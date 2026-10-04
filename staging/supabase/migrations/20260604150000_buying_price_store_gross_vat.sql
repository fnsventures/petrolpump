-- buying_price_per_litre is stored gross (incl. purchase VAT/LST).
-- Historical rows saved as ex-VAT (default purchaseTaxInclusive) are upgraded once.

do $$
declare
  v_incl boolean;
  v_petrol_pct numeric;
  v_diesel_pct numeric;
begin
  select
    coalesce((config->'reports'->>'purchaseTaxInclusive')::boolean, false),
    coalesce((config->'reports'->>'petrolPurchaseVatPct')::numeric, 28),
    coalesce((config->'reports'->>'dieselPurchaseVatPct')::numeric, 24)
  into v_incl, v_petrol_pct, v_diesel_pct
  from public.pump_settings
  where id = 1;

  if v_incl then
    return;
  end if;

  update public.dsr_petrol
  set buying_price_per_litre = round((buying_price_per_litre * (1 + v_petrol_pct / 100))::numeric, 2)
  where buying_price_per_litre is not null and buying_price_per_litre > 0;

  update public.dsr_diesel
  set buying_price_per_litre = round((buying_price_per_litre * (1 + v_diesel_pct / 100))::numeric, 2)
  where buying_price_per_litre is not null and buying_price_per_litre > 0;
end;
$$;

comment on column public.dsr_petrol.buying_price_per_litre is
  'Admin: gross landed cost per litre (incl. purchase VAT/LST); set from P&L ex-VAT ₹/KL entry.';
comment on column public.dsr_diesel.buying_price_per_litre is
  'Admin: gross landed cost per litre (incl. purchase VAT/LST); set from P&L ex-VAT ₹/KL entry.';
