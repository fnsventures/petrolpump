-- Close EXECUTE for anonymous callers again, and make it stick for new functions.
--
-- 20261013092142 revoked PUBLIC and anon on every function, then set
-- `alter default privileges ... in schema public revoke execute on functions from public`.
-- A schema-level default can only add to the global default, never remove from it, so that
-- line was a no-op: every function created afterwards still got EXECUTE for PUBLIC. Functions
-- dropped and re-created since then were callable with the anon key:
--
--   set_day_closing_certified        anon could certify or revoke any day (is_admin() is null
--                                    without a login, so `if not is_admin()` never raised)
--   check_credit_balances            every customer's stored and book balance
--   get_credit_aging                 customer names and dues
--   get_customer_credit_detail_as_of one customer's ledger
--   get_dashboard_snapshot           sales, credit and expense totals
--   get_invoice_document_category_counts
--
-- Fix: the same revoke loop as 20261013092142, plus the global (not per-schema) default for
-- the role that runs migrations. Logged-in behaviour does not change.
-- supabase/tests/rls.test.sql fails if any public function is executable by anon.

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

-- Global default for functions this role creates (no `in schema`): removes the built-in
-- PUBLIC grant. A new function then needs an explicit grant to authenticated.
alter default privileges for role postgres revoke execute on functions from public;
