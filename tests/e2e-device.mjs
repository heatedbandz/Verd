// The public site with no database connected ("device" mode): nothing but your own answer is known,
// so no percentage, count or verdict may appear anywhere. Also checks an answer can't be changed.
//
//   cd tests && node --test e2e-device.mjs     (needs Playwright)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { serveSite } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let server, browser, base;

before(async () => { server = await serveSite(8094); base = 'http://localhost:8094/verd/'; browser = await chromium.launch(); });
after(async () => { await browser?.close(); server?.close(); });

async function open(scheme = 'light'){
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, serviceWorkers: 'block' });
  const p = await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(base); await p.waitForSelector('.slide[data-id=daily] .ans');
  return { p, ctx, errors };
}
const dailyText = p => p.evaluate(() => document.querySelector('.slide[data-id=daily]').innerText);

test('no database: the reveal shows no percentage, count or fake verdict', async () => {
  const { p, ctx, errors } = await open();
  assert.match(await dailyText(p), /Tap your answer\./);
  await p.click('.slide[data-id=daily] .ans');
  await p.waitForTimeout(600);
  assert.equal(await p.$('[data-guess]'), null, 'no guess step with no database: there is nothing to check it against');
  await p.waitForTimeout(600);
  const text = await dailyText(p);
  assert.doesNotMatch(text, /\d\s*%/, 'a percentage appeared with no database: ' + text);
  assert.doesNotMatch(text, /first voice|of Earth|people answered|Plot twist|agree with you/i, text);
  assert.match(text, /Your answer is saved\./);
  assert.match(text, /aren't switched on yet/);
  // the whole page, not just the slide
  const all = await p.evaluate(() => document.body.innerText);
  assert.doesNotMatch(all, /\d\s*%/, 'a percentage appeared somewhere on the page');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an answer is locked in: tapping the other side does nothing', async () => {
  const { p, ctx } = await open('dark');
  await p.click('.slide[data-id=daily] .ans');
  const g = await p.$('[data-guess]'); if (g) await g.click();
  await p.waitForTimeout(400);
  const enabled = await p.$$eval('.slide[data-id=daily] .ans', bs => bs.filter(b => !b.disabled).length);
  assert.equal(enabled, 0);
  const saved = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('es_myVotes')))[0].choice);
  assert.equal(saved, 0);
  await ctx.close();
});

test('the feed has a real end: no dead tabs, when the next question drops, and its topic', async () => {
  const { p, ctx, errors } = await open();
  assert.equal(await p.$eval('#scopes', e => e.hidden), true, 'scope tabs show with no posts to filter');
  await p.evaluate(() => { const f = document.getElementById('feed'); f.scrollTo(0, f.scrollHeight); });
  const end = () => p.evaluate(() => document.querySelector('.slide[data-id=end]').innerText);
  const text = await end();
  assert.match(text, /You're caught up\./);
  assert.match(text, /Tomorrow's question drops in (\d+h )?\d+m\./);
  assert.match(text, /Tomorrow's topic\s*(School|Food|Money|Tech|Would you rather|Hot takes|Space & future|Everyday life)/);
  assert.match(text, /Answer today's question/);
  await p.click('.slide[data-id=end] .cta'); await p.waitForTimeout(400);
  assert.equal(await p.$eval('#feed', f => f.scrollTop), 0, 'the button goes back to today');
  await p.click('.slide[data-id=daily] .ans'); await p.waitForTimeout(500);
  assert.doesNotMatch(await end(), /Answer today's question/, 'still asks after answering');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('search finds questions that are out, announces ones coming up, and a past one has no fake verdict', async () => {
  const { p, ctx, errors } = await open();
  const q = await p.$eval('.slide[data-id=daily] .stext', e => e.textContent);
  await p.click('#navSearch'); await p.waitForTimeout(400);
  const home = await p.innerText('#sres');
  assert.match(home, /Topics/); assert.doesNotMatch(home, /Be the first/);
  assert.match(home, /Questions so far/); assert.ok(home.includes(q), 'today is not in the list');
  // the longest word of today's question finds it
  const word = q.replace(/[^A-Za-z ]/g, '').split(' ').sort((a, b) => b.length - a.length)[0];
  await p.fill('#q', word); await p.waitForTimeout(200);
  assert.match(await p.innerText('#sres'), /Today's question/);
  await p.fill('#q', 'zzqx'); await p.waitForTimeout(200);
  assert.match(await p.innerText('#sres'), /Nothing on “zzqx” yet\./);
  // yesterday's question: no database, so no verdict and no percentage
  await p.fill('#q', ''); await p.waitForTimeout(200);
  const rows = await p.$$('#sres .res'); await rows[rows.length - 1].click(); await p.waitForTimeout(400);
  const past = await p.innerText('#dayview');
  assert.match(past, /Live results weren't switched on yet/); assert.doesNotMatch(past, /\d\s*%/);
  await p.click('#dclose'); assert.equal(await p.$eval('#dayview', e => e.hidden), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
