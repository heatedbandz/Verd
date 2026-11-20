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
  for (const t of ['votes', 'profiles', 'suggestions', 'app_config', 'blocked_terms', 'friend_adds']) {
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

test('friend match: only between two people who added each other, past days only, 3 shared answers, never raw answers', async () => {
  const a = await user(), b = await user();
  const codeA = (await as('authenticated', a, 'select public.my_profile() as p')).rows[0].p.code;
  const codeB = (await as('authenticated', b, 'select public.my_profile() as p')).rows[0].p.code;
  assert.match(codeA, /^[A-Z2-9]{6}$/);
  const put = (u, d, c) => admin('insert into public.votes (day, user_id, choice) values ($1, $2, $3)', [d, u, c]);
  const setFriends = async (u, codes) => (await as('authenticated', u, 'select public.set_friends($1) as k', [codes])).rows[0].k;
  const match = async (u, codes) => (await as('authenticated', u, 'select * from public.friend_match($1)', [codes])).rows;
  assert.equal(await setFriends(a, [codeB]), 1);
  assert.deepEqual(await match(a, [codeB]), [], 'knowing a code is not enough: they have to add you too');
  // their own code, a lowercase duplicate and junk are skipped
  assert.equal(await setFriends(b, [codeA.toLowerCase(), codeA, 'bad!!', codeB]), 1);
  assert.deepEqual(await match(a, [codeB]), [{ code: codeB, shared: 0, agree: null }], 'friends both ways, nothing in common yet');
  await put(a, day(today, -3), 0); await put(b, day(today, -3), 0);
  await put(a, day(today, -4), 1); await put(b, day(today, -4), 0);
  await put(b, day(today, -6), 1);   // only they answered: not shared
  assert.deepEqual(await match(a, [codeB]), [{ code: codeB, shared: 2, agree: null }], 'no agreement shown with 2 shared answers');
  await put(a, day(today, -5), 1); await put(b, day(today, -5), 1);
  await vote(a, today, 1); await vote(b, today, 1);   // today must not count
  assert.deepEqual(await match(a, [codeB, codeA, 'ZZZZZZ']), [{ code: codeB, shared: 3, agree: 2 }], 'today, your own code and unknown codes left out');
  assert.deepEqual(await match(b, [codeA]), [{ code: codeA, shared: 3, agree: 2 }], 'the same both ways');
  // Removing someone ends it for both of you.
  assert.equal(await setFriends(b, []), 0);
  assert.deepEqual(await match(a, [codeB]), []);
  assert.deepEqual(await match(b, [codeA]), []);
});

test('friend lists: signed in only, at most 50, and never readable', async () => {
  const u = await user(), L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const codes = Array.from({ length: 70 }, (_, i) => 'FRND' + L[Math.floor(i / 24)] + L[i % 24]);
  assert.equal((await as('authenticated', u, 'select public.set_friends($1) as k', [codes])).rows[0].k, 50);
  assert.equal((await admin('select count(*)::int as n from public.friend_adds where user_id = $1', [u])).rows[0].n, 50);
  await denied(as('anon', null, `select public.set_friends('{AAAAAA}')`), 'anon sets a friend list');
  await denied(as('authenticated', u, 'select * from public.friend_adds'), 'reads friend lists');
  await denied(as('authenticated', u, `insert into public.friend_adds (user_id, code) values ($1, 'AAAAAA')`, [u]), 'writes a friend list directly');
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

// ---------- Posting ----------
// Writing needs a real account (not anonymous), an age kept here, 13 or older, no block, and a moderator to
// exist. Everything waits for review. Rate limits, blocked words, reports and blocks are all checked here.
async function realUser(born = [2000, 1]) {
  const id = randomUUID();
  await admin('insert into auth.users (id, is_anonymous) values ($1, false)', [id]);
  if (born) await as('authenticated', id, 'select public.set_birth($1, $2)', born);
  return id;
}
const call = (uid, sql, params = []) => as(uid ? 'authenticated' : 'anon', uid, sql, params).then(r => r.rows[0].r);
const feed = (uid, cc = 'US', st = null, ci = null) => call(uid, 'select public.get_posts($1, $2, $3) as r', [cc, st, ci]);
const ids = f => f.posts.map(p => p.id);
const post = (uid, body, scope = 'world', cc = 'US', st = null, ci = null) =>
  call(uid, 'select public.create_post($1, 3::smallint, $2, $3, $4, $5) as r', [body, scope, cc, st, ci]);
const judge = (uid, pid, yes, cc = 'US', st = null, ci = null) => call(uid, 'select public.judge_post($1, $2, $3, $4, $5) as r', [pid, yes, cc, st, ci]);
const comment = (uid, pid, body) => call(uid, 'select public.create_comment($1, $2, $3) as r', [pid, body, 'US']);
const reportIt = (uid, what, id) => call(uid, 'select public.report_item($1, $2, $3) as r', [what, id, 'US']);
const review = (uid, what, id, decision, why = null) => call(uid, 'select public.review_item($1, $2, $3, $4) as r', [what, id, decision, why]);
const queue = uid => call(uid, 'select public.review_queue() as r');
let mod = null;
const approved = async (writer, body, scope, cc, st, ci) => { const p = await post(writer, body, scope, cc, st, ci); await review(mod, 'post', p.id, 'approve'); return p.id; };

test('posting tables are locked like the rest, and their functions are closed to anon', async () => {
  const u = await realUser();
  for (const t of ['posts', 'post_votes', 'comments', 'reports', 'moderators', 'bans']) {
    await denied(as('anon', null, `select * from public.${t}`), `anon reads ${t}`);
    await denied(as('authenticated', u, `select * from public.${t}`), `authenticated reads ${t}`);
  }
  await denied(as('authenticated', u, `insert into public.posts (user_id, body, scope, status) values ($1, 'Is this approved?', 'world', 'approved')`, [u]), 'insert an approved post');
  await denied(as('authenticated', u, `insert into public.moderators (user_id) values ($1)`, [u]), 'make yourself a moderator');
  await denied(as('authenticated', u, `delete from public.bans`), 'lift a block');
  await denied(as('authenticated', u, `update public.posts set status = 'approved'`), 'approve posts');
  for (const sql of [`select public.create_post('Is this allowed?', 0::smallint, 'world')`, `select public.judge_post(1, true)`,
    `select public.create_comment(1, 'hi there')`, `select public.report_item('post', 1)`, `select public.set_birth(2000, 1)`,
    `select public.review_queue()`, `select public.review_item('post', 1, 'approve')`, `select public.ban_author('post', 1)`, `select public.delete_mine('post', 1)`])
    await denied(as('anon', null, sql), 'anon: ' + sql);
  const f = await feed(null);
  assert.deepEqual(f.posts, [], 'anon can read the feed, which is empty');
});

test('posting stays closed until a moderator exists, and pausing closes it again', async () => {
  const u = await realUser();
  assert.equal((await feed(u)).open, false);
  await assert.rejects(post(u, 'Is pineapple on pizza good?'), /posting is closed/);
  mod = await realUser();
  await admin('insert into public.moderators (user_id) values ($1)', [mod]);
  assert.equal((await feed(u)).open, true);
  await admin(`update public.app_config set value = 1 where key = 'posting_paused'`);
  assert.equal((await feed(u)).open, false);
  await assert.rejects(post(u, 'Is pineapple on pizza good?'), /posting is closed/);
  await admin(`update public.app_config set value = 0 where key = 'posting_paused'`);
  assert.equal((await post(u, 'Is pineapple on pizza good?')).status, 'pending');
});

test('only a real account, 13 or older, with the age kept here and no block, can write', async () => {
  const anon = await user();   // an anonymous session, like everyone who has only voted
  await assert.rejects(post(anon, 'Should school start later?'), /sign in to post/);
  const noAge = await realUser(null);
  await assert.rejects(post(noAge, 'Should school start later?'), /age needed/);
  const year = new Date().getUTCFullYear(), month = new Date().getUTCMonth() + 1;
  const kid = await realUser([year - 12, 1]);
  assert.equal((await call(kid, 'select public.my_profile() as r')).age_ok, false);
  await assert.rejects(post(kid, 'Should school start later?'), /13 and older/);
  // The age is given once: answering again can't change it.
  assert.equal((await call(kid, 'select public.set_birth(1990, 1) as r')).age_ok, false);
  await assert.rejects(post(kid, 'Should school start later?'), /13 and older/);
  // Exactly 13 years to the month isn't enough (the month's day isn't known); a month later is.
  const thirteen = await realUser([year - 13, month]);
  await assert.rejects(post(thirteen, 'Should school start later?'), /13 and older/);
  const teen = await realUser(month === 1 ? [year - 14, 12] : [year - 13, month - 1]);
  assert.equal((await post(teen, 'Should school start later?')).status, 'pending');
  await assert.rejects(call(teen, 'select public.set_birth($1, $2) as r', [year + 1, 1]), /bad date/);
  const me = await call(teen, 'select public.my_profile() as r');
  assert.deepEqual([me.real, me.age_given, me.age_ok, me.moderator, me.blocked, me.open], [true, true, true, false, false, true]);
});

test('every post waits for review: others see it only once approved, the writer sees where it stands', async () => {
  const w = await realUser(), other = await realUser();
  const p = await post(w, '  Is   cereal a soup?  ');
  let mine = (await feed(w)).posts.find(x => x.id === p.id);
  assert.deepEqual([mine.body, mine.status, mine.mine], ['Is cereal a soup?', 'pending', true]);
  assert.ok(!ids(await feed(other)).includes(p.id), 'a pending post is invisible to others');
  assert.ok(!ids(await feed(null)).includes(p.id), 'and to anon');
  const q = await queue(mod);
  const waiting = q.waiting.find(x => x.kind === 'post' && x.id === p.id);
  assert.equal(waiting.body, 'Is cereal a soup?');
  assert.deepEqual(waiting.writer, { approved: 0, turned_down: 0 }, 'moderators see a track record, never who it is');
  assert.ok(!JSON.stringify(q).includes(w), 'no account ids in the queue');
  await review(mod, 'post', p.id, 'approve');
  assert.ok(ids(await feed(other)).includes(p.id));
  await assert.rejects(review(mod, 'post', p.id, 'approve'), /already decided/);
  const p2 = await post(other, 'Should homework be banned?');
  await review(mod, 'post', p2.id, 'reject', 'Not a yes or no question');
  mine = (await feed(other)).posts.find(x => x.id === p2.id);
  assert.deepEqual([mine.status, mine.reason], ['rejected', 'Not a yes or no question']);
  assert.ok(!ids(await feed(w)).includes(p2.id));
});

test('only moderators can review or block', async () => {
  const u = await realUser(), w = await realUser();
  const p = await post(w, 'Are cats better than dogs?');
  await denied(queue(u), 'see the queue');
  await denied(review(u, 'post', p.id, 'approve'), 'approve');
  await denied(call(u, `select public.ban_author('post', $1) as r`, [p.id]), 'block a writer');
  await denied(review(w, 'post', p.id, 'approve'), 'approve your own');
});

test('a post can have its own two answers; both or neither, different, short, and no blocked words', async () => {
  const opt = (u, body, a, b) => call(u, "select public.create_post($1, 3::smallint, 'world', 'US', null, null, $2, $3) as r", [body, a, b]);
  await assert.rejects(opt(await realUser(), 'Lamborghini or Ferrari?', 'Lamborghini', null), /two different answers/);
  await assert.rejects(opt(await realUser(), 'Lamborghini or Ferrari?', 'Ferrari', ' ferrari '), /two different answers/);
  await assert.rejects(opt(await realUser(), 'Lamborghini or Ferrari?', 'x'.repeat(31), 'Ferrari'), /1 to 30/);
  await assert.rejects(opt(await realUser(), 'Who is worse?', 'Them', 'that f@ggot'), /blocked words/);
  const u = await realUser(), r = await opt(u, 'Lamborghini or Ferrari?', '  Lamborghini ', 'Ferrari');
  const mine = (await feed(u)).posts.find(p => p.id === r.id);
  assert.deepEqual([mine.a, mine.b], ['Lamborghini', 'Ferrari']);
  const plain = await realUser(), q = await post(plain, 'Is cereal a soup?');
  const p2 = (await feed(plain)).posts.find(p => p.id === q.id);
  assert.deepEqual([p2.a, p2.b], [null, null], 'no answers given: Yes and No');
});

test('blocked words and rate limits are enforced by the database', async () => {
  const u = await realUser();
  for (const bad of ['Text me at 555 123 4567?', 'Add me on snap?', 'Is www.example.com good?', 'Should I send pics?', 'How old are you?', 'Follow @someone?'])
    await assert.rejects(post(u, bad), /blocked words/, bad);
  await assert.rejects(post(u, 'Hi?'), /4 to 200/);
  await assert.rejects(post(u, 'x'.repeat(201)), /4 to 200/);
  await assert.rejects(post(u, 'Is my city the best?', 'city', 'US', 'Texas', null), /set your place/);
  await assert.rejects(post(u, 'Is this a real audience?', 'galaxy'), /bad audience/);
  assert.equal((await post(u, 'Should I text my crush?')).status, 'pending', 'normal questions about texting are fine');
  await assert.rejects(post(u, 'Is a second post too fast?'), /wait a moment/);
  // Two more, as if made earlier today, then the fourth of the day is refused.
  await admin(`update public.posts set created_at = now() - interval '3 hours' where user_id = $1`, [u]);
  await admin(`insert into public.posts (user_id, body, scope, created_at) values ($1, 'Earlier post one?', 'world', now() - interval '2 hours'), ($1, 'Earlier post two?', 'world', now() - interval '1 hour')`, [u]);
  await assert.rejects(post(u, 'Is a fourth post too many?'), /enough posts for today/);
});

test('slurs are refused, look-alike spellings too, and normal words that contain them still work', async () => {
  const has = async t => (await admin('select verd_private.blocked($1) as b', [t])).rows[0].b;
  for (const bad of ['you f@ggot', 'N1GGA please', 'such a retard', 'what a tranny', 'go back wetback', 'K!KE'])
    assert.equal(await has(bad), true, bad);
  for (const ok of ['Is a raccoon a good pet?', 'Do you like spicy food?', 'Is Chinese food the best?', 'Is a fig a fruit?', 'Is Nigeria in Africa?', 'Who won the Niger match?', 'Is a cocoon cozy?'])
    assert.equal(await has(ok), false, ok);
});

test('judging: once, never your own, only posts you can see, and the split stays hidden until you judge', async () => {
  const w = await realUser(), a = await user(), b = await user(), c = await user();
  const pid = await approved(w, 'Is a hot dog a sandwich?');
  const pending = await post(await realUser(), 'Is water wet?');
  for (const [u, yes] of [[a, true], [b, true]]) await judge(u, pid, yes);
  let seen = (await feed(c)).posts.find(x => x.id === pid);
  assert.deepEqual([seen.total, seen.yes, seen.no, seen.my_vote], [2, null, null, null], 'before judging: only how many');
  const r = await judge(c, pid, false);
  assert.deepEqual([r.yes, r.no, r.my_vote], [2, 1, -1]);
  assert.deepEqual((await judge(c, pid, true)), r, 'a second judgment changes nothing');
  seen = (await feed(c)).posts.find(x => x.id === pid);
  assert.deepEqual([seen.total, seen.yes, seen.no, seen.my_vote], [3, 2, 1, -1]);
  const own = (await feed(w)).posts.find(x => x.id === pid);
  assert.deepEqual([own.yes, own.no], [2, 1], 'the writer sees the split');
  await assert.rejects(judge(w, pid, true), /your own/);
  await assert.rejects(judge(a, pending.id, true), /no such post/);
  await denied(as('anon', null, 'select public.judge_post($1, true)', [pid]), 'anon judges');
});

test('audiences: city posts reach that city only, friends posts reach mutual friends only', async () => {
  const w = await realUser(), near = await user(), far = await user(), friend = await user(), fan = await user();
  const city = await approved(w, 'Is our bus system good?', 'city', 'US', 'Texas', 'Austin');
  assert.ok(ids(await feed(near, 'US', ' texas ', 'AUSTIN')).includes(city), 'same place, written differently');
  assert.ok(!ids(await feed(far, 'US', 'Texas', 'Dallas')).includes(city));
  assert.ok(!ids(await feed(far, 'US')).includes(city));
  const code = async u => (await call(u, 'select public.my_profile() as r')).code;
  const [wc, fc, fanc] = [await code(w), await code(friend), await code(fan)];
  await as('authenticated', w, 'select public.set_friends($1)', [[fc]]);
  await as('authenticated', friend, 'select public.set_friends($1)', [[wc]]);
  await as('authenticated', fan, 'select public.set_friends($1)', [[wc]]);   // added the writer, but not added back
  await admin(`update public.posts set created_at = now() - interval '1 hour' where user_id = $1`, [w]);
  const fp = await approved(w, 'Should we get pizza Friday?', 'friends');
  const theirs = (await feed(friend)).posts.find(x => x.id === fp);
  assert.equal(theirs.code, wc, 'a mutual friend sees whose post it is');
  assert.ok(!ids(await feed(fan)).includes(fp), 'knowing a code is not enough');
  assert.ok(!ids(await feed(null)).includes(fp));
  assert.ok(!JSON.stringify(await feed(fan)).includes(wc), 'and nothing else shows the code');
  assert.ok(fanc);
});

test('comments: a real account aged 13+, judge first, and each one waits for review', async () => {
  const w = await realUser(), c = await realUser(), viewer = await user(), anonymous = await user();
  const pid = await approved(w, 'Is homework useful?');
  await assert.rejects(comment(c, pid, 'It helps me remember'), /judge it first/);
  await judge(c, pid, true);
  await assert.rejects(comment(c, pid, 'Call 555 123 4567'), /blocked words/);
  const cm = await comment(c, pid, 'It helps me remember');
  assert.equal(cm.status, 'pending');
  await judge(anonymous, pid, false);
  await assert.rejects(comment(anonymous, pid, 'Nope'), /sign in to post/);
  let list = (await feed(viewer)).posts.find(x => x.id === pid).comments;
  assert.deepEqual(list, [], 'waiting comments are invisible to others');
  const mine = (await feed(c)).posts.find(x => x.id === pid).comments;
  assert.deepEqual([mine[0].status, mine[0].side, mine[0].mine], ['pending', 0, true]);
  assert.ok((await queue(mod)).waiting.some(x => x.kind === 'comment' && x.id === cm.id && x.on === 'Is homework useful?'));
  await review(mod, 'comment', cm.id, 'approve');
  list = (await feed(viewer)).posts.find(x => x.id === pid).comments;
  assert.deepEqual(list.map(x => [x.body, x.side, x.mine, x.code, x.status]), [['It helps me remember', 0, false, null, null]]);
  await assert.rejects(comment(c, pid, 'And it is good practice'), /wait a moment/);
  assert.equal((await comment(w, pid, 'Thanks for answering')).status, 'pending', 'the writer can answer on their own post');
});

test('reports: hidden for the reporter at once, for everyone at 3, until a moderator keeps it', async () => {
  const w = await realUser(), r1 = await user(), r2 = await user(), r3 = await user(), viewer = await user();
  const pid = await approved(w, 'Is summer the best season?');
  await assert.rejects(reportIt(w, 'post', pid), /no such post/, 'not your own');
  assert.equal(await reportIt(r1, 'post', pid), 'reported');
  assert.ok(!ids(await feed(r1)).includes(pid), 'gone for the reporter');
  assert.ok(ids(await feed(viewer)).includes(pid), 'still there for others');
  await reportIt(r2, 'post', pid);
  await assert.rejects(reportIt(r2, 'post', pid), /no such post/, 'once you report it, it is gone for you');
  assert.ok(ids(await feed(viewer)).includes(pid), 'two reports: still there');
  await reportIt(r3, 'post', pid);
  assert.ok(!ids(await feed(viewer)).includes(pid), 'hidden for everyone at 3 reports');
  assert.ok(ids(await feed(w)).includes(pid), 'the writer still sees their post');
  const rep = (await queue(mod)).reported.find(x => x.kind === 'post' && x.id === pid);
  assert.deepEqual([rep.reports, rep.hidden], [3, true]);
  await review(mod, 'post', pid, 'keep');
  assert.ok(ids(await feed(viewer)).includes(pid), 'kept: back for everyone');
  assert.ok(!(await queue(mod)).reported.some(x => x.kind === 'post' && x.id === pid), 'and off the reported list');
  await review(mod, 'post', pid, 'remove', 'Mean about a real person');
  assert.ok(!ids(await feed(viewer)).includes(pid));
  const mine = (await feed(w)).posts.find(x => x.id === pid);
  assert.deepEqual([mine.status, mine.reason], ['removed', 'Mean about a real person']);
  const spam = await user();
  await admin(`insert into public.reports (kind, item_id, user_id) select 'post', g, $1 from generate_series(100000, 100029) g`, [spam]);
  const another = await approved(await realUser(), 'Is spring better than fall?');
  await assert.rejects(reportIt(spam, 'post', another), /enough reports/);
});

test('a block turns down what is waiting, hides what was shown, and stops new posts', async () => {
  const w = await realUser(), viewer = await user();
  const shown = await approved(w, 'Is chess a sport?');
  await admin(`update public.posts set created_at = now() - interval '1 hour' where user_id = $1`, [w]);
  const waiting = await post(w, 'Is golf a sport?');
  await assert.rejects(call(mod, `select public.ban_author('post', $1, 0, 'Spam') as r`, [-1]), /no such item/);
  assert.equal(await call(mod, `select public.ban_author('post', $1, 7, 'Spam') as r`, [shown]), 'blocked');
  assert.ok(!ids(await feed(viewer)).includes(shown));
  const mine = (await feed(w)).posts.find(x => x.id === waiting.id);
  assert.deepEqual([mine.status, mine.reason], ['rejected', 'Spam']);
  await admin(`update public.posts set created_at = now() - interval '1 hour' where user_id = $1`, [w]);
  await assert.rejects(post(w, 'Is darts a sport?'), /blocked for you/);
  assert.equal((await call(w, 'select public.my_profile() as r')).blocked, true);
  const modPost = await approved(mod, 'Is this a moderator post?');
  await assert.rejects(call(mod, `select public.ban_author('post', $1) as r`, [modPost]), /moderators cannot be blocked/);
  await admin('delete from public.bans where user_id = $1', [w]);
  assert.ok(ids(await feed(viewer)).includes(shown), 'lifting the block shows it again');
});

test('the feed never carries account ids, and codes only between mutual friends', async () => {
  const w = await realUser(), viewer = await user();
  const pid = await approved(w, 'Should phones be banned in class?');
  await judge(viewer, pid, true);
  const f = JSON.stringify(await feed(viewer));
  const accounts = (await admin('select id::text from auth.users')).rows.map(r => r.id);
  for (const id of accounts) assert.ok(!f.includes(id), 'an account id leaked into the feed');
  const codes = (await admin('select code from public.profiles where id <> $1', [viewer])).rows.map(r => r.code);
  for (const c of codes) assert.ok(!f.includes('"' + c + '"'), 'a code leaked into the feed');
});

test('you can delete your own post or comment, and nobody else can', async () => {
  const w = await realUser(), c = await realUser();
  const pid = await approved(w, 'Is breakfast the best meal?');
  await judge(c, pid, true);
  const cm = await comment(c, pid, 'Pancakes win');
  await assert.rejects(call(w, `select public.delete_mine('comment', $1) as r`, [cm.id]), /no such item/);
  await assert.rejects(call(c, `select public.delete_mine('post', $1) as r`, [pid]), /no such item/);
  assert.equal(await call(c, `select public.delete_mine('comment', $1) as r`, [cm.id]), 'deleted');
  assert.equal(await call(w, `select public.delete_mine('post', $1) as r`, [pid]), 'deleted');
  assert.equal((await admin('select count(*)::int as n from public.post_votes where post_id = $1', [pid])).rows[0].n, 0, 'its judgments went with it');
});

test('auto_approve: off unless the owner sets it; then posts and comments go live at once, the moderator sees only reports, and every other rule holds', async () => {
  const w = await realUser(), c = await realUser(), viewer = await user();
  const has = (list, kind, id) => list.some(x => x.kind === kind && x.id === id);
  assert.equal((await feed(viewer)).review_first, true, 'everything waits for review by default');
  assert.equal((await queue(mod)).review_first, true);
  await admin(`update public.app_config set value = 1 where key = 'auto_approve'`);
  try {
    assert.equal((await feed(viewer)).review_first, false, 'the app is told, so it stops promising a check first');
    const p = await post(w, 'Is a hot dog a sandwich?');
    assert.equal(p.status, 'approved', 'live at once');
    assert.ok(ids(await feed(viewer)).includes(p.id), 'others see it straight away');
    assert.ok(ids(await feed(null)).includes(p.id), 'and so does anon');
    await judge(c, p.id, false);
    const cm = await comment(c, p.id, 'It is a taco');
    assert.equal(cm.status, 'approved');
    assert.ok((await feed(viewer)).posts.find(x => x.id === p.id).comments.some(x => x.id === cm.id), 'the comment shows too');
    // Nothing for the moderator to approve: the queue has only what people report.
    let q = await queue(mod);
    assert.equal(q.review_first, false);
    assert.deepEqual(Object.keys(q).sort(), ['reported', 'review_first', 'waiting']);
    assert.ok(![['post', p.id], ['comment', cm.id]].some(([k, id]) => has(q.waiting, k, id) || has(q.reported, k, id)));
    // A report puts it in front of the moderator; 3 hide it for everyone, as before. Removing tells the writer why.
    await reportIt(await user(), 'comment', cm.id);
    q = await queue(mod);
    assert.ok(has(q.reported, 'comment', cm.id));
    assert.ok(!JSON.stringify(q).includes(c), 'no account ids in the queue');
    await review(mod, 'comment', cm.id, 'remove', 'Spam');
    assert.ok(!(await feed(viewer)).posts.find(x => x.id === p.id).comments.some(x => x.id === cm.id), 'the removed comment is gone');
    assert.equal((await feed(c)).posts.find(x => x.id === p.id).comments.find(x => x.id === cm.id).status, 'removed');
    const w2 = await realUser(), p2 = await post(w2, 'Is cereal better at night?');
    for (let i = 0; i < 3; i++) await reportIt(await user(), 'post', p2.id);
    assert.ok(!ids(await feed(viewer)).includes(p2.id), 'hidden for everyone at 3 reports');
    // The word filter, the gap between posts, the age rule and blocks still apply.
    await assert.rejects(post(await realUser(), 'Can you dm me later?'), /blocked words/);
    await assert.rejects(post(await realUser(), 'Are you a f@ggot?'), /blocked words/);
    await assert.rejects(post(w, 'Is a taco a sandwich?'), /wait a moment/);
    const year = new Date().getUTCFullYear();
    await assert.rejects(post(await realUser([year - 12, 1]), 'Is recess too short?'), /13 and older/);
    await call(mod, `select public.ban_author('post', $1, 7, 'Spam') as r`, [p2.id]);
    await admin(`update public.posts set created_at = now() - interval '1 hour' where user_id = $1`, [w2]);
    await assert.rejects(post(w2, 'Is lunch too early?'), /blocked for you/);
  } finally {
    await admin(`update public.app_config set value = 0 where key = 'auto_approve'`);
  }
  assert.equal((await post(await realUser(), 'Is it back to waiting?')).status, 'pending', 'switched off: new ones wait again');
  assert.equal((await feed(viewer)).review_first, true);
});

// The slur list lives twice: blocked_terms here and core.js in the app (so the app can say so before sending).
// Both must hold the same patterns and agree on every example, including spellings meant to slip past a filter.
const SLUR_EXAMPLES = ['you nigger', 'NIGGA please', 'my niggas', 'niggaz', 'nigguh', 'niiigggaaa', 'n1gg3r', 'ni99a', 'n*gga',
  'n i g g a', 'n.i.g.g.e.r', 'N-I-G-G-E-R', 'niglet', 'faggot', 'you fag', 'fags', 'f@g', 'f4ggot', 'faggit', 'f a g g o t',
  'dyke', 'tranny', 'trannies', 'shemale', 'lesbo', 'retard', 'retarded', 'r3tard', 'mongoloid', 'kike', 'kyke', 'chink',
  'gook', 'g00k', 'spic', 'spics', 'wetback', 'beaner', 'coon', 'jigaboo', 'porch monkey', 'towelhead', 'raghead', 'rag-head', 'paki',
  'redskins', 'squaw', 'jungle bunnies', 'zipperhead', 'sandnigger', 'gyppo', 'kaffir', 'tard', 'spick', 'niggress'];
const CLEAN_EXAMPLES = ['Is Niger in Africa?', 'Is Nigeria the biggest country in Africa?', 'Is snigger a real word?',
  'Is that just a niggle?', 'Is a raccoon cute?', 'Is a cocoon cozy?', 'Is Pakistan hot in summer?', 'Is flame retardant safe?',
  'Do you like spicy food?', 'Is Fagin a villain?', 'Is that a running gag?', 'Is this a con?', 'Is a dike a wall?',
  'Is a chinchilla soft?', 'Is Hong Kong busy?', 'Is bacon good?', 'Mini golf or bowling?', 'Lamborghini or Ferrari?',
  'Is a martini gross?', 'Is a pecan a nut?', 'Is Scunthorpe in England?', 'I scored 69 points, is that good?',
  'Is 2024 a leap year?', 'Is a gecko a good pet?', 'Is red skin from the sun bad?', 'Is a spice rack useful?',
  'Is she male or female?', 'I came home with a wet back, is that bad?', 'Is a towel head wrap good?', 'Is squawk a bird sound?',
  'Do you know Nigel?', 'Is nigiri better than rolls?', 'Is a tycoon rich?', 'Is Kiki a cute name?', 'Is sniggering rude?',
  'Is Chinese food the best?', 'Is a fig a fruit?', 'Who won the Niger match?', 'Is the zipper head stuck?', 'Is kafir an Arabic word?'];

test('slurs are refused, written plainly or dodged, and the app checks exactly the same list', async () => {
  const { SLURS, SQUEEZED, blockedText } = await import('../core.js');
  const rows = (await admin('select pattern, squeezed from public.blocked_terms')).rows;
  const sql = r => r.source.replace(/^\\b/, '\\m').replace(/\\b$/, '\\M');
  for (const r of SLURS) assert.ok(rows.some(x => x.pattern === sql(r) && !x.squeezed), 'setup.sql is missing ' + sql(r));
  for (const r of SQUEEZED) assert.ok(rows.some(x => x.pattern === r.source && x.squeezed), 'setup.sql is missing squeezed ' + r.source);
  const blocked = async t => (await admin('select verd_private.blocked($1) as b', [t])).rows[0].b;
  for (const t of SLUR_EXAMPLES) {
    assert.equal(await blocked(t), true, 'the database let through: ' + t);
    assert.equal(blockedText(t), true, 'the app let through: ' + t);
  }
  for (const t of CLEAN_EXAMPLES) {
    assert.equal(await blocked(t), false, 'the database refused: ' + t);
    assert.equal(blockedText(t), false, 'the app refused: ' + t);
  }
  // And through the real calls: a post, a comment and a suggested question.
  const w = await realUser(), c = await realUser();
  await assert.rejects(post(w, 'Are all n1gg@s like this?'), /blocked words/);
  const pid = await approved(w, 'Is soccer better than football?');
  await judge(c, pid, true);
  await assert.rejects(comment(c, pid, 'only a f a g g o t says no'), /blocked words/);
  await assert.rejects(call(c, 'select public.suggest_question($1, $2) as r', ['Is a tranny weird?', ['Yes', 'No']]), /friendly/);
  // The old link pattern never matched in Postgres (\b is a backspace there). Now a bare web address is refused.
  for (const [t, want] of [['Go to example.com now', true], ['Is it cool. Me too', false]]) {
    assert.equal(await blocked(t), want, 'the database got wrong: ' + t);
    assert.equal(blockedText(t), want, 'the app got wrong: ' + t);
  }
});
