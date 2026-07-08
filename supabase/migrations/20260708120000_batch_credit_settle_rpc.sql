-- Batch credit settlement: distribute one payment across multiple customer records
-- (same name / vehicle group) in a single transaction and one client round trip.

create or replace function public.batch_record_credit_settlements(
  p_customer_ids uuid[],
  p_primary_customer_id uuid,
  p_date date,
  p_total_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining numeric := p_total_amount;
  v_cust_id uuid;
  v_due numeric;
  v_pay_amount numeric;
  v_result jsonb;
  v_settlements jsonb := '[]'::jsonb;
begin
  perform public.require_staff_access();

  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > current_date then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    raise exception 'customer_ids required';
  end if;
  if p_primary_customer_id is null then
    raise exception 'primary_customer_id required';
  end if;
  if not exists (select 1 from public.credit_customers where id = p_primary_customer_id) then
    raise exception 'Primary credit customer not found';
  end if;

  perform id
  from public.credit_customers
  where id = any(p_customer_ids || array[p_primary_customer_id])
  order by id
  for update;

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
      v_cust_id, p_date, v_pay_amount, p_note, p_payment_mode
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
    v_remaining := v_remaining - v_pay_amount;
  end loop;

  if v_remaining > 0 then
    v_result := public.record_credit_payment(
      p_primary_customer_id, p_date, v_remaining, p_note, p_payment_mode
    );
    v_settlements := v_settlements || jsonb_build_array(v_result);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_amount', p_total_amount,
    'settlements', v_settlements
  );
end;
$$;

comment on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text) is
  'Record one payment split across multiple credit customer rows (FIFO per row). Overpayment goes to primary customer as prepaid.';

grant execute on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text) to authenticated;
