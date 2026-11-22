-- Canonical definition of public.credit_entries_sync_amount_due. Edit here, then:
--   node scripts/sql-functions.mjs emit credit_entries_sync_amount_due
create or replace function public.credit_entries_sync_amount_due()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
begin
  if coalesce(current_setting('app.skip_credit_sync', true), '') = 'true' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    v_customer_id := old.credit_customer_id;
  else
    v_customer_id := new.credit_customer_id;
  end if;
  perform public.sync_credit_customer_balances(v_customer_id);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
