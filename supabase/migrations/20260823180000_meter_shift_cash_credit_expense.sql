-- Staff shift cash: add credit + expenses for short calc.
-- Total = cash + phone + credit + expense. Short = expected − total.
-- IMPORTANT: Apply 20260823190000 immediately after this migration.
-- This file alone can double-count shift credit/expense in day closing and
-- lets save overwrite ledger caches; 190000 corrects both and adds shift ledger RPCs.
-- Day closing credit/expense come from the ledger (see 20260823190000); meter_shift_cash
-- credit_amount/expense_amount are caches only.

alter table public.meter_shift_cash
  add column if not exists credit_amount numeric(14, 2) not null default 0
    check (credit_amount >= 0);

alter table public.meter_shift_cash
  add column if not exists expense_amount numeric(14, 2) not null default 0
    check (expense_amount >= 0);

comment on table public.meter_shift_cash is
  'Staff handover per shift: cash + phone pay + cached credit + expenses. Total = sum of four. Short = expected − total.';

comment on column public.meter_shift_cash.cash_collected is
  'Hard cash handed over by staff for the shift (₹).';

comment on column public.meter_shift_cash.phone_pay is
  'PhonePe / UPI collected by staff for the shift (₹).';

comment on column public.meter_shift_cash.credit_amount is
  'Cached shift-attributed credit (₹). Synced from credit_entries; used for short / reports.';

comment on column public.meter_shift_cash.expense_amount is
  'Cached shift-attributed expenses (₹). Synced from expenses; used for short / reports.';

-- ─── save_meter_shift_readings ──────────────────────────────────────────────

create or replace function public.save_meter_shift_readings(
  p_date date,
  p_shift text,
  p_nozzles jsonb,
  p_cash jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_shift text;
  v_row jsonb;
  v_product text;
  v_pump smallint;
  v_nozzle smallint;
  v_employee uuid;
  v_opening numeric;
  v_closing numeric;
  v_testing numeric;
  v_remarks text;
  v_cash_amt numeric;
  v_phone_pay numeric;
  v_credit_amt numeric;
  v_expense_amt numeric;
  v_kept_nozzles int := 0;
  v_kept_cash int := 0;
  v_keys text[] := array[]::text[];
  v_emp_ids uuid[] := array[]::uuid[];
  v_existing_count int;
  v_morning_close numeric;
  v_dsr_apply jsonb;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  perform public.require_meter_shift_writable(p_date, v_shift);

  if p_nozzles is null or jsonb_typeof(p_nozzles) <> 'array' then
    raise exception 'Nozzles payload must be a JSON array';
  end if;

  if p_cash is null then
    p_cash := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_cash) <> 'array' then
    raise exception 'Cash payload must be a JSON array';
  end if;

  select count(*)::int into v_existing_count
  from public.meter_shift_readings r
  where r.reading_date = p_date and r.shift = v_shift;

  for v_row in
    select value from jsonb_array_elements(p_nozzles)
  loop
    v_employee := nullif(btrim(coalesce(v_row->>'employee_id', '')), '')::uuid;
    if v_employee is null then
      continue;
    end if;

    v_product := lower(btrim(coalesce(v_row->>'product', '')));
    if v_product not in ('petrol', 'diesel') then
      raise exception 'Invalid product in nozzle row';
    end if;

    v_pump := (v_row->>'pump_no')::smallint;
    v_nozzle := (v_row->>'nozzle_no')::smallint;
    if v_pump is null or v_nozzle is null
       or v_pump < 1 or v_pump > 8
       or v_nozzle < 1 or v_nozzle > 8 then
      raise exception 'Invalid pump/nozzle in nozzle row';
    end if;

    if not exists (
      select 1 from public.employees e
      where e.id = v_employee and coalesce(e.is_active, true)
    ) then
      raise exception 'Staff is inactive or missing';
    end if;

    v_opening := coalesce((v_row->>'opening_meter')::numeric, 0);
    v_closing := coalesce((v_row->>'closing_meter')::numeric, 0);
    v_testing := coalesce((v_row->>'testing_litres')::numeric, 0);
    if v_opening < 0 or v_closing < 0 or v_testing < 0 then
      raise exception 'Meter and testing values must be >= 0';
    end if;
    if v_closing < v_opening then
      raise exception 'Closing meter must be >= opening meter (P% · N%)', v_pump, v_nozzle;
    end if;
    if v_testing > (v_closing - v_opening) then
      raise exception 'Testing cannot exceed sale litres (P% · N%)', v_pump, v_nozzle;
    end if;

    if v_shift = 'afternoon' then
      select m.closing_meter into v_morning_close
      from public.meter_shift_readings m
      where m.reading_date = p_date
        and m.shift = 'morning'
        and m.product = v_product
        and m.pump_no = v_pump
        and m.nozzle_no = v_nozzle;
      if found and v_morning_close is not null
         and abs(v_opening - v_morning_close) > 0.001 then
        raise exception
          'Afternoon opening for % P%·N% (%) must match morning closing (%)',
          v_product, v_pump, v_nozzle, v_opening, v_morning_close;
      end if;
    end if;

    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_readings (
      reading_date, product, shift, employee_id,
      pump_no, nozzle_no, opening_meter, closing_meter, testing_litres,
      remarks, created_by, updated_at
    )
    values (
      p_date, v_product, v_shift, v_employee,
      v_pump, v_nozzle, v_opening, v_closing, v_testing,
      v_remarks, v_uid, timezone('utc'::text, now())
    )
    on conflict (reading_date, product, shift, pump_no, nozzle_no)
    do update set
      employee_id = excluded.employee_id,
      opening_meter = excluded.opening_meter,
      closing_meter = excluded.closing_meter,
      testing_litres = excluded.testing_litres,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now());

    v_keys := array_append(v_keys, v_product || ':' || v_pump::text || ':' || v_nozzle::text);
    v_kept_nozzles := v_kept_nozzles + 1;
  end loop;

  if v_kept_nozzles = 0 and coalesce(v_existing_count, 0) > 0 then
    raise exception
      'Assign at least one nozzle, or use Clear shift to delete existing readings';
  end if;

  delete from public.meter_shift_readings r
  where r.reading_date = p_date
    and r.shift = v_shift
    and not (
      (r.product || ':' || r.pump_no::text || ':' || r.nozzle_no::text) = any (v_keys)
    );

  for v_row in
    select value from jsonb_array_elements(p_cash)
  loop
    v_employee := nullif(btrim(coalesce(v_row->>'employee_id', '')), '')::uuid;
    if v_employee is null then
      continue;
    end if;

    if not exists (
      select 1 from public.employees e
      where e.id = v_employee and coalesce(e.is_active, true)
    ) then
      raise exception 'Cash row references inactive or unknown staff';
    end if;

    v_cash_amt := coalesce((v_row->>'cash_collected')::numeric, 0);
    v_phone_pay := coalesce((v_row->>'phone_pay')::numeric, 0);
    v_credit_amt := coalesce((v_row->>'credit_amount')::numeric, 0);
    v_expense_amt := coalesce((v_row->>'expense_amount')::numeric, 0);
    if v_cash_amt < 0 then
      raise exception 'Cash collected must be >= 0';
    end if;
    if v_phone_pay < 0 then
      raise exception 'Phone pay must be >= 0';
    end if;
    if v_credit_amt < 0 then
      raise exception 'Credit amount must be >= 0';
    end if;
    if v_expense_amt < 0 then
      raise exception 'Expense amount must be >= 0';
    end if;
    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_cash (
      reading_date, shift, employee_id,
      cash_collected, phone_pay, credit_amount, expense_amount,
      remarks, created_by, updated_at
    )
    values (
      p_date, v_shift, v_employee,
      v_cash_amt, v_phone_pay, v_credit_amt, v_expense_amt,
      v_remarks, v_uid, timezone('utc'::text, now())
    )
    on conflict (reading_date, shift, employee_id)
    do update set
      cash_collected = excluded.cash_collected,
      phone_pay = excluded.phone_pay,
      credit_amount = excluded.credit_amount,
      expense_amount = excluded.expense_amount,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now());

    v_emp_ids := array_append(v_emp_ids, v_employee);
    v_kept_cash := v_kept_cash + 1;
  end loop;

  delete from public.meter_shift_cash c
  where c.reading_date = p_date
    and c.shift = v_shift
    and not (c.employee_id = any (v_emp_ids))
    and not exists (
      select 1 from public.meter_shift_readings r
      where r.reading_date = c.reading_date
        and r.shift = c.shift
        and r.employee_id = c.employee_id
    );

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return public.get_meter_shift_readings(p_date, v_shift)
    || jsonb_build_object(
      'saved_nozzles', v_kept_nozzles,
      'saved_cash', v_kept_cash,
      'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
    );
end;
$$;

comment on function public.save_meter_shift_readings(date, text, jsonb, jsonb) is
  'Upsert shift nozzle + cash/phone/credit/expense; push meter columns into existing dsr_* rows; refuses empty wipe.';

-- ─── get_meter_shift_readings ───────────────────────────────────────────────

create or replace function public.get_meter_shift_readings(
  p_date date,
  p_shift text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_petrol record;
  v_diesel record;
  v_petrol_complete boolean := false;
  v_diesel_complete boolean := false;
  v_prior jsonb;
  v_daily_meters jsonb;
  v_suggested jsonb := '{}'::jsonb;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select p.*
  into v_petrol
  from public.dsr_petrol p
  where p.date = p_date
  order by p.created_at desc
  limit 1;

  select d.*
  into v_diesel
  from public.dsr_diesel d
  where d.date = p_date
  order by d.created_at desc
  limit 1;

  if v_petrol.id is not null then
    v_petrol_complete := public.dsr_meter_row_is_complete(
      v_petrol.petrol_rate, v_petrol.dip_reading, v_petrol.stock, v_petrol.receipts
    );
  end if;
  if v_diesel.id is not null then
    v_diesel_complete := public.dsr_meter_row_is_complete(
      v_diesel.diesel_rate, v_diesel.dip_reading, v_diesel.stock, v_diesel.receipts
    );
  end if;

  v_prior := public.get_meter_shift_prior_closings(p_date, v_shift);

  v_daily_meters := jsonb_build_object(
    'petrol', case when v_petrol.id is not null then jsonb_build_object(
      'opening_pump1_nozzle1', v_petrol.opening_pump1_nozzle1,
      'opening_pump1_nozzle2', v_petrol.opening_pump1_nozzle2,
      'opening_pump2_nozzle1', v_petrol.opening_pump2_nozzle1,
      'opening_pump2_nozzle2', v_petrol.opening_pump2_nozzle2,
      'closing_pump1_nozzle1', v_petrol.closing_pump1_nozzle1,
      'closing_pump1_nozzle2', v_petrol.closing_pump1_nozzle2,
      'closing_pump2_nozzle1', v_petrol.closing_pump2_nozzle1,
      'closing_pump2_nozzle2', v_petrol.closing_pump2_nozzle2,
      'sales_pump1', v_petrol.sales_pump1,
      'sales_pump2', v_petrol.sales_pump2,
      'total_sales', v_petrol.total_sales,
      'is_complete', v_petrol_complete
    ) else null end,
    'diesel', case when v_diesel.id is not null then jsonb_build_object(
      'opening_pump1_nozzle1', v_diesel.opening_pump1_nozzle1,
      'opening_pump1_nozzle2', v_diesel.opening_pump1_nozzle2,
      'opening_pump2_nozzle1', v_diesel.opening_pump2_nozzle1,
      'opening_pump2_nozzle2', v_diesel.opening_pump2_nozzle2,
      'closing_pump1_nozzle1', v_diesel.closing_pump1_nozzle1,
      'closing_pump1_nozzle2', v_diesel.closing_pump1_nozzle2,
      'closing_pump2_nozzle1', v_diesel.closing_pump2_nozzle1,
      'closing_pump2_nozzle2', v_diesel.closing_pump2_nozzle2,
      'sales_pump1', v_diesel.sales_pump1,
      'sales_pump2', v_diesel.sales_pump2,
      'total_sales', v_diesel.total_sales,
      'is_complete', v_diesel_complete
    ) else null end
  );

  select coalesce(
    jsonb_object_agg(
      (elem->>'product') || ':' || (elem->>'pump_no') || ':' || (elem->>'nozzle_no'),
      elem->'closing_meter'
    ),
    '{}'::jsonb
  )
  into v_suggested
  from jsonb_array_elements(coalesce(v_prior->'from_shift', '[]'::jsonb)) as elem;

  if v_shift = 'morning' then
    if v_petrol_complete then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'petrol:1:1', coalesce(v_suggested->'petrol:1:1', v_daily_meters->'petrol'->'opening_pump1_nozzle1'),
        'petrol:1:2', coalesce(v_suggested->'petrol:1:2', v_daily_meters->'petrol'->'opening_pump1_nozzle2'),
        'petrol:2:1', coalesce(v_suggested->'petrol:2:1', v_daily_meters->'petrol'->'opening_pump2_nozzle1'),
        'petrol:2:2', coalesce(v_suggested->'petrol:2:2', v_daily_meters->'petrol'->'opening_pump2_nozzle2')
      ));
    end if;
    if v_diesel_complete then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'diesel:1:1', coalesce(v_suggested->'diesel:1:1', v_daily_meters->'diesel'->'opening_pump1_nozzle1'),
        'diesel:1:2', coalesce(v_suggested->'diesel:1:2', v_daily_meters->'diesel'->'opening_pump1_nozzle2'),
        'diesel:2:1', coalesce(v_suggested->'diesel:2:1', v_daily_meters->'diesel'->'opening_pump2_nozzle1'),
        'diesel:2:2', coalesce(v_suggested->'diesel:2:2', v_daily_meters->'diesel'->'opening_pump2_nozzle2')
      ));
    end if;
    if v_prior->'from_daily'->'petrol' is not null then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'petrol:1:1', coalesce(v_suggested->'petrol:1:1', v_prior->'from_daily'->'petrol'->'closing_pump1_nozzle1'),
        'petrol:1:2', coalesce(v_suggested->'petrol:1:2', v_prior->'from_daily'->'petrol'->'closing_pump1_nozzle2'),
        'petrol:2:1', coalesce(v_suggested->'petrol:2:1', v_prior->'from_daily'->'petrol'->'closing_pump2_nozzle1'),
        'petrol:2:2', coalesce(v_suggested->'petrol:2:2', v_prior->'from_daily'->'petrol'->'closing_pump2_nozzle2')
      ));
    end if;
    if v_prior->'from_daily'->'diesel' is not null then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'diesel:1:1', coalesce(v_suggested->'diesel:1:1', v_prior->'from_daily'->'diesel'->'closing_pump1_nozzle1'),
        'diesel:1:2', coalesce(v_suggested->'diesel:1:2', v_prior->'from_daily'->'diesel'->'closing_pump1_nozzle2'),
        'diesel:2:1', coalesce(v_suggested->'diesel:2:1', v_prior->'from_daily'->'diesel'->'closing_pump2_nozzle1'),
        'diesel:2:2', coalesce(v_suggested->'diesel:2:2', v_prior->'from_daily'->'diesel'->'closing_pump2_nozzle2')
      ));
    end if;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'rates', jsonb_build_object(
      'petrol', v_petrol.petrol_rate,
      'diesel', v_diesel.diesel_rate
    ),
    'daily_totals', jsonb_build_object(
      'petrol', jsonb_build_object(
        'total_sales', coalesce(v_petrol.total_sales, 0),
        'testing', coalesce(v_petrol.testing, 0),
        'has_row', v_petrol.id is not null,
        'has_complete_row', v_petrol_complete
      ),
      'diesel', jsonb_build_object(
        'total_sales', coalesce(v_diesel.total_sales, 0),
        'testing', coalesce(v_diesel.testing, 0),
        'has_row', v_diesel.id is not null,
        'has_complete_row', v_diesel_complete
      )
    ),
    'daily_meters', coalesce(v_daily_meters, '{}'::jsonb),
    'suggested_openings', v_suggested,
    'prior', v_prior,
    'nozzles', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'product', r.product,
          'pump_no', r.pump_no,
          'nozzle_no', r.nozzle_no,
          'employee_id', r.employee_id,
          'employee_name', e.name,
          'opening_meter', r.opening_meter,
          'closing_meter', r.closing_meter,
          'testing_litres', r.testing_litres,
          'litres_sold', greatest(r.closing_meter - r.opening_meter, 0),
          'net_litres', greatest(r.closing_meter - r.opening_meter - r.testing_litres, 0),
          'remarks', r.remarks
        )
        order by r.product, r.pump_no, r.nozzle_no
      )
      from public.meter_shift_readings r
      left join public.employees e on e.id = r.employee_id
      where r.reading_date = p_date
        and r.shift = v_shift
    ), '[]'::jsonb),
    'cash', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'employee_id', c.employee_id,
          'employee_name', e.name,
          'cash_collected', c.cash_collected,
          'phone_pay', c.phone_pay,
          'credit_amount', c.credit_amount,
          'expense_amount', c.expense_amount,
          'total_collected',
            coalesce(c.cash_collected, 0) + coalesce(c.phone_pay, 0)
            + coalesce(c.credit_amount, 0) + coalesce(c.expense_amount, 0),
          'remarks', c.remarks
        )
        order by e.display_order nulls last, e.name
      )
      from public.meter_shift_cash c
      left join public.employees e on e.id = c.employee_id
      where c.reading_date = p_date
        and c.shift = v_shift
    ), '[]'::jsonb),
    'attendance_hints', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employee_id', a.employee_id,
          'employee_name', e.name,
          'status', a.status
        )
        order by e.display_order nulls last, e.name
      )
      from public.employee_attendance a
      join public.employees e on e.id = a.employee_id
      where a.date = p_date
        and a.shift = v_shift
        and a.status in ('present', 'half_day')
        and coalesce(e.is_active, true)
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.get_meter_shift_readings(date, text) is
  'Load shift nozzles, cash/phone/credit/expense, rates, daily meters, suggested openings, attendance hints.';

-- ─── get_meter_sales_breakdown ──────────────────────────────────────────────

create or replace function public.get_meter_sales_breakdown(
  p_start date,
  p_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();

  if p_start is null or p_end is null then
    raise exception 'Start and end dates are required';
  end if;
  if p_end < p_start then
    raise exception 'End date must be on or after start date';
  end if;

  return (
    with readings as (
      select
        r.reading_date,
        r.shift,
        r.product,
        r.pump_no,
        r.employee_id,
        greatest(r.closing_meter - r.opening_meter, 0) as litres,
        greatest(r.closing_meter - r.opening_meter - r.testing_litres, 0) as net_litres
      from public.meter_shift_readings r
      where r.reading_date between p_start and p_end
    )
    select jsonb_build_object(
      'start', p_start,
      'end', p_end,
      'by_pump', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.shift, t.product, t.pump_no)
        from (
          select reading_date, shift, product, pump_no,
            sum(litres) as litres, sum(net_litres) as net_litres
          from readings
          group by reading_date, shift, product, pump_no
        ) t
      ), '[]'::jsonb),
      'by_shift', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.shift, t.product)
        from (
          select reading_date, shift, product,
            sum(litres) as litres, sum(net_litres) as net_litres,
            count(distinct employee_id) as staff_count
          from readings
          group by reading_date, shift, product
        ) t
      ), '[]'::jsonb),
      'by_salesman', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.employee_name, t.shift)
        from (
          select
            r.reading_date,
            r.shift,
            r.employee_id,
            e.name as employee_name,
            sum(case when r.product = 'petrol' then r.litres else 0 end) as petrol_litres,
            sum(case when r.product = 'diesel' then r.litres else 0 end) as diesel_litres,
            sum(case when r.product = 'petrol' then r.net_litres else 0 end) as petrol_net_litres,
            sum(case when r.product = 'diesel' then r.net_litres else 0 end) as diesel_net_litres,
            sum(r.litres) as total_litres,
            sum(r.net_litres) as net_litres,
            coalesce(max(c.cash_collected), 0) as cash_collected,
            coalesce(max(c.phone_pay), 0) as phone_pay,
            coalesce(max(c.credit_amount), 0) as credit_amount,
            coalesce(max(c.expense_amount), 0) as expense_amount,
            coalesce(max(c.cash_collected), 0) + coalesce(max(c.phone_pay), 0)
              + coalesce(max(c.credit_amount), 0) + coalesce(max(c.expense_amount), 0) as total_collected
          from readings r
          left join public.employees e on e.id = r.employee_id
          left join public.meter_shift_cash c
            on c.reading_date = r.reading_date
            and c.shift = r.shift
            and c.employee_id = r.employee_id
          group by r.reading_date, r.shift, r.employee_id, e.name
        ) t
      ), '[]'::jsonb),
      'daily_pump', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.date desc, t.product)
        from (
          (
            select distinct on (p.date)
              p.date, 'petrol'::text as product,
              p.sales_pump1, p.sales_pump2, p.total_sales, p.testing
            from public.dsr_petrol p
            where p.date between p_start and p_end
            order by p.date, p.created_at desc
          )
          union all
          (
            select distinct on (d.date)
              d.date, 'diesel'::text as product,
              d.sales_pump1, d.sales_pump2, d.total_sales, d.testing
            from public.dsr_diesel d
            where d.date between p_start and p_end
            order by d.date, d.created_at desc
          )
        ) t
      ), '[]'::jsonb)
    )
  );
end;
$$;

comment on function public.get_meter_sales_breakdown(date, date) is
  'Pump / shift / salesman aggregates (cash + phone + credit + expense + total) plus daily pump columns.';

-- ─── Day closing: include shift credit / expense in credit_today / expenses_today

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

  select coalesce(sum(amount), 0) into v_collection
  from public.credit_payments where date = p_date;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  select coalesce(sum(amount), 0) into v_credit_ledger
  from public.credit_entries where transaction_date = p_date;
  select v_credit_ledger + coalesce((
    select sum(c.amount_due) from public.credit_customers c
    where c.date = p_date
      and not exists (select 1 from public.credit_entries e where e.credit_customer_id = c.id)
  ), 0) into v_credit_ledger;

  select coalesce(sum(credit_amount), 0) into v_credit_shift
  from public.meter_shift_cash where reading_date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(expense_amount), 0) into v_expenses_shift
  from public.meter_shift_cash where reading_date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_ledger, 0) + coalesce(v_credit_shift, 0),
    'expenses_today', coalesce(v_expenses_ledger, 0) + coalesce(v_expenses_shift, 0),
    'credit_ledger', coalesce(v_credit_ledger, 0),
    'credit_shift', coalesce(v_credit_shift, 0),
    'expenses_ledger', coalesce(v_expenses_ledger, 0),
    'expenses_shift', coalesce(v_expenses_shift, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Shared day-closing totals. Credit/expenses = ledger + shift register. Total sale uses gross DSR litres (incl. testing).';

grant execute on function public.save_meter_shift_readings(date, text, jsonb, jsonb) to authenticated;
grant execute on function public.get_meter_shift_readings(date, text) to authenticated;
grant execute on function public.get_meter_sales_breakdown(date, date) to authenticated;
grant execute on function public.compute_day_closing_components(date) to authenticated;

-- Pass ledger vs shift breakdown through to the day closing UI
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_components jsonb;
  v_existing record;
  v_collection_ref text;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_night_cash_collected boolean := false;
  v_certified boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_live numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
begin
  perform public.require_staff_access();

  select dc.total_sale, dc.collection, dc.short_previous, dc.credit_today, dc.expenses_today,
         dc.night_cash, dc.phone_pay, dc.short_today, dc.closing_reference, dc.remarks,
         dc.certified, dc.certified_at, dc.certified_by_name,
         dc.night_cash_collection_id, ncc.collection_reference
  into v_existing
  from public.day_closing dc
  left join public.night_cash_collections ncc on ncc.id = dc.night_cash_collection_id
  where dc.date = p_date
  limit 1;

  v_already_saved := found;
  v_night_cash_collected := v_already_saved and v_existing.night_cash_collection_id is not null;
  v_certified := v_already_saved and coalesce(v_existing.certified, false);
  v_collection_ref := v_existing.collection_reference;
  v_can_overwrite := v_already_saved and (
    public.is_admin()
    or (not v_night_cash_collected and not v_certified)
  );
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

  if v_use_snapshot then
    select coalesce(sum(amount), 0) into v_expenses_live
    from public.expenses where date = p_date;

    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
    v_components := public.compute_day_closing_components(p_date);
  else
    v_components := public.compute_day_closing_components(p_date);
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_live := coalesce((v_components->>'expenses_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_live,
    'credit_ledger', coalesce((v_components->>'credit_ledger')::numeric, 0),
    'credit_shift', coalesce((v_components->>'credit_shift')::numeric, 0),
    'expenses_ledger', coalesce((v_components->>'expenses_ledger')::numeric, 0),
    'expenses_shift', coalesce((v_components->>'expenses_shift')::numeric, 0),
    'night_cash', case when v_already_saved then coalesce(v_existing.night_cash, 0) else null end,
    'phone_pay', case when v_already_saved then coalesce(v_existing.phone_pay, 0) else null end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite,
    'night_cash_collected', v_night_cash_collected,
    'night_cash_collection_reference', v_collection_ref,
    'certified', v_certified,
    'certified_at', case when v_certified then v_existing.certified_at else null end,
    'certified_by_name', case when v_certified then v_existing.certified_by_name else null end,
    'can_certify', v_already_saved and not v_certified and public.is_admin()
  );
end;
$$;

comment on function public.get_day_closing_breakdown(date) is
  'Returns day closing components (incl. ledger vs shift credit/expense). Supervisors may edit until certified or night cash is collected; after either, only admins may edit.';

grant execute on function public.get_day_closing_breakdown(date) to authenticated;
