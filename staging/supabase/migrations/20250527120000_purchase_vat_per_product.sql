-- Per-product purchase VAT/LST % for reports (BPCL: MS 28%, HSD 24%)

update public.pump_settings
set config = jsonb_set(
  config,
  '{reports}',
  coalesce(config->'reports', '{}'::jsonb)
    || jsonb_strip_nulls(
      jsonb_build_object(
        'petrolPurchaseVatPct',
        coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28),
        'dieselPurchaseVatPct',
        coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24),
        'purchaseTaxInclusive',
        case
          when config->'reports' ? 'purchaseTaxInclusive' then (config->'reports'->>'purchaseTaxInclusive')::boolean
          else false
        end
      )
    ),
  true
)
where id = 1;
