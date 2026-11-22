-- Canonical definition of public.meter_day_has_daily_entry. Edit here, then:
--   node scripts/sql-functions.mjs emit meter_day_has_daily_entry
create or replace function public.meter_day_has_daily_entry(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.dsr_petrol p
    where p.date = p_date
      and public.dsr_meter_row_is_complete(
        p.petrol_rate, p.dip_reading, p.stock, p.receipts
      )
  )
  or exists (
    select 1
    from public.dsr_diesel d
    where d.date = p_date
      and public.dsr_meter_row_is_complete(
        d.diesel_rate, d.dip_reading, d.stock, d.receipts
      )
  );
$$;

comment on function public.meter_day_has_daily_entry(date) is
  'True when a completed daily MS or HSD sheet exists (excludes shift-sync stubs).';

grant execute on function public.meter_day_has_daily_entry(date) to authenticated;
