-- Just enough of Supabase for tests/db.test.mjs to run setup.sql on a plain local Postgres:
-- the anon/authenticated roles, auth.users, auth.uid() (same definition Supabase uses) and
-- Supabase's default grants (every new table and function granted to the browser roles,
-- so setup.sql has to lock things down itself, exactly like on the real thing).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, is_anonymous boolean not null default true);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
