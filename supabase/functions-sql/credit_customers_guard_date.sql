-- Canonical definition of public.credit_customers_guard_date. Edit here, then:
--   node scripts/sql-functions.mjs emit credit_customers_guard_date
create or replace function public.credit_customers_guard_date()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.date is distinct from new.date then
    raise exception 'Customer date is fixed. Opening balances are recorded as credit entries.';
  end if;
  return new;
end;
$$;
