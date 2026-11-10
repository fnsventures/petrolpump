-- Canonical definition of public.meter_station_today. Edit here, then:
--   node scripts/sql-functions.mjs emit meter_station_today
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
