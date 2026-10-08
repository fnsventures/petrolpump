-- Staging only. Turns audit off and empties audit_log.
-- Production has no runtime_flags row, so logging stays on there.

do $$
begin
  if to_regclass('public.runtime_flags') is null then
    raise exception 'Apply migration 20261008150000_audit_log_retention on staging first';
  end if;
end $$;

insert into public.runtime_flags (key, value)
values ('audit', 'off')
on conflict (key) do update set value = excluded.value;

truncate table public.audit_log;
