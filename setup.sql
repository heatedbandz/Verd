-- Verd database for Supabase.
--
-- How to install (about 5 minutes, works from a phone):
--   1. Supabase dashboard > SQL Editor > New query. Paste this whole file. Press Run.
--   2. Authentication > Sign In / Providers > turn on "Allow anonymous sign-ins". Save.
--   3. Project Settings > API: copy the Project URL and the anon public key into CONFIG in app.js.
-- Running it again is safe: it keeps votes and replaces the functions.
--
-- Why the anon key can sit in a public web page:
--   * Every table has row level security ON with no policies, and the browser roles (anon,
--     authenticated) have no privileges on any table. A client cannot read, insert, update or
--     delete a single row directly.
--   * The app only calls the functions below. They run as the owner and check everything.
--   * One vote per person per question is the primary key (day, user_id). user_id is always
--     auth.uid(), never something the browser sends.
--   * Results are totals only. A split is returned only when enough people voted (app_config),
--     and today's totals only come back after you have voted, so nobody can peek.
--   * Location is stored as country, state and city only. Never coordinates.
--   * A friend match compares two people only when both added each other, over past days, and
--     never returns an answer. Friend lists are locked like votes: no browser role can read them.
--   * tests/db.test.mjs and tests/live-rls.mjs try to break all of this and must fail to.

-- Older test versions of this file used a different votes table (voter text). Replace it.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'votes' and column_name = 'voter') then
    drop table public.votes cascade;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'suggestions' and column_name = 'voter') then
    drop table public.suggestions cascade;
  end if;
end $$;
drop function if exists public.tally(text);
drop function if exists public.friend_votes(text[]);

-- ---------- Tables ----------

create table if not exists public.app_config (
  key   text primary key,
  value int  not null
);
insert into public.app_config (key, value) values
  ('min_world', 10),            -- no world percentages below 10 votes
  ('min_country', 30),          -- no country split below 30 votes
  ('min_state', 30),
  ('min_city', 30),
  ('min_friend_overlap', 3),    -- friend match needs 3 shared past answers
  ('suggestions_per_day', 3)
on conflict (key) do nothing;

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  code        text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  imported_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.votes (
  day        date     not null,
  user_id    uuid     not null references auth.users (id) on delete cascade,
  choice     smallint not null check (choice between 0 and 3),
  country    text     not null default 'XX' check (country ~ '^[A-Z]{2}$'),
  state      text     check (state is null or char_length(state) between 1 and 40),
  city       text     check (city is null or char_length(city) between 1 and 40),
  created_at timestamptz not null default now(),
  primary key (day, user_id)   -- one vote per person per question, enforced here
);
create index if not exists votes_by_country on public.votes (day, country);
create index if not exists votes_by_place   on public.votes (day, country, state, city);
create index if not exists votes_by_user    on public.votes (user_id, day);

-- Question ideas from players. This is the moderation queue: everything starts as pending.
-- Read and approve them in Table Editor > suggestions.
create table if not exists public.suggestions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  question   text not null check (char_length(question) between 5 and 140),
  answers    text[] not null check (array_length(answers, 1) between 2 and 4),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);
create index if not exists suggestions_by_user on public.suggestions (user_id, created_at);

-- Words and patterns that are never allowed in anything a player writes.
-- Add your own rows in Table Editor > blocked_terms (they are matched case-insensitively as regex).
create table if not exists public.blocked_terms (
  pattern text primary key
);
insert into public.blocked_terms (pattern) values
  ('https?://'), ('www\.'), ('\.(com|net|org|io|gg|me|ly)\b'),   -- links
  ('@[a-z0-9_.]{2,}'),                                            -- @handles
  ('[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'),                      -- emails
  ('\d[\d\s().-]{6,}\d'),                                         -- phone numbers
  ('\m(kys|kill (yo)?urself|kill you)\M')                         -- threats
on conflict (pattern) do nothing;

-- The friends each person added, by code. A friend match needs both people to have added each
-- other, so knowing someone's code is not enough to compare yourself with them.
create table if not exists public.friend_adds (
  user_id  uuid not null references auth.users (id) on delete cascade,
  code     text not null check (code ~ '^[A-Z2-9]{6}$'),
  added_at timestamptz not null default now(),
  primary key (user_id, code)
);
create index if not exists friend_adds_by_code on public.friend_adds (code);

-- Lock every table: RLS on, no policies, no privileges for the browser roles.
alter table public.app_config    enable row level security;
alter table public.profiles      enable row level security;
alter table public.votes         enable row level security;
alter table public.suggestions   enable row level security;
alter table public.blocked_terms enable row level security;
alter table public.friend_adds   enable row level security;
revoke all on public.app_config, public.profiles, public.votes, public.suggestions, public.blocked_terms, public.friend_adds
  from public, anon, authenticated;
revoke all on sequence public.suggestions_id_seq from public, anon, authenticated;

-- ---------- Private helpers (not reachable from the API) ----------

create schema if not exists verd_private;
revoke all on schema verd_private from public, anon, authenticated;

create or replace function verd_private.cfg(k text) returns int
language sql stable security definer set search_path = public as $$
  select value from public.app_config where key = k
$$;

create or replace function verd_private.today() returns date
language sql stable as $$ select (now() at time zone 'utc')::date $$;

-- Coarse place key: trimmed, lower case, at most 40 characters, empty means none.
create or replace function verd_private.place(x text) returns text
language sql immutable as $$
  select nullif(left(lower(btrim(regexp_replace(coalesce(x, ''), '\s+', ' ', 'g'))), 40), '')
$$;

create or replace function verd_private.country(x text) returns text
language sql immutable as $$
  select case when upper(coalesce(x, '')) ~ '^[A-Z]{2}$' then upper(x) else 'XX' end
$$;

create or replace function verd_private.blocked(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocked_terms b where coalesce(t, '') ~* b.pattern)
$$;

-- Friend code: 6 characters from a CSPRNG (gen_random_uuid), no 0/O/1/I.
create or replace function verd_private.ensure_profile(uid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  c   text;
  b   bytea;
  abc constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  select code into c from public.profiles where id = uid;
  if c is not null then return c; end if;
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    c := '';
    for i in 0..5 loop
      c := c || substr(abc, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    begin
      insert into public.profiles (id, code) values (uid, c);
      return c;
    exception when unique_violation then
      select code into c from public.profiles where id = uid;   -- created by a parallel call?
      if c is not null then return c; end if;                   -- otherwise the code was taken: try again
    end;
  end loop;
end $$;

-- Totals for one level. counts is null unless the caller may see them and n meets the minimum.
create or replace function verd_private.level(d date, n smallint, lvl text, cc text, st text, ci text, can_see boolean)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  total   int;
  arr     int[];
  minimum int := verd_private.cfg('min_' || lvl);
begin
  select coalesce(sum(x.cnt), 0)::int, array_agg(coalesce(x.cnt, 0)::int order by i)
    into total, arr
    from generate_series(0, n - 1) as i
    left join (
      select v.choice, count(*) as cnt
        from public.votes v
       where v.day = d
         and v.choice < n
         and (lvl = 'world' or v.country = cc)
         and (lvl not in ('state', 'city') or v.state = st)
         and (lvl <> 'city' or v.city = ci)
       group by v.choice
    ) x on x.choice = i;
  return jsonb_build_object(
    'n', total,
    'counts', case when can_see and total >= minimum then to_jsonb(arr) end
  );
end $$;

revoke all on all functions in schema verd_private from public, anon, authenticated;

-- ---------- The API: the only things the app can call ----------

-- Results for a question. n = number of answers (2 to 4).
-- Today's counts only come back if the caller has voted today. Past days are open.
create or replace function public.get_results(d date, n smallint, cc text default null, st text default null, ci text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid     uuid := auth.uid();
  mine    smallint;
  can_see boolean;
  k_cc    text := verd_private.country(cc);
  k_st    text := verd_private.place(st);
  k_ci    text := verd_private.place(ci);
begin
  if d is null or n is null or n < 2 or n > 4 then
    raise exception 'bad request' using errcode = '22023';
  end if;
  if d > verd_private.today() then
    raise exception 'that question is not out yet' using errcode = '22023';
  end if;
  if uid is not null then
    select v.choice into mine from public.votes v where v.day = d and v.user_id = uid;
  end if;
  can_see := d < verd_private.today() or mine is not null;
  return jsonb_build_object(
    'day', d,
    'mine', mine,
    'visible', can_see,
    'min', jsonb_build_object(
      'world', verd_private.cfg('min_world'), 'country', verd_private.cfg('min_country'),
      'state', verd_private.cfg('min_state'), 'city', verd_private.cfg('min_city')),
    'world', verd_private.level(d, n, 'world', null, null, null, can_see),
    'country', case when k_cc <> 'XX' then verd_private.level(d, n, 'country', k_cc, null, null, can_see) end,
    'state', case when k_cc <> 'XX' and k_st is not null then verd_private.level(d, n, 'state', k_cc, k_st, null, can_see) end,
    'city', case when k_cc <> 'XX' and k_st is not null and k_ci is not null
                 then verd_private.level(d, n, 'city', k_cc, k_st, k_ci, can_see) end
  );
end $$;

-- Vote. Keeps your first answer; a second call changes nothing. Returns the results.
-- Today's question, plus yesterday's for votes made offline just before midnight UTC.
create or replace function public.cast_vote(d date, c smallint, n smallint, cc text default 'XX', st text default null, ci text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  k_st text := verd_private.place(st);
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if d is null or d < verd_private.today() - 1 or d > verd_private.today() then
    raise exception 'that question is closed' using errcode = '22023';
  end if;
  if n is null or n < 2 or n > 4 or c is null or c < 0 or c >= n then
    raise exception 'bad answer' using errcode = '22023';
  end if;
  perform verd_private.ensure_profile(uid);
  insert into public.votes (day, user_id, choice, country, state, city)
  values (d, uid, c, verd_private.country(cc), k_st,
          case when k_st is null then null else verd_private.place(ci) end)
  on conflict (day, user_id) do nothing;
  return public.get_results(d, n, cc, st, ci);
end $$;

-- Your friend code (made on first use).
create or replace function public.my_profile()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  return jsonb_build_object('code', verd_private.ensure_profile(uid));
end $$;

-- One-time copy of answers this phone saved before the database existed.
-- Only days from launch to today, at most 60, once per person.
create or replace function public.import_votes(items jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  done timestamptz;
  k    int := 0;
  it   jsonb;
  d    date;
  c    int;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  perform verd_private.ensure_profile(uid);
  select imported_at into done from public.profiles where id = uid for update;
  if done is not null then return 0; end if;
  for it in select value from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end) limit 60 loop
    begin
      d := (it ->> 'd')::date;
      c := (it ->> 'c')::int;
      if d between date '2026-11-17' and verd_private.today() and c between 0 and 3 then
        insert into public.votes (day, user_id, choice, country)
        values (d, uid, c, verd_private.country(it ->> 'cc'))
        on conflict (day, user_id) do nothing;
        if found then k := k + 1; end if;
      end if;
    exception when others then
      null;   -- skip a malformed item, keep the rest
    end;
  end loop;
  update public.profiles set imported_at = now() where id = uid;
  return k;
end $$;

-- How often you agree with friends, by their codes. Only friends who added you too get a row
-- (shared = 0 when you have no past answers in common yet). Past days only (today stays private),
-- agreement only once you share enough answers. Never returns anyone's actual answers.
create or replace function public.friend_match(codes text[])
returns table (code text, shared int, agree int)
language plpgsql stable security definer set search_path = public as $$
declare
  uid     uuid := auth.uid();
  minimum int := verd_private.cfg('min_friend_overlap');
  mine    text;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select pr.code into mine from public.profiles pr where pr.id = uid;
  return query
    select p.code,
           count(m.day)::int,
           case when count(m.day) >= minimum then (count(*) filter (where f.choice = m.choice))::int end
      from public.profiles p
      join public.friend_adds i_added    on i_added.user_id = uid and i_added.code = p.code
      join public.friend_adds they_added on they_added.user_id = p.id and they_added.code = mine
      left join public.votes f on f.user_id = p.id and f.day < verd_private.today()
      left join public.votes m on m.user_id = uid and m.day = f.day
     where p.code = any (codes[1:50])
       and p.id <> uid
     group by p.code;
end $$;

-- Your friend list, as the app has it. It replaces what was saved, so removing someone here ends
-- the match for both of you. Up to 50 codes; your own code and malformed ones are skipped.
create or replace function public.set_friends(codes text[])
returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  mine text;
  k    int;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  mine := verd_private.ensure_profile(uid);
  delete from public.friend_adds where user_id = uid;
  insert into public.friend_adds (user_id, code)
  select distinct uid, upper(c)
    from unnest((coalesce(codes, '{}'::text[]))[1:50]) as c
   where upper(c) ~ '^[A-Z2-9]{6}$' and upper(c) <> mine;
  get diagnostics k = row_count;
  return k;
end $$;

-- Today's board: countries (no cc), states in a country (no st) or cities in a state,
-- only places with enough votes, biggest first. Today's board needs your vote first.
create or replace function public.get_board(d date, n smallint, cc text default null, st text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid     uuid := auth.uid();
  k_cc    text := case when cc is null then null else verd_private.country(cc) end;
  k_st    text := verd_private.place(st);
  lvl     text := case when cc is null then 'country' when k_st is null then 'state' else 'city' end;
  minimum int := verd_private.cfg('min_' || lvl);
  result  jsonb;
begin
  if d is null or n is null or n < 2 or n > 4 or d > verd_private.today() then
    raise exception 'bad request' using errcode = '22023';
  end if;
  if d = verd_private.today() and (uid is null or not exists (
       select 1 from public.votes v where v.day = d and v.user_id = uid)) then
    return '[]'::jsonb;
  end if;
  with src as (
    select case lvl when 'country' then v.country when 'state' then v.state else v.city end as place, v.choice
      from public.votes v
     where v.day = d and v.choice < n
       and (lvl = 'country' or v.country = k_cc)
       and (lvl <> 'city' or v.state = k_st)
  ), per as (
    select src.place, src.choice, count(*)::int as cnt
      from src where src.place is not null and src.place <> 'XX'
     group by src.place, src.choice
  ), tot as (
    select per.place, sum(per.cnt)::int as total
      from per group by per.place
    having sum(per.cnt) >= minimum
     order by 2 desc
     limit 8
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'place', t.place,
           'n', t.total,
           'counts', (select to_jsonb(array_agg(coalesce(p.cnt, 0) order by i))
                        from generate_series(0, n - 1) as i
                        left join per p on p.place = t.place and p.choice = i))
         order by t.total desc), '[]'::jsonb)
    into result
    from tot t;
  return result;
end $$;

-- Suggest a question. Signed-in players only, a few a day, blocklist checked, held for review.
create or replace function public.suggest_question(q text, answers text[])
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid    uuid := auth.uid();
  recent int;
  clean  text[];
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  q := btrim(regexp_replace(coalesce(q, ''), '\s+', ' ', 'g'));
  if char_length(q) not between 5 and 140 then
    raise exception 'questions are 5 to 140 characters' using errcode = '22023';
  end if;
  clean := array(select left(btrim(a), 40) from unnest(coalesce(answers, '{}')) a where btrim(a) <> '' limit 4);
  if coalesce(array_length(clean, 1), 0) < 2 then
    raise exception 'give 2 to 4 answers' using errcode = '22023';
  end if;
  if verd_private.blocked(q || ' ' || array_to_string(clean, ' ')) then
    raise exception 'keep it friendly: no links, handles, numbers or threats' using errcode = '22023';
  end if;
  select count(*) into recent from public.suggestions s
   where s.user_id = uid and s.created_at > now() - interval '1 day';
  if recent >= verd_private.cfg('suggestions_per_day') then
    raise exception 'that is enough ideas for today' using errcode = '22023';
  end if;
  insert into public.suggestions (user_id, question, answers) values (uid, q, clean);
  return 'pending';
end $$;

-- Who may call what. Results and boards are open (they are totals with minimums);
-- everything that writes or is about you needs a session (anonymous counts).
revoke all on function public.get_results(date, smallint, text, text, text) from public;
revoke all on function public.cast_vote(date, smallint, smallint, text, text, text) from public;
revoke all on function public.my_profile() from public;
revoke all on function public.import_votes(jsonb) from public;
revoke all on function public.friend_match(text[]) from public;
revoke all on function public.set_friends(text[]) from public;
revoke all on function public.get_board(date, smallint, text, text) from public;
revoke all on function public.suggest_question(text, text[]) from public;
revoke all on function public.cast_vote(date, smallint, smallint, text, text, text) from anon;
revoke all on function public.my_profile() from anon;
revoke all on function public.import_votes(jsonb) from anon;
revoke all on function public.friend_match(text[]) from anon;
revoke all on function public.set_friends(text[]) from anon;
revoke all on function public.suggest_question(text, text[]) from anon;
grant execute on function public.get_results(date, smallint, text, text, text) to anon, authenticated;
grant execute on function public.get_board(date, smallint, text, text) to anon, authenticated;
grant execute on function public.cast_vote(date, smallint, smallint, text, text, text) to authenticated;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.import_votes(jsonb) to authenticated;
grant execute on function public.friend_match(text[]) to authenticated;
grant execute on function public.set_friends(text[]) to authenticated;
grant execute on function public.suggest_question(text, text[]) to authenticated;
