// A stand-in for Supabase's HTTP API (anonymous auth, Google sign-in with PKCE, PostgREST RPC, table
// requests), backed by a real local Postgres loaded with setup.sql. e2e-live.mjs drives the real app.js against it.
// Each request runs the way PostgREST runs it: SET ROLE plus request.jwt.claims, one transaction.
// Google itself is a page on this server (/fake-google) where a test types an email address.
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const TABLE_SQL = {
  GET: t => `select * from public.${t}`,
  POST: t => `insert into public.${t} default values returning *`,
  PATCH: t => `update public.${t} set created_at = now() returning *`,
  DELETE: t => `delete from public.${t} returning *`
};

export async function startFakeSupabase({ databaseUrl, port = 54321, anonKey = 'sb_publishable_test-key' }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tokens = new Map(), refresh = new Map(), calls = [];
  const flows = new Map(), codes = new Map();   // Google sign-ins under way, and one-time codes waiting for their verifier
  let offline = false, google = true, manualLinking = true;
  const issue = (uid, anonymous = true) => {
    const at = 'at-' + randomUUID(), rt = 'rt-' + randomUUID();
    tokens.set(at, uid); refresh.set(rt, uid);
    return { access_token: at, refresh_token: rt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, is_anonymous: anonymous } };
  };
  const s256 = v => createHash('sha256').update(v).digest('base64url');
  // Like GoTrue: a sign-in starts with the PKCE challenge and where to come back to.
  function startFlow(q, linkUid) {
    const id = randomUUID();
    flows.set(id, { redirectTo: q.get('redirect_to'), challenge: q.get('code_challenge'), linkUid });
    return `http://localhost:${port}/fake-google?flow=${id}`;
  }
  // Google said yes for this email. Linking adds Google to the signed-in account (no longer anonymous), unless
  // another account already has that Google identity. A plain sign-in finds or makes the account.
  async function finishFlow(id, email) {
    const f = flows.get(id); flows.delete(id);
    if (!f) return { status: 400, body: { message: 'unknown flow' } };
    const back = new URL(f.redirectTo);
    let owner = (await pool.query('select id from auth.users where email = $1', [email])).rows[0]?.id || null;
    if (f.linkUid) {
      if (owner && owner !== f.linkUid) {
        const e = { error: 'server_error', error_code: 'identity_already_exists', error_description: 'Identity is already linked to another user' };
        for (const [k, v] of Object.entries(e)) back.searchParams.set(k, v);
        back.hash = new URLSearchParams(e).toString();
        return { status: 302, location: back.toString() };
      }
      await pool.query('update auth.users set is_anonymous = false, email = $2 where id = $1', [f.linkUid, email]);
      owner = f.linkUid;
    } else if (!owner) {
      owner = (await pool.query('insert into auth.users (id, is_anonymous, email) values (gen_random_uuid(), false, $1) returning id', [email])).rows[0].id;
    }
    const code = randomUUID(); codes.set(code, { uid: owner, challenge: f.challenge });
    back.searchParams.set('code', code);
    return { status: 302, location: back.toString() };
  }
  const GOOGLE_PAGE = id => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stand-in Google sign-in</title>
<form action="/fake-google/continue" method="get"><input type="hidden" name="flow" value="${id}">
<label>Email <input id="email" name="email" type="email" required></label> <button id="go">Continue</button></form>`;
  async function asRole(auth, fn) {
    const bearer = (auth || '').replace(/^Bearer /, '');
    const uid = tokens.get(bearer) || null;
    // Like Supabase: no Authorization header is the anon role. A publishable key isn't a JWT, so sent as one it's refused.
    if (!uid && auth && (bearer !== anonKey || anonKey.startsWith('sb_publishable_'))) return { status: 401, body: { message: 'Invalid JWT' } };
    const role = uid ? 'authenticated' : 'anon';
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
      const body = await fn(c);
      await c.query('commit');
      return { status: 200, body };
    } catch (e) {
      await c.query('rollback').catch(() => {});
      const status = e.code === '42501' ? (uid ? 403 : 401) : (e.code === '42883' || e.code === '42P01') ? 404 : 400;
      return { status, body: { code: e.code, message: e.message } };
    } finally { c.release(); }
  }
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (offline) { req.socket.destroy(); return; }
    let raw = ''; for await (const ch of req) raw += ch;
    const args = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://x');
    calls.push(req.method + ' ' + url.pathname);
    let out = { status: 404, body: { message: 'not found' } };
    // The browser goes to these itself, so like Supabase they need no key.
    if (req.method === 'GET' && url.pathname === '/auth/v1/authorize') {
      out = !google ? { status: 400, body: { error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' } }
        : { status: 302, location: startFlow(url.searchParams, null) };
    } else if (req.method === 'GET' && url.pathname === '/fake-google') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(GOOGLE_PAGE(url.searchParams.get('flow')));
    } else if (req.method === 'GET' && url.pathname === '/fake-google/continue') {
      out = await finishFlow(url.searchParams.get('flow'), (url.searchParams.get('email') || '').trim().toLowerCase());
    } else if (req.headers.apikey !== anonKey) out = { status: 401, body: { message: 'No API key found in request' } };
    else if (url.pathname === '/auth/v1/settings') {
      out = { status: 200, body: { external: { google, email: true, anonymous_users: true }, disable_signup: false } };
    } else if (url.pathname === '/auth/v1/user/identities/authorize') {
      const uid = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      out = !uid ? { status: 401, body: { message: 'invalid JWT' } }
        : !manualLinking ? { status: 404, body: { code: 404, error_code: 'manual_linking_disabled', msg: 'Manual linking is disabled' } }
        : !google ? { status: 400, body: { error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' } }
        : { status: 200, body: { url: startFlow(url.searchParams, uid) } };
    } else if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      const c = codes.get(args.auth_code); codes.delete(args.auth_code);
      out = c && args.code_verifier && s256(args.code_verifier) === c.challenge ? { status: 200, body: issue(c.uid, false) }
        : { status: 404, body: { error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' } };
    }
    else if (url.pathname === '/auth/v1/signup') {
      const uid = randomUUID();
      await pool.query('insert into auth.users (id) values ($1)', [uid]);
      out = { status: 200, body: issue(uid) };
    } else if (url.pathname === '/auth/v1/token') {
      const uid = refresh.get(args.refresh_token);
      out = uid ? { status: 200, body: issue(uid) } : { status: 400, body: { message: 'Invalid Refresh Token' } };
    } else if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length).replace(/[^a-z_]/g, '');
      // like PostgREST: arrays of plain values become SQL arrays, anything with objects goes in as JSON
      const keys = Object.keys(args), vals = keys.map(k => Array.isArray(args[k]) && args[k].some(x => x && typeof x === 'object') ? JSON.stringify(args[k]) : args[k]);
      const named = keys.map((k, i) => `${k.replace(/[^a-z_]/g, '')} := $${i + 1}`).join(', ');
      out = await asRole(req.headers.authorization, async c => {
        const fn = (await c.query(`select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name])).rows[0];
        if (!fn) { const e = new Error('function not found'); e.code = '42883'; throw e; }
        if (fn.proretset) return (await c.query(`select * from public.${name}(${named})`, vals)).rows;
        return (await c.query(`select public.${name}(${named}) as r`, vals)).rows[0].r;
      });
    } else if (url.pathname.startsWith('/rest/v1/') && TABLE_SQL[req.method]) {
      const table = url.pathname.slice('/rest/v1/'.length).replace(/[^a-z_]/g, '');
      out = await asRole(req.headers.authorization, async c => (await c.query(TABLE_SQL[req.method](table))).rows);
    }
    if (out.location) { res.writeHead(out.status, { ...cors, Location: out.location }); return res.end(); }
    res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise(r => server.listen(port, r));
  return {
    url: `http://localhost:${port}`, anonKey, calls, pool,
    userOf: token => tokens.get(token) || null,
    setOffline(v) { offline = v; },
    setGoogle(v) { google = v; },
    setManualLinking(v) { manualLinking = v; },
    close: async () => { server.close(); await pool.end(); }
  };
}
