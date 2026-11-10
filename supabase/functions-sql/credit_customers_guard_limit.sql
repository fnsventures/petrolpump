-- Canonical definition of public.credit_customers_guard_limit. Edit here, then:
--   node scripts/sql-functions.mjs emit credit_customers_guard_limit
create or replace function public.credit_customers_guard_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.credit_limit is distinct from old.credit_limit
     and not public.is_admin()
     and coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'Only an admin can change the credit limit.';
  end if;
  return new;
end;
$$;

revoke all on function public.credit_customers_guard_limit() from public, anon;

grant execute on function public.credit_customers_guard_limit() to authenticated;
