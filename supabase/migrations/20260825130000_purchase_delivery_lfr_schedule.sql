-- Date-effective delivery + LFR schedule.
-- Each row applies from effectiveFrom (inclusive) until the next row.
-- Flat delivery/LFR fields remain as the latest mirror for display/compat.

update public.pump_settings
set config = jsonb_set(
  config,
  '{reports,purchaseDeliveryLfrSchedule}',
  coalesce(
    nullif(config->'reports'->'purchaseDeliveryLfrSchedule', 'null'::jsonb),
    jsonb_build_array(
      jsonb_build_object(
        'effectiveFrom', '2000-01-01',
        'purchaseDeliveryPerKl',
          coalesce((config->'reports'->>'purchaseDeliveryPerKl')::numeric, 600),
        'petrolPurchaseDeliveryPerKl',
          coalesce(
            (config->'reports'->>'petrolPurchaseDeliveryPerKl')::numeric,
            (config->'reports'->>'purchaseDeliveryPerKl')::numeric,
            609
          ),
        'dieselPurchaseDeliveryPerKl',
          coalesce(
            (config->'reports'->>'dieselPurchaseDeliveryPerKl')::numeric,
            (config->'reports'->>'purchaseDeliveryPerKl')::numeric,
            600
          ),
        'petrolPurchaseLfrPerKl',
          coalesce((config->'reports'->>'petrolPurchaseLfrPerKl')::numeric, 236),
        'dieselPurchaseLfrPerKl',
          coalesce((config->'reports'->>'dieselPurchaseLfrPerKl')::numeric, 197)
      )
    )
  ),
  true
)
where id = 1
  and (
    config->'reports'->'purchaseDeliveryLfrSchedule' is null
    or jsonb_typeof(config->'reports'->'purchaseDeliveryLfrSchedule') <> 'array'
    or jsonb_array_length(coalesce(config->'reports'->'purchaseDeliveryLfrSchedule', '[]'::jsonb)) = 0
  );
