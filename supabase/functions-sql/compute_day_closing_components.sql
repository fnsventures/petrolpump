-- Canonical definition of public.compute_day_closing_components. Edit here, then:
--   node scripts/sql-functions.mjs emit compute_day_closing_components
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
  v_credit_shift_gross numeric := 0;
  v_expenses_ledger numeric := 0;
  v_expenses_shift numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_same_day_settle numeric := 0;
  v_same_day_cash numeric := 0;
  v_same_day_upi numeric := 0;
  v_same_day_bank numeric := 0;
  v_payments_raw numeric := 0;
  v_credit_entries numeric := 0;
  v_credit_legacy numeric := 0;
  v_pay_cash numeric := 0;
  v_pay_upi numeric := 0;
  v_same_day_credit_reduce numeric := 0;
  v_open_credit numeric := 0;
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

  with pay as (
    select
      credit_customer_id,
      sum(amount) as pay_today,
      sum(amount) filter (where coalesce(same_day_settlement, false)) as same_day_pay,
      sum(amount) filter (where not coalesce(same_day_settlement, false)) as collection_pay,
      sum(amount) filter (where lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash') as pay_cash,
      sum(amount) filter (where lower(trim(coalesce(payment_mode, ''))) = 'upi') as pay_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as same_day_cash,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as same_day_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'bank'
      ) as same_day_bank
    from public.credit_payments
    where date = p_date
      and status = 'posted'
    group by credit_customer_id
  ),
  cred as (
    select
      credit_customer_id,
      sum(amount) as credit_today,
      sum(amount) filter (where employee_id is not null and shift is not null) as credit_shift
    from public.credit_entries
    where transaction_date = p_date
      and status = 'posted'
    group by credit_customer_id
  ),
  split as (
    select
      coalesce(p.pay_today, 0) as pay_today,
      coalesce(p.collection_pay, 0) as collection_pay,
      coalesce(p.same_day_pay, 0) as same_day_pay,
      coalesce(p.pay_cash, 0) as pay_cash,
      coalesce(p.pay_upi, 0) as pay_upi,
      coalesce(p.same_day_cash, 0) as same_day_cash,
      coalesce(p.same_day_upi, 0) as same_day_upi,
      coalesce(p.same_day_bank, 0) as same_day_bank,
      coalesce(c.credit_today, 0) as credit_today,
      coalesce(c.credit_shift, 0) as credit_shift,
      least(coalesce(p.same_day_pay, 0), coalesce(c.credit_today, 0)) as same_day_credit_reduce
    from pay p
    full outer join cred c using (credit_customer_id)
  )
  select
    coalesce(sum(pay_today), 0),
    coalesce(sum(collection_pay), 0),
    coalesce(sum(pay_cash), 0),
    coalesce(sum(pay_upi), 0),
    coalesce(sum(credit_today), 0),
    coalesce(sum(credit_shift), 0),
    coalesce(sum(same_day_pay), 0),
    coalesce(sum(same_day_cash), 0),
    coalesce(sum(same_day_upi), 0),
    coalesce(sum(same_day_bank), 0),
    coalesce(sum(same_day_credit_reduce), 0)
  into
    v_payments_raw, v_collection,
    v_pay_cash, v_pay_upi,
    v_credit_entries, v_credit_shift_gross,
    v_same_day_settle, v_same_day_cash, v_same_day_upi, v_same_day_bank,
    v_same_day_credit_reduce
  from split;

  select coalesce(sum(c.amount_due), 0) into v_credit_legacy
  from public.credit_customers c
  where c.date = p_date
    and not exists (
      select 1 from public.credit_entries e
      where e.credit_customer_id = c.id and e.status = 'posted'
    );

  v_open_credit := greatest(v_credit_entries - v_same_day_credit_reduce, 0);
  v_credit_ledger := v_open_credit + v_credit_legacy;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  v_credit_shift := least(v_credit_shift_gross, v_open_credit);

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_shift
  from public.expenses
  where date = p_date and employee_id is not null and shift is not null;

  select coalesce(sum(cash_collected), 0), coalesce(sum(phone_pay), 0)
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
    'credit_shift_gross', coalesce(v_credit_shift_gross, 0),
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
  'Day closing: credit_today = open credit (same-day settled excluded). credit_shift_gross = shift register credit for shift short.';

grant execute on function public.compute_day_closing_components(date) to authenticated;
