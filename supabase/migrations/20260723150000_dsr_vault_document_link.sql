-- Link DSR fuel receipts to vault purchase PDFs (optional).

alter table public.dsr_petrol
  add column if not exists invoice_document_id uuid references public.invoice_documents (id) on delete set null;

alter table public.dsr_diesel
  add column if not exists invoice_document_id uuid references public.invoice_documents (id) on delete set null;

create index if not exists dsr_petrol_invoice_document_idx
  on public.dsr_petrol (invoice_document_id)
  where invoice_document_id is not null;

create index if not exists dsr_diesel_invoice_document_idx
  on public.dsr_diesel (invoice_document_id)
  where invoice_document_id is not null;

comment on column public.dsr_petrol.invoice_document_id is
  'Optional link to vault purchase PDF (invoice_documents) for this receipt day.';
comment on column public.dsr_diesel.invoice_document_id is
  'Optional link to vault purchase PDF (invoice_documents) for this receipt day.';

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
    supplier_invoice_no, supplier_gstin, invoice_document_id,
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
    supplier_invoice_no, supplier_gstin, invoice_document_id,
    remarks, created_by, created_at
  from public.dsr_diesel;

comment on view public.dsr is 'Backward-compatible union view. SELECT only; writes go to dsr_petrol / dsr_diesel.';

drop function if exists public.update_dsr_buying_price(uuid, numeric, text, text);

create or replace function public.update_dsr_buying_price(
  p_dsr_id uuid,
  p_value numeric,
  p_supplier_invoice_no text default null,
  p_supplier_gstin text default null,
  p_invoice_document_id uuid default null
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
    end
  where id = p_dsr_id;
  if not found then
    raise exception 'DSR record not found';
  end if;
end;
$$;

comment on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid) is
  'Admin-only: set buying price and optional supplier invoice / GSTIN / vault document link.';

grant execute on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid) to authenticated;
