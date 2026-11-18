// Opens Verd in Chromium against the REAL database without answering, so nothing is stored.
// Passes when the app runs live, the database answers today's count, no account is made just by looking,
// and nothing logs an error.
//
//   cd tests && node live-smoke.mjs       (needs Playwright with Chromium, and a network that reaches the project)
import { createRequire } from 'node:module';
import { serveSite } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let failed = 0;
const check = (ok, what, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + what + (ok ? '' : '  ' + detail)); if (!ok) failed++; };

const server = await serveSite(8099, undefined, { live: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const p = await ctx.newPage(), errors = [], calls = [];
p.on('pageerror', e => errors.push(e.message));
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
p.on('response', r => { if (/\.supabase\.co\//.test(r.url())) calls.push(r.request().method() + ' ' + new URL(r.url()).pathname + ' ' + r.status()); });
await p.goto('http://localhost:8099/verd/');
await p.waitForFunction(() => /^Live/.test(document.getElementById('mode').textContent), null, { timeout: 15000 }).catch(() => {});
await p.waitForTimeout(4000);

check(/^Live/.test(await p.textContent('#mode')), 'the app runs live', await p.textContent('#mode'));
check(calls.some(c => /^POST \/rest\/v1\/rpc\/get_results 200$/.test(c)), "the database answers today's count", calls.join(', ') || 'no calls');
check(!calls.some(c => /\/auth\/v1\/signup/.test(c)), 'no account is made just by looking', calls.join(', '));
const daily = await p.innerText('.slide[data-id=daily]');
check(/Be the first to answer today\.|so far\. Be one of the first 50 to vote\.|answered\. Tap to see the verdict\./.test(daily), "today's question shows the live count line", daily.replace(/\s+/g, ' ').slice(0, 160));
check(!/Couldn't load|Can't connect/.test(await p.innerText('body')), 'no error state on screen');
check(errors.length === 0, 'no console errors', errors.join(' | '));

await browser.close(); server.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed: Verd runs live against its database.');
process.exit(failed ? 1 : 0);
