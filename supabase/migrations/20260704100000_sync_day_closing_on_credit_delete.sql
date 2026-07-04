-- Keep saved day_closing snapshots in sync when credit settlements or sales are deleted.

create or replace function public.sync_saved_day_closing_for_date(p_date date)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_components jsonb;
  v_short_today numeric;
begin
  select night_cash, phone_pay
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_short_today := (
    coalesce((v_components->>'total_sale')::numeric, 0)
    + coalesce((v_components->>'collection')::numeric, 0)
    + coalesce((v_components->>'short_previous')::numeric, 0)
  ) - (
    coalesce(v_row.night_cash, 0) + coalesce(v_row.phone_pay, 0)
    + coalesce((v_components->>'credit_today')::numeric, 0)
    + coalesce((v_components->>'expenses_today')::numeric, 0)
  );

  update public.day_closing set
    total_sale = coalesce((v_components->>'total_sale')::numeric, 0),
    collection = coalesce((v_components->>'collection')::numeric, 0),
    short_previous = coalesce((v_components->>'short_previous')::numeric, 0),
    credit_today = coalesce((v_components->>'credit_today')::numeric, 0),
    expenses_today = coalesce((v_components->>'expenses_today')::numeric, 0),
    short_today = v_short_today
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.sync_saved_day_closing_for_date(date) is
  'Refresh saved day_closing snapshot from live DSR/credit/expense data and recascade short chain.';

revoke all on function public.sync_saved_day_closing_for_date(date) from public;
revoke all on function public.sync_saved_day_closing_for_date(date) from authenticated;

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

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    delete from public.credit_payments where id = p_payment_id;
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select max(date) into v_last_payment
  from public.credit_payments
  where credit_customer_id = v_payment.credit_customer_id;

  update public.credit_customers
  set last_payment = v_last_payment
  where id = v_payment.credit_customer_id;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_payment.credit_customer_id;

  perform public.sync_saved_day_closing_for_date(v_payment.date);

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;

create or replace function public.delete_credit_entry(p_entry_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_entry record;
  v_new_due numeric;
  v_prepaid numeric;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit entries';
  end if;

  select * into v_entry
  from public.credit_entries
  where id = p_entry_id;

  if not found then
    raise exception 'Credit entry not found';
  end if;

  if coalesce(v_entry.amount_settled, 0) > 0 then
    perform set_config('app.skip_credit_sync', 'true', true);
    begin
      delete from public.credit_entries where id = p_entry_id;
      perform public.reallocate_credit_settlements(v_entry.credit_customer_id);
    exception
      when others then
        perform set_config('app.skip_credit_sync', '', true);
        raise;
    end;
    perform set_config('app.skip_credit_sync', '', true);
  else
    delete from public.credit_entries where id = p_entry_id;
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = v_entry.credit_customer_id;

  perform public.sync_saved_day_closing_for_date(v_entry.transaction_date);

  return jsonb_build_object(
    'credit_customer_id', v_entry.credit_customer_id,
    'amount', v_entry.amount,
    'transaction_date', v_entry.transaction_date,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid
  );
end;
$$;
