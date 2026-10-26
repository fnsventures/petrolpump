-- dsr and dsr_cost picked one row per date with distinct on (date), which
-- sorts the whole of dsr_petrol / dsr_diesel before a caller's date filter
-- can narrow it. dsr_petrol_date_unique / dsr_diesel_date_unique
-- (20260820160000) already guarantee one row per date, so read the tables
-- directly. A date range now uses the unique index. Output columns are the same.
-- dsr_cost's admin check runs once per query as an initPlan.

create or replace view public.dsr
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
  from public.dsr_petrol
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
  from public.dsr_diesel;

comment on view public.dsr is
  'Staff union of dsr_petrol and dsr_diesel. One row per product per date (unique date constraint). Does not include buying_price_per_litre.';

create or replace view public.dsr_cost
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
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at,
    purchase_delivery_per_kl, purchase_lfr_per_kl,
    purchase_delivery_total, purchase_delivery_qty_kl,
    purchase_lfr_total, purchase_lfr_qty_kl
  from public.dsr_diesel
) rows
where (select public.is_admin());

comment on view public.dsr_cost is
  'Admin-only DSR union, including buying_price_per_litre. Supervisors get no rows.';
