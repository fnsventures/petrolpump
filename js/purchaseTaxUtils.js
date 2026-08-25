/* global PumpSettings, AppConfig */

const LITRES_PER_KL = 1000;
/** Stored buying rates are ₹/L; UI and invoices use ₹/KL. Reject values that look like per-litre entry. */
const MIN_REASONABLE_BUYING_RATE_KL = 500;
const BUYING_RATE_DECIMALS = 5;
/** Schedule floor when no earlier entry exists (covers all historical days). */
const PURCHASE_CHARGE_SCHEDULE_EPOCH = "2000-01-01";

function getPetrolPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.petrolPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct;
}

function getDieselPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.dieselPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct;
}

function normalizePurchaseChargeDate(date) {
  if (date == null || date === "") return null;
  const s = String(date).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function buildPurchaseChargeEntryFromFlat(reports, effectiveFrom) {
  const r = reports || {};
  const d = AppConfig.DEFAULT_REPORTS;
  return {
    effectiveFrom: normalizePurchaseChargeDate(effectiveFrom) || PURCHASE_CHARGE_SCHEDULE_EPOCH,
    purchaseDeliveryPerKl:
      numOrNull(r.purchaseDeliveryPerKl) ?? numOrNull(d.purchaseDeliveryPerKl) ?? 600,
    petrolPurchaseDeliveryPerKl:
      numOrNull(r.petrolPurchaseDeliveryPerKl) ?? numOrNull(d.petrolPurchaseDeliveryPerKl),
    dieselPurchaseDeliveryPerKl:
      numOrNull(r.dieselPurchaseDeliveryPerKl) ?? numOrNull(d.dieselPurchaseDeliveryPerKl),
    petrolPurchaseLfrPerKl:
      numOrNull(r.petrolPurchaseLfrPerKl) ?? numOrNull(d.petrolPurchaseLfrPerKl) ?? 0,
    dieselPurchaseLfrPerKl:
      numOrNull(r.dieselPurchaseLfrPerKl) ?? numOrNull(d.dieselPurchaseLfrPerKl) ?? 0,
  };
}

function normalizePurchaseChargeScheduleEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const effectiveFrom = normalizePurchaseChargeDate(raw.effectiveFrom);
  if (!effectiveFrom) return null;
  return {
    effectiveFrom,
    purchaseDeliveryPerKl: numOrNull(raw.purchaseDeliveryPerKl),
    petrolPurchaseDeliveryPerKl: numOrNull(raw.petrolPurchaseDeliveryPerKl),
    dieselPurchaseDeliveryPerKl: numOrNull(raw.dieselPurchaseDeliveryPerKl),
    petrolPurchaseLfrPerKl: numOrNull(raw.petrolPurchaseLfrPerKl),
    dieselPurchaseLfrPerKl: numOrNull(raw.dieselPurchaseLfrPerKl),
  };
}

/**
 * Sorted ascending by effectiveFrom. Synthesizes one epoch entry from flat fields when empty.
 */
function normalizePurchaseDeliveryLfrSchedule(rawSchedule, reportsForFallback) {
  const list = Array.isArray(rawSchedule)
    ? rawSchedule.map(normalizePurchaseChargeScheduleEntry).filter(Boolean)
    : [];
  if (!list.length) {
    return [buildPurchaseChargeEntryFromFlat(reportsForFallback, PURCHASE_CHARGE_SCHEDULE_EPOCH)];
  }
  list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const deduped = [];
  list.forEach((entry) => {
    const last = deduped[deduped.length - 1];
    if (last && last.effectiveFrom === entry.effectiveFrom) {
      deduped[deduped.length - 1] = entry;
    } else {
      deduped.push(entry);
    }
  });
  return deduped;
}

function getPurchaseDeliveryLfrSchedule() {
  const r = PumpSettings.getCachedSync().reports || {};
  return normalizePurchaseDeliveryLfrSchedule(r.purchaseDeliveryLfrSchedule, r);
}

/**
 * Latest schedule row with effectiveFrom <= date.
 * No date → current (latest) row.
 */
function resolvePurchaseChargesForDate(date) {
  const schedule = getPurchaseDeliveryLfrSchedule();
  const d = normalizePurchaseChargeDate(date);
  if (!d) return schedule[schedule.length - 1];
  let chosen = schedule[0];
  for (let i = 0; i < schedule.length; i++) {
    if (schedule[i].effectiveFrom <= d) chosen = schedule[i];
    else break;
  }
  return chosen;
}

function chargesEqual(a, b) {
  if (!a || !b) return false;
  const keys = [
    "purchaseDeliveryPerKl",
    "petrolPurchaseDeliveryPerKl",
    "dieselPurchaseDeliveryPerKl",
    "petrolPurchaseLfrPerKl",
    "dieselPurchaseLfrPerKl",
  ];
  return keys.every((k) => numOrNull(a[k]) === numOrNull(b[k]));
}

/**
 * Upsert a schedule row for effectiveFrom; returns { schedule, flat } for reports save.
 * If charges match the row already active on that date, schedule is unchanged (still syncs flat).
 */
function upsertPurchaseDeliveryLfrSchedule(existingSchedule, entry, reportsForFallback) {
  const nextEntry = normalizePurchaseChargeScheduleEntry(entry);
  if (!nextEntry) {
    const schedule = normalizePurchaseDeliveryLfrSchedule(existingSchedule, reportsForFallback);
    const latest = schedule[schedule.length - 1];
    return { schedule, flat: flatFieldsFromChargeEntry(latest) };
  }

  const schedule = normalizePurchaseDeliveryLfrSchedule(existingSchedule, reportsForFallback);
  const activeBefore = (() => {
    let chosen = schedule[0];
    for (let i = 0; i < schedule.length; i++) {
      if (schedule[i].effectiveFrom <= nextEntry.effectiveFrom) chosen = schedule[i];
      else break;
    }
    return chosen;
  })();

  const idx = schedule.findIndex((e) => e.effectiveFrom === nextEntry.effectiveFrom);
  if (idx >= 0) {
    schedule[idx] = nextEntry;
  } else if (!chargesEqual(activeBefore, nextEntry)) {
    schedule.push(nextEntry);
    schedule.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }

  const normalized = normalizePurchaseDeliveryLfrSchedule(schedule, reportsForFallback);
  const latest = normalized[normalized.length - 1];
  return { schedule: normalized, flat: flatFieldsFromChargeEntry(latest) };
}

function flatFieldsFromChargeEntry(entry) {
  const e = entry || {};
  const d = AppConfig.DEFAULT_REPORTS;
  return {
    purchaseDeliveryPerKl: numOrNull(e.purchaseDeliveryPerKl) ?? d.purchaseDeliveryPerKl,
    petrolPurchaseDeliveryPerKl:
      numOrNull(e.petrolPurchaseDeliveryPerKl) ?? d.petrolPurchaseDeliveryPerKl,
    dieselPurchaseDeliveryPerKl:
      numOrNull(e.dieselPurchaseDeliveryPerKl) ?? d.dieselPurchaseDeliveryPerKl,
    petrolPurchaseLfrPerKl: numOrNull(e.petrolPurchaseLfrPerKl) ?? d.petrolPurchaseLfrPerKl,
    dieselPurchaseLfrPerKl: numOrNull(e.dieselPurchaseLfrPerKl) ?? d.dieselPurchaseLfrPerKl,
  };
}

function removePurchaseDeliveryLfrScheduleEntry(existingSchedule, effectiveFrom, reportsForFallback) {
  const date = normalizePurchaseChargeDate(effectiveFrom);
  const schedule = normalizePurchaseDeliveryLfrSchedule(existingSchedule, reportsForFallback).filter(
    (e) => e.effectiveFrom !== date
  );
  const normalized = normalizePurchaseDeliveryLfrSchedule(schedule, reportsForFallback);
  const latest = normalized[normalized.length - 1];
  return { schedule: normalized, flat: flatFieldsFromChargeEntry(latest) };
}

function deliveryFromCharges(charges, product) {
  const p = String(product ?? "").trim().toLowerCase();
  const shared =
    numOrNull(charges?.purchaseDeliveryPerKl) ??
    numOrNull(AppConfig.DEFAULT_REPORTS.purchaseDeliveryPerKl) ??
    600;
  if (p === "petrol") {
    return numOrNull(charges?.petrolPurchaseDeliveryPerKl) ?? shared;
  }
  if (p === "diesel") {
    return numOrNull(charges?.dieselPurchaseDeliveryPerKl) ?? shared;
  }
  return shared;
}

function lfrFromCharges(charges, product) {
  const p = String(product ?? "").trim().toLowerCase();
  if (p === "petrol") {
    return (
      numOrNull(charges?.petrolPurchaseLfrPerKl) ??
      numOrNull(AppConfig.DEFAULT_REPORTS.petrolPurchaseLfrPerKl) ??
      0
    );
  }
  if (p === "diesel") {
    return (
      numOrNull(charges?.dieselPurchaseLfrPerKl) ??
      numOrNull(AppConfig.DEFAULT_REPORTS.dieselPurchaseLfrPerKl) ??
      0
    );
  }
  return 0;
}

/** @param {string} [date] YYYY-MM-DD — omit for current (latest) rates */
function getPurchaseDeliveryPerKl(product, date) {
  return deliveryFromCharges(resolvePurchaseChargesForDate(date), product);
}

function getPurchaseDeliveryPerLitre(product, date) {
  return getPurchaseDeliveryPerKl(product, date) / LITRES_PER_KL;
}

function getPetrolPurchaseLfrPerKl(date) {
  return lfrFromCharges(resolvePurchaseChargesForDate(date), "petrol");
}

function getDieselPurchaseLfrPerKl(date) {
  return lfrFromCharges(resolvePurchaseChargesForDate(date), "diesel");
}

/** LFR ₹/KL (incl. GST on the LFR invoice) by product. */
function getPurchaseLfrPerKl(product, date) {
  return lfrFromCharges(resolvePurchaseChargesForDate(date), product);
}

function getPurchaseLfrPerLitre(product, date) {
  return getPurchaseLfrPerKl(product, date) / LITRES_PER_KL;
}

function isPurchaseTaxInclusive() {
  const r = PumpSettings.getCachedSync().reports || {};
  if (typeof r.purchaseTaxInclusive === "boolean") return r.purchaseTaxInclusive;
  return AppConfig.DEFAULT_REPORTS.purchaseTaxInclusive === true;
}

/** Pre-VAT invoice entry + VAT/delivery/LFR applied in reports/P&L (default for BPCL). */
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

function getPurchaseLfrGstPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.purchaseLfrGstPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.purchaseLfrGstPct;
}

/** ₹/KL from invoice total ÷ quantity (KL). */
function ratePerKlFromTotalAndQty(totalAmount, qtyKl) {
  const t = Number(totalAmount);
  const q = Number(qtyKl);
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(q) || q <= 0) return null;
  return Math.round((t / q) * 10000) / 10000;
}

/**
 * LFR ₹/KL including GST from taxable invoice total.
 * Example: 2133 taxable ÷ 12 KL × 1.18 → ~209.75/KL.
 */
function lfrPerKlInclGstFromTaxable(taxableTotal, qtyKl, gstPct) {
  const base = ratePerKlFromTotalAndQty(taxableTotal, qtyKl);
  if (base == null) return null;
  const pct = Number.isFinite(Number(gstPct)) ? Number(gstPct) : getPurchaseLfrGstPct();
  return Math.round(base * (1 + pct / 100) * 10000) / 10000;
}

function litresToKl(litres) {
  const l = Number(litres);
  if (!Number.isFinite(l) || l <= 0) return null;
  return Math.round((l / LITRES_PER_KL) * 10000) / 10000;
}

function getPurchaseLfrLabel(date) {
  const ms = getPetrolPurchaseLfrPerKl(date).toLocaleString("en-IN");
  const hsd = getDieselPurchaseLfrPerKl(date).toLocaleString("en-IN");
  return `MS ₹${ms}/KL · HSD ₹${hsd}/KL LFR (incl. GST)`;
}

function roundBuyingRatePerLitre(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const factor = 10 ** BUYING_RATE_DECIMALS;
  return Math.round(r * factor) / factor;
}

/**
 * Landed cost (₹/L) from stored pre-VAT rate:
 * (fuel + delivery) × (1 + VAT/LST%) + LFR (incl. GST).
 * Delivery/LFR come only from the receipt (Purchase cost). Missing → 0
 * so Settings / other days never rewrite this receipt’s cost.
 * @param {{ deliveryPerKl?: number|null, lfrPerKl?: number|null }} [chargeOverrides]
 */
function landedBuyingRatePerLitre(preVatRatePerLitre, product, date, chargeOverrides) {
  const r = Number(preVatRatePerLitre);
  if (!Number.isFinite(r) || r < 0) return null;
  const deliveryKl = numOrNull(chargeOverrides?.deliveryPerKl) ?? 0;
  const lfrKl = numOrNull(chargeOverrides?.lfrPerKl) ?? 0;
  const delivery = deliveryKl / LITRES_PER_KL;
  const lfr = lfrKl / LITRES_PER_KL;
  const pct = getPurchaseTaxPct(product);
  return roundBuyingRatePerLitre((r + delivery) * (1 + pct / 100) + lfr);
}

/** Convert stored DB rate to landed cost for P&L / trading. */
function storedToLandedBuyingRatePerLitre(storedRatePerLitre, product, date, chargeOverrides) {
  const r = Number(storedRatePerLitre);
  if (!Number.isFinite(r) || r <= 0) return null;
  if (usesPreVatBuyingPriceModel()) {
    return landedBuyingRatePerLitre(r, product, date, chargeOverrides);
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
  if (!usesPreVatBuyingPriceModel()) {
    return "Enter tax-inclusive purchase rate per kilolitre (1000 L). Selling rates come from Meter Reading.";
  }
  return `Copy figures from the BPCL invoices for that load only. VAT/LST (${getPurchaseTaxPctLabel()}) and LFR GST (${getPurchaseLfrGstPct()}%) are applied automatically. Each saved receipt keeps its own delivery/LFR — past days are unchanged.`;
}

function getPurchaseGstSummaryNote() {
  const unit = getBuyingPriceUnitLabel();
  const vatLabel = getPurchaseTaxPctLabel();
  if (usesPreVatBuyingPriceModel()) {
    return `Based on stock receipts (L) and pre-VAT buying price (${unit} on Meter Reading → Purchase cost). VAT/LST: ${vatLabel}. Delivery from that receipt’s DLY totals; LFR (incl. ${getPurchaseLfrGstPct()}% GST) from the LFR invoice — stored per receipt day.`;
  }
  return `Based on stock receipts (L) and tax-inclusive buying price (${unit} on Meter Reading → Purchase cost). VAT/LST: ${vatLabel}.`;
}

function getPurchaseGstDetailNote() {
  const vatLabel = getPurchaseTaxPctLabel();
  if (usesPreVatBuyingPriceModel()) {
    return `${vatLabel}. Rate column is the stored pre-VAT invoice rate. Delivery is from the receipt’s DLY total÷KL when saved on Purchase cost. LFR excluded here (separate invoice; in P&L landed cost).`;
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
    const deliveryPerL =
      numOrNull(options.deliveryPerKl) != null
        ? numOrNull(options.deliveryPerKl) / LITRES_PER_KL
        : 0;
    delivery = l * deliveryPerL;
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
  PURCHASE_CHARGE_SCHEDULE_EPOCH,
  getPetrolPurchaseVatPct,
  getDieselPurchaseVatPct,
  normalizePurchaseChargeDate,
  getPurchaseDeliveryLfrSchedule,
  resolvePurchaseChargesForDate,
  upsertPurchaseDeliveryLfrSchedule,
  removePurchaseDeliveryLfrScheduleEntry,
  buildPurchaseChargeEntryFromFlat,
  flatFieldsFromChargeEntry,
  getPurchaseDeliveryPerKl,
  getPurchaseDeliveryPerLitre,
  getPetrolPurchaseLfrPerKl,
  getDieselPurchaseLfrPerKl,
  getPurchaseLfrPerKl,
  getPurchaseLfrPerLitre,
  getPurchaseLfrGstPct,
  ratePerKlFromTotalAndQty,
  lfrPerKlInclGstFromTaxable,
  litresToKl,
  getPurchaseLfrLabel,
  isPurchaseTaxInclusive,
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
