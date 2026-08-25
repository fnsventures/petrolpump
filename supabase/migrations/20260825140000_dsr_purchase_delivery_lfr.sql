-- Per-receipt delivery / LFR (from BPCL invoice totals) for landed buying cost.
-- Prefer these over the Settings schedule when set on a receipt day.

alter table public.dsr_petrol
  add column if not exists purchase_delivery_per_kl numeric(12, 4),
  add column if not exists purchase_lfr_per_kl numeric(12, 4),
  add column if not exists purchase_delivery_total numeric(14, 2),
  add column if not exists purchase_delivery_qty_kl numeric(12, 4),
  add column if not exists purchase_lfr_total numeric(14, 2),
  add column if not exists purchase_lfr_qty_kl numeric(12, 4);

alter table public.dsr_diesel
  add column if not exists purchase_delivery_per_kl numeric(12, 4),
  add column if not exists purchase_lfr_per_kl numeric(12, 4),
  add column if not exists purchase_delivery_total numeric(14, 2),
  add column if not exists purchase_delivery_qty_kl numeric(12, 4),
  add column if not exists purchase_lfr_total numeric(14, 2),
  add column if not exists purchase_lfr_qty_kl numeric(12, 4);

comment on column public.dsr_petrol.purchase_delivery_per_kl is
  'Delivery ₹/KL from invoice (DLY total ÷ KL). Used in landed cost; null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_petrol.purchase_lfr_per_kl is
  'LFR ₹/KL incl. GST from LFR invoice (taxable×(1+GST%)÷KL). Null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_petrol.purchase_delivery_total is
  'Invoice DLY/TAXABLE CHARGE total ₹ (audit / re-edit).';
comment on column public.dsr_petrol.purchase_delivery_qty_kl is
  'KL used with delivery total to derive purchase_delivery_per_kl.';
comment on column public.dsr_petrol.purchase_lfr_total is
  'LFR invoice taxable ₹ (usually shared across MS+HSD on the load).';
comment on column public.dsr_petrol.purchase_lfr_qty_kl is
  'Total KL on the LFR invoice (e.g. MS+HSD).';

comment on column public.dsr_diesel.purchase_delivery_per_kl is
  'Delivery ₹/KL from invoice (DLY total ÷ KL). Used in landed cost; null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_diesel.purchase_lfr_per_kl is
  'LFR ₹/KL incl. GST from LFR invoice (taxable×(1+GST%)÷KL). Null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_diesel.purchase_delivery_total is
  'Invoice DLY/TAXABLE CHARGE total ₹ (audit / re-edit).';
comment on column public.dsr_diesel.purchase_delivery_qty_kl is
  'KL used with delivery total to derive purchase_delivery_per_kl.';
comment on column public.dsr_diesel.purchase_lfr_total is
  'LFR invoice taxable ₹ (usually shared across MS+HSD on the load).';
comment on column public.dsr_diesel.purchase_lfr_qty_kl is
  'Total KL on the LFR invoice (e.g. MS+HSD).';

-- Seed LFR GST % on pump settings (applied to taxable LFR total from invoice).
update public.pump_settings
set config = jsonb_set(
  config,
  '{reports,purchaseLfrGstPct}',
  coalesce(config->'reports'->'purchaseLfrGstPct', '18'::jsonb),
  true
)
where id = 1;

-- CREATE OR REPLACE cannot insert columns mid-list (PG matches by position).
-- Drop and recreate so purchase_* columns can be added safely.
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
  ) d;

comment on view public.dsr is
  'Backward-compatible union view (one row per product per date). SELECT only; writes go to dsr_petrol / dsr_diesel.';

drop function if exists public.update_dsr_buying_price(uuid, numeric, text, text, uuid);

create or replace function public.update_dsr_buying_price(
  p_dsr_id uuid,
  p_value numeric,
  p_supplier_invoice_no text default null,
  p_supplier_gstin text default null,
  p_invoice_document_id uuid default null,
  p_purchase_delivery_per_kl numeric default null,
  p_purchase_lfr_per_kl numeric default null,
  p_purchase_delivery_total numeric default null,
  p_purchase_delivery_qty_kl numeric default null,
  p_purchase_lfr_total numeric default null,
  p_purchase_lfr_qty_kl numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta boolean := p_supplier_invoice_no is not null
    or p_supplier_gstin is not null
    or p_invoice_document_id is not null;
  v_charges boolean := p_purchase_delivery_per_kl is not null
    or p_purchase_lfr_per_kl is not null
    or p_purchase_delivery_total is not null
    or p_purchase_delivery_qty_kl is not null
    or p_purchase_lfr_total is not null
    or p_purchase_lfr_qty_kl is not null;
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;

  update public.dsr_petrol
  set
    buying_price_per_litre = p_value,
    supplier_invoice_no = case
      when not v_meta then supplier_invoice_no
      else nullif(trim(p_supplier_invoice_no), '')
    end,
    supplier_gstin = case
      when not v_meta then supplier_gstin
      else nullif(upper(trim(p_supplier_gstin)), '')
    end,
    invoice_document_id = case
      when not v_meta then invoice_document_id
      else p_invoice_document_id
    end,
    purchase_delivery_per_kl = case
      when not v_charges then purchase_delivery_per_kl
      else p_purchase_delivery_per_kl
    end,
    purchase_lfr_per_kl = case
      when not v_charges then purchase_lfr_per_kl
      else p_purchase_lfr_per_kl
    end,
    purchase_delivery_total = case
      when not v_charges then purchase_delivery_total
      else p_purchase_delivery_total
    end,
    purchase_delivery_qty_kl = case
      when not v_charges then purchase_delivery_qty_kl
      else p_purchase_delivery_qty_kl
    end,
    purchase_lfr_total = case
      when not v_charges then purchase_lfr_total
      else p_purchase_lfr_total
    end,
    purchase_lfr_qty_kl = case
      when not v_charges then purchase_lfr_qty_kl
      else p_purchase_lfr_qty_kl
    end
  where id = p_dsr_id;
  if found then return; end if;

  update public.dsr_diesel
  set
    buying_price_per_litre = p_value,
    supplier_invoice_no = case
      when not v_meta then supplier_invoice_no
      else nullif(trim(p_supplier_invoice_no), '')
    end,
    supplier_gstin = case
      when not v_meta then supplier_gstin
      else nullif(upper(trim(p_supplier_gstin)), '')
    end,
    invoice_document_id = case
      when not v_meta then invoice_document_id
      else p_invoice_document_id
    end,
    purchase_delivery_per_kl = case
      when not v_charges then purchase_delivery_per_kl
      else p_purchase_delivery_per_kl
    end,
    purchase_lfr_per_kl = case
      when not v_charges then purchase_lfr_per_kl
      else p_purchase_lfr_per_kl
    end,
    purchase_delivery_total = case
      when not v_charges then purchase_delivery_total
      else p_purchase_delivery_total
    end,
    purchase_delivery_qty_kl = case
      when not v_charges then purchase_delivery_qty_kl
      else p_purchase_delivery_qty_kl
    end,
    purchase_lfr_total = case
      when not v_charges then purchase_lfr_total
      else p_purchase_lfr_total
    end,
    purchase_lfr_qty_kl = case
      when not v_charges then purchase_lfr_qty_kl
      else p_purchase_lfr_qty_kl
    end
  where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;

comment on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid, numeric, numeric, numeric, numeric, numeric, numeric) is
  'Admin-only: set pre-VAT buying price, optional supplier invoice link, and optional per-receipt delivery/LFR.';

grant execute on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated;
