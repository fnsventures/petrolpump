-- Canonical definition of public.dsr_refresh_open_day_closing. Edit here, then:
--   node scripts/sql-functions.mjs emit dsr_refresh_open_day_closing
create or replace function public.dsr_refresh_open_day_closing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_open_day_closing(old.date);
    return null;
  end if;
  perform public.refresh_open_day_closing(new.date);
  if tg_op = 'UPDATE' and old.date is distinct from new.date then
    perform public.refresh_open_day_closing(old.date);
  end if;
  return null;
end;
$$;

comment on function public.dsr_refresh_open_day_closing() is
  'Trigger: after a meter row change, refresh an uncertified saved day closing. Certified days are rejected by dsr_validate_meter_row.';

revoke all on function public.dsr_refresh_open_day_closing() from public, anon;

grant execute on function public.dsr_refresh_open_day_closing() to authenticated;
