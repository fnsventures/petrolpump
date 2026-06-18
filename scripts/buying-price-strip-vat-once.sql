-- =============================================================================
-- ONE-TIME manual fix: convert OLD buying_price_per_litre rows from
-- tax-inclusive (e.g. ₹97,400/KL invoice figure stored per litre) to pre-VAT.
--
-- Run in Supabase SQL Editor — ONE query/block at a time (not Explain).
-- Order: 1 → 2 → 3 → 4 (preview) → 5 (apply).
--
-- No date filter: ALL receipt rows in dsr_petrol / dsr_diesel are checked.
-- Rows already at pre-VAT (~₹78,000–81,000/KL) are skipped on re-run.
-- =============================================================================


-- ─── 1) Status — run alone ─────────────────────────────────────────────────

select
  coalesce((config->'reports'->>'buyingPriceStoredAsPreVat')::boolean, false) as already_migrated,
  coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28) as ms_vat_pct,
  coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24) as hsd_vat_pct,
  coalesce((config->'reports'->>'purchaseDeliveryPerKl')::numeric, 600) as delivery_per_kl,
  coalesce((config->'billing'->>'receiptHistoryStart')::text, '2000-01-01') as receipt_history_start
from public.pump_settings
where id = 1;


-- ─── 2) Coverage — run alone (see earliest data & gaps) ──────────────────────

select
  product,
  min(date) as earliest_receipt_with_buying_price,
  max(date) as latest_receipt_with_buying_price,
  count(*) as rows_with_buying_price
from (
  select 'petrol' as product, date, buying_price_per_litre
  from public.dsr_petrol
  where receipts > 0 and buying_price_per_litre is not null and buying_price_per_litre > 0
  union all
  select 'diesel', date, buying_price_per_litre
  from public.dsr_diesel
  where receipts > 0 and buying_price_per_litre is not null and buying_price_per_litre > 0
) t
group by product
order by product;

select
  product,
  date,
  receipts
from (
  select 'petrol' as product, date, receipts
  from public.dsr_petrol
  where receipts > 0 and (buying_price_per_litre is null or buying_price_per_litre <= 0)
  union all
  select 'diesel', date, receipts
  from public.dsr_diesel
  where receipts > 0 and (buying_price_per_litre is null or buying_price_per_litre <= 0)
) t
order by date asc;


-- ─── 3) Preview MS — run alone (all history, oldest first) ───────────────────

select
  'petrol' as product,
  date,
  receipts,
  buying_price_per_litre as current_per_litre,
  round(buying_price_per_litre * 1000, 2) as current_per_kl,
  round(
    (buying_price_per_litre / (1 + coalesce((select (config->'reports'->>'petrolPurchaseVatPct')::numeric from public.pump_settings where id = 1), 28) / 100))::numeric,
    2
  ) as new_per_litre,
  round(
    (buying_price_per_litre / (1 + coalesce((select (config->'reports'->>'petrolPurchaseVatPct')::numeric from public.pump_settings where id = 1), 28) / 100) * 1000)::numeric,
    2
  ) as new_per_kl,
  case
    when buying_price_per_litre * 1000 >= 85000 then 'will convert'
    else 'skip (already pre-VAT)'
  end as action
from public.dsr_petrol
where buying_price_per_litre is not null and buying_price_per_litre > 0
order by date asc;


-- ─── 4) Preview HSD — run alone (all history, oldest first) ──────────────────

select
  'diesel' as product,
  date,
  receipts,
  buying_price_per_litre as current_per_litre,
  round(buying_price_per_litre * 1000, 2) as current_per_kl,
  round(
    (buying_price_per_litre / (1 + coalesce((select (config->'reports'->>'dieselPurchaseVatPct')::numeric from public.pump_settings where id = 1), 24) / 100))::numeric,
    2
  ) as new_per_litre,
  round(
    (buying_price_per_litre / (1 + coalesce((select (config->'reports'->>'dieselPurchaseVatPct')::numeric from public.pump_settings where id = 1), 24) / 100) * 1000)::numeric,
    2
  ) as new_per_kl,
  case
    when buying_price_per_litre * 1000 >= 85000 then 'will convert'
    else 'skip (already pre-VAT)'
  end as action
from public.dsr_diesel
where buying_price_per_litre is not null and buying_price_per_litre > 0
order by date asc;


-- ─── 5) APPLY — run alone (all history; safe to re-run) ─────────────────────
-- Converts every row that still looks like tax-inclusive ₹/KL (>= 85000/KL).
-- Does NOT use a date filter. Already pre-VAT rows are left unchanged.

do $$
declare
  v_petrol_pct numeric;
  v_diesel_pct numeric;
  v_petrol_rows int;
  v_diesel_rows int;
begin
  select
    coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28),
    coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24)
  into v_petrol_pct, v_diesel_pct
  from public.pump_settings
  where id = 1;

  update public.dsr_petrol
  set buying_price_per_litre = round(
    (buying_price_per_litre / (1 + v_petrol_pct / 100))::numeric,
    2
  )
  where buying_price_per_litre is not null
    and buying_price_per_litre > 0
    and buying_price_per_litre * 1000 >= 85000;
  get diagnostics v_petrol_rows = row_count;

  update public.dsr_diesel
  set buying_price_per_litre = round(
    (buying_price_per_litre / (1 + v_diesel_pct / 100))::numeric,
    2
  )
  where buying_price_per_litre is not null
    and buying_price_per_litre > 0
    and buying_price_per_litre * 1000 >= 85000;
  get diagnostics v_diesel_rows = row_count;

  update public.pump_settings
  set config = jsonb_set(
    coalesce(config, '{}'::jsonb),
    '{reports,buyingPriceStoredAsPreVat}',
    'true'::jsonb,
    true
  )
  where id = 1;

  raise notice 'Done: % petrol + % diesel row(s) converted (all dates, inclusive-looking rates only).', v_petrol_rows, v_diesel_rows;
end;
$$;


-- ─── 6) Optional — run alone if app only shows buying prices from April ──────
-- Sets receipt history start to beginning (P&L / reports load all receipt rows).
-- Change the date below to your pump opening date if you prefer.

/*
update public.pump_settings
set config = jsonb_set(
  coalesce(config, '{}'::jsonb),
  '{billing,receiptHistoryStart}',
  '"2000-01-01"'::jsonb,
  true
)
where id = 1;
*/
