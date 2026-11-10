-- Canonical definition of public.raise_if_day_closing_certified. Edit here, then:
--   node scripts/sql-functions.mjs emit raise_if_day_closing_certified
create or replace function public.raise_if_day_closing_certified(p_date date)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_date is null then
    return;
  end if;
  if exists (
    select 1
    from public.day_closing
    where date = p_date
      and coalesce(certified, false)
  ) then
    raise exception
      'Day closing for % is certified and locked. Revoke certification before changing it.',
      p_date;
  end if;
end;
$$;

comment on function public.raise_if_day_closing_certified(date) is
  'Raise when the date''s day closing is certified. Used by save/sync/delete paths.';

revoke all on function public.raise_if_day_closing_certified(date) from public;

revoke all on function public.raise_if_day_closing_certified(date) from authenticated;
