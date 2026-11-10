-- Canonical definition of public.batch_record_credit_settlements. Edit here, then:
--   node scripts/sql-functions.mjs emit batch_record_credit_settlements
create or replace function public.batch_record_credit_settlements(
  p_customer_ids uuid[],
  p_primary_customer_id uuid,
  p_date date,
  p_total_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_out jsonb;
  v_remaining numeric := p_total_amount;
  v_cust_id uuid;
  v_due numeric;
  v_pay_amount numeric;
  v_result jsonb;
  v_settlements jsonb := '[]'::jsonb;
begin
  perform public.require_staff_access();

  v_replay := public.write_request_replay(p_request_id, 'batch_record_credit_settlements');
  if v_replay is not null then
    return v_replay;
  end if;

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > public.meter_station_today() then
    raise exception 'payment date cannot be in the future';
  end if;
  perform public.raise_if_day_closing_certified(p_date);
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    raise exception 'customer_ids required';
  end if;
  if p_primary_customer_id is null then
    raise exception 'primary_customer_id required';
  end if;

  perform id
  from public.credit_customers
  where id = any(p_customer_ids || array[p_primary_customer_id])
  order by id
  for update;

  perform set_config('app.defer_credit_day_closing', 'true', true);

  foreach v_cust_id in array p_customer_ids
  loop
    exit when v_remaining <= 0;

    select amount_due into v_due
    from public.credit_customers
    where id = v_cust_id;

    if not found then
      raise exception 'Credit customer not found';
    end if;

    if v_due <= 0 then
      continue;
    end if;

    v_pay_amount := least(v_remaining, v_due);
    v_result := public.record_credit_payment(
      v_cust_id, p_date, v_pay_amount, p_note, p_payment_mode, coalesce(p_same_day_settlement, false)
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
    v_remaining := v_remaining - v_pay_amount;
  end loop;

  if v_remaining > 0 then
    v_result := public.record_credit_payment(
      p_primary_customer_id, p_date, v_remaining, p_note, p_payment_mode, coalesce(p_same_day_settlement, false)
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
  end if;

  perform set_config('app.defer_credit_day_closing', '', true);

  perform public.apply_credit_payment_to_day_closing(
    p_date,
    coalesce(p_same_day_settlement, false),
    coalesce(p_payment_mode, 'Cash'),
    p_total_amount
  );

  v_out := jsonb_build_object(
    'date', p_date,
    'total_amount', p_total_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'settlements', v_settlements
  );
  perform public.write_request_store(p_request_id, 'batch_record_credit_settlements', v_out);
  return v_out;
end;
$$;

comment on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean, uuid) is
  'Record one payment split across credit customer rows. Locks those rows. Optional same-day settlement flag. Rejects a certified day. Retry-safe with p_request_id.';

grant execute on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean, uuid) to authenticated;
