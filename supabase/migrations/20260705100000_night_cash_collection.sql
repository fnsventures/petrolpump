-- Night cash collection: track physical pickup of accumulated night cash from day closings.
-- Once collected, linked day_closing rows are locked (no app edits, even admin).

-- ============================================================================
-- NIGHT CASH COLLECTIONS
-- ============================================================================
create table if not exists public.night_cash_collections (
  id uuid primary key default uuid_generate_v4(),
  collection_reference text not null,
  from_date date not null,
  to_date date not null,
  day_count integer not null check (day_count > 0),
  total_amount numeric(14,2) not null check (total_amount >= 0),
  remarks text check (char_length(remarks) <= 500),
  collected_by uuid references auth.users (id) on delete set null,
  collected_at timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone default timezone('utc'::text, now()),
  check (from_date <= to_date)
);

create unique index if not exists night_cash_collections_reference_idx
  on public.night_cash_collections (collection_reference);

create index if not exists night_cash_collections_collected_at_idx
  on public.night_cash_collections (collected_at desc);

comment on table public.night_cash_collections is
  'Register of physical night cash pickups from the pump. Immutable via the app once recorded.';
comment on column public.night_cash_collections.collection_reference is
  'Unique reference for the register (e.g. NCC-2026-00001).';
comment on column public.night_cash_collections.total_amount is
  'Sum of night_cash from all linked day_closing rows in the collection period.';

alter table public.night_cash_collections enable row level security;

drop policy if exists "night_cash_collections_select_authenticated" on public.night_cash_collections;
create policy "night_cash_collections_select_authenticated" on public.night_cash_collections
  for select to authenticated using (public.is_supervisor_or_admin());

-- Link day_closing rows to a collection (null = night cash still at pump)
alter table public.day_closing
  add column if not exists night_cash_collection_id uuid
  references public.night_cash_collections (id) on delete restrict;

create index if not exists day_closing_night_cash_collection_idx
  on public.day_closing (night_cash_collection_id)
  where night_cash_collection_id is not null;

comment on column public.day_closing.night_cash_collection_id is
  'When set, night cash for this date was physically collected and the closing is locked.';

-- Prevent any modification of collected day closings (even via direct table access from app roles)
create or replace function public.day_closing_block_collected_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected (ref %).',
      old.date,
      (select collection_reference from public.night_cash_collections where id = old.night_cash_collection_id);
  end if;
  if tg_op = 'DELETE' and old.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected. Remove the collection in the database first.',
      old.date;
  end if;
  if tg_op = 'UPDATE' and new.night_cash_collection_id is distinct from old.night_cash_collection_id
     and old.night_cash_collection_id is null and new.night_cash_collection_id is not null then
    return new;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists day_closing_block_collected_mutation_trigger on public.day_closing;
create trigger day_closing_block_collected_mutation_trigger
  before update or delete on public.day_closing
  for each row execute function public.day_closing_block_collected_mutation();

-- Tighten RLS: no updates/deletes on collected rows from authenticated clients
drop policy if exists "day_closing_update_by_role" on public.day_closing;
create policy "day_closing_update_by_role" on public.day_closing
  for update to authenticated
  using (
    night_cash_collection_id is null
    and public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  )
  with check (
    night_cash_collection_id is null
    and public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  );

drop policy if exists "day_closing_delete_admin" on public.day_closing;
create policy "day_closing_delete_admin" on public.day_closing
  for delete to authenticated
  using (public.is_admin() and night_cash_collection_id is null);

-- Skip recascade updates for collected (locked) day closings
create or replace function public.recascade_day_closing_short_from(p_from_date date)
returns void
language plpgsql security definer
as $$
declare
  v_row record;
  v_components jsonb;
  v_short_today numeric;
begin
  for v_row in
    select date, night_cash, phone_pay, night_cash_collection_id
    from public.day_closing
    where date > p_from_date
    order by date asc
  loop
    if v_row.night_cash_collection_id is not null then
      continue;
    end if;

    v_components := public.compute_day_closing_components(v_row.date);
    v_short_today := (
      coalesce((v_components->>'total_sale')::numeric, 0)
      + coalesce((v_components->>'collection')::numeric, 0)
      + coalesce((v_components->>'short_previous')::numeric, 0)
    ) - (
      v_row.night_cash + v_row.phone_pay
      + coalesce((v_components->>'credit_today')::numeric, 0)
      + coalesce((v_components->>'expenses_today')::numeric, 0)
    );

    update public.day_closing set
      total_sale = coalesce((v_components->>'total_sale')::numeric, 0),
      collection = coalesce((v_components->>'collection')::numeric, 0),
      short_previous = coalesce((v_components->>'short_previous')::numeric, 0),
      credit_today = coalesce((v_components->>'credit_today')::numeric, 0),
      expenses_today = coalesce((v_components->>'expenses_today')::numeric, 0),
      short_today = v_short_today
    where date = v_row.date
      and night_cash_collection_id is null;
  end loop;
end;
$$;

-- Skip sync for collected day closings
create or replace function public.sync_saved_day_closing_for_date(p_date date)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_components jsonb;
  v_short_today numeric;
begin
  select night_cash, phone_pay, night_cash_collection_id
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found or v_row.night_cash_collection_id is not null then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_short_today := (
    coalesce((v_components->>'total_sale')::numeric, 0)
    + coalesce((v_components->>'collection')::numeric, 0)
    + coalesce((v_components->>'short_previous')::numeric, 0)
  ) - (
    coalesce(v_row.night_cash, 0) + coalesce(v_row.phone_pay, 0)
    + coalesce((v_components->>'credit_today')::numeric, 0)
    + coalesce((v_components->>'expenses_today')::numeric, 0)
  );

  update public.day_closing set
    total_sale = coalesce((v_components->>'total_sale')::numeric, 0),
    collection = coalesce((v_components->>'collection')::numeric, 0),
    short_previous = coalesce((v_components->>'short_previous')::numeric, 0),
    credit_today = coalesce((v_components->>'credit_today')::numeric, 0),
    expenses_today = coalesce((v_components->>'expenses_today')::numeric, 0),
    short_today = v_short_today
  where date = p_date
    and night_cash_collection_id is null;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

-- RPC: Available (uncollected) night cash summary
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
    max(date)
  into v_total, v_count, v_from, v_to
  from public.day_closing
  where night_cash_collection_id is null;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date', dc.date,
      'night_cash', dc.night_cash,
      'closing_reference', dc.closing_reference
    ) order by dc.date asc
  ), '[]'::jsonb)
  into v_days
  from public.day_closing dc
  where dc.night_cash_collection_id is null;

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

-- RPC: Preview a collection for a date range before confirming
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
  perform public.require_staff_access();

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
    ), '[]'::jsonb),
    coalesce(sum(dc.night_cash), 0),
    count(*)::int
  into v_included, v_total, v_count
  from public.day_closing dc
  where dc.date between p_from_date and p_to_date
    and dc.night_cash_collection_id is null;

  select count(*)::int into v_collected_count
  from public.day_closing
  where date between p_from_date and p_to_date
    and night_cash_collection_id is not null;

  select (p_to_date - p_from_date + 1) - v_count - v_collected_count
  into v_missing_count;

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
  'Preview uncollected night cash in a date range before recording collection.';

-- RPC: Record night cash collection (admin only, immutable)
create or replace function public.collect_night_cash(
  p_from_date date,
  p_to_date date,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
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

-- Update get_day_closing_breakdown: expose collection lock status
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_collection_ref text;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_night_cash_collected boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_live numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
begin
  perform public.require_staff_access();

  select dc.total_sale, dc.collection, dc.short_previous, dc.credit_today, dc.expenses_today,
         dc.night_cash, dc.phone_pay, dc.short_today, dc.closing_reference, dc.remarks,
         dc.night_cash_collection_id, ncc.collection_reference
  into v_existing
  from public.day_closing dc
  left join public.night_cash_collections ncc on ncc.id = dc.night_cash_collection_id
  where dc.date = p_date
  limit 1;

  v_already_saved := found;
  v_night_cash_collected := v_already_saved and v_existing.night_cash_collection_id is not null;
  v_collection_ref := v_existing.collection_reference;
  v_can_overwrite := v_already_saved and public.is_admin() and not v_night_cash_collected;
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null
    and (not public.is_admin() or v_night_cash_collected);

  if v_use_snapshot then
    select coalesce(sum(amount), 0) into v_expenses_live
    from public.expenses where date = p_date;

    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
  else
    v_components := public.compute_day_closing_components(p_date);
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_live := coalesce((v_components->>'expenses_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_live,
    'night_cash', case when v_already_saved then coalesce(v_existing.night_cash, 0) else null end,
    'phone_pay', case when v_already_saved then coalesce(v_existing.phone_pay, 0) else null end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite,
    'night_cash_collected', v_night_cash_collected,
    'night_cash_collection_reference', v_collection_ref
  );
end;
$$;

-- Update save_day_closing: reject collected (locked) dates
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_is_overwrite boolean := false;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
  v_ref text;
  v_seq bigint;
begin
  perform public.require_staff_access();

  if p_night_cash is null or p_night_cash < 0 then
    raise exception 'night_cash must be >= 0';
  end if;
  if p_phone_pay is null or p_phone_pay < 0 then
    raise exception 'phone_pay must be >= 0';
  end if;

  select closing_reference, night_cash_collection_id into v_existing
  from public.day_closing where date = p_date;
  if found then
    if v_existing.night_cash_collection_id is not null then
      raise exception 'Day closing for % is locked: night cash was already collected.', p_date;
    end if;
    if not public.is_admin() then
      raise exception 'Day closing already saved for this date.';
    end if;
    v_is_overwrite := true;
    v_ref := v_existing.closing_reference;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  if v_is_overwrite then
    update public.day_closing set
      night_cash = p_night_cash,
      phone_pay = p_phone_pay,
      short_today = v_short_today,
      total_sale = v_total_sale,
      collection = v_collection,
      short_previous = v_short_previous,
      credit_today = v_credit_today,
      expenses_today = v_expenses_today,
      remarks = nullif(trim(p_remarks), '')
    where date = p_date
      and night_cash_collection_id is null;

    perform public.recascade_day_closing_short_from(p_date);
  else
    select coalesce(max(
      nullif(regexp_replace(closing_reference, '^DC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
    ), 0) + 1 into v_seq
    from public.day_closing
    where extract(year from date) = extract(year from p_date)
      and closing_reference is not null
      and closing_reference ~ '^DC-[0-9]+-[0-9]+$';
    v_ref := 'DC-' || to_char(p_date, 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

    insert into public.day_closing (
      date, night_cash, phone_pay, short_today,
      total_sale, collection, short_previous, credit_today, expenses_today,
      closing_reference, remarks, created_by
    )
    values (
      p_date, p_night_cash, p_phone_pay, v_short_today,
      v_total_sale, v_collection, v_short_previous, v_credit_today, v_expenses_today,
      v_ref, nullif(trim(p_remarks), ''), auth.uid()
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', coalesce(p_night_cash, 0),
    'phone_pay', coalesce(p_phone_pay, 0),
    'short_today', coalesce(v_short_today, 0),
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), ''),
    'overwritten', v_is_overwrite
  );
end;
$$;

-- Update delete_day_closing: reject collected dates
create or replace function public.delete_day_closing(p_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_row record;
  v_latest_date date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete day closing records';
  end if;

  select * into v_row from public.day_closing where id = p_id;
  if not found then
    raise exception 'Day closing record not found';
  end if;

  if v_row.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected.', v_row.date;
  end if;

  select max(date) into v_latest_date from public.day_closing;

  if v_row.date < v_latest_date then
    raise exception 'Only the most recent day closing can be deleted. Remove newer closings first.';
  end if;

  delete from public.day_closing where id = p_id;

  return jsonb_build_object(
    'date', v_row.date,
    'closing_reference', v_row.closing_reference
  );
end;
$$;

grant execute on function public.get_night_cash_available() to authenticated;
grant execute on function public.preview_night_cash_collection(date, date) to authenticated;
grant execute on function public.collect_night_cash(date, date, text) to authenticated;
