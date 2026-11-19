// Opens Verd in Chromium against the REAL database without answering, so nothing is stored.
// Passes when the app runs live, the database answers today's count, no account is made just by looking,
// and nothing logs an error. GitHub runs it after every change (.github/workflows/live-check.yml).
//
//   cd tests && node live-smoke.mjs       (needs Playwright with Chromium, and a network that reaches the project)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
const failedLoads = [];   // what a "Failed to load resource" error was about: method, path (never the query) and status
p.on('response', r => { const what = r.request().method() + ' ' + new URL(r.url()).pathname + ' ' + r.status();
  if (/\.supabase\.co\//.test(r.url())) calls.push(what); if (r.status() >= 400) failedLoads.push(what); });
await p.goto('http://localhost:8099/verd/');
await p.waitForFunction(() => /^Live/.test(document.getElementById('mode').textContent), null, { timeout: 15000 }).catch(() => {});
await p.waitForTimeout(4000);
// Me, where Sign in with Google shows once sign-in is ready. Looking at it asks the database nothing new.
await p.click('#navMe'); await p.waitForTimeout(800);
const signInShown = await p.$eval('#account', e => !e.hidden);

check(/^Live/.test(await p.textContent('#mode')), 'the app runs live', await p.textContent('#mode'));
check(calls.some(c => /^POST \/rest\/v1\/rpc\/get_results 200$/.test(c)), "the database answers today's count", calls.join(', ') || 'no calls');
check(!calls.some(c => /\/auth\/v1\/signup/.test(c)), 'no account is made just by looking', calls.join(', '));
const daily = await p.innerText('.slide[data-id=daily]');
check(/Be the first to answer today\.|so far\. Be one of the first 50 to vote\.|answered\. Tap to see the verdict\./.test(daily), "today's question shows the live count line", daily.replace(/\s+/g, ' ').slice(0, 160));
check(!/Couldn't load|Can't connect/.test(await p.innerText('body')), 'no error state on screen');
// The setup done in another order: Google sign-in is on, but the posting part of setup.sql (step 1) isn't installed.
// The app asks for posts once, hears there's no such function, and stays the daily question with sign-in hidden.
// That's a setup step still to do, not a fault in the app, so it's a note. Confirmed the way live-rls.mjs checks it.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8'), setting = k => (app.match(new RegExp(k + ': "([^"]*)"')) || [])[1] || '';
let postingMissing = false;
if (failedLoads.length && failedLoads.every(f => f === 'POST /rest/v1/rpc/get_posts 404')){
  const r = await fetch(setting('supabaseUrl').replace(/\/+$/, '') + '/rest/v1/rpc/get_posts', { method: 'POST', headers: { apikey: setting('supabaseKey'), 'Content-Type': 'application/json' }, body: '{}' });
  postingMissing = r.status === 404;
}
if (postingMissing) console.log('NOTE Google sign-in is on, but the posting part of setup.sql is not installed yet: step 1 of the setup is still to do.');
const loud = postingMissing ? errors.filter(e => !/^Failed to load resource: the server responded with a status of 404\b/.test(e)) : errors;
check(loud.length === 0, 'no console errors', loud.join(' | ') + (failedLoads.length ? '  [failed: ' + failedLoads.join(', ') + ']' : ''));
check(!postingMissing || failedLoads.length === 1, 'with the posting part missing, posts are asked for once', failedLoads.join(', '));
check(!postingMissing || !signInShown, 'with the posting part missing, sign-in stays hidden');

await browser.close(); server.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed: Verd runs live against its database.');
process.exit(failed ? 1 : 0);
