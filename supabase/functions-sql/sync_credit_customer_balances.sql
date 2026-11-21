-- Canonical definition of public.sync_credit_customer_balances. Edit here, then:
--   node scripts/sql-functions.mjs emit sync_credit_customer_balances
create or replace function public.sync_credit_customer_balances(p_credit_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_due numeric;
  v_prepaid numeric;
  v_payment_total numeric;
  v_settled_total numeric;
begin
  select
    coalesce(sum(amount - amount_settled), 0),
    coalesce(sum(amount_settled), 0)
  into v_new_due, v_settled_total
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  select coalesce(sum(amount), 0) into v_payment_total
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id
    and status = 'posted';

  v_prepaid := greatest(0, v_payment_total - v_settled_total);

  update public.credit_customers
  set amount_due = v_new_due, prepaid_balance = v_prepaid
  where id = p_credit_customer_id;
end;
$$;

comment on function public.sync_credit_customer_balances(uuid) is
  'Sync amount_due and prepaid_balance from credit_entries and credit_payments.';

revoke all on function public.sync_credit_customer_balances(uuid) from public;

revoke all on function public.sync_credit_customer_balances(uuid) from authenticated;
