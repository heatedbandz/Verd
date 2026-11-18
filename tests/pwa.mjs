// The installed app. Chrome sees an installable app; every icon and iPhone launch screen the page names exists at
// its exact size; after one visit Verd opens with no connection and keeps an answer made offline; the service
// worker leaves the site's other pages alone; a new version arrives by itself; the status bar matches the screen.
//
//   cd tests && node --test pwa.mjs     (needs Playwright)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serveSite } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(ROOT + 'index.html', 'utf8');
let server, base, extra = '';   // extra: added to the end of app.js by the server, to ship "a new version"

before(async () => {
  server = await serveSite(8095, (p, body) => p === '/app.js' && extra ? Buffer.concat([body, Buffer.from(extra)]) : body);
  base = 'http://localhost:8095/verd/';
});
after(() => server?.close());

// A phone that has never seen Verd: its own profile, so nothing is cached.
async function phone(opts = {}){
  const dir = mkdtempSync(path.join(tmpdir(), 'verd-pwa-'));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 390, height: 844 }, ...opts });
  const p = ctx.pages()[0] || await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, p, errors, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}
// The first visit, until the service worker has the app cached and is in charge of the page.
async function visit(p){
  await p.goto(base); await p.waitForSelector('.slide[data-id=end]');
  const ok = await p.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100));
    return !!navigator.serviceWorker.controller;
  });
  assert.ok(ok, 'the service worker never took over the page');
}
// The end slide is drawn only by app.js, so seeing it means the app itself ran, not just the page painted from HTML.
const launch = async p => { await p.reload(); await p.waitForSelector('.slide[data-id=end]'); };
const daily = p => p.evaluate(() => document.querySelector('.slide[data-id=daily]').innerText);

test('Chrome sees an installable app with a valid manifest', async () => {
  const { p, ctx, errors, close } = await phone();
  await visit(p);
  const cdp = await ctx.newCDPSession(p);
  assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
  const m = await cdp.send('Page.getAppManifest');
  assert.deepEqual(m.errors, []);
  const man = JSON.parse(m.data);
  assert.equal(man.display, 'standalone');
  assert.equal(new URL(man.start_url, m.url).href, base, 'opens at the app, with relative paths');
  assert.equal(man.background_color, '#0b0b0b'); assert.equal(man.theme_color, '#0b0b0b');
  assert.ok(man.icons.some(i => i.purpose === 'maskable'), 'a maskable icon for Android');
  assert.deepEqual(errors, []);
  await close();
});

test('every icon and iPhone launch screen the page names exists, at its exact size', () => {
  // [width, height, colour type]: 2 is RGB, 6 is RGBA
  const png = f => { const b = readFileSync(ROOT + f); assert.equal(b.toString('latin1', 1, 4), 'PNG', f); return [b.readUInt32BE(16), b.readUInt32BE(20), b[25]]; };
  const man = JSON.parse(readFileSync(ROOT + 'manifest.webmanifest', 'utf8'));
  for (const i of man.icons) assert.deepEqual(png(i.src).slice(0, 2), i.sizes.split('x').map(Number), i.src);
  // Full-bleed icons must have no see-through pixels: iOS would show black behind them.
  assert.deepEqual(png('icons/apple-touch-icon.png'), [180, 180, 2]);
  assert.equal(png('icons/maskable-512.png')[2], 2);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon.png">/);
  const shots = [...html.matchAll(/<link rel="apple-touch-startup-image" media="\(device-width:(\d+)px\) and \(device-height:(\d+)px\) and \(-webkit-device-pixel-ratio:(\d)\) and \(orientation:portrait\)" href="([^"]+)">/g)];
  assert.equal(shots.length, 11, 'a launch screen for each current iPhone size');
  for (const [, w, h, d, f] of shots) assert.deepEqual(png(f).slice(0, 2), [w * d, h * d], f);
  // iOS ignores launch screens without this tag, even when the manifest says standalone.
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
});

test('after one visit Verd opens with no connection, and an answer made offline is kept', async () => {
  const { p, ctx, errors, close } = await phone();
  await visit(p);
  const question = await p.$eval('.slide[data-id=daily] .stext', e => e.textContent);
  await ctx.setOffline(true);
  // Really offline: anything the app didn't keep fails to load. (That failure is expected, so it's not an error here.)
  assert.equal(await p.evaluate(() => fetch('README.md').then(() => 'loaded', () => 'failed')), 'failed');
  errors.length = 0;
  await launch(p);
  assert.equal(await p.$eval('.slide[data-id=daily] .stext', e => e.textContent), question);
  await p.click('.slide[data-id=daily] .ans'); await p.waitForTimeout(800);
  assert.match(await daily(p), /Your answer is saved\./);
  await launch(p); await p.waitForTimeout(300);
  assert.equal(await p.$$eval('.slide[data-id=daily] .ans.mine', b => b.length), 1, 'the answer was kept');
  assert.deepEqual(errors, []);
  await close();
});

test("the service worker leaves the site's other pages alone", async () => {
  const { p, ctx, close } = await phone();
  await visit(p);
  await ctx.setOffline(true);
  // Offline, the plan should fail to load like any web page, not turn into the app.
  await assert.rejects(p.goto(base + 'PLAN.md'), /ERR_INTERNET_DISCONNECTED/);
  await close();
});

test('a new version arrives by itself: one launch fetches it in the background, the next one runs it', async () => {
  const { p, errors, close } = await phone();
  try {
    await visit(p);
    extra = '\n;window.verdVersion = 2;\n';
    await launch(p);
    assert.equal(await p.evaluate(() => window.verdVersion), undefined, 'this launch opens instantly, from the phone');
    await p.waitForFunction(async () => (await (await caches.open('verd-shell')).match('app.js')).text().then(t => t.includes('verdVersion')), null, { timeout: 5000 });
    await launch(p);
    assert.equal(await p.evaluate(() => window.verdVersion), 2, 'the launch after that runs the new version');
    assert.deepEqual(errors, []);
  } finally { extra = ''; await close(); }
});

test('the status bar takes the colour of whatever is under it, in both themes', async () => {
  for (const [scheme, page] of [['light', '#ffffff'], ['dark', '#0b0b0b']]){
    const { p, errors, close } = await phone({ colorScheme: scheme });
    await p.goto(base); await p.waitForSelector('.slide[data-id=end]');
    const bar = () => p.$eval('meta[name=theme-color]', m => m.content);
    assert.equal(await bar(), '#0b0b0b', 'over the feed, ' + scheme);
    await p.click('#navMe'); await p.waitForTimeout(400);
    assert.equal(await bar(), page, 'over Me, ' + scheme);
    if (scheme === 'light'){
      await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(100);
      assert.equal(await bar(), '#0b0b0b', 'the phone switched to dark while Me was open');
      await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(100);
    }
    await p.click('#navHome'); await p.waitForTimeout(400);
    assert.equal(await bar(), '#0b0b0b', 'back over the feed, ' + scheme);
    assert.deepEqual(errors, []);
    await close();
  }
});
