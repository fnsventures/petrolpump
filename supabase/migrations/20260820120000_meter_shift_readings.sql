-- Shift-wise meter readings with staff attribution and cash short.
-- Additive / backward compatible: daily dsr_petrol / dsr_diesel are unchanged.
-- Optional enrichment so operators can see who sold how much from which nozzle.

-- ─── Nozzle assignments (who ran which meter this shift) ─────────────────────

create table if not exists public.meter_shift_readings (
  id uuid primary key default uuid_generate_v4(),
  reading_date date not null,
  product text not null
    check (product in ('petrol', 'diesel')),
  shift text not null
    check (shift in ('morning', 'afternoon')),
  employee_id uuid not null references public.employees (id) on delete restrict,
  pump_no smallint not null
    check (pump_no between 1 and 8),
  nozzle_no smallint not null
    check (nozzle_no between 1 and 8),
  opening_meter numeric(14, 2) not null default 0
    check (opening_meter >= 0),
  closing_meter numeric(14, 2) not null default 0
    check (closing_meter >= 0),
  testing_litres numeric(14, 2) not null default 0
    check (testing_litres >= 0),
  remarks text
    check (remarks is null or char_length(remarks) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint meter_shift_readings_unique_nozzle
    unique (reading_date, product, shift, pump_no, nozzle_no),
  constraint meter_shift_readings_closing_gte_opening
    check (closing_meter >= opening_meter)
);

create index if not exists meter_shift_readings_date_shift_idx
  on public.meter_shift_readings (reading_date desc, shift);

create index if not exists meter_shift_readings_employee_date_idx
  on public.meter_shift_readings (employee_id, reading_date desc);

comment on table public.meter_shift_readings is
  'Shift nozzle meter readings with staff assignment. Optional; daily DSR remains source of truth for day closing.';

comment on column public.meter_shift_readings.shift is
  'Shift key: morning | afternoon (labels from pump_settings.config.shifts).';

comment on column public.meter_shift_readings.testing_litres is
  'Testing litres attributed to this nozzle for the shift (subtracted from gross sale for expected cash).';

-- ─── Staff cash handover per shift (short = expected − collected) ───────────

create table if not exists public.meter_shift_cash (
  id uuid primary key default uuid_generate_v4(),
  reading_date date not null,
  shift text not null
    check (shift in ('morning', 'afternoon')),
  employee_id uuid not null references public.employees (id) on delete restrict,
  cash_collected numeric(14, 2) not null default 0
    check (cash_collected >= 0),
  remarks text
    check (remarks is null or char_length(remarks) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint meter_shift_cash_unique_staff
    unique (reading_date, shift, employee_id)
);

create index if not exists meter_shift_cash_date_shift_idx
  on public.meter_shift_cash (reading_date desc, shift);

comment on table public.meter_shift_cash is
  'Cash handed over by staff for a shift. Expected ₹ is derived from assigned nozzle litres × day rates.';

-- ─── RLS ────────────────────────────────────────────────────────────────────

alter table public.meter_shift_readings enable row level security;
alter table public.meter_shift_cash enable row level security;

drop policy if exists "meter_shift_readings_select" on public.meter_shift_readings;
create policy "meter_shift_readings_select" on public.meter_shift_readings
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_readings_insert" on public.meter_shift_readings;
create policy "meter_shift_readings_insert" on public.meter_shift_readings
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "meter_shift_readings_update" on public.meter_shift_readings;
create policy "meter_shift_readings_update" on public.meter_shift_readings
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_readings_delete" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete_admin" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete_staff" on public.meter_shift_readings;
create policy "meter_shift_readings_delete" on public.meter_shift_readings
  for delete to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_cash_select" on public.meter_shift_cash;
create policy "meter_shift_cash_select" on public.meter_shift_cash
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_cash_insert" on public.meter_shift_cash;
create policy "meter_shift_cash_insert" on public.meter_shift_cash
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "meter_shift_cash_update" on public.meter_shift_cash;
create policy "meter_shift_cash_update" on public.meter_shift_cash
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "meter_shift_cash_delete" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete_admin" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete_staff" on public.meter_shift_cash;
create policy "meter_shift_cash_delete" on public.meter_shift_cash
  for delete to authenticated
  using (public.is_supervisor_or_admin());

grant select, insert, update, delete on public.meter_shift_readings to authenticated;
grant select, insert, update, delete on public.meter_shift_cash to authenticated;

-- ─── Audit ──────────────────────────────────────────────────────────────────

drop trigger if exists audit_meter_shift_readings_trigger on public.meter_shift_readings;
create trigger audit_meter_shift_readings_trigger
  after insert or update or delete on public.meter_shift_readings
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_meter_shift_cash_trigger on public.meter_shift_cash;
create trigger audit_meter_shift_cash_trigger
  after insert or update or delete on public.meter_shift_cash
  for each row execute function public.audit_trigger_fn();

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
  v_petrol_rate numeric;
  v_diesel_rate numeric;
  v_petrol_sales numeric;
  v_petrol_testing numeric;
  v_diesel_sales numeric;
  v_diesel_testing numeric;
  v_has_petrol boolean := false;
  v_has_diesel boolean := false;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select p.petrol_rate, p.total_sales, p.testing
  into v_petrol_rate, v_petrol_sales, v_petrol_testing
  from public.dsr_petrol p
  where p.date = p_date
  order by p.created_at desc
  limit 1;
  v_has_petrol := found;

  select d.diesel_rate, d.total_sales, d.testing
  into v_diesel_rate, v_diesel_sales, v_diesel_testing
  from public.dsr_diesel d
  where d.date = p_date
  order by d.created_at desc
  limit 1;
  v_has_diesel := found;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'rates', jsonb_build_object(
      'petrol', v_petrol_rate,
      'diesel', v_diesel_rate
    ),
    'daily_totals', jsonb_build_object(
      'petrol', jsonb_build_object(
        'total_sales', coalesce(v_petrol_sales, 0),
        'testing', coalesce(v_petrol_testing, 0),
        'has_row', v_has_petrol
      ),
      'diesel', jsonb_build_object(
        'total_sales', coalesce(v_diesel_sales, 0),
        'testing', coalesce(v_diesel_testing, 0),
        'has_row', v_has_diesel
      )
    ),
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
  'Load shift nozzle readings, cash handovers, day rates, daily DSR totals, and attendance hints.';

grant execute on function public.get_meter_shift_readings(date, text) to authenticated;

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
  v_shift text;
  v_uid uuid := auth.uid();
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
begin
  perform public.require_staff_access();

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

    if not exists (select 1 from public.employees e where e.id = v_employee) then
      raise exception 'Cash row references unknown staff';
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
      p_date, v_shift, v_employee, v_cash_amt, v_remarks, v_uid, timezone('utc'::text, now())
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
    and not (c.employee_id = any (v_emp_ids));

  return public.get_meter_shift_readings(p_date, v_shift)
    || jsonb_build_object(
      'saved_nozzles', v_kept_nozzles,
      'saved_cash', v_kept_cash
    );
end;
$$;

comment on function public.save_meter_shift_readings(date, text, jsonb, jsonb) is
  'Upsert shift nozzle assignments and staff cash for a date+shift; clears removed rows.';

grant execute on function public.save_meter_shift_readings(date, text, jsonb, jsonb) to authenticated;

-- ─── delete_meter_shift_readings (admin wipe for date+shift) ────────────────

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

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove all shift nozzle and cash rows for a date+shift.';

grant execute on function public.delete_meter_shift_readings(date, text) to authenticated;

-- ─── Prior closing helpers for “copy openings” ──────────────────────────────

create or replace function public.get_meter_shift_prior_closings(
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
  v_prior_date date;
  v_prior_shift text;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := lower(btrim(coalesce(p_shift, '')));
  if v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  if v_shift = 'afternoon' then
    v_prior_date := p_date;
    v_prior_shift := 'morning';
  else
    v_prior_date := p_date - 1;
    v_prior_shift := 'afternoon';
  end if;

  return jsonb_build_object(
    'prior_date', v_prior_date,
    'prior_shift', v_prior_shift,
    'from_shift', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'product', r.product,
          'pump_no', r.pump_no,
          'nozzle_no', r.nozzle_no,
          'closing_meter', r.closing_meter
        )
        order by r.product, r.pump_no, r.nozzle_no
      )
      from public.meter_shift_readings r
      where r.reading_date = v_prior_date
        and r.shift = v_prior_shift
    ), '[]'::jsonb),
    'from_daily', jsonb_build_object(
      'petrol', (
        select jsonb_build_object(
          'closing_pump1_nozzle1', p.closing_pump1_nozzle1,
          'closing_pump1_nozzle2', p.closing_pump1_nozzle2,
          'closing_pump2_nozzle1', p.closing_pump2_nozzle1,
          'closing_pump2_nozzle2', p.closing_pump2_nozzle2
        )
        from public.dsr_petrol p
        where p.date = v_prior_date
        order by p.created_at desc
        limit 1
      ),
      'diesel', (
        select jsonb_build_object(
          'closing_pump1_nozzle1', d.closing_pump1_nozzle1,
          'closing_pump1_nozzle2', d.closing_pump1_nozzle2,
          'closing_pump2_nozzle1', d.closing_pump2_nozzle1,
          'closing_pump2_nozzle2', d.closing_pump2_nozzle2
        )
        from public.dsr_diesel d
        where d.date = v_prior_date
        order by d.created_at desc
        limit 1
      )
    )
  );
end;
$$;

comment on function public.get_meter_shift_prior_closings(date, text) is
  'Prior shift/daily closing meters for prefilling openings (afternoon←morning; morning←prior afternoon/daily).';

grant execute on function public.get_meter_shift_prior_closings(date, text) to authenticated;
