-- Books polish: BPCL / supplier invoice fields on fuel receipt days (GST purchase register).

alter table public.dsr_petrol
  add column if not exists supplier_invoice_no text,
  add column if not exists supplier_gstin text;

alter table public.dsr_diesel
  add column if not exists supplier_invoice_no text,
  add column if not exists supplier_gstin text;

comment on column public.dsr_petrol.supplier_invoice_no is
  'BPCL / supplier invoice number for this receipt day (GST purchase register).';
comment on column public.dsr_petrol.supplier_gstin is
  'Supplier GSTIN for this receipt (defaults from Settings when blank).';
comment on column public.dsr_diesel.supplier_invoice_no is
  'BPCL / supplier invoice number for this receipt day (GST purchase register).';
comment on column public.dsr_diesel.supplier_gstin is
  'Supplier GSTIN for this receipt (defaults from Settings when blank).';

-- CREATE OR REPLACE cannot insert columns before existing ones (remarks).
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
    supplier_invoice_no, supplier_gstin,
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
    supplier_invoice_no, supplier_gstin,
    remarks, created_by, created_at
  from public.dsr_diesel;

comment on view public.dsr is 'Backward-compatible union view. SELECT only; writes go to dsr_petrol / dsr_diesel.';

drop function if exists public.update_dsr_buying_price(uuid, numeric);

create or replace function public.update_dsr_buying_price(
  p_dsr_id uuid,
  p_value numeric,
  p_supplier_invoice_no text default null,
  p_supplier_gstin text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set buying price';
  end if;

  update public.dsr_petrol
  set
    buying_price_per_litre = p_value,
    supplier_invoice_no = case
      when p_supplier_invoice_no is null and p_supplier_gstin is null then supplier_invoice_no
      else nullif(trim(p_supplier_invoice_no), '')
    end,
    supplier_gstin = case
      when p_supplier_invoice_no is null and p_supplier_gstin is null then supplier_gstin
      else nullif(upper(trim(p_supplier_gstin)), '')
    end
  where id = p_dsr_id;
  if found then return; end if;

  update public.dsr_diesel
  set
    buying_price_per_litre = p_value,
    supplier_invoice_no = case
      when p_supplier_invoice_no is null and p_supplier_gstin is null then supplier_invoice_no
      else nullif(trim(p_supplier_invoice_no), '')
    end,
    supplier_gstin = case
      when p_supplier_invoice_no is null and p_supplier_gstin is null then supplier_gstin
      else nullif(upper(trim(p_supplier_gstin)), '')
    end
  where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;

comment on function public.update_dsr_buying_price(uuid, numeric, text, text) is
  'Admin-only: set buying_price_per_litre and optional supplier invoice no / GSTIN for a DSR receipt row.';

grant execute on function public.update_dsr_buying_price(uuid, numeric, text, text) to authenticated;
