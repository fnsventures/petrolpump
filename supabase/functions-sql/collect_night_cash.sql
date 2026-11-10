-- Canonical definition of public.collect_night_cash. Edit here, then:
--   node scripts/sql-functions.mjs emit collect_night_cash
create or replace function public.collect_night_cash(
  p_from_date date,
  p_to_date date,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_preview jsonb;
  v_total numeric;
  v_count int;
  v_collection_id uuid;
  v_ref text;
  v_seq bigint;
  v_year int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can record night cash collection';
  end if;

  v_preview := public.preview_night_cash_collection(p_from_date, p_to_date);
  v_total := coalesce((v_preview->>'total_amount')::numeric, 0);
  v_count := coalesce((v_preview->>'day_count')::int, 0);

  if v_count = 0 then
    raise exception 'No uncollected day closings in this date range';
  end if;

  v_year := extract(year from p_to_date)::int;
  select coalesce(max(
    nullif(regexp_replace(collection_reference, '^NCC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
  ), 0) + 1 into v_seq
  from public.night_cash_collections
  where extract(year from collected_at) = v_year
    and collection_reference ~ '^NCC-[0-9]+-[0-9]+$';

  v_ref := 'NCC-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');

  insert into public.night_cash_collections (
    collection_reference, from_date, to_date, day_count, total_amount,
    remarks, collected_by
  )
  values (
    v_ref, p_from_date, p_to_date, v_count, v_total,
    nullif(trim(p_remarks), ''), auth.uid()
  )
  returning id into v_collection_id;

  update public.day_closing
  set night_cash_collection_id = v_collection_id
  where date between p_from_date and p_to_date
    and night_cash_collection_id is null;

  return jsonb_build_object(
    'id', v_collection_id,
    'collection_reference', v_ref,
    'from_date', p_from_date,
    'to_date', p_to_date,
    'day_count', v_count,
    'total_amount', v_total,
    'remarks', nullif(trim(p_remarks), ''),
    'days', v_preview->'days'
  );
end;
$$;

comment on function public.collect_night_cash(date, date, text) is
  'Admin-only: record physical night cash collection for a date range. Locks linked day closings.';

grant execute on function public.collect_night_cash(date, date, text) to authenticated;
