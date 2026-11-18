// The reveal, end to end, against the real setup.sql: answer → guess → reveal → share card.
// Checks the hard rules (the count-up lands exactly on the database's number, the guess line is
// right, the card is 1080 × 1350 and never names the winning side) and prints the feel numbers
// (tap latency, frames during the reveal) with the CPU slowed 4×, like a mid-range phone.
//
//   cd tests && node --test reveal.mjs           (needs Postgres and Playwright)
//   SHOTS=/some/dir node --test reveal.mjs       also saves screenshots of each step
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { startFakeSupabase } from './fake-supabase.mjs';
import { serveSite } from './serve.mjs';
import { shares } from '../core.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ADMIN_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const DB = 'verd_reveal', SHOTS = process.env.SHOTS;
let fake, site, browser, today, pool;

before(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`); await root.query(`create database ${DB}`); await root.end();
  const url = new URL(ADMIN_URL); url.pathname = '/' + DB;
  pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(readFileSync(new URL('./supabase-stub.sql', import.meta.url), 'utf8'));
  await pool.query(readFileSync(new URL('../setup.sql', import.meta.url), 'utf8'));
  today = (await pool.query('select verd_private.today()::text as d')).rows[0].d;
  fake = await startFakeSupabase({ databaseUrl: url.toString(), port: 54331 });
  site = await serveSite(8095);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); site?.close(); await fake?.close(); await pool?.end(); });

async function seed(day, counts){
  for (const [choice, k] of counts.entries()) for (let i = 0; i < k; i++){
    const id = (await pool.query('insert into auth.users (id) values (gen_random_uuid()) returning id')).rows[0].id;
    await pool.query('insert into public.votes (day, user_id, choice, country) values ($1, $2, $3, $4)', [day, id, choice, 'US']);
  }
}

async function open(scheme){
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route('**/app.js', async route => {
    const r = await route.fetch(); const js = (await r.text()).replace('supabaseUrl: ""', `supabaseUrl: "${fake.url}"`).replace('supabaseKey: ""', `supabaseKey: "${fake.anonKey}"`);
    await route.fulfill({ response: r, body: js });
  });
  if (process.env.NOVT) await ctx.addInitScript(() => { delete Document.prototype.startViewTransition; });
  await ctx.addInitScript(() => {
    window.__ev = [];
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.interactionId) window.__ev.push({ id: e.interactionId, dur: e.duration }); }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    window.__frames = ms => new Promise(res => { const ts = [], t0 = performance.now(); const f = t => { ts.push(t); if (t - t0 < ms) requestAnimationFrame(f); else res(ts); }; requestAnimationFrame(f); });
  });
  const p = await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://localhost:8095/verd/'); await p.waitForSelector('.slide[data-id=daily] .ans');
  await p.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(p);
  return { p, ctx, cdp, errors };
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const worstTap = async p => { const ev = await p.evaluate(() => window.__ev.splice(0)); const by = {}; for (const e of ev) by[e.id] = Math.max(by[e.id] || 0, e.dur); return Math.max(0, ...Object.values(by)); };

for (const scheme of ['light', 'dark']){
  test(`answer, guess, reveal and share (${scheme})`, async () => {
    await pool.query('delete from public.votes'); await seed(today, [8, 4]);   // 12 people already answered: over the minimum of 10
    const { p, ctx, cdp, errors } = await open(scheme);
    await shot(p, `${scheme}-1-open`);
    assert.match(await p.innerText('.slide[data-id=daily]'), /12 people so far\. Be one of the first 50 to vote\./);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await p.click('.slide[data-id=daily] .ans');                      // answer: the first option
    await p.waitForSelector('[data-guess]', { timeout: 2000 });
    const tapAnswer = await worstTap(p);
    await p.waitForTimeout(500); await shot(p, `${scheme}-2-guess`);
    assert.match(await p.innerText('.slide[data-id=daily]'), /How many people picked/);

    const frames = p.evaluate(() => window.__frames(1800));
    await p.click('[data-guess=most]');                                // guess: most people
    const ts = await frames, gaps = ts.slice(1).map((t, i) => t - ts[i]);
    const tapGuess = await worstTap(p);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await p.waitForTimeout(300); await shot(p, `${scheme}-3-reveal`);

    // the count-up lands exactly on the database's own numbers
    const counts = (await pool.query('select choice, count(*)::int as k from public.votes where day = $1 group by choice order by choice', [today])).rows.map(r => r.k);
    const expected = shares(counts).map(x => x + '%');
    const shown = await p.$$eval('.slide[data-id=daily] .apct', es => es.map(e => e.textContent));
    assert.deepEqual(shown, expected);
    const text = await p.innerText('.slide[data-id=daily]');
    assert.match(text, new RegExp(`You called it\\. ${shares(counts)[0]}% are with you\\.`));
    assert.match(text, /13 answers/);

    // share: no share sheet in this browser, so the card is saved and the text copied
    const [download] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click('.slide[data-id=daily] .iact[aria-label=Share]')]);
    const file = await download.path(), png = readFileSync(file);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1080, 1350]);
    if (SHOTS) writeFileSync(`${SHOTS}/${scheme}-4-card.png`, png);
    assert.deepEqual(errors, []);
    const longFrames = gaps.filter(g => g > 20).length, worst = Math.round(Math.max(...gaps));
    console.log(`# ${scheme}: answer tap ${Math.round(tapAnswer)} ms, guess tap ${Math.round(tapGuess)} ms, reveal frames ${ts.length}, over 20 ms: ${longFrames} (at frame ${gaps.map((g, i) => g > 20 ? i : -1).filter(i => i >= 0).join(',')}), worst ${worst} ms (4× CPU)`);
    assert.ok(tapAnswer < 100 && tapGuess < 100, 'a tap took 100 ms or more');
    await ctx.close();
  });
}

test('the share card text never names the winning side', async () => {
  await pool.query('delete from public.votes'); await seed(today, [3, 9]);
  const { p, ctx } = await open('light');
  await p.evaluate(() => { window.__drawn = []; const f = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function(t, ...a){ window.__drawn.push(String(t)); return f.call(this, t, ...a); }; });
  await p.click('.slide[data-id=daily] .ans');
  await (await p.waitForSelector('[data-guess]')).click(); await p.waitForTimeout(1500);
  const [download] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click('.slide[data-id=daily] .iact[aria-label=Share]')]);
  await download.path();
  const drawn = await p.evaluate(() => window.__drawn);
  assert.ok(drawn.includes("What's the Verd?"), 'branding is on the card');
  assert.ok(drawn.some(t => /^I'm with \d+% of 13 people\.$/.test(t)), drawn.join(' | '));
  for (const t of drawn) assert.doesNotMatch(t, /won|winning|majority|Dogs \d|Cats \d|\d+% (Cats|Dogs)/, t);
  await ctx.close();
});
