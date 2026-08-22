-- Staff shift cash: hard cash + phone pay (UPI), total = cash + phone pay.
-- Short = expected − total. Existing cash_collected rows stay as hard cash.

alter table public.meter_shift_cash
  add column if not exists phone_pay numeric(14, 2) not null default 0
    check (phone_pay >= 0);

comment on table public.meter_shift_cash is
  'Staff handover per shift: hard cash + phone pay (UPI). Total = cash_collected + phone_pay. Short = expected − total.';

comment on column public.meter_shift_cash.cash_collected is
  'Hard cash handed over by staff for the shift (₹).';

comment on column public.meter_shift_cash.phone_pay is
  'PhonePe / UPI collected by staff for the shift (₹).';

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
  v_kept_nozzles int := 0;
  v_kept_cash int := 0;
  v_keys text[] := array[]::text[];
  v_emp_ids uuid[] := array[]::uuid[];
  v_existing_count int;
  v_morning_close numeric;
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
    if v_cash_amt < 0 then
      raise exception 'Cash collected must be >= 0';
    end if;
    if v_phone_pay < 0 then
      raise exception 'Phone pay must be >= 0';
    end if;
    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_cash (
      reading_date, shift, employee_id, cash_collected, phone_pay, remarks, created_by, updated_at
    )
    values (
      p_date, v_shift, v_employee, v_cash_amt, v_phone_pay, v_remarks, v_uid,
      timezone('utc'::text, now())
    )
    on conflict (reading_date, shift, employee_id)
    do update set
      cash_collected = excluded.cash_collected,
      phone_pay = excluded.phone_pay,
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

  return public.get_meter_shift_readings(p_date, v_shift)
    || jsonb_build_object(
      'saved_nozzles', v_kept_nozzles,
      'saved_cash', v_kept_cash
    );
end;
$$;



comment on function public.save_meter_shift_readings(date, text, jsonb, jsonb) is
  'Upsert shift nozzle + cash/phone-pay rows; per-shift past-day lock; refuses empty wipe.';

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
      'total_sales', v_petrol.total_sales
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
      'total_sales', v_diesel.total_sales
    ) else null end
  );

  -- Suggested openings: prior shift closings first
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
    -- Same-day daily openings, then prior-day daily closings (fill gaps only)
    if v_daily_meters->'petrol' is not null then
      v_suggested := v_suggested || jsonb_strip_nulls(jsonb_build_object(
        'petrol:1:1', coalesce(v_suggested->'petrol:1:1', v_daily_meters->'petrol'->'opening_pump1_nozzle1'),
        'petrol:1:2', coalesce(v_suggested->'petrol:1:2', v_daily_meters->'petrol'->'opening_pump1_nozzle2'),
        'petrol:2:1', coalesce(v_suggested->'petrol:2:1', v_daily_meters->'petrol'->'opening_pump2_nozzle1'),
        'petrol:2:2', coalesce(v_suggested->'petrol:2:2', v_daily_meters->'petrol'->'opening_pump2_nozzle2')
      ));
    end if;
    if v_daily_meters->'diesel' is not null then
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
  -- Afternoon: only prior/morning closings (already in v_suggested). Do NOT
  -- fall back to same-day daily openings — those are start-of-day meters.

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
        'has_row', v_petrol.id is not null
      ),
      'diesel', jsonb_build_object(
        'total_sales', coalesce(v_diesel.total_sales, 0),
        'testing', coalesce(v_diesel.testing, 0),
        'has_row', v_diesel.id is not null
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
          'total_collected', coalesce(c.cash_collected, 0) + coalesce(c.phone_pay, 0),
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
  'Load shift nozzles, cash/phone-pay, rates, daily meters, suggested openings, and attendance hints.';

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
        select jsonb_agg(to_jsonb(t) order by t.reading_date desc, t.product, t.pump_no)
        from (
          select reading_date, product, pump_no,
            sum(litres) as litres, sum(net_litres) as net_litres
          from readings
          group by reading_date, product, pump_no
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
            coalesce(max(c.cash_collected), 0) + coalesce(max(c.phone_pay), 0) as total_collected
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
  'Pump / shift / salesman aggregates (cash + phone pay + total) plus daily pump columns.';

grant execute on function public.save_meter_shift_readings(date, text, jsonb, jsonb) to authenticated;
grant execute on function public.get_meter_shift_readings(date, text) to authenticated;
grant execute on function public.get_meter_sales_breakdown(date, date) to authenticated;
