-- Canonical definition of public.refresh_open_day_closing. Edit here, then:
--   node scripts/sql-functions.mjs emit refresh_open_day_closing
create or replace function public.refresh_open_day_closing(p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_date is null then
    return;
  end if;

  -- Collected closings stay frozen for supervisors. Admins may still refresh them.
  -- Certified dates are rejected by the caller before this runs.
  if exists (
    select 1
    from public.day_closing dc
    where dc.date = p_date
      and not coalesce(dc.certified, false)
      and (
        dc.night_cash_collection_id is null
        or public.is_admin()
      )
  ) then
    perform public.sync_saved_day_closing_for_date(p_date);
  end if;
end;
$$;

comment on function public.refresh_open_day_closing(date) is
  'Refresh a saved day closing after a ledger or meter write. Skips certified dates and, for supervisors, nights whose cash was already collected.';

revoke all on function public.refresh_open_day_closing(date) from public, anon, authenticated;
