-- Fewer table scans for night cash availability and collection preview.

create or replace function public.get_night_cash_available()
returns jsonb
language plpgsql security definer
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

create or replace function public.preview_night_cash_collection(
  p_from_date date,
  p_to_date date
)
returns jsonb
language plpgsql security definer
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
