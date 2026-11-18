// A stand-in for Supabase's HTTP API (anonymous auth, PostgREST RPC, table requests), backed by a
// real local Postgres loaded with setup.sql. e2e-live.mjs drives the real app.js against it.
// Each request runs the way PostgREST runs it: SET ROLE plus request.jwt.claims, one transaction.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const TABLE_SQL = {
  GET: t => `select * from public.${t}`,
  POST: t => `insert into public.${t} default values returning *`,
  PATCH: t => `update public.${t} set created_at = now() returning *`,
  DELETE: t => `delete from public.${t} returning *`
};

export async function startFakeSupabase({ databaseUrl, port = 54321, anonKey = 'anon-test-key' }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const tokens = new Map(), refresh = new Map(), calls = [];
  let offline = false;
  const issue = uid => {
    const at = 'at-' + randomUUID(), rt = 'rt-' + randomUUID();
    tokens.set(at, uid); refresh.set(rt, uid);
    return { access_token: at, refresh_token: rt, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, is_anonymous: true } };
  };
  async function asRole(auth, fn) {
    const bearer = (auth || '').replace(/^Bearer /, '');
    const uid = tokens.get(bearer) || null;
    if (!uid && bearer !== anonKey) return { status: 401, body: { message: 'JWT invalid' } };
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
    if (req.headers.apikey !== anonKey) out = { status: 401, body: { message: 'No API key found in request' } };
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
    res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise(r => server.listen(port, r));
  return {
    url: `http://localhost:${port}`, anonKey, calls, pool,
    setOffline(v) { offline = v; },
    close: async () => { server.close(); await pool.end(); }
  };
}
