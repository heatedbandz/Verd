-- Verd: paste this whole file into Supabase > SQL Editor > New query, then press Run.
create table if not exists votes (
  day      text not null,
  voter    text not null,
  choice   smallint not null check (choice between 0 and 3),
  country  text not null check (char_length(country) = 2),
  created_at timestamptz not null default now(),
  primary key (day, voter)
);
alter table votes enable row level security;
-- Anyone can add one answer per day. Nobody can read raw rows, change or delete them from the app.
create policy "anyone can vote" on votes for insert to anon with check (true);

-- Totals per answer and country, which is all the app ever reads.
create or replace function tally(d text)
returns table(choice smallint, country text, n bigint)
language sql security definer set search_path = public as $$
  select choice, country, count(*) from votes where day = d group by choice, country;
$$;
grant execute on function tally(text) to anon;

-- Question ideas from players. Only you can read them (in the Supabase Table Editor).
create table if not exists suggestions (
  id bigint generated always as identity primary key,
  question text not null check (char_length(question) between 5 and 140),
  answers  text[] not null check (array_length(answers, 1) between 2 and 4),
  voter    text,
  created_at timestamptz not null default now()
);
alter table suggestions enable row level security;
create policy "anyone can suggest" on suggestions for insert to anon with check (true);

-- Friend match: friends' answers (only by their 6-letter code, never names).
alter table votes add column if not exists code text;
create index if not exists votes_code on votes(code);
create or replace function friend_votes(codes text[])
returns table(code text, day text, choice smallint)
language sql security definer set search_path = public as $$
  select code, day, choice from votes where code = any(codes[1:50]);
$$;
grant execute on function friend_votes(text[]) to anon;
