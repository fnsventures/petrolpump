-- Canonical definition of public.credit_settle_latest_sale. Edit here, then:
--   node scripts/sql-functions.mjs emit credit_settle_latest_sale
create or replace function public.credit_settle_latest_sale(
  p_credit_customer_id uuid,
  p_entry_id uuid,
  p_date date,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_entry date;
  v_max_pay date;
  v_prepaid numeric;
  v_apply numeric;
begin
  select max(transaction_date) into v_max_entry
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id
    and status = 'posted'
    and id <> p_entry_id;

  select max(date) into v_max_pay
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  if p_date < coalesce(v_max_entry, p_date)
     or p_date < coalesce(v_max_pay, p_date) then
    perform public.reallocate_credit_settlements(p_credit_customer_id);
    return;
  end if;

  select prepaid_balance into v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  v_apply := least(greatest(coalesce(v_prepaid, 0), 0), coalesce(p_amount, 0));
  if v_apply > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    perform set_config('app.skip_credit_audit', 'true', true);
    update public.credit_entries
    set amount_settled = v_apply
    where id = p_entry_id;
    perform set_config('app.skip_credit_audit', '', true);
    perform set_config('app.skip_credit_sync', '', true);
  end if;
  perform public.sync_credit_customer_balances(p_credit_customer_id);
end;
$$;

revoke all on function public.credit_settle_latest_sale(uuid, uuid, date, numeric) from public, anon, authenticated;
