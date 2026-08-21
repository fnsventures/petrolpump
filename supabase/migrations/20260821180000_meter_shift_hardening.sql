-- Harden clean shift model:
-- 1) RPC-only writes on meter_shift_* (RLS/grants match save/delete locks)
-- 2) Expose has_complete_row for shift reconcile UI
-- 3) Staff access on meter_shift_lock_info
-- 4) DSR update/insert: no created_by bypass of complete / certified-day locks

-- ─── 1) Force RPC writes for shift tables ───────────────────────────────────

revoke insert, update, delete on public.meter_shift_readings from authenticated;
revoke insert, update, delete on public.meter_shift_cash from authenticated;
grant select on public.meter_shift_readings to authenticated;
grant select on public.meter_shift_cash to authenticated;

drop policy if exists "meter_shift_readings_insert" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_update" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete_admin" on public.meter_shift_readings;
drop policy if exists "meter_shift_readings_delete_staff" on public.meter_shift_readings;

drop policy if exists "meter_shift_cash_insert" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_update" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete_admin" on public.meter_shift_cash;
drop policy if exists "meter_shift_cash_delete_staff" on public.meter_shift_cash;

comment on table public.meter_shift_readings is
  'Per-nozzle shift meters + staff. Writes only via save/delete_meter_shift_readings RPCs.';

comment on table public.meter_shift_cash is
  'Staff handover per shift: hard cash + phone pay (UPI). Writes only via save/delete_meter_shift_readings RPCs. Total = cash_collected + phone_pay.';

-- ─── 2) Lock info: require provisioned staff ─────────────────────────────────

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
  v_shift_saved boolean := false;
  v_shift text;
  v_today date := public.meter_station_today();
  v_reason text := null;
  v_readonly boolean := false;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  v_day_locked := public.meter_day_is_locked(p_date);

  if v_shift is not null then
    v_shift_saved := public.meter_shift_has_readings(p_date, v_shift);
  end if;

  if v_day_locked and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'Day closing is certified or night cash is collected. Only an admin can change meters.';
  elsif v_shift_saved and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'This shift is already saved. Only an admin can change it.';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'today', v_today,
    'day_locked', v_day_locked,
    'past_closed', p_date < v_today and public.meter_day_has_daily_entry(p_date),
    'shift_has_data', v_shift_saved,
    'has_daily_entry', public.meter_day_has_daily_entry(p_date),
    'supervisor_readonly', v_readonly,
    'admin_can_edit', public.is_admin(),
    'lock_reason', v_reason
  );
end;
$$;

comment on function public.meter_shift_lock_info(date, text) is
  'Shift register lock: certified day, or any shift that already has saved rows (supervisors).';

-- ─── 3) get_meter_shift_readings: has_complete_row + complete-only morning tips ─

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
    -- Same-day daily openings only from a finished sheet (avoid partial-row poison)
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
  'Load shift nozzles, cash/phone-pay, rates, daily meters (has_complete_row), suggested openings, attendance hints.';

-- ─── 4) DSR RLS: align with UI locks (complete / certified day) ─────────────

drop policy if exists "dsr_petrol_insert_own" on public.dsr_petrol;
create policy "dsr_petrol_insert_own" on public.dsr_petrol
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
    and (public.is_admin() or not public.meter_day_is_locked(date))
  );

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
  with check (public.is_supervisor_or_admin());

drop policy if exists "dsr_diesel_insert_own" on public.dsr_diesel;
create policy "dsr_diesel_insert_own" on public.dsr_diesel
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
    and (public.is_admin() or not public.meter_day_is_locked(date))
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
  with check (public.is_supervisor_or_admin());
