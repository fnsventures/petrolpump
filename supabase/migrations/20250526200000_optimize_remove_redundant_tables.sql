-- Migration: Optimize schema by removing redundant tables
--
-- PROBLEM: petrol_tank_dsr and diesel_tank_dsr store data 100% derivable from
-- dsr_petrol/dsr_diesel, requiring complex sync logic and risking inconsistency.
-- Additionally lube_* and purchase_entries are unused dead tables.
--
-- SOLUTION: Replace materialized dsr_stock with a computed view. All stock
-- reconciliation values (opening_stock, total_stock, closing_stock, variation)
-- are calculated on-the-fly from the authoritative dsr_petrol/dsr_diesel tables.
-- At ~730 rows/year the window function is trivial.

-- ============================================================================
-- 1. DROP REDUNDANT STOCK TABLES (backing old dsr_stock view)
-- ============================================================================

-- Legacy prod kept dsr_stock as a table; newer installs use a view first.
do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr_stock' and c.relkind = 'v'
  ) then
    execute 'drop view public.dsr_stock cascade';
  elsif exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dsr_stock' and c.relkind = 'r'
  ) then
    execute 'drop table public.dsr_stock cascade';
  end if;
end $$;

-- Drop the materialized backing tables
drop table if exists public.petrol_tank_dsr cascade;
drop table if exists public.diesel_tank_dsr cascade;

-- ============================================================================
-- 2. CREATE COMPUTED dsr_stock VIEW (zero-maintenance, always consistent)
-- ============================================================================

create or replace view public.dsr_stock as
with base as (
  select
    date,
    'petrol'::text as product,
    stock as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from public.dsr_petrol
  union all
  select
    date,
    'diesel'::text as product,
    stock as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from public.dsr_diesel
),
with_opening as (
  select *,
    coalesce(
      lag(dip_stock) over (partition by product order by date),
      0
    ) as opening_stock
  from base
)
select
  date,
  product,
  opening_stock,
  receipts,
  (opening_stock + receipts) as total_stock,
  sale_from_meter,
  testing,
  net_sale,
  ((opening_stock + receipts) - net_sale) as closing_stock,
  dip_stock,
  (((opening_stock + receipts) - net_sale) - dip_stock) as variation,
  remark,
  created_by,
  created_at
from with_opening;

comment on view public.dsr_stock is 'Computed stock reconciliation view derived from dsr_petrol/dsr_diesel. No sync needed; always consistent with meter readings.';

-- ============================================================================
-- 3. DROP sync_dsr_receipts_from_stock RPC (no longer needed — single source of truth)
-- ============================================================================

drop function if exists public.sync_dsr_receipts_from_stock(date, date);

-- ============================================================================
-- 4. DROP UNUSED TABLES (never referenced in application code)
-- ============================================================================

drop table if exists public.lube_invoice_items cascade;
drop table if exists public.lube_invoices cascade;
drop table if exists public.lube_products cascade;
drop table if exists public.purchase_entries cascade;
