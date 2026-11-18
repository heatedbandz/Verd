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
  assert.match(await p.innerText('#flist'), new RegExp('Jay · ' + fcode + '\\s+Matches start after your first answer\\.'));
  await p.click('#navHome'); await p.waitForTimeout(300); await tap(p, 0); await p.waitForTimeout(1500);
  const rows = (await fake.pool.query('select user_id from public.friend_adds where code = $1', [fcode])).rows;
  assert.equal(rows.length, 1, 'the database got your friend list once you had an account');
  await p.click('#navMe'); await p.waitForTimeout(900);
  assert.match(await p.innerText('#flist'), /Shows once they add you too\./);
  // They add you back, and you both answered the same 3 past days: 2 alike
  const me = rows[0].user_id, mycode = (await fake.pool.query('select code from public.profiles where id = $1', [me])).rows[0].code;
  await fake.pool.query('insert into public.friend_adds (user_id, code) values ($1, $2)', [friend, mycode]);
  for (const [d, c] of [[1, 0], [2, 0], [3, 1]]) await fake.pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, $3, $4) on conflict do nothing', [day(today, -d), me, c, 'US']);
  await p.click('#navHome'); await p.waitForTimeout(300); await p.click('#navMe'); await p.waitForTimeout(900);
  assert.match(await p.innerText('#flist'), /Jay · \w{6}\s+67% match/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('friends added before Verd went live are asked for a new link, their stand-in codes stay off the server, and removing ends a match', async () => {
  const friend = await newUser(), fcode = (await fake.pool.query('select verd_private.ensure_profile($1) as c', [friend])).rows[0].c;
  const { p, ctx, errors } = await page({ es_friends: JSON.stringify(['OLDJAY']), es_nicks: JSON.stringify({ OLDJAY: 'Jay' }) }, '#f=' + fcode + '&n=Sam');
  assert.match(await p.innerText('#toast'), /Added Sam\. Send your link back so you can compare\./);
  await tap(p, 0); await p.waitForTimeout(1500);
  const sent = async () => (await fake.pool.query('select code from public.friend_adds where code in ($1, $2) order by code', [fcode, 'OLDJAY'])).rows.map(r => r.code);
  assert.deepEqual(await sent(), [fcode], 'only the friend added since launch is sent');
  await p.click('#navMe'); await p.waitForTimeout(900);
  const list = await p.innerText('#flist');
  assert.match(list, /Jay · OLDJAY\s+Added before Verd went live\. Send them your new invite link\./);
  assert.match(list, new RegExp('Sam · ' + fcode + '\\s+Shows once they add you too\\.'));
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

test('posting stays off on the live site: no post button, no tabs, nothing opens the composer', async () => {
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
  const rows = await p.$$('#sres .res'); await rows[rows.length - 1].click(); await p.waitForTimeout(900);
  const text = await p.innerText('#dayview');
  if (n >= 10) assert.match(text, /\d+%/);
  else if (n) { assert.match(text, /Not enough answers for a verdict\./); assert.ok(text.includes(n + (n === 1 ? ' person' : ' people') + ' answered. A verdict needs 10.'), text); }
  else assert.match(text, /Nobody answered this one on Verd\./);
  assert.doesNotMatch(n >= 10 ? '' : text, /\d\s*%/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
