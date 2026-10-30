-- UPI / bank settlement matching.
--
-- An admin uploads a bank or UPI-app statement CSV (DSR → Settlement). The browser parses it,
-- the admin maps the date / amount / reference columns, and import_settlement_lines stores the
-- credit lines. Lines with a reference already imported for the same source are skipped, so
-- re-uploading an overlapping statement does not double-count.
--
-- get_settlement_match compares, per business date, what the app recorded as digital money
-- with what the statement shows:
--
--   app_digital   = day_closing.phone_pay when the day is closed, else
--                   shift UPI (meter_shift_cash.phone_pay) + UPI credit payments that day
--   bank_amount   = statement lines dated business date + p_lag_days
--   difference    = bank_amount - app_digital   (negative = money missing from the bank)
--   status        = matched (|difference| <= tolerance) | short | excess | missing_bank | bank_only
--
-- Tolerance: p_tolerance, else pump_settings.config.alerts.settlementTolerance (₹), else 10.

create table if not exists public.settlement_imports (
  id uuid primary key default gen_random_uuid(),
  source text not null check (char_length(btrim(source)) between 1 and 60),
  file_name text check (file_name is null or char_length(file_name) <= 200),
  column_map jsonb not null default '{}'::jsonb,
  line_count integer not null default 0,
  skipped_count integer not null default 0,
  first_date date,
  last_date date,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.settlement_lines (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.settlement_imports (id) on delete cascade,
  source text not null,
  txn_date date not null,
  amount numeric(14, 2) not null check (amount > 0),
  reference text check (reference is null or char_length(reference) <= 120),
  description text check (description is null or char_length(description) <= 300),
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists settlement_imports_created_idx on public.settlement_imports (created_at desc);
create index if not exists settlement_lines_date_idx on public.settlement_lines (txn_date);
create index if not exists settlement_lines_import_idx on public.settlement_lines (import_id);
create unique index if not exists settlement_lines_source_reference_unique
  on public.settlement_lines (lower(source), reference)
  where reference is not null;

comment on table public.settlement_imports is
  'One uploaded bank / UPI statement. Rows written by import_settlement_lines (admin).';
comment on table public.settlement_lines is
  'Credit lines from an uploaded statement. A reference is unique per source (re-uploads skip it).';

alter table public.settlement_imports enable row level security;
alter table public.settlement_lines enable row level security;

revoke all on table public.settlement_imports from anon, authenticated;
revoke all on table public.settlement_lines from anon, authenticated;
grant select, delete on table public.settlement_imports to authenticated;
grant select on table public.settlement_lines to authenticated;

drop policy if exists "settlement_imports_select_admin" on public.settlement_imports;
create policy "settlement_imports_select_admin" on public.settlement_imports
  for select to authenticated
  using ((select public.is_admin()));

drop policy if exists "settlement_imports_delete_admin" on public.settlement_imports;
create policy "settlement_imports_delete_admin" on public.settlement_imports
  for delete to authenticated
  using ((select public.is_admin()));

drop policy if exists "settlement_lines_select_admin" on public.settlement_lines;
create policy "settlement_lines_select_admin" on public.settlement_lines
  for select to authenticated
  using ((select public.is_admin()));

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

create or replace function public.get_settlement_match(
  p_start date,
  p_end date,
  p_tolerance numeric default null,
  p_lag_days integer default 0
)
returns table (
  business_date date,
  bank_date date,
  app_digital numeric,
  app_source text,
  bank_amount numeric,
  bank_lines integer,
  difference numeric,
  status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tol numeric;
  v_lag int := greatest(least(coalesce(p_lag_days, 0), 7), 0);
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Only an admin can view settlement matching.';
  end if;
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Choose a valid From / To range.';
  end if;
  if p_end - p_start > 400 then
    raise exception 'Choose a range of 400 days or less.';
  end if;

  v_tol := coalesce(
    p_tolerance,
    (select case when s.config #>> '{alerts,settlementTolerance}' ~ '^[0-9]+(\.[0-9]+)?$'
                 then (s.config #>> '{alerts,settlementTolerance}')::numeric end
     from public.pump_settings s where s.id = 1),
    10
  );

  return query
  with days as (
    select g::date as d from generate_series(p_start, p_end, interval '1 day') g
  ),
  shift_upi as (
    select c.reading_date as d, sum(c.phone_pay) as amt
    from public.meter_shift_cash c
    where c.reading_date between p_start and p_end
    group by 1
  ),
  credit_upi as (
    select cp.date as d, sum(cp.amount) as amt
    from public.credit_payments cp
    where cp.date between p_start and p_end
      and cp.status = 'posted'
      and lower(btrim(coalesce(cp.payment_mode, ''))) = 'upi'
    group by 1
  ),
  closing as (
    select dc.date as d, dc.phone_pay as amt
    from public.day_closing dc
    where dc.date between p_start and p_end
  ),
  bank as (
    select sl.txn_date as d, sum(sl.amount) as amt, count(*)::int as n
    from public.settlement_lines sl
    where sl.txn_date between p_start + v_lag and p_end + v_lag
    group by 1
  ),
  app as (
    select dd.d,
           case when cl.d is not null then cl.amt
                else coalesce(su.amt, 0) + coalesce(cu.amt, 0) end as amt,
           case when cl.d is not null then 'day_closing'
                when su.d is not null or cu.d is not null then 'shift_and_credit'
                else null end as src
    from days dd
    left join closing cl on cl.d = dd.d
    left join shift_upi su on su.d = dd.d
    left join credit_upi cu on cu.d = dd.d
  )
  select a.d,
         (a.d + v_lag)::date,
         a.amt,
         a.src,
         coalesce(b.amt, 0),
         coalesce(b.n, 0),
         coalesce(b.amt, 0) - a.amt,
         case
           when coalesce(a.amt, 0) = 0 and coalesce(b.amt, 0) = 0 then 'none'
           when coalesce(b.n, 0) = 0 then 'missing_bank'
           when coalesce(a.amt, 0) = 0 then 'bank_only'
           when abs(coalesce(b.amt, 0) - a.amt) <= v_tol then 'matched'
           when coalesce(b.amt, 0) < a.amt then 'short'
           else 'excess'
         end
  from app a
  left join bank b on b.d = a.d + v_lag
  where coalesce(a.amt, 0) <> 0 or coalesce(b.amt, 0) <> 0
  order by a.d desc;
end;
$$;

comment on function public.get_settlement_match(date, date, numeric, integer) is
  'Admin: per business date, app digital (day_closing.phone_pay, else shift UPI + UPI credit payments) vs imported statement lines on date + lag. status matched | short | excess | missing_bank | bank_only.';

grant execute on function public.get_settlement_match(date, date, numeric, integer) to authenticated;
