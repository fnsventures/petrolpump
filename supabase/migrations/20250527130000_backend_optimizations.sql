-- Backend optimizations: indexes, shared day-closing logic, range-scoped DSR stock,
-- batch attendance, credit payment trigger skip, richer credit detail RPC.

-- ─── Indexes for hot query paths ─────────────────────────────────────────────

create index if not exists dsr_petrol_receipts_buying_idx
  on public.dsr_petrol (date desc)
  where receipts > 0 and buying_price_per_litre is not null;

create index if not exists dsr_diesel_receipts_buying_idx
  on public.dsr_diesel (date desc)
  where receipts > 0 and buying_price_per_litre is not null;

create index if not exists credit_customers_name_norm_idx
  on public.credit_customers (lower(trim(customer_name)));

create index if not exists credit_entries_open_fifo_idx
  on public.credit_entries (credit_customer_id, transaction_date, id)
  where amount_settled < amount;

create index if not exists expenses_category_idx
  on public.expenses (category);

create index if not exists invoices_list_order_idx
  on public.invoices (invoice_date desc, created_at desc);

-- ─── Skip redundant amount_due sync during FIFO payment allocation ───────────

create or replace function public.credit_entries_sync_amount_due()
returns trigger language plpgsql security definer as $$
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
  update public.credit_customers c
  set amount_due = coalesce((
    select sum(e.amount - e.amount_settled)
    from public.credit_entries e
    where e.credit_customer_id = c.id
  ), 0)
  where c.id = v_customer_id;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

-- ─── Shared day-closing component calculator ─────────────────────────────────

create or replace function public.compute_day_closing_components(p_date date)
returns jsonb
language plpgsql stable security definer
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_expenses_today numeric := 0;
begin
  select coalesce(sum(
    (coalesce(v_row.total_sales, 0) - coalesce(v_row.testing, 0))
    * case
        when v_row.product = 'petrol' then coalesce(v_row.petrol_rate, 0)
        when v_row.product = 'diesel' then coalesce(v_row.diesel_rate, 0)
        else 0
      end
  ), 0) into v_total_sale
  from public.dsr v_row
  where v_row.date = p_date;

  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  select coalesce(sum(amount), 0) into v_credit_today
  from public.credit_entries where transaction_date = p_date;
  select v_credit_today + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_today;

  select coalesce(sum(amount), 0) into v_expenses_today
  from public.expenses where date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Shared day-closing totals for a date (DSR sale, collections, credit, expenses).';

-- Refactor get_day_closing_breakdown to use shared calculator
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_already_saved boolean := false;
begin
  select total_sale, collection, short_previous, credit_today, expenses_today,
         night_cash, phone_pay, short_today, closing_reference, remarks
  into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;

  if v_already_saved and v_existing.total_sale is not null then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', coalesce(v_existing.total_sale, 0),
      'collection', coalesce(v_existing.collection, 0),
      'short_previous', coalesce(v_existing.short_previous, 0),
      'credit_today', coalesce(v_existing.credit_today, 0),
      'expenses_today', coalesce(v_existing.expenses_today, 0),
      'night_cash', coalesce(v_existing.night_cash, 0),
      'phone_pay', coalesce(v_existing.phone_pay, 0),
      'short_today', coalesce(v_existing.short_today, 0),
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  v_components := public.compute_day_closing_components(p_date);

  if v_already_saved then
    return jsonb_build_object(
      'date', p_date,
      'total_sale', coalesce((v_components->>'total_sale')::numeric, 0),
      'collection', coalesce((v_components->>'collection')::numeric, 0),
      'short_previous', coalesce((v_components->>'short_previous')::numeric, 0),
      'credit_today', coalesce((v_components->>'credit_today')::numeric, 0),
      'expenses_today', coalesce((v_components->>'expenses_today')::numeric, 0),
      'night_cash', coalesce(v_existing.night_cash, 0),
      'phone_pay', coalesce(v_existing.phone_pay, 0),
      'short_today', coalesce(v_existing.short_today, 0),
      'closing_reference', v_existing.closing_reference,
      'remarks', v_existing.remarks,
      'already_saved', true
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce((v_components->>'total_sale')::numeric, 0),
    'collection', coalesce((v_components->>'collection')::numeric, 0),
    'short_previous', coalesce((v_components->>'short_previous')::numeric, 0),
    'credit_today', coalesce((v_components->>'credit_today')::numeric, 0),
    'expenses_today', coalesce((v_components->>'expenses_today')::numeric, 0),
    'night_cash', null,
    'phone_pay', null,
    'short_today', null,
    'closing_reference', null,
    'remarks', null,
    'already_saved', false
  );
end;
$$;

-- Refactor save_day_closing to use shared calculator
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
  v_ref text;
  v_seq bigint;
begin
  if p_night_cash is null or p_night_cash < 0 then
    raise exception 'night_cash must be >= 0';
  end if;
  if p_phone_pay is null or p_phone_pay < 0 then
    raise exception 'phone_pay must be >= 0';
  end if;

  if exists (select 1 from public.day_closing where date = p_date) then
    raise exception 'Day closing already saved for this date.';
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  select coalesce(max(
    nullif(regexp_replace(closing_reference, '^DC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
  ), 0) + 1 into v_seq
  from public.day_closing
  where extract(year from date) = extract(year from p_date)
    and closing_reference is not null
    and closing_reference ~ '^DC-[0-9]+-[0-9]+$';
  v_ref := 'DC-' || to_char(p_date, 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

  insert into public.day_closing (
    date, night_cash, phone_pay, short_today,
    total_sale, collection, short_previous, credit_today, expenses_today,
    closing_reference, remarks, created_by
  )
  values (
    p_date, p_night_cash, p_phone_pay, v_short_today,
    v_total_sale, v_collection, v_short_previous, v_credit_today, v_expenses_today,
    v_ref, nullif(trim(p_remarks), ''), auth.uid()
  );

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'night_cash', p_night_cash,
    'phone_pay', p_phone_pay,
    'short_today', v_short_today,
    'closing_reference', v_ref
  );
end;
$$;

-- ─── DSR stock for a date range (LAG only over needed rows) ──────────────────

create or replace function public.get_dsr_stock_range(p_start date, p_end date)
returns table (
  date date,
  product text,
  opening_stock numeric,
  receipts numeric,
  total_stock numeric,
  sale_from_meter numeric,
  testing numeric,
  net_sale numeric,
  closing_stock numeric,
  dip_stock numeric,
  variation numeric,
  remark text,
  created_by uuid,
  created_at timestamptz
)
language sql stable security definer
as $$
  with bounds as (
    select (p_start - interval '1 day')::date as lookback_start
  ),
  base as (
    select
      d.date,
      'petrol'::text as product,
      d.stock as dip_stock,
      d.receipts,
      d.total_sales as sale_from_meter,
      d.testing,
      greatest(d.total_sales - d.testing, 0) as net_sale,
      d.remarks as remark,
      d.created_by,
      d.created_at
    from public.dsr_petrol d, bounds b
    where d.date >= b.lookback_start and d.date <= p_end
    union all
    select
      d.date,
      'diesel'::text,
      d.stock,
      d.receipts,
      d.total_sales,
      d.testing,
      greatest(d.total_sales - d.testing, 0),
      d.remarks,
      d.created_by,
      d.created_at
    from public.dsr_diesel d, bounds b
    where d.date >= b.lookback_start and d.date <= p_end
  ),
  with_opening as (
    select *,
      coalesce(lag(dip_stock) over (partition by product order by date), 0) as opening_stock
    from base
  )
  select
    w.date,
    w.product,
    w.opening_stock,
    w.receipts,
    (w.opening_stock + w.receipts) as total_stock,
    w.sale_from_meter,
    w.testing,
    w.net_sale,
    ((w.opening_stock + w.receipts) - w.net_sale) as closing_stock,
    w.dip_stock,
    (((w.opening_stock + w.receipts) - w.net_sale) - w.dip_stock) as variation,
    w.remark,
    w.created_by,
    w.created_at
  from with_opening w
  where w.date >= p_start and w.date <= p_end;
$$;

comment on function public.get_dsr_stock_range(date, date) is
  'DSR stock reconciliation for a date range; LAG scoped to range + 1 prior day per product.';

grant execute on function public.get_dsr_stock_range(date, date) to authenticated;

-- ─── Batch attendance save (one round-trip) ──────────────────────────────────

create or replace function public.save_employee_attendance_batch(
  p_date date,
  p_rows jsonb
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_row jsonb;
  v_count int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('saved', 0);
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) as t(value)
  loop
    if v_row->>'employee_id' is null then
      continue;
    end if;
    insert into public.employee_attendance (
      employee_id, date, status, shift, note, created_by, updated_at
    )
    values (
      (v_row->>'employee_id')::uuid,
      p_date,
      coalesce(nullif(trim(v_row->>'status'), ''), 'present'),
      nullif(trim(v_row->>'shift'), ''),
      nullif(trim(v_row->>'note'), ''),
      auth.uid(),
      timezone('utc'::text, now())
    )
    on conflict (employee_id, date) do update set
      status = excluded.status,
      shift = excluded.shift,
      note = excluded.note,
      updated_at = excluded.updated_at;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('saved', v_count);
end;
$$;

comment on function public.save_employee_attendance_batch(date, jsonb) is
  'Upsert attendance rows for one date in a single transaction.';

grant execute on function public.save_employee_attendance_batch(date, jsonb) to authenticated;

-- ─── Optimized credit payment (skip per-row amount_due sync) ─────────────────

create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  for v_entry in
    select id, amount, amount_settled
    from public.credit_entries
    where credit_customer_id = p_credit_customer_id
      and amount_settled < amount
    order by transaction_date asc, id asc
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
    update public.credit_entries
    set amount_settled = amount_settled + v_alloc
    where id = v_entry.id;
    v_remaining := v_remaining - v_alloc;
  end loop;

  perform set_config('app.skip_credit_sync', '', true);

  if v_remaining >= p_amount then
    raise exception 'No outstanding balance to apply payment to';
  end if;

  if v_remaining > 0 then
    raise exception 'Payment amount exceeds outstanding balance';
  end if;

  insert into public.credit_payments (credit_customer_id, date, amount, note, payment_mode, created_by)
  values (p_credit_customer_id, p_date, p_amount, nullif(trim(p_note), ''), coalesce(p_payment_mode, 'Cash'), auth.uid());

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = p_credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = p_date
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'new_due', v_new_due
  );
end;
$$;

-- ─── Richer credit detail RPC (full entry fields; avoids extra SELECTs) ──────

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
  return query
  with customer_ids as (
    select c.id as credit_customer_id
    from public.credit_customers c
    where lower(trim(c.customer_name)) = lower(trim(p_customer_name))
  ),
  bal as (
    select e.credit_customer_id,
           coalesce(sum(e.amount), 0) as credit_tot,
           min(e.transaction_date) as min_txn_date,
           max(e.transaction_date) as max_txn_date
    from public.credit_entries e
    where e.transaction_date <= p_date
      and e.credit_customer_id in (select credit_customer_id from customer_ids)
    group by e.credit_customer_id
  ),
  pay as (
    select p.credit_customer_id,
           coalesce(sum(p.amount), 0) as payment_tot,
           max(p.date) as last_pay_date
    from public.credit_payments p
    where p.date <= p_date
      and p.credit_customer_id in (select credit_customer_id from customer_ids)
    group by p.credit_customer_id
  ),
  name_match as (
    select c.id as credit_customer_id,
           max(c.customer_name)::text as customer_name,
           max(c.vehicle_no)::text as vehicle_no
    from public.credit_customers c
    join customer_ids ci on ci.credit_customer_id = c.id
    group by c.id
  ),
  per_customer as (
    select nm.customer_name,
           nm.vehicle_no,
           coalesce(b.credit_tot, 0) as credit_taken,
           coalesce(p.payment_tot, 0) as settlement_done,
           greatest(coalesce(b.credit_tot, 0) - coalesce(p.payment_tot, 0), 0)::numeric as remaining,
           p.last_pay_date as last_payment_date,
           b.min_txn_date as first_sale_date,
           b.max_txn_date as last_credit_date
    from name_match nm
    left join bal b on b.credit_customer_id = nm.credit_customer_id
    left join pay p on p.credit_customer_id = nm.credit_customer_id
  ),
  agg as (
    select (max(pc.customer_name))::text as customer_name,
           (max(pc.vehicle_no))::text as vehicle_no,
           sum(pc.credit_taken)::numeric as credit_taken,
           sum(pc.settlement_done)::numeric as settlement_done,
           sum(pc.remaining)::numeric as remaining,
           max(pc.last_payment_date) as last_payment_date,
           min(pc.first_sale_date) as first_sale_date,
           max(pc.last_credit_date) as last_credit_date
    from per_customer pc
  ),
  credits_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'entry_date', e.transaction_date,
          'amount', e.amount,
          'fuel_type', e.fuel_type,
          'quantity', e.quantity,
          'amount_settled', e.amount_settled
        ) order by e.transaction_date desc
      )
       from public.credit_entries e
       where e.credit_customer_id in (select credit_customer_id from customer_ids)
         and e.transaction_date <= p_date),
      '[]'::jsonb
    ) as entries
  ),
  payments_json as (
    select coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'entry_date', p.date,
          'amount', p.amount,
          'payment_mode', p.payment_mode,
          'note', p.note
        ) order by p.date desc
      )
       from public.credit_payments p
       where p.credit_customer_id in (select credit_customer_id from customer_ids)
         and p.date <= p_date),
      '[]'::jsonb
    ) as entries
  )
  select a.customer_name, a.vehicle_no, a.credit_taken, a.settlement_done, a.remaining,
         a.last_payment_date, a.first_sale_date, a.last_credit_date,
         cj.entries as credit_entries, pj.entries as payment_entries
  from agg a, credits_json cj, payments_json pj;
end;
$$;

grant execute on function public.compute_day_closing_components(date) to authenticated;
