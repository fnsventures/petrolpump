-- Fix save_invoice: insert invoice header before line items (FK on invoice_items.invoice_id)

create or replace function public.save_invoice(
  p_invoice_date date,
  p_invoice_type text,
  p_party_name text,
  p_party_address text default null,
  p_party_gstin text default null,
  p_vehicle_no text default null,
  p_mobile text default null,
  p_km_reading text default null,
  p_discount numeric default 0,
  p_notes text default null,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_invoice_id uuid;
  v_invoice_number text;
  v_subtotal numeric := 0;
  v_cgst numeric := 0;
  v_sgst numeric := 0;
  v_non_gst numeric := 0;
  v_nil_rate numeric := 0;
  v_gross numeric := 0;
  v_round_off numeric := 0;
  v_total numeric := 0;
  v_item jsonb;
  v_line_amount numeric;
  v_line_taxable numeric;
  v_line_gst numeric;
  v_line_cgst numeric;
  v_line_sgst numeric;
  v_gst_pct numeric;
  v_qty numeric;
  v_rate numeric;
begin
  v_invoice_number := public.generate_invoice_number();
  v_invoice_id := uuid_generate_v4();

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 1);
    v_rate := coalesce((v_item->>'rate')::numeric, 0);
    v_gst_pct := coalesce((v_item->>'gst_percent')::numeric, 0);
    v_line_amount := round(v_qty * v_rate, 2);

    if v_gst_pct > 0 then
      v_line_taxable := round(v_line_amount / (1 + v_gst_pct / 100), 2);
      v_line_gst := v_line_amount - v_line_taxable;
      v_line_cgst := round(v_line_gst / 2, 2);
      v_line_sgst := v_line_gst - v_line_cgst;
      v_cgst := v_cgst + v_line_cgst;
      v_sgst := v_sgst + v_line_sgst;
    elsif v_gst_pct = 0 then
      v_nil_rate := v_nil_rate + v_line_amount;
    else
      v_non_gst := v_non_gst + v_line_amount;
    end if;

    v_subtotal := v_subtotal + v_line_amount;
  end loop;

  v_gross := v_subtotal - p_discount;
  v_round_off := round(v_gross) - v_gross;
  v_total := round(v_gross);

  insert into public.invoices (
    id, invoice_number, invoice_date, invoice_type,
    party_name, party_address, party_gstin,
    vehicle_no, mobile, km_reading,
    subtotal, discount, round_off, total_amount,
    cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total,
    notes, created_by
  ) values (
    v_invoice_id, v_invoice_number, p_invoice_date, p_invoice_type,
    p_party_name, p_party_address, p_party_gstin,
    p_vehicle_no, p_mobile, p_km_reading,
    v_subtotal, p_discount, v_round_off, v_total,
    v_cgst, v_sgst, 0, v_non_gst, v_nil_rate,
    p_notes, auth.uid()
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 1);
    v_rate := coalesce((v_item->>'rate')::numeric, 0);
    v_gst_pct := coalesce((v_item->>'gst_percent')::numeric, 0);
    v_line_amount := round(v_qty * v_rate, 2);

    insert into public.invoice_items (
      invoice_id, sl_no, product_id, item_name, hsn_code,
      quantity, unit, rate, gst_percent, amount
    ) values (
      v_invoice_id,
      coalesce((v_item->>'sl_no')::integer, 1),
      case when v_item->>'product_id' is not null and v_item->>'product_id' != ''
        then (v_item->>'product_id')::uuid else null end,
      coalesce(v_item->>'item_name', 'Item'),
      v_item->>'hsn_code',
      v_qty,
      coalesce(v_item->>'unit', 'Pcs'),
      v_rate,
      v_gst_pct,
      v_line_amount
    );
  end loop;

  return jsonb_build_object(
    'id', v_invoice_id,
    'invoice_number', v_invoice_number,
    'total_amount', v_total,
    'subtotal', v_subtotal,
    'cgst', v_cgst,
    'sgst', v_sgst,
    'discount', p_discount,
    'round_off', v_round_off
  );
end;
$$;
