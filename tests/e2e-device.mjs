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

test('Me: only badges you have, and a streak line that says what helps next', async () => {
  const { p, ctx, errors } = await open();
  await p.click('#navMe'); await p.waitForTimeout(500);
  assert.equal(await p.$$eval('#badges span', b => b.length), 0, 'no locked badges to collect');
  assert.equal(await p.$eval('#badgesNote', e => e.hidden), false);
  assert.equal(await p.innerText('#streakNote'), "Answer today's question to start your streak.");
  await p.click('#navHome'); await p.waitForTimeout(400);
  await p.click('.slide[data-id=daily] .ans'); await p.waitForTimeout(900);
  await p.click('#navMe'); await p.waitForTimeout(500);
  assert.deepEqual(await p.$$eval('#badges span', b => b.map(x => x.textContent)), ['First answer']);
  assert.equal(await p.$eval('#badgesNote', e => e.hidden), true);
  assert.equal(await p.innerText('#streak'), '1');
  assert.equal(await p.innerText('#streakNote'), '1 streak freeze saved. A freeze covers a missed day by itself.');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an invite link adds the friend by name and clears itself; your own link does not; yours carries your code', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(base + '#f=jayk42&n=Jay'); await p.waitForSelector('.slide[data-id=end]');
  assert.equal(await p.evaluate(() => location.hash), '', 'the link is cleared from the address bar');
  assert.equal((await p.innerText('#toast')).trim(), 'Added Jay.', 'nothing to compare before Verd is live, so no promise');
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('es_friends'))), ['JAYK42']);
  await p.click('#navMe'); await p.waitForTimeout(500);
  const list = await p.innerText('#flist');
  assert.match(list, /Jay\s+JAYK42/); assert.match(list, /When Verd goes live, swap new invite links to compare\./);
  const own = await p.evaluate(() => localStorage.getItem('es_myCode:device'));
  assert.match(JSON.parse(own), /^[A-Z2-9]{6}$/);
  await p.evaluate(c => { location.hash = 'f=' + c; }, JSON.parse(own)); await p.waitForTimeout(300);
  assert.match(await p.innerText('#toast'), /That's your own invite link\./);
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('es_friends'))), ['JAYK42'], 'you are not your own friend');
  await p.fill('#myname', ' Sam!! '); await p.dispatchEvent('#myname', 'change');
  assert.equal(await p.inputValue('#myname'), 'Sam', 'only letters make it into a name');
  await p.click('#invite'); await p.waitForTimeout(300);
  const text = await p.evaluate(() => navigator.clipboard.readText());
  assert.ok(text.endsWith('#f=' + JSON.parse(own) + '&n=Sam'), text);
  // Removing a friend takes one tap and says how to undo it
  await p.click('#flist button[aria-label="Remove Jay"]'); await p.waitForTimeout(200);
  assert.match(await p.innerText('#toast'), /Removed Jay\. To add them back, use JAYK42\./);
  assert.deepEqual(await p.evaluate(() => [JSON.parse(localStorage.getItem('es_friends')), JSON.parse(localStorage.getItem('es_nicks'))]), [[], {}]);
  assert.equal(await p.$$eval('#flist > div', d => d.length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('adding a friend: a name in the code box is caught, and a code or a whole invite link both work', async () => {
  const { p, ctx, errors } = await open();
  await p.click('#navMe'); await p.waitForTimeout(400);
  const own = JSON.parse(await p.evaluate(() => localStorage.getItem('es_myCode:device')));
  const err = async v => { await p.fill('#fcode', v); await p.click('#fadd'); await p.waitForTimeout(100); return p.$eval('#ferr', e => e.hidden ? '' : e.textContent); };
  assert.match(await err('Marcus Smith'), /That looks like a name\. Your name goes in the Your name box above/);
  assert.match(await err('Christopher'), /That looks like a name/);
  assert.match(await err('K7MP'), /A code is 6 letters and numbers\. That one has 4\./);
  assert.match(await err('K7MPO2'), /never use 0, 1, I or O/);
  assert.match(await err(own.toLowerCase()), /That's your own code/);
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('es_friends') || '[]')), [], 'nothing was added');
  // typing again clears the message
  await p.type('#fcode', 'x'); assert.equal(await p.$eval('#ferr', e => e.hidden), true);
  // a code with a dash, in lower case, with their name
  await p.fill('#fcode', 'k7m-px2'); await p.fill('#fnick', 'Marcus'); await p.click('#fadd'); await p.waitForTimeout(200);
  assert.equal((await p.innerText('#toast')).trim(), 'Added Marcus.');
  assert.equal(await p.inputValue('#fcode'), ''); assert.equal(await p.inputValue('#fnick'), '');
  // a whole invite link pasted in brings the name with it
  await p.fill('#fcode', 'Answer today\'s question on Verd http://localhost:8094/verd/#f=ZZPQ42&n=Jay%20Lee'); await p.click('#fadd'); await p.waitForTimeout(200);
  assert.equal((await p.innerText('#toast')).trim(), 'Added Jay Lee.');
  // adding the same code again with a name renames them
  await p.fill('#fcode', 'K7MPX2'); await p.fill('#fnick', 'Marc'); await p.click('#fadd'); await p.waitForTimeout(200);
  assert.equal((await p.innerText('#toast')).trim(), 'Renamed to Marc.');
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('es_friends'))), ['K7MPX2', 'ZZPQ42']);
  const list = await p.innerText('#flist');
  assert.match(list, /Marc\s+K7MPX2/); assert.match(list, /Jay Lee\s+ZZPQ42/);
  // a long first name fits in Your name
  await p.fill('#myname', 'Maximiliano Alejandro'); await p.dispatchEvent('#myname', 'change');
  assert.equal(await p.inputValue('#myname'), 'Maximiliano Alejandro');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('state and city wait for one neutral age question, and under 13 they are never kept', async () => {
  for (const [year, ok] of [[new Date().getFullYear() - 10, false], [2000, true]]){
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')){ localStorage.setItem('es_state', '"Texas"'); localStorage.setItem('es_city', '"Austin"'); sessionStorage.setItem('seeded', '1'); } });
    const p = await ctx.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(base); await p.waitForSelector('.slide[data-id=end]');
    await p.click('#navMe'); await p.waitForTimeout(400);
    assert.equal(await p.$eval('#placeFields', e => e.hidden), true, 'no state or city before the question');
    assert.deepEqual([await p.inputValue('#bmonth'), await p.inputValue('#byear')], ['', ''], 'nothing is chosen for you');
    assert.doesNotMatch(await p.innerText('#ageAsk .note'), /13|old|age/i, 'the question does not hint at the cut-off');
    await p.selectOption('#bmonth', '06'); await p.selectOption('#byear', String(year)); await p.waitForTimeout(200);
    assert.equal(await p.$eval('#ageAsk', e => e.hidden), true, 'asked once');
    assert.equal(await p.$eval('#placeFields', e => e.hidden), !ok);
    const kept = await p.evaluate(() => [localStorage.getItem('es_state'), localStorage.getItem('es_city')]);
    if (ok) assert.deepEqual(kept, ['"Texas"', '"Austin"']);
    else { assert.deepEqual(kept, ['""', '""'], 'a child\'s state and city are removed'); assert.match(await p.innerText('#placeNote'), /13 and older/); }
    await p.click('#navPlus'); await p.waitForTimeout(300);
    assert.deepEqual(await p.$$eval('#aud button', b => b.map(x => x.textContent)), ok ? ['World', 'Country', 'State', 'City', 'Friends'] : ['World', 'Country', 'Friends']);
    await p.click('#cclose'); await p.waitForTimeout(200);
    await p.reload(); await p.waitForSelector('.slide[data-id=end]'); await p.click('#navMe'); await p.waitForTimeout(300);
    assert.equal(await p.$eval('#ageAsk', e => e.hidden), true, 'the answer is kept on the phone and not asked again');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('share and invite links use the address the public site was opened at', async () => {
  const site = 'https://heatedbandz.github.io/Verd/';
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  // Serve the local copy at the real address. GitHub Pages paths are case-sensitive, and the repo is "Verd".
  await ctx.route(site + '**', async route => route.fulfill({ response: await route.fetch({ url: base + route.request().url().slice(site.length) }) }));
  const p = await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(site); await p.waitForSelector('.slide[data-id=end]');
  await p.click('#navMe'); await p.waitForTimeout(300); await p.click('#invite'); await p.waitForTimeout(300);
  const link = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /\shttps:\/\/heatedbandz\.github\.io\/Verd\/#f=[A-Z2-9]{6}$/, link);
  assert.deepEqual(errors, []);
  await ctx.close();
});


test('on a computer the app sits in a phone-sized frame that fills the window, even when extensions add to the page', async () => {
  // Browser extensions (password managers, writing helpers) put their own elements into <body>, often one before the
  // app and one after. When <body> centred the app as a grid, each one took a share of the height and the frame
  // shrank to a third, with the question running into the logo. A window under 560 x 700 gets the phone layout.
  for (const [w, h] of [[1512, 950], [1440, 900], [1280, 720], [1920, 1080], [500, 800]]) for (const added of [false, true]){
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    if (added) await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      document.body.prepend(document.createElement('ext-before')); document.body.append(document.createElement('ext-after'));
    }));
    const p = await ctx.newPage(), errors = [], at = `${w}x${h}${added ? ' with extension elements' : ''}`;
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(base); await p.waitForSelector('.slide[data-id=end]');
    assert.equal(await p.$$eval('body > ext-before, body > ext-after', e => e.length), added ? 2 : 0);
    const box = await p.$eval('.app', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const framed = w >= 560 && h >= 700, fw = framed ? 420 : Math.min(480, w), fh = framed ? Math.min(860, h - 48) : h;
    assert.deepEqual(box, { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh }, at + ': the app is not the size it should be, or not centred');
    // Today's question has room: it starts below the logo, and its answers end above the bar at the bottom.
    const r = await p.evaluate(() => { const b = s => document.querySelector(s).getBoundingClientRect();
      return { logo: b('.top .brand').bottom, question: b('.slide[data-id=daily] .stext').top, answers: b('.slide[data-id=daily] .answers').bottom, nav: b('.nav').top }; });
    assert.ok(r.question > r.logo, at + ': the question runs into the logo');
    assert.ok(r.answers < r.nav, at + ': the answers run into the bar at the bottom');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
