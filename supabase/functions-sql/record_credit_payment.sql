-- Canonical definition of public.record_credit_payment. Edit here, then:
--   node scripts/sql-functions.mjs emit record_credit_payment
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false,
  p_request_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_new_due numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'record_credit_payment');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  perform 1
  from public.credit_customers
  where id = p_credit_customer_id
  for update;
  if not found then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_day_closing_refresh', 'true', true);
  perform set_config('app.skip_credit_sync', 'true', true);

  insert into public.credit_payments (
    credit_customer_id, date, amount, note, payment_mode, same_day_settlement, created_by, status
  )
  values (
    p_credit_customer_id,
    p_date,
    p_amount,
    nullif(trim(p_note), ''),
    coalesce(p_payment_mode, 'Cash'),
    coalesce(p_same_day_settlement, false),
    auth.uid(),
    'posted'
  );

  perform set_config('app.skip_credit_sync', '', true);
  perform set_config('app.skip_day_closing_refresh', '', true);

  perform public.credit_settle_latest_payment(p_credit_customer_id, p_date, p_amount);

  update public.credit_customers
  set last_payment = p_date
  where id = p_credit_customer_id;

  if coalesce(current_setting('app.defer_credit_day_closing', true), '') is distinct from 'true' then
    perform public.apply_credit_payment_to_day_closing(
      p_date,
      coalesce(p_same_day_settlement, false),
      coalesce(p_payment_mode, 'Cash'),
      p_amount
    );
  end if;

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  v_out := jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
  perform public.write_request_store(p_request_id, 'record_credit_payment', v_out);
  return v_out;
end;
$$;

comment on function public.record_credit_payment(uuid, date, numeric, text, text, boolean, uuid) is
  'Record payment. Locks the customer row. Same-day flag excludes from Collection and nets Credit today; syncs day closing. Rejects a certified day. Retry-safe with p_request_id.';

grant execute on function public.record_credit_payment(uuid, date, numeric, text, text, boolean, uuid) to authenticated;
