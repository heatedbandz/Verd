// WCAG AA contrast for every colour pair Verd draws text or icons with, in light and dark.
// Reads the real values: the slide palette and the tokens, both from index.html.
//   node tests/contrast.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');

const rgb = c => {
  const m = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  const r = c.match(/rgba?\(([^)]+)\)/); if (!r) throw new Error('colour? ' + c);
  const v = r[1].split(',').map(Number); return [v[0], v[1], v[2], v[3] ?? 1];
};
const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => a * top[i] + (1 - a) * under[i]).concat(1); };  // sRGB blend, like CSS
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function tokens(block){ const t = {}; for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim(); return t; }
const light = tokens(html.match(/:root\{([\s\S]*?)\n\}/)[1]);
const dark = { ...light, ...tokens(html.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\}/)[1]) };
const COLORS = JSON.parse(html.match(/<script type="application\/json" id="verd-data">([\s\S]*?)<\/script>/)[1]).colors;
const WHITE = rgb('#ffffff');
const AA = 4.5, LARGE = 3, UI = 3;   // normal text, large text (≥ 24px or ≥ 18.7px bold), icons and controls

test('white text on every slide colour, both ends of the gradient, under the sheen', () => {
  const sheen = rgb(light.sheen);
  for (const pair of COLORS) for (const c of pair){
    const r = ratio(WHITE, over(sheen, rgb(c)));
    assert.ok(r >= AA, `${c}: ${r.toFixed(2)}`);
  }
});

test('answer buttons: label on the glass, and percentages on the result bars', () => {
  for (const [c0, c1] of COLORS){
    const mid = over([...rgb(c0).slice(0, 3), 0.5], rgb(c1));
    const glass = over(rgb(light.glass), mid);
    assert.ok(ratio(WHITE, glass) >= AA, `${c0} glass ${ratio(WHITE, glass).toFixed(2)}`);
    for (const f of ['fill', 'fill-mine']){
      const r = ratio(WHITE, over(rgb(light[f]), glass));
      assert.ok(r >= LARGE, `${c0} ${f} ${r.toFixed(2)} (labels are 20px bold, percentages 32px bold)`);
    }
  }
});

test('page text in light and dark', () => {
  for (const [name, t] of [['light', light], ['dark', dark]]){
    const pairs = [['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface-2'], ['muted', 'bg'], ['muted', 'surface'], ['accent-ink', 'bg'], ['accent-ink', 'accent-tint'], ['bg', 'ink']];
    for (const [fg, bg] of pairs){
      const r = ratio(rgb(t[fg]), rgb(t[bg]));
      assert.ok(r >= AA, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}`);
    }
  }
});

test('the floating bar over the feed: icons stay readable even over a white photo', () => {
  const bar = over(rgb(light['nav-glass']), WHITE);   // worst case behind the glass
  assert.ok(ratio(over(rgb(light['nav-icon']), bar), bar) >= UI, 'inactive icon ' + ratio(over(rgb(light['nav-icon']), bar), bar).toFixed(2));
  assert.ok(ratio(WHITE, bar) >= AA, 'active icon');
  const black = over(rgb(light['nav-glass']), rgb('#000000'));
  assert.ok(ratio(over(rgb(light['nav-icon']), black), black) >= UI);
});

test('the bar on pages: icons over the frosted page colour, in light and dark', () => {
  for (const [name, t] of [['light', light], ['dark', dark]]){
    for (const behind of [t.bg, '#17181a', '#ffffff', ...COLORS.map(c => c[0])]){
      const bar = over(rgb(t['paged-glass']), rgb(behind));
      assert.ok(ratio(rgb(t.ink), bar) >= UI, `${name} active over ${behind}`);
      assert.ok(ratio(rgb(t.muted), bar) >= UI, `${name} inactive over ${behind}: ${ratio(rgb(t.muted), bar).toFixed(2)}`);
    }
  }
});
