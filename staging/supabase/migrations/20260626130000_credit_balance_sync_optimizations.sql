-- Keep prepaid_balance in sync via entry trigger; reduce queries in sync_credit_customer_balances.

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
  where credit_customer_id = p_credit_customer_id;

  select coalesce(sum(amount), 0) into v_payment_total
  from public.credit_payments
  where credit_customer_id = p_credit_customer_id;

  v_prepaid := greatest(0, v_payment_total - v_settled_total);

  update public.credit_customers
  set amount_due = v_new_due, prepaid_balance = v_prepaid
  where id = p_credit_customer_id;
end;
$$;

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
