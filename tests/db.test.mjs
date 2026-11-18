// Attacks setup.sql the way a browser would, on a real local Postgres.
// Every request runs exactly like PostgREST runs it: SET ROLE anon|authenticated plus the JWT claims.
//
//   cd tests && npm install && node db.test.mjs
//   (needs Postgres 14+; set DATABASE_URL, default postgres://postgres:postgres@localhost:5432/postgres)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ADMIN_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const DB = 'verd_test';
const here = p => new URL(p, import.meta.url);
let pool, today, yesterday, older;

const day = (base, delta) => { const d = new Date(base + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };

// Run one statement as a browser role. uid = the signed-in user's id (anonymous users count).
async function as(role, uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const admin = (sql, params) => pool.query(sql, params);
async function user() { const id = randomUUID(); await admin('insert into auth.users (id) values ($1)', [id]); return id; }
const denied = async (promise, why) => {
  await assert.rejects(promise, e => { assert.equal(e.code, '42501', `${why}: expected permission denied, got ${e.code} ${e.message}`); return true; }, why);
};
const vote = (uid, d, c, n = 2, cc = 'US', st = null, ci = null) =>
  as('authenticated', uid, 'select public.cast_vote($1::date, $2::smallint, $3::smallint, $4, $5, $6) as r', [d, c, n, cc, st, ci]).then(r => r.rows[0].r);
const results = (role, uid, d, n = 2, cc = 'US', st = null, ci = null) =>
  as(role, uid, 'select public.get_results($1::date, $2::smallint, $3, $4, $5) as r', [d, n, cc, st, ci]).then(r => r.rows[0].r);
// Add votes from fresh users straight into the table (admin), for setting up past days and crowds.
async function crowd(d, k, choice, cc = 'US', st = null, ci = null) {
  for (let i = 0; i < k; i++) {
    const id = await user();
    await admin('insert into public.votes (day, user_id, choice, country, state, city) values ($1, $2, $3, $4, $5, $6)', [d, id, choice, cc, st, ci]);
  }
}

before(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`);
  await root.query(`create database ${DB}`);
  await root.end();
  const url = new URL(ADMIN_URL); url.pathname = '/' + DB;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await admin(readFileSync(here('./supabase-stub.sql'), 'utf8'));
  const setup = readFileSync(here('../setup.sql'), 'utf8');
  await admin(setup);
  await admin(setup);   // running it twice must be safe
  today = (await admin(`select verd_private.today()::text as d`)).rows[0].d;
  yesterday = day(today, -1); older = day(today, -2);
});
after(async () => { await pool?.end(); });

test('browser roles cannot read any table', async () => {
  const u = await user();
  for (const t of ['votes', 'profiles', 'suggestions', 'app_config', 'blocked_terms']) {
    await denied(as('anon', null, `select * from public.${t}`), `anon reads ${t}`);
    await denied(as('authenticated', u, `select * from public.${t}`), `authenticated reads ${t}`);
  }
});

test('browser roles cannot write any table directly', async () => {
  const u = await user();
  await denied(as('authenticated', u, `insert into public.votes (day, user_id, choice) values ($1, $2, 0)`, [today, u]), 'insert vote');
  await denied(as('anon', null, `insert into public.votes (day, user_id, choice) values ($1, $2, 0)`, [today, u]), 'anon insert vote');
  await denied(as('authenticated', u, `update public.votes set choice = 1`), 'update votes');
  await denied(as('authenticated', u, `delete from public.votes`), 'delete votes');
  await denied(as('authenticated', u, `insert into public.suggestions (user_id, question, answers) values ($1, 'Is this ok?', '{a,b}')`, [u]), 'insert suggestion');
  await denied(as('authenticated', u, `update public.app_config set value = 0`), 'change config');
  await denied(as('authenticated', u, `insert into public.profiles (id, code) values ($1, 'AAAAAA')`, [u]), 'insert profile');
});

test('RLS is on for every table, even if a grant slips in later', async () => {
  const r = await admin(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`);
  for (const row of r.rows) assert.equal(row.relrowsecurity, true, `RLS off on ${row.relname}`);
  // Simulate a careless future grant: RLS with no policies must still return nothing.
  await admin('grant select on public.votes to authenticated');
  const u = await user(); await crowd(yesterday, 3, 0);
  const rows = (await as('authenticated', u, 'select * from public.votes')).rows;
  assert.equal(rows.length, 0, 'raw votes leaked through a grant');
  await admin('revoke select on public.votes from authenticated');
});

test('private helpers are unreachable', async () => {
  const u = await user();
  await denied(as('authenticated', u, `select verd_private.cfg('min_world')`), 'call helper');
  await denied(as('anon', null, `select verd_private.ensure_profile($1)`, [u]), 'make profile for someone');
});

test('anon cannot vote or call personal functions', async () => {
  await denied(as('anon', null, `select public.cast_vote($1::date, 0::smallint, 2::smallint)`, [today]), 'anon vote');
  await denied(as('anon', null, `select public.my_profile()`), 'anon profile');
  await denied(as('anon', null, `select public.friend_match('{AAAAAA}')`), 'anon friend match');
  await denied(as('anon', null, `select public.import_votes('[]'::jsonb)`), 'anon import');
  await denied(as('anon', null, `select public.suggest_question('Is this a question?', '{Yes,No}')`), 'anon suggest');
});

test('one vote per person per question, enforced by the database', async () => {
  const u = await user();
  const first = await vote(u, today, 0);
  assert.equal(first.mine, 0);
  const n1 = first.world.n;
  const second = await vote(u, today, 1);
  assert.equal(second.mine, 0, 'second vote changed the answer');
  assert.equal(second.world.n, n1, 'second vote was counted');
  // Even the table owner cannot insert a duplicate: it's the primary key.
  await assert.rejects(admin('insert into public.votes (day, user_id, choice) values ($1, $2, 1)', [today, u]), e => e.code === '23505');
});

test('votes only for open questions and valid answers', async () => {
  const u = await user();
  const bad = async (args, why) => assert.rejects(vote(u, ...args), e => { assert.equal(e.code, '22023', why); return true; }, why);
  await bad([older, 0], 'two days ago');
  await bad([day(today, 1), 0], 'tomorrow');
  await bad([today, 2, 2], 'answer index out of range');
  await bad([today, -1, 2], 'negative answer');
  await bad([today, 0, 5], 'too many answers');
  const late = await vote(u, yesterday, 1);   // offline vote synced after midnight
  assert.equal(late.mine, 1);
});

test('today stays hidden until you vote, then shows only above the minimum', async () => {
  const d = today, n = 3;   // a 3-answer question, its own counts
  // 12 people vote 0 on the 3-answer question (world minimum is 10)
  for (let i = 0; i < 12; i++) await vote(await user(), d, 0, n, 'GB');
  const watcher = await user();
  const before = await results('authenticated', watcher, d, n, 'GB');
  assert.equal(before.visible, false);
  assert.equal(before.world.counts, null, 'counts visible before voting');
  assert.ok(before.world.n >= 12, 'n is shown so the app can say how many voted');
  const anon = await results('anon', null, d, n, 'GB');
  assert.equal(anon.world.counts, null, 'anon sees today counts');
  const afterVote = await vote(watcher, d, 1, n, 'GB');
  assert.equal(afterVote.visible, true);
  assert.deepEqual(afterVote.world.counts.length, 3);
  assert.equal(afterVote.world.counts[1] >= 1, true);
  assert.equal(afterVote.country.counts, null, 'country split shown below 30');
});

test('splits roll in only at the minimum: world 10, country/state/city 30', async () => {
  const d = older;   // past day: visible to everyone, so only the minimums matter
  await crowd(d, 9, 0, 'FR', 'ile-de-france', 'paris');
  let r = await results('anon', null, d, 2, 'FR', 'Île-de-France', 'Paris');
  assert.equal(r.world.counts, null, 'world shown at 9');
  await crowd(d, 1, 1, 'FR', 'ile-de-france', 'paris');
  r = await results('anon', null, d, 2, 'FR', 'Ile-de-France', 'Paris');
  assert.deepEqual(r.world.counts, [9, 1], 'world at 10');
  assert.equal(r.country.counts, null, 'country at 10');
  await crowd(d, 20, 1, 'FR', 'ile-de-france', 'paris');
  r = await results('anon', null, d, 2, 'FR', 'ile-de-france', 'paris');
  assert.deepEqual(r.country.counts, [9, 21], 'country at 30');
  r = await results('anon', null, d, 2, 'FR', 'Île-de-France', 'Paris');
  assert.deepEqual(r.state, { n: 0, counts: null }, 'a differently spelled state is a different place');
  r = await results('anon', null, d, 2, 'FR', '  ILE-DE-FRANCE ', ' PARIS ');
  assert.deepEqual(r.state.counts, [9, 21], 'state key is normalised');
  assert.deepEqual(r.city.counts, [9, 21]);
  r = await results('anon', null, d, 2, 'FR', null, 'paris');
  assert.equal(r.city, null, 'city without a state is never looked up');
});

test('results never include who voted', async () => {
  const r = await results('anon', null, older, 2, 'FR');
  const text = JSON.stringify(r);
  assert.ok(!/user|uid|[0-9a-f]{8}-[0-9a-f]{4}/i.test(text), 'results leak an id: ' + text);
});

test('friend match: past days only, needs 3 shared answers, never raw answers', async () => {
  const a = await user(), b = await user();
  const codeA = (await as('authenticated', a, 'select public.my_profile() as p')).rows[0].p.code;
  const codeB = (await as('authenticated', b, 'select public.my_profile() as p')).rows[0].p.code;
  assert.match(codeA, /^[A-Z2-9]{6}$/);
  const put = (u, d, c) => admin('insert into public.votes (day, user_id, choice) values ($1, $2, $3)', [d, u, c]);
  await put(a, day(today, -3), 0); await put(b, day(today, -3), 0);
  await put(a, day(today, -4), 1); await put(b, day(today, -4), 0);
  let m = (await as('authenticated', a, 'select * from public.friend_match($1)', [[codeB]])).rows;
  assert.deepEqual(m, [{ code: codeB, shared: 2, agree: null }], 'match shown with 2 shared answers');
  await put(a, day(today, -5), 1); await put(b, day(today, -5), 1);
  await vote(a, today, 1); await vote(b, today, 1);   // today must not count
  m = (await as('authenticated', a, 'select * from public.friend_match($1)', [[codeB, codeA, 'ZZZZZZ']])).rows;
  assert.deepEqual(m, [{ code: codeB, shared: 3, agree: 2 }], 'today counted, own code included or unknown code returned');
});

test('import of old local votes: once, launch to today, at most 60', async () => {
  const u = await user();
  // yesterday is in range (launch was 2026-11-17); 2026-11-01 is before launch; +3 days is the future
  const items = [{ d: yesterday, c: 1, cc: 'us' }, { d: '2026-11-01', c: 0 }, { d: day(today, 3), c: 0 }, { d: yesterday, c: 0 }, { x: 'junk' }, { d: today, c: 9 }];
  const k = (await as('authenticated', u, 'select public.import_votes($1::jsonb) as k', [JSON.stringify(items)])).rows[0].k;
  assert.equal(k, 1, 'only the valid, in-range, first answer is imported');
  const again = (await as('authenticated', u, 'select public.import_votes($1::jsonb) as k', [JSON.stringify([{ d: yesterday, c: 0 }])])).rows[0].k;
  assert.equal(again, 0, 'import ran twice');
  const many = await user();
  const lots = Array.from({ length: 90 }, () => ({ d: yesterday, c: 0 }));
  assert.equal((await as('authenticated', many, 'select public.import_votes($1::jsonb) as k', [JSON.stringify(lots)])).rows[0].k, 1);
});

test('board: only places above the minimum, today only after voting', async () => {
  const d = older;
  let board = (await as('anon', null, 'select public.get_board($1::date, 2::smallint) as b', [d])).rows[0].b;
  assert.deepEqual(board.map(x => x.place), ['FR'], 'only France has 30 on that day');
  assert.equal(board[0].n, 30);
  const u = await user();
  board = (await as('authenticated', u, 'select public.get_board($1::date, 3::smallint) as b', [today])).rows[0].b;
  assert.deepEqual(board, [], 'today board before voting');
  const cities = (await as('anon', null, 'select public.get_board($1::date, 2::smallint, $2, $3) as b', [d, 'FR', 'Ile-de-France'])).rows[0].b;
  assert.deepEqual(cities.map(x => x.place), ['paris']);
});

test('suggestions: signed in, blocklist, 3 a day, held for review', async () => {
  const u = await user();
  const s = (q, a = ['Yes', 'No']) => as('authenticated', u, 'select public.suggest_question($1, $2) as s', [q, a]);
  await assert.rejects(s('Check out www.example.com now?'), /friendly/);
  await assert.rejects(s('Text me at 555 123 4567?'), /friendly/);
  await assert.rejects(s('Follow @someone?'), /friendly/);
  await assert.rejects(s('Hi', ['A', 'B']), /5 to 140/);
  await assert.rejects(s('Only one answer here?', ['Yes']), /2 to 4/);
  for (const q of ['Pizza or tacos?', 'Is math useful?', 'Beach or snow?']) assert.equal((await s(q)).rows[0].s, 'pending');
  await assert.rejects(s('One more idea?'), /enough/);
  const st = (await admin('select distinct status from public.suggestions')).rows.map(r => r.status);
  assert.deepEqual(st, ['pending']);
});
