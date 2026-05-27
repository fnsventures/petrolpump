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
window.normalizeProduct = normalizeProduct;
window.formatQuantity = formatQuantity;
window.formatGstLabel = formatGstLabel;
window.getWeekRange = getWeekRange;
window.getMonthRange = getMonthRange;
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
window.showProgress = showProgress;
window.hideProgress = hideProgress;
window.withProgress = withProgress;
