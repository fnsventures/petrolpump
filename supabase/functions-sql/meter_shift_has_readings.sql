-- Canonical definition of public.meter_shift_has_readings. Edit here, then:
--   node scripts/sql-functions.mjs emit meter_shift_has_readings
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
