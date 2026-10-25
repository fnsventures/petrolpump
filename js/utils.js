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

/** Literal text for a Postgres ILIKE pattern. % and _ stay characters, not wildcards. */
function escapeIlikePattern(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Normalize a credit customer name for case-insensitive comparison. */
function normCustomerName(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Debounce a function — waits until calls stop for `waitMs`.
 * @param {Function} fn
 * @param {number} waitMs
 * @returns {Function}
 */
function debounce(fn, waitMs = 150) {
  let timer = null;
  function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), waitMs);
  }
  debounced.cancel = function cancel() {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
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
 * Convert a local date string (YYYY-MM-DD) to UTC ISO string for start of day.
 * Use this when querying timestamptz columns in the database.
 * @param {string} localDateStr - YYYY-MM-DD in local timezone
 * @returns {string} ISO string in UTC (start of day)
 */
function localDateToUtcStart(localDateStr) {
  const [y, m, d] = String(localDateStr).split("-").map(Number);
  if (!y || !m || !d) return new Date().toISOString();
  // Create date at midnight in local timezone, then convert to UTC
  const dt = new Date(y, m - 1, d, 0, 0, 0);
  return dt.toISOString();
}

/**
 * Convert a local date string (YYYY-MM-DD) to UTC ISO string for end of day.
 * Use this when querying timestamptz columns in the database.
 * @param {string} localDateStr - YYYY-MM-DD in local timezone
 * @returns {string} ISO string in UTC (end of day, 23:59:59.999)
 */
function localDateToUtcEnd(localDateStr) {
  const [y, m, d] = String(localDateStr).split("-").map(Number);
  if (!y || !m || !d) return new Date().toISOString();
  // Create date at 23:59:59.999 in local timezone, then convert to UTC
  const dt = new Date(y, m - 1, d, 23, 59, 59, 999);
  return dt.toISOString();
}

/**
 * Get UTC range for a local date (for querying timestamptz columns).
 * @param {string} localDateStr - YYYY-MM-DD in local timezone
 * @returns {{ start: string, end: string }} ISO strings in UTC
 */
function getUtcRangeForLocalDate(localDateStr) {
  return {
    start: localDateToUtcStart(localDateStr),
    end: localDateToUtcEnd(localDateStr),
  };
}

/**
 * Add days to a YYYY-MM-DD string in local calendar time.
 * @param {string} yyyyMmDd
 * @param {number} days
 * @returns {string}
 */
function addDaysToDateString(yyyyMmDd, days) {
  const base = String(yyyyMmDd || "").slice(0, 10);
  const [y, m, d] = base.split("-").map(Number);
  if (!y || !m || !d) return base;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + (Number(days) || 0));
  return toLocalDateString(dt);
}

/**
 * Shift a YYYY-MM value by whole months in local calendar time.
 * @param {string} yyyyMm
 * @param {number} months
 * @returns {string}
 */
function addMonthsToMonthValue(yyyyMm, months) {
  const [y, m] = String(yyyyMm || "").split("-").map(Number);
  if (!y || !m) return String(yyyyMm || "");
  const dt = new Date(y, m - 1 + (Number(months) || 0), 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

function dateStepBound(value) {
  if (typeof value === "function") value = value();
  const s = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function monthStepBound(value) {
  if (typeof value === "function") value = value();
  const s = String(value || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : "";
}

function createDateStepButton(label, glyph, text, iconFirst) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "button-secondary date-step";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = glyph;
  const words = document.createElement("span");
  words.className = "date-step-text";
  words.textContent = text;
  if (iconFirst) btn.append(icon, words);
  else btn.append(words, icon);
  return btn;
}

/**
 * Previous / next day around a date input.
 * Steps exactly one local calendar day. The browser's own date spinner is not used:
 * on some desktop browsers that control moves a week when the weekday segment is active.
 *
 * @param {HTMLInputElement} input
 * @param {{ compact?: boolean, min?: string|(() => string), max?: string|(() => string), dispatch?: boolean, beforeStep?: (target: string, current: string) => boolean|Promise<boolean>, onStep?: (target: string, current: string) => void }} [opts]
 * @returns {{ sync: () => void } | null}
 */
function mountDateStepper(input, opts = {}) {
  if (!input || input.dataset.dateStepper === "1") return input?._dateStepper || null;
  if (!input.parentNode) return null;
  input.dataset.dateStepper = "1";
  input.step = "1";

  const wrap = document.createElement("div");
  wrap.className = "date-stepper" + (opts.compact ? " date-stepper--compact" : "");
  const prev = createDateStepButton("Previous day", "‹", "Prev", true);
  const next = createDateStepButton("Next day", "›", "Next", false);
  input.parentNode.insertBefore(wrap, input);
  wrap.append(prev, input, next);

  function sync() {
    const value = input.value || "";
    const min = dateStepBound(opts.min);
    const max = dateStepBound(opts.max);
    prev.disabled = !!(value && min && value <= min);
    next.disabled = !!(value && max && value >= max);
    prev.title = prev.disabled ? "Already at the earliest day" : "Previous day";
    next.title = next.disabled ? "Already at the latest day" : "Next day";
  }

  async function step(days, event) {
    event?.preventDefault();
    event?.stopPropagation();
    const delta = Number(days) < 0 ? -1 : 1;
    const current = input.value?.trim() || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(current)) return;
    let target = addDaysToDateString(current, delta);
    const min = dateStepBound(opts.min);
    const max = dateStepBound(opts.max);
    if (min && target < min) target = min;
    if (max && target > max) target = max;
    if (!target || target === current) {
      sync();
      return;
    }
    if (typeof opts.beforeStep === "function") {
      const ok = await opts.beforeStep(target, current);
      if (!ok) return;
    }
    // Blur before writing. A focused weekday segment treats a value change as a one-week step.
    input.blur();
    input.step = "1";
    input.value = target;
    if (input.value !== target) input.value = target;
    sync();
    if (opts.dispatch !== false) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (typeof opts.onStep === "function") opts.onStep(target, current);
  }

  prev.addEventListener("click", (event) => {
    void step(-1, event);
  });
  next.addEventListener("click", (event) => {
    void step(1, event);
  });
  input.addEventListener("change", sync);

  const api = { sync };
  input._dateStepper = api;
  sync();
  return api;
}

/**
 * Previous / next month for a month + year select pair.
 * Pass wrapSelector to put the buttons around an existing control (attendance).
 * Otherwise the two selects are grouped between the buttons.
 *
 * @param {HTMLSelectElement} monthSelect
 * @param {HTMLSelectElement} yearSelect
 * @param {{ wrapSelector?: string, min?: string|(() => string), max?: string|(() => string) }} [opts]
 * @returns {{ sync: () => void } | null}
 */
function mountMonthStepper(monthSelect, yearSelect, opts = {}) {
  if (!monthSelect || !yearSelect || monthSelect.dataset.monthStepper === "1") {
    return monthSelect?._monthStepper || null;
  }
  if (!monthSelect.parentNode) return null;
  monthSelect.dataset.monthStepper = "1";

  const prev = createDateStepButton("Previous month", "‹", "Prev", true);
  const next = createDateStepButton("Next month", "›", "Next", false);
  const host = opts.wrapSelector ? monthSelect.closest(opts.wrapSelector) : null;
  if (host?.parentNode) {
    const outer = document.createElement("div");
    outer.className = "date-stepper date-stepper--month";
    host.parentNode.insertBefore(outer, host);
    outer.append(prev, host, next);
  } else {
    const group = document.createElement("div");
    group.className = "date-stepper date-stepper--month";
    monthSelect.before(group);
    group.append(prev, monthSelect, yearSelect, next);
  }

  function earliestMonth() {
    const years = [...yearSelect.options].map((opt) => opt.value).filter((value) => /^\d{4}$/.test(value));
    if (!years.length) return "";
    years.sort();
    return `${years[0]}-01`;
  }

  function sync() {
    const value = readMonthYearValue(monthSelect, yearSelect);
    const min = monthStepBound(opts.min) || earliestMonth();
    const max = monthStepBound(opts.max);
    prev.disabled = !!(value && min && value <= min);
    next.disabled = !!(value && max && value >= max);
    prev.title = prev.disabled ? "Already at the earliest month" : "Previous month";
    next.title = next.disabled ? "Already at the latest month" : "Next month";
  }

  function step(delta, event) {
    event?.preventDefault();
    event?.stopPropagation();
    const value = readMonthYearValue(monthSelect, yearSelect);
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    let target = addMonthsToMonthValue(value, delta < 0 ? -1 : 1);
    const min = monthStepBound(opts.min) || earliestMonth();
    const max = monthStepBound(opts.max);
    if (min && target < min) target = min;
    if (max && target > max) target = max;
    if (target === value) {
      sync();
      return;
    }
    writeMonthYearValue(monthSelect, yearSelect, target);
    sync();
    monthSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  prev.addEventListener("click", (event) => step(-1, event));
  next.addEventListener("click", (event) => step(1, event));
  monthSelect.addEventListener("change", sync);
  yearSelect.addEventListener("change", sync);

  const api = { sync };
  monthSelect._monthStepper = api;
  sync();
  return api;
}

/**
 * Append a dated follow-up line to notes (max 2000 chars).
 * Returns null when noteText is empty.
 * @param {string|null|undefined} existingNotes
 * @param {string} noteText
 * @param {string} [dateLabel]
 * @returns {string|null}
 */
function appendDatedNote(existingNotes, noteText, dateLabel) {
  const note = String(noteText || "").trim();
  if (!note) return null;
  const stamp = String(dateLabel || "").trim();
  const line = stamp ? `[${stamp}] ${note}` : note;
  const prev = String(existingNotes || "").trim();
  let next = prev ? `${prev}\n${line}` : line;
  if (next.length > 2000) next = next.slice(next.length - 2000);
  return next;
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
 * Parse a YYYY-MM-DD date string as UTC (not local timezone).
 * Use this when reading dates from the database that were stored as date type.
 * @param {string|null|undefined} dateStr
 * @returns {Date|null}
 */
function parseDateAsUtc(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Format YYYY-MM-DD for display (e.g. "10 Feb 2025").
 * @param {string|null|undefined} dateStr
 * @returns {string}
 */
function formatDisplayDate(dateStr) {
  if (!dateStr) return "—";
  const date = parseDateAsUtc(dateStr);
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Format YYYY-MM-DD for tables/reports (e.g. "10/02/2025").
 * @param {string|null|undefined} dateStr
 * @returns {string}
 */
function formatNumericDate(dateStr) {
  if (!dateStr) return "—";
  const date = parseDateAsUtc(dateStr);
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
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
function formatQty(value) {
  return formatQuantity(value);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

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

function getYearRange(year) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
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
 * @param {string} selection - today | this-week | this-month | this-year | last-year | last-3-months | all-time | custom | date
 * @param {{ startInput?: HTMLInputElement, endInput?: HTMLInputElement, singleDate?: string }} [opts]
 * @returns {{ start: string, end: string, modeInfo?: object }|null}
 */
function resolveDateRange(selection, opts = {}) {
  const { startInput, endInput, singleDate } = opts;
  const today = new Date();
  const todayStr = toLocalDateString(today);
  const currentYear = today.getFullYear();

  if (selection === "today") {
    // Never reuse custom From/To leftovers — those inputs are only for "custom".
    return { start: todayStr, end: todayStr, modeInfo: { mode: "today" } };
  }
  if (selection === "date") {
    const d = singleDate || startInput?.value || todayStr;
    return { start: d, end: d, modeInfo: { mode: "date" } };
  }
  if (selection === "yesterday") {
    const d = getYesterdayDateString();
    return { start: d, end: d, modeInfo: { mode: "yesterday" } };
  }
  if (selection === "this-week") {
    return { ...getWeekRange(today), modeInfo: { mode: "this-week" } };
  }
  if (selection === "this-month") {
    return {
      ...getMonthRange(currentYear, today.getMonth()),
      modeInfo: { mode: "this-month" },
    };
  }
  if (selection === "last-month") {
    return {
      ...getMonthRange(currentYear, today.getMonth() - 1),
      modeInfo: { mode: "last-month" },
    };
  }
  if (selection === "this-year") {
    return { ...getYearRange(currentYear), modeInfo: { mode: "this-year" } };
  }
  if (selection === "last-year") {
    return { ...getYearRange(currentYear - 1), modeInfo: { mode: "last-year" } };
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
  // Keep inputs enabled so range reads always see current values.
  if (startInput) startInput.disabled = false;
  if (endInput) endInput.disabled = false;
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
  reminder: "record_reminder_due_date",
  e20Register: "record_e20_register_date",
  meterShift: "record_meter_shift_date",
};

/**
 * A stored entry date is kept only for the Indian day it was chosen.
 * The next morning every entry form opens on today, so a leftover date cannot be saved.
 * @param {{ start?: string, savedOn?: string }|null|undefined} storedState
 * @param {string} today - YYYY-MM-DD
 * @returns {string|null}
 */
function persistedDateIfCurrent(storedState, today) {
  if (!storedState || storedState.savedOn !== today) return null;
  const stored = storedState.start;
  if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
  return null;
}

/**
 * Read a persisted single-date value (dashboard snapshot, record forms, etc.).
 * Dates chosen on an earlier day are ignored.
 * @param {string} storageKey
 * @param {string} [fallback]
 * @returns {string}
 */
function getPersistedDate(storageKey, fallback) {
  const stored =
    typeof getValidFilterState === "function"
      ? getValidFilterState(storageKey, SINGLE_DATE_FILTER_RANGE)
      : null;
  const today = getLocalDateString();
  return persistedDateIfCurrent(stored, today) || fallback || today;
}

/**
 * Persist a single-date value using the shared filter-state format.
 * `savedOn` is today, so the value expires on the next Indian morning.
 * @param {string} storageKey
 * @param {string} dateStr - YYYY-MM-DD
 */
function savePersistedDate(storageKey, dateStr) {
  if (dateStr && typeof setFilterState === "function") {
    setFilterState(storageKey, {
      range: "date",
      start: dateStr,
      savedOn: getLocalDateString(),
    });
  }
}

/**
 * Restore and auto-save a single date input (record forms, snapshot pickers).
 * Priority: URL param → localStorage → current value → fallback (today unless overridden).
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
    const storedState =
      typeof getValidFilterState === "function"
        ? getValidFilterState(storageKey, SINGLE_DATE_FILTER_RANGE)
        : null;
    const today = getLocalDateString();
    const current = persistedDateIfCurrent(storedState, today);
    if (current) dateStr = current;
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
 * Request id for a money-writing form submit (p_request_id on RPCs, client_request_id on
 * expenses). The same id is reused while the submitted values are unchanged, so a retry after
 * a timeout or a lost response is recognised by the server instead of writing twice.
 * Call clearFormRequestId(form) after a successful save.
 * @param {HTMLFormElement|Element} form
 * @param {unknown} values - submitted values; a change starts a new request
 * @returns {string}
 */
function formRequestId(form, values) {
  const fingerprint = JSON.stringify(values ?? null);
  const pending = form?._pendingRequest;
  if (pending && pending.fingerprint === fingerprint) return pending.id;
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
          (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)
        );
  if (form) form._pendingRequest = { id, fingerprint };
  return id;
}

/** Forget the pending request id after a successful save (next submit is a new request). */
function clearFormRequestId(form) {
  if (form) delete form._pendingRequest;
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

/** Same-origin page to return to after login. Rejects anything that is not an app html file. */
function safeAppReturnPath(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > 300) return "";
  if (
    !/^[a-z0-9][a-z0-9.-]*\.html(?:\?[A-Za-z0-9._~%=&+-]*)?(?:#[A-Za-z0-9._~%=&+-]*)?$/i.test(
      value
    )
  ) {
    return "";
  }
  if (/^login\.html(?:[?#]|$)/i.test(value)) return "";
  if (value.includes("..") || value.includes("//") || value.includes("\\")) return "";
  return value;
}

/**
 * Confirm when a credit payment is larger than the outstanding balance.
 * @param {number} amount
 * @param {number} outstanding - amount still owed; zero or negative means the whole payment is an advance
 * @returns {Promise<boolean>}
 */
async function confirmCreditOverpayment(amount, outstanding) {
  const pay = Number(amount);
  const owed = Math.max(0, Number(outstanding) || 0);
  if (!Number.isFinite(pay) || pay <= 0) return true;
  const payCents = Math.round(pay * 100);
  const owedCents = Math.round(owed * 100);
  if (payCents <= owedCents) return true;
  const advance = (payCents - owedCents) / 100;
  if (typeof AppDialog === "undefined" || typeof AppDialog.confirm !== "function") return false;
  return AppDialog.confirm(`This creates an advance of ${formatCurrency(advance)}.`, {
    title: "Payment is more than the balance",
    confirmLabel: "Record payment",
  });
}

const UNSAVED_DRAFT_PREFIX = "bpf.draft.v1.";
const unsavedGuards = [];
let unsavedLeaveBound = false;
let bypassUnsavedLeave = false;

function stableDraftString(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableDraftString(item))));
  if (value && typeof value === "object") {
    const sorted = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        sorted[key] = JSON.parse(stableDraftString(value[key]));
      });
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value ?? null);
}

function unsavedWorkPending() {
  if (bypassUnsavedLeave) return false;
  return unsavedGuards.some((isDirty) => {
    try {
      return Boolean(isDirty());
    } catch (_) {
      return false;
    }
  });
}

/** Register a leave warning. Shift register uses this around its own meter draft. */
function trackUnsavedWork(isDirty) {
  if (typeof isDirty !== "function") return;
  unsavedGuards.push(isDirty);
  if (unsavedLeaveBound || typeof document === "undefined" || typeof window === "undefined") return;
  unsavedLeaveBound = true;

  window.addEventListener("beforeunload", (event) => {
    if (!unsavedWorkPending()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener(
    "click",
    (event) => {
      const link = event.target?.closest?.("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      let url;
      try {
        url = new URL(link.href, window.location.href);
      } catch (_) {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!unsavedWorkPending()) return;
      event.preventDefault();
      event.stopPropagation();
      const leave = () => {
        bypassUnsavedLeave = true;
        window.location.href = url.href;
      };
      const ask = window.AppDialog?.confirm;
      if (typeof ask !== "function") {
        leave();
        return;
      }
      ask("You have unsaved changes on this page. Leave without saving?", {
        title: "Unsaved changes",
        confirmLabel: "Leave",
        danger: true,
      }).then((ok) => {
        if (ok) leave();
      });
    },
    true
  );
}

function unsavedDraftStorageKey(key) {
  const name = typeof key === "function" ? key() : key;
  if (!name) return null;
  return `${UNSAVED_DRAFT_PREFIX}${name}`;
}

function resolveUnsavedRoot(root) {
  if (!root) return null;
  if (typeof root === "string") return document.getElementById(root) || document.querySelector(root);
  return root;
}

function captureDomDraftFields(root) {
  if (!root) return null;
  const fields = {};
  root.querySelectorAll("input, textarea, select").forEach((field) => {
    if (field.disabled || field.type === "hidden" || field.type === "button" || field.type === "submit") return;
    const id = field.name || field.id;
    if (!id) return;
    fields[id] = field.type === "checkbox" || field.type === "radio" ? (field.checked ? "1" : "0") : field.value;
  });
  return fields;
}

function applyDomDraftFields(root, fields) {
  if (!root || !fields) return false;
  let applied = false;
  root.querySelectorAll("input, textarea, select").forEach((field) => {
    if (field.disabled) return;
    const id = field.name || field.id;
    if (!id || !Object.prototype.hasOwnProperty.call(fields, id)) return;
    const next = String(fields[id] ?? "");
    if (field.type === "checkbox" || field.type === "radio") {
      const checked = next === "1";
      if (field.checked !== checked) {
        field.checked = checked;
        applied = true;
      }
      return;
    }
    if (String(field.value || "") !== next) {
      field.value = next;
      applied = true;
    }
  });
  return applied;
}

/**
 * Keep a local draft of typed fields and warn before leaving the page.
 * Storage matches the shift-register draft: `{ v, at, fields }` under a dated key.
 *
 * @param {{
 *   key: string | (() => string|null),
 *   root: Element | string,
 *   capture?: () => unknown,
 *   restore?: (fields: unknown) => boolean,
 *   skipTarget?: (target: EventTarget) => boolean,
 * }} opts
 */
function bindUnsavedDraft(opts) {
  let cleanSnapshot = "";
  let paused = false;

  function storageKey() {
    return unsavedDraftStorageKey(opts.key);
  }

  function readFields() {
    if (typeof opts.capture === "function") return opts.capture();
    return captureDomDraftFields(resolveUnsavedRoot(opts.root));
  }

  function snapshot() {
    const fields = readFields();
    return fields == null ? "" : stableDraftString(fields);
  }

  function persist() {
    if (paused) return;
    const key = storageKey();
    const fields = readFields();
    if (!key || fields == null) return;
    const next = stableDraftString(fields);
    try {
      if (next === cleanSnapshot) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ v: 1, at: Date.now(), fields }));
    } catch (_) {
      /* private mode or quota */
    }
  }

  function adoptServerState() {
    cleanSnapshot = snapshot();
  }

  function markClean() {
    const key = storageKey();
    cleanSnapshot = snapshot();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* private mode */
    }
  }

  function restore() {
    const key = storageKey();
    if (!key) return false;
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      return false;
    }
    if (parsed?.v !== 1 || parsed.fields == null) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      return false;
    }
    if (stableDraftString(parsed.fields) === cleanSnapshot) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
      return false;
    }
    paused = true;
    let applied = false;
    try {
      if (typeof opts.restore === "function") applied = opts.restore(parsed.fields) !== false;
      else applied = applyDomDraftFields(resolveUnsavedRoot(opts.root), parsed.fields);
    } finally {
      paused = false;
    }
    return applied;
  }

  function isDirty() {
    return snapshot() !== cleanSnapshot;
  }

  const zone = resolveUnsavedRoot(opts.root);
  const onEdit = (event) => {
    if (opts.skipTarget?.(event.target)) return;
    persist();
  };
  zone?.addEventListener("input", onEdit);
  zone?.addEventListener("change", onEdit);
  trackUnsavedWork(isDirty);

  return {
    persist,
    restore,
    adoptServerState,
    markClean,
    isDirty,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
  };
}

/**
 * Station calendar date as YYYY-MM-DD (Asia/Kolkata), matching meter_station_today().
 * @param {Date} [date]
 * @returns {string}
 */
function getStationDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Today's date as YYYY-MM-DD in Indian time.
 * @returns {string}
 */
function getLocalDateString() {
  return getStationDateString();
}

/** Yesterday's date as YYYY-MM-DD in Indian time. */
function getYesterdayDateString() {
  const [year, month, day] = getStationDateString().split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
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
 * Success copy that names the amount, the person, and the balance left.
 * A negative remaining is money now held for them (customer credit or salary advance).
 * @param {{ amount: number, person?: string, remaining: number|null, direction?: "from"|"for", surplus?: "credit"|"advance" }} details
 * @returns {string}
 */
function formatRecordedBalance(details) {
  const amount = formatCurrency(details && details.amount);
  const person = String((details && details.person) || "").trim() || "them";
  const direction = details && details.direction === "for" ? "for" : "from";
  const remaining = details ? Number(details.remaining) : NaN;
  let balance = "Remaining —.";
  if (Number.isFinite(remaining)) {
    if (remaining < -0.004) {
      const label = details.surplus === "advance" ? "Remaining advance" : "Remaining credit balance";
      balance = `${label} ${formatCurrency(-remaining)}.`;
    } else {
      balance = `Remaining ${formatCurrency(Math.max(0, remaining))}.`;
    }
  }
  return `Recorded ${amount} ${direction} ${person}. ${balance}`;
}

/**
 * Amount for a decimal text field (`inputmode="decimal"`).
 * A raw sum such as 1234.5600000001 fails the step check and blocks submit.
 * @param {number} value
 * @returns {string}
 */
function formatMoneyInput(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

/**
 * Calendar month label from `YYYY-MM` (for example "October 2026").
 * @param {string|null|undefined} monthValue
 * @returns {string}
 */
function formatMonthLabel(monthValue) {
  if (!monthValue) return "—";
  const [year, month] = String(monthValue).split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return String(monthValue);
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

/**
 * Show global top progress bar during API calls.
 * Call hideProgress() when done (e.g. in finally).
 */
let _progressDepth = 0;
let _progressWatchdog = null;
const PROGRESS_WATCHDOG_MS = 25000;

function showProgress() {
  let bar = document.getElementById("top-progress-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "top-progress-bar";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);
  }
  _progressDepth += 1;
  bar.classList.add("loading");

  clearTimeout(_progressWatchdog);
  _progressWatchdog = setTimeout(() => {
    if (_progressDepth > 0) {
      console.warn("[Progress] Watchdog cleared stuck loading indicator.");
      _progressDepth = 0;
      bar.classList.remove("loading");
    }
  }, PROGRESS_WATCHDOG_MS);
}

/**
 * Hide global top progress bar.
 */
function hideProgress() {
  _progressDepth = Math.max(0, _progressDepth - 1);
  if (_progressDepth > 0) return;
  clearTimeout(_progressWatchdog);
  _progressWatchdog = null;
  const bar = document.getElementById("top-progress-bar");
  if (bar) bar.classList.remove("loading");
}

/**
 * Brand loader: spinning Bishnupriya logo.
 * - Boot overlay (html.app-booting) until requireAuth resolves.
 * - Any leaf element whose whole text is a busy label ("Loading…", "Saving…", "…")
 *   gets .app-busy, which renders a small spinning logo before the text.
 */
const AppLoader = (function () {
  const BOOT_CLASS = "app-booting";
  const BUSY_CLASS = "app-busy";
  const ICON_ONLY_CLASS = "app-busy--icon";
  const BOOT_WATCHDOG_MS = 15000;
  const BUSY_TEXT_RE = /^(?:…|(?:[A-Z][a-z]+ing\b|Please wait)[^\n]{0,40}…)$/;
  let bootWatchdog = null;
  let observer = null;

  function startBoot() {
    document.documentElement.classList.add(BOOT_CLASS);
    clearTimeout(bootWatchdog);
    bootWatchdog = setTimeout(endBoot, BOOT_WATCHDOG_MS);
  }

  function endBoot() {
    clearTimeout(bootWatchdog);
    bootWatchdog = null;
    document.documentElement.classList.remove(BOOT_CLASS);
  }

  function syncBusy(el) {
    if (!el || el.nodeType !== 1) return;
    const text = el.childElementCount === 0 ? el.textContent.trim() : "";
    const busy = BUSY_TEXT_RE.test(text);
    if (busy !== el.classList.contains(BUSY_CLASS)) el.classList.toggle(BUSY_CLASS, busy);
    // Bare "…" placeholders show only the logo.
    const iconOnly = busy && text === "…";
    if (iconOnly !== el.classList.contains(ICON_ONLY_CLASS)) el.classList.toggle(ICON_ONLY_CLASS, iconOnly);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      syncBusy(root.parentElement);
      return;
    }
    if (root.nodeType !== 1) return;
    // Fast path: most inserted subtrees have no busy label at all.
    if (!root.textContent.includes("…")) {
      syncBusy(root);
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.includes("…")) syncBusy(node.parentElement);
    }
  }

  function observe() {
    if (observer || !document.body || typeof MutationObserver === "undefined") return;
    scan(document.body);
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          syncBusy(record.target.parentElement);
          continue;
        }
        // Text replaced via textContent: re-check the element itself (clears stale spinners).
        syncBusy(record.target);
        record.addedNodes.forEach(scan);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (typeof document !== "undefined") {
    if (document.body) observe();
    else document.addEventListener("DOMContentLoaded", observe, { once: true });
    if (document.documentElement.classList.contains(BOOT_CLASS)) {
      bootWatchdog = setTimeout(endBoot, BOOT_WATCHDOG_MS);
    }
    // Back/forward cache can restore a page frozen mid-redirect with the overlay still on.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) endBoot();
    });
  }

  return { startBoot, endBoot, scan };
})();

const ActionProgress = (function () {
  const WATCHDOG_MS = 60000;
  const HOLD_MS = 420;
  let active = false;
  let watchdog = null;
  let creepTimer = null;
  let creepStarted = 0;
  let displayed = 0;
  let lead = 0;
  let finishing = null;

  function ensure() {
    let root = document.getElementById("action-progress");
    if (root) return root;
    root = document.createElement("div");
    root.id = "action-progress";
    root.className = "action-progress";
    root.hidden = true;
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "action-progress-title");
    root.setAttribute("aria-describedby", "action-progress-status");
    root.innerHTML =
      '<div class="action-progress-card">' +
      '<span class="app-spinner app-spinner--lg action-progress-logo" aria-hidden="true"></span>' +
      '<p id="action-progress-title" class="action-progress-title"></p>' +
      '<p id="action-progress-status" class="action-progress-status"></p>' +
      '<div class="action-progress-track" aria-hidden="true"><div id="action-progress-fill" class="action-progress-fill"></div></div>' +
      '<p id="action-progress-pct" class="action-progress-pct">0%</p>' +
      "</div>";
    document.body.appendChild(root);
    return root;
  }

  function setFill(pct) {
    const fill = document.getElementById("action-progress-fill");
    const pctEl = document.getElementById("action-progress-pct");
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (fill) fill.style.width = `${clamped}%`;
    if (pctEl) pctEl.textContent = `${Math.round(clamped)}%`;
  }

  function setStatus(status) {
    if (!status) return;
    const el = document.getElementById("action-progress-status");
    if (el) el.textContent = status;
  }

  function stopCreep() {
    clearInterval(creepTimer);
    creepTimer = null;
  }

  function tickCreep() {
    if (!active || finishing) return;
    const elapsed = performance.now() - creepStarted;
    const eased = 92 * (1 - Math.exp(-elapsed / 3200));
    const next = Math.min(96, Math.max(displayed, eased, lead));
    displayed = next;
    setFill(displayed);
  }

  function start(options) {
    const opts = options || {};
    const root = ensure();
    active = true;
    finishing = null;
    displayed = 0;
    lead = 0;
    document.getElementById("action-progress-title").textContent = opts.title || "Working";
    setStatus(opts.status || "Please wait…");
    setFill(0);
    root.hidden = false;
    // Stay above an open modal (e.g. delete from the shift ledger popup).
    window.AppError?.raiseToTopLayer?.(root);
    document.body.classList.add("action-progress-open");
    stopCreep();
    creepStarted = performance.now();
    creepTimer = setInterval(tickCreep, 80);
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (active) {
        console.warn("[ActionProgress] Watchdog closed a stuck overlay.");
        close();
      }
    }, opts.timeoutMs || WATCHDOG_MS);
  }

  function setStep(_index, status) {
    if (!active) return;
    setStatus(status);
  }

  function setPercent(pct, status) {
    if (!active || finishing) return;
    setStatus(status);
    if (pct == null || pct === "") return;
    const clamped = Math.max(0, Math.min(96, Number(pct) || 0));
    if (clamped > lead) lead = clamped;
    if (lead > displayed) {
      displayed = lead;
      setFill(displayed);
    }
  }

  function succeed(status) {
    if (!active) return Promise.resolve();
    if (finishing) return finishing;
    stopCreep();
    setStatus(status);
    displayed = 100;
    lead = 100;
    setFill(100);
    finishing = new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    return finishing;
  }

  function close() {
    active = false;
    finishing = null;
    displayed = 0;
    lead = 0;
    stopCreep();
    clearTimeout(watchdog);
    watchdog = null;
    const root = document.getElementById("action-progress");
    if (root) {
      if (typeof root.hidePopover === "function" && root.matches(":popover-open")) root.hidePopover();
      root.hidden = true;
    }
    document.body.classList.remove("action-progress-open");
    setFill(0);
  }

  async function track(options, fn) {
    start(options);
    try {
      const result = await fn({ setStep, setPercent, succeed });
      await succeed((options && options.doneStatus) || "Done");
      return result;
    } finally {
      close();
    }
  }

  function run(options, fn) {
    return track(options, fn);
  }

  return { start, setStep, setPercent, succeed, close, run, track };
})();

/** Recover from stuck UI after background/freeze (PWA resume hook). */
function recoverStuckUi() {
  _progressDepth = 0;
  clearTimeout(_progressWatchdog);
  _progressWatchdog = null;
  hideProgress();
  ActionProgress.close();
  AppLoader.endBoot();
  document.querySelectorAll(".loading").forEach((el) => el.classList.remove("loading"));
  document.querySelectorAll("[aria-busy='true']").forEach((el) => el.removeAttribute("aria-busy"));
  document.querySelectorAll("button[disabled], input[disabled]").forEach((el) => {
    if (el.dataset.stuckDisabled === "1") {
      el.disabled = false;
      delete el.dataset.stuckDisabled;
    }
    if (el.dataset.paginationLoading === "true" || el.classList.contains("load-more-btn")) {
      el.disabled = false;
      if (el.dataset.loadMoreLabel) el.textContent = el.dataset.loadMoreLabel;
    }
  });
  document.getElementById("snapshot-card")?.classList.remove("loading");
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

/**
 * Per-module request guard — discard stale async results after rapid filter/resume changes.
 * @returns {{ next: () => number, isCurrent: (id: number) => boolean }}
 */
function createRequestGuard() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
  };
}

window.escapeHtml = escapeHtml;
window.debounce = debounce;
window.throttle = throttle;
window.toLocalDateString = toLocalDateString;
window.localDateToUtcStart = localDateToUtcStart;
window.localDateToUtcEnd = localDateToUtcEnd;
window.getUtcRangeForLocalDate = getUtcRangeForLocalDate;
window.parseDateAsUtc = parseDateAsUtc;
window.addDaysToDateString = addDaysToDateString;
window.addMonthsToMonthValue = addMonthsToMonthValue;
window.mountDateStepper = mountDateStepper;
window.mountMonthStepper = mountMonthStepper;
window.appendDatedNote = appendDatedNote;
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
window.getYearRange = getYearRange;
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
window.getStationDateString = getStationDateString;
window.getLocalDateString = getLocalDateString;
window.formatCurrency = formatCurrency;
window.formatMoneyInput = formatMoneyInput;
window.formatMonthLabel = formatMonthLabel;
window.getFilterState = getFilterState;
window.getValidFilterState = getValidFilterState;
window.setFilterState = setFilterState;
window.SINGLE_DATE_FILTER_RANGE = SINGLE_DATE_FILTER_RANGE;
window.RECORD_DATE_KEYS = RECORD_DATE_KEYS;
window.getPersistedDate = getPersistedDate;
window.persistedDateIfCurrent = persistedDateIfCurrent;
window.savePersistedDate = savePersistedDate;
window.initPersistedDateInput = initPersistedDateInput;
window.resetFormKeepingFields = resetFormKeepingFields;
window.finishRecordFormSave = finishRecordFormSave;
window.safeAppReturnPath = safeAppReturnPath;
window.confirmCreditOverpayment = confirmCreditOverpayment;
window.bindUnsavedDraft = bindUnsavedDraft;
window.trackUnsavedWork = trackUnsavedWork;
window.showProgress = showProgress;
window.hideProgress = hideProgress;
window.ActionProgress = ActionProgress;
window.AppLoader = AppLoader;
window.recoverStuckUi = recoverStuckUi;
window.createRequestGuard = createRequestGuard;
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

window.sumByProduct = sumByProduct;
window.resolveDayFuelStock = resolveDayFuelStock;
window.getDsrNetSaleLitres = getDsrNetSaleLitres;
window.getDsrSaleRate = getDsrSaleRate;
window.calculateDsrSaleRupees = calculateDsrSaleRupees;
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

/** MS/HSD or petrol/diesel → product key for styling. */
function normalizeFuelType(value) {
  const v = String(value ?? "").trim().toUpperCase();
  if (v === "MS" || v === "PETROL") return "petrol";
  if (v === "HSD" || v === "DIESEL") return "diesel";
  const product = normalizeProduct(value);
  if (product === "petrol" || product === "diesel") return product;
  return "";
}

function fuelProductModifier(value) {
  const mod = normalizeFuelType(value);
  return mod || null;
}

function fuelBadgeClass(value) {
  const mod = fuelProductModifier(value);
  return mod ? `fuel-badge fuel-badge--${mod}` : "fuel-badge";
}

function formatFuelBadge(value) {
  const text = value != null && String(value).trim() ? String(value).trim().toUpperCase() : "";
  if (!text) return "—";
  return `<span class="${fuelBadgeClass(value)}">${escapeHtml(text)}</span>`;
}

function fuelRowClass(value) {
  const mod = fuelProductModifier(value);
  return mod ? `fuel-row--${mod}` : "";
}

function syncFuelSelectStyle(selectEl) {
  if (!selectEl) return;
  selectEl.classList.remove("credit-fuel-select--petrol", "credit-fuel-select--diesel");
  const mod = fuelProductModifier(selectEl.value);
  if (mod) selectEl.classList.add(`credit-fuel-select--${mod}`);
}

window.normalizeFuelType = normalizeFuelType;
window.fuelProductModifier = fuelProductModifier;
window.fuelBadgeClass = fuelBadgeClass;
window.formatFuelBadge = formatFuelBadge;
window.fuelRowClass = fuelRowClass;
window.syncFuelSelectStyle = syncFuelSelectStyle;

/** Single-open accordion for documentation panels (Reports About, Analysis Setup). */
function initDocsAccordion(accordion) {
  if (!accordion) return;
  const topLevelItems = accordion.querySelectorAll(":scope > .reports-about-item");
  topLevelItems.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      topLevelItems.forEach((other) => {
        if (other !== item) other.open = false;
      });
    });
  });
}

window.initDocsAccordion = initDocsAccordion;

const _scriptLoadPromises = new Map();

/**
 * Load a script once (deduped). Resolves when the script has executed.
 * @param {string} src - URL relative to the page or absolute
 * @returns {Promise<void>}
 */
function loadScript(src, options = {}) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const url = src.includes("://") ? src : new URL(src, window.location.href).href;
  if (_scriptLoadPromises.has(url)) return _scriptLoadPromises.get(url);
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Timed out loading ${src}`));
    }, timeoutMs);

    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        finish(resolve);
        return;
      }
      if (existing.dataset.loadFailed === "1") {
        finish(reject, new Error(`Failed to load ${src}`));
        return;
      }
      existing.addEventListener("load", () => finish(resolve), { once: true });
      existing.addEventListener(
        "error",
        () => {
          existing.dataset.loadFailed = "1";
          finish(reject, new Error(`Failed to load ${src}`));
        },
        { once: true }
      );
      return;
    }
    const el = document.createElement("script");
    el.src = url;
    el.defer = true;
    el.addEventListener(
      "load",
      () => {
        el.dataset.loaded = "1";
        finish(resolve);
      },
      { once: true }
    );
    el.addEventListener(
      "error",
      () => {
        el.dataset.loadFailed = "1";
        finish(reject, new Error(`Failed to load ${src}`));
      },
      { once: true }
    );
    document.head.appendChild(el);
  });
  _scriptLoadPromises.set(url, promise);
  return promise;
}

/** PWA / mobile: recover from background freeze, hung fetches, and stale loading flags. */
let appLoadGeneration = 0;
const _appResumeHandlers = new Map();
let _appResumeDispatchTimer = null;
let _appHiddenAt = 0;
const APP_REQUEST_TIMEOUT_MS = 20000;
/** Invalidate live data after this much background time, or immediately on online/bfcache. */
const APP_RESUME_INVALIDATE_MS = 5000;
/** Only cancel in-flight work after a real background stretch (desktop Alt-Tab is often <2s). */
const APP_RESUME_CANCEL_AFTER_MS = 30000;
const APP_RESUME_DEBOUNCE_MS = 400;

function bumpAppLoadGeneration() {
  appLoadGeneration += 1;
  return appLoadGeneration;
}

function getAppLoadGeneration() {
  return appLoadGeneration;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      _appHiddenAt = Date.now();
    }
  });
}

function isCancelledRequestError(err) {
  return err?.code === "CANCELLED";
}

function isSettingsPanelActive(panelId) {
  const panel = document.querySelector(`[data-panel="${panelId}"]`);
  return Boolean(panel && !panel.hidden);
}

function withRequestTimeout(promise, ms, label) {
  const timeoutMs = ms ?? APP_REQUEST_TIMEOUT_MS;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label || "Request"} timed out. Check your connection and try again.`));
      }, timeoutMs);
    }),
  ]);
}

async function runAppRequest(label, fn, options = {}) {
  const loadId = options.loadId ?? appLoadGeneration;
  const runner =
    typeof AppError !== "undefined" && AppError.withRetry
      ? AppError.withRetry(fn, {
          maxAttempts: options.maxAttempts ?? 2,
          baseMs: options.baseMs ?? 400,
          maxMs: options.maxMs ?? 2500,
          isRetryable: options.isRetryable,
        })
      : fn();
  const result = await withRequestTimeout(runner, options.timeoutMs, label);
  if (loadId !== appLoadGeneration) {
    const err = new Error("Request cancelled.");
    err.code = "CANCELLED";
    throw err;
  }
  return result;
}

/**
 * Append a "Showing N of M" line and a Load more button. No-op when already mounted.
 * @returns {{ info: HTMLElement|null, button: HTMLElement|null }}
 */
function mountLoadMorePager(container, { infoId, buttonId, onMore }) {
  if (!container) return { info: null, button: null };
  if (!container.querySelector(".pagination-controls")) {
    const wrap = document.createElement("div");
    wrap.className = "pagination-controls";
    wrap.innerHTML = `
      <div class="pagination-info">
        <span id="${infoId}" class="muted"></span>
      </div>
      <button type="button" id="${buttonId}" class="button-secondary hidden">Load more</button>
    `;
    container.appendChild(wrap);
    if (onMore) wrap.querySelector("button")?.addEventListener("click", onMore);
  }
  return {
    info: document.getElementById(infoId),
    button: document.getElementById(buttonId),
  };
}

/**
 * @param {{ info?: HTMLElement|null, button?: HTMLElement|null, extraInfo?: HTMLElement|null, shown: number, total: number, hasMore: boolean, noun?: string }} state
 */
function syncLoadMorePager({ info, button, extraInfo, shown, total, hasMore, noun = "entries" }) {
  const text = total > 0 ? `Showing ${Math.min(shown, total)} of ${total} ${noun}` : "";
  if (info) info.textContent = text;
  if (extraInfo) extraInfo.textContent = text;
  if (button) {
    button.disabled = false;
    button.textContent = "Load more";
    button.classList.toggle("hidden", !(hasMore && shown > 0));
  }
}

/**
 * Append Back and Load more for a windowed page (meter history).
 * @returns {{ info: HTMLElement|null, back: HTMLElement|null, more: HTMLElement|null }}
 */
function mountWindowPager(container, { infoId, backId, moreId, onBack, onMore }) {
  if (!container) return { info: null, back: null, more: null };
  if (!container.querySelector(".pagination-controls")) {
    const wrap = document.createElement("div");
    wrap.className = "pagination-controls";
    wrap.innerHTML = `
      <div class="pagination-info">
        <span id="${infoId}" class="muted"></span>
      </div>
      <div class="pagination-buttons">
        <button type="button" id="${backId}" class="button-secondary hidden">Back</button>
        <button type="button" id="${moreId}" class="button-secondary hidden">Load more</button>
      </div>
    `;
    container.appendChild(wrap);
    if (onBack) document.getElementById(backId)?.addEventListener("click", onBack);
    if (onMore) document.getElementById(moreId)?.addEventListener("click", onMore);
  }
  return {
    info: document.getElementById(infoId),
    back: document.getElementById(backId),
    more: document.getElementById(moreId),
  };
}

/**
 * @param {{ info?: HTMLElement|null, back?: HTMLElement|null, more?: HTMLElement|null, page: number, pageSize: number, total: number, singlePageText?: string, moreLabel?: string }} state
 */
function syncWindowPager({ info, back, more, page, pageSize, total, singlePageText, moreLabel }) {
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  if (info) {
    if (!total) info.textContent = "";
    else if (totalPages <= 1 && singlePageText) info.textContent = singlePageText;
    else {
      const from = page * pageSize + 1;
      const to = Math.min((page + 1) * pageSize, total);
      info.textContent = `Showing ${from}–${to} of ${total}`;
    }
  }
  const multi = totalPages > 1;
  if (back) {
    back.disabled = page <= 0;
    back.classList.toggle("hidden", !multi);
  }
  if (more) {
    more.disabled = page >= totalPages - 1;
    if (moreLabel) more.textContent = moreLabel;
    more.classList.toggle("hidden", !multi);
  }
}

function resetPaginationLoading(pagination, loadMoreBtn, loadMoreLabel = "Load more") {
  if (pagination) pagination.isLoading = false;
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = loadMoreLabel;
  }
}

function renderTableRetryRow(tbody, colSpan, message, onRetry) {
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="${colSpan}" class="error">${escapeHtml(message)} <button type="button" class="button-secondary button-small" data-app-retry-row>Retry</button></td></tr>`;
  tbody.querySelector("[data-app-retry-row]")?.addEventListener("click", () => {
    void onRetry();
  });
}

function onAppResumeEvent(event) {
  clearTimeout(_appResumeDispatchTimer);
  _appResumeDispatchTimer = setTimeout(() => {
    const reason = event?.detail?.reason || "";
    const hiddenForMs =
      typeof event?.detail?.hiddenForMs === "number"
        ? event.detail.hiddenForMs
        : _appHiddenAt
          ? Date.now() - _appHiddenAt
          : 0;

    recoverStuckUi();

    const shouldInvalidate =
      reason === "bfcache" ||
      hiddenForMs >= APP_RESUME_INVALIDATE_MS;
    if (reason !== "online" && shouldInvalidate && typeof AppCache !== "undefined" && AppCache?.invalidateOperational) {
      AppCache.invalidateOperational();
    }

    if (
      reason !== "online" &&
      (hiddenForMs >= APP_RESUME_CANCEL_AFTER_MS || reason === "bfcache")
    ) {
      bumpAppLoadGeneration();
    }

    _appHiddenAt = 0;
    if (reason === "online") return;
    for (const { handler, match } of _appResumeHandlers.values()) {
      try {
        if (typeof match === "function" && !match()) continue;
        handler();
      } catch (err) {
        console.warn("[AppResume] handler failed:", err);
      }
    }
  }, APP_RESUME_DEBOUNCE_MS);
}

function bindAppResume(handler, options = {}) {
  if (typeof handler !== "function") return;
  const key = options.key || handler;
  _appResumeHandlers.set(key, {
    handler,
    match: options.match,
  });
  if (_appResumeHandlers.size === 1) {
    window.addEventListener("bpf:app-resume", onAppResumeEvent);
  }
}

const _cacheInvalidateHandlers = new Map();

function onCacheInvalidateEvent(event) {
  for (const { handler, match } of _cacheInvalidateHandlers.values()) {
    try {
      if (typeof match === "function" && !match()) continue;
      handler(event);
    } catch (err) {
      console.warn("[CacheInvalidate] handler failed:", err);
    }
  }
}

function bindCacheInvalidate(handler, options = {}) {
  if (typeof handler !== "function") return;
  const key = options.key || handler;
  _cacheInvalidateHandlers.set(key, {
    handler,
    match: options.match,
  });
  if (_cacheInvalidateHandlers.size === 1) {
    window.addEventListener("bpf:cache-invalidate", onCacheInvalidateEvent);
  }
}

/** Register a handler for app resume and cross-tab cache invalidation (same match rules). */
function bindLiveRefresh(handler, options = {}) {
  bindAppResume(handler, options);
  bindCacheInvalidate(handler, options);
}

window.loadScript = loadScript;
window.withRequestTimeout = withRequestTimeout;
window.runAppRequest = runAppRequest;
window.resetPaginationLoading = resetPaginationLoading;
window.renderTableRetryRow = renderTableRetryRow;
window.bindAppResume = bindAppResume;
window.bindCacheInvalidate = bindCacheInvalidate;
window.bindLiveRefresh = bindLiveRefresh;
window.bumpAppLoadGeneration = bumpAppLoadGeneration;
window.getAppLoadGeneration = getAppLoadGeneration;
window.isCancelledRequestError = isCancelledRequestError;
window.isSettingsPanelActive = isSettingsPanelActive;
window.APP_REQUEST_TIMEOUT_MS = APP_REQUEST_TIMEOUT_MS;

/**
 * Browser number inputs change value on wheel/trackpad while focused.
 * Prevent that for type=number, and also for decimal/numeric text fields inside
 * scrollable meter/DSR tables (belt-and-suspenders with type=text conversion).
 */
function isScrollSensitiveNumericInput(el) {
  if (!el || el.tagName !== "INPUT" || el.disabled) return false;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  if (type === "number") return true;
  if (type !== "text" && type !== "search" && type !== "") return false;
  const mode = (el.getAttribute("inputmode") || el.inputMode || "").toLowerCase();
  return mode === "decimal" || mode === "numeric";
}

function installNumericInputScrollGuard() {
  if (typeof document === "undefined") return;
  if (document.documentElement.dataset.bpfNumScrollGuard === "1") return;
  document.documentElement.dataset.bpfNumScrollGuard = "1";

  document.addEventListener(
    "wheel",
    (e) => {
      const active = document.activeElement;
      const target = e.target instanceof Element ? e.target.closest("input") : null;
      const el = isScrollSensitiveNumericInput(active)
        ? active
        : isScrollSensitiveNumericInput(target)
          ? target
          : null;
      if (!el) return;
      e.preventDefault();
      if (document.activeElement === el) el.blur();
    },
    { passive: false, capture: true }
  );
}

window.installNumericInputScrollGuard = installNumericInputScrollGuard;

const FIELD_CONTROL = "input, select, textarea";

function fieldErrorId(el) {
  if (el.id) return `${el.id}-error`;
  if (!el.dataset.fieldErrorId) {
    el.dataset.fieldErrorId = `field-error-${Math.random().toString(36).slice(2, 9)}`;
  }
  return el.dataset.fieldErrorId;
}

/** Mark a control invalid and show one message directly under it. */
function setFieldInvalid(el, message) {
  if (!el?.matches?.(FIELD_CONTROL)) return;
  const text = String(message || el.validationMessage || "Check this field.");
  el.classList.add("is-invalid");
  el.setAttribute("aria-invalid", "true");
  const id = fieldErrorId(el);
  let msg = document.getElementById(id);
  if (!msg) {
    msg = document.createElement("p");
    msg.id = id;
    msg.className = "field-error";
    el.insertAdjacentElement("afterend", msg);
  }
  msg.textContent = text;
  const described = new Set(
    (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)
  );
  described.add(id);
  el.setAttribute("aria-describedby", [...described].join(" "));
}

/** Clear the invalid mark once the control passes its checks. */
function clearFieldInvalid(el) {
  if (!el?.matches?.(FIELD_CONTROL)) return;
  if (el.validity && !el.validity.valid) return;
  el.classList.remove("is-invalid");
  el.removeAttribute("aria-invalid");
  const id = el.id ? `${el.id}-error` : el.dataset.fieldErrorId;
  if (!id) return;
  document.getElementById(id)?.remove();
  const described = (el.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter((token) => token && token !== id);
  if (described.length) el.setAttribute("aria-describedby", described.join(" "));
  else el.removeAttribute("aria-describedby");
}

function installFieldValidation() {
  if (document.documentElement.dataset.bpfFieldValidation === "1") return;
  document.documentElement.dataset.bpfFieldValidation = "1";
  let focusQueued = false;

  document.addEventListener(
    "invalid",
    (event) => {
      const el = event.target;
      if (!el?.matches?.(FIELD_CONTROL)) return;
      event.preventDefault();
      setFieldInvalid(el, el.validationMessage);
      if (focusQueued) return;
      focusQueued = true;
      queueMicrotask(() => {
        focusQueued = false;
        document.querySelector(`${FIELD_CONTROL}.is-invalid`)?.focus();
      });
    },
    true
  );

  const clearIfValid = (event) => clearFieldInvalid(event.target);
  document.addEventListener("input", clearIfValid, true);
  document.addEventListener("change", clearIfValid, true);
}

function tableHeaderLabels(table) {
  const row = table.querySelector("thead tr:last-child");
  if (!row) return null;
  const labels = [];
  let index = 0;
  for (const cell of row.children) {
    const span = Number(cell.getAttribute("colspan") || 1);
    const count = Number.isFinite(span) && span > 0 ? span : 1;
    const visible = (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim();
    const label = (cell.getAttribute("data-card-label") || cell.getAttribute("title") || visible).trim();
    for (let i = 0; i < count; i += 1) {
      labels[index] = label;
      index += 1;
    }
  }
  return labels;
}

function annotateWideTable(table) {
  if (!(table instanceof HTMLTableElement)) return;
  if (table.classList.contains("attendance-matrix")) return;
  if (!table.closest(".table-wrap, .table-scroll, .e20-grid")) return;
  const labels = tableHeaderLabels(table);
  if (!labels || labels.filter(Boolean).length < 2) {
    table.classList.remove("table-cards");
    return;
  }
  table.classList.add("table-cards");
  for (const body of table.tBodies) {
    for (const tr of body.rows) {
      let col = 0;
      for (const cell of tr.cells) {
        const span = Number(cell.getAttribute("colspan") || 1);
        const label = span === 1 ? labels[col] : "";
        if (label) cell.setAttribute("data-label", label);
        else cell.removeAttribute("data-label");
        col += Number.isFinite(span) && span > 0 ? span : 1;
      }
    }
  }
}

function annotateWideTables(root) {
  const scope = root instanceof Element ? root : document;
  if (scope instanceof HTMLTableElement) annotateWideTable(scope);
  scope.querySelectorAll?.(".table-wrap table, .table-scroll table, .e20-grid table").forEach(annotateWideTable);
}

function installResponsiveTables() {
  if (document.documentElement.dataset.bpfResponsiveTables === "1") return;
  document.documentElement.dataset.bpfResponsiveTables = "1";
  let timer = 0;
  const run = () => {
    timer = 0;
    annotateWideTables(document);
  };
  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(run, 40);
  };
  run();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
}

window.setFieldInvalid = setFieldInvalid;
window.clearFieldInvalid = clearFieldInvalid;
window.annotateWideTables = annotateWideTables;

let pdfPreviewLoader = null;

function loadPdfPreview() {
  if (window.PdfPreview?.render) return Promise.resolve(window.PdfPreview);
  if (!pdfPreviewLoader) {
    pdfPreviewLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "js/pdf/pdf-preview.min.js";
      script.onload = () => {
        if (window.PdfPreview?.render) resolve(window.PdfPreview);
        else reject(new Error("PDF viewer failed to start."));
      };
      script.onerror = () => {
        pdfPreviewLoader = null;
        reject(new Error("Could not load the PDF viewer."));
      };
      document.head.appendChild(script);
    });
  }
  return pdfPreviewLoader;
}

function preloadPdfPreview() {
  loadPdfPreview().catch(() => {
    /* mountPdfPreview reports the failure when a page is actually drawn. */
  });
}

async function mountPdfPreview(container, blob) {
  const viewer = await loadPdfPreview();
  await viewer.render(container, blob);
}

if (typeof document !== "undefined") {
  const startUiHelpers = () => {
    installNumericInputScrollGuard();
    installFieldValidation();
    installResponsiveTables();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startUiHelpers, { once: true });
  } else {
    startUiHelpers();
  }
}
