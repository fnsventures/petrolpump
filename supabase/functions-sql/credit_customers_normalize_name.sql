-- Canonical definition of public.credit_customers_normalize_name. Edit here, then:
--   node scripts/sql-functions.mjs emit credit_customers_normalize_name
create or replace function public.credit_customers_normalize_name()
returns trigger
language plpgsql
as $$
begin
  new.customer_name := btrim(regexp_replace(new.customer_name, '\s+', ' ', 'g'));
  return new;
end;
$$;

comment on function public.credit_customers_normalize_name() is
  'Trigger: store credit_customers.customer_name trimmed with inner whitespace collapsed to one space.';

revoke all on function public.credit_customers_normalize_name() from public, anon;
