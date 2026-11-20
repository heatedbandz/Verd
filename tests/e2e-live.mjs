// Drives the real app (index.html + app.js) in Chromium against fake-supabase.mjs, which runs the
// real setup.sql on a local Postgres. Proves the client: lazy anonymous sign-in, one vote, offline
// outbox, import of old local answers, server friend codes, and that the app's own token can't read raw votes.
//
//   cd tests && npm install && node e2e-live.mjs     (needs Postgres and Playwright)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { startFakeSupabase } from './fake-supabase.mjs';
import { serveSite } from './serve.mjs';
import { shares } from '../core.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ADMIN_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const DB = 'verd_e2e';
let fake, site, siteServer, browser, today, yesterday;

const day = (base, delta) => { const d = new Date(base + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
async function newUser() { return (await fake.pool.query('insert into auth.users (id) values (gen_random_uuid()) returning id')).rows[0].id; }
async function page(init = {}, hash = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route('**/app.js', async route => {
    const r = await route.fetch(); let js = await r.text();
    js = js.replace('supabaseUrl: ""', `supabaseUrl: "${fake.url}"`).replace('supabaseKey: ""', `supabaseKey: "${fake.anonKey}"`);
    if (!js.includes(`supabaseUrl: "${fake.url}"`)) throw new Error('app.js is not pointed at the stand-in database');
    await route.fulfill({ response: r, body: js });
  });
  if (Object.keys(init).length) await ctx.addInitScript(items => { if (!sessionStorage.getItem('seeded')) { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, init);
  const p = await ctx.newPage(); const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(site + '/verd/' + hash); await p.waitForTimeout(600);
  return { p, ctx, errors };
}
const dbVotes = async (d) => (await fake.pool.query('select user_id, choice from public.votes where day = $1', [d])).rows;
// Answer today's question, then take the guess if one is offered (the guess step comes a frame after the tap).
const tap = async (p, i = 0) => {
  const b = await p.$$('.slide[data-id=daily] .ans:not(:disabled)'); await b[i].click();
  const g = await p.waitForSelector('[data-guess]', { timeout: 1500 }).catch(() => null); if (g) await g.click();
};

before(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`); await root.query(`create database ${DB}`); await root.end();
  const url = new URL(ADMIN_URL); url.pathname = '/' + DB;
  const setupPool = new pg.Pool({ connectionString: url.toString() });
  await setupPool.query(readFileSync(new URL('./supabase-stub.sql', import.meta.url), 'utf8'));
  await setupPool.query(readFileSync(new URL('../setup.sql', import.meta.url), 'utf8'));
  today = (await setupPool.query('select verd_private.today()::text as d')).rows[0].d;
  const y = new Date(today + 'T00:00:00Z'); y.setUTCDate(y.getUTCDate() - 1); yesterday = y.toISOString().slice(0, 10);
  await setupPool.end();
  fake = await startFakeSupabase({ databaseUrl: url.toString() });
  siteServer = await serveSite(8093); site = 'http://localhost:8093';
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); siteServer?.close(); await fake?.close(); });

test('no account is created just by looking', async () => {
  fake.calls.length = 0;
  const { p, ctx, errors } = await page();
  assert.ok(!fake.calls.includes('POST /auth/v1/signup'), 'signed up before voting: ' + fake.calls.join(', '));
  assert.ok(fake.calls.includes('POST /rest/v1/rpc/get_results'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a vote signs in anonymously, is stored once, and the app token cannot read raw votes', async () => {
  fake.calls.length = 0;
  const { p, ctx, errors } = await page();
  await tap(p, 0); await p.waitForTimeout(800);
  assert.ok(fake.calls.includes('POST /auth/v1/signup'));
  assert.ok(fake.calls.includes('POST /rest/v1/rpc/cast_vote'));
  const votes = await dbVotes(today); assert.equal(votes.length, 1); assert.equal(votes[0].choice, 0);
  // one vote is under the minimum of 10: the slide says how far along the count is, with no percentage
  const text = await p.evaluate(() => document.querySelector('.slide[data-id=daily]').innerText);
  assert.match(text, /You're the first voter today\./); assert.match(text, /9 more votes until the verdict unlocks\./);
  assert.doesNotMatch(text, /\d\s*%/);
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('es_outbox'))), []);
  // Use the app's own session token to try the table directly, like an attacker in devtools would.
  const raw = await p.evaluate(async ({ url, key }) => {
    const s = JSON.parse(localStorage.getItem('es_sb')); const h = { apikey: key, Authorization: 'Bearer ' + s.at };
    const out = {};
    for (const [m, t] of [['GET', 'votes'], ['GET', 'profiles'], ['GET', 'suggestions'], ['POST', 'votes'], ['DELETE', 'votes'], ['PATCH', 'votes']]) {
      const r = await fetch(url + '/rest/v1/' + t, { method: m, headers: h }); out[m + ' ' + t] = r.status;
    }
    return out;
  }, { url: fake.url, key: fake.anonKey });
  for (const [k, status] of Object.entries(raw)) assert.ok(status === 401 || status === 403, `${k} returned ${status}`);
  // Second vote from the same person (straight to the API): ignored.
  const again = await p.evaluate(async ({ url, key, d }) => {
    const s = JSON.parse(localStorage.getItem('es_sb'));
    const r = await fetch(url + '/rest/v1/rpc/cast_vote', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + s.at, 'Content-Type': 'application/json' }, body: JSON.stringify({ d, c: 1, n: 2 }) });
    return r.json();
  }, { url: fake.url, key: fake.anonKey, d: today });
  assert.equal(again.mine, 0);
  assert.equal((await dbVotes(today)).length, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a vote with no signal waits in the outbox and syncs when back online', async () => {
  const { p, ctx, errors } = await page();
  const before = (await dbVotes(today)).length;
  fake.setOffline(true);
  await tap(p, 1); await p.waitForTimeout(800);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('es_outbox')).length), 1);
  assert.equal((await dbVotes(today)).length, before);
  assert.match(await p.evaluate(() => document.querySelector('.slide[data-id=daily]').innerText), /It counts as soon as you're back online\./);
  fake.setOffline(false);
  await p.evaluate(() => dispatchEvent(new Event('online'))); await p.waitForTimeout(1200);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('es_outbox')).length), 0);
  assert.equal((await dbVotes(today)).length, before + 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('installed and opened with no signal: Verd still works live, and the answer is sent when the signal is back', async () => {
  // This site serves app.js with the keys already in it, because the service worker caches what the server sends.
  const keyed = await serveSite(8096, (path, body) => path !== '/app.js' ? body
    : Buffer.from(body.toString().replace('supabaseUrl: ""', `supabaseUrl: "${fake.url}"`).replace('supabaseKey: ""', `supabaseKey: "${fake.anonKey}"`)));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const p = await ctx.newPage(), errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto('http://localhost:8096/verd/'); await p.waitForSelector('.slide[data-id=end]');
    await p.evaluate(async () => { await navigator.serviceWorker.ready; for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100)); });
    const before = (await dbVotes(today)).length;
    await ctx.setOffline(true);
    await p.reload(); await p.waitForSelector('.slide[data-id=end]');
    assert.equal(await p.$eval('#netText', e => e.textContent), 'Offline');
    await tap(p); await p.waitForTimeout(800);
    assert.match(await p.evaluate(() => document.querySelector('.slide[data-id=daily]').innerText), /It counts as soon as you're back online\./);
    assert.equal((await dbVotes(today)).length, before);
    await ctx.setOffline(false);
    await p.waitForFunction(() => JSON.parse(localStorage.getItem('es_outbox') || '[]').length === 0, null, { timeout: 5000 });
    assert.equal((await dbVotes(today)).length, before + 1, 'the answer reached the database');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); keyed.close(); }
});

test("answers saved on the phone before launch are copied once, with today's vote", async () => {
  const local = { [yesterday]: { choice: 1, country: 'US' } };
  const { p, ctx } = await page({ es_myVotes: JSON.stringify(local) });
  await tap(p, 0); await p.waitForTimeout(1000);
  const s = await p.evaluate(() => JSON.parse(localStorage.getItem('es_sb')));
  const uid = [...(await fake.pool.query('select user_id from public.votes where day = $1', [today])).rows].map(r => r.user_id);
  const mineYesterday = (await fake.pool.query('select count(*)::int as k from public.votes where day = $1 and choice = 1', [yesterday])).rows[0].k;
  assert.ok(s && uid.length >= 1);
  assert.equal(mineYesterday, 1, 'yesterday was not imported');
  assert.equal(await p.evaluate(() => localStorage.getItem('es_imported')), 'true');
  await ctx.close();
});

test('results appear once enough people voted, and the friend code comes from the server', async () => {
  for (let i = 0; i < 12; i++) {
    const id = (await fake.pool.query('insert into auth.users (id) values (gen_random_uuid()) returning id')).rows[0].id;
    await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, 0, $3)', [today, id, 'US']);
  }
  const { p, ctx, errors } = await page();
  await tap(p, 0); await p.waitForTimeout(1500);
  const text = await p.evaluate(() => document.querySelector('.slide[data-id=daily]').innerText);
  assert.match(text, /\d+%/, 'no percentages after 10+ votes: ' + text);
  await p.click('#navMe'); await p.waitForTimeout(600);
  const code = await p.evaluate(() => document.getElementById('mycode').textContent);
  const codes = (await fake.pool.query('select code from public.profiles')).rows.map(r => r.code);
  assert.ok(codes.includes(code), `code ${code} not issued by the server`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with no connection a cached count still shows; with none cached there is an error and Try again works', async () => {
  const { p, ctx, errors } = await page();
  await tap(p, 1); await p.waitForTimeout(1200);
  assert.match(await p.innerText('.slide[data-id=daily]'), /\d+%/);
  await ctx.route('**/rpc/get_results', r => r.abort());
  await p.reload(); await p.waitForTimeout(900);
  assert.match(await p.innerText('.slide[data-id=daily]'), /\d+%/, 'the cached count is gone');
  assert.equal(await p.$eval('#net', e => e.hidden), false); assert.match(await p.innerText('#net'), /Can't connect/);
  await p.evaluate(d => localStorage.removeItem('es_res:' + d), today);
  await p.reload(); await p.waitForTimeout(900);
  assert.match(await p.innerText('.slide[data-id=daily]'), /Couldn't load the count right now\./);
  await ctx.unroute('**/rpc/get_results');
  await p.click('.slide[data-id=daily] .cta'); await p.waitForTimeout(1200);
  const text = await p.innerText('.slide[data-id=daily]');
  assert.doesNotMatch(text, /Couldn't load/); assert.match(text, /\d+%/);
  assert.equal(await p.$eval('#net', e => e.hidden), true);
  assert.deepEqual(errors.filter(e => !/Failed to fetch/.test(e)), []);
  await ctx.close();
});

test("the next day, yesterday's final verdict says how your answer did", async () => {
  const have = (await fake.pool.query('select count(*)::int as n from public.votes where day = $1', [yesterday])).rows[0].n;
  for (let i = have; i < 12; i++) {
    const id = (await fake.pool.query('insert into auth.users (id) values (gen_random_uuid()) returning id')).rows[0].id;
    await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, $3, $4)', [yesterday, id, i % 3 ? 0 : 1, 'US']);
  }
  const { p, ctx, errors } = await page({ es_myVotes: JSON.stringify({ [yesterday]: { choice: 1, country: 'US' } }) });
  await p.waitForSelector('.slide[data-id=yday]');
  const text = await p.innerText('.slide[data-id=yday]');
  const options = await p.$$eval('.slide[data-id=yday] .ans .alabel', b => b.map(x => x.textContent));
  assert.match(text, new RegExp("You said " + options[1] + "\\. \\S"), text);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('invites: no account just for opening one, and a match needs both of you to add each other', async () => {
  // A friend who answered the last 3 days
  const friend = await newUser(), fcode = (await fake.pool.query('select verd_private.ensure_profile($1) as c', [friend])).rows[0].c;
  for (const d of [1, 2, 3]) await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, 0, $3)', [day(today, -d), friend, 'US']);
  fake.calls.length = 0;
  const { p, ctx, errors } = await page({}, '#f=' + fcode + '&n=Jay');
  assert.ok(!fake.calls.includes('POST /auth/v1/signup'), 'opening an invite made an account: ' + fake.calls.join(', '));
  await p.click('#navMe'); await p.waitForTimeout(500);
  assert.match(await p.innerText('#flist'), new RegExp('Jay\\s+' + fcode + '\\s+Matches start after your first answer\\.'));
  await p.click('#navHome'); await p.waitForTimeout(300); await tap(p, 0); await p.waitForTimeout(1500);
  const rows = (await fake.pool.query('select user_id from public.friend_adds where code = $1', [fcode])).rows;
  assert.equal(rows.length, 1, 'the database got your friend list once you had an account');
  await p.click('#navMe'); await p.waitForTimeout(900);
  assert.match(await p.innerText('#flist'), /Request sent\. Waiting for them to accept\./);
  // They add you back, and you both answered the same 3 past days: 2 alike
  const me = rows[0].user_id, mycode = (await fake.pool.query('select code from public.profiles where id = $1', [me])).rows[0].code;
  await fake.pool.query('insert into public.friend_adds (user_id, code) values ($1, $2)', [friend, mycode]);
  for (const [d, c] of [[1, 0], [2, 0], [3, 1]]) await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, $3, $4) on conflict do nothing', [day(today, -d), me, c, 'US']);
  await p.click('#navHome'); await p.waitForTimeout(300); await p.click('#navMe'); await p.waitForTimeout(900);
  assert.match(await p.innerText('#flist'), /Jay\s+\w{6}\s+67% match/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('friend requests: someone who added you shows up on Me with a dot, and Accept makes you friends', async () => {
  const friend = await newUser(), fcode = (await fake.pool.query('select verd_private.ensure_profile($1) as c', [friend])).rows[0].c;
  const { p, ctx, errors } = await page();
  await tap(p, 0); await p.waitForTimeout(1500);
  const me = await uidOf(p), mycode = (await fake.pool.query('select verd_private.ensure_profile($1) as c', [me])).rows[0].c;
  // Not added by anyone yet: nothing shows
  await p.click('#navMe'); await p.waitForTimeout(700);
  assert.equal(await p.$eval('#freqs', e => e.hidden), true);
  await fake.pool.query('insert into public.friend_adds (user_id, code) values ($1, $2)', [friend, mycode]);
  await p.reload(); await p.waitForTimeout(1500);
  assert.equal(await p.$eval('#meDot', e => e.hidden), false, 'the Me button shows a dot');
  await p.click('#navMe'); await p.waitForSelector('#freqs:not([hidden])');
  assert.match(await p.innerText('#freqs'), new RegExp('1 friend request[\\s\\S]*' + fcode + '[\\s\\S]*added you', 'i'));
  await p.fill('#freqs input', 'Jay'); await p.click('#freqs button:text-is("Accept")'); await p.waitForTimeout(1200);
  assert.match(await p.innerText('#toast'), /You and Jay are friends now\./);
  assert.equal(await p.$eval('#freqs', e => e.hidden), true); assert.equal(await p.$eval('#meDot', e => e.hidden), true);
  assert.equal((await fake.pool.query('select count(*)::int as n from public.friend_adds where user_id = $1 and code = $2', [me, fcode])).rows[0].n, 1, 'accepting adds them back');
  assert.match(await p.innerText('#flist'), new RegExp('Jay\\s+' + fcode));
  assert.doesNotMatch(await p.innerText('#flist'), /Waiting for them/, 'they added you, so it is mutual');
  // Not now hides a request on this phone
  const other = await newUser(), ocode = (await fake.pool.query('select verd_private.ensure_profile($1) as c', [other])).rows[0].c;
  await fake.pool.query('insert into public.friend_adds (user_id, code) values ($1, $2)', [other, mycode]);
  await p.reload(); await p.waitForTimeout(1500); await p.click('#navMe'); await p.waitForSelector('#freqs:not([hidden])');
  assert.match(await p.innerText('#freqs'), new RegExp(ocode));
  await p.click('#freqs button:text-is("Not now")'); await p.waitForTimeout(300);
  assert.equal(await p.$eval('#freqs', e => e.hidden), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('friends added before Verd went live are asked for a new link, their stand-in codes stay off the server, and removing ends a match', async () => {
  const friend = await newUser(), fcode = (await fake.pool.query('select verd_private.ensure_profile($1) as c', [friend])).rows[0].c;
  const { p, ctx, errors } = await page({ es_friends: JSON.stringify(['OLDJAY']), es_nicks: JSON.stringify({ OLDJAY: 'Jay' }) }, '#f=' + fcode + '&n=Sam');
  assert.match(await p.innerText('#toast'), /Added Sam\. Answer today's question and Sam will get your friend request\./);
  await tap(p, 0); await p.waitForTimeout(1500);
  const sent = async () => (await fake.pool.query('select code from public.friend_adds where code in ($1, $2) order by code', [fcode, 'OLDJAY'])).rows.map(r => r.code);
  assert.deepEqual(await sent(), [fcode], 'only the friend added since launch is sent');
  await p.click('#navMe'); await p.waitForTimeout(900);
  const list = await p.innerText('#flist');
  assert.match(list, /Jay\s+OLDJAY\s+Added before Verd went live\. Send them your new invite link\./);
  assert.match(list, new RegExp('Sam\\s+' + fcode + '\\s+Request sent\\. Waiting for them to accept\\.'));
  await p.click('#flist button[aria-label="Remove Sam"]'); await p.waitForTimeout(800);
  assert.deepEqual(await sent(), [], 'removing a friend takes them off your list in the database too');
  assert.doesNotMatch(await p.innerText('#flist'), /Sam/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("today's board: a place shows at 30 answers, and until then it says how to get yours on", async () => {
  const perCountry = async () => Object.fromEntries((await fake.pool.query('select country, count(*)::int as n from public.votes where day = $1 group by country', [today])).rows.map(r => [r.country, r.n]));
  const { p, ctx, errors } = await page({ es_country: JSON.stringify('FR') });
  await tap(p, 0); await p.waitForSelector('.slide[data-id=board]', { timeout: 6000 });
  if (Math.max(...Object.values(await perCountry())) < 30)
    assert.match(await p.innerText('.slide[data-id=board]'), /No country has 30 answers yet\. Share today's question to put yours on the board\./);
  // 30 more answers from France (20 picked the first answer) and enough from the US
  for (let i = 0; i < 30; i++) await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, $3, $4)', [today, await newUser(), i < 20 ? 0 : 1, 'FR']);
  for (let i = (await perCountry()).US || 0; i < 30; i++) await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, 1, $3)', [today, await newUser(), 'US']);
  await p.reload(); await p.waitForSelector('.slide[data-id=board] .brow', { timeout: 6000 });
  const fr = (await fake.pool.query('select count(*) filter (where choice = 0)::int as k, count(*)::int as n from public.votes where day = $1 and country = $2', [today, 'FR'])).rows[0];
  const rows = await p.$$eval('.slide[data-id=board] .brow', r => r.map(x => ({ text: x.innerText.replace(/\s+/g, ' ').trim(), me: x.classList.contains('you') })));
  const france = rows.find(r => /France/.test(r.text));
  assert.ok(france && france.me, 'your country is marked: ' + JSON.stringify(rows));
  assert.match(france.text, new RegExp(shares([fr.k, fr.n - fr.k])[0] + '%'));
  assert.ok(rows.some(r => /United States/.test(r.text)), JSON.stringify(rows));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('posting stays off on the live site until there is a moderator: no post button, no tabs, nothing opens the composer', async () => {
  const { p, ctx, errors } = await page();
  assert.equal(await p.$eval('#navPlus', e => e.hidden), true);
  assert.equal(await p.$eval('#scopes', e => e.hidden), true);
  await tap(p, 0); await p.waitForTimeout(900);
  assert.doesNotMatch(await p.innerText('.slide[data-id=end]'), /Post something/);
  await p.click('#navSearch'); await p.fill('#q', 'skateboard'); await p.waitForTimeout(400);
  assert.doesNotMatch(await p.innerText('#search'), /Start a debate/);
  assert.equal(await p.$eval('#compose', e => e.hidden), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a vote sends state and city only for someone 13 or older, and only they can suggest a question', async () => {
  const placed = async () => (await fake.pool.query("select count(*)::int as n from public.votes where day = $1 and state = 'ohio' and city = 'akron'", [today])).rows[0].n;
  const before = await placed(), year = new Date().getUTCFullYear();
  for (const [born, adds] of [[(year - 11) + '-01', 0], ['2001-04', 1]]){
    const { p, ctx, errors } = await page({ es_state: JSON.stringify('Ohio'), es_city: JSON.stringify('Akron'), es_born: JSON.stringify(born) });
    await tap(p, 1); await p.waitForTimeout(1200);
    assert.equal(await p.$eval('#suggest', e => e.hidden), !adds, 'suggestion box for ' + born);
    assert.deepEqual(errors, []);
    await ctx.close();
    assert.equal(await placed(), before + (adds ? 1 : 0), born);
  }
});

test("a past question in search opens with the database's final verdict", async () => {
  const counts = (await fake.pool.query('select choice, count(*)::int as k from public.votes where day = $1 group by choice order by choice', [yesterday])).rows;
  const n = counts.reduce((a, r) => a + r.k, 0);
  const { p, ctx, errors } = await page();
  await p.click('#navSearch'); await p.waitForTimeout(400);
  assert.match(await p.innerText('#sres'), /See the verdict/);
  // The list gains a day every day, so find yesterday by its number rather than its place in the list.
  const start = await p.evaluate(() => JSON.parse(document.getElementById('verd-data').textContent).start);
  const no = Math.round((Date.parse(yesterday) - Date.parse(start)) / 864e5) + 1;
  await p.locator('#sres .res', { has: p.locator('.mini', { hasText: new RegExp('^No\\.' + no + '$') }) }).click(); await p.waitForTimeout(900);
  const text = await p.innerText('#dayview');
  assert.ok(text.startsWith('No. ' + no + ' · '), 'opened the wrong day: ' + text);
  if (n >= 10) assert.match(text, /\d+%/);
  else if (n) { assert.match(text, /Not enough answers for a verdict\./); assert.ok(text.includes(n + (n === 1 ? ' person' : ' people') + ' answered. A verdict needs 10.'), text); }
  else assert.match(text, /Nobody answered this one on Verd\./);
  assert.doesNotMatch(n >= 10 ? '' : text, /\d\s*%/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

// ---------- Posting: Google sign-in, age, review, reports ----------
// Google is the stand-in page on fake-supabase.mjs. Each sign-in there types an email address.
const yearsAgo = (n, m = '01') => (new Date().getUTCFullYear() - n) + '-' + m;
async function google(p, email) {
  await p.waitForURL(/\/fake-google/, { timeout: 5000 });
  await p.fill('#email', email);
  await Promise.all([p.waitForURL(u => u.pathname.startsWith('/verd/'), { timeout: 5000 }), p.click('#go')]);
  await p.waitForTimeout(1200);
}
const sessionOf = p => p.evaluate(() => localStorage.getItem('es_sb'));
const uidOf = async p => fake.userOf(JSON.parse(await sessionOf(p)).at);
const pickAge = async (p, y, m) => { await p.selectOption('#ayear', String(y)); await p.selectOption('#amonth', m); await p.click('#ago'); await p.waitForTimeout(300); };
const slideWith = (p, text) => p.$(`.slide:has(h2:text-is("${text}"))`);
let modSession, writerSession;

test('posting stays closed until Verd has a moderator, even for someone signed in', async () => {
  const { p, ctx, errors } = await page({ es_born: JSON.stringify(yearsAgo(40, '03')) });
  await p.waitForTimeout(400);
  assert.equal(await p.$eval('#navPlus', e => e.hidden), true, 'the + button shows with no moderator');
  // The account section is there (Google sign-in is on). Signing in from Me: no account existed, so this is a fresh Google one.
  await p.click('#navMe'); await p.waitForSelector('#account:not([hidden])');
  assert.match(await p.innerText('#account'), /Sign in to post and comment\. Your name is never shown to anyone\./);
  await p.click('#acctBtn'); await p.waitForSelector('#acct:not([hidden])');
  assert.match(await p.innerText('#acct'), /Sign in to post[\s\S]*your birth month and year are kept with the account/);
  await p.click('#ago'); await google(p, 'mod@verd.test');
  assert.equal(new URL(p.url()).search, '', 'the one-time code is left in the address');
  assert.match(await p.innerText('#account'), /Signed in with Google\./);
  const uid = await uidOf(p), u = (await fake.pool.query('select is_anonymous, email from auth.users where id = $1', [uid])).rows[0];
  assert.deepEqual(u, { is_anonymous: false, email: 'mod@verd.test' });
  assert.equal((await fake.pool.query('select born from public.profiles where id = $1', [uid])).rows[0].born, (new Date().getUTCFullYear() - 40) * 12 + 2, 'the age from this phone is kept with the account');
  assert.equal(await p.$eval('#navPlus', e => e.hidden), true, 'signed in, but no moderator yet');
  assert.equal(await p.$eval('#review', e => e.hidden), true);
  modSession = await sessionOf(p);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('someone under 13 is never sent to sign in: no account, no email, and the sheet says why', async () => {
  await fake.pool.query("insert into public.moderators (user_id) select id from auth.users where email = 'mod@verd.test'");
  fake.calls.length = 0;
  const { p, ctx, errors } = await page({ es_born: JSON.stringify(yearsAgo(11)) });
  await p.waitForTimeout(500);
  assert.equal(await p.$eval('#navPlus', e => e.hidden), false, 'posting is open now');
  await p.click('#navPlus'); await p.waitForSelector('#acct:not([hidden])');
  assert.match(await p.innerText('#acct'), /Posting is for 13 and older[\s\S]*You can still answer every day, judge posts and report anything that looks wrong\./);
  assert.equal(await p.$eval('#ago', e => e.hidden), true);
  assert.equal(await p.$eval('#compose', e => e.hidden), true);
  await p.click('#aclose'); await p.click('#navMe'); await p.waitForTimeout(300);
  assert.equal(await p.$eval('#account', e => e.hidden), true, 'no sign-in on Me either');
  assert.ok(!fake.calls.some(c => /authorize|signup|token/.test(c)), fake.calls.join(', '));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a post: age asked first, then Google, then it waits for review and only the writer sees it', async () => {
  const { p, ctx, errors } = await page();
  await p.waitForTimeout(400);
  await p.click('#navPlus'); await p.waitForSelector('#acct:not([hidden])');
  assert.match(await p.innerText('#atitle'), /One question first/);
  assert.doesNotMatch(await p.innerText('#atitle') + ' ' + await p.innerText('#anote'), /13|older|young/, 'the age question hints at the cut-off');
  await pickAge(p, new Date().getUTCFullYear() - 16, '05');
  assert.match(await p.innerText('#atitle'), /Sign in to post/);
  await p.click('#ago'); await google(p, 'writer@verd.test');
  await p.waitForSelector('#compose:not([hidden])', { timeout: 4000 });
  assert.equal(await p.$eval('#photoRow', e => e.hidden), true, 'photos are offered on the live site');
  assert.match(await p.innerText('#cnote'), /A moderator checks every post before anyone else sees it/);
  await p.fill('#ptext', 'add me on snap if you want'); await p.click('#psend'); await p.waitForTimeout(200);
  assert.match(await p.innerText('#toast'), /Leave out slurs, contact info/);
  await p.fill('#ptext', 'Is cereal a soup?'); await p.click('#psend'); await p.waitForTimeout(900);
  assert.match(await p.innerText('#toast'), /Sent for review\./);
  const rows = (await fake.pool.query("select status, body, user_id from public.posts")).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'pending'); assert.equal(rows[0].body, 'Is cereal a soup?');
  assert.equal(rows[0].user_id, await uidOf(p));
  const mine = await slideWith(p, 'Is cereal a soup?');
  assert.ok(mine, 'your post is in your feed');
  assert.match(await mine.innerText(), /Waiting for review[\s\S]*Only you can see this until a moderator approves it\./);
  // Two minutes between posts, said in plain words
  await p.click('#navPlus'); await p.waitForSelector('#compose:not([hidden])');
  await p.fill('#ptext', 'Is a hot dog a sandwich?'); await p.click('#psend'); await p.waitForTimeout(700);
  assert.match(await p.innerText('#toast'), /Wait a moment before the next one\./);
  assert.equal((await fake.pool.query('select count(*)::int as n from public.posts')).rows[0].n, 1);
  writerSession = await sessionOf(p);
  // Someone else sees nothing yet
  const other = await page();
  await other.p.waitForTimeout(500);
  assert.equal(await slideWith(other.p, 'Is cereal a soup?'), null, 'a post showed before review');
  await other.ctx.close();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the moderator approves it from Me; then people judge it, see the split, and can report it', async () => {
  const mod = await page({ es_sb: modSession, es_born: JSON.stringify(yearsAgo(40, '03')) });
  await mod.p.click('#navMe'); await mod.p.waitForSelector('#review:not([hidden]) .ritem');
  assert.match(await mod.p.innerText('#review'), /1 waiting\. Nothing new shows to others until you approve it\.[\s\S]*Post · \S+ ago · First one from this writer[\s\S]*Is cereal a soup\?/);
  assert.doesNotMatch(await mod.p.innerText('#review'), /writer@verd\.test/, 'the writer\'s email is shown to the moderator');
  await mod.p.click('#reviewList button:text-is("Approve")'); await mod.p.waitForTimeout(800);
  assert.match(await mod.p.innerText('#reviewNote'), /Nothing waiting\./);
  assert.equal((await fake.pool.query('select status from public.posts')).rows[0].status, 'approved');
  assert.deepEqual(mod.errors, []); await mod.ctx.close();

  const { p, ctx, errors } = await page();
  await p.waitForTimeout(600);
  const s = await slideWith(p, 'Is cereal a soup?');
  assert.ok(s, 'the approved post shows to others');
  assert.match(await s.innerText(), /Be the first to judge\./);
  assert.doesNotMatch(await s.innerText(), /writer|@verd/);
  await (await s.$('.ans')).click(); await p.waitForTimeout(900);
  const after = await (await slideWith(p, 'Is cereal a soup?')).innerText();
  assert.match(after, /100%/, 'the split shows once you judge: ' + after);
  assert.match(after, /1 vote/);
  assert.equal((await fake.pool.query('select count(*)::int as n from public.post_votes')).rows[0].n, 1);
  await (await (await slideWith(p, 'Is cereal a soup?')).$('button[aria-label="Report"]')).click(); await p.waitForTimeout(700);
  assert.match(await p.innerText('#toast'), /Reported\. It's hidden for you\./);
  assert.equal((await fake.pool.query("select count(*)::int as n from public.reports where kind = 'post'")).rows[0].n, 1);
  await p.reload(); await p.waitForTimeout(800);
  assert.equal(await slideWith(p, 'Is cereal a soup?'), null, 'a post you reported came back');
  assert.deepEqual(errors, []);
  await ctx.close();

  // The writer sees it's up, and can't judge their own
  const w = await page({ es_sb: writerSession, es_born: JSON.stringify(yearsAgo(16, '05')) });
  await w.p.waitForTimeout(600);
  const ws = await slideWith(w.p, 'Is cereal a soup?');
  assert.match(await ws.innerText(), /Your post[\s\S]*1 vote/);
  assert.deepEqual(w.errors, []); await w.ctx.close();
});

test('comments wait for review too, and show as yours until then', async () => {
  const { p, ctx, errors } = await page({ es_sb: writerSession, es_born: JSON.stringify(yearsAgo(16, '05')) });
  await p.waitForTimeout(600);
  await (await (await slideWith(p, 'Is cereal a soup?')).$('button[aria-label="Comments"]')).click();
  await p.waitForSelector('#sheet:not([hidden])');
  await p.fill('#cinput', 'Milk makes it a soup'); await p.click('#csend'); await p.waitForTimeout(900);
  assert.match(await p.innerText('#toast'), /Sent\. Others see it once a moderator approves it\./);
  assert.match(await p.innerText('#clist'), /You[\s\S]*Waiting for review[\s\S]*Milk makes it a soup/);
  assert.equal((await fake.pool.query("select status from public.comments")).rows[0].status, 'pending');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('once the owner sets auto_approve, posts and comments go live at once, and the moderator checks them afterwards in Me', async () => {
  await fake.pool.query("update public.app_config set value = 1 where key = 'auto_approve'");
  // The writer posted and commented moments ago: move those back past the minimum gaps.
  await fake.pool.query("update public.posts set created_at = created_at - interval '1 hour'");
  await fake.pool.query("update public.comments set created_at = created_at - interval '1 hour'");
  try {
    const { p, ctx, errors } = await page({ es_sb: writerSession, es_born: JSON.stringify(yearsAgo(16, '05')) });
    await p.waitForTimeout(600);
    await p.click('#navPlus'); await p.waitForSelector('#compose:not([hidden])');
    assert.match(await p.innerText('#cnote'), /Posts go live straight away, and your name is never shown\./);
    assert.doesNotMatch(await p.innerText('#cnote'), /checks every post/);
    await p.fill('#ptext', 'Is a taco a kind of sandwich?'); await p.click('#psend'); await p.waitForTimeout(900);
    assert.match(await p.innerText('#toast'), /Posted\. Others can see it now\./);
    const post = (await fake.pool.query("select id, status from public.posts where body = 'Is a taco a kind of sandwich?'")).rows[0];
    assert.equal(post.status, 'approved');
    const mine = await slideWith(p, 'Is a taco a kind of sandwich?');
    assert.match(await mine.innerText(), /Your post/);
    assert.doesNotMatch(await mine.innerText(), /Waiting for review|Only you can see this/);
    await (await mine.$('button[aria-label="Comments"]')).click(); await p.waitForSelector('#sheet:not([hidden])');
    await p.fill('#cinput', 'Only if it comes in a bun'); await p.click('#csend'); await p.waitForTimeout(900);
    assert.match(await p.innerText('#toast'), /Posted\. Others can see it now\./);
    assert.doesNotMatch(await p.innerText('#clist'), /Waiting for review/);
    assert.equal((await fake.pool.query("select status from public.comments where body = 'Only if it comes in a bun'")).rows[0].status, 'approved');
    assert.deepEqual(errors, []); await ctx.close();

    const other = await page();
    await other.p.waitForTimeout(600);
    assert.ok(await slideWith(other.p, 'Is a taco a kind of sandwich?'), 'others see it straight away');
    assert.deepEqual(other.errors, []); await other.ctx.close();

    // Nothing to approve: what went live isn't listed, and neither is what waited from before. Only the report shows.
    const mod = await page({ es_sb: modSession, es_born: JSON.stringify(yearsAgo(40, '03')) });
    await mod.p.click('#navMe'); await mod.p.waitForSelector('#review:not([hidden]) .ritem');
    assert.equal(await mod.p.innerText('#reviewNote'), '1 was reported. Everything else goes live by itself, and slurs are blocked.');
    assert.equal(await mod.p.$$eval('#reviewList .ritem', r => r.length), 1);
    assert.doesNotMatch(await mod.p.innerText('#reviewList'), /Went live|Approve|Looks fine/);
    await mod.p.click('#reviewList button:text-is("Keep")'); await mod.p.waitForTimeout(900);
    assert.equal(await mod.p.$eval('#review', e => e.hidden), true, 'with nothing reported, Review goes away');
    assert.deepEqual(mod.errors, []); await mod.ctx.close();
  } finally {
    await fake.pool.query("update public.app_config set value = 0 where key = 'auto_approve'");
  }
});

test('a Google account that already has Verd: this phone signs in to it, and nothing is counted twice', async () => {
  const { p, ctx, errors } = await page({ es_born: JSON.stringify(yearsAgo(16, '05')) });
  await tap(p, 0); await p.waitForTimeout(900);
  const anon = await uidOf(p), votesBefore = (await dbVotes(today)).length;
  await p.click('#navMe'); await p.waitForSelector('#account:not([hidden])');
  await p.click('#acctBtn'); await p.waitForSelector('#acct:not([hidden])'); await p.click('#ago');
  await google(p, 'writer@verd.test');   // linking is refused: that Google account is the writer's
  await google(p, 'writer@verd.test');   // so the app signs in to the writer's account instead
  const writer = (await fake.pool.query("select id from auth.users where email = 'writer@verd.test'")).rows[0].id;
  assert.equal(await uidOf(p), writer);
  assert.notEqual(anon, writer);
  assert.equal((await dbVotes(today)).length, votesBefore, "today's answer was counted again");
  assert.equal((await fake.pool.query('select is_anonymous from auth.users where id = $1', [anon])).rows[0].is_anonymous, true);
  assert.match(await p.innerText('#account'), /Signed in with Google\./);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('if Supabase manual linking is off, signing in says so instead of making a second account', async () => {
  fake.setManualLinking(false);
  try {
    const { p, ctx, errors } = await page({ es_born: JSON.stringify(yearsAgo(16, '05')) });
    await tap(p, 1); await p.waitForTimeout(900);
    const users = (await fake.pool.query('select count(*)::int as n from auth.users')).rows[0].n;
    await p.click('#navMe'); await p.waitForSelector('#account:not([hidden])');
    await p.click('#acctBtn'); await p.waitForSelector('#acct:not([hidden])'); await p.click('#ago'); await p.waitForTimeout(600);
    assert.match(await p.innerText('#toast'), /Signing in isn't fully switched on yet\./);
    assert.ok(!/fake-google/.test(p.url()));
    assert.equal((await fake.pool.query('select count(*)::int as n from auth.users')).rows[0].n, users);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { fake.setManualLinking(true); }
});

test('with Google sign-in switched off, the site is just the daily question: no posts are even fetched', async () => {
  fake.setGoogle(false);
  try {
    fake.calls.length = 0;
    const { p, ctx, errors } = await page({ es_born: JSON.stringify(yearsAgo(16, '05')) });
    await p.waitForTimeout(600);
    assert.equal(await p.$eval('#navPlus', e => e.hidden), true);
    assert.equal(await slideWith(p, 'Is cereal a soup?'), null);
    assert.ok(!fake.calls.includes('POST /rest/v1/rpc/get_posts'), fake.calls.join(', '));
    await p.click('#navMe'); await p.waitForTimeout(300);
    assert.equal(await p.$eval('#account', e => e.hidden), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { fake.setGoogle(true); }
});

test('Google switched on before the posting part of setup.sql: no sign-in yet, and posts are asked for once, not on a timer', async () => {
  // The setup done in another order. Until get_posts exists, the database can't keep an account's age or posts.
  await fake.pool.query('alter function public.get_posts rename to get_posts_off');
  try {
    fake.calls.length = 0;
    const asked = () => fake.calls.filter(c => c === 'POST /rest/v1/rpc/get_posts').length;
    const { p, ctx, errors } = await page({ es_born: JSON.stringify(yearsAgo(40, '03')) });
    await p.waitForTimeout(600);
    assert.equal(asked(), 1, fake.calls.join(', '));
    assert.equal(await p.$eval('#navPlus', e => e.hidden), true);
    await p.click('#navMe'); await p.waitForTimeout(300);
    assert.equal(await p.$eval('#account', e => e.hidden), true, 'sign-in shows before the database can keep an account');
    // Coming back to the tab asks again when posts exist. Here it doesn't.
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(400);
    assert.equal(asked(), 1, 'asked for posts again: ' + fake.calls.join(', '));
    // Everything else is the usual daily question, with no error on screen.
    await p.click('#navHome'); await p.waitForTimeout(300);
    assert.ok((await p.$$('.slide[data-id=daily] .ans:not(:disabled)')).length >= 2, 'today\'s answers are not there to tap');
    assert.doesNotMatch(await p.innerText('body'), /Couldn't load|Can't connect/);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await fake.pool.query('alter function public.get_posts_off rename to get_posts'); }
});

test("signed in with Google, Verd opens on friends' posts with today's question one tab over; signed out it opens on today's question", async () => {
  const id = email => fake.pool.query('select id from auth.users where email = $1', [email]).then(r => r.rows[0].id);
  const mod = await id('mod@verd.test'), writer = await id('writer@verd.test');
  const code = async u => (await fake.pool.query('select verd_private.ensure_profile($1) as c', [u])).rows[0].c;
  const modCode = await code(mod), writerCode = await code(writer);
  await fake.pool.query('insert into public.friend_adds (user_id, code) values ($1, $2), ($3, $4) on conflict do nothing', [mod, writerCode, writer, modCode]);
  const post = (await fake.pool.query("insert into public.posts (user_id, body, scope, status, reviewed_at) values ($1, 'Should pineapple go on pizza?', 'friends', 'approved', now()) returning id", [writer])).rows[0].id;
  try {
    const { p, ctx, errors } = await page({ es_sb: modSession, es_born: JSON.stringify(yearsAgo(40, '03')), es_friends: JSON.stringify([writerCode]), es_addedIn: JSON.stringify({ [writerCode]: 'live' }) });
    await p.waitForSelector('#scopes:not([hidden]) .scope.on', { timeout: 4000 }); await p.waitForTimeout(500);
    assert.deepEqual(await p.$$eval('#scopes .scope', b => b.slice(0, 2).map(x => x.textContent)), ['Friends', 'World'], 'Friends is the first tab');
    assert.equal(await p.innerText('#scopes .scope.on'), 'Friends');
    assert.equal(await p.$eval('#feed .slide', s => s.innerText.includes('Should pineapple go on pizza?')), true, "a friend's post comes first");
    // one tap over is today's question
    await p.click('#scopes .scope:text-is("World")'); await p.waitForTimeout(300);
    assert.equal(await p.$eval('#feed .slide', s => s.dataset.id), 'daily');
    assert.deepEqual(errors, []); await ctx.close();
    // Not signed in: today's question first, Friends stays the last tab, and nobody is asked to sign in
    const anon = await page({ es_friends: JSON.stringify([writerCode]), es_addedIn: JSON.stringify({ [writerCode]: 'live' }) });
    await anon.p.waitForTimeout(1200);
    assert.equal(await anon.p.$eval('#feed .slide', s => s.dataset.id), 'daily');
    assert.equal(await anon.p.$eval('#acct', e => e.hidden), true);
    const tabs = await anon.p.$$eval('#scopes .scope', b => b.map(x => x.textContent));
    if (tabs.length) assert.equal(tabs[0], 'World');
    assert.deepEqual(anon.errors, []); await anon.ctx.close();
  } finally {
    await fake.pool.query('delete from public.posts where id = $1', [post]);
  }
});

// A small photo, and the same one the way a phone camera saves it: with a location (EXIF) and a comment.
const PHOTO = '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';
function withMeta(b64) {
  const raw = Buffer.from(b64, 'base64'), seg = (marker, text) => {
    const body = Buffer.from(text, 'latin1');
    return Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  };
  return Buffer.concat([raw.subarray(0, 2), seg(0xe1, 'Exif\0\0MM\0*GPSLatitude 37.7749 N GPSLongitude 122.4194 W'),
    seg(0xfe, 'Taken at 12 Oak Street'), raw.subarray(2)]);
}

test('photo posts, once the owner switches them on: friends only, no location kept, friends signed in see them, and Review blurs a reported one', async () => {
  const id = email => fake.pool.query('select id from auth.users where email = $1', [email]).then(r => r.rows[0].id);
  const mod = await id('mod@verd.test'), writer = await id('writer@verd.test');
  const code = async u => (await fake.pool.query('select verd_private.ensure_profile($1) as c', [u])).rows[0].c;
  const modCode = await code(mod), writerCode = await code(writer);
  await fake.pool.query('insert into public.friend_adds (user_id, code) values ($1, $2), ($3, $4) on conflict do nothing', [mod, writerCode, writer, modCode]);
  // The writer posted earlier in these tests: move those back past the daily limit.
  await fake.pool.query("update public.posts set created_at = created_at - interval '2 days' where user_id = $1", [writer]);
  await fake.pool.query("update public.app_config set value = 1 where key in ('photos', 'auto_approve')");
  let pid = null;
  try {
    // Two photos: only Friends can be picked, and the note says who sees them.
    const w = await page({ es_sb: writerSession, es_born: JSON.stringify(yearsAgo(16, '05')), es_friends: JSON.stringify([modCode]), es_addedIn: JSON.stringify({ [modCode]: 'live' }) });
    await w.p.waitForTimeout(600);
    await w.p.click('#navPlus'); await w.p.waitForSelector('#compose:not([hidden])');
    assert.equal(await w.p.$eval('#photoRow', e => e.hidden), false, 'photos are offered once they are switched on');
    const file = n => ({ name: n + '.jpg', mimeType: 'image/jpeg', buffer: withMeta(PHOTO) });
    await w.p.setInputFiles('#pfile', [file('a'), file('b')]); await w.p.waitForSelector('#thumbs .thumb:nth-child(2)');
    assert.deepEqual(await w.p.$$eval('#aud button:not(:disabled)', b => b.map(x => x.textContent)), ['Friends']);
    assert.match(await w.p.innerText('#cnote'), /Friends pick This one or That one\. Only friends who are signed in and 13 or older see it, and one report hides it/);
    await w.p.click('#psend'); await w.p.waitForTimeout(1200);
    assert.match(await w.p.innerText('#toast'), /Posted\. Your friends can see it now\./);
    const row = (await fake.pool.query('select id, scope, photos, status, body from public.posts where user_id = $1 and photos > 0', [writer])).rows[0];
    pid = row.id;
    assert.deepEqual({ ...row, id: 0 }, { id: 0, scope: 'friends', photos: 2, status: 'approved', body: 'Which one?' });
    // What's kept is a plain JPEG: no location, no comment.
    const kept = (await fake.pool.query('select jpeg from public.post_photos where post_id = $1 order by n', [pid])).rows.map(r => r.jpeg);
    assert.equal(kept.length, 2);
    for (const j of kept) { assert.equal(j.subarray(0, 2).toString('hex'), 'ffd8'); assert.doesNotMatch(j.toString('latin1'), /Exif|GPS|Oak Street/); }
    const loaded = (pg, n) => pg.waitForFunction(([i, k]) => document.querySelectorAll('.slide[data-id="p' + i + '"] .duo-imgs img[src^="data:image/jpeg"]').length === k, [pid, n], { timeout: 5000 });
    await loaded(w.p, 2);
    assert.deepEqual(w.errors, []); await w.ctx.close();

    // Signed out, it isn't there and no photo is asked for.
    fake.calls.length = 0;
    const anon = await page();
    await anon.p.waitForTimeout(900);
    assert.equal(await anon.p.$(`.slide[data-id="p${pid}"]`), null);
    assert.ok(!fake.calls.some(c => /get_photos/.test(c)), fake.calls.join(', '));
    assert.deepEqual(anon.errors, []); await anon.ctx.close();

    // A friend who's signed in sees both photos and picks one.
    const f = await page({ es_sb: modSession, es_born: JSON.stringify(yearsAgo(40, '03')), es_friends: JSON.stringify([writerCode]), es_addedIn: JSON.stringify({ [writerCode]: 'live' }) });
    await loaded(f.p, 2);
    const slide = await f.p.$(`.slide[data-id="p${pid}"]`);
    assert.deepEqual(await slide.$$eval('.ans .alabel', b => b.map(x => x.textContent)), ['This one', 'That one']);
    await (await slide.$('.duo-imgs button')).click(); await f.p.waitForTimeout(700);
    assert.equal((await fake.pool.query('select v from public.post_votes where post_id = $1 and user_id = $2', [pid, mod])).rows[0].v, 1);

    // Reported once: hidden for everyone, and in Review its photos are blurred until the moderator taps them.
    await fake.pool.query("insert into public.reports (kind, item_id, user_id) values ('post', $1, $2)", [pid, await newUser()]);
    await f.p.click('#navMe'); await f.p.waitForSelector('#review:not([hidden]) .rphotos img');
    assert.match(await f.p.innerText('#reviewList'), /Photo post · 1 report, hidden until you decide/);
    assert.equal(await f.p.$$eval('#reviewList .rphotos img', i => i.length), 2);
    assert.equal(await f.p.$eval('#reviewList .rphotos', b => getComputedStyle(b.querySelector('img')).filter), 'blur(18px)');
    await f.p.click('#reviewList .rphotos');
    assert.equal(await f.p.$eval('#reviewList .rphotos', b => getComputedStyle(b.querySelector('img')).filter), 'none');
    await f.p.click('#reviewList button:text-is("Keep")'); await f.p.waitForTimeout(900);
    assert.equal(await f.p.$eval('#review', e => e.hidden), true, 'with nothing reported, Review goes away');
    assert.deepEqual(f.errors, []); await f.ctx.close();
  } finally {
    await fake.pool.query("update public.app_config set value = 0 where key in ('photos', 'auto_approve')");
    if (pid) await fake.pool.query('delete from public.posts where id = $1', [pid]);
  }
});
