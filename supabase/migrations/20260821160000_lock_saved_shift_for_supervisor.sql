-- Lock shift register for supervisors once that shift has saved rows.
-- Empty shifts (e.g. afternoon after morning save) stay editable.
-- Admins can still edit; day-closing certification still blocks non-admins.

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

grant execute on function public.meter_shift_lock_info(date, text) to authenticated;

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

  if public.meter_shift_has_readings(p_date, v_shift) then
    raise exception
      'Shift % for % is already saved. Only an admin can change it.',
      v_shift, p_date;
  end if;
end;
$$;

comment on function public.require_meter_shift_writable(date, text) is
  'Supervisors cannot re-edit a shift once it has saved nozzle rows; admins can.';

grant execute on function public.require_meter_shift_writable(date, text) to authenticated;
