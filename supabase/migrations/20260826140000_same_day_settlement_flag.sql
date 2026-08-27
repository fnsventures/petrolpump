-- Explicit "Same day settlement" flag on credit payments.
-- Checked payments are excluded from Collection and netted from Credit today;
-- Cash/UPI amounts still feed Night cash / Phone pay suggestions.

alter table public.credit_payments
  add column if not exists same_day_settlement boolean not null default false;

comment on column public.credit_payments.same_day_settlement is
  'When true, payment settles same-day credit: excluded from Collection, counted in Night cash / Phone pay.';

create index if not exists credit_payments_same_day_date_idx
  on public.credit_payments (date)
  where same_day_settlement;

-- ─── record_credit_payment ─────────────────────────────────────────────────
drop function if exists public.record_credit_payment(uuid, date, numeric, text, text);
drop function if exists public.record_credit_payment(uuid, date, numeric, text, text, boolean);

create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false
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
        and transaction_date <= p_date
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

    insert into public.credit_payments (
      credit_customer_id, date, amount, note, payment_mode, same_day_settlement, created_by
    )
    values (
      p_credit_customer_id,
      p_date,
      p_amount,
      nullif(trim(p_note), ''),
      coalesce(p_payment_mode, 'Cash'),
      coalesce(p_same_day_settlement, false),
      auth.uid()
    );

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
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
end;
$$;

comment on function public.record_credit_payment(uuid, date, numeric, text, text, boolean) is
  'Record payment; LIFO within entries on/before payment date. p_same_day_settlement routes to Night cash / Phone pay (not Collection).';

grant execute on function public.record_credit_payment(uuid, date, numeric, text, text, boolean) to authenticated;

-- ─── batch_record_credit_settlements ───────────────────────────────────────
drop function if exists public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text);
drop function if exists public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean);

create or replace function public.batch_record_credit_settlements(
  p_customer_ids uuid[],
  p_primary_customer_id uuid,
  p_date date,
  p_total_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false
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

  return jsonb_build_object(
    'date', p_date,
    'total_amount', p_total_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'settlements', v_settlements
  );
end;
$$;

comment on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean) is
  'Record one payment split across credit customer rows. Optional same-day settlement flag.';

grant execute on function public.batch_record_credit_settlements(uuid[], uuid, date, numeric, text, text, boolean) to authenticated;

-- ─── Day closing: Collection / Credit use the explicit flag ────────────────
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
      sum(amount) filter (
        where lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as pay_cash,
      sum(amount) filter (
        where lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as pay_upi,
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
    group by credit_customer_id
  ),
  cred as (
    select
      credit_customer_id,
      sum(amount) as credit_today,
      sum(amount) filter (
        where employee_id is not null and shift is not null
      ) as credit_shift
    from public.credit_entries
    where transaction_date = p_date
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
      select 1 from public.credit_entries e where e.credit_customer_id = c.id
    );

  v_credit_ledger := greatest(v_credit_entries - v_same_day_credit_reduce, 0) + v_credit_legacy;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  v_credit_shift := least(
    v_credit_shift_gross,
    greatest(v_credit_entries - v_same_day_credit_reduce, 0)
  );

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
  'Day-closing totals. Same-day settle uses credit_payments.same_day_settlement flag; Collection excludes flagged payments.';

-- Include flag in customer payment breakdown (body otherwise unchanged)
create or replace function public.get_customer_credit_detail_as_of(
  p_customer_name text,
  p_date date
)
returns table (
  customer_name text,
  vehicle_no text,
  credit_taken numeric,
  settlement_done numeric,
  remaining numeric,
  last_payment_date date,
  first_sale_date date,
  last_credit_date date,
  credit_entries jsonb,
  payment_entries jsonb
)
language plpgsql security definer stable
as $$
begin
  perform public.require_staff_access();
  return query
  with customer_ids as (
    select c.id as credit_customer_id from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id, coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date, max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id, coalesce(sum(p.amount), 0) as payment_tot, max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id, max(c.customer_name)::text as customer_name, max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c join customer_ids ci on ci.credit_customer_id = c.id group by c.id
  ),
  per_customer as (
    select nm.customer_name, nm.vehicle_no, coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date, b.min_txn_date as first_sale_date, b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name, (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken, sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining, max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date, max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'entry_date', e.transaction_date,
          'amount', e.amount,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount_settled', e.amount_settled
        ) order by e.transaction_date desc
      )
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids) and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'entry_date', p.date,
          'amount', p.amount,
          'payment_mode', p.payment_mode,
          'note', p.note,
          'same_day_settlement', coalesce(p.same_day_settlement, false)
        ) order by p.date desc
      )
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids) and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date, cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;
