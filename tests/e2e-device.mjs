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
  const g = await p.$('[data-guess]'); if (g) await g.click();
  await p.waitForTimeout(1200);
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
