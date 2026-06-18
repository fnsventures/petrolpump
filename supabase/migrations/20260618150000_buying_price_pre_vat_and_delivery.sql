-- buying_price_per_litre is stored pre-VAT (₹/L). VAT/LST and delivery are applied in P&L and GST reports.
-- One-time conversion of OLD rows (tax-inclusive → pre-VAT): run manually —
--   scripts/buying-price-strip-vat-once.sql

update public.pump_settings
set config = jsonb_set(
  coalesce(config, '{}'::jsonb),
  '{reports,purchaseDeliveryPerKl}',
  coalesce(config #> '{reports,purchaseDeliveryPerKl}', '600'::jsonb),
  true
)
where id = 1;

comment on column public.dsr_petrol.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Admin: pre-VAT fuel cost per litre (from P&L ₹/KL entry); VAT/LST and delivery applied in P&L and reports.';
