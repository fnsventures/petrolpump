-- Canonical definition of public.meter_day_has_closing. Edit here, then:
--   node scripts/sql-functions.mjs emit meter_day_has_closing
create or replace function public.meter_day_has_closing(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.day_closing dc where dc.date = p_date
  );
$$;

comment on function public.meter_day_has_closing(date) is
  'True when a day closing statement exists for the date (blocks supervisor shift edits).';

grant execute on function public.meter_day_has_closing(date) to authenticated;
