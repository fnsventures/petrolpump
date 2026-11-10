-- Canonical definition of public.import_settlement_lines. Edit here, then:
--   node scripts/sql-functions.mjs emit import_settlement_lines
create or replace function public.import_settlement_lines(
  p_source text,
  p_file_name text,
  p_column_map jsonb,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_import uuid;
  v_total int;
  v_inserted int;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can import settlement statements.';
  end if;
  if v_source is null then
    raise exception 'Name the statement source (e.g. SBI current account, PhonePe Business).';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'The statement has no credit lines to import.';
  end if;
  v_total := jsonb_array_length(p_lines);
  if v_total > 5000 then
    raise exception 'Import at most 5000 lines at a time (got %).', v_total;
  end if;

  insert into public.settlement_imports (source, file_name, column_map)
  values (left(v_source, 60), left(nullif(btrim(coalesce(p_file_name, '')), ''), 200),
          coalesce(p_column_map, '{}'::jsonb))
  returning id into v_import;

  with parsed as (
    select
      (l->>'date')::date as txn_date,
      round((l->>'amount')::numeric, 2) as amount,
      left(nullif(btrim(coalesce(l->>'reference', '')), ''), 120) as reference,
      left(nullif(btrim(coalesce(l->>'description', '')), ''), 300) as description
    from jsonb_array_elements(p_lines) l
  ),
  checked as (
    select * from parsed
    where txn_date is not null and amount > 0
      and txn_date <= public.meter_station_today()
  ),
  -- Within one file a reference can repeat (split lines); keep the first.
  deduped as (
    select distinct on (coalesce(reference, gen_random_uuid()::text)) *
    from checked
  ),
  ins as (
    insert into public.settlement_lines (import_id, source, txn_date, amount, reference, description)
    select v_import, left(v_source, 60), d.txn_date, d.amount, d.reference, d.description
    from deduped d
    on conflict (lower(source), reference) where reference is not null do nothing
    returning txn_date
  )
  select count(*)::int into v_inserted from ins;

  update public.settlement_imports si
  set line_count = v_inserted,
      skipped_count = v_total - v_inserted,
      first_date = (select min(sl.txn_date) from public.settlement_lines sl where sl.import_id = v_import),
      last_date = (select max(sl.txn_date) from public.settlement_lines sl where sl.import_id = v_import)
  where si.id = v_import;

  if v_inserted = 0 then
    delete from public.settlement_imports where id = v_import;
    v_import := null;
  end if;

  return jsonb_build_object('import_id', v_import, 'inserted', v_inserted, 'skipped', v_total - v_inserted);
exception
  when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
    raise exception 'A mapped date or amount could not be read (%). Check the column mapping.', sqlerrm;
end;
$$;

comment on function public.import_settlement_lines(text, text, jsonb, jsonb) is
  'Admin: store parsed statement credit lines [{date, amount, reference?, description?}]. Skips future dates, non-positive amounts and references already imported for the source.';

grant execute on function public.import_settlement_lines(text, text, jsonb, jsonb) to authenticated;
