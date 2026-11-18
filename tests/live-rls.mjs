// Attacks the REAL Supabase project over HTTPS with the public key, like anyone on the internet could.
// Every check must be denied. It casts no votes, so real results stay clean.
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_KEY=sb_publishable_... node tests/live-rls.mjs
// (SUPABASE_ANON_KEY works too, for an older project's anon public key.)
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_KEY'); process.exit(2); }

let failed = 0;
const check = (ok, what, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + what + (ok ? '' : '  ' + detail)); if (!ok) failed++; };
// Signed out, the key goes only in apikey, as the app sends it: a publishable key isn't a token.
const h = token => ({ apikey: key, ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' });
const today = new Date().toISOString().slice(0, 10);

async function signIn() {
  const r = await fetch(url + '/auth/v1/signup', { method: 'POST', headers: h(), body: JSON.stringify({ data: {} }) });
  const b = await r.json(); if (!r.ok) throw new Error('anonymous sign-in failed (is it switched on?): ' + JSON.stringify(b));
  return b.access_token;
}
const denied = r => r.status === 401 || r.status === 403 || r.status === 404;

const user = await signIn();
for (const [who, token] of [['anon', null], ['signed-in user', user]]) {
  for (const t of ['votes', 'profiles', 'suggestions', 'app_config', 'blocked_terms', 'friend_adds']) {
    const r = await fetch(`${url}/rest/v1/${t}?select=*`, { headers: h(token) });
    const body = await r.text();
    check(denied(r) || body === '[]', `${who} cannot read ${t}`, `${r.status} ${body.slice(0, 120)}`);
    check(!/user_id|"choice"/.test(body), `${who} sees no raw rows in ${t}`, body.slice(0, 120));
  }
  for (const [m, body] of [['POST', { day: today, choice: 0 }], ['PATCH', { choice: 1 }], ['DELETE', null]]) {
    const r = await fetch(`${url}/rest/v1/votes${m === 'POST' ? '' : '?day=eq.' + today}`, { method: m, headers: { ...h(token), Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    check(denied(r) || (m !== 'POST' && text === '[]'), `${who} cannot ${m} votes`, `${r.status} ${text.slice(0, 120)}`);
  }
  const helper = await fetch(`${url}/rest/v1/rpc/cfg`, { method: 'POST', headers: h(token), body: JSON.stringify({ k: 'min_world' }) });
  check(helper.status >= 400, `${who} cannot call private helpers`, String(helper.status));
}

// Personal functions need a session.
for (const [fn, args] of [['cast_vote', { d: today, c: 0, n: 2 }], ['my_profile', {}], ['friend_match', { codes: ['AAAAAA'] }], ['import_votes', { items: [] }], ['suggest_question', { q: 'Is this a test?', answers: ['Yes', 'No'] }]]) {
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h(), body: JSON.stringify(args) });
  check(denied(r) || r.status === 400, `anon cannot call ${fn}`, `${r.status} ${(await r.text()).slice(0, 120)}`);
}

// No peeking: someone who hasn't voted today sees no counts, signed in or not.
for (const [who, token] of [['anon', null], ['fresh user', await signIn()]]) {
  const r = await fetch(`${url}/rest/v1/rpc/get_results`, { method: 'POST', headers: h(token), body: JSON.stringify({ d: today, n: 2, cc: 'US' }) });
  const b = await r.json();
  check(r.ok && b.visible === false && b.world.counts === null, `${who} cannot peek at today's results`, JSON.stringify(b).slice(0, 160));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed: the public key can only do what setup.sql allows.');
process.exit(failed ? 1 : 0);
