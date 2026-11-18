// Draws Verd's app icons and iPhone launch screens from one SVG mark, with the browser Playwright ships.
// Run from the repo:  node tools/make-icons.mjs   (needs Playwright, e.g. cd tests && npm install)
// Writes icons/*.png and splash/*.png. Run it again only if the mark or the list of iPhones changes.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../tests/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = new URL('..', import.meta.url).pathname;

const BG = '#0b0b0b', INK = '#fbfbf9', DOT = '#2bd98a';
// The mark: a V and a green dot, the same drawing as the favicon. size is the mark's box in CSS px.
const mark = size => `<svg width="${size}" height="${size}" viewBox="5 6 24 20"><path d="M8 10l6.2 13h1.6L22 10" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="22" r="2.4" fill="${DOT}"/></svg>`;
const page = (body, bg = BG, radius = 0) => `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:fixed;inset:0;display:grid;place-items:center;background:${bg};border-radius:${radius}">${body}</div></body></html>`;

// Icons: "any" has rounded corners on a clear background; maskable and Apple's are full-bleed (the system rounds them).
// Maskable icons keep the mark inside the middle 80% circle, which is all some launchers show.
const ICONS = [
  ['icons/icon-192.png', 192, 0.62, '22%'], ['icons/icon-512.png', 512, 0.62, '22%'],
  ['icons/maskable-512.png', 512, 0.5, 0], ['icons/apple-touch-icon.png', 180, 0.6, 0]
];
// Launch screens for current iPhones: CSS width x height at a pixel ratio. The mark sits in the middle, small.
export const IPHONES = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [420, 912, 3], [393, 852, 3], [428, 926, 3],
  [390, 844, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2]
];

mkdirSync(root + 'icons', { recursive: true }); mkdirSync(root + 'splash', { recursive: true });
const browser = await chromium.launch();
for (const [file, px, k, radius] of ICONS){
  const p = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  await p.setContent(page(mark(Math.round(px * k)), BG, radius));
  await p.screenshot({ path: root + file, omitBackground: true }); await p.close();
}
for (const [w, h, dpr] of IPHONES){
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  await p.setContent(page(mark(72)));
  await p.screenshot({ path: `${root}splash/${w * dpr}x${h * dpr}.png` }); await p.close();
}
await browser.close();
console.log('wrote', ICONS.length, 'icons and', IPHONES.length, 'launch screens');
