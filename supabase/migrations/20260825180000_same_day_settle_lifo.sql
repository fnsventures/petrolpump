-- Day-closing Collection: LIFO — payments apply to same-day credit first.
-- Older outstanding is ignored until today's credit is fully covered.
-- Also switch payment allocation (amount_settled) to LIFO so the ledger matches.

-- ─── 1) Day closing components ─────────────────────────────────────────────
create or replace function public.compute_day_closing_components(p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_ledger numeric := 0;
  v_credit_shift numeric := 0;
  v_expenses_ledger numeric := 0;
  v_expenses_shift numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_same_day_settle numeric := 0;
  v_same_day_cash numeric := 0;
  v_same_day_upi numeric := 0;
  v_same_day_bank numeric := 0;
  v_payments_raw numeric := 0;
  v_credit_raw numeric := 0;
  v_pay_cash numeric := 0;
  v_pay_upi numeric := 0;
begin
  perform public.require_staff_access();

  select coalesce(sum(
    coalesce(v_row.total_sales, 0)
    * case
        when v_row.product = 'petrol' then coalesce(v_row.petrol_rate, 0)
        when v_row.product = 'diesel' then coalesce(v_row.diesel_rate, 0)
        else 0
      end
  ), 0) into v_total_sale
  from (
    select distinct on (product)
      product, total_sales, petrol_rate, diesel_rate
    from public.dsr
    where date = p_date
    order by product, created_at desc nulls last, id desc
  ) v_row;

  select coalesce(sum(amount), 0) into v_payments_raw
  from public.credit_payments where date = p_date;

  select
    coalesce(sum(amount) filter (where coalesce(payment_mode, 'Cash') = 'Cash'), 0),
    coalesce(sum(amount) filter (where payment_mode = 'UPI'), 0)
  into v_pay_cash, v_pay_upi
  from public.credit_payments
  where date = p_date;

  select coalesce(sum(amount), 0) into v_credit_raw
  from public.credit_entries where transaction_date = p_date;
  select v_credit_raw + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_raw;

  -- LIFO for day closing: same-day settle = min(pay_today, credit_today).
  -- Older balance is NOT considered until today's credit is fully covered.
  with cust as (
    select credit_customer_id as cid from public.credit_payments where date = p_date
    union
    select credit_customer_id from public.credit_entries where transaction_date = p_date
  ),
  prior as (
    select
      c.cid,
      coalesce((
        select sum(e.amount) from public.credit_entries e
        where e.credit_customer_id = c.cid and e.transaction_date = p_date
      ), 0) as credit_today,
      coalesce((
        select sum(p.amount) from public.credit_payments p
        where p.credit_customer_id = c.cid and p.date = p_date
      ), 0) as pay_today,
      coalesce((
        select sum(p.amount) from public.credit_payments p
        where p.credit_customer_id = c.cid and p.date = p_date
          and coalesce(p.payment_mode, 'Cash') = 'Cash'
      ), 0) as pay_cash,
      coalesce((
        select sum(p.amount) from public.credit_payments p
        where p.credit_customer_id = c.cid and p.date = p_date
          and p.payment_mode = 'UPI'
      ), 0) as pay_upi,
      coalesce((
        select sum(p.amount) from public.credit_payments p
        where p.credit_customer_id = c.cid and p.date = p_date
          and p.payment_mode = 'Bank'
      ), 0) as pay_bank
    from cust c
  ),
  split as (
    select
      pay_today,
      pay_cash,
      pay_upi,
      pay_bank,
      least(pay_today, credit_today) as same_day
    from prior
  )
  select
    coalesce(sum(same_day), 0),
    coalesce(sum(
      case when pay_today > 0 then same_day * (pay_cash / pay_today) else 0 end
    ), 0),
    coalesce(sum(
      case when pay_today > 0 then same_day * (pay_upi / pay_today) else 0 end
    ), 0),
    coalesce(sum(
      case when pay_today > 0 then same_day * (pay_bank / pay_today) else 0 end
    ), 0)
  into v_same_day_settle, v_same_day_cash, v_same_day_upi, v_same_day_bank
  from split;

  v_collection := greatest(coalesce(v_payments_raw, 0) - coalesce(v_same_day_settle, 0), 0);
  v_credit_ledger := greatest(coalesce(v_credit_raw, 0) - coalesce(v_same_day_settle, 0), 0);

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  select coalesce(sum(amount), 0) into v_credit_shift
  from public.credit_entries
  where transaction_date = p_date and employee_id is not null and shift is not null;
  v_credit_shift := least(coalesce(v_credit_shift, 0), coalesce(v_credit_ledger, 0));

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_shift
  from public.expenses
  where date = p_date and employee_id is not null and shift is not null;

  select
    coalesce(sum(cash_collected), 0),
    coalesce(sum(phone_pay), 0)
  into v_shift_cash, v_shift_phone
  from public.meter_shift_cash
  where reading_date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_ledger, 0),
    'expenses_today', coalesce(v_expenses_ledger, 0),
    'credit_ledger', coalesce(v_credit_ledger, 0) - coalesce(v_credit_shift, 0),
    'credit_shift', coalesce(v_credit_shift, 0),
    'expenses_ledger', coalesce(v_expenses_ledger, 0) - coalesce(v_expenses_shift, 0),
    'expenses_shift', coalesce(v_expenses_shift, 0),
    'shift_cash_total', coalesce(v_shift_cash, 0),
    'shift_phone_pay_total', coalesce(v_shift_phone, 0),
    'same_day_settle', coalesce(v_same_day_settle, 0),
    'same_day_settle_cash', coalesce(v_same_day_cash, 0),
    'same_day_settle_upi', coalesce(v_same_day_upi, 0),
    'same_day_settle_bank', coalesce(v_same_day_bank, 0),
    'settle_cash_total', coalesce(v_pay_cash, 0),
    'settle_upi_total', coalesce(v_pay_upi, 0),
    'suggested_night_cash', coalesce(v_shift_cash, 0) + coalesce(v_pay_cash, 0),
    'suggested_phone_pay', coalesce(v_shift_phone, 0) + coalesce(v_pay_upi, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Day-closing totals. Same-day settle uses LIFO (today first); Collection is only payment excess over today’s credit.';

-- ─── 2) Payment allocation → LIFO (newest credit first) ────────────────────
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > current_date then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
        and amount_settled < amount
      order by transaction_date desc, id desc
      for update
    loop
      exit when v_remaining <= 0;
      v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
      update public.credit_entries
      set amount_settled = amount_settled + v_alloc
      where id = v_entry.id;
      v_remaining := v_remaining - v_alloc;
    end loop;

    insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
    values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

    perform public.sync_credit_customer_balances(p_credit_customer_id);

    update public.credit_customers
    set last_payment = p_date
    where id = p_credit_customer_id;
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
end;
$$;

comment on function public.record_credit_payment(uuid, date, numeric, text, text) is
  'Record payment; allocate to entries LIFO (newest first). Overpayment stored as prepaid_balance.';

-- ─── 3) Reallocate settlements LIFO ────────────────────────────────────────
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_pay record;
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    update public.credit_entries
    set amount_settled = 0
    where credit_customer_id = p_credit_customer_id;

    for v_pay in
      select id, amount
      from public.credit_payments
      where credit_customer_id = p_credit_customer_id
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
      for v_entry in
        select id, amount, amount_settled
        from public.credit_entries
        where credit_customer_id = p_credit_customer_id
          and amount_settled < amount
        order by transaction_date desc, id desc
        for update
      loop
        exit when v_remaining <= 0;
        v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
        update public.credit_entries
        set amount_settled = amount_settled + v_alloc
        where id = v_entry.id;
        v_remaining := v_remaining - v_alloc;
      end loop;
    end loop;

    perform public.sync_credit_customer_balances(p_credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);
end;
$$;

comment on function public.reallocate_credit_settlements(uuid) is
  'Reset amount_settled, then re-apply payments with LIFO (newest credit first).';

grant execute on function public.compute_day_closing_components(date) to authenticated;
grant execute on function public.record_credit_payment(uuid, date, numeric, text, text) to authenticated;
