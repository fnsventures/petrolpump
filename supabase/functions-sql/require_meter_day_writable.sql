-- Canonical definition of public.require_meter_day_writable. Edit here, then:
--   node scripts/sql-functions.mjs emit require_meter_day_writable
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
