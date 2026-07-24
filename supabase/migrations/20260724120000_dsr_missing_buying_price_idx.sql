-- Speed missing buying-price todo scans (receipts with null/zero rate).
-- Existing receipts_buying indexes only cover rows that already have a price.

create index if not exists dsr_petrol_missing_buying_idx
  on public.dsr_petrol (date desc)
  where receipts > 0
    and (buying_price_per_litre is null or buying_price_per_litre <= 0);

create index if not exists dsr_diesel_missing_buying_idx
  on public.dsr_diesel (date desc)
  where receipts > 0
    and (buying_price_per_litre is null or buying_price_per_litre <= 0);

comment on index public.dsr_petrol_missing_buying_idx is
  'Partial index for Purchase cost / P&L todo: petrol receipts missing buying price.';

comment on index public.dsr_diesel_missing_buying_idx is
  'Partial index for Purchase cost / P&L todo: diesel receipts missing buying price.';
