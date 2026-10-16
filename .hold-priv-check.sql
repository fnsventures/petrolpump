select 'migration ' || version || ' ' || coalesce(name, '')
from supabase_migrations.schema_migrations
where version >= '20261008'
order by version;

select 'priv anon=' || anon_exec::text || ' auth=' || auth_exec::text || ' n=' || count(*)::text
from (
  select
    has_function_privilege('anon', p.oid, 'execute') as anon_exec,
    has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and d.objid is null
    and p.prorettype <> 'trigger'::regtype
) s
group by anon_exec, auth_exec
order by 1;

select 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') anon=' ||
       has_function_privilege('anon', p.oid, 'execute')::text ||
       ' auth=' || has_function_privilege('authenticated', p.oid, 'execute')::text ||
       ' svc=' || has_function_privilege('service_role', p.oid, 'execute')::text
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'is_admin', 'is_supervisor_or_admin', 'require_staff_access',
    'upsert_staff', 'delete_staff', 'add_credit_entry', 'save_day_closing',
    'list_employees_roster', 'check_page_access'
  )
order by 1;

select 'defacl role=' || a.defaclrole::regrole::text || ' acl=' || coalesce(a.defaclacl::text, '(none)')
from pg_default_acl a
join pg_namespace n on n.oid = a.defaclnamespace
where n.nspname = 'public' and a.defaclobjtype = 'f'
order by 1;
