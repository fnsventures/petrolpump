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
 * Apply purchase VAT/LST to an entered buying rate (₹/L) when the invoice rate is ex-VAT.
 */
function grossBuyingRatePerLitre(rate, product) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0) return null;
  if (isPurchaseTaxInclusive()) return r;
  const pct = getPurchaseTaxPct(product);
  return r * (1 + pct / 100);
}

const LITRES_PER_KL = 1000;
/** Stored buying rates are ₹/L; UI and invoices use ₹/KL. Reject values that look like per-litre entry. */
const MIN_REASONABLE_BUYING_RATE_KL = 500;

function roundBuyingRatePerLitre(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  return Math.round(r * 100) / 100;
}

/**
 * Rate to persist in buying_price_per_litre (gross landed cost ₹/L incl. purchase VAT/LST).
 */
function buyingRatePerLitreForDb(ratePerLitre, product) {
  const gross = grossBuyingRatePerLitre(ratePerLitre, product);
  return gross != null ? roundBuyingRatePerLitre(gross) : null;
}

function buyingRatePerLitreToKl(ratePerLitre) {
  const r = Number(ratePerLitre);
  if (!Number.isFinite(r) || r < 0) return null;
  return r * LITRES_PER_KL;
}

/** P&amp;L entry is ₹/KL; database stores ₹/L. */
function buyingRatePerKlToLitre(rateKl) {
  const r = Number(rateKl);
  if (!Number.isFinite(r) || r <= 0) return null;
  return roundBuyingRatePerLitre(r / LITRES_PER_KL);
}

/**
 * Validate admin input (₹/KL) and convert to stored ₹/L.
 * @returns {{ ok: true, valuePerLitre: number } | { ok: false, message: string }}
 */
function validateBuyingRateKlInput(rateKl) {
  const r = Number(rateKl);
  if (!Number.isFinite(r) || r <= 0) {
    return { ok: false, message: "" };
  }
  if (r < MIN_REASONABLE_BUYING_RATE_KL) {
    return {
      ok: false,
      message:
        "Enter rate per kilolitre (1000 L), as on the BPCL invoice — not per litre. Example: ~95000, not ~95.",
    };
  }
  const valuePerLitre = buyingRatePerKlToLitre(r);
  if (valuePerLitre == null || valuePerLitre <= 0) {
    return { ok: false, message: "" };
  }
  return { ok: true, valuePerLitre };
}

function formatBuyingRatePerKl(ratePerLitre) {
  const kl = buyingRatePerLitreToKl(ratePerLitre);
  if (kl == null) return "—";
  return kl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getBuyingPriceUnitLabel() {
  return "₹/KL";
}

function getPlBuyingPriceFieldLabel() {
  return isPurchaseTaxInclusive()
    ? `Buying price (${getBuyingPriceUnitLabel()}, incl. VAT)`
    : `Buying price (ex-VAT ${getBuyingPriceUnitLabel()})`;
}

function getPlBuyingPricePlaceholder() {
  return isPurchaseTaxInclusive() ? "₹/KL incl." : "ex-VAT ₹/KL";
}

function getPlBuyingPriceHint() {
  if (isPurchaseTaxInclusive()) {
    return "Enter tax-inclusive purchase rate per kilolitre (1000 L). Selling rates come from Meter Reading.";
  }
  return `Enter ex-VAT purchase rate per kilolitre (${getPurchaseTaxPctLabel()} applied when saving). Selling rates come from Meter Reading.`;
}

/**
 * @returns {{ taxable: number, tax: number, gross: number, cgst: number, sgst: number }}
 */
function calcPurchaseLineTax(litres, ratePerLitre, taxPct, options) {
  const base = Number(litres) * Number(ratePerLitre);
  const pct = Number(taxPct);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(pct) || pct < 0) {
    return { taxable: 0, tax: 0, gross: 0, cgst: 0, sgst: 0 };
  }

  const storedGrossRate = options?.storedGrossRate === true;
  let taxable;
  let tax;
  let gross;
  if (storedGrossRate || isPurchaseTaxInclusive()) {
    gross = base;
    taxable = gross / (1 + pct / 100);
    tax = gross - taxable;
  } else {
    taxable = base;
    tax = taxable * (pct / 100);
    gross = taxable + tax;
  }

  const half = tax / 2;
  return { taxable, tax, gross, cgst: half, sgst: half };
}

Object.assign(window, {
  getPetrolPurchaseVatPct,
  getDieselPurchaseVatPct,
  isPurchaseTaxInclusive,
  getPurchaseTaxPct,
  getPurchaseTaxPctLabel,
  grossBuyingRatePerLitre,
  buyingRatePerLitreForDb,
  buyingRatePerLitreToKl,
  buyingRatePerKlToLitre,
  validateBuyingRateKlInput,
  formatBuyingRatePerKl,
  getBuyingPriceUnitLabel,
  getPlBuyingPriceFieldLabel,
  getPlBuyingPricePlaceholder,
  getPlBuyingPriceHint,
  calcPurchaseLineTax,
});
