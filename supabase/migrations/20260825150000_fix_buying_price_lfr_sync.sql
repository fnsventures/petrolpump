-- Fix update_dsr_buying_price: coalesce charge fields so partial updates
-- (e.g. syncing shared LFR to the sibling product) do not wipe delivery.
-- Also sync shared LFR to the other product on the same date when provided.

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
  v_date date;
  v_table text;
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
    purchase_delivery_per_kl = coalesce(p_purchase_delivery_per_kl, purchase_delivery_per_kl),
    purchase_lfr_per_kl = coalesce(p_purchase_lfr_per_kl, purchase_lfr_per_kl),
    purchase_delivery_total = coalesce(p_purchase_delivery_total, purchase_delivery_total),
    purchase_delivery_qty_kl = coalesce(p_purchase_delivery_qty_kl, purchase_delivery_qty_kl),
    purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
    purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
  where id = p_dsr_id
  returning date into v_date;
  if found then
    v_table := 'petrol';
  else
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
      purchase_delivery_per_kl = coalesce(p_purchase_delivery_per_kl, purchase_delivery_per_kl),
      purchase_lfr_per_kl = coalesce(p_purchase_lfr_per_kl, purchase_lfr_per_kl),
      purchase_delivery_total = coalesce(p_purchase_delivery_total, purchase_delivery_total),
      purchase_delivery_qty_kl = coalesce(p_purchase_delivery_qty_kl, purchase_delivery_qty_kl),
      purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
      purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
    where id = p_dsr_id
    returning date into v_date;
    if not found then
      raise exception 'DSR record not found';
    end if;
    v_table := 'diesel';
  end if;

  -- Shared LFR invoice covers MS+HSD on the same load date — keep sibling in sync.
  if p_purchase_lfr_per_kl is not null and v_date is not null then
    if v_table = 'petrol' then
      update public.dsr_diesel
      set
        purchase_lfr_per_kl = p_purchase_lfr_per_kl,
        purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
        purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
      where date = v_date and receipts > 0;
    else
      update public.dsr_petrol
      set
        purchase_lfr_per_kl = p_purchase_lfr_per_kl,
        purchase_lfr_total = coalesce(p_purchase_lfr_total, purchase_lfr_total),
        purchase_lfr_qty_kl = coalesce(p_purchase_lfr_qty_kl, purchase_lfr_qty_kl)
      where date = v_date and receipts > 0;
    end if;
  end if;
end;
$$;

comment on function public.update_dsr_buying_price(uuid, numeric, text, text, uuid, numeric, numeric, numeric, numeric, numeric, numeric) is
  'Admin-only: set pre-VAT buying price, optional supplier invoice link, and per-receipt delivery/LFR. Null charge args leave existing values. Shared LFR syncs to the other product on the same date.';

comment on column public.dsr_petrol.purchase_delivery_per_kl is
  'Delivery ₹/KL from invoice (DLY total ÷ KL). Used in landed cost; null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_petrol.purchase_lfr_per_kl is
  'LFR ₹/KL incl. GST from LFR invoice. Null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_diesel.purchase_delivery_per_kl is
  'Delivery ₹/KL from invoice (DLY total ÷ KL). Used in landed cost; null treated as 0 until entered on Purchase cost.';
comment on column public.dsr_diesel.purchase_lfr_per_kl is
  'LFR ₹/KL incl. GST from LFR invoice. Null treated as 0 until entered on Purchase cost.';
