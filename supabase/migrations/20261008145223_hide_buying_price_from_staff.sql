-- Hiding Analysis and Reports is only the menu. Supervisors still read DSR,
-- expenses, invoices, and credit, because those pages are their job.
-- buying_price_per_litre is the column that stays admin-only.
--
-- A table-level select includes every column, so revoke it and grant the
-- other columns back. The staff view dsr must not mention the column: it is
-- security invoker, and a reference would fail the whole read. Profit screens
-- read dsr_cost, which runs as the owner and returns rows only for an admin.
-- update_dsr_buying_price is already security definer and admin-only.

revoke select, insert, update on table public.dsr_petrol from public, anon, authenticated;
revoke select, insert, update on table public.dsr_diesel from public, anon, authenticated;

revoke select, insert, update (buying_price_per_litre)
  on table public.dsr_petrol from public, anon, authenticated;
revoke select, insert, update (buying_price_per_litre)
  on table public.dsr_diesel from public, anon, authenticated;

grant select, insert, update (
  id,
  date,
  tank_capacity,
  opening_pump1_nozzle1,
  opening_pump1_nozzle2,
  opening_pump2_nozzle1,
  opening_pump2_nozzle2,
  closing_pump1_nozzle1,
  closing_pump1_nozzle2,
  closing_pump2_nozzle1,
  closing_pump2_nozzle2,
  sales_pump1,
  sales_pump2,
  total_sales,
  testing,
  dip_reading,
  stock,
  receipts,
  petrol_rate,
  diesel_rate,
  remarks,
  created_by,
  created_at,
  supplier_invoice_no,
  supplier_gstin,
  invoice_document_id,
  purchase_delivery_per_kl,
  purchase_lfr_per_kl,
  purchase_delivery_total,
  purchase_delivery_qty_kl,
  purchase_lfr_total,
  purchase_lfr_qty_kl
) on table public.dsr_petrol to authenticated;

grant select, insert, update (
  id,
  date,
  tank_capacity,
  opening_pump1_nozzle1,
  opening_pump1_nozzle2,
  opening_pump2_nozzle1,
  opening_pump2_nozzle2,
  closing_pump1_nozzle1,
  closing_pump1_nozzle2,
  closing_pump2_nozzle1,
  closing_pump2_nozzle2,
  sales_pump1,
  sales_pump2,
  total_sales,
  testing,
  dip_reading,
  stock,
  receipts,
  petrol_rate,
  diesel_rate,
  remarks,
  created_by,
  created_at,
  supplier_invoice_no,
  supplier_gstin,
  invoice_document_id,
  purchase_delivery_per_kl,
  purchase_lfr_per_kl,
  purchase_delivery_total,
  purchase_delivery_qty_kl,
  purchase_lfr_total,
  purchase_lfr_qty_kl
) on table public.dsr_diesel to authenticated;

comment on column public.dsr_petrol.buying_price_per_litre is
  'Pre-VAT fuel cost per litre. Not granted to authenticated; update_dsr_buying_price (admin) writes it.';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Pre-VAT fuel cost per litre. Not granted to authenticated; update_dsr_buying_price (admin) writes it.';

-- CREATE OR REPLACE cannot remove a view column.
drop view if exists public.dsr;

create view public.dsr
with (security_invoker = true) as
  select id, date, 'petrol'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate,
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from (
    select distinct on (date)
      id, date, tank_capacity,
      opening_pump1_nozzle1, opening_pump1_nozzle2,
      opening_pump2_nozzle1, opening_pump2_nozzle2,
      closing_pump1_nozzle1, closing_pump1_nozzle2,
      closing_pump2_nozzle1, closing_pump2_nozzle2,
      sales_pump1, sales_pump2, total_sales, testing,
      dip_reading, stock, receipts,
      petrol_rate, diesel_rate,
      supplier_invoice_no, supplier_gstin, invoice_document_id,
      remarks, created_by, created_at,
      purchase_delivery_per_kl, purchase_lfr_per_kl,
      purchase_delivery_total, purchase_delivery_qty_kl,
      purchase_lfr_total, purchase_lfr_qty_kl
    from public.dsr_petrol
    order by date, created_at desc nulls last, id desc
  ) p
  union all
  select id, date, 'diesel'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate,
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from (
    select distinct on (date)
      id, date, tank_capacity,
      opening_pump1_nozzle1, opening_pump1_nozzle2,
      opening_pump2_nozzle1, opening_pump2_nozzle2,
      closing_pump1_nozzle1, closing_pump1_nozzle2,
      closing_pump2_nozzle1, closing_pump2_nozzle2,
      sales_pump1, sales_pump2, total_sales, testing,
      dip_reading, stock, receipts,
      petrol_rate, diesel_rate,
      supplier_invoice_no, supplier_gstin, invoice_document_id,
      remarks, created_by, created_at,
      purchase_delivery_per_kl, purchase_lfr_per_kl,
      purchase_delivery_total, purchase_delivery_qty_kl,
      purchase_lfr_total, purchase_lfr_qty_kl
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d;

comment on view public.dsr is
  'Staff union of dsr_petrol and dsr_diesel. One row per product per date. Does not include buying_price_per_litre.';

grant select on public.dsr to authenticated;

-- Same shape as dsr, plus buying price. Runs as the owner so it can read the
-- column. is_admin() uses the caller's login, so a supervisor gets no rows.
create view public.dsr_cost
with (security_invoker = false, security_barrier = true) as
select *
from (
  select id, date, 'petrol'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from (
    select distinct on (date) *
    from public.dsr_petrol
    order by date, created_at desc nulls last, id desc
  ) p
  union all
  select id, date, 'diesel'::text as product, tank_capacity,
    opening_pump1_nozzle1, opening_pump1_nozzle2,
    opening_pump2_nozzle1, opening_pump2_nozzle2,
    closing_pump1_nozzle1, closing_pump1_nozzle2,
    closing_pump2_nozzle1, closing_pump2_nozzle2,
    sales_pump1, sales_pump2, total_sales, testing,
    dip_reading, stock, receipts,
    petrol_rate, diesel_rate, buying_price_per_litre,
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from (
    select distinct on (date) *
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d
) rows
where public.is_admin();

comment on view public.dsr_cost is
  'Admin-only DSR union, including buying_price_per_litre. Supervisors get no rows.';

revoke all on public.dsr_cost from public, anon;
grant select on public.dsr_cost to authenticated;

-- Stock does not show buying price. Drop the column from the inner read so a
-- supervisor can still query the security-invoker view. Output columns stay the same.
create or replace view public.dsr_stock
with (security_invoker = true) as
with base as (
  select
    date,
    'petrol'::text as product,
    (
      case
        when public.dsr_meter_row_is_complete(petrol_rate, dip_reading, stock, receipts)
          then stock
        else null
      end
    )::numeric(14,2) as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from (
    select distinct on (date)
      id, date, tank_capacity, opening_pump1_nozzle1, opening_pump1_nozzle2,
      opening_pump2_nozzle1, opening_pump2_nozzle2, closing_pump1_nozzle1,
      closing_pump1_nozzle2, closing_pump2_nozzle1, closing_pump2_nozzle2,
      sales_pump1, sales_pump2, total_sales, testing, dip_reading, stock,
      receipts, petrol_rate, diesel_rate, remarks,
      created_by, created_at, supplier_invoice_no, supplier_gstin,
      invoice_document_id
    from public.dsr_petrol
    order by date, created_at desc nulls last, id desc
  ) p
  union all
  select
    date,
    'diesel'::text as product,
    (
      case
        when public.dsr_meter_row_is_complete(diesel_rate, dip_reading, stock, receipts)
          then stock
        else null
      end
    )::numeric(14,2) as dip_stock,
    receipts,
    total_sales as sale_from_meter,
    testing,
    greatest(total_sales - testing, 0) as net_sale,
    remarks as remark,
    created_by,
    created_at
  from (
    select distinct on (date)
      id, date, tank_capacity, opening_pump1_nozzle1, opening_pump1_nozzle2,
      opening_pump2_nozzle1, opening_pump2_nozzle2, closing_pump1_nozzle1,
      closing_pump1_nozzle2, closing_pump2_nozzle1, closing_pump2_nozzle2,
      sales_pump1, sales_pump2, total_sales, testing, dip_reading, stock,
      receipts, petrol_rate, diesel_rate, remarks,
      created_by, created_at, supplier_invoice_no, supplier_gstin,
      invoice_document_id
    from public.dsr_diesel
    order by date, created_at desc nulls last, id desc
  ) d
),
with_opening as (
  select
    b.*,
    coalesce(
      (
        select p.dip_stock
        from base p
        where p.product = b.product
          and p.date < b.date
          and p.dip_stock is not null
        order by p.date desc
        limit 1
      ),
      0
    )::numeric(14,2) as opening_stock
  from base b
)
select
  date,
  product,
  opening_stock,
  receipts,
  (opening_stock + receipts)::numeric(14,2) as total_stock,
  sale_from_meter,
  testing,
  net_sale,
  ((opening_stock + receipts) - net_sale)::numeric(14,2) as closing_stock,
  dip_stock,
  (
    case
      when dip_stock is null then null
      else (((opening_stock + receipts) - net_sale) - dip_stock)
    end
  )::numeric(14,2) as variation,
  remark,
  created_by,
  created_at
from with_opening;

comment on view public.dsr_stock is
  'Stock reconciliation. Incomplete meter stubs expose NULL dip_stock so opening lookback skips them.';

grant select on public.dsr_stock to authenticated;
