-- Canonical definition of public.require_meter_shift_writable. Edit here, then:
--   node scripts/sql-functions.mjs emit require_meter_shift_writable
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

  if public.meter_day_has_closing(p_date) then
    raise exception
      'Day closing is saved for %. Only an admin can change shift %.',
      p_date, v_shift;
  end if;
end;
$$;

comment on function public.require_meter_shift_writable(date, text) is
  'Supervisors can re-save a shift until day closing is saved; admins always can.';

grant execute on function public.require_meter_shift_writable(date, text) to authenticated;
