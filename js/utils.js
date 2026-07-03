/**
 * Shared utilities for the app.
 */

const FILTER_STORAGE_PREFIX = "petrolpump_filter_";

/**
 * Escape HTML for safe insertion into innerHTML.
 * @param {*} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Debounce a function — waits until calls stop for `waitMs`.
 * @param {Function} fn
 * @param {number} waitMs
 * @returns {Function}
 */
function debounce(fn, waitMs = 150) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), waitMs);
  };
}

/**
 * Throttle a function — at most once per `limitMs`.
 * @param {Function} fn
 * @param {number} limitMs
 * @returns {Function}
 */
function throttle(fn, limitMs = 150) {
  let last = 0;
  let pending = null;
  return function throttled(...args) {
    const now = Date.now();
    const run = () => {
      last = Date.now();
      fn.apply(this, args);
    };
    if (now - last >= limitMs) {
      run();
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        run();
      }, limitMs - (now - last));
    }
  };
}

/**
 * Convert a Date (or date string) to YYYY-MM-DD in local timezone.
 * @param {Date|string} [date] - defaults to now
 * @returns {string}
 */
function toLocalDateString(date) {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) return getLocalDateString();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a Date object as YYYY-MM-DD (local timezone).
 * @param {Date} date
 * @returns {string}
 */
function formatDateInput(date) {
  return toLocalDateString(date);
}

/**
 * Format YYYY-MM-DD for display (e.g. "10 Feb 2025").
 * @param {string|null|undefined} dateStr
 * @returns {string}
 */
function formatDisplayDate(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format YYYY-MM-DD for tables/reports (e.g. "10/02/2025").
 * @param {string|null|undefined} dateStr
 * @returns {string}
 */
function formatNumericDate(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Format a number with fixed decimal places (no currency symbol).
 * @param {number|null|undefined} value
 * @param {number} [fractionDigits=2]
 * @returns {string}
 */
function formatNumberPlain(value, fractionDigits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Single letter for avatar fallback (first letter of name or email local part).
 * @param {string|null|undefined} nameOrEmail
 * @returns {string}
 */
function getAvatarInitial(nameOrEmail) {
  const raw = String(nameOrEmail ?? "").trim();
  if (!raw) return "?";

  if (raw.includes("@")) {
    const local = raw.split("@")[0] ?? "";
    const letter = (local.replace(/[^a-zA-Z0-9]/g, "").charAt(0) || local.charAt(0) || "?");
    return letter.toUpperCase();
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  const letter = parts[0]?.[0] || raw[0] || "?";
  return letter.toUpperCase();
}

/**
 * Two-letter initials for avatar chips (name or email).
 * @param {string|null|undefined} nameOrEmail
 * @returns {string}
 */
function getAvatarInitials(nameOrEmail) {
  const raw = String(nameOrEmail ?? "").trim();
  if (!raw) return "";

  if (raw.includes("@")) {
    const local = raw.split("@")[0] ?? "";
    const parts = local.replace(/[._+-]+/g, " ").split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    const letters = local.replace(/[^a-zA-Z0-9]/g, "");
    return (letters.slice(0, 2) || local.slice(0, 2)).toUpperCase();
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return raw.slice(0, 2).toUpperCase();
}

/**
 * Human-readable label from an email local part (e.g. operator.name → Operator Name).
 * @param {string|null|undefined} email
 * @returns {string}
 */
function formatEmailLocalLabel(email) {
  const local = String(email ?? "").trim().split("@")[0] ?? "";
  if (!local) return "";
  return local
    .replace(/[._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Normalize product name for comparisons.
 * @param {*} value
 * @returns {string}
 */
function normalizeProduct(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Format quantity with Indian locale.
 * @param {number|null|undefined} value
 * @returns {string}
 */
function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Format GST percentage label.
 * @param {number} pct
 * @returns {string}
 */
function formatGstLabel(pct) {
  if (pct < 0) return "Exempt";
  if (pct === 0) return "Nil";
  return pct + "%";
}

function getWeekRange(date) {
  const diffToMonday = (date.getDay() + 6) % 7;
  const start = new Date(date);
  start.setDate(date.getDate() - diffToMonday);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: formatDateInput(start), end: formatDateInput(end) };
}

function getMonthRange(year, monthIndex) {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  return { start: formatDateInput(start), end: formatDateInput(end) };
}

function getMonthNameOptions() {
  return Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1).padStart(2, "0"),
    label: new Date(2000, i, 1).toLocaleDateString("en-IN", { month: "long" }),
  }));
}

function populateMonthYearSelects(monthSelect, yearSelect, options = {}) {
  if (!monthSelect || !yearSelect) return;

  const now = new Date();
  const currentYear = now.getFullYear();
  const minYear = options.minYear ?? currentYear - 5;
  const maxYear = options.maxYear ?? currentYear + 1;

  monthSelect.innerHTML = getMonthNameOptions()
    .map(({ value, label }) => `<option value="${value}">${label}</option>`)
    .join("");

  yearSelect.innerHTML = "";
  for (let year = maxYear; year >= minYear; year -= 1) {
    yearSelect.add(new Option(String(year), String(year)));
  }
}

function readMonthYearValue(monthSelect, yearSelect) {
  const year = yearSelect?.value;
  const month = monthSelect?.value;
  if (!year || !month) return "";
  return `${year}-${month}`;
}

function writeMonthYearValue(monthSelect, yearSelect, monthValue) {
  if (!monthSelect || !yearSelect || !monthValue) return;
  const [year, month] = monthValue.split("-");
  if (!year || !month) return;

  if (![...yearSelect.options].some((opt) => opt.value === year)) {
    yearSelect.add(new Option(year, year, true, true));
  }

  monthSelect.value = month.padStart(2, "0");
  yearSelect.value = year;
}

function getLast3MonthsRange() {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 2);
  start.setDate(1);
  const lastDay = new Date(end.getFullYear(), end.getMonth() + 1, 0);
  return { start: formatDateInput(start), end: formatDateInput(lastDay) };
}

function getCustomRange(startValue, endValue) {
  if (!startValue && !endValue) return null;
  let start = startValue || endValue;
  let end = endValue || startValue;
  if (end < start) [start, end] = [end, start];
  return { start, end };
}

/**
 * Resolve date range from a filter selection value.
 * @param {string} selection - today | this-week | this-month | last-3-months | custom | date
 * @param {{ startInput?: HTMLInputElement, endInput?: HTMLInputElement, singleDate?: string }} [opts]
 * @returns {{ start: string, end: string, modeInfo?: object }|null}
 */
function resolveDateRange(selection, opts = {}) {
  const { startInput, endInput, singleDate } = opts;
  const today = new Date();
  const todayStr = toLocalDateString(today);

  if (selection === "today" || selection === "date") {
    const d = singleDate || startInput?.value || todayStr;
    return { start: d, end: d, modeInfo: { mode: selection } };
  }
  if (selection === "this-week") {
    return { ...getWeekRange(today), modeInfo: { mode: "this-week" } };
  }
  if (selection === "this-month") {
    return {
      ...getMonthRange(today.getFullYear(), today.getMonth()),
      modeInfo: { mode: "this-month" },
    };
  }
  if (selection === "last-3-months") {
    return { ...getLast3MonthsRange(), modeInfo: { mode: "last-3-months" } };
  }
  if (selection === "last-30-days") {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    return { start: formatDateInput(d), end: todayStr, modeInfo: { mode: "last-30-days" } };
  }
  if (selection === "all-time") {
    return { start: "", end: todayStr, modeInfo: { mode: "all-time" } };
  }
  if (selection === "custom") {
    const range = getCustomRange(startInput?.value, endInput?.value);
    if (!range) return null;
    return { ...range, modeInfo: { mode: "custom" } };
  }
  return null;
}

function setCustomRangeVisibility(container, startInput, endInput, isVisible) {
  if (!container) return;
  if (isVisible) container.classList.remove("hidden");
  else container.classList.add("hidden");
  if (startInput) startInput.disabled = !isVisible;
  if (endInput) endInput.disabled = !isVisible;
}

/**
 * Get persisted filter state. Returns null if none or invalid.
 * @param {string} key - e.g. 'dashboard_dsr', 'dashboard_pl', 'analysis'
 * @returns {{ range: string, start?: string, end?: string }|null}
 */
function getFilterState(key) {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_PREFIX + key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data.range === "string" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Get filter state only if valid for the given allowed ranges.
 * For "custom" range, start and end must be present.
 * @param {string} key
 * @param {Set<string>} allowedRanges - e.g. new Set(['today','this-week','this-month','custom'])
 * @returns {{ range: string, start?: string, end?: string }|null}
 */
function getValidFilterState(key, allowedRanges) {
  const data = getFilterState(key);
  if (!data || !allowedRanges.has(data.range)) return null;
  if (data.range === "date" && !data.start) return null;
  if (data.range === "custom" && (!data.start || !data.end)) return null;
  return data;
}

/**
 * Persist filter state so it can be restored when the user comes back.
 * @param {string} key
 * @param {{ range: string, start?: string, end?: string }} state
 */
function setFilterState(key, state) {
  if (typeof localStorage === "undefined" || !state || typeof state.range !== "string") return;
  try {
    localStorage.setItem(FILTER_STORAGE_PREFIX + key, JSON.stringify(state));
  } catch (_) {}
}

/** Allowed `range` value for single-date inputs stored via {@link savePersistedDate}. */
const SINGLE_DATE_FILTER_RANGE = new Set(["date"]);

/** localStorage keys for record-form date inputs (single-date persistence). */
const RECORD_DATE_KEYS = {
  expense: "record_expense_date",
  creditTransaction: "record_credit_transaction_date",
  creditQuickSettle: "record_credit_quick_settle_date",
  creditSettle: "record_credit_settle_date",
  salaryPayment: "record_salary_payment_date",
  invoiceUpload: "record_invoice_upload_date",
  billingInvoice: "record_billing_invoice_date",
  attendance: "record_attendance_date",
  dsrPetrol: "record_dsr_petrol_date",
  dsrDiesel: "record_dsr_diesel_date",
};

/**
 * Read a persisted single-date value (dashboard snapshot, record forms, etc.).
 * @param {string} storageKey
 * @param {string} [fallback]
 * @returns {string}
 */
function getPersistedDate(storageKey, fallback) {
  const stored =
    typeof getValidFilterState === "function"
      ? getValidFilterState(storageKey, SINGLE_DATE_FILTER_RANGE)
      : null;
  return stored?.start || fallback || getLocalDateString();
}

/**
 * Persist a single-date value using the shared filter-state format.
 * @param {string} storageKey
 * @param {string} dateStr - YYYY-MM-DD
 */
function savePersistedDate(storageKey, dateStr) {
  if (dateStr && typeof setFilterState === "function") {
    setFilterState(storageKey, { range: "date", start: dateStr });
  }
}

/**
 * Restore and auto-save a single date input (record forms, snapshot pickers).
 * Priority: URL param → localStorage → current value → fallback (today).
 *
 * @param {HTMLInputElement|string} inputRef
 * @param {string} storageKey
 * @param {{ fallback?: string, urlParam?: string, saveOnChange?: boolean, onChange?: (dateStr: string) => void }} [opts]
 * @returns {string} resolved date
 */
function initPersistedDateInput(inputRef, storageKey, opts = {}) {
  const input = typeof inputRef === "string" ? document.getElementById(inputRef) : inputRef;
  const fallback = opts.fallback || getLocalDateString();
  if (!input) return fallback;

  let dateStr = null;
  if (opts.urlParam) {
    const fromUrl = new URLSearchParams(window.location.search).get(opts.urlParam);
    if (fromUrl && /^\d{4}-\d{2}-\d{2}$/.test(fromUrl)) dateStr = fromUrl;
  }
  if (!dateStr) {
    const stored = getPersistedDate(storageKey, "");
    if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) dateStr = stored;
  }
  if (!dateStr) {
    dateStr =
      input.value && /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : fallback;
  }

  input.value = dateStr;
  savePersistedDate(storageKey, dateStr);

  if (opts.saveOnChange !== false) {
    input.addEventListener("change", () => {
      const value = input.value || fallback;
      savePersistedDate(storageKey, value);
      if (typeof opts.onChange === "function") opts.onChange(value);
    });
  }

  return dateStr;
}

/**
 * Reset a form without losing chosen field values (e.g. date after record save).
 * @param {HTMLFormElement} form
 * @param {Record<string, string>} fieldValues - element id or name → value
 */
function resetFormKeepingFields(form, fieldValues) {
  if (!form || !fieldValues) return;
  form.reset();
  for (const [key, value] of Object.entries(fieldValues)) {
    if (value == null) continue;
    const el =
      form.querySelector(key.startsWith("#") ? key : `#${key}`) ||
      form.querySelector(`[name="${key}"]`);
    if (el && "value" in el) el.value = value;
  }
}

/**
 * After a successful record save: reset the form, restore fields, and sync date keys.
 * @param {HTMLFormElement} form
 * @param {Record<string, string>} fieldValues
 * @param {Record<string, string>} [dateStorageKeys] - field key → storage key
 */
function finishRecordFormSave(form, fieldValues, dateStorageKeys = {}) {
  resetFormKeepingFields(form, fieldValues);
  for (const [fieldKey, storageKey] of Object.entries(dateStorageKeys)) {
    const value = fieldValues[fieldKey];
    if (value && storageKey) savePersistedDate(storageKey, value);
  }
}

/**
 * Get today's date as YYYY-MM-DD in the user's local timezone.
 * Use this for "today" in credit payments and day closing so the same calendar day is used.
 * @returns {string}
 */
function getLocalDateString() {
  return toLocalDateString(new Date());
}

/**
 * Format a value as INR currency (₹) with 2 decimal places.
 * Returns "—" for null, undefined, or NaN.
 * @param {number|null|undefined} value
 * @returns {string}
 */
function formatCurrency(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return "₹" + Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Show global top progress bar during API calls.
 * Call hideProgress() when done (e.g. in finally).
 */
function showProgress() {
  let bar = document.getElementById("top-progress-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "top-progress-bar";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);
  }
  bar.classList.add("loading");
}

/**
 * Hide global top progress bar.
 */
function hideProgress() {
  const bar = document.getElementById("top-progress-bar");
  if (bar) bar.classList.remove("loading");
}

/**
 * Run an async function with global progress indicator.
 * @param {() => Promise<*>} fn
 * @returns {Promise<*>}
 */
async function withProgress(fn) {
  showProgress();
  try {
    return await fn();
  } finally {
    hideProgress();
  }
}

window.escapeHtml = escapeHtml;
window.debounce = debounce;
window.throttle = throttle;
window.toLocalDateString = toLocalDateString;
window.formatDateInput = formatDateInput;
window.formatDisplayDate = formatDisplayDate;
window.formatNumericDate = formatNumericDate;
window.formatNumberPlain = formatNumberPlain;
window.getAvatarInitial = getAvatarInitial;
window.getAvatarInitials = getAvatarInitials;
window.formatEmailLocalLabel = formatEmailLocalLabel;
window.normalizeProduct = normalizeProduct;
window.formatQuantity = formatQuantity;
window.formatGstLabel = formatGstLabel;
window.getWeekRange = getWeekRange;
window.getMonthRange = getMonthRange;
window.getMonthNameOptions = getMonthNameOptions;
window.populateMonthYearSelects = populateMonthYearSelects;
window.readMonthYearValue = readMonthYearValue;
window.writeMonthYearValue = writeMonthYearValue;
window.getLast3MonthsRange = getLast3MonthsRange;
window.getCustomRange = getCustomRange;
/**
 * Alias for resolveDateRange using select + date inputs (legacy name used across pages).
 * @param {string} selection
 * @param {HTMLInputElement|null|undefined} startInput
 * @param {HTMLInputElement|null|undefined} endInput
 * @returns {{ start: string, end: string, modeInfo?: { mode: string } }|null}
 */
function getRangeForSelection(selection, startInput, endInput) {
  return resolveDateRange(selection, { startInput, endInput });
}

window.resolveDateRange = resolveDateRange;
window.getRangeForSelection = getRangeForSelection;
window.setCustomRangeVisibility = setCustomRangeVisibility;
window.getLocalDateString = getLocalDateString;
window.formatCurrency = formatCurrency;
window.getFilterState = getFilterState;
window.getValidFilterState = getValidFilterState;
window.setFilterState = setFilterState;
window.SINGLE_DATE_FILTER_RANGE = SINGLE_DATE_FILTER_RANGE;
window.RECORD_DATE_KEYS = RECORD_DATE_KEYS;
window.getPersistedDate = getPersistedDate;
window.savePersistedDate = savePersistedDate;
window.initPersistedDateInput = initPersistedDateInput;
window.resetFormKeepingFields = resetFormKeepingFields;
window.finishRecordFormSave = finishRecordFormSave;
window.showProgress = showProgress;
window.hideProgress = hideProgress;
window.withProgress = withProgress;

/**
 * Sum a numeric field across rows for one fuel product (petrol / diesel).
 * @param {Array} rows
 * @param {string} product
 * @param {(row: object) => number} valueFn
 * @returns {number}
 */
function sumByProduct(rows, product, valueFn) {
  const expectedProduct = normalizeProduct(product);
  return (rows ?? []).reduce((sum, row) => {
    if (normalizeProduct(row.product) !== expectedProduct) return sum;
    return sum + Number(valueFn(row) ?? 0);
  }, 0);
}

/**
 * Petrol/diesel stock (L) for a single calendar day.
 * Prefers dsr_stock.dip_stock when a stock row exists for that product; else dsr.stock.
 * @returns {{ petrolStock: number, dieselStock: number, hasAnyRow: boolean }}
 */
function resolveDayFuelStock(stockData, dsrData, dateStr) {
  const lastDayStockRows = (stockData ?? []).filter((row) => row.date === dateStr);
  const lastDayDsrRows = (dsrData ?? []).filter((row) => row.date === dateStr);
  const hasPetrolInStock = lastDayStockRows.some(
    (row) => normalizeProduct(row.product) === "petrol"
  );
  const hasDieselInStock = lastDayStockRows.some(
    (row) => normalizeProduct(row.product) === "diesel"
  );
  const petrolStock = hasPetrolInStock
    ? sumByProduct(lastDayStockRows, "petrol", (row) => Number(row.dip_stock ?? 0))
    : sumByProduct(lastDayDsrRows, "petrol", (row) => Number(row.stock ?? 0));
  const dieselStock = hasDieselInStock
    ? sumByProduct(lastDayStockRows, "diesel", (row) => Number(row.dip_stock ?? 0))
    : sumByProduct(lastDayDsrRows, "diesel", (row) => Number(row.stock ?? 0));
  return {
    petrolStock,
    dieselStock,
    hasAnyRow: lastDayStockRows.length > 0 || lastDayDsrRows.length > 0,
  };
}

/** Net sale litres (meter sales minus testing). */
function getDsrNetSaleLitres(row) {
  return Math.max(Number(row?.total_sales ?? 0) - Number(row?.testing ?? 0), 0);
}

function getDsrSaleRate(row) {
  const product = normalizeProduct(row?.product);
  return product === "petrol"
    ? Number(row?.petrol_rate ?? 0)
    : product === "diesel"
      ? Number(row?.diesel_rate ?? 0)
      : 0;
}

/** Sum DSR sale value (₹). Day closing and dashboard total sale use includeTesting: true. */
function calculateDsrSaleRupees(rows, { includeTesting = false } = {}) {
  let total = 0;
  for (const row of rows ?? []) {
    const litres = includeTesting
      ? Number(row?.total_sales ?? 0)
      : getDsrNetSaleLitres(row);
    const rate = getDsrSaleRate(row);
    if (litres > 0 && rate > 0) total += litres * rate;
  }
  return total;
}

/**
 * Effective buying price (₹/L) from latest receipt on or before the sale date.
 * Returns landed cost for P&L: pre-VAT fuel + delivery + VAT/LST (see purchaseTaxUtils).
 * @param {Array<{ date: string, product: string, buying_price_per_litre: number }>} receiptRows
 */
function buildEffectiveBuyingMap(receiptRows) {
  const byProduct = new Map();
  (receiptRows ?? []).forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!byProduct.has(p)) byProduct.set(p, []);
    byProduct.get(p).push({
      date: row.date,
      buying_price_per_litre: Number(row.buying_price_per_litre),
    });
  });
  byProduct.forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date)));
  return function getEffectiveBuying(product, date) {
    const list = byProduct.get(normalizeProduct(product));
    if (!list?.length) return null;
    const found = list.find((r) => r.date <= date);
    return found != null && Number.isFinite(found.buying_price_per_litre)
      ? found.buying_price_per_litre
      : null;
  };
}

/** Stored (pre-VAT) buying rate — row value first, then latest receipt on or before that date. */
function resolveStoredBuyingRate(row, getBuying) {
  const rowRate = Number(row?.buying_price_per_litre);
  if (Number.isFinite(rowRate) && rowRate > 0) return rowRate;
  const fromMap = getBuying?.(row?.product, row?.date);
  return fromMap != null && Number.isFinite(fromMap) && fromMap > 0 ? fromMap : null;
}

function getEffectiveBuyingRate(row, getBuying) {
  const product = row?.product;
  const stored = resolveStoredBuyingRate(row, getBuying);
  if (stored == null) return null;
  if (typeof storedToLandedBuyingRatePerLitre === "function") {
    return storedToLandedBuyingRatePerLitre(stored, product) ?? stored;
  }
  return stored;
}

/** Per-row fuel P&L: net litres × selling/buying rates (petrol & diesel only). */
function computeFuelRowMargin(row, getBuying) {
  const product = normalizeProduct(row?.product);
  if (product !== "petrol" && product !== "diesel") {
    return { revenue: 0, cost: 0, grossProfit: 0, litres: 0 };
  }
  const litres = getDsrNetSaleLitres(row);
  if (!Number.isFinite(litres) || litres <= 0) {
    return { revenue: 0, cost: 0, grossProfit: 0, litres: 0 };
  }
  const sellingRate = getDsrSaleRate(row);
  const buyingRate = getEffectiveBuyingRate(row, getBuying);
  const revenue =
    Number.isFinite(sellingRate) && sellingRate > 0 ? litres * sellingRate : 0;
  const cost = buyingRate != null ? litres * buyingRate : 0;
  const grossProfit =
    revenue > 0 && buyingRate != null ? litres * (sellingRate - buyingRate) : 0;
  return { revenue, cost, grossProfit, litres };
}

/** Net sale revenue (₹) from fuel DSR rows. */
function computeFuelRevenue(dsrRows) {
  let total = 0;
  let missingRates = 0;
  for (const row of dsrRows ?? []) {
    const { revenue, litres } = computeFuelRowMargin(row, null);
    if (litres <= 0) continue;
    const rate = getDsrSaleRate(row);
    if (!Number.isFinite(rate) || rate <= 0) missingRates += 1;
    total += revenue;
  }
  return { total, missingRates };
}

/** Fuel cost at effective buying rates (₹). */
function computeFuelCostOfGoods(dsrRows, getBuying) {
  let total = 0;
  for (const row of dsrRows ?? []) {
    total += computeFuelRowMargin(row, getBuying).cost;
  }
  return total;
}

/** Fuel gross profit: net litres × (selling rate − effective buying rate). */
function computeFuelGrossProfit(dsrRows, getBuying) {
  let total = 0;
  for (const row of dsrRows ?? []) {
    total += computeFuelRowMargin(row, getBuying).grossProfit;
  }
  return total;
}

function sumExpenseAmounts(expenseRows, { excludeTesting = false, testingOnly = false } = {}) {
  return (expenseRows ?? []).reduce((sum, row) => {
    const isTesting = isTestingExpenseCategory(row.category);
    if (testingOnly && !isTesting) return sum;
    if (excludeTesting && isTesting) return sum;
    return sum + Number(row.amount ?? 0);
  }, 0);
}

/** MS/HS fuel testing — excluded from P&L net profit (tracked separately in day closing). */
const TESTING_EXPENSE_CATEGORY_SLUGS = new Set([
  "mstest",
  "hsdtest",
  "ms_testing",
  "hs_testing",
  "ms-test",
  "hs-test",
  "ms_test",
  "hs_test",
]);

function isTestingExpenseCategory(category, label) {
  const slug = String(category ?? "").toLowerCase();
  if (TESTING_EXPENSE_CATEGORY_SLUGS.has(slug)) return true;
  const normalizedLabel = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return normalizedLabel === "ms testing" || normalizedLabel === "hs testing" || normalizedLabel === "hsd testing";
}

/** Receipt days missing buying price (blocks P&L until admin enters ₹/KL). */
function findMissingBuyingPriceRows(dsrRows) {
  return (dsrRows ?? []).filter((row) => {
    if (Number(row.receipts ?? 0) <= 0) return false;
    const bp = row.buying_price_per_litre;
    return bp == null || bp === "" || (typeof bp === "number" && !Number.isFinite(bp));
  });
}

/**
 * Unified P&L for dashboard, reports, and analysis.
 * Fuel cost uses landed buying rate per litre: (pre-VAT + delivery/L) × (1 + VAT%).
 * Net profit = fuel gross profit + lube − operating expenses (MS/HS testing excluded).
 * Requires purchaseTaxUtils.js (loaded before utils.js).
 */
function computeProfitLossSummary({
  dsrRows,
  receiptRows,
  expenseRows,
  lubeSales = 0,
  requireAllBuying = true,
} = {}) {
  const missingBuyingPrice = findMissingBuyingPriceRows(dsrRows);
  const canCalculate = !requireAllBuying || missingBuyingPrice.length === 0;
  const getBuying = buildEffectiveBuyingMap(canCalculate ? receiptRows : []);
  const { total: revenue, missingRates } = computeFuelRevenue(dsrRows);
  const costOfGoods = canCalculate ? computeFuelCostOfGoods(dsrRows, getBuying) : 0;
  const fuelGrossProfit = canCalculate ? computeFuelGrossProfit(dsrRows, getBuying) : null;
  const lube = Number(lubeSales ?? 0);
  const testingExpenses = sumExpenseAmounts(expenseRows, { testingOnly: true });
  const totalExpenses = sumExpenseAmounts(expenseRows, { excludeTesting: true });
  const grossProfit = fuelGrossProfit != null ? fuelGrossProfit + lube : null;
  const netProfit = grossProfit != null ? grossProfit - totalExpenses : null;

  return {
    revenue,
    missingRates,
    costOfGoods,
    fuelGrossProfit,
    lubeSales: lube,
    grossProfit,
    testingExpenses,
    totalExpenses,
    netProfit,
    missingBuyingPrice,
    canCalculate,
  };
}

window.sumByProduct = sumByProduct;
window.resolveDayFuelStock = resolveDayFuelStock;
window.getDsrNetSaleLitres = getDsrNetSaleLitres;
window.getDsrSaleRate = getDsrSaleRate;
window.calculateDsrSaleRupees = calculateDsrSaleRupees;
window.buildEffectiveBuyingMap = buildEffectiveBuyingMap;
window.resolveStoredBuyingRate = resolveStoredBuyingRate;
window.getEffectiveBuyingRate = getEffectiveBuyingRate;
window.computeFuelRowMargin = computeFuelRowMargin;
window.computeFuelRevenue = computeFuelRevenue;
window.computeFuelCostOfGoods = computeFuelCostOfGoods;
window.computeFuelGrossProfit = computeFuelGrossProfit;
window.sumExpenseAmounts = sumExpenseAmounts;
window.isTestingExpenseCategory = isTestingExpenseCategory;
window.findMissingBuyingPriceRows = findMissingBuyingPriceRows;
window.computeProfitLossSummary = computeProfitLossSummary;
