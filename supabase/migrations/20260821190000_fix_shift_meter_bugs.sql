-- Fix shift/daily meter bugs:
-- 1) Complete sheet = rate + (dip or stock) — rate-only / receipts-only no longer lock
-- 2) Push shift rollup meters into existing dsr_* rows (no stub inserts)
-- 3) DSR update WITH CHECK re-enforces day lock on the new date

-- ─── 1) Tighten completeness ────────────────────────────────────────────────

create or replace function public.dsr_meter_row_is_complete(
  p_selling_rate numeric,
  p_dip_reading numeric,
  p_stock numeric,
  p_receipts numeric
)
returns boolean
language sql
immutable
as $$
  select
    (p_selling_rate is not null and p_selling_rate > 0)
    and (
      coalesce(p_dip_reading, 0) <> 0
      or coalesce(p_stock, 0) > 0
    );
$$;

comment on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) is
  'True when daily meter sheet is finished: selling rate set and dip or stock entered. Receipts/rate alone do not count.';

-- ─── 2) Apply shift aggregate → existing DSR meter columns only ─────────────

create or replace function public.apply_shift_aggregate_to_dsr(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agg jsonb;
  v_block jsonb;
  v_updated text[] := array[]::text[];
  v_id uuid;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  if public.meter_day_is_locked(p_date) and not public.is_admin() then
    return jsonb_build_object(
      'date', p_date,
      'updated', '[]'::jsonb,
      'skipped_locked', true
    );
  end if;

  v_agg := public.get_shift_aggregated_daily_meters(p_date);

  v_block := v_agg->'petrol';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select p.id into v_id
    from public.dsr_petrol p
    where p.date = p_date
    order by p.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_petrol p set
        opening_pump1_nozzle1 = coalesce((v_block->>'opening_pump1_nozzle1')::numeric, p.opening_pump1_nozzle1),
        opening_pump1_nozzle2 = coalesce((v_block->>'opening_pump1_nozzle2')::numeric, p.opening_pump1_nozzle2),
        opening_pump2_nozzle1 = coalesce((v_block->>'opening_pump2_nozzle1')::numeric, p.opening_pump2_nozzle1),
        opening_pump2_nozzle2 = coalesce((v_block->>'opening_pump2_nozzle2')::numeric, p.opening_pump2_nozzle2),
        closing_pump1_nozzle1 = coalesce((v_block->>'closing_pump1_nozzle1')::numeric, p.closing_pump1_nozzle1),
        closing_pump1_nozzle2 = coalesce((v_block->>'closing_pump1_nozzle2')::numeric, p.closing_pump1_nozzle2),
        closing_pump2_nozzle1 = coalesce((v_block->>'closing_pump2_nozzle1')::numeric, p.closing_pump2_nozzle1),
        closing_pump2_nozzle2 = coalesce((v_block->>'closing_pump2_nozzle2')::numeric, p.closing_pump2_nozzle2),
        sales_pump1 = coalesce((v_block->>'sales_pump1')::numeric, 0),
        sales_pump2 = coalesce((v_block->>'sales_pump2')::numeric, 0),
        total_sales = coalesce((v_block->>'total_sales')::numeric, 0),
        testing = coalesce((v_block->>'testing')::numeric, 0)
      where p.id = v_id;
      v_updated := array_append(v_updated, 'petrol');
    end if;
  end if;

  v_block := v_agg->'diesel';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select d.id into v_id
    from public.dsr_diesel d
    where d.date = p_date
    order by d.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_diesel d set
        opening_pump1_nozzle1 = coalesce((v_block->>'opening_pump1_nozzle1')::numeric, d.opening_pump1_nozzle1),
        opening_pump1_nozzle2 = coalesce((v_block->>'opening_pump1_nozzle2')::numeric, d.opening_pump1_nozzle2),
        opening_pump2_nozzle1 = coalesce((v_block->>'opening_pump2_nozzle1')::numeric, d.opening_pump2_nozzle1),
        opening_pump2_nozzle2 = coalesce((v_block->>'opening_pump2_nozzle2')::numeric, d.opening_pump2_nozzle2),
        closing_pump1_nozzle1 = coalesce((v_block->>'closing_pump1_nozzle1')::numeric, d.closing_pump1_nozzle1),
        closing_pump1_nozzle2 = coalesce((v_block->>'closing_pump1_nozzle2')::numeric, d.closing_pump1_nozzle2),
        closing_pump2_nozzle1 = coalesce((v_block->>'closing_pump2_nozzle1')::numeric, d.closing_pump2_nozzle1),
        closing_pump2_nozzle2 = coalesce((v_block->>'closing_pump2_nozzle2')::numeric, d.closing_pump2_nozzle2),
        sales_pump1 = coalesce((v_block->>'sales_pump1')::numeric, 0),
        sales_pump2 = coalesce((v_block->>'sales_pump2')::numeric, 0),
        total_sales = coalesce((v_block->>'total_sales')::numeric, 0),
        testing = coalesce((v_block->>'testing')::numeric, 0)
      where d.id = v_id;
      v_updated := array_append(v_updated, 'diesel');
    end if;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'updated', to_jsonb(v_updated),
    'skipped_locked', false
  );
end;
$$;

comment on function public.apply_shift_aggregate_to_dsr(date) is
  'Update meter columns on existing dsr_* rows from shift rollup. Never inserts stubs; leaves dip/stock/rate/remarks alone.';

grant execute on function public.apply_shift_aggregate_to_dsr(date) to authenticated;

-- Hook into save_meter_shift_readings
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
  'Upsert shift nozzle + cash/phone-pay; push meter columns into existing dsr_* rows; refuses empty wipe.';

-- Re-apply rollup after admin deletes a shift (e.g. afternoon removed → morning-only meters)
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
  v_dsr_apply jsonb;
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

  v_dsr_apply := public.apply_shift_aggregate_to_dsr(p_date);

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'dsr_meters_updated', coalesce(v_dsr_apply->'updated', '[]'::jsonb)
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzle/cash; refresh meter columns on existing dsr_* from remaining shifts.';

grant execute on function public.save_meter_shift_readings(date, text, jsonb, jsonb) to authenticated;
grant execute on function public.delete_meter_shift_readings(date, text) to authenticated;

-- ─── 3) DSR update WITH CHECK: lock on new date ─────────────────────────────

drop policy if exists "dsr_petrol_update_by_role" on public.dsr_petrol;
create policy "dsr_petrol_update_by_role" on public.dsr_petrol
  for update to authenticated
  using (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
      and not public.dsr_meter_row_is_complete(
        petrol_rate, dip_reading, stock, receipts
      )
    )
  )
  with check (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
    )
  );

drop policy if exists "dsr_diesel_update_by_role" on public.dsr_diesel;
create policy "dsr_diesel_update_by_role" on public.dsr_diesel
  for update to authenticated
  using (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
      and not public.dsr_meter_row_is_complete(
        diesel_rate, dip_reading, stock, receipts
      )
    )
  )
  with check (
    public.is_admin()
    or (
      public.is_supervisor_or_admin()
      and not public.meter_day_is_locked(date)
    )
  );
