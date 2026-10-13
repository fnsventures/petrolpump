-- Stop anonymous callers from running app functions.
--
-- Postgres grants EXECUTE on every new function to PUBLIC, and nothing here
-- revoked it, so the anon key (shipped in js/env.js) could call any RPC.
-- Without a login, is_admin() / is_supervisor_or_admin() return null and
-- require_staff_access() returns early, so "if not public.is_admin() then
-- raise" never fired: an anonymous caller could run upsert_staff(email,
-- 'admin'), delete_staff, read employee PII, and write money rows.
--
-- Fix: for every function in public, copy the EXECUTE that authenticated and
-- service_role currently get (directly or through PUBLIC) into explicit grants,
-- then revoke PUBLIC and anon. Logged-in behaviour does not change; functions
-- already revoked from authenticated stay revoked. Trigger functions are
-- skipped (triggers run without an EXECUTE check). Default privileges stop new
-- functions from being granted to PUBLIC/anon again.

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_ok,
           has_function_privilege('service_role', p.oid, 'execute') as svc_ok
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and d.objid is null                       -- not owned by an extension
      and p.prorettype <> 'trigger'::regtype
  loop
    if f.auth_ok then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if f.svc_ok then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end;
$$;

alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
