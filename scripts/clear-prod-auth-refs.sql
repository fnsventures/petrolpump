-- After a prod → staging load. Staging keeps its own logins, so prod's
-- auth.users ids in created_by, certified_by, … point at nobody. Set them null.
-- Run against the STAGING database only. Safe to re-run.

begin;

-- Skip audit and certified-day triggers; this is a load fix-up, not an edit.
set session_replication_role = replica;

do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'auth.users'::regclass
      and c.connamespace = 'public'::regnamespace
      and array_length(c.conkey, 1) = 1
  loop
    execute format(
      'update %s t set %I = null where t.%I is not null and not exists (select 1 from auth.users a where a.id = t.%I)',
      r.tbl, r.col, r.col, r.col
    );
  end loop;
end
$$;

set session_replication_role = default;

commit;
