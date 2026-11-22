-- Canonical definition of public.meter_shift_lock_info. Edit here, then:
--   node scripts/sql-functions.mjs emit meter_shift_lock_info
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
  v_closing_saved boolean := false;
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
  v_closing_saved := public.meter_day_has_closing(p_date);

  if v_shift is not null then
    v_shift_saved := public.meter_shift_has_readings(p_date, v_shift);
  end if;

  if v_day_locked and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'Day closing is certified or night cash is collected. Only an admin can change meters.';
  elsif v_closing_saved and not public.is_admin() then
    v_readonly := true;
    v_reason :=
      'Day closing is saved for this date. Only an admin can change shifts.';
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'today', v_today,
    'day_locked', v_day_locked,
    'day_closing_saved', v_closing_saved,
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
  'Shift register lock for supervisors: day closing saved, or day certified / night cash collected.';

grant execute on function public.meter_shift_lock_info(date, text) to authenticated;
