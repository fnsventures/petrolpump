/* global PumpSettings, AppConfig */

function getPetrolPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.petrolPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct;
}

function getDieselPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.dieselPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct;
}

function isPurchaseTaxInclusive() {
  const r = PumpSettings.getCachedSync().reports || {};
  if (typeof r.purchaseTaxInclusive === "boolean") return r.purchaseTaxInclusive;
  return AppConfig.DEFAULT_REPORTS.purchaseTaxInclusive === true;
}

/** VAT/LST % for inward fuel by product (MS = petrol, HSD = diesel). */
function getPurchaseTaxPct(product) {
  const p = String(product ?? "").trim().toLowerCase();
  if (p === "petrol") return getPetrolPurchaseVatPct();
  if (p === "diesel") return getDieselPurchaseVatPct();
  return AppConfig.DEFAULT_REPORTS.fuelGstPct;
}

function getPurchaseTaxPctLabel() {
  return `MS ${getPetrolPurchaseVatPct()}% · HSD ${getDieselPurchaseVatPct()}%`;
}

/**
 * Convert stored buying rate (₹/L) to gross cost rate for P&amp;L / trading.
 * Default: stored rate is ex-VAT (BPCL invoice); VAT/LST is added for cost.
 */
function grossBuyingRatePerLitre(rate, product) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0) return null;
  if (isPurchaseTaxInclusive()) return r;
  const pct = getPurchaseTaxPct(product);
  return r * (1 + pct / 100);
}

function getPlBuyingPriceFieldLabel() {
  return isPurchaseTaxInclusive() ? "Buying price (₹/L, incl. VAT)" : "Buying price (ex-VAT ₹/L)";
}

function getPlBuyingPriceHint() {
  if (isPurchaseTaxInclusive()) {
    return "Enter tax-inclusive purchase rate. Selling rates come from Meter Reading.";
  }
  return `Enter ex-VAT purchase rate (${getPurchaseTaxPctLabel()} added in profit calculation). Selling rates come from Meter Reading.`;
}
