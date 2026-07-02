/* global PumpSettings, AppConfig */

function getPetrolPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.petrolPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct;
}

function getDieselPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.dieselPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct;
}

function getPurchaseDeliveryPerKl() {
  const v = Number(PumpSettings.getCachedSync().reports?.purchaseDeliveryPerKl);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.purchaseDeliveryPerKl;
}

function getPurchaseDeliveryPerLitre() {
  return getPurchaseDeliveryPerKl() / LITRES_PER_KL;
}

function isPurchaseTaxInclusive() {
  const r = PumpSettings.getCachedSync().reports || {};
  if (typeof r.purchaseTaxInclusive === "boolean") return r.purchaseTaxInclusive;
  return AppConfig.DEFAULT_REPORTS.purchaseTaxInclusive === true;
}

/** True after one-time migration completed (skip re-running bulk conversion). */
function isBuyingPriceStoredAsPreVat() {
  return PumpSettings.getCachedSync().reports?.buyingPriceStoredAsPreVat === true;
}

/** Pre-VAT invoice entry + VAT/delivery applied in reports/P&L (default for BPCL). */
function usesPreVatBuyingPriceModel() {
  return !isPurchaseTaxInclusive();
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
const BUYING_RATE_DECIMALS = 5;

function roundBuyingRatePerLitre(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const factor = 10 ** BUYING_RATE_DECIMALS;
  return Math.round(r * factor) / factor;
}

/**
 * Landed cost (₹/L) from stored pre-VAT rate: (fuel + delivery) × (1 + VAT/LST%).
 */
function landedBuyingRatePerLitre(preVatRatePerLitre, product) {
  const r = Number(preVatRatePerLitre);
  if (!Number.isFinite(r) || r < 0) return null;
  const delivery = getPurchaseDeliveryPerLitre();
  const pct = getPurchaseTaxPct(product);
  return roundBuyingRatePerLitre((r + delivery) * (1 + pct / 100));
}

/** Convert stored DB rate to landed cost for P&L / trading. */
function storedToLandedBuyingRatePerLitre(storedRatePerLitre, product) {
  const r = Number(storedRatePerLitre);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (usesPreVatBuyingPriceModel()) {
    return landedBuyingRatePerLitre(r, product);
  }
  return r;
}

/**
 * Rate to persist in buying_price_per_litre (pre-VAT fuel cost ₹/L).
 */
function buyingRatePerLitreForDb(ratePerLitre, _product) {
  const r = Number(ratePerLitre);
  if (!Number.isFinite(r) || r < 0) return null;
  // Store invoice rate as entered; VAT/delivery applied only in reports/P&L.
  return roundBuyingRatePerLitre(r);
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
  return usesPreVatBuyingPriceModel()
    ? `Buying price (pre-VAT ${getBuyingPriceUnitLabel()})`
    : `Buying price (${getBuyingPriceUnitLabel()}, incl. VAT)`;
}

function getPlBuyingPricePlaceholder() {
  return usesPreVatBuyingPriceModel() ? "pre-VAT ₹/KL" : "₹/KL incl.";
}

function getPlBuyingPriceHint() {
  const delivery = getPurchaseDeliveryPerKl().toLocaleString("en-IN");
  if (!usesPreVatBuyingPriceModel()) {
    return "Enter tax-inclusive purchase rate per kilolitre (1000 L). Selling rates come from Meter Reading.";
  }
  return `Enter pre-VAT invoice rate per kilolitre (${getPurchaseTaxPctLabel()}). ₹${delivery}/KL delivery and VAT are applied in reports and P&L. Selling rates come from Meter Reading.`;
}

function getPurchaseGstSummaryNote() {
  const unit = getBuyingPriceUnitLabel();
  const vatLabel = getPurchaseTaxPctLabel();
  if (usesPreVatBuyingPriceModel()) {
    const delivery = getPurchaseDeliveryPerKl().toLocaleString("en-IN");
    return `Based on stock receipts (L) and pre-VAT buying price (${unit} on dashboard). VAT/LST: ${vatLabel}. ₹${delivery}/KL delivery included in gross. VAT is calculated on taxable value plus delivery.`;
  }
  return `Based on stock receipts (L) and tax-inclusive buying price (${unit} on dashboard). VAT/LST: ${vatLabel}.`;
}

function getPurchaseGstDetailNote() {
  const vatLabel = getPurchaseTaxPctLabel();
  if (usesPreVatBuyingPriceModel()) {
    const delivery = getPurchaseDeliveryPerKl().toLocaleString("en-IN");
    return `${vatLabel}. Rate column is the stored pre-VAT invoice rate. ₹${delivery}/KL delivery included in gross; VAT is on taxable + delivery.`;
  }
  return `${vatLabel}. Rate column is the stored tax-inclusive purchase rate per ${getBuyingPriceUnitLabel()}.`;
}

/**
 * @returns {{ taxable: number, tax: number, gross: number, delivery: number, cgst: number, sgst: number }}
 */
function calcPurchaseLineTax(litres, ratePerLitre, taxPct, options = {}) {
  const l = Number(litres);
  const rate = Number(ratePerLitre);
  const pct = Number(taxPct);
  if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(pct) || pct < 0) {
    return { taxable: 0, tax: 0, gross: 0, delivery: 0, cgst: 0, sgst: 0 };
  }

  const usePreVat = options.storedPreVat ?? usesPreVatBuyingPriceModel();
  let taxable;
  let tax;
  let gross;
  let delivery = 0;

  if (usePreVat) {
    taxable = l * rate;
    delivery = l * getPurchaseDeliveryPerLitre();
    const vatBase = taxable + delivery;
    tax = vatBase * (pct / 100);
    gross = taxable + tax + delivery;
  } else if (isPurchaseTaxInclusive()) {
    gross = l * rate;
    taxable = gross / (1 + pct / 100);
    tax = gross - taxable;
  } else {
    taxable = l * rate;
    tax = taxable * (pct / 100);
    gross = taxable + tax;
  }

  const half = tax / 2;
  return { taxable, tax, gross, delivery, cgst: half, sgst: half };
}

Object.assign(window, {
  getPetrolPurchaseVatPct,
  getDieselPurchaseVatPct,
  getPurchaseDeliveryPerKl,
  getPurchaseDeliveryPerLitre,
  isPurchaseTaxInclusive,
  isBuyingPriceStoredAsPreVat,
  usesPreVatBuyingPriceModel,
  getPurchaseTaxPct,
  getPurchaseTaxPctLabel,
  landedBuyingRatePerLitre,
  storedToLandedBuyingRatePerLitre,
  buyingRatePerLitreForDb,
  buyingRatePerLitreToKl,
  buyingRatePerKlToLitre,
  validateBuyingRateKlInput,
  formatBuyingRatePerKl,
  getBuyingPriceUnitLabel,
  getPlBuyingPriceFieldLabel,
  getPlBuyingPricePlaceholder,
  getPlBuyingPriceHint,
  getPurchaseGstSummaryNote,
  getPurchaseGstDetailNote,
  calcPurchaseLineTax,
});
