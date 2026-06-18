/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getLocalDateString, toLocalDateString, escapeHtml, AdminDelete, CacheInvalidation, getValidFilterState, setFilterState */

// Day closing & short: (Total sale + Collection + Short previous) − (Night cash + Phone pay + Credit + Expenses) = Today's short
let dayClosingBreakdown = null;
let isAdmin = false;
let dcBreakdownRequestId = 0;
let dcDetailsCache = { date: null, collection: null, credit: null, expenses: null };
let expenseCategoryLabels = null;

const DC_DETAIL_KINDS = ["collection", "credit", "expenses"];
const DAY_CLOSING_DATE_RANGE = new Set(["date"]);

function saveDayClosingDateFilter(dateStr) {
  if (dateStr && typeof setFilterState === "function") {
    setFilterState("day_closing_close", { range: "date", start: dateStr });
  }
}

function resolveDayClosingDateInput(dateInput, todayStr) {
  const dateParam = new URLSearchParams(window.location.search).get("date");
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    dateInput.value = dateParam;
  } else {
    const stored =
      typeof getValidFilterState === "function"
        ? getValidFilterState("day_closing_close", DAY_CLOSING_DATE_RANGE)
        : null;
    if (stored?.start) {
      dateInput.value = stored.start;
    } else if (!dateInput.value) {
      dateInput.value = todayStr;
    }
  }
  saveDayClosingDateFilter(dateInput.value);
  return dateInput.value || todayStr;
}
const DC_LEGACY_EXPENSE_LABELS = {
  miscellanious: "Miscellaneous",
  mstest: "Miscellaneous",
  hsdtest: "Others",
};
const DC_AMOUNT_COLUMN = {
  label: "Amount",
  format: (row) => formatCurrency(row.amount),
  escape: false,
};
const DC_DETAIL_COLUMNS = {
  collection: [
    { label: "Customer", key: "customer" },
    { label: "Mode", key: "mode" },
    DC_AMOUNT_COLUMN,
  ],
  credit: [
    { label: "Customer", key: "customer" },
    { label: "Fuel", format: (row) => (row.legacy ? "Legacy" : row.fuel) },
    { label: "Qty (L)", format: (row) => (row.quantity == null ? "—" : row.quantity.toFixed(3)) },
    DC_AMOUNT_COLUMN,
  ],
  expenses: [
    { label: "Category", key: "category" },
    { label: "Description", key: "description" },
    DC_AMOUNT_COLUMN,
  ],
};

function getDcDetailElements(kind) {
  const group = document.querySelector(`.dc-breakdown-group[data-breakdown="${kind}"]`);
  return {
    toggle: group?.querySelector(".dc-breakdown-toggle") ?? null,
    panel: group?.querySelector(".dc-breakdown-details") ?? null,
  };
}

function collapseDayClosingDetails() {
  document.querySelectorAll(".dc-breakdown-group").forEach((group) => {
    const toggle = group.querySelector(".dc-breakdown-toggle");
    const panel = group.querySelector(".dc-breakdown-details");
    toggle?.setAttribute("aria-expanded", "false");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  });
}

async function refreshDayClosingDetailsState(dateStr) {
  const prevDate = dcDetailsCache.date;
  dcDetailsCache = { date: dateStr, collection: null, credit: null, expenses: null };
  if (prevDate !== dateStr) {
    collapseDayClosingDetails();
    return;
  }
  await Promise.all(DC_DETAIL_KINDS.map(async (kind) => {
    const { toggle } = getDcDetailElements(kind);
    if (toggle?.getAttribute("aria-expanded") === "true") {
      await loadDayClosingDetail(kind, dateStr);
    }
  }));
}

async function loadExpenseCategoryLabels() {
  if (expenseCategoryLabels) return expenseCategoryLabels;
  const { data, error } = await supabaseClient
    .from("expense_categories")
    .select("name, label");
  if (error) throw error;
  expenseCategoryLabels = Object.fromEntries((data || []).map((row) => [row.name, row.label]));
  return expenseCategoryLabels;
}

function renderDayClosingDetailTable(rows, columns) {
  if (!rows.length) {
    return '<p class="muted">No entries for this date.</p>';
  }
  const head = columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join("");
  const body = rows.map((row) => {
    const cells = columns.map((col) => {
      const value = typeof col.format === "function" ? col.format(row) : (row[col.key] ?? "—");
      return `<td>${typeof value === "string" && col.escape !== false ? escapeHtml(String(value)) : value}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table class="dc-breakdown-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function fetchCollectionDetails(dateStr) {
  const { data, error } = await supabaseClient
    .from("credit_payments")
    .select("amount, payment_mode, credit_customers(customer_name)")
    .eq("date", dateStr)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    customer: row.credit_customers?.customer_name || "—",
    mode: row.payment_mode || "—",
    amount: Number(row.amount ?? 0),
  }));
}

async function fetchCreditTodayDetails(dateStr) {
  const [entriesRes, legacyRes] = await Promise.all([
    supabaseClient
      .from("credit_entries")
      .select("credit_customer_id, amount, fuel_type, quantity, credit_customers(customer_name)")
      .eq("transaction_date", dateStr)
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("credit_customers")
      .select("id, customer_name, amount_due")
      .eq("date", dateStr)
      .gt("amount_due", 0),
  ]);
  if (entriesRes.error) throw entriesRes.error;
  if (legacyRes.error) throw legacyRes.error;

  const entryRows = (entriesRes.data || []).map((row) => ({
    customer: row.credit_customers?.customer_name || "—",
    fuel: row.fuel_type || "—",
    quantity: Number(row.quantity ?? 0),
    amount: Number(row.amount ?? 0),
    legacy: false,
  }));

  const legacyCandidates = legacyRes.data || [];
  let legacyRows = [];
  if (legacyCandidates.length) {
    const ids = legacyCandidates.map((row) => row.id);
    const { data: withEntries, error: entryCheckError } = await supabaseClient
      .from("credit_entries")
      .select("credit_customer_id")
      .in("credit_customer_id", ids);
    if (entryCheckError) throw entryCheckError;
    const hasEntry = new Set((withEntries || []).map((row) => row.credit_customer_id));
    legacyRows = legacyCandidates
      .filter((row) => !hasEntry.has(row.id))
      .map((row) => ({
        customer: row.customer_name || "—",
        fuel: "—",
        quantity: null,
        amount: Number(row.amount_due ?? 0),
        legacy: true,
      }));
  }

  return [...entryRows, ...legacyRows];
}

async function fetchExpensesDetails(dateStr) {
  const [expensesRes, labelMap] = await Promise.all([
    supabaseClient
      .from("expenses")
      .select("category, description, amount")
      .eq("date", dateStr)
      .order("created_at", { ascending: true }),
    loadExpenseCategoryLabels(),
  ]);
  if (expensesRes.error) throw expensesRes.error;
  const getCategoryLabel = (value) => labelMap[value] || DC_LEGACY_EXPENSE_LABELS[value] || value || "—";
  return (expensesRes.data || []).map((row) => ({
    category: getCategoryLabel(row.category),
    description: row.description || "—",
    amount: Number(row.amount ?? 0),
  }));
}

const DC_DETAIL_FETCHERS = {
  collection: fetchCollectionDetails,
  credit: fetchCreditTodayDetails,
  expenses: fetchExpensesDetails,
};

async function loadDayClosingDetail(kind, dateStr) {
  const { panel } = getDcDetailElements(kind);
  if (!panel) return;

  if (dcDetailsCache.date === dateStr && dcDetailsCache[kind]) {
    panel.innerHTML = dcDetailsCache[kind];
    return;
  }

  panel.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const rows = await DC_DETAIL_FETCHERS[kind](dateStr);
    const html = renderDayClosingDetailTable(rows, DC_DETAIL_COLUMNS[kind]);
    dcDetailsCache.date = dateStr;
    dcDetailsCache[kind] = html;
    panel.innerHTML = html;
  } catch (err) {
    AppError.report(err, { context: `loadDayClosingDetail:${kind}` });
    panel.innerHTML = `<p class="error">${escapeHtml(err?.message || "Failed to load details.")}</p>`;
  }
}

async function toggleDayClosingDetail(kind) {
  const dateInput = document.getElementById("day-closing-date");
  const dateStr = dateInput?.value?.trim();
  if (!dateStr) return;

  const { toggle, panel } = getDcDetailElements(kind);
  if (!toggle || !panel) return;

  const isOpen = toggle.getAttribute("aria-expanded") === "true";
  if (isOpen) {
    toggle.setAttribute("aria-expanded", "false");
    panel.hidden = true;
    return;
  }

  toggle.setAttribute("aria-expanded", "true");
  panel.hidden = false;
  await loadDayClosingDetail(kind, dateStr);
}

async function loadDayClosingBreakdown(dateStr) {
  const dateInput = document.getElementById("day-closing-date");
  const nightCashInput = document.getElementById("dc-night-cash");
  const phonePayInput = document.getElementById("dc-phone-pay");
  const totalSaleEl = document.getElementById("dc-total-sale");
  const collectionEl = document.getElementById("dc-collection");
  const shortPrevEl = document.getElementById("dc-short-previous");
  const subtotalEl = document.getElementById("dc-subtotal");
  const creditTodayEl = document.getElementById("dc-credit-today");
  const expensesTodayEl = document.getElementById("dc-expenses-today");
  const shortTodayEl = document.getElementById("dc-short-today");
  const successEl = document.getElementById("day-closing-success");
  const errorEl = document.getElementById("day-closing-error");

  if (!dateStr || !dateInput) return;

  if (dateInput.value !== dateStr) dateInput.value = dateStr;

  const requestId = ++dcBreakdownRequestId;
  refreshDayClosingDetailsState(dateStr).catch((err) => {
    AppError.report(err, { context: "refreshDayClosingDetailsState" });
  });

  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");
  if (totalSaleEl) totalSaleEl.textContent = "…";
  if (collectionEl) collectionEl.textContent = "…";
  if (shortPrevEl) shortPrevEl.textContent = "…";
  if (subtotalEl) subtotalEl.textContent = "…";
  if (creditTodayEl) creditTodayEl.textContent = "…";
  if (expensesTodayEl) expensesTodayEl.textContent = "…";
  if (shortTodayEl) shortTodayEl.textContent = "…";

  try {
    const { data, error } = await supabaseClient.rpc("get_day_closing_breakdown", { p_date: dateStr });
    if (requestId !== dcBreakdownRequestId) return;
    if (error) throw error;
    dayClosingBreakdown = data;
  } catch (err) {
    if (requestId !== dcBreakdownRequestId) return;
    AppError.report(err, { context: "loadDayClosingBreakdown" });
    dayClosingBreakdown = null;
    if (totalSaleEl) totalSaleEl.textContent = "—";
    if (collectionEl) collectionEl.textContent = "—";
    if (shortPrevEl) shortPrevEl.textContent = "—";
    if (subtotalEl) subtotalEl.textContent = "—";
    if (creditTodayEl) creditTodayEl.textContent = "—";
    if (expensesTodayEl) expensesTodayEl.textContent = "—";
    if (shortTodayEl) shortTodayEl.textContent = "—";
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to load day closing breakdown.";
      errorEl.classList.remove("hidden");
    }
    return;
  }

  if (requestId !== dcBreakdownRequestId) return;

  const b = dayClosingBreakdown || {};
  const totalSale = Number(b.total_sale ?? 0);
  const collection = Number(b.collection ?? 0);
  const shortPrevious = Number(b.short_previous ?? 0);
  const creditToday = Number(b.credit_today ?? 0);
  const expensesToday = Number(b.expenses_today ?? 0);
  const subtotal = totalSale + collection + shortPrevious;

  if (totalSaleEl) totalSaleEl.textContent = formatCurrency(totalSale);
  if (collectionEl) collectionEl.textContent = formatCurrency(collection);
  if (shortPrevEl) shortPrevEl.textContent = formatCurrency(shortPrevious);
  if (subtotalEl) subtotalEl.textContent = formatCurrency(subtotal);
  if (creditTodayEl) creditTodayEl.textContent = formatCurrency(creditToday);
  if (expensesTodayEl) expensesTodayEl.textContent = formatCurrency(expensesToday);

  if (nightCashInput) {
    const v = b.night_cash;
    if (v != null && v !== "") nightCashInput.value = Number(v);
    else nightCashInput.value = "";
  }
  if (phonePayInput) {
    const v = b.phone_pay;
    if (v != null && v !== "") phonePayInput.value = Number(v);
    else phonePayInput.value = "";
  }

  const alreadySaved = !!b.already_saved;
  const canOverwrite = canOverwriteDayClosing(b);
  const saveBtn = document.getElementById("day-closing-save");
  const referenceLine = document.getElementById("dc-reference-line");
  const remarksInput = document.getElementById("dc-remarks");
  syncDayClosingSaveButton(saveBtn);
  syncDayClosingAlreadySavedNotice(b);
  if (referenceLine) {
    if (b.closing_reference) {
      referenceLine.textContent = "Reference: " + b.closing_reference + (b.remarks ? " · " + b.remarks : "");
      referenceLine.classList.remove("hidden");
    } else {
      referenceLine.classList.add("hidden");
    }
  }
  if (remarksInput) {
    remarksInput.value = b.remarks ?? "";
    remarksInput.disabled = alreadySaved && !canOverwrite;
  }
  const noActivityHint = document.getElementById("dc-no-activity-hint");
  if (noActivityHint) {
    const hasActivity = totalSale || collection || shortPrevious || creditToday || expensesToday;
    if (!hasActivity && !alreadySaved) {
      noActivityHint.classList.remove("hidden");
    } else {
      noActivityHint.classList.add("hidden");
    }
  }
  successEl?.classList.add("hidden");

  updateDayClosingShortLive();
}

function canOverwriteDayClosing(breakdown) {
  return !!(breakdown?.can_overwrite || (isAdmin && breakdown?.already_saved));
}

function syncDayClosingSaveButton(btn) {
  if (!btn) return;
  const alreadySaved = !!dayClosingBreakdown?.already_saved;
  const canOverwrite = canOverwriteDayClosing(dayClosingBreakdown);
  btn.disabled = alreadySaved && !canOverwrite;
  btn.textContent = canOverwrite ? "Save changes" : "Save day closing";
}

function syncDayClosingAlreadySavedNotice(breakdown) {
  const el = document.getElementById("day-closing-already-saved");
  if (!el) return;
  const alreadySaved = !!breakdown?.already_saved;
  const canOverwrite = canOverwriteDayClosing(breakdown);
  if (alreadySaved && !canOverwrite) {
    el.textContent = "Day closing already saved for this date.";
    el.classList.remove("hidden");
  } else if (canOverwrite) {
    el.textContent = "Day closing saved. You can update values and save again.";
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function updateDayClosingShortLive() {
  if (!dayClosingBreakdown) return;
  const nightCashInput = document.getElementById("dc-night-cash");
  const phonePayInput = document.getElementById("dc-phone-pay");
  const shortTodayEl = document.getElementById("dc-short-today");

  const totalSale = Number(dayClosingBreakdown.total_sale ?? 0);
  const collection = Number(dayClosingBreakdown.collection ?? 0);
  const shortPrevious = Number(dayClosingBreakdown.short_previous ?? 0);
  const creditToday = Number(dayClosingBreakdown.credit_today ?? 0);
  const expensesToday = Number(dayClosingBreakdown.expenses_today ?? 0);
  const nightCash = Number(nightCashInput?.value ?? 0) || 0;
  const phonePay = Number(phonePayInput?.value ?? 0) || 0;

  const shortToday = (totalSale + collection + shortPrevious) - (nightCash + phonePay + creditToday + expensesToday);
  if (shortTodayEl) {
    shortTodayEl.textContent = formatCurrency(shortToday);
    shortTodayEl.classList.remove("stat-positive", "stat-negative");
    if (shortToday > 0) shortTodayEl.classList.add("stat-positive");
    else if (shortToday < 0) shortTodayEl.classList.add("stat-negative");
  }
}

async function initializeDayClosing() {
  const dateInput = document.getElementById("day-closing-date");
  const form = document.getElementById("day-closing-form");
  const refreshBtn = document.getElementById("day-closing-refresh");
  const nightCashInput = document.getElementById("dc-night-cash");
  const phonePayInput = document.getElementById("dc-phone-pay");

  if (!dateInput || !form) return;

  const todayStr = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  resolveDayClosingDateInput(dateInput, todayStr);

  dateInput.addEventListener("change", () => {
    const dateStr = dateInput.value || todayStr;
    saveDayClosingDateFilter(dateStr);
    loadDayClosingBreakdown(dateStr);
  });

  const debouncedShortUpdate = debounce(updateDayClosingShortLive, 120);
  if (nightCashInput) {
    nightCashInput.addEventListener("input", debouncedShortUpdate);
    nightCashInput.addEventListener("change", updateDayClosingShortLive);
  }
  if (phonePayInput) {
    phonePayInput.addEventListener("input", debouncedShortUpdate);
    phonePayInput.addEventListener("change", updateDayClosingShortLive);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let alreadySavedHandled = false;
    const submitBtn = document.getElementById("day-closing-save");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    const successEl = document.getElementById("day-closing-success");
    const errorEl = document.getElementById("day-closing-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");

    const dateStr = dateInput.value?.trim();
    const nightCash = Number(document.getElementById("dc-night-cash")?.value ?? 0);
    const phonePay = Number(document.getElementById("dc-phone-pay")?.value ?? 0);
    const remarks = document.getElementById("dc-remarks")?.value?.trim() || null;
    if (!dateStr) {
      syncDayClosingSaveButton(submitBtn);
      if (errorEl) {
        errorEl.textContent = "Please select a date.";
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (dayClosingBreakdown?.already_saved && !canOverwriteDayClosing(dayClosingBreakdown)) {
      alreadySavedHandled = true;
      syncDayClosingSaveButton(submitBtn);
      syncDayClosingAlreadySavedNotice(dayClosingBreakdown);
      if (errorEl) errorEl.classList.add("hidden");
      return;
    }
    if (nightCash < 0 || phonePay < 0) {
      syncDayClosingSaveButton(submitBtn);
      if (errorEl) {
        errorEl.textContent = "Night cash and Phone pay must be ≥ 0.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    try {
      const { data, error } = await supabaseClient.rpc("save_day_closing", {
        p_date: dateStr,
        p_night_cash: nightCash,
        p_phone_pay: phonePay,
        p_remarks: remarks,
      });
      if (error) throw error;
      dayClosingBreakdown = data;
      updateDayClosingShortLive();
      if (successEl) {
        const refPart = data?.closing_reference ? " Reference: " + data.closing_reference + "." : "";
        const action = data?.overwritten ? "Day closing updated." : "Day closing saved.";
        successEl.classList.remove("hidden");
        successEl.textContent = action + refPart + " Today's short: " + formatCurrency(Number(data?.short_today ?? 0)) + " (stored for next day).";
      }
      const referenceLine = document.getElementById("dc-reference-line");
      if (referenceLine && data?.closing_reference) {
        referenceLine.textContent = "Reference: " + data.closing_reference + (data.remarks ? " · " + data.remarks : "");
        referenceLine.classList.remove("hidden");
      }
      if (errorEl) errorEl.classList.add("hidden");
      dateInput.value = dateStr;
      saveDayClosingDateFilter(dateStr);
      await loadDayClosingBreakdown(dateStr);
      // Invalidate cache so dashboard day-closing banners and data reflect immediately
      if (typeof CacheInvalidation !== "undefined") {
        CacheInvalidation.invalidate("operational");
      }
    } catch (err) {
      AppError.report(err, { context: "saveDayClosing" });
      const isAlreadySaved = err?.message && String(err.message).includes("already saved for this date");
      if (isAlreadySaved) {
        alreadySavedHandled = true;
        if (errorEl) errorEl.classList.add("hidden");
        const alreadySavedEl = document.getElementById("day-closing-already-saved");
        if (alreadySavedEl) alreadySavedEl.classList.remove("hidden");
        if (submitBtn) submitBtn.disabled = true;
        dayClosingBreakdown = { ...(dayClosingBreakdown || {}), already_saved: true, can_overwrite: isAdmin };
        await loadDayClosingBreakdown(dateStr);
      } else {
        if (errorEl) {
          errorEl.textContent = err?.message || "Failed to save day closing.";
          errorEl.classList.remove("hidden");
        }
      }
    } finally {
      if (submitBtn && !alreadySavedHandled) syncDayClosingSaveButton(submitBtn);
    }
  });

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadDayClosingBreakdown(dateInput.value || todayStr));
  }

  document.querySelector(".day-closing-breakdown")?.addEventListener("click", (event) => {
    const toggle = event.target.closest(".dc-breakdown-toggle");
    if (!toggle) return;
    const kind = toggle.closest("[data-breakdown]")?.dataset.breakdown;
    if (kind && DC_DETAIL_KINDS.includes(kind)) {
      toggleDayClosingDetail(kind);
    }
  });

  loadExpenseCategoryLabels().catch((err) => {
    AppError.report(err, { context: "loadExpenseCategoryLabels" });
  });

  await loadDayClosingBreakdown(dateInput.value || todayStr);

  // Day closing register: date range and load
  const registerStart = document.getElementById("dc-register-start");
  const registerEnd = document.getElementById("dc-register-end");
  const registerLoadBtn = document.getElementById("dc-register-load");
  const registerBody = document.getElementById("dc-register-body");
  if (registerStart && registerEnd && registerLoadBtn && registerBody) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    registerEnd.value = toLocalDateString(endDate);
    registerStart.value = toLocalDateString(startDate);

    registerLoadBtn.addEventListener("click", async () => {
      const start = registerStart.value?.trim();
      const end = registerEnd.value?.trim();
      if (!start || !end) return;
      registerLoadBtn.disabled = true;
      registerBody.innerHTML = `<tr><td colspan='${isAdmin ? 12 : 11}' class='muted'>Loading…</td></tr>`;
      try {
        const [{ data, error }, { data: latestRow }] = await Promise.all([
          supabaseClient
            .from("day_closing")
            .select("id, date, closing_reference, total_sale, collection, short_previous, credit_today, expenses_today, night_cash, phone_pay, short_today, remarks")
            .gte("date", start)
            .lte("date", end)
            .order("date", { ascending: false }),
          supabaseClient
            .from("day_closing")
            .select("date")
            .order("date", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);
        if (error) throw error;
        const colCount = isAdmin ? 12 : 11;
        if (!data?.length) {
          registerBody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No closing statements in this range.</td></tr>`;
          return;
        }
        const latestDate = latestRow?.date || null;
        registerBody.innerHTML = data.map((row) => {
          const d = row.date;
          const ref = row.closing_reference ?? "—";
          const fmtNum = (v) => formatCurrency(Number(v ?? 0));
          const canDelete = isAdmin && row.id && row.date === latestDate;
          const deleteBtn = canDelete
            ? AdminDelete.buttonHtml({
                selector: "dc-delete-btn",
                data: { id: row.id, date: d, ref },
                title: "Delete latest closing (admin)",
              })
            : isAdmin
              ? `<span class="muted" title="Only the most recent closing can be deleted">—</span>`
              : "";
          const actionsCell = isAdmin ? `<td class="table-actions">${deleteBtn}</td>` : "";
          return `<tr>
            <td>${d}</td>
            <td><code>${escapeHtml(ref)}</code></td>
            <td>${fmtNum(row.total_sale)}</td>
            <td>${fmtNum(row.collection)}</td>
            <td>${fmtNum(row.short_previous)}</td>
            <td>${fmtNum(row.credit_today)}</td>
            <td>${fmtNum(row.expenses_today)}</td>
            <td>${fmtNum(row.night_cash)}</td>
            <td>${fmtNum(row.phone_pay)}</td>
            <td>${fmtNum(row.short_today)}</td>
            <td>${escapeHtml(row.remarks ?? "—")}</td>
            ${actionsCell}
          </tr>`;
        }).join("");

        if (!registerBody.dataset.dcDeleteBound) {
          AdminDelete.bindOnce(registerBody, ".dc-delete-btn", (btn) => deleteDayClosing(btn, registerLoadBtn), "dcDeleteBound");
        }
      } catch (err) {
        AppError.report(err, { context: "loadDayClosingRegister" });
        const errColCount = isAdmin ? 12 : 11;
        registerBody.innerHTML = `<tr><td colspan='${errColCount}' class='error'>${escapeHtml(err?.message || "Failed to load.")}</td></tr>`;
      } finally {
        registerLoadBtn.disabled = false;
      }
    });
  }
}

async function deleteDayClosing(btn, reloadBtn) {
  const id = btn.dataset.id;
  const dateStr = btn.dataset.date || "";
  const ref = btn.dataset.ref || "";

  await AdminDelete.execute({
    btn,
    auth: isAdmin ? { role: "admin" } : null,
    actionLabel: "delete day closing records",
    confirmMessage: `Delete day closing for ${dateStr}${ref && ref !== "—" ? ` (${ref})` : ""}?\n\nOnly the latest closing can be removed so the day can be re-closed. This cannot be undone.`,
    deleteFn: () => supabaseClient.rpc("delete_day_closing", { p_id: id }),
    cacheScope: "operational",
    onSuccess: async () => {
      const dateInput = document.getElementById("day-closing-date");
      if (dateInput?.value === dateStr) {
        dayClosingBreakdown = null;
        await loadDayClosingBreakdown(dateStr);
      }
      if (reloadBtn) reloadBtn.click();
    },
    errorContext: { context: "deleteDayClosing", id },
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "day-closing",
  });
  if (!auth) return;
  isAdmin = auth.role === "admin";
  applyRoleVisibility(auth.role);

  const registerActionsHead = document.getElementById("dc-register-actions-head");
  if (registerActionsHead) registerActionsHead.hidden = !isAdmin;

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "close", validSections: ["close", "register"] });
  }

  await initializeDayClosing();
});
