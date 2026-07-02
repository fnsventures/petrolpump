-- buying_price_per_litre is stored pre-VAT (₹/L). VAT/LST and delivery are applied in P&L and GST reports.
-- One-time: strip VAT from historical rows only (date <= 2025-12-18). New entries are saved as-is by the app.

do $$
declare
  v_already_pre_vat boolean;
  v_petrol_div numeric;
  v_diesel_div numeric;
  v_delivery_kl numeric;
  v_petrol_rows int;
  v_diesel_rows int;
begin
  select
    coalesce((config->'reports'->>'buyingPriceStoredAsPreVat')::boolean, false),
    1 + coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28) / 100,
    1 + coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24) / 100,
    coalesce((config->'reports'->>'purchaseDeliveryPerKl')::numeric, 600)
  into v_already_pre_vat, v_petrol_div, v_diesel_div, v_delivery_kl
  from public.pump_settings
  where id = 1;

  if v_already_pre_vat then
    raise notice 'Skipped: buyingPriceStoredAsPreVat already true.';
    return;
  end if;

  -- dsr is a union view over dsr_petrol/dsr_diesel; drop before altering column type.
  drop view if exists public.dsr;

  alter table public.dsr_petrol
    alter column buying_price_per_litre type numeric(12, 5);

  alter table public.dsr_diesel
    alter column buying_price_per_litre type numeric(12, 5);

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

  comment on view public.dsr is 'Backward-compatible union view. SELECT only; writes go to dsr_petrol / dsr_diesel.';

  update public.dsr_petrol
  set buying_price_per_litre = round((buying_price_per_litre / v_petrol_div)::numeric, 5)
  where buying_price_per_litre is not null
    and buying_price_per_litre > 0
    and date <= '2025-12-18'::date;
  get diagnostics v_petrol_rows = row_count;

  update public.dsr_diesel
  set buying_price_per_litre = case
    when date = '2025-12-18'::date and receipts = 9000 then 72.11538
    else round((buying_price_per_litre / v_diesel_div)::numeric, 5)
  end
  where buying_price_per_litre is not null
    and buying_price_per_litre > 0
    and date <= '2025-12-18'::date;
  get diagnostics v_diesel_rows = row_count;

  update public.pump_settings
  set config = coalesce(config, '{}'::jsonb)
    || jsonb_build_object(
      'reports',
      coalesce(config->'reports', '{}'::jsonb)
        || jsonb_build_object(
          'buyingPriceStoredAsPreVat', true,
          'purchaseDeliveryPerKl', v_delivery_kl
        )
    )
  where id = 1;

  raise notice 'Pre-VAT migration done: % petrol + % diesel row(s). Delivery ₹%/KL.',
    v_petrol_rows, v_diesel_rows, v_delivery_kl;
end;
$$;

comment on column public.dsr_petrol.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';
