/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, AppError, escapeHtml, PumpSettings, loadPumpSettings, AppConfig */

const PRODUCTS = ["petrol", "diesel"];
let currentUserId = null;

/** Pump/nozzle layout; loaded from Settings (pump_settings). */
let PUMP_CONFIG = {
  petrol: { pumps: 2, nozzlesPerPump: 2 },
  diesel: { pumps: 2, nozzlesPerPump: 2 },
};

function applyPumpConfigFromSettings() {
  const pumps = PumpSettings.getPumpConfig();
  PUMP_CONFIG = {
    petrol: {
      pumps: Number(pumps.petrol?.pumps) || 2,
      nozzlesPerPump: Number(pumps.petrol?.nozzlesPerPump) || 2,
    },
    diesel: {
      pumps: Number(pumps.diesel?.pumps) || 2,
      nozzlesPerPump: Number(pumps.diesel?.nozzlesPerPump) || 2,
    },
  };
}

/** Rate column name per product (dsr table). */
const RATE_FIELD_BY_PRODUCT = { petrol: "petrol_rate", diesel: "diesel_rate" };

/** Maps product to its dedicated database table name (writes go here). */
const DSR_TABLE = { petrol: "dsr_petrol", diesel: "dsr_diesel" };

/** Shown when a supervisor picks a date that already has a meter entry (read-only view). */
const MSG_SUPERVISOR_METER_DAY_LOCKED =
  "Meter readings for this date are already saved. Choose another date to enter new readings, or contact an admin if a correction is needed.";

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

/** Build list of DSR reading number field names from config (uses petrol shape for table). */
function getReadingNumberFields() {
  const config = PUMP_CONFIG.petrol;
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

const readingNumberFields = getReadingNumberFields();

// Pagination configuration and state (page-based: 0 = first page)
const DSR_PAGE_SIZE = 10;
/** Page size for "Recent meter entries" so "Load more" and Back show when there are more entries */
const DSR_RECENT_PAGE_SIZE = 5;
const dsrPagination = {
  petrol: { currentPage: 0, totalCount: 0, isLoading: false },
  diesel: { currentPage: 0, totalCount: 0, isLoading: false },
};

/** Increments on each date refresh so stale async results do not overwrite the form. */
const meterRefreshGeneration = { petrol: 0, diesel: 0 };

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
  });
  if (!auth) return;

  await loadPumpSettings();
  applyPumpConfigFromSettings();

  currentUserId = auth.session?.user?.id ?? null;
  currentUserRole = auth.role ?? "supervisor";
  applyRoleVisibility(auth.role);

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "petrol", validSections: ["petrol", "diesel"] });
    document.querySelectorAll(".settings-nav-item[data-section]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fuel = btn.dataset.section;
        const sel = document.getElementById("meter-fuel-select");
        if (sel && (fuel === "petrol" || fuel === "diesel")) sel.value = fuel;
      });
    });
  }

  PRODUCTS.forEach((product) => {
    initReadingForm(product);
    initDsrPaginationControls(product);
  });
  initMeterFilter();
  initDsrDeleteHandlers();
  await Promise.all(PRODUCTS.map((product) => loadReadingHistory(product, true)));
});

/** Column count for recent-entries table (includes Actions for admin). */
function getHistoryColCount(product) {
  const pumps = (PUMP_CONFIG[product] || PUMP_CONFIG.petrol).pumps;
  const base = 7 + pumps;
  return currentUserRole === "admin" ? base + 1 : base;
}

/** Delete meter history rows — admin only (RLS also enforces on server). */
function initDsrDeleteHandlers() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest?.(".dsr-delete-entry");
    if (!btn) return;

    if (currentUserRole !== "admin") {
      alert("Only an admin can delete meter entries.");
      return;
    }

    const id = btn.dataset.id;
    const product = btn.dataset.product;
    const dateStr = btn.dataset.date;
    if (!id || !product) return;

    const fuelLabel = product === "petrol" ? "MS (Petrol)" : "HSD (Diesel)";
    const confirmed = confirm(
      `Delete the ${fuelLabel} meter entry for ${dateStr || "this date"}? This cannot be undone.`
    );
    if (!confirmed) return;

    btn.disabled = true;
    const table = DSR_TABLE[product] || "dsr_petrol";
    const { error } = await supabaseClient.from(table).delete().eq("id", id);

    if (error) {
      btn.disabled = false;
      alert(AppError.getUserMessage(error));
      AppError.report(error, { context: "deleteMeterEntry", product, id });
      return;
    }

    const form = document.getElementById(`dsr-form-${product}`);
    const dateInput = form?.querySelector('input[name="date"]');
    if (form && dateInput?.value === dateStr) {
      await refreshMeterFormForSelectedDate(product, form);
    }

    await loadReadingHistory(product, true);
  });
}

/**
 * @param {string} product
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<string | null>} dsr.id
 */
async function fetchDsrEntryIdForDate(product, dateStr) {
  if (!dateStr || !product) return null;
  const table = DSR_TABLE[product] || "dsr_petrol";
  const { data, error } = await supabaseClient
    .from(table)
    .select("id")
    .eq("date", dateStr)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0].id ?? null;
}

/**
 * Full DSR row for a calendar date (latest by created_at if duplicates).
 * @returns {Promise<object | null>}
 */
async function fetchDsrFullRowForDate(product, dateStr) {
  if (!dateStr || !product) return null;
  const table = DSR_TABLE[product] || "dsr_petrol";
  const { data, error } = await supabaseClient
    .from(table)
    .select("*")
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
    if (openingStockHint != null && Number.isFinite(Number(openingStockHint))) {
      openingInput.value = Number(openingStockHint).toFixed(2);
    } else {
      openingInput.value = "";
    }
  }
}

/**
 * Hydrate meter form from an already-fetched DSR row (opening stock from previous day).
 */
async function applyExistingDsrRowToMeterForm(product, form, row) {
  if (!row) return;

  const openingHint = await getPreviousDayDipStock(product, row.date);

  applyDsrRowFieldsToMeterForm(form, row, product, openingHint);
  updateDerivedFields(form);
}

function setMeterFormSupervisorLocked(form, locked) {
  const suffix = form.id?.replace("dsr-form-", "") || "";
  const banner = document.getElementById(`dsr-meter-locked-banner-${suffix}`);

  if (!locked) {
    form.classList.remove("dsr-meter-supervisor-locked");
    if (banner) {
      banner.classList.add("hidden");
      banner.textContent = "";
    }
    form.querySelectorAll("[data-dsr-supervisor-lock]").forEach((el) => {
      if (el.tagName === "BUTTON") {
        el.disabled = false;
      } else {
        el.readOnly = el.dataset.dsrOrigReadonly === "1";
      }
      el.removeAttribute("data-dsr-supervisor-lock");
      el.removeAttribute("data-dsr-orig-readonly");
    });
    return;
  }

  form.classList.add("dsr-meter-supervisor-locked");
  if (banner) {
    banner.textContent = MSG_SUPERVISOR_METER_DAY_LOCKED;
    banner.classList.remove("hidden");
  }

  form.querySelectorAll("input, textarea, button").forEach((el) => {
    if (el.name === "date" || el.type === "hidden") return;
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

function applyMeterDayLockState(product, form, hasEntryForDate) {
  if (currentUserRole !== "supervisor" || !hasEntryForDate) {
    setMeterFormSupervisorLocked(form, false);
    return;
  }
  setMeterFormSupervisorLocked(form, true);
}

/**
 * Prefill for new dates, load saved row for dates that already have a DSR, then apply supervisor lock.
 */
async function refreshMeterFormForSelectedDate(product, form) {
  const dateInput = form.querySelector("input[name='date']");
  if (!dateInput?.value) return;

  const gen = (meterRefreshGeneration[product] = (meterRefreshGeneration[product] || 0) + 1);
  const dateStr = dateInput.value;

  const existingRow = await fetchDsrFullRowForDate(product, dateStr);

  if (gen !== meterRefreshGeneration[product]) return;

  if (existingRow) {
    await applyExistingDsrRowToMeterForm(product, form, existingRow);
  } else {
    await prefillOpeningFromPreviousDay(product, form);
  }

  if (gen !== meterRefreshGeneration[product]) return;

  applyMeterDayLockState(product, form, !!existingRow);
}

function initReadingForm(product) {
  const form = document.getElementById(`dsr-form-${product}`);
  if (!form) return;

  setDefaultDate(form);

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
      copyPrevBtn.disabled = true;
      copyPrevBtn.textContent = "Loading…";
      await prefillOpeningFromPreviousDay(product, form);
      updateDerivedFields(form);
      const d = form.querySelector("input[name='date']")?.value;
      const id = d ? await fetchDsrEntryIdForDate(product, d) : null;
      applyMeterDayLockState(product, form, id != null);
      copyPrevBtn.disabled = false;
      copyPrevBtn.textContent = "Copy from previous day";
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
    const payload = {
      date: formData.get("date"),
      product,
      remarks: formData.get("remarks") || null,
    };
    if (currentUserId) {
      payload.created_by = currentUserId;
    }

    readingNumberFields.forEach((field) => {
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
    const existingId = await fetchDsrEntryIdForDate(product, payload.date);
    let saveError = null;

    if (existingId) {
      if (currentUserRole !== "admin") {
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
      const { error } = await supabaseClient.from(table).update(updatePayload).eq("id", existingId);
      saveError = error;
    } else {
      const insertPayload = { ...payload };
      delete insertPayload.product;
      const { error } = await supabaseClient.from(table).insert(insertPayload);
      saveError = error;
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

    const hasReceipts = Number(payload.receipts) > 0;
    if (hasReceipts && typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("pl_todo_pending", "1");
    }

    form.reset();
    setDefaultDate(form);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save meter entry";
    }
    await refreshMeterFormForSelectedDate(product, form);
    successEl?.classList.remove("hidden");
    if (successEl) {
      if (hasReceipts && currentUserRole === "admin") {
        successEl.innerHTML =
          'Entry saved. Receipts recorded — <a href="dashboard.html#pl">Enter ex-VAT buying price on P&amp;L</a> to calculate profit from this day until the next receipt.';
      } else if (hasReceipts) {
        successEl.textContent =
          "Entry saved. Receipts recorded — an admin can enter ex-VAT buying price on the P&L dashboard to calculate profit.";
      } else {
        successEl.textContent = "Entry saved successfully.";
      }
    }
    loadReadingHistory(product, true); // Reset pagination to show new entry
    // Invalidate cache so dashboard reflects new DSR immediately
    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.invalidateByType("dashboard_data");
      AppCache.invalidateByType("today_sales");
      AppCache.invalidateByType("dsr_summary");
      AppCache.invalidateByType("profit_loss");
      AppCache.invalidateByType("reports_data");
    }
  });
}

/** Fetch previous day's stock (dip reading) for a product. Returns a number. */
async function getPreviousDayDipStock(product, dateStr) {
  if (!dateStr || !product) return 0;
  const prevDateStr = getPreviousDateStr(dateStr);
  const table = DSR_TABLE[product] || "dsr_petrol";
  const { data, error } = await supabaseClient
    .from(table)
    .select("stock")
    .eq("date", prevDateStr)
    .maybeSingle();
  if (!error && data != null && Number.isFinite(Number(data.stock))) {
    return Number(data.stock);
  }
  return 0;
}

/**
 * Initialize pagination controls for DSR reading history table
 */
function initDsrPaginationControls(product) {
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
      const totalPages = Math.ceil(dsrPagination[product].totalCount / DSR_RECENT_PAGE_SIZE);
      if (dsrPagination[product].currentPage < totalPages - 1) {
        dsrPagination[product].currentPage++;
        loadReadingHistory(product, false);
      }
    });
  }
}

/**
 * Load reading history with pagination support
 * @param {string} product - Product type (petrol/diesel)
 * @param {boolean} reset - If true, resets pagination and clears existing data
 */
async function loadReadingHistory(product, reset = false) {
  const tbody = document.getElementById(`dsr-table-${product}`);
  const loadMoreBtn = document.getElementById(`dsr-load-more-${product}`);
  const paginationInfo = document.getElementById(`dsr-pagination-info-${product}`);
  const pagination = dsrPagination[product];
  
  if (!tbody) return;
  
  // Prevent duplicate requests
  if (pagination.isLoading) return;
  pagination.isLoading = true;

  const colCount = getHistoryColCount(product);

  if (reset) {
    pagination.currentPage = 0;
    pagination.totalCount = 0;
    tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>Loading recent readings…</td></tr>`;
  }

  // Update button state
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    const config = PUMP_CONFIG[product] || PUMP_CONFIG.petrol;
    const pumpCols = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`).join(", ");
    const selectCols = `id, date, ${pumpCols}, total_sales, testing, dip_reading, stock, petrol_rate, diesel_rate, remarks`;
    const rangeStart = pagination.currentPage * DSR_RECENT_PAGE_SIZE;
    const rangeEnd = rangeStart + DSR_RECENT_PAGE_SIZE - 1;

    let data;
    let error;

    const table = DSR_TABLE[product] || "dsr_petrol";
    if (reset) {
      const [countRes, pageRes] = await Promise.all([
        supabaseClient
          .from(table)
          .select("*", { count: "exact", head: true }),
        supabaseClient
          .from(table)
          .select(selectCols)
          .order("date", { ascending: false })
          .range(rangeStart, rangeEnd),
      ]);

      if (!countRes.error) {
        pagination.totalCount = countRes.count || 0;
      }
      data = pageRes.data;
      error = pageRes.error;
    } else {
      const pageRes = await supabaseClient
        .from(table)
        .select(selectCols)
        .order("date", { ascending: false })
        .range(rangeStart, rangeEnd);
      data = pageRes.data;
      error = pageRes.error;
    }

    if (error) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan='${colCount}' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      }
      AppError.report(error, { context: "loadReadingHistory", product });
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    const dataRows = data || [];

    // Handle empty data
    if (reset && dataRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No readings saved yet.</td></tr>`;
      pagination.isLoading = false;
      updateDsrPaginationUI(product);
      return;
    }

    // Replace tbody with current page rows
    const pumpColNames = Array.from({ length: config.pumps }, (_, i) => `sales_pump${i + 1}`);
    const isAdmin = currentUserRole === "admin";
    tbody.innerHTML = dataRows
      .map((row) => {
        const rate = product === "petrol" ? row.petrol_rate : row.diesel_rate;
        const pumpCells = pumpColNames.map((col) => `<td>${formatQuantity(row[col])}</td>`).join("");
        const actionsCell = isAdmin
          ? `<td><button type="button" class="dsr-delete-entry button-secondary" data-id="${escapeHtml(row.id)}" data-product="${escapeHtml(product)}" data-date="${escapeHtml(row.date)}" title="Delete meter entry (admin only)">Delete</button></td>`
          : "";
        return `<tr>
          <td>${row.date}</td>
          ${pumpCells}
          <td>${formatQuantity(row.total_sales)}</td>
          <td>${formatQuantity(row.testing)}</td>
          <td>${formatQuantity(row.dip_reading)}</td>
          <td>${formatQuantity(row.stock)}</td>
          <td>${rate ? formatCurrency(rate) : "—"}</td>
          <td>${escapeHtml(row.remarks ?? "—")}</td>
          ${actionsCell}
        </tr>`;
      })
      .join("");

  } catch (err) {
    if (reset) {
      const errColCount = getHistoryColCount(product);
      tbody.innerHTML = `<tr><td colspan="${errColCount}" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    }
    AppError.report(err, { context: "loadReadingHistory", product });
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
      const totalPages = Math.ceil(pagination.totalCount / DSR_RECENT_PAGE_SIZE);
      const page = pagination.currentPage;
      const from = page * DSR_RECENT_PAGE_SIZE + 1;
      const to = Math.min((page + 1) * DSR_RECENT_PAGE_SIZE, pagination.totalCount);
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

  const totalPages = Math.ceil(pagination.totalCount / DSR_RECENT_PAGE_SIZE);
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

  const { data: prevDayData, error: prevError } = await supabaseClient
    .from(table)
    .select(selectCols)
    .eq("date", prevDateStr)
    .maybeSingle();

  if (prevError) {
    AppError.report(prevError, { context: "fetchDsrRowForPrefill", product });
    return { row: null, error: prevError };
  }
  if (prevDayData) return { row: prevDayData, error: null };

  const { data: lastData, error: lastError } = await supabaseClient
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
 * Fetches the most recent non-null rate for a product from dsr.
 * @param {string} product - petrol | diesel
 * @returns {Promise<number | null>}
 */
async function fetchLastDsrRate(product) {
  const rateField = RATE_FIELD_BY_PRODUCT[product];
  if (!rateField) return null;
  const table = DSR_TABLE[product] || "dsr_petrol";

  const { data, error } = await supabaseClient
    .from(table)
    .select(rateField)
    .not(rateField, "is", null)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || data?.[rateField] == null) return null;
  const num = Number(data[rateField]);
  return Number.isFinite(num) ? num : null;
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
  if (!input || rateValue == null || !Number.isFinite(rateValue)) return;
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

  const needsRateFallback =
    !row || row[rateField] == null || !Number.isFinite(Number(row[rateField]));

  const [openingStock, rateFallback] = await Promise.all([
    getPreviousDayDipStock(product, selectedDateStr),
    needsRateFallback ? fetchLastDsrRate(product) : Promise.resolve(null),
  ]);

  const openingStockInput = getFormFieldInput(form, "opening_stock");
  if (openingStockInput) {
    openingStockInput.value = openingStock > 0 ? openingStock.toFixed(2) : "";
  }

  let rateValue = row?.[rateField];
  if (rateValue == null || !Number.isFinite(Number(rateValue))) {
    rateValue = rateFallback;
  } else {
    rateValue = Number(rateValue);
  }
  applyRateToForm(form, product, rateValue);

  updateDerivedFields(form);
}

function setDefaultDate(form) {
  const dateInput = form.querySelector("input[type='date']");
  if (dateInput && !dateInput.value) {
    dateInput.value = getLocalDateString();
  }
}

function toNumber(value) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Opening stock on meter forms uses id `{product}-opening-stock-inline` (see dsr.html).
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
      pumpSales += closing - opening;
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

function formatQuantity(value) {
  if (value === null || value === undefined) return "—";
  if (Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

const METER_FILTER_KEY = "petrolpump_meter_filter";

function initMeterFilter() {
  const select = document.getElementById("meter-fuel-select");
  if (!select) return;

  const saved = (() => {
    try { return localStorage.getItem(METER_FILTER_KEY); } catch (_) { return null; }
  })();
  const initial = saved && ["all", "petrol", "diesel"].includes(saved) ? saved : "petrol";

  select.value = initial;
  applyMeterFilter(initial);

  select.addEventListener("change", () => {
    applyMeterFilter(select.value);
    try { localStorage.setItem(METER_FILTER_KEY, select.value); } catch (_) {}
  });
}

function applyMeterFilter(filter) {
  document.querySelectorAll(".dsr-card[data-product]").forEach((card) => {
    const product = card.dataset.product;
    card.classList.toggle("filter-hidden", filter !== "all" && product !== filter);
  });
}

