/* global window.supabaseClient, requireAuth, applyRoleVisibility, AppCache, AppError, escapeHtml, PumpSettings, loadPumpSettings, AppConfig, formatQuantity, formatCurrency, CacheInvalidation, AdminDelete, initPersistedDateInput, finishRecordFormSave, getLocalDateString, RECORD_DATE_KEYS, debounce, toLocalDateString, initPageSections, BuyingPriceEntry, getPlBuyingPriceHint, MeterShiftReading */

const PRODUCTS = ["petrol", "diesel"];
let currentUserId = null;

/** Pump/nozzle layout; loaded from Settings (pump_settings). */
let PUMP_CONFIG = {
  petrol: { pumps: 2, nozzlesPerPump: 2 },
  diesel: { pumps: 2, nozzlesPerPump: 2 },
};

function applyPumpConfigFromSettings() {
  const pumps = PumpSettings.getPumpConfig();
  /** Daily dsr_* columns are fixed 2×2 — clamp so forms never emit unknown fields. */
  const clamp = (raw) => ({
    pumps: Math.min(Math.max(Number(raw?.pumps) || 2, 1), 2),
    nozzlesPerPump: Math.min(Math.max(Number(raw?.nozzlesPerPump) || 2, 1), 2),
  });
  PUMP_CONFIG = {
    petrol: clamp(pumps.petrol),
    diesel: clamp(pumps.diesel),
  };
}

/** Rate column name per product (dsr table). */
const RATE_FIELD_BY_PRODUCT = { petrol: "petrol_rate", diesel: "diesel_rate" };

/** Maps product to its dedicated database table name (writes go here). */
const DSR_TABLE = { petrol: "dsr_petrol", diesel: "dsr_diesel" };

/** Shown when a supervisor picks a date that already has a completed meter entry (read-only view). */
const MSG_SUPERVISOR_METER_DAY_LOCKED =
  "Meter readings for this date are already saved. Choose another date to enter new readings, or contact an admin if a correction is needed.";

/** Hint when shift register meters are prefilled on the daily sheet. */
const MSG_SHIFT_PREFILL_HINT =
  "Nozzle meters are filled from the shift register and locked. Enter testing, dip reading, dip stock (L), receipts, and selling rate here, then save.";

function shiftPrefillHint(agg) {
  if (!agg?.has_shifts) return MSG_SHIFT_PREFILL_HINT;
  if (agg.has_morning && agg.has_afternoon) {
    return "Full day from shift register (morning + afternoon). Meters are locked — enter testing, dip, stock, receipts, and rate here, then save.";
  }
  if (agg.has_morning) {
    return "Morning shift only — meters locked. Prefer finishing the afternoon shift before saving this sheet; afternoon save will refresh meters if the sheet already exists. Enter testing, dip, stock, and rate here.";
  }
  if (agg.has_afternoon) {
    return "Afternoon shift only — meters locked from the shift register. Enter testing, dip, stock, receipts, and rate here, then save.";
  }
  return MSG_SHIFT_PREFILL_HINT;
}

/** Field names owned by the shift register (readonly for supervisors on prefill). */
const SHIFT_PREFILL_METER_FIELD_RE =
  /^(opening_pump\d+_nozzle\d+|closing_pump\d+_nozzle\d+|sales_pump\d+|total_sales)$/;

/**
 * True when the daily sheet was finished: selling rate + dip or stock.
 * Rate alone (or receipts alone) must not lock the day — matches dsr_meter_row_is_complete.
 */
function isDailyMeterEntryComplete(row, product) {
  if (!row) return false;
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (rateField == null) return false;
  const rate = Number(row[rateField]);
  if (!(Number.isFinite(rate) && rate > 0)) return false;
  const dipOk =
    row.dip_reading != null &&
    Number.isFinite(Number(row.dip_reading)) &&
    Number(row.dip_reading) !== 0;
  const stockOk =
    row.stock != null && Number.isFinite(Number(row.stock)) && Number(row.stock) > 0;
  return dipOk || stockOk;
}

/** True when the form was filled from shift rollup (not a finished DSR row). */
function isShiftPrefillRow(row) {
  return Boolean(row && row._fromShiftAggregate);
}

/**
 * Blank zero testing/dip/stock/receipts so supervisors enter real values on the meter sheet.
 */
function blankUnsetStockFields(form) {
  for (const name of ["testing", "dip_reading", "stock", "receipts"]) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) continue;
    const v = Number(input.value);
    if (!Number.isFinite(v) || v === 0) input.value = "";
  }
}

/** Cache of in-flight/completed shift rollup promises per date. */
const shiftAggregateCache = new Map();

async function fetchShiftAggregatedDailyMeters(dateStr) {
  if (!dateStr) return null;
  if (shiftAggregateCache.has(dateStr)) return shiftAggregateCache.get(dateStr);

  const pending = (async () => {
    const { data, error } = await window.supabaseClient.rpc("get_shift_aggregated_daily_meters", {
      p_date: dateStr,
    });
    if (error) {
      AppError.report(error, { context: "fetchShiftAggregatedDailyMeters", dateStr });
      shiftAggregateCache.delete(dateStr);
      return null;
    }
    return data || null;
  })();

  shiftAggregateCache.set(dateStr, pending);
  return pending;
}

function invalidateShiftAggregateCache(dateStr) {
  if (dateStr) shiftAggregateCache.delete(dateStr);
  else shiftAggregateCache.clear();
}

/**
 * Apply testing/dip/stock/receipts/rate/remarks from an incomplete DSR row onto a
 * shift-prefilled form so partial meter-sheet progress is not wiped.
 */
function applyEditableStockFieldsFromRow(form, row, product) {
  if (!form || !row) return;
  for (const name of ["testing", "dip_reading", "stock", "receipts", "remarks"]) {
    const input =
      name === "remarks"
        ? form.querySelector(`[name="${name}"]`)
        : getFormFieldInput(form, name) || form.querySelector(`[name="${name}"]`);
    if (!input) continue;
    if (name === "remarks") {
      if (row.remarks != null && String(row.remarks).trim() !== "") {
        input.value = row.remarks;
      }
      continue;
    }
    if (row[name] == null) continue;
    const v = Number(row[name]);
    if (Number.isFinite(v) && v !== 0) input.value = v.toFixed(2);
  }
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (rateField && row[rateField] != null) {
    const rate = Number(row[rateField]);
    if (Number.isFinite(rate) && rate > 0) applyRateToForm(form, product, rate);
  }
}

/**
 * Build a virtual incomplete DSR-shaped row from shift rollup (not persisted).
 * @returns {object | null}
 */
function shiftAggregateToVirtualRow(product, dateStr, aggregate) {
  const block = aggregate?.[product];
  if (!block || !block.has_shifts) return null;
  return {
    date: dateStr,
    _fromShiftAggregate: true,
    _shiftHint: shiftPrefillHint(block),
    has_morning: !!block.has_morning,
    has_afternoon: !!block.has_afternoon,
    opening_pump1_nozzle1: block.opening_pump1_nozzle1,
    opening_pump1_nozzle2: block.opening_pump1_nozzle2,
    opening_pump2_nozzle1: block.opening_pump2_nozzle1,
    opening_pump2_nozzle2: block.opening_pump2_nozzle2,
    closing_pump1_nozzle1: block.closing_pump1_nozzle1,
    closing_pump1_nozzle2: block.closing_pump1_nozzle2,
    closing_pump2_nozzle1: block.closing_pump2_nozzle1,
    closing_pump2_nozzle2: block.closing_pump2_nozzle2,
    sales_pump1: block.sales_pump1,
    sales_pump2: block.sales_pump2,
    total_sales: block.total_sales,
    // Testing is entered on the daily MS/HSD sheet, not from the shift register.
    testing: null,
    dip_reading: null,
    stock: null,
    receipts: null,
    petrol_rate: null,
    diesel_rate: null,
  };
}

/** Resolved after auth; drives supervisor vs admin meter form behaviour. */
let currentUserRole = "supervisor";

/**
 * Returns closing meter field names for a product config (e.g. closing_pump1_nozzle1, …).
 * @param {{ pumps: number, nozzlesPerPump: number }} config
 * @returns {string[]}
 */
function getClosingMeterFields(config) {
  const fields = [];
  for (let p = 1; p <= config.pumps; p++) {
    for (let n = 1; n <= config.nozzlesPerPump; n++) {
      fields.push(`closing_pump${p}_nozzle${n}`);
    }
  }
  return fields;
}

/**
 * Returns the date string (YYYY-MM-DD) for the day before the given date string.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
function getPreviousDateStr(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return toLocalDateString(d);
}

/** Build list of DSR reading number field names from current pump config. */
function getReadingNumberFields(product = "petrol") {
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const { pumps, nozzlesPerPump } = config;
  const fields = [];
  for (let p = 1; p <= pumps; p++) {
    for (let n = 1; n <= nozzlesPerPump; n++) {
      fields.push(`opening_pump${p}_nozzle${n}`);
    }
  }
  for (let p = 1; p <= pumps; p++) {
    for (let n = 1; n <= nozzlesPerPump; n++) {
      fields.push(`closing_pump${p}_nozzle${n}`);
    }
  }
  for (let p = 1; p <= pumps; p++) {
    fields.push(`sales_pump${p}`);
  }
  fields.push("total_sales", "testing", "dip_reading", "stock");
  return fields;
}

// Pagination configuration and state (page-based: 0 = first page)
/** Page size for "Recent meter entries" so "Load more" and Back show when there are more entries */
const METER_RECENT_PAGE_SIZE = 5;
const dsrPagination = {
  petrol: { currentPage: 0, totalCount: 0, isLoading: false },
  diesel: { currentPage: 0, totalCount: 0, isLoading: false },
};

/** Increments on each date refresh so stale async results do not overwrite the form. */
const meterRefreshGeneration = { petrol: 0, diesel: 0 };

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "dsr",
  });
  if (!auth) return;

  await loadPumpSettings();
  applyPumpConfigFromSettings();
  window.DsrFuelNav?.applyFuelNavMeta?.();

  currentUserId = auth.session?.user?.id ?? null;
  currentUserRole = auth.role ?? "supervisor";
  applyRoleVisibility(auth.role);

  const meterSections =
    currentUserRole === "admin"
      ? ["shift-readings", "petrol", "diesel", "purchase-cost"]
      : ["shift-readings", "petrol", "diesel"];

  initPageSections({
    navItemSelector: "#meter-sidebar-nav .settings-nav-item",
    panelSelector: ".settings-panels .settings-panel",
    defaultSection: "shift-readings",
    validSections: meterSections,
    hashAliases: {
      meter: "petrol",
      register: "shift-readings",
      handover: "shift-readings",
      pl: "purchase-cost",
      shift: "shift-readings",
      sales: "shift-readings",
      breakdown: "shift-readings",
    },
    onSectionChange: (section) => {
      if (section === "purchase-cost" && currentUserRole === "admin") {
        void ensurePurchaseCostLoaded();
      }
      if (section === "shift-readings" && typeof MeterShiftReading !== "undefined") {
        void MeterShiftReading.init({
          isAdmin: currentUserRole === "admin",
          userId: currentUserId,
        });
      }
    },
  });

  const landingHash = (location.hash || "").replace(/^#/, "").split("?")[0];
  const landsOnShift =
    !landingHash ||
    landingHash === "shift-readings" ||
    landingHash === "shift" ||
    landingHash === "register" ||
    landingHash === "handover" ||
    landingHash === "sales" ||
    landingHash === "breakdown";
  if (typeof MeterShiftReading !== "undefined" && landsOnShift) {
    void MeterShiftReading.init({ isAdmin: currentUserRole === "admin", userId: currentUserId });
  }

  PRODUCTS.forEach((product) => {
    initReadingForm(product);
    initMeterPaginationControls(product);
  });
  initMeterDeleteHandlers();
  await Promise.all(PRODUCTS.map((product) => loadReadingHistory(product, true)));

  const landingPurchaseCost =
    currentUserRole === "admin" &&
    (landingHash === "purchase-cost" || landingHash === "pl");
  if (landingPurchaseCost) {
    // Ensure list is rendered before focusing (onSectionChange refresh may still be in flight).
    await ensurePurchaseCostLoaded();
    setTimeout(() => BuyingPriceEntry?.focusFirstInput?.(), 200);
  }
});

function getPurchaseCostEntryOpts() {
  return {
    listEl: document.getElementById("purchase-cost-missing-list"),
    alertEl: document.getElementById("purchase-cost-alert"),
    emptyEl: document.getElementById("purchase-cost-empty"),
    errorEl: document.getElementById("purchase-cost-error"),
    onSaved: async () => {
      purchaseCostLoaded = false;
      await ensurePurchaseCostLoaded({ force: true });
    },
  };
}

let purchaseCostLoadPromise = null;
let purchaseCostLoaded = false;

/**
 * Load Purchase cost list once. Pass force to rebuild after save / clean live refresh.
 * Skips when already loaded or when the user has unsaved edits (unless force).
 */
async function ensurePurchaseCostLoaded(options = {}) {
  if (typeof BuyingPriceEntry?.refresh !== "function") return;
  const force = Boolean(options.force);
  if (!force && purchaseCostLoaded) return;
  if (purchaseCostLoadPromise) return purchaseCostLoadPromise;

  const listEl = document.getElementById("purchase-cost-missing-list");
  if (!force && typeof BuyingPriceEntry.hasUnsavedEdits === "function" && BuyingPriceEntry.hasUnsavedEdits(listEl)) {
    return;
  }

  const hintEl = document.getElementById("purchase-cost-hint");
  if (hintEl && typeof getPlBuyingPriceHint === "function") {
    hintEl.textContent = getPlBuyingPriceHint();
  }
  purchaseCostLoadPromise = BuyingPriceEntry.refresh({ ...getPurchaseCostEntryOpts(), force })
    .then((rows) => {
      // null => skipped to preserve edits; keep loaded flag as-is
      if (rows !== null) purchaseCostLoaded = true;
      return rows;
    })
    .finally(() => {
      purchaseCostLoadPromise = null;
    });
  return purchaseCostLoadPromise;
}

/** Column count for recent-entries table (includes Actions for admin). */
function getHistoryColCount(product) {
  const pumps = (PUMP_CONFIG[product] || PUMP_CONFIG.petrol).pumps;
  const base = 7 + pumps;
  return currentUserRole === "admin" ? base + 1 : base;
}

function initMeterDeleteHandlers() {
  AdminDelete.bindOnce(document.body, ".dsr-delete-entry", async (btn) => {
    const id = btn.dataset.id;
    const product = btn.dataset.product;
    const dateStr = btn.dataset.date;
    if (!id || !product) return;

    const fuelLabel = product === "petrol" ? "MS (Petrol)" : "HSD (Diesel)";

    await AdminDelete.execute({
      btn,
      auth: currentUserRole === "admin" ? { role: "admin" } : null,
      actionLabel: "delete meter entries",
      confirmMessage: `Delete the ${fuelLabel} meter entry for ${dateStr || "this date"}? This cannot be undone.`,
      deleteFn: () => {
        const table = DSR_TABLE[product] || "dsr_petrol";
        return window.supabaseClient.from(table).delete().eq("id", id);
      },
      cacheScope: "dsr",
      onSuccess: async () => {
        const form = document.getElementById(`dsr-form-${product}`);
        const dateInput = form?.querySelector('input[name="date"]');
        if (form && dateInput?.value === dateStr) {
          await refreshMeterFormForSelectedDate(product, form);
        }
        await loadReadingHistory(product, true);
        
      },
      errorContext: { context: "deleteMeterEntry", product, id },
    });
  }, "dsrDeleteBound");
}

/** Columns needed to hydrate a meter form (avoids select("*")). */
function getMeterRowSelectColumns(product) {
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const opening = [];
  for (let p = 1; p <= config.pumps; p++) {
    for (let n = 1; n <= config.nozzlesPerPump; n++) {
      opening.push(`opening_pump${p}_nozzle${n}`);
    }
  }
  const closing = getClosingMeterFields(config);
  const pumpCols = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`);
  return [
    "id",
    "date",
    ...opening,
    ...closing,
    ...pumpCols,
    "total_sales",
    "testing",
    "dip_reading",
    "stock",
    "receipts",
    "petrol_rate",
    "diesel_rate",
    "remarks",
  ].join(", ");
}

/**
 * Full DSR row for a calendar date (latest by created_at if duplicates).
 * @returns {Promise<object | null>}
 */
async function fetchDsrFullRowForDate(product, dateStr) {
  if (!dateStr || !product) return null;
  const table = DSR_TABLE[product] || "dsr_petrol";
  const { data, error } = await window.supabaseClient
    .from(table)
    .select(getMeterRowSelectColumns(product))
    .eq("date", dateStr)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0];
}

/**
 * @param {HTMLFormElement} form
 * @param {object} row - dsr row
 * @param {string} product
 * @param {number | null | undefined} openingStockHint - previous day's stock value
 */
function applyDsrRowFieldsToMeterForm(form, row, product, openingStockHint) {
  const skip = new Set(["id", "created_at", "created_by", "product", "date"]);
  for (const [key, val] of Object.entries(row)) {
    if (skip.has(key)) continue;
    const input = form.querySelector(`[name="${key}"]`);
    if (!input) continue;
    if (key === "remarks") {
      input.value = val ?? "";
      continue;
    }
    if (input.type === "number" || input.classList.contains("meter-reading")) {
      input.value = val != null && val !== "" ? Number(val).toFixed(2) : "";
    }
  }
  const openingInput = getFormFieldInput(form, "opening_stock");
  if (openingInput) {
    const hint = Number(openingStockHint);
    openingInput.value =
      openingStockHint != null && Number.isFinite(hint) && hint > 0 ? hint.toFixed(2) : "";
  }
}

/**
 * Hydrate meter form from a saved DSR row (opening stock from previous day).
 * Incomplete rows blank zero stock fields; rate fill is handled by ensureMeterRatePrefill.
 */
async function applyExistingDsrRowToMeterForm(product, form, row) {
  if (!row) return;

  const openingHint = await getPreviousDayDipStock(product, row.date);
  applyDsrRowFieldsToMeterForm(form, row, product, openingHint);

  if (!isDailyMeterEntryComplete(row, product)) {
    blankUnsetStockFields(form);
  }

  updateDerivedFields(form);
}

/**
 * Refresh MS/HSD forms when their selected date matches (e.g. after shift save).
 * Optionally force the form date to match so meters are visible immediately.
 */
async function refreshMeterFormsForShiftDate(dateStr, products, { alignDate = true } = {}) {
  if (!dateStr) return;
  invalidateShiftAggregateCache(dateStr);
  const list = Array.isArray(products) && products.length ? products : ["petrol", "diesel"];

  await Promise.all(
    list.map(async (product) => {
      const form = document.getElementById(`dsr-form-${product}`);
      if (!form) return;
      const dateInput = form.querySelector("input[name='date']");
      if (!dateInput) return;
      if (alignDate && dateInput.value !== dateStr) {
        dateInput.value = dateStr;
        try {
          localStorage.setItem(meterDateStorageKey(product), dateStr);
        } catch (_) {
          /* ignore */
        }
      }
      if (dateInput.value === dateStr) {
        await refreshMeterFormForSelectedDate(product, form);
      }
    })
  );

  await Promise.all(
    list.map((product) =>
      loadReadingHistory(product, true).catch(() => {
        /* ignore history refresh errors */
      })
    )
  );
}

/**
 * Apply shift rollup meters onto the form as a virtual prefill (no DSR row yet).
 * Stock/dip stay blank — entered only when saving the meter sheet.
 */
async function applyShiftAggregateToMeterForm(product, form, dateStr, agg) {
  if (!agg?.has_shifts) return null;

  const virtualRow = shiftAggregateToVirtualRow(product, dateStr, { [product]: agg });
  if (!virtualRow) return null;

  const openingHint = await getPreviousDayDipStock(product, dateStr);
  applyDsrRowFieldsToMeterForm(form, virtualRow, product, openingHint);
  blankUnsetStockFields(form);
  // Do not enrich openings from prior day — only show nozzles entered in the shift.
  updateDerivedFields(form);
  return virtualRow;
}

/** Clear full-day and shift-meter lock marks on inputs/buttons. */
function clearMeterFormLockMarks(form) {
  form.classList.remove("dsr-meter-supervisor-locked", "dsr-meter-shift-meters-locked");
  form.querySelectorAll("[data-dsr-supervisor-lock]").forEach((el) => {
    if (el.tagName === "BUTTON") {
      el.disabled = false;
    } else {
      el.readOnly = el.dataset.dsrOrigReadonly === "1";
    }
    el.removeAttribute("data-dsr-supervisor-lock");
    el.removeAttribute("data-dsr-orig-readonly");
  });
}

function setMeterFormSupervisorLocked(form, locked, { hint = null } = {}) {
  const suffix = form.id?.replace("dsr-form-", "") || "";
  const banner = document.getElementById(`dsr-meter-locked-banner-${suffix}`);

  clearMeterFormLockMarks(form);

  if (!locked) {
    if (banner) {
      if (hint) {
        banner.textContent = hint;
        banner.classList.remove("hidden");
        banner.classList.add("dsr-meter-prefill-hint");
      } else {
        banner.classList.add("hidden");
        banner.classList.remove("dsr-meter-prefill-hint");
        banner.textContent = "";
      }
    }
    return;
  }

  form.classList.add("dsr-meter-supervisor-locked");
  if (banner) {
    banner.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
    banner.classList.remove("hidden");
    banner.classList.remove("dsr-meter-prefill-hint");
  }

  form.querySelectorAll("input, textarea, button").forEach((el) => {
    if (el.name === "date" || el.type === "hidden") return;
    // Refresh must stay available so supervisors can clear stale closings after a date change.
    if (el.classList?.contains("dsr-refresh-form")) return;
    if (el.hasAttribute("data-dsr-supervisor-lock")) return;

    if (el.tagName === "BUTTON") {
      el.setAttribute("data-dsr-supervisor-lock", "");
      el.disabled = true;
      return;
    }
    el.setAttribute("data-dsr-supervisor-lock", "");
    el.setAttribute("data-dsr-orig-readonly", el.readOnly ? "1" : "0");
    el.readOnly = true;
  });
}

/**
 * Lock nozzle open/close (+ derived sales) for supervisors after shift sync.
 * Testing, dip stock, receipts, selling rate, and remarks stay editable until the day is finished.
 */
function setMeterFormShiftMetersLocked(form, locked, { hint = null } = {}) {
  const suffix = form.id?.replace("dsr-form-", "") || "";
  const banner = document.getElementById(`dsr-meter-locked-banner-${suffix}`);

  clearMeterFormLockMarks(form);

  if (banner) {
    if (locked && hint) {
      banner.textContent = hint;
      banner.classList.remove("hidden");
      banner.classList.add("dsr-meter-prefill-hint");
    } else if (!locked && hint) {
      banner.textContent = hint;
      banner.classList.remove("hidden");
      banner.classList.add("dsr-meter-prefill-hint");
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("dsr-meter-prefill-hint");
      banner.textContent = "";
    }
  }

  if (!locked) return;

  form.classList.add("dsr-meter-shift-meters-locked");

  form.querySelectorAll("input, textarea").forEach((el) => {
    if (!el.name || !SHIFT_PREFILL_METER_FIELD_RE.test(el.name)) return;
    if (el.hasAttribute("data-dsr-supervisor-lock")) return;
    el.setAttribute("data-dsr-supervisor-lock", "");
    el.setAttribute("data-dsr-orig-readonly", el.readOnly ? "1" : "0");
    el.readOnly = true;
  });

  // Opening stock is from prior dip — lock when prefilled; leave editable if empty.
  const openingStock = getFormFieldInput(form, "opening_stock");
  if (
    openingStock &&
    !openingStock.hasAttribute("data-dsr-supervisor-lock") &&
    openingStock.value !== "" &&
    Number(openingStock.value) > 0
  ) {
    openingStock.setAttribute("data-dsr-supervisor-lock", "");
    openingStock.setAttribute("data-dsr-orig-readonly", openingStock.readOnly ? "1" : "0");
    openingStock.readOnly = true;
  }

  const copyPrev = form.querySelector(".dsr-copy-prev");
  if (copyPrev) {
    copyPrev.setAttribute("data-dsr-supervisor-lock", "");
    copyPrev.disabled = true;
  }
}

function applyMeterDayLockState(product, form, row) {
  if (currentUserRole !== "supervisor") {
    setMeterFormSupervisorLocked(form, false);
    return;
  }

  const complete = isDailyMeterEntryComplete(row, product);
  if (complete) {
    setMeterFormSupervisorLocked(form, true);
    return;
  }

  // Shift rollup prefill: lock meters; leave testing/dip/stock/rate editable.
  if (isShiftPrefillRow(row)) {
    const hint = row._shiftHint || MSG_SHIFT_PREFILL_HINT;
    setMeterFormShiftMetersLocked(form, true, { hint });
    return;
  }

  setMeterFormSupervisorLocked(form, false);
}

/**
 * Clear entry fields so a prior date’s closings/testing/dip do not linger
 * when the selected date has no saved row (or the user hits Refresh).
 * Date is preserved; openings/rate/stock are filled by prefill next.
 */
function clearMeterFormEntryFields(form, product) {
  if (!form) return;
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const names = [
    ...Array.from({ length: config.pumps }, (_, i) => {
      const p = i + 1;
      const openings = [];
      for (let n = 1; n <= config.nozzlesPerPump; n++) {
        openings.push(`opening_pump${p}_nozzle${n}`);
      }
      return openings;
    }).flat(),
    ...getClosingMeterFields(config),
    ...Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`),
    "total_sales",
    "total_stock",
    "net_sale",
    "variation",
    "testing",
    "dip_reading",
    "stock",
    "receipts",
    "remarks",
    "opening_stock",
    RATE_FIELD_BY_PRODUCT[product],
  ].filter(Boolean);

  for (const name of names) {
    const input = getFormFieldInput(form, name) || form.querySelector(`[name="${name}"]`);
    if (input) input.value = "";
  }
}

/**
 * Prefill for new dates, load saved finished DSR, or shift rollup (clean model).
 * Finished sheet → show DSR. Otherwise → meters from shifts; keep any partial stock fields.
 */
async function refreshMeterFormForSelectedDate(product, form) {
  const dateInput = form.querySelector("input[name='date']");
  if (!dateInput?.value) return;

  const gen = (meterRefreshGeneration[product] = (meterRefreshGeneration[product] || 0) + 1);
  const dateStr = dateInput.value;

  setMeterFormSupervisorLocked(form, false);
  clearMeterFormEntryFields(form, product);
  updateDerivedFields(form);

  const existingRow = await fetchDsrFullRowForDate(product, dateStr);
  if (gen !== meterRefreshGeneration[product]) return;

  let lockRow = null;
  const finished = existingRow && isDailyMeterEntryComplete(existingRow, product);

  if (finished) {
    await applyExistingDsrRowToMeterForm(product, form, existingRow);
    lockRow = existingRow;
  } else {
    const shiftAgg = await fetchShiftAggregatedDailyMeters(dateStr);
    if (gen !== meterRefreshGeneration[product]) return;
    const productAgg = shiftAgg?.[product];
    if (productAgg?.has_shifts) {
      lockRow = await applyShiftAggregateToMeterForm(product, form, dateStr, productAgg);
      // Preserve partial meter-sheet progress on an incomplete DSR row
      if (existingRow) {
        applyEditableStockFieldsFromRow(form, existingRow, product);
        updateDerivedFields(form);
      }
    } else if (existingRow) {
      await applyExistingDsrRowToMeterForm(product, form, existingRow);
      lockRow = existingRow;
    } else {
      await prefillOpeningFromPreviousDay(product, form);
    }
  }

  if (gen !== meterRefreshGeneration[product]) return;

  await ensureMeterRatePrefill(product, form);
  if (gen !== meterRefreshGeneration[product]) return;

  applyMeterDayLockState(product, form, lockRow);
}

function initReadingForm(product) {
  const form = document.getElementById(`dsr-form-${product}`);
  if (!form) return;

  initMeterFormDate(form, product);

  const dateInput = form.querySelector("input[name='date']");
  if (dateInput) {
    const onDateChange = () => {
      void refreshMeterFormForSelectedDate(product, form);
    };
    dateInput.addEventListener("change", onDateChange);
    dateInput.addEventListener("input", onDateChange);
    void onDateChange();
  } else {
    updateDerivedFields(form);
  }

  const debouncedUpdateDerived = debounce(() => {
    if (form.classList.contains("dsr-meter-supervisor-locked")) return;
    updateDerivedFields(form);
  }, 120);
  form.addEventListener("input", debouncedUpdateDerived);

  const copyPrevBtn = form.querySelector(".dsr-copy-prev[data-product]");
  if (copyPrevBtn && copyPrevBtn.dataset.product === product) {
    copyPrevBtn.addEventListener("click", async () => {
      if (form.classList.contains("dsr-meter-supervisor-locked")) return;
      if (form.classList.contains("dsr-meter-shift-meters-locked")) return;
      copyPrevBtn.disabled = true;
      copyPrevBtn.textContent = "Loading…";
      const d = form.querySelector("input[name='date']")?.value;
      try {
        const shiftAgg = d ? await fetchShiftAggregatedDailyMeters(d) : null;
        if (shiftAgg?.[product]?.has_shifts) {
          // Shifts own meters — refresh from rollup instead of prior-day inventing
          await refreshMeterFormForSelectedDate(product, form);
        } else {
          await prefillOpeningFromPreviousDay(product, form);
          updateDerivedFields(form);
          const row = d ? await fetchDsrFullRowForDate(product, d) : null;
          applyMeterDayLockState(product, form, row);
        }
      } finally {
        copyPrevBtn.disabled = false;
        copyPrevBtn.textContent = "Copy from previous day";
      }
    });
  }

  const refreshBtn = form.querySelector(".dsr-refresh-form[data-product]");
  if (refreshBtn && refreshBtn.dataset.product === product) {
    refreshBtn.addEventListener("click", async () => {
      if (refreshBtn.dataset.busy === "1") return;
      refreshBtn.dataset.busy = "1";
      refreshBtn.disabled = true;
      const prevLabel = refreshBtn.textContent;
      refreshBtn.textContent = "Refreshing…";
      try {
        await refreshMeterFormForSelectedDate(product, form);
      } finally {
        refreshBtn.dataset.busy = "0";
        refreshBtn.textContent = prevLabel || "Refresh";
        // Keep enabled even when the day is supervisor-locked (excluded from lock).
        refreshBtn.disabled = false;
      }
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    const successEl = document.getElementById(`dsr-success-${product}`);
    const errorEl = document.getElementById(`dsr-error-${product}`);
    successEl?.classList.add("hidden");
    errorEl?.classList.remove("dsr-meter-locked-msg");
    errorEl?.classList.add("hidden");

    updateDerivedFields(form);

    const formData = new FormData(form);

    // Closing must be ≥ opening on every nozzle (same rule as shift register)
    {
      const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
      const { pumps, nozzlesPerPump } = config;
      for (let p = 1; p <= pumps; p++) {
        for (let n = 1; n <= nozzlesPerPump; n++) {
          const opening = toNumber(formData.get(`opening_pump${p}_nozzle${n}`));
          const closing = toNumber(formData.get(`closing_pump${p}_nozzle${n}`));
          if (closing < opening) {
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = "Save meter entry";
            }
            if (errorEl) {
              errorEl.classList.remove("dsr-meter-locked-msg");
              errorEl.textContent = `Closing must be ≥ opening for Pump ${p} · Nozzle ${n}.`;
              errorEl.classList.remove("hidden");
            }
            return;
          }
        }
      }
      const testing = toNumber(formData.get("testing"));
      const totalSales = toNumber(formData.get("total_sales"));
      if (testing > totalSales) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save meter entry";
        }
        if (errorEl) {
          errorEl.classList.remove("dsr-meter-locked-msg");
          errorEl.textContent = "Testing cannot exceed total sales.";
          errorEl.classList.remove("hidden");
        }
        return;
      }
    }

    const payload = {
      date: formData.get("date"),
      product,
      remarks: formData.get("remarks") || null,
    };
    if (currentUserId) {
      payload.created_by = currentUserId;
    }

    getReadingNumberFields(product).forEach((field) => {
      payload[field] = toNumber(formData.get(field));
    });

    // Add the appropriate rate field based on product
    if (product === "petrol" && formData.get("petrol_rate")) {
      payload.petrol_rate = toNumber(formData.get("petrol_rate"));
    } else if (product === "diesel" && formData.get("diesel_rate")) {
      payload.diesel_rate = toNumber(formData.get("diesel_rate"));
    }

    payload.receipts = toNumber(formData.get("receipts"));

    if (!payload.date) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save meter entry";
      }
      if (errorEl) {
        errorEl.classList.remove("dsr-meter-locked-msg");
        errorEl.textContent = "Date is required.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    // Require rate + dip or stock so rate-prefill alone cannot lock the day.
    {
      const rateField = RATE_FIELD_BY_PRODUCT[product];
      const rateVal = rateField ? toNumber(formData.get(rateField)) : 0;
      const dipVal = toNumber(formData.get("dip_reading"));
      const stockVal = toNumber(formData.get("stock"));
      if (!(rateVal > 0 && (dipVal !== 0 || stockVal > 0))) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save meter entry";
        }
        if (errorEl) {
          errorEl.classList.remove("dsr-meter-locked-msg");
          errorEl.textContent =
            "Enter selling rate and dip reading or dip stock (L) before saving.";
          errorEl.classList.remove("hidden");
        }
        return;
      }
    }

    if (form.classList.contains("dsr-meter-supervisor-locked")) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save meter entry";
      }
      if (errorEl) {
        errorEl.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
        errorEl.classList.add("dsr-meter-locked-msg");
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const table = DSR_TABLE[product] || "dsr_petrol";
    const existingRow = await fetchDsrFullRowForDate(product, payload.date);
    const existingId = existingRow?.id || null;
    let saveError = null;

    if (existingId) {
      const complete = isDailyMeterEntryComplete(existingRow, product);
      if (currentUserRole !== "admin" && complete) {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save meter entry";
        }
        if (errorEl) {
          errorEl.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
          errorEl.classList.add("dsr-meter-locked-msg");
          errorEl.classList.remove("hidden");
        }
        return;
      }

      const updatePayload = { ...payload };
      delete updatePayload.created_by;
      delete updatePayload.product;
      const { error } = await window.supabaseClient.from(table).update(updatePayload).eq("id", existingId);
      saveError = error;
    } else {
      const insertPayload = { ...payload };
      delete insertPayload.product;
      const { error } = await window.supabaseClient.from(table).insert(insertPayload);
      // Race: another writer inserted the same date — fall back to update when allowed
      if (error && /duplicate|unique|23505/i.test(`${error.message || ""} ${error.code || ""}`)) {
        const racedRow = await fetchDsrFullRowForDate(product, payload.date);
        const racedId = racedRow?.id;
        const canUpdate =
          racedId &&
          (currentUserRole === "admin" || !isDailyMeterEntryComplete(racedRow, product));
        if (canUpdate) {
          const updatePayload = { ...payload };
          delete updatePayload.created_by;
          delete updatePayload.product;
          const { error: updErr } = await window.supabaseClient
            .from(table)
            .update(updatePayload)
            .eq("id", racedId);
          saveError = updErr;
        } else if (racedId) {
          saveError = {
            message:
              "A meter entry for this date already exists. Only an admin can update it.",
          };
        } else {
          saveError = error;
        }
      } else {
        saveError = error;
      }
    }

    if (saveError) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save meter entry";
      }
      errorEl?.classList.remove("dsr-meter-locked-msg");
      AppError.handle(saveError, { target: errorEl });
      return;
    }

    finishRecordFormSave(form, { date: payload.date }, {
      date: meterDateStorageKey(product),
    });
    invalidateShiftAggregateCache(payload.date);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save meter entry";
    }

    // Push daily openings into morning shift rows; afternoon closings when afternoon exists
    let syncFailed = false;
    try {
      const { error: syncErr } = await window.supabaseClient.rpc("sync_shift_meters_from_dsr", {
        p_date: payload.date,
        p_shift: null,
      });
      if (syncErr) throw syncErr;
    } catch (syncErr) {
      syncFailed = true;
      AppError.report(syncErr, { context: "meterReading.syncShiftFromDaily", product });
    }

    await refreshMeterFormForSelectedDate(product, form);
    successEl?.classList.remove("hidden");
    if (successEl) {
      if (syncFailed) {
        successEl.textContent =
          "Entry saved, but shift meter sync failed — check the shift register.";
      } else {
        const hasReceipts = Number(payload.receipts) > 0;
        if (hasReceipts && currentUserRole === "admin") {
          successEl.innerHTML =
            'Entry saved. Receipts recorded — <a href="#purchase-cost">Enter pre-VAT ₹/KL under Purchase cost</a> to calculate profit from this day until the next receipt.';
        } else if (hasReceipts) {
          successEl.textContent =
            "Entry saved. Receipts recorded — an admin can enter pre-VAT ₹/KL under Meter Reading → Purchase cost to calculate profit.";
        } else {
          successEl.textContent = "Entry saved successfully.";
        }
      }
    }
    loadReadingHistory(product, true); // Reset pagination to show new entry
    
    // Invalidate cache so dashboard reflects new DSR immediately
    if (typeof AppCache !== "undefined" && AppCache) {
      CacheInvalidation.invalidate("dsr");
    }
  });
}

/** Fetch prior-day dip stock (L) for opening stock. Skips incomplete rows with stock=0. */
async function getPreviousDayDipStock(product, dateStr) {
  if (!dateStr || !product) return 0;
  const table = DSR_TABLE[product] || "dsr_petrol";
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  const selectCols = ["stock", "dip_reading", "receipts", "date"]
    .concat(rateField ? [rateField] : [])
    .join(", ");

  // Look back several days so an incomplete row (stock 0) does not wipe opening stock.
  const { data, error } = await window.supabaseClient
    .from(table)
    .select(selectCols)
    .lt("date", dateStr)
    .order("date", { ascending: false })
    .limit(14);

  if (error || !data?.length) return 0;

  for (const row of data) {
    const stock = Number(row.stock);
    if (!Number.isFinite(stock) || stock <= 0) continue;
    // Prefer a finished daily sheet; otherwise any positive dip stock.
    if (isDailyMeterEntryComplete(row, product) || stock > 0) {
      return stock;
    }
  }
  return 0;
}

/**
 * Initialize pagination controls for DSR reading history table
 */
function initMeterPaginationControls(product) {
  const historySection = document.querySelector(`#dsr-table-${product}`)?.closest(".dsr-history");
  if (!historySection) return;

  // Check if pagination controls already exist
  if (historySection.querySelector(".pagination-controls")) return;

  // Create pagination controls container
  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="dsr-pagination-info-${product}" class="muted"></span>
    </div>
    <div class="pagination-buttons">
      <button type="button" id="dsr-pagination-back-${product}" class="button-secondary hidden">Back</button>
      <button type="button" id="dsr-load-more-${product}" class="button-secondary hidden">Load more</button>
    </div>
  `;
  historySection.appendChild(paginationDiv);

  const backBtn = document.getElementById(`dsr-pagination-back-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (dsrPagination[product].currentPage > 0) {
        dsrPagination[product].currentPage--;
        loadReadingHistory(product, false);
      }
    });
  }
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      const totalPages = Math.ceil(dsrPagination[product].totalCount / METER_RECENT_PAGE_SIZE);
      if (dsrPagination[product].currentPage < totalPages - 1) {
        dsrPagination[product].currentPage++;
        loadReadingHistory(product, false);
      }
    });
  }
}

/**
 * PostgREST filter: finished meter sheets only (matches isDailyMeterEntryComplete).
 * @param {"petrol"|"diesel"} product
 */
function finishedMeterHistoryFilter(product) {
  const rateField = RATE_FIELD_BY_PRODUCT[product] || "petrol_rate";
  return `and(${rateField}.gt.0,dip_reading.neq.0),and(${rateField}.gt.0,stock.gt.0)`;
}

/**
 * Load reading history with pagination support
 * @param {string} product - Product type (petrol/diesel)
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadReadingHistory(product, reset = false) {
  const tbody = document.getElementById(`dsr-table-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  const pagination = dsrPagination[product];

  if (!tbody) return;

  if (pagination.isLoading) return;
  pagination.isLoading = true;

  const colCount = getHistoryColCount(product);

  if (reset) {
    pagination.currentPage = 0;
    pagination.totalCount = 0;
    tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>Loading recent readings…</td></tr>`;
  }

  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
    const pumpCols = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`).join(", ");
    const selectCols = `id, date, ${pumpCols}, total_sales, testing, dip_reading, stock, petrol_rate, diesel_rate, remarks`;
    const rangeStart = pagination.currentPage * METER_RECENT_PAGE_SIZE;
    const rangeEnd = rangeStart + METER_RECENT_PAGE_SIZE - 1;
    const table = DSR_TABLE[product] || "dsr_petrol";
    const completeOr = finishedMeterHistoryFilter(product);

    let data;
    let error;

    if (reset) {
      const [countRes, pageRes] = await runAppRequest(`${product} meter history`, () =>
        Promise.all([
          supabaseClient
            .from(table)
            .select("id", { count: "exact", head: true })
            .or(completeOr),
          supabaseClient
            .from(table)
            .select(selectCols)
            .or(completeOr)
            .order("date", { ascending: false })
            .range(rangeStart, rangeEnd),
        ])
      );

      if (!countRes.error) {
        pagination.totalCount = countRes.count || 0;
      }
      data = pageRes.data;
      error = pageRes.error || countRes.error;
    } else {
      const pageRes = await runAppRequest(`${product} meter history`, () =>
        supabaseClient
          .from(table)
          .select(selectCols)
          .or(completeOr)
          .order("date", { ascending: false })
          .range(rangeStart, rangeEnd)
      );
      data = pageRes.data;
      error = pageRes.error;
    }

    if (error) {
      if (reset) {
        renderTableRetryRow(tbody, colCount, AppError.getUserMessage(error), () =>
          loadReadingHistory(product, true)
        );
      }
      AppError.report(error, { context: "loadReadingHistory", product });
      resetPaginationLoading(pagination, loadMoreBtn);
      updateDsrPaginationUI(product);
      return;
    }

    const dataRows = data || [];

    if (reset && dataRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No readings saved yet.</td></tr>`;
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    if (!reset && dataRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No more readings on this page.</td></tr>`;
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    const pumpColNames = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`);
    const isAdmin = currentUserRole === "admin";
    tbody.innerHTML = dataRows
      .map((row) => {
        const rate = product === "petrol" ? row.petrol_rate : row.diesel_rate;
        const pumpCells = pumpColNames.map((col) => `<td>${formatQuantity(row[col])}</td>`).join("");
        const actionsCell = isAdmin
          ? `<td>${AdminDelete.buttonHtml({
              selector: "dsr-delete-entry",
              data: { id: row.id, product, date: row.date },
              title: "Delete meter entry (admin)",
            })}</td>`
          : "";
        return `<tr>
          <td>${row.date}</td>
          ${pumpCells}
          <td>${formatQuantity(row.total_sales)}</td>
          <td>${formatQuantity(row.testing)}</td>
          <td>${Number(row.dip_reading) ? formatQuantity(row.dip_reading) : "—"}</td>
          <td>${Number(row.stock) ? formatQuantity(row.stock) : "—"}</td>
          <td>${rate ? formatCurrency(rate) : "—"}</td>
          <td>${escapeHtml(row.remarks ?? "—")}</td>
          ${actionsCell}
        </tr>`;
      })
      .join("");
  } catch (err) {
    if (reset && !isCancelledRequestError(err)) {
      const errColCount = getHistoryColCount(product);
      renderTableRetryRow(tbody, errColCount, AppError.getUserMessage(err), () =>
        loadReadingHistory(product, true)
      );
    }
    if (!isCancelledRequestError(err)) {
      AppError.report(err, { context: "loadReadingHistory", product });
    }
  } finally {
    pagination.isLoading = false;
    updateDsrPaginationUI(product);
  }
}

/**
 * Update pagination UI elements for DSR reading history (info text, Back, Load more).
 */
function updateDsrPaginationUI(product) {
  const backBtn = document.getElementById(`dsr-pagination-back-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  const paginationInfo = document.getElementById(`dsr-pagination-info-${product}`);
  const pagination = dsrPagination[product];

  if (paginationInfo) {
    if (pagination.totalCount > 0) {
      const totalPages = Math.ceil(pagination.totalCount / METER_RECENT_PAGE_SIZE);
      const page = pagination.currentPage;
      const from = page * METER_RECENT_PAGE_SIZE + 1;
      const to = Math.min((page + 1) * METER_RECENT_PAGE_SIZE, pagination.totalCount);
      const total = pagination.totalCount;
      if (totalPages <= 1) {
        paginationInfo.textContent = `Showing all ${total} entries`;
      } else {
        paginationInfo.textContent = `Showing ${from}–${to} of ${total}`;
      }
    } else {
      paginationInfo.textContent = "";
    }
  }

  const totalPages = Math.ceil(pagination.totalCount / METER_RECENT_PAGE_SIZE);
  const hasMultiplePages = totalPages > 1;
  const canGoBack = pagination.currentPage > 0;
  const canGoForward = pagination.currentPage < totalPages - 1;

  if (backBtn) {
    backBtn.disabled = !canGoBack;
    backBtn.classList.toggle("hidden", !hasMultiplePages);
  }
  if (loadMoreBtn) {
    loadMoreBtn.disabled = !canGoForward;
    loadMoreBtn.textContent = "Load more";
    loadMoreBtn.classList.toggle("hidden", !hasMultiplePages);
  }
}

// --- DSR prefill: fetch and apply helpers ---

/**
 * Fetches the DSR row to use for prefill: previous day if present, else latest before selected date.
 * @param {string} product - petrol | diesel
 * @param {string} selectedDateStr - YYYY-MM-DD
 * @param {string} selectCols - Comma-separated column names to select
 * @returns {Promise<{ row: object | null, error: Error | null }>}
 */
async function fetchDsrRowForPrefill(product, selectedDateStr, selectCols) {
  const prevDateStr = getPreviousDateStr(selectedDateStr);
  const table = DSR_TABLE[product] || "dsr_petrol";

  const { data: prevDayData, error: prevError } = await window.supabaseClient
    .from(table)
    .select(selectCols)
    .eq("date", prevDateStr)
    .maybeSingle();

  if (prevError) {
    AppError.report(prevError, { context: "fetchDsrRowForPrefill", product });
    return { row: null, error: prevError };
  }
  if (prevDayData) return { row: prevDayData, error: null };

  const { data: lastData, error: lastError } = await window.supabaseClient
    .from(table)
    .select(selectCols)
    .lt("date", selectedDateStr)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastError) {
    AppError.report(lastError, { context: "fetchDsrRowForPrefill", product });
    return { row: null, error: lastError };
  }
  return { row: lastData, error: null };
}

/**
 * Last positive selling rate for a product (skips null/zero incomplete rows).
 * @param {string} product - petrol | diesel
 * @returns {Promise<number | null>}
 */
async function fetchLastDsrRate(product) {
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (!rateField) return null;
  const table = DSR_TABLE[product] || "dsr_petrol";

  const { data, error } = await window.supabaseClient
    .from(table)
    .select(rateField)
    .not(rateField, "is", null)
    .order("date", { ascending: false })
    .limit(30);

  if (error || !data?.length) return null;
  for (const row of data) {
    const num = Number(row[rateField]);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

/**
 * If the rate field is empty or zero, fill from the last entered selling rate.
 */
async function ensureMeterRatePrefill(product, form) {
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (!rateField) return;
  const input = form.querySelector(`[name="${rateField}"]`);
  if (!input) return;
  const current = Number(input.value);
  if (Number.isFinite(current) && current > 0) return;
  const lastRate = await fetchLastDsrRate(product);
  if (lastRate != null) applyRateToForm(form, product, lastRate);
}

/**
 * Applies opening meter values to the form from a DSR row, or "0.00" if no row.
 * @param {HTMLFormElement} form
 * @param {object | null} row - DSR row with closing_pump*_nozzle* fields
 * @param {{ pumps: number, nozzlesPerPump: number }} config
 */
function applyOpeningMeterToForm(form, row, config) {
  const closingFields = getClosingMeterFields(config);
  for (const closingKey of closingFields) {
    const openingKey = closingKey.replace("closing_", "opening_");
    const input = form.querySelector(`[name="${openingKey}"]`);
    if (!input) continue;

    let value = "0.00";
    if (row) {
      const v = row[closingKey];
      if (v != null && Number.isFinite(Number(v))) value = Number(v).toFixed(2);
    }
    input.value = value;
  }
}

/**
 * Sets the rate input on the form if value is a valid number.
 * @param {HTMLFormElement} form
 * @param {string} product - petrol | diesel
 * @param {number | null} rateValue
 */
function applyRateToForm(form, product, rateValue) {
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (!rateField) return;
  const input = form.querySelector(`[name="${rateField}"]`);
  if (!input || rateValue == null || !Number.isFinite(rateValue) || rateValue <= 0) return;
  input.value = rateValue.toFixed(2);
}

/**
 * Prefill opening meter and rate from previous/last DSR. Opening uses previous day, else latest before date; if none, opening is zero. Rate uses that row or last entered rate.
 * @param {string} product - petrol | diesel
 * @param {HTMLFormElement} form - The DSR reading form
 */
async function prefillOpeningFromPreviousDay(product, form) {
  const dateInput = form.querySelector("input[name='date']");
  if (!dateInput?.value) return;

  const selectedDateStr = dateInput.value;
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  const closingFields = getClosingMeterFields(config);
  const selectCols = closingFields.join(", ") + (rateField ? ", " + rateField : "");

  const { row, error } = await fetchDsrRowForPrefill(product, selectedDateStr, selectCols);
  if (error) return;

  applyOpeningMeterToForm(form, row, config);

  const priorRate = row?.[rateField] != null ? Number(row[rateField]) : NaN;
  const needsRateFallback = !Number.isFinite(priorRate) || priorRate <= 0;

  const [openingStock, rateFallback] = await Promise.all([
    getPreviousDayDipStock(product, selectedDateStr),
    needsRateFallback ? fetchLastDsrRate(product) : Promise.resolve(null),
  ]);

  const openingStockInput = getFormFieldInput(form, "opening_stock");
  if (openingStockInput) {
    openingStockInput.value = openingStock > 0 ? openingStock.toFixed(2) : "";
  }

  applyRateToForm(
    form,
    product,
    needsRateFallback ? rateFallback : priorRate
  );

  updateDerivedFields(form);
}

function meterDateStorageKey(product) {
  return product === "petrol" ? RECORD_DATE_KEYS.dsrPetrol : RECORD_DATE_KEYS.dsrDiesel;
}

function initMeterFormDate(form, product) {
  const dateInput = form.querySelector("input[name='date']");
  if (dateInput) initPersistedDateInput(dateInput, meterDateStorageKey(product), { urlParam: "date" });
}

function toNumber(value) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Opening stock on meter forms uses id `{product}-opening-stock-inline` (see meter-reading.html).
 * Resolves inside the form so diesel/petrol stay independent.
 * @param {HTMLFormElement} form
 * @returns {HTMLInputElement | null}
 */
function getMeterReadingOpeningStockInput(form) {
  if (!form?.id?.startsWith("dsr-form-")) {
    return form?.querySelector('input[name="opening_stock"]') ?? null;
  }
  const product = form.id.slice("dsr-form-".length);
  const idSel =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? `#${CSS.escape(product)}-opening-stock-inline`
      : `#${product}-opening-stock-inline`;
  return form.querySelector(idSel) || form.querySelector('input[name="opening_stock"]');
}

function getFormFieldInput(form, name) {
  if (name === "opening_stock") {
    const meterOpening = getMeterReadingOpeningStockInput(form);
    if (meterOpening) return meterOpening;
  }
  return form.querySelector(`[name="${name}"]`);
}

function updateDerivedFields(form) {
  const product = form.id?.replace("dsr-form-", "") || "petrol";
  const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
  const { pumps, nozzlesPerPump } = config;

  const salesByPump = [];
  for (let p = 1; p <= pumps; p++) {
    let pumpSales = 0;
    for (let n = 1; n <= nozzlesPerPump; n++) {
      const opening = getNumber(form, `opening_pump${p}_nozzle${n}`);
      const closing = getNumber(form, `closing_pump${p}_nozzle${n}`);
      pumpSales += Math.max(closing - opening, 0);
    }
    salesByPump.push(pumpSales);
    setNumber(form, `sales_pump${p}`, pumpSales);
  }

  const totalSales = salesByPump.reduce((a, b) => a + b, 0);
  const testing = getNumber(form, "testing");
  const stock = getNumber(form, "stock");
  const openingStock = getNumber(form, "opening_stock");
  const receipts = getNumber(form, "receipts");
  const netSale = totalSales - testing;
  const totalStock = openingStock + receipts;
  const variation = stock - (totalStock - netSale);

  setNumber(form, "total_sales", totalSales);
  setNumber(form, "net_sale", netSale);
  setNumber(form, "total_stock", totalStock);
  setNumber(form, "variation", variation);
}

function getNumber(form, name) {
  const input = getFormFieldInput(form, name);
  if (!input) return 0;
  return toNumber(input.value);
}

function setNumber(form, name, value) {
  const input = getFormFieldInput(form, name);
  if (!input) return;
  if (!Number.isFinite(value)) {
    input.value = "";
    return;
  }
  input.value = value.toFixed(2);
}

// Expose for shift register → MS/HSD form refresh
window.MeterReadingForms = {
  refreshForShiftDate: refreshMeterFormsForShiftDate,
};

bindLiveRefresh(
  () => {
    PRODUCTS.forEach((product) => {
      resetPaginationLoading(dsrPagination[product], document.getElementById(`dsr-load-more-${product}`));
    });
    void Promise.all(PRODUCTS.map((product) => loadReadingHistory(product, true)));
    if (typeof MeterShiftReading !== "undefined" && isSettingsPanelActive("shift-readings")) {
      void MeterShiftReading.init({ isAdmin: currentUserRole === "admin", userId: currentUserId });
    }
    if (currentUserRole === "admin" && isSettingsPanelActive("purchase-cost")) {
      const listEl = document.getElementById("purchase-cost-missing-list");
      const dirty =
        typeof BuyingPriceEntry?.hasUnsavedEdits === "function" &&
        BuyingPriceEntry.hasUnsavedEdits(listEl);
      if (!dirty) void ensurePurchaseCostLoaded({ force: true });
    }
  },
  { match: () => document.body.classList.contains("meter-reading-page") }
);
