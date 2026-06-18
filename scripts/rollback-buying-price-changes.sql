-- =============================================================================
-- ROLLBACK: undo buying-price pre-VAT migration on production database.
-- Run manually in Supabase SQL Editor — ONE block at a time.
--
-- Use this if you ran buying-price-strip-vat-once.sql or the auto-migration
-- that divided buying_price_per_litre by (1 + VAT%).
--
-- This multiplies stored rates back to tax-inclusive (previous behaviour).
-- =============================================================================


-- ─── 1) Preview — run alone ─────────────────────────────────────────────────

select
  coalesce((config->'reports'->>'buyingPriceStoredAsPreVat')::boolean, false) as was_stripped,
  coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28) as ms_vat_pct,
  coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24) as hsd_vat_pct
from public.pump_settings
where id = 1;

select 'petrol' as product, date,
  buying_price_per_litre as current_per_litre,
  round(buying_price_per_litre * 1000, 2) as current_per_kl,
  round((buying_price_per_litre * (1 + coalesce((select (config->'reports'->>'petrolPurchaseVatPct')::numeric from public.pump_settings where id = 1), 28) / 100))::numeric, 2) as restored_per_litre,
  round((buying_price_per_litre * (1 + coalesce((select (config->'reports'->>'petrolPurchaseVatPct')::numeric from public.pump_settings where id = 1), 28) / 100) * 1000)::numeric, 2) as restored_per_kl
from public.dsr_petrol
where buying_price_per_litre is not null and buying_price_per_litre > 0
order by date asc;

select 'diesel' as product, date,
  buying_price_per_litre as current_per_litre,
  round(buying_price_per_litre * 1000, 2) as current_per_kl,
  round((buying_price_per_litre * (1 + coalesce((select (config->'reports'->>'dieselPurchaseVatPct')::numeric from public.pump_settings where id = 1), 24) / 100))::numeric, 2) as restored_per_litre,
  round((buying_price_per_litre * (1 + coalesce((select (config->'reports'->>'dieselPurchaseVatPct')::numeric from public.pump_settings where id = 1), 24) / 100) * 1000)::numeric, 2) as restored_per_kl
from public.dsr_diesel
where buying_price_per_litre is not null and buying_price_per_litre > 0
order by date asc;


-- ─── 2) APPLY rollback — run alone (only if was_stripped = true) ────────────

do $$
declare
  v_was_stripped boolean;
  v_petrol_pct numeric;
  v_diesel_pct numeric;
  v_petrol_rows int;
  v_diesel_rows int;
begin
  select
    coalesce((config->'reports'->>'buyingPriceStoredAsPreVat')::boolean, false),
    coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28),
    coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24)
  into v_was_stripped, v_petrol_pct, v_diesel_pct
  from public.pump_settings
  where id = 1;

  if not v_was_stripped then
    raise notice 'Skipped: buyingPriceStoredAsPreVat is false — VAT strip may not have been applied.';
    return;
  end if;

  update public.dsr_petrol
  set buying_price_per_litre = round(
    (buying_price_per_litre * (1 + v_petrol_pct / 100))::numeric,
    2
  )
  where buying_price_per_litre is not null and buying_price_per_litre > 0;
  get diagnostics v_petrol_rows = row_count;

  update public.dsr_diesel
  set buying_price_per_litre = round(
    (buying_price_per_litre * (1 + v_diesel_pct / 100))::numeric,
    2
  )
  where buying_price_per_litre is not null and buying_price_per_litre > 0;
  get diagnostics v_diesel_rows = row_count;

  update public.pump_settings
  set config = config #- '{reports,buyingPriceStoredAsPreVat}'
  where id = 1;

  update public.pump_settings
  set config = config #- '{reports,purchaseDeliveryPerKl}'
  where id = 1;

  raise notice 'Rollback done: % petrol + % diesel row(s) restored to tax-inclusive per litre.', v_petrol_rows, v_diesel_rows;
end;
$$;

comment on column public.dsr_petrol.buying_price_per_litre is
  'Admin: gross landed cost per litre (incl. purchase VAT/LST); set from P&L ex-VAT ₹/KL entry.';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Admin: gross landed cost per litre (incl. purchase VAT/LST); set from P&L ex-VAT ₹/KL entry.';
