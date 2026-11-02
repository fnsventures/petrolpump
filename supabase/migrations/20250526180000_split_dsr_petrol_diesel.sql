-- Migration: Split single dsr table into dsr_petrol and dsr_diesel
-- Creates a backward-compatible dsr VIEW so all SELECT queries keep working.
-- Write paths (INSERT/UPDATE/DELETE) must target the product-specific tables.

-- ============================================================================
-- 1. CREATE dsr_petrol TABLE
-- ============================================================================
create table if not exists public.dsr_petrol (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  tank_capacity text not null default '15KL',
  opening_pump1_nozzle1 numeric(14,2) not null default 0,
  opening_pump1_nozzle2 numeric(14,2) not null default 0,
  opening_pump2_nozzle1 numeric(14,2) not null default 0,
  opening_pump2_nozzle2 numeric(14,2) not null default 0,
  closing_pump1_nozzle1 numeric(14,2) not null default 0,
  closing_pump1_nozzle2 numeric(14,2) not null default 0,
  closing_pump2_nozzle1 numeric(14,2) not null default 0,
  closing_pump2_nozzle2 numeric(14,2) not null default 0,
  sales_pump1 numeric(14,2) not null default 0,
  sales_pump2 numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  dip_reading numeric(14,2) not null default 0,
  stock numeric(14,2) not null default 0,
  receipts numeric(14,2) not null default 0,
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  buying_price_per_litre numeric(10,2),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_petrol_date_idx on public.dsr_petrol (date desc);

comment on table public.dsr_petrol is 'Petrol (MS) meter readings. One row per day per tank. Replaces dsr rows where product=petrol.';

-- ============================================================================
-- 2. CREATE dsr_diesel TABLE
-- ============================================================================
create table if not exists public.dsr_diesel (
  id uuid primary key default uuid_generate_v4(),
  date date not null,
  tank_capacity text not null default '20KL',
  opening_pump1_nozzle1 numeric(14,2) not null default 0,
  opening_pump1_nozzle2 numeric(14,2) not null default 0,
  opening_pump2_nozzle1 numeric(14,2) not null default 0,
  opening_pump2_nozzle2 numeric(14,2) not null default 0,
  closing_pump1_nozzle1 numeric(14,2) not null default 0,
  closing_pump1_nozzle2 numeric(14,2) not null default 0,
  closing_pump2_nozzle1 numeric(14,2) not null default 0,
  closing_pump2_nozzle2 numeric(14,2) not null default 0,
  sales_pump1 numeric(14,2) not null default 0,
  sales_pump2 numeric(14,2) not null default 0,
  total_sales numeric(14,2) not null default 0,
  testing numeric(14,2) not null default 0,
  dip_reading numeric(14,2) not null default 0,
  stock numeric(14,2) not null default 0,
  receipts numeric(14,2) not null default 0,
  petrol_rate numeric(10,2),
  diesel_rate numeric(10,2),
  buying_price_per_litre numeric(10,2),
  remarks text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create index if not exists dsr_diesel_date_idx on public.dsr_diesel (date desc);

comment on table public.dsr_diesel is 'Diesel (HSD) meter readings. One row per day per tank. Replaces dsr rows where product=diesel.';

-- ============================================================================
-- 3. MIGRATE DATA from dsr → dsr_petrol / dsr_diesel
-- ============================================================================
insert into public.dsr_petrol (
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
)
select
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
from public.dsr
where product = 'petrol'
on conflict (id) do nothing;

insert into public.dsr_diesel (
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
)
select
  id, date, opening_pump1_nozzle1, opening_pump1_nozzle2,
  opening_pump2_nozzle1, opening_pump2_nozzle2,
  closing_pump1_nozzle1, closing_pump1_nozzle2,
  closing_pump2_nozzle1, closing_pump2_nozzle2,
  sales_pump1, sales_pump2, total_sales, testing,
  dip_reading, stock, receipts,
  petrol_rate, diesel_rate, buying_price_per_litre,
  remarks, created_by, created_at
from public.dsr
where product = 'diesel'
on conflict (id) do nothing;

-- ============================================================================
-- 4. DROP OLD dsr (TABLE or VIEW) and CREATE backward-compatible VIEW
-- ============================================================================
-- dsr may already be a view (from a prior migration) or still a table.
-- Handle both cases safely.
do $$
begin
  -- If it is a table, drop triggers and policies first, then the table
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr' and c.relkind = 'r'
  ) then
    execute 'drop trigger if exists audit_dsr_trigger on public.dsr';
    execute 'drop policy if exists "dsr_select_authenticated" on public.dsr';
    execute 'drop policy if exists "dsr_insert_own" on public.dsr';
    execute 'drop policy if exists "dsr_update_by_role" on public.dsr';
    execute 'drop policy if exists "dsr_delete_admin" on public.dsr';
    execute 'drop table public.dsr';
  -- If it is a view, just drop the view
  elsif exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr' and c.relkind = 'v'
  ) then
    execute 'drop view public.dsr';
  end if;
end $$;

create or replace view public.dsr as
  select id, date, 'petrol'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    remarks, created_by, created_at
  from public.dsr_petrol
  union all
  select id, date, 'diesel'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    remarks, created_by, created_at
  from public.dsr_diesel;

comment on view public.dsr is 'Backward-compatible union view of dsr_petrol and dsr_diesel. Use for SELECT only; writes go to product-specific tables.';

-- ============================================================================
-- 5. RLS POLICIES on new tables
-- ============================================================================
alter table public.dsr_petrol enable row level security;

drop policy if exists "dsr_petrol_select_authenticated" on public.dsr_petrol;
create policy "dsr_petrol_select_authenticated" on public.dsr_petrol
  for select to authenticated using (true);

drop policy if exists "dsr_petrol_insert_own" on public.dsr_petrol;
create policy "dsr_petrol_insert_own" on public.dsr_petrol
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "dsr_petrol_update_by_role" on public.dsr_petrol;
create policy "dsr_petrol_update_by_role" on public.dsr_petrol
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "dsr_petrol_delete_admin" on public.dsr_petrol;
create policy "dsr_petrol_delete_admin" on public.dsr_petrol
  for delete to authenticated using (public.is_admin());

alter table public.dsr_diesel enable row level security;

drop policy if exists "dsr_diesel_select_authenticated" on public.dsr_diesel;
create policy "dsr_diesel_select_authenticated" on public.dsr_diesel
  for select to authenticated using (true);

drop policy if exists "dsr_diesel_insert_own" on public.dsr_diesel;
create policy "dsr_diesel_insert_own" on public.dsr_diesel
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "dsr_diesel_update_by_role" on public.dsr_diesel;
create policy "dsr_diesel_update_by_role" on public.dsr_diesel
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists "dsr_diesel_delete_admin" on public.dsr_diesel;
create policy "dsr_diesel_delete_admin" on public.dsr_diesel
  for delete to authenticated using (public.is_admin());

-- ============================================================================
-- 6. AUDIT TRIGGERS on new tables
-- ============================================================================
drop trigger if exists audit_dsr_petrol_trigger on public.dsr_petrol;
create trigger audit_dsr_petrol_trigger
  after insert or update or delete on public.dsr_petrol
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_dsr_diesel_trigger on public.dsr_diesel;
create trigger audit_dsr_diesel_trigger
  after insert or update or delete on public.dsr_diesel
  for each row execute function public.audit_trigger_fn();

-- ============================================================================
-- 7. UPDATE RPC: update_dsr_buying_price (check both tables)
-- ============================================================================
create or replace function public.update_dsr_buying_price(p_dsr_id uuid, p_value numeric)
returns void
language plpgsql
security definer
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;
  update public.dsr_petrol set buying_price_per_litre = p_value where id = p_dsr_id;
  if found then return; end if;
  update public.dsr_diesel set buying_price_per_litre = p_value where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;

-- ============================================================================
-- 8. UPDATE RPC: sync_dsr_receipts_from_stock (both tables)
-- ============================================================================
create or replace function public.sync_dsr_receipts_from_stock(p_start date, p_end date)
returns void
language sql
security definer
as $$
  update public.dsr_petrol d
  set receipts = s.receipts
  from public.dsr_stock s
  where d.date = s.date and s.product = 'petrol'
    and s.receipts > 0 and coalesce(d.receipts, 0) = 0
    and d.date >= p_start and d.date <= p_end
    and s.date >= p_start and s.date <= p_end;

  update public.dsr_diesel d
  set receipts = s.receipts
  from public.dsr_stock s
  where d.date = s.date and s.product = 'diesel'
    and s.receipts > 0 and coalesce(d.receipts, 0) = 0
    and d.date >= p_start and d.date <= p_end
    and s.date >= p_start and s.date <= p_end;
$$;
