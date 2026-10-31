-- Clears staging app data before importing a prod snapshot.
-- Keeps staging's own logins (auth.users, auth.identities) and app users (public.users).
-- Run against the STAGING database only.
-- Uses session_replication_role so FK order and audit triggers do not block the load.

begin;

set session_replication_role = replica;

-- Every public table except users, so a table added later is cleared too.
do $$
declare
  v_tables text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  into v_tables
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relispartition
    and c.relname <> 'users';

  execute 'truncate table ' || v_tables || ' restart identity cascade';
end
$$;

truncate table storage.objects cascade;
truncate table storage.buckets cascade;

drop table if exists public._dsr_import;

set session_replication_role = default;

commit;
