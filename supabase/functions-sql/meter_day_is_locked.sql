-- Canonical definition of public.meter_day_is_locked. Edit here, then:
--   node scripts/sql-functions.mjs emit meter_day_is_locked
create or replace function public.meter_day_is_locked(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.day_closing dc
    where dc.date = p_date
      and (
        coalesce(dc.certified, false)
        or dc.night_cash_collection_id is not null
      )
  );
$$;

comment on function public.meter_day_is_locked(date) is
  'True when day closing is certified or night cash collected — meter sync requires admin.';

grant execute on function public.meter_day_is_locked(date) to authenticated;
