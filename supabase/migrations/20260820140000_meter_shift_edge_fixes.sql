-- Edge-case fixes for meter shift ↔ daily sync and salesman expected cash.
-- Depends on 20260820120000 + 20260820130000.

-- ─── Helpers ────────────────────────────────────────────────────────────────

create or replace function public.meter_day_is_locked(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.day_closing dc
    where dc.date = p_date
      and (
        coalesce(dc.certified, false)
        or dc.night_cash_collection_id is not null
      )
  );
$$;

comment on function public.meter_day_is_locked(date) is
  'True when day closing is certified or night cash collected — meter sync requires admin.';

grant execute on function public.meter_day_is_locked(date) to authenticated;

create or replace function public.require_meter_day_writable(p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.meter_day_is_locked(p_date) and not public.is_admin() then
    raise exception
      'Day % is locked (certified or night cash collected). Only an admin can change meters.',
      p_date;
  end if;
end;
$$;

grant execute on function public.require_meter_day_writable(date) to authenticated;

-- ─── save_meter_shift_readings ──────────────────────────────────────────────
-- - Block non-admin on locked days
-- - Refuse empty save that would wipe existing nozzles (use Clear shift)
-- - Afternoon handoff: opening must match morning closing when morning exists
-- - Cash rows require active staff

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
  v_kept_nozzles int := 0;
  v_kept_cash int := 0;
  v_keys text[] := array[]::text[];
  v_emp_ids uuid[] := array[]::uuid[];
  v_existing_count int;
  v_morning_close numeric;
begin
  perform public.require_staff_access();
  perform public.require_meter_day_writable(p_date);

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

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

  -- Upsert assigned nozzles
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

    -- Afternoon handoff: opening must equal morning closing when morning row exists
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

  -- Remove nozzles cleared in the form for this date+shift
  delete from public.meter_shift_readings r
  where r.reading_date = p_date
    and r.shift = v_shift
    and not (
      (r.product || ':' || r.pump_no::text || ':' || r.nozzle_no::text) = any (v_keys)
    );

  -- Upsert cash rows (only for employees who have nozzle assignments or explicit cash)
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
    if v_cash_amt < 0 then
      raise exception 'Cash collected must be >= 0';
    end if;
    v_remarks := nullif(btrim(coalesce(v_row->>'remarks', '')), '');

    insert into public.meter_shift_cash (
      reading_date, shift, employee_id, cash_collected, remarks, created_by, updated_at
    )
    values (
      p_date, v_shift, v_employee, v_cash_amt, v_remarks, v_uid,
      timezone('utc'::text, now())
    )
    on conflict (reading_date, shift, employee_id)
    do update set
      cash_collected = excluded.cash_collected,
      remarks = excluded.remarks,
      updated_at = timezone('utc'::text, now());

    v_emp_ids := array_append(v_emp_ids, v_employee);
    v_kept_cash := v_kept_cash + 1;
  end loop;

  -- Drop cash for staff no longer assigned and not in payload
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
  'Upsert shift nozzle + cash rows; enforces handoff, locked-day gate, and refuses empty wipe.';

-- ─── delete_meter_shift_readings: re-sync daily from remaining shifts ───────

create or replace function public.delete_meter_shift_readings(
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
  v_n int;
  v_c int;
  v_sync jsonb;
begin
  perform public.require_staff_access();
  if not public.is_admin() then
    raise exception 'Only admin can delete shift readings';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  delete from public.meter_shift_readings
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_n = row_count;

  delete from public.meter_shift_cash
  where reading_date = p_date and shift = v_shift;
  get diagnostics v_c = row_count;

  -- Recompute daily meters from whatever shifts remain
  v_sync := public.sync_dsr_meters_from_shifts(p_date);

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'daily_sync', v_sync
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzle/cash for date+shift, then re-sync daily meters from remaining shifts.';

-- ─── sync_dsr_meters_from_shifts ────────────────────────────────────────────
-- Daily sales = sum of shift nozzle deltas (avoids handoff-gap inflation).
-- Open/close still morning open → afternoon close for continuity display.
-- Locked-day gate for non-admin. Testing = max(existing daily, shift sum).

create or replace function public.sync_dsr_meters_from_shifts(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_product text;
  v_o11 numeric; v_o12 numeric; v_o21 numeric; v_o22 numeric;
  v_c11 numeric; v_c12 numeric; v_c21 numeric; v_c22 numeric;
  v_test numeric;
  v_shift_sales numeric;
  v_s1 numeric; v_s2 numeric; v_total numeric;
  v_existing_id uuid;
  v_existing_testing numeric;
  v_touched text[] := array[]::text[];
  v_has_any boolean;
  v_has_afternoon boolean;
begin
  perform public.require_staff_access();
  perform public.require_meter_day_writable(p_date);

  if p_date is null then
    raise exception 'Date is required';
  end if;

  select exists(
    select 1 from public.meter_shift_readings
    where reading_date = p_date and shift = 'afternoon'
  )
  into v_has_afternoon;

  foreach v_product in array array['petrol', 'diesel']
  loop
    v_existing_id := null;
    v_existing_testing := null;
    v_o11 := null; v_o12 := null; v_o21 := null; v_o22 := null;
    v_c11 := null; v_c12 := null; v_c21 := null; v_c22 := null;
    v_test := 0;
    v_shift_sales := 0;
    v_has_any := false;

    select
      q.has_any,
      coalesce(q.o11_m, q.o11_a),
      coalesce(q.o12_m, q.o12_a),
      coalesce(q.o21_m, q.o21_a),
      coalesce(q.o22_m, q.o22_a),
      coalesce(q.c11_a, q.c11_m),
      coalesce(q.c12_a, q.c12_m),
      coalesce(q.c21_a, q.c21_m),
      coalesce(q.c22_a, q.c22_m),
      q.testing,
      q.shift_sales
    into
      v_has_any,
      v_o11, v_o12, v_o21, v_o22,
      v_c11, v_c12, v_c21, v_c22,
      v_test,
      v_shift_sales
    from (
      select
        count(*) > 0 as has_any,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 1) as o11_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 1) as o11_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 2) as o12_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 2) as o12_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 1) as o21_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 1) as o21_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 2) as o22_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 2) as o22_a,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 1) as c11_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 1) as c11_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 2) as c12_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 2) as c12_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 1) as c21_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 1) as c21_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 2) as c22_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 2) as c22_m,
        coalesce(sum(r.testing_litres), 0) as testing,
        coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)), 0) as shift_sales
      from public.meter_shift_readings r
      where r.reading_date = p_date
        and r.product = v_product
        and r.pump_no in (1, 2)
        and r.nozzle_no in (1, 2)
    ) q;

    if not coalesce(v_has_any, false) then
      continue;
    end if;

    v_c11 := coalesce(v_c11, v_o11);
    v_c12 := coalesce(v_c12, v_o12);
    v_c21 := coalesce(v_c21, v_o21);
    v_c22 := coalesce(v_c22, v_o22);

    if v_product = 'petrol' then
      select id,
        coalesce(v_o11, opening_pump1_nozzle1),
        coalesce(v_o12, opening_pump1_nozzle2),
        coalesce(v_o21, opening_pump2_nozzle1),
        coalesce(v_o22, opening_pump2_nozzle2),
        coalesce(v_c11, closing_pump1_nozzle1),
        coalesce(v_c12, closing_pump1_nozzle2),
        coalesce(v_c21, closing_pump2_nozzle1),
        coalesce(v_c22, closing_pump2_nozzle2),
        testing
      into
        v_existing_id,
        v_o11, v_o12, v_o21, v_o22,
        v_c11, v_c12, v_c21, v_c22,
        v_existing_testing
      from public.dsr_petrol
      where date = p_date
      order by created_at desc
      limit 1;

      v_o11 := coalesce(v_o11, 0); v_o12 := coalesce(v_o12, 0);
      v_o21 := coalesce(v_o21, 0); v_o22 := coalesce(v_o22, 0);
      v_c11 := coalesce(v_c11, v_o11); v_c12 := coalesce(v_c12, v_o12);
      v_c21 := coalesce(v_c21, v_o21); v_c22 := coalesce(v_c22, v_o22);

      -- Prefer sum of shift sales so handoff gaps do not inflate daily totals.
      -- When only one shift exists, open→close span matches that shift.
      v_total := coalesce(v_shift_sales, 0);
      if v_has_afternoon then
        -- Split pump sales proportionally from nozzle-level shift sums already in v_total;
        -- attribute by pump from shift rows.
        select
          coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 1), 0),
          coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 2), 0)
        into v_s1, v_s2
        from public.meter_shift_readings r
        where r.reading_date = p_date
          and r.product = v_product
          and r.pump_no in (1, 2)
          and r.nozzle_no in (1, 2);
      else
        v_s1 := greatest(v_c11 - v_o11, 0) + greatest(v_c12 - v_o12, 0);
        v_s2 := greatest(v_c21 - v_o21, 0) + greatest(v_c22 - v_o22, 0);
        v_total := v_s1 + v_s2;
      end if;
      v_total := coalesce(v_s1, 0) + coalesce(v_s2, 0);

      -- Keep manually higher daily testing; otherwise take shift sum
      v_test := greatest(coalesce(v_existing_testing, 0), coalesce(v_test, 0));

      if v_existing_id is not null then
        update public.dsr_petrol set
          opening_pump1_nozzle1 = v_o11,
          opening_pump1_nozzle2 = v_o12,
          opening_pump2_nozzle1 = v_o21,
          opening_pump2_nozzle2 = v_o22,
          closing_pump1_nozzle1 = v_c11,
          closing_pump1_nozzle2 = v_c12,
          closing_pump2_nozzle1 = v_c21,
          closing_pump2_nozzle2 = v_c22,
          sales_pump1 = v_s1,
          sales_pump2 = v_s2,
          total_sales = v_total,
          testing = v_test
        where id = v_existing_id;
      else
        insert into public.dsr_petrol (
          date,
          opening_pump1_nozzle1, opening_pump1_nozzle2,
          opening_pump2_nozzle1, opening_pump2_nozzle2,
          closing_pump1_nozzle1, closing_pump1_nozzle2,
          closing_pump2_nozzle1, closing_pump2_nozzle2,
          sales_pump1, sales_pump2, total_sales, testing,
          dip_reading, stock, receipts, created_by
        ) values (
          p_date,
          v_o11, v_o12, v_o21, v_o22,
          v_c11, v_c12, v_c21, v_c22,
          v_s1, v_s2, v_total, v_test,
          0, 0, 0, v_uid
        );
      end if;
    else
      select id,
        coalesce(v_o11, opening_pump1_nozzle1),
        coalesce(v_o12, opening_pump1_nozzle2),
        coalesce(v_o21, opening_pump2_nozzle1),
        coalesce(v_o22, opening_pump2_nozzle2),
        coalesce(v_c11, closing_pump1_nozzle1),
        coalesce(v_c12, closing_pump1_nozzle2),
        coalesce(v_c21, closing_pump2_nozzle1),
        coalesce(v_c22, closing_pump2_nozzle2),
        testing
      into
        v_existing_id,
        v_o11, v_o12, v_o21, v_o22,
        v_c11, v_c12, v_c21, v_c22,
        v_existing_testing
      from public.dsr_diesel
      where date = p_date
      order by created_at desc
      limit 1;

      v_o11 := coalesce(v_o11, 0); v_o12 := coalesce(v_o12, 0);
      v_o21 := coalesce(v_o21, 0); v_o22 := coalesce(v_o22, 0);
      v_c11 := coalesce(v_c11, v_o11); v_c12 := coalesce(v_c12, v_o12);
      v_c21 := coalesce(v_c21, v_o21); v_c22 := coalesce(v_c22, v_o22);

      if v_has_afternoon then
        select
          coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 1), 0),
          coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 2), 0)
        into v_s1, v_s2
        from public.meter_shift_readings r
        where r.reading_date = p_date
          and r.product = v_product
          and r.pump_no in (1, 2)
          and r.nozzle_no in (1, 2);
      else
        v_s1 := greatest(v_c11 - v_o11, 0) + greatest(v_c12 - v_o12, 0);
        v_s2 := greatest(v_c21 - v_o21, 0) + greatest(v_c22 - v_o22, 0);
      end if;
      v_total := coalesce(v_s1, 0) + coalesce(v_s2, 0);
      v_test := greatest(coalesce(v_existing_testing, 0), coalesce(v_test, 0));

      if v_existing_id is not null then
        update public.dsr_diesel set
          opening_pump1_nozzle1 = v_o11,
          opening_pump1_nozzle2 = v_o12,
          opening_pump2_nozzle1 = v_o21,
          opening_pump2_nozzle2 = v_o22,
          closing_pump1_nozzle1 = v_c11,
          closing_pump1_nozzle2 = v_c12,
          closing_pump2_nozzle1 = v_c21,
          closing_pump2_nozzle2 = v_c22,
          sales_pump1 = v_s1,
          sales_pump2 = v_s2,
          total_sales = v_total,
          testing = v_test
        where id = v_existing_id;
      else
        insert into public.dsr_diesel (
          date,
          opening_pump1_nozzle1, opening_pump1_nozzle2,
          opening_pump2_nozzle1, opening_pump2_nozzle2,
          closing_pump1_nozzle1, closing_pump1_nozzle2,
          closing_pump2_nozzle1, closing_pump2_nozzle2,
          sales_pump1, sales_pump2, total_sales, testing,
          dip_reading, stock, receipts, created_by
        ) values (
          p_date,
          v_o11, v_o12, v_o21, v_o22,
          v_c11, v_c12, v_c21, v_c22,
          v_s1, v_s2, v_total, v_test,
          0, 0, 0, v_uid
        );
      end if;
    end if;

    v_touched := array_append(v_touched, v_product);
  end loop;

  return jsonb_build_object(
    'date', p_date,
    'synced_products', to_jsonb(v_touched)
  );
end;
$$;

comment on function public.sync_dsr_meters_from_shifts(date) is
  'Roll shift nozzle meters into daily dsr_*; sales = sum of shift deltas; respects locked days.';

-- ─── sync_shift_meters_from_dsr ─────────────────────────────────────────────
-- Never push daily closing into morning when afternoon is absent (mid-day trap).
-- Only push openings to morning; closings to afternoon when it exists.

create or replace function public.sync_shift_meters_from_dsr(
  p_date date,
  p_shift text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_has_afternoon boolean;
  v_updated int := 0;
  v_n int;
begin
  perform public.require_staff_access();
  perform public.require_meter_day_writable(p_date);

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select exists(
    select 1 from public.meter_shift_readings
    where reading_date = p_date and shift = 'afternoon'
  )
  into v_has_afternoon;

  -- Morning: align openings from daily; never overwrite closings with end-of-day
  with daily as (
    (
      select 'petrol'::text as product,
        p.opening_pump1_nozzle1 as o11, p.opening_pump1_nozzle2 as o12,
        p.opening_pump2_nozzle1 as o21, p.opening_pump2_nozzle2 as o22
      from public.dsr_petrol p
      where p.date = p_date
      order by p.created_at desc
      limit 1
    )
    union all
    (
      select 'diesel'::text,
        d.opening_pump1_nozzle1, d.opening_pump1_nozzle2,
        d.opening_pump2_nozzle1, d.opening_pump2_nozzle2
      from public.dsr_diesel d
      where d.date = p_date
      order by d.created_at desc
      limit 1
    )
  ),
  nozzles as (
    select product, 1::smallint as pump_no, 1::smallint as nozzle_no, o11 as opening from daily
    union all select product, 1, 2, o12 from daily
    union all select product, 2, 1, o21 from daily
    union all select product, 2, 2, o22 from daily
  )
  update public.meter_shift_readings r set
    opening_meter = coalesce(n.opening, r.opening_meter),
    closing_meter = greatest(r.closing_meter, coalesce(n.opening, r.opening_meter)),
    updated_at = timezone('utc'::text, now())
  from nozzles n
  where r.reading_date = p_date
    and r.shift = 'morning'
    and r.product = n.product
    and r.pump_no = n.pump_no
    and r.nozzle_no = n.nozzle_no
    and (v_shift is null or v_shift = 'morning');

  get diagnostics v_n = row_count;
  v_updated := v_updated + coalesce(v_n, 0);

  if v_has_afternoon and (v_shift is null or v_shift = 'afternoon') then
    with daily as (
      (
        select 'petrol'::text as product,
          p.closing_pump1_nozzle1 as c11, p.closing_pump1_nozzle2 as c12,
          p.closing_pump2_nozzle1 as c21, p.closing_pump2_nozzle2 as c22
        from public.dsr_petrol p
        where p.date = p_date
        order by p.created_at desc
        limit 1
      )
      union all
      (
        select 'diesel'::text,
          d.closing_pump1_nozzle1, d.closing_pump1_nozzle2,
          d.closing_pump2_nozzle1, d.closing_pump2_nozzle2
        from public.dsr_diesel d
        where d.date = p_date
        order by d.created_at desc
        limit 1
      )
    ),
    nozzles as (
      select product, 1::smallint as pump_no, 1::smallint as nozzle_no, c11 as closing from daily
      union all select product, 1, 2, c12 from daily
      union all select product, 2, 1, c21 from daily
      union all select product, 2, 2, c22 from daily
    )
    update public.meter_shift_readings r set
      closing_meter = greatest(coalesce(n.closing, r.closing_meter), r.opening_meter),
      updated_at = timezone('utc'::text, now())
    from nozzles n
    where r.reading_date = p_date
      and r.shift = 'afternoon'
      and r.product = n.product
      and r.pump_no = n.pump_no
      and r.nozzle_no = n.nozzle_no;

    get diagnostics v_n = row_count;
    v_updated := v_updated + coalesce(v_n, 0);
  end if;

  -- Afternoon opening = morning closing (handoff continuity)
  if v_shift is null or v_shift = 'afternoon' then
    update public.meter_shift_readings aft set
      opening_meter = m.closing_meter,
      closing_meter = greatest(aft.closing_meter, m.closing_meter),
      updated_at = timezone('utc'::text, now())
    from public.meter_shift_readings m
    where aft.reading_date = p_date
      and aft.shift = 'afternoon'
      and m.reading_date = p_date
      and m.shift = 'morning'
      and m.product = aft.product
      and m.pump_no = aft.pump_no
      and m.nozzle_no = aft.nozzle_no;

    get diagnostics v_n = row_count;
    v_updated := v_updated + coalesce(v_n, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'ok', true,
    'rows_touched', v_updated
  );
end;
$$;

comment on function public.sync_shift_meters_from_dsr(date, text) is
  'Push daily openings into morning and daily closings into afternoon only; handoff afternoon open from morning close.';

-- ─── get_meter_sales_breakdown: expose net litres per product for expected ₹ ─

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
            coalesce(max(c.cash_collected), 0) as cash_collected
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
  'Pump / shift / salesman aggregates (incl. net litres per fuel) plus daily pump columns.';
