-- Canonical definition of public.get_night_cash_available. Edit here, then:
--   node scripts/sql-functions.mjs emit get_night_cash_available
create or replace function public.get_night_cash_available()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_total numeric := 0;
  v_count int := 0;
  v_from date;
  v_to date;
  v_days jsonb;
begin
  perform public.require_staff_access();

  select
    coalesce(sum(night_cash), 0),
    count(*)::int,
    min(date),
    max(date),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'date', date,
        'night_cash', night_cash,
        'closing_reference', closing_reference
      ) order by date asc
    ), '[]'::jsonb)
  into v_total, v_count, v_from, v_to, v_days
  from public.day_closing
  where night_cash_collection_id is null;

  return jsonb_build_object(
    'total_available', coalesce(v_total, 0),
    'day_count', coalesce(v_count, 0),
    'from_date', v_from,
    'to_date', v_to,
    'days', v_days
  );
end;
$$;

comment on function public.get_night_cash_available() is
  'Sum of uncollected night cash from saved day closings, with per-day breakdown.';

grant execute on function public.get_night_cash_available() to authenticated;
