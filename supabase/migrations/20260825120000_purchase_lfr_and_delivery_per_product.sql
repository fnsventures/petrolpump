-- Include BPCL LFR (Licence Fee Recovery) and optional per-product delivery in pump settings.
-- Landed buying rate = (pre-VAT + delivery) × (1 + VAT%) + LFR(incl GST).
-- LFR closes the gap vs BPCL dealer effective buying rate (fuel invoice + LFR invoice).

update public.pump_settings
set config = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          config,
          '{reports,petrolPurchaseLfrPerKl}',
          coalesce(config->'reports'->'petrolPurchaseLfrPerKl', '236'::jsonb),
          true
        ),
        '{reports,dieselPurchaseLfrPerKl}',
        coalesce(config->'reports'->'dieselPurchaseLfrPerKl', '197'::jsonb),
        true
      ),
      '{reports,petrolPurchaseDeliveryPerKl}',
      coalesce(config->'reports'->'petrolPurchaseDeliveryPerKl', '609'::jsonb),
      true
    ),
    '{reports,dieselPurchaseDeliveryPerKl}',
    coalesce(
      config->'reports'->'dieselPurchaseDeliveryPerKl',
      config->'reports'->'purchaseDeliveryPerKl',
      '600'::jsonb
    ),
    true
  ),
  '{reports,purchaseDeliveryPerKl}',
  coalesce(config->'reports'->'purchaseDeliveryPerKl', '600'::jsonb),
  true
)
where id = 1;
