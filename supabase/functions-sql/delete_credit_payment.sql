-- Canonical definition of public.delete_credit_payment. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_credit_payment
create or replace function public.delete_credit_payment(p_payment_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment record;
  v_new_due numeric;
  v_prepaid numeric;
  v_last_payment date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit settlements';
  end if;

  select * into v_payment
  from public.credit_payments
  where id = p_payment_id;

  if not found then
    raise exception 'Settlement record not found';
  end if;

  if v_payment.status is distinct from 'cancelled' then
    perform public.raise_if_day_closing_certified(v_payment.date);
  end if;

  perform 1
  from public.credit_customers
  where id = v_payment.credit_customer_id
  for update;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  delete from public.credit_payments
  where id = p_payment_id;

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  if v_payment.status is distinct from 'cancelled' then
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);

    select max(date) into v_last_payment
    from public.credit_payments
    where credit_customer_id = v_payment.credit_customer_id
      and status = 'posted';

    update public.credit_customers
    set last_payment = v_last_payment
    where id = v_payment.credit_customer_id;

    perform public.apply_credit_payment_to_day_closing(
      v_payment.date,
      coalesce(v_payment.same_day_settlement, false),
      coalesce(v_payment.payment_mode, 'Cash'),
      -v_payment.amount
    );
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_payment.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'deleted', true,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

comment on function public.delete_credit_payment(uuid) is
  'Admin-only: delete a credit settlement and re-allocate remaining payments FIFO. The row is removed.';

grant execute on function public.delete_credit_payment(uuid) to authenticated;
