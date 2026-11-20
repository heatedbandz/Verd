-- Verd database for Supabase.
--
-- How to install (about 5 minutes, works from a phone):
--   1. Supabase dashboard > SQL Editor > New query. Paste this whole file. Press Run. The result should say
--      "Verd is set up, with posting". "Success. No rows returned" means an older copy of this file ran.
--   2. Authentication > Sign In / Providers > turn on "Allow anonymous sign-ins". Save.
--   3. Press Connect (or Settings > API Keys): copy the Project URL and the publishable key
--      (sb_publishable_..., called the anon public key on older projects) into CONFIG in app.js.
-- Running it again is safe: it keeps votes and replaces the functions.
--
-- Posting (people's own yes/no questions) stays closed until the account owner also does this:
--   4. Google Cloud console > Google Auth Platform: audience External, then Publish app. Clients > Create
--      client > Web application, with the authorized redirect URI
--      https://<your project>.supabase.co/auth/v1/callback. Copy the client ID and secret.
--   5. Authentication > Sign In / Providers > Google: turn it on, paste the ID and secret, Save.
--      Same page: turn on "Allow manual linking" (an anonymous account becomes the Google one). Save.
--   6. Authentication > URL Configuration: Site URL https://heatedbandz.github.io/Verd/ and the
--      redirect URL https://heatedbandz.github.io/Verd/** . Save.
--   7. The moderator signs in on the site (Me > Account), then runs this here with their email:
--        insert into public.moderators (user_id) select id from auth.users where email = 'their@email.com';
--   Posting opens the moment a moderator exists. To pause it straight away:
--        update public.app_config set value = 1 where key = 'posting_paused';   (0 opens it again)
--   New posts and comments wait for the moderator. To let them go live at once instead, with the moderator
--   seeing only what people report (only the account owner can switch this):
--        update public.app_config set value = 1 where key = 'auto_approve';     (0 makes them wait again)
--
-- Why the publishable (anon) key can sit in a public web page:
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
--   * Posts and comments: only a real (Google) account, 13 or older by the birth month kept with it,
--     not blocked, can write. Everything waits for a moderator (unless the owner sets auto_approve),
--     words are filtered here, and the limits are counted here. Nobody's account id, email or name
--     ever leaves the database.
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
-- Add your own rows in Table Editor > blocked_terms (they are matched case-insensitively as regex). Each is
-- checked on the text as written and with the swaps people use to dodge a filter undone (n1gg3r, f@g, ni99a).
-- Rows marked squeezed are checked with everything but letters taken out instead (n i g g a, n.i.g.g.e.r).
-- The app checks the same slurs before sending (core.js), and tests/db.test.mjs keeps the two lists equal.
create table if not exists public.blocked_terms (
  pattern text primary key
);
alter table public.blocked_terms add column if not exists squeezed boolean not null default false;
-- Rows from earlier copies of this file that the lists below replace. The link one had \b, which in Postgres
-- means a backspace, so it never matched. The slur ones missed common dodges and caught phrases like "a wet back".
delete from public.blocked_terms where pattern in (
  '\.(com|net|org|io|gg|me|ly)\b',
  '\mn+[i1!l|]+gg+(a|ah|as|az|er|ers|uh|uz|ress)?\M',
  '\mn[i1!]g{1,2}(let|lets|ra|ras)\M',
  '\mf+[a@4]+g+([o0]+t+s?|s|y|ie|ier)?\M',
  '\mk[i1!y]kes?\M',
  '\mch[i1!]nks?\M',
  '\msp[i1!]c?ks?\M',
  '\mwet ?backs?\M',
  '\mbeaners?\M',
  '\mg[o0][o0]ks?\M',
  '\mc[o0][o0]ns?\M',
  '\mjig(g)?ab[o0][o0]s?\M',
  '\mporch ?monkeys?\M',
  '\mjungle ?bunn(y|ies)\M',
  '\mtowel ?heads?\M',
  '\mrag ?heads?\M',
  '\msand ?n[i1!]gg',
  '\mzipper ?heads?\M',
  '\mpak[i1!]s\M',
  '\mdykes?\M',
  '\mtr[a@4]nn(y|ie|ies)\M',
  '\mshemales?\M',
  '\mret[a@4]rd(s|ed)?\M',
  '\mtard(s)?\M',
  '\mgyppos?\M',
  '\mkaff[i1]rs?\M');
insert into public.blocked_terms (pattern) values
  ('https?://'), ('www\.'), ('\.(com|net|org|io|gg|me|ly)\M'),   -- links
  ('@[a-z0-9_.]{2,}'),                                            -- @handles
  ('[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'),                      -- emails
  ('\d[\d\s().-]{6,}\d'),                                         -- phone numbers
  ('\m(kys|kill (yo)?urself|kill you)\M'),                        -- threats
  ('\m(dm|snap|add|text|hmu)\s+me\M'), ('\mhmu\M'),                   -- asking strangers for contact
  ('\mmy\s+(snap|snapchat|insta|ig|discord|number|addy|address)\M'),
  ('\m(send|show)\s+(me\s+)?(a\s+)?(pics?|nudes?|photos?)\M'),          -- asking for pictures
  ('\mhow old (are|r) (you|u)\M'), ('\mwhere do (you|u) live\M'),      -- asking a stranger's age or home
  ('\m(nudes?|sext(ing)?|porn|onlyfans|horny)\M')                    -- sexual
on conflict (pattern) do nothing;
-- Slurs, refused outright so nothing hateful ever needs a person to check it. Doubled letters (niggga),
-- plurals and look-alike swaps (n1gg3r, f@g, n*gga) count. Whole words only, so "raccoon" and "spicy" still work.
-- Each one is in core.js as well.
insert into public.blocked_terms (pattern) values
  ('\mn+[i1!l|*]+g{2,}(a+|e+r+|u+h*|a+h+|r+e+s+)?[sz]?\M'), ('\mn+[i1!l|*]+g+(l+e+t+|r+a+)s?\M'),
  ('\mf+[a4@*]+g+(o+t+|i+t+|e+t+|y|i+e+r?)?s?\M'), ('\md+y+k+e+s?\M'), ('\mt+r+a+n+(y+|i+e+)s?\M'),
  ('\ms+h+e+-?m+a+l+e+s?\M'), ('\ml+e+s+b+o+s?\M'),
  ('\m(r+e+)?t+a+r+d+(s|e+d+|o+s?)?\M'), ('\mm+o+n+g+o+l+o+i+d+s?\M'),
  ('\mk+[i1!y]+k+e+s?\M'), ('\mc+h+[i1!]+n+k+(s|y)?\M'), ('\mg+o{2,}k+s?\M'), ('\ms+p+[i1!]+(c+k*|k+)s?\M'),
  ('\mw+e+t+-?b+a+c+k+s?\M'), ('\mb+e+a+n+e+r+s?\M'), ('\mc+o{2,}n+s?\M'), ('\mj+[i1!]+g+a+b+o+s?\M'),
  ('\mp+o+r+c+h+[\s-]*m+o+n+k+e+y+s?\M'), ('\mj+u+n+g+l+e+[\s-]*b+u+n+(y+|i+e+)s?\M'),
  ('\m(t+o+w+e+l+|r+a+g+|z+i+p+e+r+)-?h+e+a+d+s?\M'), ('\mp+a+k+i+s?\M'), ('\mr+e+d+s+k+i+n+s?\M'),
  ('\ms+q+u+a+w+s?\M'), ('\mg+y+p+o+s?\M'), ('\mk+a+f{2,}[i1!]+r+s?\M')
on conflict (pattern) do nothing;
insert into public.blocked_terms (pattern, squeezed) values
  ('(^|[^s])nigg+(er|a(?!rd)|uh|ah)', true), ('fagg+(o|i|e)t', true)   -- spelled out: n i g g a, f.a.g.g.o.t
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

-- The text with the swaps people use to slip past a filter undone: n1gg3r is nigger, f@g is fag. core.js does the same.
create or replace function verd_private.unleet(t text) returns text
language sql immutable as $$ select translate(lower(coalesce(t, '')), '0134@$5796', 'oieaasstgg') $$;

create or replace function verd_private.blocked(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocked_terms b
                  where case when b.squeezed then regexp_replace(verd_private.unleet(t), '[^a-z]', '', 'g') ~* b.pattern
                             else coalesce(t, '') ~* b.pattern or verd_private.unleet(t) ~* b.pattern end)
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

-- Your friend code (made on first use), and what your account may do: real = signed in with a real
-- account, not anonymous; age_given / age_ok = month and year given, 13 or older; open = posting is open.
create or replace function public.my_profile()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'code', verd_private.ensure_profile(uid),
    'real', verd_private.real(uid),
    'age_given', (select p.born is not null from public.profiles p where p.id = uid),
    'age_ok', verd_private.age_ok(uid),
    'moderator', verd_private.is_mod(uid),
    'blocked', verd_private.banned(uid),
    'open', verd_private.posting_open());
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
  -- Codes still on the list keep the time they were first added, so a friend request stays in its place.
  delete from public.friend_adds f
   where f.user_id = uid and f.code <> all (select coalesce(upper(c), '') from unnest((coalesce(codes, '{}'::text[]))[1:50]) as c);
  insert into public.friend_adds (user_id, code)
  select distinct uid, upper(c)
    from unnest((coalesce(codes, '{}'::text[]))[1:50]) as c
   where upper(c) ~ '^[A-Z2-9]{6}$' and upper(c) <> mine
  on conflict (user_id, code) do nothing;
  select count(*) into k from public.friend_adds f where f.user_id = uid;
  return k;
end $$;

-- Friend requests: people who added your code that you haven't added back, newest first (the last 60 days,
-- at most 20). Only their code comes back, never a name or anything else about them. Accepting is the app
-- adding their code to your list (set_friends); saying no is kept on the phone.
create or replace function public.friend_requests()
returns table (code text, t bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  mine text;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select pr.code into mine from public.profiles pr where pr.id = uid;
  if mine is null then
    return;
  end if;
  return query
    select p.code, verd_private.ms(f.added_at)
      from public.friend_adds f
      join public.profiles p on p.id = f.user_id
     where f.code = mine and p.id <> uid and f.added_at > now() - interval '60 days'
       and not exists (select 1 from public.friend_adds back where back.user_id = uid and back.code = p.code)
     order by f.added_at desc
     limit 20;
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

-- ---------- Posting ----------
-- People's own yes/no questions, judged by everyone else.
--   * Every post and comment waits for a moderator before anyone else sees it. So posting stays closed
--     until the owner adds a moderator, and app_config posting_paused = 1 stops it at once.
--   * Unless the owner sets app_config auto_approve = 1: then new ones go live at once, the word filter is
--     the only check before they show, and the moderator sees what people report.
--   * Writing needs a real sign-in (not an anonymous session), an age given once and kept here (13 or
--     older), and no block. Judging and reporting only need a session, like voting.
--   * Rate limits and the blocked_terms list are checked here, so no app can skip them.
--   * Nobody's name or code is shown. A post or comment is "Someone" to everyone but mutual friends.
--   * Enough reports hide a post or comment for everyone until a moderator looks at it.

insert into public.app_config (key, value) values
  ('posts_per_day', 3),          -- posts per person per day
  ('post_gap_seconds', 120),     -- and at least 2 minutes apart
  ('comments_per_day', 20),
  ('comment_gap_seconds', 20),
  ('reports_per_day', 30),
  ('hide_at_reports', 3),        -- hidden for everyone at 3 reports, until a moderator looks
  ('posting_paused', 0),         -- set to 1 to stop new posts and comments straight away
  ('auto_approve', 0)            -- 1: new posts and comments go live at once; the moderator sees what's reported
on conflict (key) do nothing;

-- The month someone was born, given once (year * 12 + month - 1). The app can't change it.
alter table public.profiles add column if not exists born int check (born between 1900 * 12 and 2200 * 12);

-- Who reviews posts. Add someone after they've signed in on the site:
--   insert into public.moderators (user_id) select id from auth.users where email = 'their@email.com';
create table if not exists public.moderators (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- People who can't post or comment. until = null means until a moderator deletes the row.
create table if not exists public.bans (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  until      timestamptz,
  reason     text,
  by_user    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  body        text not null check (char_length(body) between 4 and 200),
  color       smallint not null default 0 check (color between 0 and 31),
  scope       text not null check (scope in ('world', 'country', 'state', 'city', 'friends')),
  country     text not null default 'XX' check (country ~ '^[A-Z]{2}$'),
  state       text check (state is null or char_length(state) between 1 and 40),
  city        text check (city is null or char_length(city) between 1 and 40),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'removed')),
  reason      text,                    -- why a moderator turned it down, shown to the author
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  kept_at     timestamptz              -- a moderator read its reports and kept it
);
create index if not exists posts_by_status on public.posts (status, created_at);
-- A post's own two answers, like "Lamborghini" and "Ferrari". Both empty means Yes and No.
alter table public.posts add column if not exists opt_a text check (opt_a is null or char_length(opt_a) between 1 and 30);
alter table public.posts add column if not exists opt_b text check (opt_b is null or char_length(opt_b) between 1 and 30);
create index if not exists posts_by_user   on public.posts (user_id, created_at);

-- One judgment per person per post: 1 = yes (or "this one"), -1 = no.
create table if not exists public.post_votes (
  post_id    bigint   not null references public.posts (id) on delete cascade,
  user_id    uuid     not null references auth.users (id) on delete cascade,
  v          smallint not null check (v in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  post_id     bigint not null references public.posts (id) on delete cascade,
  user_id     uuid   not null references auth.users (id) on delete cascade,
  body        text   not null check (char_length(body) between 2 and 200),
  side        smallint check (side in (0, 1)),   -- the side the writer judged: 0 yes, 1 no
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'removed')),
  reason      text,
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  kept_at     timestamptz
);
create index if not exists comments_by_post   on public.comments (post_id, created_at);
create index if not exists comments_by_status on public.comments (status, created_at);
create index if not exists comments_by_user   on public.comments (user_id, created_at);

create table if not exists public.reports (
  kind       text   not null check (kind in ('post', 'comment')),
  item_id    bigint not null,
  user_id    uuid   not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (kind, item_id, user_id)
);
create index if not exists reports_by_user on public.reports (user_id, created_at);

-- Locked like the rest: RLS on, no policies, no privileges for the browser roles.
alter table public.moderators enable row level security;
alter table public.bans       enable row level security;
alter table public.posts      enable row level security;
alter table public.post_votes enable row level security;
alter table public.comments   enable row level security;
alter table public.reports    enable row level security;
revoke all on public.moderators, public.bans, public.posts, public.post_votes, public.comments, public.reports
  from public, anon, authenticated;
revoke all on sequence public.posts_id_seq, public.comments_id_seq from public, anon, authenticated;

-- ---------- Posting: private helpers ----------

create or replace function verd_private.is_mod(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.moderators m where m.user_id = uid)
$$;

create or replace function verd_private.banned(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.bans b where b.user_id = uid and (b.until is null or b.until > now()))
$$;

-- Signed in with a real account, not an anonymous session.
create or replace function verd_private.real(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u where u.id = uid and u.is_anonymous is false)
$$;

-- 13 or older: more than 156 whole months since the month given, the same rule as the app.
create or replace function verd_private.age_ok(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (extract(year from now() at time zone 'utc') * 12
                           + extract(month from now() at time zone 'utc') - 1)::int - p.born > 13 * 12
                     from public.profiles p where p.id = uid), false)
$$;

-- Open once someone can review, and not paused.
create or replace function verd_private.posting_open() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(verd_private.cfg('posting_paused'), 1) = 0 and exists (select 1 from public.moderators)
$$;

-- Why this person can't post or comment right now, or null when they can.
create or replace function verd_private.cannot_write(uid uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if uid is null then return 'sign in first'; end if;
  if not verd_private.posting_open() then return 'posting is closed'; end if;
  if not verd_private.real(uid) then return 'sign in to post'; end if;
  if (select p.born from public.profiles p where p.id = uid) is null then return 'age needed'; end if;
  if not verd_private.age_ok(uid) then return 'posting is for 13 and older'; end if;
  if verd_private.banned(uid) then return 'posting is blocked for you'; end if;
  return null;
end $$;

-- Mutual friends: each added the other's code.
create or replace function verd_private.mutual(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and exists (
    select 1 from public.profiles pa, public.profiles pb
     where pa.id = a and pb.id = b
       and exists (select 1 from public.friend_adds f where f.user_id = a and f.code = pb.code)
       and exists (select 1 from public.friend_adds f where f.user_id = b and f.code = pa.code))
$$;

-- Hidden for everyone: enough reports since a moderator last kept it.
create or replace function verd_private.hidden(k text, item bigint, kept timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.reports r
           where r.kind = k and r.item_id = item and (kept is null or r.created_at > kept))
         >= verd_private.cfg('hide_at_reports')
$$;

-- May this viewer see this post in their feed? Approved, for their place or a mutual friend, not hidden,
-- not reported by them, and its writer isn't blocked.
create or replace function verd_private.sees(p public.posts, uid uuid, k_cc text, k_st text, k_ci text) returns boolean
language sql stable security definer set search_path = public as $$
  select p.status = 'approved'
     and not verd_private.hidden('post', p.id, p.kept_at)
     and not verd_private.banned(p.user_id)
     and not exists (select 1 from public.reports r where r.kind = 'post' and r.item_id = p.id and r.user_id = uid)
     and case p.scope
           when 'world'   then true
           when 'country' then p.country = k_cc
           when 'state'   then p.country = k_cc and p.state = k_st
           when 'city'    then p.country = k_cc and p.state = k_st and p.city = k_ci
           when 'friends' then verd_private.mutual(p.user_id, uid)
           else false
         end
$$;

-- What moderators see about a writer: how much of theirs was approved and turned down. Never who they are.
create or replace function verd_private.track(u uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'approved', (select count(*) from public.posts p where p.user_id = u and p.status = 'approved')
              + (select count(*) from public.comments c where c.user_id = u and c.status = 'approved'),
    'turned_down', (select count(*) from public.posts p where p.user_id = u and p.status in ('rejected', 'removed'))
                 + (select count(*) from public.comments c where c.user_id = u and c.status in ('rejected', 'removed')))
$$;

create or replace function verd_private.ms(t timestamptz) returns bigint
language sql stable as $$ select (extract(epoch from t) * 1000)::bigint $$;

-- New posts and comments wait for a moderator, unless the owner set app_config auto_approve to 1.
create or replace function verd_private.review_first() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(verd_private.cfg('auto_approve'), 0) <> 1
$$;

revoke all on all functions in schema verd_private from public, anon, authenticated;

-- ---------- Posting: the API ----------

-- Your month and year of birth, once. It can't be changed from the app afterwards.
create or replace function public.set_birth(y int, m int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  b     int := y * 12 + m - 1;
  now_m int := (extract(year from now() at time zone 'utc') * 12 + extract(month from now() at time zone 'utc') - 1)::int;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if y is null or m is null or m < 1 or m > 12 or y < 1900 or b > now_m then
    raise exception 'bad date' using errcode = '22023';
  end if;
  perform verd_private.ensure_profile(uid);
  update public.profiles set born = b where id = uid and born is null;
  return jsonb_build_object('age_ok', verd_private.age_ok(uid));
end $$;

-- The feed's posts for this viewer and place: approved ones they may see, plus their own, from the last
-- 14 days, newest first. The split comes back only for your own posts and ones you've judged; before that,
-- only how many judged and whether it's close. Comments: approved ones, plus your own.
create or replace function public.get_posts(cc text default null, st text default null, ci text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  k_cc text := verd_private.country(cc);
  k_st text := verd_private.place(st);
  k_ci text := verd_private.place(ci);
  list jsonb;
begin
  with shown as (
    select p.* from public.posts p
     where p.created_at > now() - interval '14 days'
       and (p.user_id = uid or verd_private.sees(p, uid, k_cc, k_st, k_ci))
     order by p.created_at desc
     limit 60
  ), tally as (
    select s.id,
           count(pv.v) filter (where pv.v = 1)::int  as yes,
           count(pv.v) filter (where pv.v = -1)::int as no,
           (select x.v from public.post_votes x where x.post_id = s.id and x.user_id = uid) as mine
      from shown s left join public.post_votes pv on pv.post_id = s.id
     group by s.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'body', s.body, 'color', s.color, 'scope', s.scope, 'country', s.country, 'a', s.opt_a, 'b', s.opt_b,
           't', verd_private.ms(s.created_at),
           'mine', s.user_id is not distinct from uid,
           'status', case when s.user_id = uid then s.status end,
           'reason', case when s.user_id = uid then s.reason end,
           'code', case when s.scope = 'friends' and s.user_id is distinct from uid
                        then (select pr.code from public.profiles pr where pr.id = s.user_id) end,
           'my_vote', t.mine,
           'total', t.yes + t.no,
           'yes', case when s.user_id = uid or t.mine is not null then t.yes end,
           'no',  case when s.user_id = uid or t.mine is not null then t.no end,
           'close', t.yes + t.no >= 4 and abs(t.yes * 100.0 / nullif(t.yes + t.no, 0) - 50) <= 10,
           'comments', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'id', c.id, 'body', c.body, 'side', c.side, 't', verd_private.ms(c.created_at),
                      'mine', c.user_id is not distinct from uid,
                      'status', case when c.user_id = uid then c.status end,
                      'code', case when c.user_id is distinct from uid and verd_private.mutual(c.user_id, uid)
                                   then (select pr.code from public.profiles pr where pr.id = c.user_id) end)
                    order by c.created_at), '[]'::jsonb)
               from public.comments c
              where c.post_id = s.id
                and (c.user_id = uid
                     or (c.status = 'approved'
                         and not verd_private.hidden('comment', c.id, c.kept_at)
                         and not verd_private.banned(c.user_id)
                         and not exists (select 1 from public.reports r
                                          where r.kind = 'comment' and r.item_id = c.id and r.user_id = uid))))
         ) order by s.created_at desc), '[]'::jsonb)
    into list
    from shown s join tally t on t.id = s.id;
  return jsonb_build_object('open', verd_private.posting_open(), 'review_first', verd_private.review_first(), 'posts', list);
end $$;

-- Judge a post: yes = true or false. Once per post, never your own, only posts you can see.
create or replace function public.judge_post(pid bigint, yes boolean, cc text default null, st text default null, ci text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  p    public.posts;
  n_yes int;
  n_no  int;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if yes is null then
    raise exception 'bad answer' using errcode = '22023';
  end if;
  select * into p from public.posts x where x.id = pid;
  if not found or not verd_private.sees(p, uid, verd_private.country(cc), verd_private.place(st), verd_private.place(ci)) then
    raise exception 'no such post' using errcode = '22023';
  end if;
  if p.user_id = uid then
    raise exception 'not on your own post' using errcode = '22023';
  end if;
  insert into public.post_votes (post_id, user_id, v) values (pid, uid, case when yes then 1 else -1 end)
  on conflict (post_id, user_id) do nothing;
  select count(*) filter (where x.v = 1)::int, count(*) filter (where x.v = -1)::int
    into n_yes, n_no from public.post_votes x where x.post_id = pid;
  return jsonb_build_object('yes', n_yes, 'no', n_no,
    'my_vote', (select x.v from public.post_votes x where x.post_id = pid and x.user_id = uid));
end $$;

-- Write a post. It waits for a moderator (or goes live at once with auto_approve). A few a day, a couple of
-- minutes apart, blocked words refused.
-- The version before custom answers had six arguments. Two versions side by side would confuse the API.
drop function if exists public.create_post(text, smallint, text, text, text, text);
create or replace function public.create_post(body text, color smallint, scope text, cc text default 'XX', st text default null, ci text default null,
                                              opt_a text default null, opt_b text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid    uuid := auth.uid();
  why    text := verd_private.cannot_write(auth.uid());
  clean  text := btrim(regexp_replace(coalesce(body, ''), '\s+', ' ', 'g'));
  a      text := nullif(btrim(regexp_replace(coalesce(opt_a, ''), '\s+', ' ', 'g')), '');
  b      text := nullif(btrim(regexp_replace(coalesce(opt_b, ''), '\s+', ' ', 'g')), '');
  k_cc   text := verd_private.country(cc);
  k_st   text := verd_private.place(st);
  k_ci   text := verd_private.place(ci);
  n      int;
  prev   timestamptz;
  new_id bigint;
  now_is text;
begin
  if why is not null then
    raise exception '%', why using errcode = '42501';
  end if;
  if char_length(clean) < 4 or char_length(clean) > 200 then
    raise exception 'posts are 4 to 200 characters' using errcode = '22023';
  end if;
  if scope is null or scope not in ('world', 'country', 'state', 'city', 'friends') then
    raise exception 'bad audience' using errcode = '22023';
  end if;
  if (scope in ('country', 'state', 'city') and k_cc = 'XX') or (scope in ('state', 'city') and k_st is null)
     or (scope = 'city' and k_ci is null) then
    raise exception 'set your place first' using errcode = '22023';
  end if;
  if (a is null) <> (b is null) or lower(a) = lower(b) then
    raise exception 'give two different answers' using errcode = '22023';
  end if;
  if char_length(a) > 30 or char_length(b) > 30 then
    raise exception 'answers are 1 to 30 characters' using errcode = '22023';
  end if;
  if verd_private.blocked(clean) or verd_private.blocked(a) or verd_private.blocked(b) then
    raise exception 'blocked words' using errcode = '22023';
  end if;
  select count(*), max(x.created_at) into n, prev
    from public.posts x where x.user_id = uid and x.created_at > now() - interval '1 day';
  if n >= verd_private.cfg('posts_per_day') then
    raise exception 'that is enough posts for today' using errcode = '22023';
  end if;
  if prev > now() - make_interval(secs => verd_private.cfg('post_gap_seconds')) then
    raise exception 'wait a moment' using errcode = '22023';
  end if;
  insert into public.posts (user_id, body, color, scope, country, state, city, status, opt_a, opt_b)
  values (uid, clean, greatest(0, least(31, coalesce(color, 0))), scope, k_cc,
          case when scope in ('state', 'city') then k_st end, case when scope = 'city' then k_ci end,
          case when verd_private.review_first() then 'pending' else 'approved' end, a, b)
  returning id, status into new_id, now_is;
  return jsonb_build_object('id', new_id, 'status', now_is);
end $$;

-- Comment on a post you've judged (or your own). It waits for a moderator too (or goes live with auto_approve).
create or replace function public.create_comment(pid bigint, body text, cc text default null, st text default null, ci text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid    uuid := auth.uid();
  why    text := verd_private.cannot_write(auth.uid());
  clean  text := btrim(regexp_replace(coalesce(body, ''), '\s+', ' ', 'g'));
  p      public.posts;
  mine   smallint;
  n      int;
  prev   timestamptz;
  new_id bigint;
  now_is text;
begin
  if why is not null then
    raise exception '%', why using errcode = '42501';
  end if;
  select * into p from public.posts x where x.id = pid;
  if not found or p.status <> 'approved'
     or (p.user_id <> uid and not verd_private.sees(p, uid, verd_private.country(cc), verd_private.place(st), verd_private.place(ci))) then
    raise exception 'no such post' using errcode = '22023';
  end if;
  select x.v into mine from public.post_votes x where x.post_id = pid and x.user_id = uid;
  if mine is null and p.user_id <> uid then
    raise exception 'judge it first' using errcode = '22023';
  end if;
  if char_length(clean) < 2 or char_length(clean) > 200 then
    raise exception 'comments are 2 to 200 characters' using errcode = '22023';
  end if;
  if verd_private.blocked(clean) then
    raise exception 'blocked words' using errcode = '22023';
  end if;
  select count(*), max(x.created_at) into n, prev
    from public.comments x where x.user_id = uid and x.created_at > now() - interval '1 day';
  if n >= verd_private.cfg('comments_per_day') then
    raise exception 'that is enough comments for today' using errcode = '22023';
  end if;
  if prev > now() - make_interval(secs => verd_private.cfg('comment_gap_seconds')) then
    raise exception 'wait a moment' using errcode = '22023';
  end if;
  insert into public.comments (post_id, user_id, body, side, status)
  values (pid, uid, clean, case mine when 1 then 0 when -1 then 1 end,
          case when verd_private.review_first() then 'pending' else 'approved' end)
  returning id, status into new_id, now_is;
  return jsonb_build_object('id', new_id, 'status', now_is);
end $$;

-- Report a post or comment you can see. Anyone with a session; enough reports hide it for everyone.
create or replace function public.report_item(what text, iid bigint, cc text default null, st text default null, ci text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  p    public.posts;
  cm   public.comments;
  n    int;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if what = 'comment' then
    select * into cm from public.comments x where x.id = iid;
    if not found or cm.user_id = uid or cm.status <> 'approved' then
      raise exception 'no such comment' using errcode = '22023';
    end if;
    select * into p from public.posts x where x.id = cm.post_id;
    if not found or (p.user_id <> uid and not verd_private.sees(p, uid, verd_private.country(cc), verd_private.place(st), verd_private.place(ci))) then
      raise exception 'no such comment' using errcode = '22023';
    end if;
  elsif what = 'post' then
    select * into p from public.posts x where x.id = iid;
    if not found or p.user_id = uid or not verd_private.sees(p, uid, verd_private.country(cc), verd_private.place(st), verd_private.place(ci)) then
      raise exception 'no such post' using errcode = '22023';
    end if;
  else
    raise exception 'bad kind' using errcode = '22023';
  end if;
  select count(*) into n from public.reports x where x.user_id = uid and x.created_at > now() - interval '1 day';
  if n >= verd_private.cfg('reports_per_day') then
    raise exception 'that is enough reports for today' using errcode = '22023';
  end if;
  insert into public.reports (kind, item_id, user_id) values (what, iid, uid) on conflict do nothing;
  return 'reported';
end $$;

-- Delete your own post (with its judgments and comments) or comment.
create or replace function public.delete_mine(what text, iid bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  k   int;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if what = 'post' then
    delete from public.posts x where x.id = iid and x.user_id = uid;
  elsif what = 'comment' then
    delete from public.comments x where x.id = iid and x.user_id = uid;
  else
    raise exception 'bad kind' using errcode = '22023';
  end if;
  get diagnostics k = row_count;
  if k = 0 then
    raise exception 'no such item' using errcode = '22023';
  end if;
  delete from public.reports r where r.kind = what and r.item_id = iid;
  delete from public.reports r where r.kind = 'comment' and not exists (select 1 from public.comments x where x.id = r.item_id);
  return 'deleted';
end $$;

-- Moderators only: what waits for review (oldest first), and approved things that were reported.
create or replace function public.review_queue()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if not verd_private.is_mod(uid) then
    raise exception 'moderators only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'waiting', (select coalesce(jsonb_agg(jsonb_build_object('kind', q.kind, 'id', q.id, 'body', q.body, 'on', q.on_post,
                                          'scope', q.scope, 't', verd_private.ms(q.t), 'writer', verd_private.track(q.user_id))
                                        order by q.t), '[]'::jsonb)
                  from (select 'post' as kind, p.id, p.body, null::text as on_post, p.scope, p.created_at as t, p.user_id
                          from public.posts p where p.status = 'pending' and not verd_private.banned(p.user_id)
                        union all
                        select 'comment', c.id, c.body, p.body, p.scope, c.created_at, c.user_id
                          from public.comments c join public.posts p on p.id = c.post_id
                         where c.status = 'pending' and not verd_private.banned(c.user_id)) q),
    'reported', (select coalesce(jsonb_agg(jsonb_build_object('kind', q.kind, 'id', q.id, 'body', q.body, 'on', q.on_post,
                                           'reports', q.n, 'hidden', q.n >= verd_private.cfg('hide_at_reports'),
                                           'writer', verd_private.track(q.user_id))
                                         order by q.n desc, q.id), '[]'::jsonb)
                   from (select 'post' as kind, p.id, p.body, null::text as on_post, p.user_id,
                                (select count(*) from public.reports r where r.kind = 'post' and r.item_id = p.id
                                    and (p.kept_at is null or r.created_at > p.kept_at))::int as n
                           from public.posts p where p.status = 'approved'
                         union all
                         select 'comment', c.id, c.body, p.body, c.user_id,
                                (select count(*) from public.reports r where r.kind = 'comment' and r.item_id = c.id
                                    and (c.kept_at is null or r.created_at > c.kept_at))::int
                           from public.comments c join public.posts p on p.id = c.post_id where c.status = 'approved') q
                  where q.n > 0),
    'review_first', verd_private.review_first());
end $$;

-- Moderators only: approve or reject what's waiting, keep or remove what was reported.
-- why is shown to the writer when something is turned down.
create or replace function public.review_item(what text, iid bigint, decision text, why text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  k   int;
  r   text := nullif(left(btrim(coalesce(why, '')), 80), '');
begin
  if not verd_private.is_mod(uid) then
    raise exception 'moderators only' using errcode = '42501';
  end if;
  if decision is null or decision not in ('approve', 'reject', 'keep', 'remove') then
    raise exception 'bad decision' using errcode = '22023';
  end if;
  if what = 'post' then
    update public.posts x set
      status = case decision when 'approve' then 'approved' when 'reject' then 'rejected' when 'remove' then 'removed' else x.status end,
      reason = case when decision in ('reject', 'remove') then r else x.reason end,
      kept_at = case when decision = 'keep' then now() else x.kept_at end,
      reviewed_at = now(), reviewed_by = uid
     where x.id = iid
       and ((decision in ('approve', 'reject') and x.status = 'pending') or (decision in ('keep', 'remove') and x.status = 'approved'));
  elsif what = 'comment' then
    update public.comments x set
      status = case decision when 'approve' then 'approved' when 'reject' then 'rejected' when 'remove' then 'removed' else x.status end,
      reason = case when decision in ('reject', 'remove') then r else x.reason end,
      kept_at = case when decision = 'keep' then now() else x.kept_at end,
      reviewed_at = now(), reviewed_by = uid
     where x.id = iid
       and ((decision in ('approve', 'reject') and x.status = 'pending') or (decision in ('keep', 'remove') and x.status = 'approved'));
  else
    raise exception 'bad kind' using errcode = '22023';
  end if;
  get diagnostics k = row_count;
  if k = 0 then
    raise exception 'already decided' using errcode = '22023';
  end if;
  return decision;
end $$;

-- Moderators only: stop the writer of a post or comment from posting, for some days or until lifted.
-- Everything of theirs still waiting is turned down, and their posts and comments stop showing.
create or replace function public.ban_author(what text, iid bigint, for_days int default null, why text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid    uuid := auth.uid();
  writer uuid;
  r      text := nullif(left(btrim(coalesce(why, '')), 80), '');
begin
  if not verd_private.is_mod(uid) then
    raise exception 'moderators only' using errcode = '42501';
  end if;
  if what = 'post' then
    select x.user_id into writer from public.posts x where x.id = iid;
  elsif what = 'comment' then
    select x.user_id into writer from public.comments x where x.id = iid;
  end if;
  if writer is null then
    raise exception 'no such item' using errcode = '22023';
  end if;
  if verd_private.is_mod(writer) then
    raise exception 'moderators cannot be blocked here' using errcode = '22023';
  end if;
  insert into public.bans (user_id, until, reason, by_user)
  values (writer, case when for_days > 0 then now() + make_interval(days => for_days) end, r, uid)
  on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, by_user = excluded.by_user, created_at = now();
  update public.posts x set status = 'rejected', reason = coalesce(r, 'Blocked by a moderator'), reviewed_at = now(), reviewed_by = uid
   where x.user_id = writer and x.status = 'pending';
  update public.comments x set status = 'rejected', reason = coalesce(r, 'Blocked by a moderator'), reviewed_at = now(), reviewed_by = uid
   where x.user_id = writer and x.status = 'pending';
  return 'blocked';
end $$;

-- Who may call what. Results and boards are open (they are totals with minimums);
-- everything that writes or is about you needs a session (anonymous counts).
revoke all on function public.get_results(date, smallint, text, text, text) from public;
revoke all on function public.cast_vote(date, smallint, smallint, text, text, text) from public;
revoke all on function public.my_profile() from public;
revoke all on function public.import_votes(jsonb) from public;
revoke all on function public.friend_match(text[]) from public;
revoke all on function public.set_friends(text[]) from public;
revoke all on function public.friend_requests() from public;
revoke all on function public.get_board(date, smallint, text, text) from public;
revoke all on function public.suggest_question(text, text[]) from public;
revoke all on function public.cast_vote(date, smallint, smallint, text, text, text) from anon;
revoke all on function public.my_profile() from anon;
revoke all on function public.import_votes(jsonb) from anon;
revoke all on function public.friend_match(text[]) from anon;
revoke all on function public.set_friends(text[]) from anon;
revoke all on function public.friend_requests() from anon;
revoke all on function public.suggest_question(text, text[]) from anon;
grant execute on function public.get_results(date, smallint, text, text, text) to anon, authenticated;
grant execute on function public.get_board(date, smallint, text, text) to anon, authenticated;
grant execute on function public.cast_vote(date, smallint, smallint, text, text, text) to authenticated;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.import_votes(jsonb) to authenticated;
grant execute on function public.friend_match(text[]) to authenticated;
grant execute on function public.set_friends(text[]) to authenticated;
grant execute on function public.friend_requests() to authenticated;
grant execute on function public.suggest_question(text, text[]) to authenticated;

-- Posting: the feed is open (approved posts only). Everything else needs a session, and each function
-- checks the rest itself: a real account, age, blocks, moderators.
revoke all on function public.get_posts(text, text, text) from public;
revoke all on function public.set_birth(int, int) from public, anon;
revoke all on function public.judge_post(bigint, boolean, text, text, text) from public, anon;
revoke all on function public.create_post(text, smallint, text, text, text, text, text, text) from public, anon;
revoke all on function public.create_comment(bigint, text, text, text, text) from public, anon;
revoke all on function public.report_item(text, bigint, text, text, text) from public, anon;
revoke all on function public.delete_mine(text, bigint) from public, anon;
revoke all on function public.review_queue() from public, anon;
revoke all on function public.review_item(text, bigint, text, text) from public, anon;
revoke all on function public.ban_author(text, bigint, int, text) from public, anon;
grant execute on function public.get_posts(text, text, text) to anon, authenticated;
grant execute on function public.set_birth(int, int) to authenticated;
grant execute on function public.judge_post(bigint, boolean, text, text, text) to authenticated;
grant execute on function public.create_post(text, smallint, text, text, text, text, text, text) to authenticated;
grant execute on function public.create_comment(bigint, text, text, text, text) to authenticated;
grant execute on function public.report_item(text, bigint, text, text, text) to authenticated;
grant execute on function public.delete_mine(text, bigint) to authenticated;
grant execute on function public.review_queue() to authenticated;
grant execute on function public.review_item(text, bigint, text, text) to authenticated;
grant execute on function public.ban_author(text, bigint, int, text) to authenticated;

-- With auto_approve on, nothing should still be waiting from before it was switched on: let those go live too,
-- unless they hold something on the blocked list (slurs included), which are turned down.
do $$ begin
  if not verd_private.review_first() then
    update public.posts set status = case when verd_private.blocked(body) then 'rejected' else 'approved' end,
      reason = case when verd_private.blocked(body) then 'Mean or unsafe' end, reviewed_at = now() where status = 'pending';
    update public.comments set status = case when verd_private.blocked(body) then 'rejected' else 'approved' end,
      reason = case when verd_private.blocked(body) then 'Mean or unsafe' end, reviewed_at = now() where status = 'pending';
  end if;
  -- Anything already up that the list now catches (the slurs added on 2026-11-20) comes down.
  update public.posts set status = 'removed', reason = 'Mean or unsafe', reviewed_at = now() where status = 'approved' and verd_private.blocked(body);
  update public.comments set status = 'removed', reason = 'Mean or unsafe', reviewed_at = now() where status = 'approved' and verd_private.blocked(body);
end $$;

-- ---------- Done ----------
-- Tells the API about these functions straight away, then says which version just ran: the SQL Editor shows this
-- line as the result. "Success. No rows returned" instead means an older copy of this file ran.
notify pgrst, 'reload schema';
select 'Verd is set up, with posting (setup.sql of 2026-11-20, with the stronger slur filter, custom answers and friend requests). New posts '
       || case when verd_private.review_first() then 'wait for review.' else 'go live at once.' end as result;
