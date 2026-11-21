// @ts-check
/* global normalizeProduct, getDsrNetSaleLitres, getDsrSaleRate, storedToLandedBuyingRatePerLitre */
/**
 * Fuel buying rates and profit & loss: receipt-rate lookup, landed cost, fuel margin,
 * testing-expense split and the P&L summary. Loaded only by the pages that report profit
 * (dashboard, analysis, reports) — see _partials/app-pages.json. Needs js/utils.js for
 * normalizeProduct / getDsrNetSaleLitres / getDsrSaleRate, and js/purchaseTaxUtils.js for landed rates.
 */

/**
 * Receipt-rate lookup + landed-rate cache for P&L, analysis, and trading account.
 * Builds receipt indexes once; memoizes stored and landed rates per product/date.
 * Per-receipt delivery/LFR (from Purchase cost) ride with the carried pre-VAT rate.
 * @param {Array<{ date: string, product: string, buying_price_per_litre: number, purchase_delivery_per_kl?: number, purchase_lfr_per_kl?: number }>} receiptRows
 */
function createBuyingRateContext(receiptRows) {
  const byProduct = new Map();
  (receiptRows ?? []).forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!byProduct.has(p)) byProduct.set(p, []);
    byProduct.get(p).push({
      date: row.date,
      buying_price_per_litre: Number(row.buying_price_per_litre),
      purchase_delivery_per_kl: row.purchase_delivery_per_kl,
      purchase_lfr_per_kl: row.purchase_lfr_per_kl,
    });
  });
  byProduct.forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date)));

  const storedCache = new Map();
  const receiptCache = new Map();
  const landedCache = new Map();

  function findReceipt(product, date) {
    const p = normalizeProduct(product);
    const cacheKey = `${p}\0${date}`;
    if (receiptCache.has(cacheKey)) return receiptCache.get(cacheKey);

    const list = byProduct.get(p);
    let found = null;
    if (list?.length) {
      let lo = 0;
      let hi = list.length - 1;
      let foundIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].date <= date) {
          foundIdx = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      const candidate = foundIdx >= 0 ? list[foundIdx] : null;
      if (
        candidate != null &&
        Number.isFinite(candidate.buying_price_per_litre) &&
        candidate.buying_price_per_litre > 0
      ) {
        found = candidate;
      }
    }
    receiptCache.set(cacheKey, found);
    return found;
  }

  function getStored(product, date) {
    const p = normalizeProduct(product);
    const cacheKey = `${p}\0${date}`;
    if (storedCache.has(cacheKey)) return storedCache.get(cacheKey);
    const found = findReceipt(product, date);
    const stored = found?.buying_price_per_litre ?? null;
    storedCache.set(cacheKey, stored);
    return stored;
  }

  function chargeOverridesFromReceipt(receipt) {
    if (!receipt) return { deliveryPerKl: 0, lfrPerKl: 0 };
    const deliveryPerKl = Number(receipt.purchase_delivery_per_kl);
    const lfrPerKl = Number(receipt.purchase_lfr_per_kl);
    return {
      deliveryPerKl: Number.isFinite(deliveryPerKl) && deliveryPerKl >= 0 ? deliveryPerKl : 0,
      lfrPerKl: Number.isFinite(lfrPerKl) && lfrPerKl >= 0 ? lfrPerKl : 0,
    };
  }

  function getLanded(stored, product, date, overrides) {
    if (stored == null || !Number.isFinite(stored) || stored <= 0) return null;
    const p = normalizeProduct(product);
    const day = date ? String(date).slice(0, 10) : "";
    const dOv = overrides?.deliveryPerKl;
    const lOv = overrides?.lfrPerKl;
    const cacheKey = `${p}\0${stored}\0${day}\0${dOv ?? ""}\0${lOv ?? ""}`;
    if (landedCache.has(cacheKey)) return landedCache.get(cacheKey);
    const landed = toLandedBuyingRatePerLitre(stored, p, day || null, overrides);
    landedCache.set(cacheKey, landed);
    return landed;
  }

  function getLandedForRow(row) {
    const date = row?.date;
    const receipt = findReceipt(row?.product, date);
    const stored = resolveStoredBuyingRate(row, getStored);
    const overrides = chargeOverridesFromReceipt(
      receipt || {
        purchase_delivery_per_kl: row?.purchase_delivery_per_kl,
        purchase_lfr_per_kl: row?.purchase_lfr_per_kl,
      }
    );
    return getLanded(stored, row?.product, date, overrides);
  }

  function getLandedForDate(product, date) {
    const receipt = findReceipt(product, date);
    return getLanded(
      getStored(product, date),
      product,
      date,
      chargeOverridesFromReceipt(receipt)
    );
  }

  return { getStored, getLandedForRow, getLandedForDate, getBuying: getStored };
}

/**
 * Stored pre-VAT buying rate for a sale day.
 * Uses the latest receipt on or before that date (see createBuyingRateContext).
 * Row value is only a fallback on receipt days — sale-only rows may carry stale
 * buying_price_per_litre from imports and must not override receipt history.
 */
function resolveStoredBuyingRate(row, getBuying) {
  const fromMap = getBuying?.(row?.product, row?.date);
  if (fromMap != null && Number.isFinite(fromMap) && fromMap > 0) return fromMap;
  const isReceiptDay = Number(row?.receipts ?? 0) > 0;
  const rowRate = Number(row?.buying_price_per_litre);
  if (isReceiptDay && Number.isFinite(rowRate) && rowRate > 0) return rowRate;
  return null;
}

/**
 * Landed buying rate (₹/L) for margin/cost: pre-VAT + delivery + VAT/LST + LFR.
 * Delivery/LFR come from the receipt that owns the pre-VAT rate (Purchase cost).
 * Missing receipt delivery/LFR → 0 (does not use Settings).
 * Never returns the raw stored pre-VAT rate — purchaseTaxUtils.js is required.
 */
function toLandedBuyingRatePerLitre(storedRatePerLitre, product, date, chargeOverrides) {
  const stored = Number(storedRatePerLitre);
  if (!Number.isFinite(stored) || stored <= 0) return null;
  if (typeof storedToLandedBuyingRatePerLitre !== "function") return null;
  return storedToLandedBuyingRatePerLitre(stored, product, date, chargeOverrides);
}

/** Landed rate from latest receipt on or before a date (opening/closing stock, trading account). */
function getLandedBuyingRateForDate(product, date, getBuyingOrCtx) {
  if (getBuyingOrCtx?.getLandedForDate) return getBuyingOrCtx.getLandedForDate(product, date);
  const stored = getBuyingOrCtx?.(product, date);
  return toLandedBuyingRatePerLitre(stored, product, date);
}

function getEffectiveBuyingRate(row, getBuyingOrCtx) {
  if (getBuyingOrCtx?.getLandedForRow) return getBuyingOrCtx.getLandedForRow(row);
  const stored = resolveStoredBuyingRate(row, getBuyingOrCtx);
  if (stored == null) return null;
  return toLandedBuyingRatePerLitre(stored, row?.product, row?.date);
}

/** Per-row fuel P&L: net litres × selling/buying rates (petrol & diesel only). */
function computeFuelRowMargin(row, getBuyingOrCtx) {
  const product = normalizeProduct(row?.product);
  if (product !== "petrol" && product !== "diesel") {
    return { revenue: 0, cost: 0, grossProfit: 0, litres: 0 };
  }
  const litres = getDsrNetSaleLitres(row);
  if (!Number.isFinite(litres) || litres <= 0) {
    return { revenue: 0, cost: 0, grossProfit: 0, litres: 0 };
  }
  const sellingRate = getDsrSaleRate(row);
  const buyingRate = getBuyingOrCtx ? getEffectiveBuyingRate(row, getBuyingOrCtx) : null;
  const revenue =
    Number.isFinite(sellingRate) && sellingRate > 0 ? litres * sellingRate : 0;
  const cost = buyingRate != null ? litres * buyingRate : 0;
  const grossProfit =
    revenue > 0 && buyingRate != null ? litres * (sellingRate - buyingRate) : 0;
  return { revenue, cost, grossProfit, litres };
}

/** Single pass: fuel revenue, cost, and gross profit from DSR rows. */
function accumulateFuelPnL(dsrRows, getBuyingOrCtx) {
  let revenue = 0;
  let missingRates = 0;
  let costOfGoods = 0;
  let fuelGrossProfit = 0;
  for (const row of dsrRows ?? []) {
    const { revenue: rowRevenue, cost, grossProfit, litres } = computeFuelRowMargin(
      row,
      getBuyingOrCtx
    );
    if (litres <= 0) continue;
    revenue += rowRevenue;
    costOfGoods += cost;
    fuelGrossProfit += grossProfit;
    const sellingRate = getDsrSaleRate(row);
    if (!Number.isFinite(sellingRate) || sellingRate <= 0) missingRates += 1;
  }
  return { revenue, missingRates, costOfGoods, fuelGrossProfit };
}

/** Net sale revenue (₹) from fuel DSR rows. */
function computeFuelRevenue(dsrRows) {
  const { revenue, missingRates } = accumulateFuelPnL(dsrRows, null);
  return { total: revenue, missingRates };
}

/** Fuel cost at effective buying rates (₹). */
function computeFuelCostOfGoods(dsrRows, getBuyingOrCtx) {
  return accumulateFuelPnL(dsrRows, getBuyingOrCtx).costOfGoods;
}

/** Fuel gross profit: net litres × (selling rate − effective buying rate). */
function computeFuelGrossProfit(dsrRows, getBuyingOrCtx) {
  return accumulateFuelPnL(dsrRows, getBuyingOrCtx).fuelGrossProfit;
}

function sumExpenseAmounts(expenseRows, { excludeTesting = false, testingOnly = false, categoryMap = null } = {}) {
  return (expenseRows ?? []).reduce((sum, row) => {
    const isTesting = isTestingExpenseRow(row, categoryMap);
    if (testingOnly && !isTesting) return sum;
    if (excludeTesting && isTesting) return sum;
    const amount = Number(row.amount ?? 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

/** MS/HS and density fuel testing — excluded from P&L net profit (tracked separately in day closing). */
const TESTING_EXPENSE_CATEGORY_SLUGS = new Set([
  "mstest",
  "hsdtest",
  "ms_testing",
  "hs_testing",
  "ms-test",
  "hs-test",
  "ms_test",
  "hs_test",
  "densitytest",
  "density_test",
  "density-test",
  "density_testing",
]);

function isTestingExpenseCategory(category, label) {
  const slug = String(category ?? "").toLowerCase();
  if (TESTING_EXPENSE_CATEGORY_SLUGS.has(slug)) return true;
  const normalizedLabel = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return (
    normalizedLabel === "ms testing" ||
    normalizedLabel === "hs testing" ||
    normalizedLabel === "hsd testing" ||
    normalizedLabel === "density test" ||
    normalizedLabel === "density testing"
  );
}

/**
 * Display / detection label for an expense row.
 * When categoryMap is provided (Reports), use Settings label — same as books bucketing.
 * Otherwise fall back to row.label, then description (Dashboard / Analysis).
 */
function getExpenseCategoryLabel(row, categoryMap) {
  const key = row?.category || "misc";
  if (categoryMap && Object.prototype.hasOwnProperty.call(categoryMap, key)) {
    return categoryMap[key] || key || "Miscellaneous";
  }
  if (row?.label) return String(row.label);
  if (!categoryMap && row?.description) return String(row.description);
  if (categoryMap) return key || "Miscellaneous";
  return key || "Miscellaneous";
}

/** Single rule for testing vs operating expense (Reports, Dashboard, Analysis). */
function isTestingExpenseRow(row, categoryMap) {
  return isTestingExpenseCategory(row?.category, getExpenseCategoryLabel(row, categoryMap));
}

/** name → label map from expense_categories rows (Settings). Empty → null (use description fallback). */
function buildExpenseCategoryMap(categories) {
  const categoryMap = {};
  (categories ?? []).forEach((c) => {
    if (c?.name == null) return;
    categoryMap[c.name] = c.label ?? c.name;
  });
  return Object.keys(categoryMap).length > 0 ? categoryMap : null;
}

/**
 * Receipt days with no buying price entered on the row itself.
 * Used for the warning UI; calculations may still use the previous receipt rate.
 */
function findMissingBuyingPriceRows(dsrRows) {
  return (dsrRows ?? []).filter((row) => {
    if (Number(row.receipts ?? 0) <= 0) return false;
    const rate = Number(row.buying_price_per_litre);
    return !Number.isFinite(rate) || rate <= 0;
  });
}

/**
 * Sale / receipt rows that cannot resolve any landed buying rate even via prior receipts.
 * @param {Function|object} getBuyingOrCtx - buying context or getStored fn
 */
function findUnresolvedBuyingRateRows(dsrRows, getBuyingOrCtx) {
  return (dsrRows ?? []).filter((row) => {
    const product = normalizeProduct(row?.product);
    if (product !== "petrol" && product !== "diesel") return false;
    const needsRate =
      getDsrNetSaleLitres(row) > 0 || Number(row?.receipts ?? 0) > 0;
    if (!needsRate) return false;
    const rate = getEffectiveBuyingRate(row, getBuyingOrCtx);
    return rate == null || !Number.isFinite(rate) || rate <= 0;
  });
}

/**
 * Unified P&L for dashboard, reports, and analysis.
 * Fuel cost uses landed buying rate per litre: (pre-VAT + delivery/L) × (1 + VAT%) + LFR/L.
 * Missing receipt-day rates fall back to the previous receipt rate for calculation;
 * missingBuyingPrice lists rows that still need an entered rate (warning only).
 * Net profit = fuel gross profit + lube sales − lube COGS − operating expenses
 * (MS/HS and density testing excluded). Requires purchaseTaxUtils.js (loaded before utils.js).
 * @param {{ dsrRows?: any[], receiptRows?: any[], expenseRows?: any[], lubeSales?: number, lubeCogs?: number,
 *   requireAllBuying?: boolean, buyingContext?: any, categoryMap?: any }} params
 */
function computeProfitLossSummary({
  dsrRows,
  receiptRows,
  expenseRows,
  lubeSales = 0,
  lubeCogs = 0,
  requireAllBuying = true,
  buyingContext = null,
  categoryMap = null,
} = {}) {
  const ctx = buyingContext ?? createBuyingRateContext(receiptRows ?? []);
  const missingBuyingPrice = findMissingBuyingPriceRows(dsrRows);
  const unresolvedBuying = findUnresolvedBuyingRateRows(dsrRows, ctx);
  // Calculate whenever a prior (or own) rate can be resolved; warn separately for unentered rows.
  const canCalculate = !requireAllBuying || unresolvedBuying.length === 0;
  const fuelPnL = accumulateFuelPnL(dsrRows, canCalculate ? ctx : null);
  const lube = Number(lubeSales ?? 0);
  const lubeCost = Math.max(0, Number(lubeCogs ?? 0));
  const testingExpenses = sumExpenseAmounts(expenseRows, { testingOnly: true, categoryMap });
  const totalExpenses = sumExpenseAmounts(expenseRows, { excludeTesting: true, categoryMap });
  const fuelGrossProfit = canCalculate ? fuelPnL.fuelGrossProfit : null;
  const lubeGrossProfit = lube - lubeCost;
  const grossProfit = fuelGrossProfit != null ? fuelGrossProfit + lubeGrossProfit : null;
  const netProfit = grossProfit != null ? grossProfit - totalExpenses : null;

  return {
    revenue: fuelPnL.revenue,
    missingRates: fuelPnL.missingRates,
    costOfGoods: canCalculate ? fuelPnL.costOfGoods + lubeCost : lubeCost,
    fuelGrossProfit,
    lubeSales: lube,
    lubeCogs: lubeCost,
    lubeGrossProfit,
    grossProfit,
    testingExpenses,
    totalExpenses,
    netProfit,
    missingBuyingPrice,
    unresolvedBuying,
    usingProvisionalBuying: canCalculate && missingBuyingPrice.length > 0,
    canCalculate,
  };
}

window.createBuyingRateContext = createBuyingRateContext;
window.resolveStoredBuyingRate = resolveStoredBuyingRate;
window.toLandedBuyingRatePerLitre = toLandedBuyingRatePerLitre;
window.getLandedBuyingRateForDate = getLandedBuyingRateForDate;
window.getEffectiveBuyingRate = getEffectiveBuyingRate;
window.computeFuelRowMargin = computeFuelRowMargin;
window.computeFuelRevenue = computeFuelRevenue;
window.computeFuelCostOfGoods = computeFuelCostOfGoods;
window.computeFuelGrossProfit = computeFuelGrossProfit;
window.sumExpenseAmounts = sumExpenseAmounts;
window.isTestingExpenseCategory = isTestingExpenseCategory;
window.getExpenseCategoryLabel = getExpenseCategoryLabel;
window.isTestingExpenseRow = isTestingExpenseRow;
window.buildExpenseCategoryMap = buildExpenseCategoryMap;
window.findMissingBuyingPriceRows = findMissingBuyingPriceRows;
window.findUnresolvedBuyingRateRows = findUnresolvedBuyingRateRows;
window.computeProfitLossSummary = computeProfitLossSummary;
