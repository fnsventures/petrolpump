-- Past closed daily meters: supervisors cannot edit shift register (avoids sync conflicts).
-- Admins can still save/delete. Exposes lock info for the UI.

create or replace function public.meter_station_today()
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (timezone('Asia/Kolkata', now()))::date;
$$;

comment on function public.meter_station_today() is
  'Station calendar date (IST) for meter lock rules.';

grant execute on function public.meter_station_today() to authenticated;

create or replace function public.meter_day_has_daily_entry(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.dsr_petrol where date = p_date)
      or exists (select 1 from public.dsr_diesel where date = p_date);
$$;

comment on function public.meter_day_has_daily_entry(date) is
  'True when MS or HSD daily meter row exists for the date.';

grant execute on function public.meter_day_has_daily_entry(date) to authenticated;

create or replace function public.meter_shift_lock_info(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_day_locked boolean := false;
  v_past_closed boolean := false;
  v_today date := public.meter_station_today();
  v_reason text := null;
begin
  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_day_locked := public.meter_day_is_locked(p_date);
  v_past_closed :=
    p_date < v_today
    and public.meter_day_has_daily_entry(p_date);

  if v_day_locked then
    v_reason :=
      'Day closing is certified or night cash is collected. Only an admin can change meters.';
  elsif v_past_closed then
    v_reason :=
      'Daily MS/HSD meters for this past date are already saved. Only an admin can change the shift register (or delete it if something went wrong).';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'today', v_today,
    'day_locked', v_day_locked,
    'past_closed', v_past_closed,
    'has_daily_entry', public.meter_day_has_daily_entry(p_date),
    'supervisor_readonly', (v_day_locked or v_past_closed) and not public.is_admin(),
    'admin_can_edit', public.is_admin(),
    'lock_reason', v_reason
  );
end;
$$;

comment on function public.meter_shift_lock_info(date) is
  'Shift register lock status for UI (past closed daily meters + day-closing lock).';

grant execute on function public.meter_shift_lock_info(date) to authenticated;

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

  if p_date < public.meter_station_today()
     and public.meter_day_has_daily_entry(p_date) then
    raise exception
      'Meter readings for % are already saved. Only an admin can change the shift register for that past date.',
      p_date;
  end if;
end;
$$;

comment on function public.require_meter_day_writable(date) is
  'Non-admins blocked when day is certified/collected, or past date already has daily MS/HSD.';

-- Admin delete must still re-sync even when the day is locked for supervisors.
-- sync_dsr_meters_from_shifts already allows admin via require_meter_day_writable.
-- Harden delete: if sync fails, still report deleted rows clearly.

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
  v_sync jsonb := null;
  v_sync_error text := null;
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

  begin
    v_sync := public.sync_dsr_meters_from_shifts(p_date);
  exception
    when others then
      v_sync_error := SQLERRM;
  end;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'deleted_nozzles', v_n,
    'deleted_cash', v_c,
    'daily_sync', v_sync,
    'daily_sync_error', v_sync_error
  );
end;
$$;

comment on function public.delete_meter_shift_readings(date, text) is
  'Admin-only: remove shift nozzle/cash for date+shift, then re-sync daily meters from remaining shifts.';
