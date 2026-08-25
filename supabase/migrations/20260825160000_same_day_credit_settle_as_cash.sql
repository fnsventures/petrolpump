-- Same-day credit sale + same-day settlement is treated as cash/UPI for day closing:
-- exclude from Collection and Credit today; supervisor enters it in Night cash / Phone pay.

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
begin
  perform public.require_staff_access();

  -- Total sale: gross litres × rate; DISTINCT ON product guards against duplicate dates
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

  select coalesce(sum(amount), 0) into v_credit_raw
  from public.credit_entries where transaction_date = p_date;
  select v_credit_raw + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_raw;

  -- Per customer: payments first cover prior open balance (FIFO-style), remainder
  -- may settle today's credit → that remainder is same-day (night cash / phone pay).
  with cust as (
    select credit_customer_id as cid from public.credit_payments where date = p_date
    union
    select credit_customer_id from public.credit_entries where transaction_date = p_date
  ),
  prior as (
    select
      c.cid,
      greatest(
        coalesce((
          select sum(e.amount) from public.credit_entries e
          where e.credit_customer_id = c.cid and e.transaction_date < p_date
        ), 0)
        - coalesce((
          select sum(p.amount) from public.credit_payments p
          where p.credit_customer_id = c.cid and p.date < p_date
        ), 0),
        0
      ) as prior_open,
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
      prior_open,
      credit_today,
      pay_today,
      pay_cash,
      pay_upi,
      pay_bank,
      least(pay_today, prior_open) as collection_prior,
      least(
        greatest(pay_today - prior_open, 0),
        credit_today
      ) as same_day
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

  -- Attribution breakdown only (already included in ledger — do not add meter_shift_cash)
  select coalesce(sum(amount), 0) into v_credit_shift
  from public.credit_entries
  where transaction_date = p_date and employee_id is not null and shift is not null;
  -- Shift-attributed credit that was same-day settled is also excluded from credit_today;
  -- keep credit_shift as gross for diagnostics, but clamp so credit_ledger stays non-negative.
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
    -- Prefill hints: shift till + same-day cash/UPI settlements
    'suggested_night_cash', coalesce(v_shift_cash, 0) + coalesce(v_same_day_cash, 0),
    'suggested_phone_pay', coalesce(v_shift_phone, 0) + coalesce(v_same_day_upi, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Day-closing totals. Same-day credit+settle is excluded from collection/credit and surfaced for night cash / phone pay.';

grant execute on function public.compute_day_closing_components(date) to authenticated;
