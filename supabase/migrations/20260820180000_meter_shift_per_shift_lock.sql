-- Per-shift past-day lock: saving morning must not lock an empty afternoon.
-- Supervisors may still fill the other shift on a past date; re-editing a shift
-- that already has rows is blocked once a completed daily sheet exists.
-- Sync only checks day-closing lock (certified / night cash).

drop function if exists public.meter_shift_lock_info(date);

create or replace function public.meter_shift_has_readings(p_date date, p_shift text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.meter_shift_readings r
    where r.reading_date = p_date
      and r.shift = lower(btrim(coalesce(p_shift, '')))
  );
$$;

comment on function public.meter_shift_has_readings(date, text) is
  'True when the given date+shift already has nozzle rows.';

grant execute on function public.meter_shift_has_readings(date, text) to authenticated;

create or replace function public.meter_shift_lock_info(
  p_date date,
  p_shift text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_day_locked boolean := false;
  v_past_closed boolean := false;
  v_shift text;
  v_shift_has_data boolean := false;
  v_today date := public.meter_station_today();
  v_reason text := null;
  v_readonly boolean := false;
begin
  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  v_day_locked := public.meter_day_is_locked(p_date);
  v_past_closed :=
    p_date < v_today
    and public.meter_day_has_daily_entry(p_date);

  if v_shift is not null then
    v_shift_has_data := public.meter_shift_has_readings(p_date, v_shift);
  end if;

  if v_day_locked and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'Day closing is certified or night cash is collected. Only an admin can change meters.';
  elsif v_past_closed and v_shift is not null and v_shift_has_data and not public.is_admin() then
    -- Only lock shifts that already have data — empty afternoon stays editable
    v_readonly := true;
    v_reason :=
      'This shift is already saved for a past date with daily meters. Only an admin can change it.';
  elsif v_past_closed and v_shift is null and not public.is_admin() then
    -- Date-level probe without shift: not fully readonly (afternoon may still be open)
    v_readonly := false;
    v_reason := null;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'today', v_today,
    'day_locked', v_day_locked,
    'past_closed', v_past_closed,
    'shift_has_data', v_shift_has_data,
    'has_daily_entry', public.meter_day_has_daily_entry(p_date),
    'supervisor_readonly', v_readonly,
    'admin_can_edit', public.is_admin(),
    'lock_reason', v_reason
  );
end;
$$;

comment on function public.meter_shift_lock_info(date, text) is
  'Shift register lock: certified day, or past+completed-daily only for shifts that already have rows.';

grant execute on function public.meter_shift_lock_info(date, text) to authenticated;

-- Sync / daily push: only block certified / night-cash days (not past+daily).
create or replace function public.require_meter_day_writable(p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return;
  end if;

  if public.meter_day_is_locked(p_date) then
    raise exception
      'Day % is locked (certified or night cash collected). Only an admin can change meters.',
      p_date;
  end if;
end;
$$;

comment on function public.require_meter_day_writable(date) is
  'Non-admins blocked when day closing is certified or night cash is collected.';

-- Shift save: also block re-editing an existing shift on a past day with completed daily.
create or replace function public.require_meter_shift_writable(p_date date, p_shift text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
begin
  perform public.require_meter_day_writable(p_date);

  if public.is_admin() then
    return;
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  if p_date < public.meter_station_today()
     and public.meter_day_has_daily_entry(p_date)
     and public.meter_shift_has_readings(p_date, v_shift) then
    raise exception
      'Shift % for % is already saved. Only an admin can change it on a past date with daily meters.',
      v_shift, p_date;
  end if;
end;
$$;

comment on function public.require_meter_shift_writable(date, text) is
  'Supervisors cannot re-edit an existing shift on a past date once daily MS/HSD is completed.';

grant execute on function public.require_meter_shift_writable(date, text) to authenticated;

-- Wire save to per-shift gate
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
  'Upsert shift nozzle + cash rows; per-shift past-day lock; refuses empty wipe.';
