-- Canonical definition of public.preview_night_cash_collection. Edit here, then:
--   node scripts/sql-functions.mjs emit preview_night_cash_collection
create or replace function public.preview_night_cash_collection(
  p_from_date date,
  p_to_date date
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_included jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_collected_count int := 0;
  v_missing_count int := 0;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can preview night cash collection';
  end if;

  if p_from_date is null or p_to_date is null then
    raise exception 'from_date and to_date are required';
  end if;
  if p_from_date > p_to_date then
    raise exception 'from_date must be on or before to_date';
  end if;

  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'date', dc.date,
        'night_cash', dc.night_cash,
        'closing_reference', dc.closing_reference
      ) order by dc.date asc
    ) filter (where dc.night_cash_collection_id is null), '[]'::jsonb),
    coalesce(sum(dc.night_cash) filter (where dc.night_cash_collection_id is null), 0),
    count(*) filter (where dc.night_cash_collection_id is null)::int,
    count(*) filter (where dc.night_cash_collection_id is not null)::int
  into v_included, v_total, v_count, v_collected_count
  from public.day_closing dc
  where dc.date between p_from_date and p_to_date;

  v_missing_count := (p_to_date - p_from_date + 1) - v_count - v_collected_count;

  return jsonb_build_object(
    'from_date', p_from_date,
    'to_date', p_to_date,
    'total_amount', coalesce(v_total, 0),
    'day_count', coalesce(v_count, 0),
    'days', v_included,
    'already_collected_count', coalesce(v_collected_count, 0),
    'missing_closing_count', greatest(coalesce(v_missing_count, 0), 0)
  );
end;
$$;

comment on function public.preview_night_cash_collection(date, date) is
  'Admin-only: preview uncollected night cash in a date range before recording collection.';

grant execute on function public.preview_night_cash_collection(date, date) to authenticated;
