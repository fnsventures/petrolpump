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

const LITRES_PER_KL = 1000;
/** Stored buying rates are ₹/L; UI and invoices use ₹/KL. Reject values that look like per-litre entry. */
const MIN_REASONABLE_BUYING_RATE_KL = 500;

function getPurchaseDeliveryPerKl() {
  const v = Number(PumpSettings.getCachedSync().reports?.purchaseDeliveryPerKl);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.purchaseDeliveryPerKl;
}

function getPurchaseDeliveryPerLitre() {
  return getPurchaseDeliveryPerKl() / LITRES_PER_KL;
}

/**
 * Landed cost (₹/L) from stored pre-VAT rate: fuel + VAT/LST + per-KL delivery.
 */
function landedBuyingRatePerLitre(preVatRatePerLitre, product) {
  const r = Number(preVatRatePerLitre);
  if (!Number.isFinite(r) || r < 0) return null;
  const delivery = getPurchaseDeliveryPerLitre();
  const pct = getPurchaseTaxPct(product);
  return r * (1 + pct / 100) + delivery;
}

/** @deprecated use landedBuyingRatePerLitre */
function grossBuyingRatePerLitre(rate, product) {
  return landedBuyingRatePerLitre(rate, product);
}

function roundBuyingRatePerLitre(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  return Math.round(r * 100) / 100;
}

/**
 * Rate to persist in buying_price_per_litre (pre-VAT ₹/L from dashboard ₹/KL entry).
 * VAT/LST and delivery are applied when calculating P&amp;L and GST reports.
 */
function buyingRatePerLitreForDb(ratePerLitre, product) {
  let preVat = Number(ratePerLitre);
  if (!Number.isFinite(preVat) || preVat <= 0) return null;
  if (isPurchaseTaxInclusive()) {
    preVat = preVat / (1 + getPurchaseTaxPct(product) / 100);
  }
  return roundBuyingRatePerLitre(preVat);
}

/** Stored pre-VAT fuel rate (₹/L); same as DB value when saved from dashboard. */
function storedPreVatRatePerLitre(ratePerLitre) {
  const r = Number(ratePerLitre);
  return Number.isFinite(r) && r > 0 ? r : null;
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
    : `Buying price (pre-VAT ${getBuyingPriceUnitLabel()})`;
}

function getPlBuyingPricePlaceholder() {
  return isPurchaseTaxInclusive() ? "₹/KL incl." : "pre-VAT ₹/KL";
}

function getPlBuyingPriceHint() {
  const delivery = getPurchaseDeliveryPerKl().toLocaleString("en-IN");
  if (isPurchaseTaxInclusive()) {
    return `Enter tax-inclusive invoice rate per kilolitre (1000 L). Saved as pre-VAT per litre in the database. ${getPurchaseTaxPctLabel()} and ₹${delivery}/KL delivery are applied in P&amp;L and reports only. Selling rates come from Meter Reading.`;
  }
  return `Enter pre-VAT rate per kilolitre (saved per litre as-is). ${getPurchaseTaxPctLabel()} and ₹${delivery}/KL delivery are applied in P&amp;L and reports only. Selling rates come from Meter Reading.`;
}

/**
 * @returns {{ taxable: number, tax: number, gross: number, cgst: number, sgst: number, delivery: number, exVatRatePerLitre: number }}
 */
function calcPurchaseLineTax(litres, ratePerLitre, taxPct, options) {
  const qty = Number(litres);
  const rate = Number(ratePerLitre);
  const pct = Number(taxPct);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(pct) || pct < 0) {
    return { taxable: 0, tax: 0, gross: 0, cgst: 0, sgst: 0, delivery: 0, exVatRatePerLitre: 0 };
  }

  const storedPreVatRate =
    options?.storedPreVatRate === true ||
    options?.storedLandedRate === true ||
    options?.storedGrossRate === true;
  let taxable;
  let tax;
  let gross;
  let delivery = 0;
  let exVatRatePerLitre = rate;

  if (storedPreVatRate) {
    exVatRatePerLitre = rate;
    taxable = qty * rate;
    tax = taxable * (pct / 100);
    delivery = qty * getPurchaseDeliveryPerLitre();
    gross = taxable + tax + delivery;
  } else if (isPurchaseTaxInclusive()) {
    const fuelGrossPerLitre = rate;
    exVatRatePerLitre = fuelGrossPerLitre / (1 + pct / 100);
    taxable = qty * exVatRatePerLitre;
    tax = taxable * (pct / 100);
    gross = taxable + tax;
  } else {
    exVatRatePerLitre = rate;
    taxable = qty * rate;
    tax = taxable * (pct / 100);
    gross = taxable + tax;
  }

  const half = tax / 2;
  return { taxable, tax, gross, cgst: half, sgst: half, delivery, exVatRatePerLitre };
}

Object.assign(window, {
  getPetrolPurchaseVatPct,
  getDieselPurchaseVatPct,
  isPurchaseTaxInclusive,
  getPurchaseTaxPct,
  getPurchaseTaxPctLabel,
  getPurchaseDeliveryPerKl,
  getPurchaseDeliveryPerLitre,
  landedBuyingRatePerLitre,
  grossBuyingRatePerLitre,
  storedPreVatRatePerLitre,
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
