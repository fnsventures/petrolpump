/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getLocalDateString, toLocalDateString, escapeHtml, AdminDelete, CacheInvalidation, initPersistedDateInput, savePersistedDate, PumpSettings, loadPumpSettings */

// Day closing & short: (Total sale + Collection + Short previous) − (Night cash + Phone pay + Credit + Expenses) = Today's short
let dayClosingBreakdown = null;
let isAdmin = false;
let dcBreakdownRequestId = 0;
let dcDetailsCache = { date: null, collection: null, credit: null, expenses: null };
let expenseCategoryLabels = null;
let dcDom = null;
const dcBreakdownEls = {};
const DC_LOADING = "…";
const DC_EMPTY = "—";

const DC_DETAIL_KINDS = ["collection", "credit", "expenses"];
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

function cacheDayClosingDom() {
  if (dcDom) return;
  dcDom = {
    dateInput: document.getElementById("day-closing-date"),
    form: document.getElementById("day-closing-form"),
    refreshBtn: document.getElementById("day-closing-refresh"),
    nightCashInput: document.getElementById("dc-night-cash"),
    phonePayInput: document.getElementById("dc-phone-pay"),
    remarksInput: document.getElementById("dc-remarks"),
    saveBtn: document.getElementById("day-closing-save"),
    referenceLine: document.getElementById("dc-reference-line"),
    noActivityHint: document.getElementById("dc-no-activity-hint"),
    successEl: document.getElementById("day-closing-success"),
    errorEl: document.getElementById("day-closing-error"),
    alreadySavedEl: document.getElementById("day-closing-already-saved"),
    totalSaleEl: document.getElementById("dc-total-sale"),
    collectionEl: document.getElementById("dc-collection"),
    shortPrevEl: document.getElementById("dc-short-previous"),
    subtotalEl: document.getElementById("dc-subtotal"),
    creditTodayEl: document.getElementById("dc-credit-today"),
    expensesTodayEl: document.getElementById("dc-expenses-today"),
    shortTodayEl: document.getElementById("dc-short-today"),
    shortStatusEl: document.getElementById("dc-short-status"),
    shortageAlertEl: document.getElementById("dc-shortage-alert"),
    shortageAlertMessageEl: document.getElementById("dc-shortage-alert-message"),
    resultCardEl: document.getElementById("dc-result-card"),
    registerStart: document.getElementById("dc-register-start"),
    registerEnd: document.getElementById("dc-register-end"),
    registerLoadBtn: document.getElementById("dc-register-load"),
    registerBody: document.getElementById("dc-register-body"),
    registerFoot: document.getElementById("dc-register-foot"),
    registerStatus: document.getElementById("dc-register-status"),
    registerSummary: document.getElementById("dc-register-summary"),
    registerPeriodStats: document.getElementById("dc-register-period-stats"),
    periodPhonePay: document.getElementById("dc-period-phone-pay"),
    periodExpenses: document.getElementById("dc-period-expenses"),
    periodCollection: document.getElementById("dc-period-collection"),
    periodNightCash: document.getElementById("dc-period-night-cash"),
    periodNightCashMeta: document.getElementById("dc-period-night-cash-meta"),
    nccAvailableTotal: document.getElementById("ncc-available-total"),
    nccAvailableDays: document.getElementById("ncc-available-days"),
    nccAvailableRange: document.getElementById("ncc-available-range"),
    nccFromDate: document.getElementById("ncc-from-date"),
    nccToDate: document.getElementById("ncc-to-date"),
    nccPreviewPanel: document.getElementById("ncc-preview-panel"),
    nccCollectBtn: document.getElementById("ncc-collect-btn"),
    nccCollectError: document.getElementById("ncc-collect-error"),
    nccCollectSuccess: document.getElementById("ncc-collect-success"),
    nccPreviewBtn: document.getElementById("ncc-preview-btn"),
    nccPreviewDays: document.getElementById("ncc-preview-days"),
    nccPreviewTotal: document.getElementById("ncc-preview-total"),
    nccPreviewRange: document.getElementById("ncc-preview-range"),
    nccPreviewWarnings: document.getElementById("ncc-preview-warnings"),
    nccPreviewBody: document.getElementById("ncc-preview-body"),
    nccRemarks: document.getElementById("ncc-remarks"),
    nccRegisterBody: document.getElementById("ncc-register-body"),
  };
  document.querySelectorAll(".dc-breakdown-group").forEach((group) => {
    const kind = group.dataset.breakdown;
    if (kind) {
      dcBreakdownEls[kind] = {
        toggle: group.querySelector(".dc-breakdown-toggle"),
        panel: group.querySelector(".dc-breakdown-details"),
      };
    }
  });
}

function getDcDetailElements(kind) {
  return dcBreakdownEls[kind] || { toggle: null, panel: null };
}

function updateShortDisplay(shortToday) {
  if (!dcDom?.shortTodayEl) return;
  const amount = Number(shortToday);
  const formatted = formatCurrency(amount);
  dcDom.shortTodayEl.textContent = formatted;

  const card = dcDom.resultCardEl;
  const statusEl = dcDom.shortStatusEl;
  const shortage = PumpSettings.isDayClosingShortage(amount);
  const surplus = PumpSettings.isDayClosingSurplus(amount);
  const threshold = PumpSettings.getAlertThresholds().dayClosingShortage;

  card?.classList.remove("dc-short--shortage");
  dcDom.shortTodayEl.classList.remove("dc-short--shortage", "stat-positive", "stat-negative");

  if (shortage) {
    card?.classList.add("dc-short--shortage");
    dcDom.shortTodayEl.classList.add("dc-short--shortage");
    if (statusEl) statusEl.textContent = "Still unaccounted — check night cash & PhonePe totals";
  } else if (surplus) {
    if (statusEl) statusEl.textContent = formatCurrency(Math.abs(amount)) + " over-accounted";
  } else {
    if (statusEl) statusEl.textContent = "Balanced — all money accounted for";
  }

  const alertEl = dcDom.shortageAlertEl;
  const alertMsgEl = dcDom.shortageAlertMessageEl;
  if (alertEl && alertMsgEl) {
    if (shortage && PumpSettings.getAlertThresholds().shortageAlert) {
      alertEl.classList.remove("hidden");
      alertMsgEl.textContent =
        threshold > 0
          ? `Short of ${formatted} exceeds your alert threshold (${formatCurrency(threshold)}). Check night cash & PhonePe totals.`
          : `Short of ${formatted} is still unaccounted. Check night cash & PhonePe totals.`;
    } else {
      alertEl.classList.add("hidden");
      alertMsgEl.textContent = "";
    }
  }
}

function setBreakdownAmounts(text) {
  if (!dcDom) return;
  dcDom.totalSaleEl && (dcDom.totalSaleEl.textContent = text);
  dcDom.collectionEl && (dcDom.collectionEl.textContent = text);
  dcDom.shortPrevEl && (dcDom.shortPrevEl.textContent = text);
  dcDom.subtotalEl && (dcDom.subtotalEl.textContent = text);
  dcDom.creditTodayEl && (dcDom.creditTodayEl.textContent = text);
  dcDom.expensesTodayEl && (dcDom.expensesTodayEl.textContent = text);
  dcDom.shortTodayEl && (dcDom.shortTodayEl.textContent = text);
  if (text === DC_LOADING || text === DC_EMPTY) {
    dcDom.shortStatusEl && (dcDom.shortStatusEl.textContent = "");
    dcDom.resultCardEl?.classList.remove("dc-short--shortage");
    dcDom.shortTodayEl?.classList.remove("dc-short--shortage", "stat-positive", "stat-negative");
    dcDom.shortageAlertEl?.classList.add("hidden");
    if (dcDom.shortageAlertMessageEl) dcDom.shortageAlertMessageEl.textContent = "";
  }
}

function collapseDayClosingDetails() {
  Object.values(dcBreakdownEls).forEach(({ toggle, panel }) => {
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

function renderDayClosingDetailTable(rows, columns, kind) {
  if (!rows.length) {
    return '<p class="muted">No entries for this date.</p>';
  }
  const showActions = isAdmin && (kind === "collection" || kind === "credit");
  const head = columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join("")
    + (showActions ? '<th class="table-actions">Actions</th>' : "");
  const body = rows.map((row) => {
    const cells = columns.map((col) => {
      const value = typeof col.format === "function" ? col.format(row) : (row[col.key] ?? "—");
      return `<td>${typeof value === "string" && col.escape !== false ? escapeHtml(String(value)) : value}</td>`;
    }).join("");
    let actions = "";
    if (showActions) {
      if (kind === "collection" && row.id) {
        actions = `<td class="table-actions">${AdminDelete.buttonHtml({
          selector: "dc-delete-payment",
          data: { paymentId: row.id, amount: String(row.amount ?? ""), date: row.date || "" },
          title: "Delete settlement (admin)",
        })}</td>`;
      } else if (kind === "credit" && row.id && !row.legacy) {
        actions = `<td class="table-actions">${AdminDelete.buttonHtml({
          selector: "dc-delete-credit",
          data: { entryId: row.id, amount: String(row.amount ?? ""), date: row.date || "" },
          title: "Delete credit sale (admin)",
        })}</td>`;
      } else {
        actions = '<td class="table-actions muted">—</td>';
      }
    }
    return `<tr>${cells}${actions}</tr>`;
  }).join("");
  return `<table class="dc-breakdown-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function fetchCollectionDetails(dateStr) {
  const { data, error } = await supabaseClient
    .from("credit_payments")
    .select("id, amount, payment_mode, date, credit_customers(customer_name)")
    .eq("date", dateStr)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id ?? null,
    date: row.date || dateStr,
    customer: row.credit_customers?.customer_name || "—",
    mode: row.payment_mode || "—",
    amount: Number(row.amount ?? 0),
  }));
}

async function fetchCreditTodayDetails(dateStr) {
  const [entriesRes, legacyRes] = await Promise.all([
    supabaseClient
      .from("credit_entries")
      .select("id, credit_customer_id, amount, fuel_type, quantity, transaction_date, credit_customers(customer_name)")
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
    id: row.id ?? null,
    date: row.transaction_date || dateStr,
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
    const html = renderDayClosingDetailTable(rows, DC_DETAIL_COLUMNS[kind], kind);
    dcDetailsCache.date = dateStr;
    dcDetailsCache[kind] = html;
    panel.innerHTML = html;
  } catch (err) {
    AppError.report(err, { context: `loadDayClosingDetail:${kind}` });
    panel.innerHTML = `<p class="error">${escapeHtml(err?.message || "Failed to load details.")}</p>`;
  }
}

async function toggleDayClosingDetail(kind) {
  const dateStr = dcDom?.dateInput?.value?.trim();
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
  if (!dateStr || !dcDom?.dateInput) return;

  if (dcDom.dateInput.value !== dateStr) dcDom.dateInput.value = dateStr;

  const requestId = ++dcBreakdownRequestId;
  refreshDayClosingDetailsState(dateStr).catch((err) => {
    AppError.report(err, { context: "refreshDayClosingDetailsState" });
  });

  dcDom.successEl?.classList.add("hidden");
  dcDom.errorEl?.classList.add("hidden");
  setBreakdownAmounts(DC_LOADING);

  try {
    const { data, error } = await supabaseClient.rpc("get_day_closing_breakdown", { p_date: dateStr });
    if (requestId !== dcBreakdownRequestId) return;
    if (error) throw error;
    dayClosingBreakdown = data;
  } catch (err) {
    if (requestId !== dcBreakdownRequestId) return;
    AppError.report(err, { context: "loadDayClosingBreakdown" });
    dayClosingBreakdown = null;
    setBreakdownAmounts(DC_EMPTY);
    if (dcDom.errorEl) {
      dcDom.errorEl.textContent = err?.message || "Failed to load day closing breakdown.";
      dcDom.errorEl.classList.remove("hidden");
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

  if (dcDom.totalSaleEl) dcDom.totalSaleEl.textContent = formatCurrency(totalSale);
  if (dcDom.collectionEl) dcDom.collectionEl.textContent = formatCurrency(collection);
  if (dcDom.shortPrevEl) dcDom.shortPrevEl.textContent = formatCurrency(shortPrevious);
  if (dcDom.subtotalEl) dcDom.subtotalEl.textContent = formatCurrency(subtotal);
  if (dcDom.creditTodayEl) dcDom.creditTodayEl.textContent = formatCurrency(creditToday);
  if (dcDom.expensesTodayEl) dcDom.expensesTodayEl.textContent = formatCurrency(expensesToday);

  for (const [input, key] of [[dcDom.nightCashInput, "night_cash"], [dcDom.phonePayInput, "phone_pay"]]) {
    if (!input) continue;
    const v = b[key];
    input.value = v != null && v !== "" ? Number(v) : "";
  }

  const alreadySaved = !!b.already_saved;
  const canOverwrite = canOverwriteDayClosing(b);
  syncDayClosingSaveButton(dcDom.saveBtn);
  syncDayClosingAlreadySavedNotice(b);
  if (dcDom.referenceLine) {
    if (b.closing_reference) {
      dcDom.referenceLine.textContent = "Reference: " + b.closing_reference + (b.remarks ? " · " + b.remarks : "");
      dcDom.referenceLine.classList.remove("hidden");
    } else {
      dcDom.referenceLine.classList.add("hidden");
    }
  }
  if (dcDom.remarksInput) {
    dcDom.remarksInput.value = b.remarks ?? "";
    dcDom.remarksInput.disabled = alreadySaved && !canOverwrite;
  }
  if (dcDom.nightCashInput) dcDom.nightCashInput.disabled = alreadySaved && !canOverwrite;
  if (dcDom.phonePayInput) dcDom.phonePayInput.disabled = alreadySaved && !canOverwrite;
  if (dcDom.noActivityHint) {
    const hasActivity = totalSale || collection || shortPrevious || creditToday || expensesToday;
    dcDom.noActivityHint.classList.toggle("hidden", hasActivity || alreadySaved);
  }
  dcDom.successEl?.classList.add("hidden");

  if (!canOverwrite && alreadySaved && b.short_today != null) {
    updateShortDisplay(Number(b.short_today));
  } else {
    updateDayClosingShortLive();
  }
}

function canOverwriteDayClosing(breakdown) {
  return !!breakdown?.can_overwrite;
}

function syncDayClosingSaveButton(btn) {
  if (!btn) return;
  const alreadySaved = !!dayClosingBreakdown?.already_saved;
  const canOverwrite = canOverwriteDayClosing(dayClosingBreakdown);
  btn.disabled = alreadySaved && !canOverwrite;
  btn.textContent = canOverwrite ? "Save changes" : "Save day closing";
}

function syncDayClosingAlreadySavedNotice(breakdown) {
  const el = dcDom?.alreadySavedEl;
  if (!el) return;
  const alreadySaved = !!breakdown?.already_saved;
  const canOverwrite = canOverwriteDayClosing(breakdown);
  if (breakdown?.night_cash_collected && !canOverwrite) {
    const ref = breakdown.night_cash_collection_reference || "collection";
    el.textContent = `Night cash collected (${ref}). Locked for supervisors — only an admin can modify this day closing.`;
    el.classList.remove("hidden");
  } else if (canOverwrite) {
    el.textContent = breakdown?.night_cash_collected
      ? "Night cash collected. As admin you can still update values and save again."
      : "Day closing saved. You can update values and save again.";
    el.classList.remove("hidden");
  } else if (alreadySaved) {
    el.textContent = "Day closing already saved for this date.";
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function updateDayClosingShortLive() {
  if (!dayClosingBreakdown || !dcDom) return;

  const totalSale = Number(dayClosingBreakdown.total_sale ?? 0);
  const collection = Number(dayClosingBreakdown.collection ?? 0);
  const shortPrevious = Number(dayClosingBreakdown.short_previous ?? 0);
  const creditToday = Number(dayClosingBreakdown.credit_today ?? 0);
  const expensesToday = Number(dayClosingBreakdown.expenses_today ?? 0);
  const nightCash = Number(dcDom.nightCashInput?.value ?? 0) || 0;
  const phonePay = Number(dcDom.phonePayInput?.value ?? 0) || 0;

  const shortToday = (totalSale + collection + shortPrevious) - (nightCash + phonePay + creditToday + expensesToday);
  updateShortDisplay(shortToday);
}

async function initializeDayClosing() {
  cacheDayClosingDom();
  const { dateInput, form, refreshBtn, nightCashInput, phonePayInput } = dcDom;
  if (!dateInput || !form) return;

  const todayStr = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  const dateStr = initPersistedDateInput(dateInput, "day_closing_close", {
    urlParam: "date",
    fallback: todayStr,
    onChange: (value) => loadDayClosingBreakdown(value),
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
    const submitBtn = dcDom.saveBtn;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    dcDom.successEl?.classList.add("hidden");
    dcDom.errorEl?.classList.add("hidden");

    const dateStr = dateInput.value?.trim();
    const nightCash = Number(nightCashInput?.value ?? 0);
    const phonePay = Number(phonePayInput?.value ?? 0);
    const remarks = dcDom.remarksInput?.value?.trim() || null;
    if (!dateStr) {
      syncDayClosingSaveButton(submitBtn);
      if (dcDom.errorEl) {
        dcDom.errorEl.textContent = "Please select a date.";
        dcDom.errorEl.classList.remove("hidden");
      }
      return;
    }
    if (dayClosingBreakdown?.already_saved && !canOverwriteDayClosing(dayClosingBreakdown)) {
      alreadySavedHandled = true;
      syncDayClosingSaveButton(submitBtn);
      syncDayClosingAlreadySavedNotice(dayClosingBreakdown);
      dcDom.errorEl?.classList.add("hidden");
      return;
    }
    if (nightCash < 0 || phonePay < 0) {
      syncDayClosingSaveButton(submitBtn);
      if (dcDom.errorEl) {
        dcDom.errorEl.textContent = "Night cash and Phone pay must be ≥ 0.";
        dcDom.errorEl.classList.remove("hidden");
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
      if (dcDom.successEl) {
        const refPart = data?.closing_reference ? " Reference: " + data.closing_reference + "." : "";
        const action = data?.overwritten ? "Day closing updated." : "Day closing saved.";
        dcDom.successEl.classList.remove("hidden");
        dcDom.successEl.textContent = action + refPart + " Today's short: " + formatCurrency(Number(data?.short_today ?? 0)) + " (stored for next day).";
      }
      if (dcDom.referenceLine && data?.closing_reference) {
        dcDom.referenceLine.textContent = "Reference: " + data.closing_reference + (data.remarks ? " · " + data.remarks : "");
        dcDom.referenceLine.classList.remove("hidden");
      }
      dcDom.errorEl?.classList.add("hidden");
      dateInput.value = dateStr;
      savePersistedDate("day_closing_close", dateStr);
      await loadDayClosingBreakdown(dateStr);
      // Invalidate cache so dashboard day-closing banners and data reflect immediately
      if (typeof CacheInvalidation !== "undefined") {
        CacheInvalidation.invalidate("operational");
      }
    } catch (err) {
      AppError.report(err, { context: "saveDayClosing" });
      const isLocked = err?.message && String(err.message).includes("locked");
      if (isLocked) {
        alreadySavedHandled = true;
        dcDom.errorEl?.classList.add("hidden");
        await loadDayClosingBreakdown(dateStr);
      } else if (dcDom.errorEl) {
        dcDom.errorEl.textContent = err?.message || "Failed to save day closing.";
        dcDom.errorEl.classList.remove("hidden");
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

  initDayClosingCreditDeleteHandlers();

  window.addEventListener("storage", (e) => {
    if (e.key !== "credit-updated" && e.key !== "expenses-updated") return;
    const dateStr = dateInput.value?.trim();
    if (!dateStr) return;
    dcDetailsCache = { date: dateStr, collection: null, credit: null, expenses: null };
    loadDayClosingBreakdown(dateStr).catch((err) => {
      AppError.report(err, { context: "operationalUpdatedRefreshDayClosing" });
    });
  });

  loadExpenseCategoryLabels().catch((err) => {
    AppError.report(err, { context: "loadExpenseCategoryLabels" });
  });

  await loadDayClosingBreakdown(dateInput.value || todayStr);
}

function broadcastCreditUpdated() {
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
}

function initDayClosingCreditDeleteHandlers() {
  if (!isAdmin || document.body.dataset.dcCreditDeleteBound) return;
  document.body.dataset.dcCreditDeleteBound = "1";

  document.addEventListener("click", async (e) => {
    const paymentBtn = e.target.closest?.(".dc-delete-payment");
    const creditBtn = e.target.closest?.(".dc-delete-credit");
    const btn = paymentBtn || creditBtn;
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const dateInput = dcDom?.dateInput;
    const dateStr = dateInput?.value?.trim() || "";

    if (paymentBtn) {
      const paymentId = btn.getAttribute("data-payment-id");
      if (!paymentId) return;
      await deleteDayClosingPayment(paymentId, btn, dateStr);
      return;
    }

    const entryId = btn.getAttribute("data-entry-id");
    if (!entryId) return;
    await deleteDayClosingCreditEntry(entryId, btn, dateStr);
  });
}

async function afterDcCreditRelatedDelete(detailKind, dateStr) {
  if (typeof CacheInvalidation !== "undefined") {
    CacheInvalidation.invalidate("credit");
  }
  broadcastCreditUpdated();
  dcDetailsCache.collection = null;
  dcDetailsCache.credit = null;
  if (!dateStr) return;
  await loadDayClosingBreakdown(dateStr);
  const { toggle } = getDcDetailElements(detailKind);
  if (toggle?.getAttribute("aria-expanded") === "true") {
    await loadDayClosingDetail(detailKind, dateStr);
  }
}

async function deleteDayClosingPayment(paymentId, btn, dateStr) {
  const amount = Number(btn?.dataset?.amount || 0);
  const dateLabel = btn?.dataset?.date || dateStr || "this date";

  await AdminDelete.execute({
    btn,
    auth: isAdmin ? { role: "admin" } : null,
    actionLabel: "delete credit settlements",
    confirmMessage: `Delete settlement of ${formatCurrency(amount)} on ${dateLabel}?\n\nIt will be removed from collection, day closing, and short. This cannot be undone.`,
    deleteFn: () => supabaseClient.rpc("delete_credit_payment", { p_payment_id: paymentId }),
    cacheScope: "operational",
    onSuccess: () => afterDcCreditRelatedDelete("collection", dateStr),
    errorContext: { context: "deleteDayClosingPayment", paymentId },
  });
}

async function deleteDayClosingCreditEntry(entryId, btn, dateStr) {
  const amount = Number(btn?.dataset?.amount || 0);
  const dateLabel = btn?.dataset?.date || dateStr || "this date";

  await AdminDelete.execute({
    btn,
    auth: isAdmin ? { role: "admin" } : null,
    actionLabel: "delete credit entries",
    confirmMessage: `Delete credit sale of ${formatCurrency(amount)} on ${dateLabel}?\n\nIt will be removed from credit today, day closing, and short. This cannot be undone.`,
    deleteFn: () => supabaseClient.rpc("delete_credit_entry", { p_entry_id: entryId }),
    cacheScope: "operational",
    onSuccess: () => afterDcCreditRelatedDelete("credit", dateStr),
    errorContext: { context: "deleteDayClosingCreditEntry", entryId },
  });
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
      if (dcDom?.dateInput?.value === dateStr) {
        dayClosingBreakdown = null;
        await loadDayClosingBreakdown(dateStr);
      }
      if (isRegisterSectionActive()) await loadDayClosingRegister();
    },
    errorContext: { context: "deleteDayClosing", id },
  });
}

let nccPreviewData = null;
let nccAvailableData = null;
let registerLoadedOnce = false;

function fmtNum(value) {
  if (value == null || value === "") return "—";
  return formatCurrency(Number(value));
}

function amtCell(value, extraClass = "") {
  const cls = ["col-amount", extraClass].filter(Boolean).join(" ");
  return `<td class="${cls}">${fmtNum(value)}</td>`;
}

function renderNightCashStatus(isCollected, collectedRef) {
  if (!isCollected) {
    return '<span class="dc-status-badge dc-status-badge--pending">At pump</span>';
  }
  const ref = collectedRef ? escapeHtml(collectedRef) : "";
  return `<span class="dc-status-badge dc-status-badge--collected">Collected</span>${ref ? `<span class="dc-status-ref">${ref}</span>` : ""}`;
}

function formatNightCashMeta(pendingNightCash, collectedNightCash, pendingCount, collectedCount) {
  const parts = [];
  if (pendingCount) parts.push(`${formatCurrency(pendingNightCash)} at pump (${pendingCount})`);
  if (collectedCount) parts.push(`${formatCurrency(collectedNightCash)} collected (${collectedCount})`);
  return parts.length ? parts.join(" · ") : "No night cash in range";
}

function updateRegisterPeriodStats({
  totalPhonePay = 0,
  totalExpenses = 0,
  totalCollection = 0,
  totalNightCash = 0,
  pendingNightCash = 0,
  collectedNightCash = 0,
  pendingCount = 0,
  collectedCount = 0,
  visible = false,
} = {}) {
  const {
    registerPeriodStats: statsEl,
    periodPhonePay,
    periodExpenses,
    periodCollection,
    periodNightCash,
    periodNightCashMeta,
  } = dcDom || {};

  if (!statsEl) return;

  if (!visible) {
    statsEl.classList.add("hidden");
    return;
  }

  statsEl.classList.remove("hidden");
  if (periodPhonePay) periodPhonePay.textContent = fmtNum(totalPhonePay);
  if (periodExpenses) periodExpenses.textContent = fmtNum(totalExpenses);
  if (periodCollection) periodCollection.textContent = fmtNum(totalCollection);
  if (periodNightCash) periodNightCash.textContent = fmtNum(totalNightCash);
  if (periodNightCashMeta) {
    periodNightCashMeta.textContent = formatNightCashMeta(
      pendingNightCash,
      collectedNightCash,
      pendingCount,
      collectedCount
    );
  }
}

async function loadNightCashAvailable() {
  const { nccAvailableTotal: totalEl, nccAvailableDays: daysEl, nccAvailableRange: rangeEl } = dcDom || {};
  if (!totalEl) return null;

  try {
    const { data, error } = await supabaseClient.rpc("get_night_cash_available");
    if (error) throw error;
    nccAvailableData = data;

    const total = Number(data?.total_available ?? 0);
    const count = Number(data?.day_count ?? 0);
    totalEl.textContent = fmtNum(total);
    daysEl.textContent = count ? String(count) : "0";
    if (data?.from_date && data?.to_date) {
      rangeEl.textContent = `${formatDisplayDate(data.from_date)} – ${formatDisplayDate(data.to_date)}`;
    } else {
      rangeEl.textContent = count ? "—" : "None pending";
    }

    return data;
  } catch (err) {
    AppError.report(err, { context: "loadNightCashAvailable" });
    nccAvailableData = null;
    totalEl.textContent = "—";
    if (daysEl) daysEl.textContent = "—";
    if (rangeEl) rangeEl.textContent = "Failed to load";
    return null;
  }
}

function applyNightCashCollectRange({ onlyIfEmpty = false, showError = false } = {}) {
  const { nccFromDate: fromInput, nccToDate: toInput, nccCollectError: errorEl, nccPreviewPanel: panel, nccCollectBtn: collectBtn } = dcDom || {};
  if (!fromInput || !toInput) return false;
  if (onlyIfEmpty && (fromInput.value || toInput.value)) return false;
  if (!nccAvailableData?.from_date || !nccAvailableData?.to_date || !Number(nccAvailableData?.day_count)) {
    if (showError && errorEl) {
      errorEl.textContent = "No uncollected night cash to fill.";
      errorEl.classList.remove("hidden");
    }
    return false;
  }
  errorEl?.classList.add("hidden");
  fromInput.value = nccAvailableData.from_date;
  toInput.value = nccAvailableData.to_date;
  panel?.classList.add("hidden");
  nccPreviewData = null;
  if (collectBtn) collectBtn.disabled = true;
  return true;
}

function fillNightCashCollectRange() {
  applyNightCashCollectRange({ showError: true });
}

async function loadNightCashCollectionRegister() {
  const body = dcDom?.nccRegisterBody;
  if (!body) return;

  body.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try {
    const { data, error } = await supabaseClient
      .from("night_cash_collections")
      .select("collection_reference, from_date, to_date, day_count, total_amount, collected_at, remarks")
      .order("collected_at", { ascending: false });
    if (error) throw error;

    if (!data?.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">No collections recorded yet.</td></tr>';
      return;
    }

    body.innerHTML = data.map((row) => {
      const collectedAt = row.collected_at
        ? new Date(row.collected_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
        : "—";
      return `<tr>
        <td><code>${escapeHtml(row.collection_reference || "—")}</code></td>
        <td>${escapeHtml(formatDisplayDate(row.from_date))}</td>
        <td>${escapeHtml(formatDisplayDate(row.to_date))}</td>
        <td class="col-num">${row.day_count ?? "—"}</td>
        ${amtCell(row.total_amount)}
        <td>${escapeHtml(collectedAt)}</td>
        <td>${escapeHtml(row.remarks || "—")}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    AppError.report(err, { context: "loadNightCashCollectionRegister" });
    body.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(err?.message || "Failed to load register.")}</td></tr>`;
  }
}

async function previewNightCashCollection() {
  if (!isAdmin) return;

  const {
    nccFromDate: fromInput,
    nccToDate: toInput,
    nccPreviewBtn: previewBtn,
    nccPreviewPanel: panel,
    nccCollectError: errorEl,
    nccCollectBtn: collectBtn,
    nccPreviewDays: previewDaysEl,
    nccPreviewTotal: previewTotalEl,
    nccPreviewRange: rangeEl,
    nccPreviewWarnings: warningsEl,
    nccPreviewBody: previewBody,
  } = dcDom || {};
  const from = fromInput?.value?.trim();
  const to = toInput?.value?.trim();

  errorEl?.classList.add("hidden");
  nccPreviewData = null;
  if (collectBtn) collectBtn.disabled = true;

  if (!from || !to) {
    if (errorEl) {
      errorEl.textContent = "Select both from and to dates.";
      errorEl.classList.remove("hidden");
    }
    panel?.classList.add("hidden");
    return;
  }
  if (from > to) {
    if (errorEl) {
      errorEl.textContent = "From date must be on or before to date.";
      errorEl.classList.remove("hidden");
    }
    panel?.classList.add("hidden");
    return;
  }

  if (previewBtn) {
    previewBtn.disabled = true;
    previewBtn.textContent = "Loading…";
  }

  try {
    const { data, error } = await supabaseClient.rpc("preview_night_cash_collection", {
      p_from_date: from,
      p_to_date: to,
    });
    if (error) throw error;
    nccPreviewData = data;

    const days = Array.isArray(data?.days) ? data.days : [];
    const dayCount = Number(data?.day_count ?? 0);
    const total = Number(data?.total_amount ?? 0);

    if (previewDaysEl) previewDaysEl.textContent = String(dayCount);
    if (previewTotalEl) previewTotalEl.textContent = fmtNum(total);

    if (rangeEl) {
      rangeEl.textContent = `${formatDisplayDate(from)} – ${formatDisplayDate(to)}`;
    }

    const warnings = [];
    const missing = Number(data?.missing_closing_count ?? 0);
    const alreadyCollected = Number(data?.already_collected_count ?? 0);
    if (missing > 0) warnings.push(`${missing} day(s) in range have no day closing and will be skipped.`);
    if (alreadyCollected > 0) warnings.push(`${alreadyCollected} day(s) in range were already collected and are excluded.`);

    if (warningsEl) {
      if (warnings.length) {
        warningsEl.textContent = warnings.join(" ");
        warningsEl.classList.remove("hidden");
      } else {
        warningsEl.classList.add("hidden");
      }
    }

    if (previewBody) {
      previewBody.innerHTML = days.length
        ? days.map((row) => `<tr>
          <td>${escapeHtml(formatDisplayDate(row.date))}</td>
          <td><code>${escapeHtml(row.closing_reference || "—")}</code></td>
          ${amtCell(row.night_cash)}
        </tr>`).join("")
        : '<tr><td colspan="3" class="muted">No uncollected day closings in this range.</td></tr>';
    }

    panel?.classList.remove("hidden");
    if (collectBtn && isAdmin) collectBtn.disabled = dayCount === 0;
  } catch (err) {
    AppError.report(err, { context: "previewNightCashCollection" });
    panel?.classList.add("hidden");
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to preview collection.";
      errorEl.classList.remove("hidden");
    }
  } finally {
    if (previewBtn) {
      previewBtn.disabled = false;
      previewBtn.textContent = "Preview collection";
    }
  }
}

async function recordNightCashCollection(e) {
  e.preventDefault();
  if (!isAdmin) return;

  const {
    nccFromDate: fromInput,
    nccToDate: toInput,
    nccRemarks: remarksInput,
    nccCollectBtn: collectBtn,
    nccCollectSuccess: successEl,
    nccCollectError: errorEl,
    nccPreviewPanel: panel,
    dateInput,
  } = dcDom || {};
  const from = fromInput?.value?.trim();
  const to = toInput?.value?.trim();
  const remarks = remarksInput?.value?.trim() || null;

  if (!nccPreviewData || Number(nccPreviewData.day_count ?? 0) === 0) {
    await previewNightCashCollection();
    if (!nccPreviewData || Number(nccPreviewData.day_count ?? 0) === 0) return;
  }

  const total = Number(nccPreviewData.total_amount ?? 0);
  const dayCount = Number(nccPreviewData.day_count ?? 0);
  const confirmed = window.confirm(
    `Record collection of ${formatCurrency(total)} for ${dayCount} day(s) (${formatDisplayDate(from)} to ${formatDisplayDate(to)})?\n\nSupervisors will no longer be able to edit those day closings. Admins can still modify them.`
  );
  if (!confirmed) return;

  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");
  if (collectBtn) {
    collectBtn.disabled = true;
    collectBtn.textContent = "Recording…";
  }

  try {
    const { data, error } = await supabaseClient.rpc("collect_night_cash", {
      p_from_date: from,
      p_to_date: to,
      p_remarks: remarks,
    });
    if (error) throw error;

    if (successEl) {
      successEl.textContent = `Collection recorded: ${data?.collection_reference || "OK"} · ${formatCurrency(data?.total_amount ?? total)} for ${data?.day_count ?? dayCount} day(s). Those days are locked for supervisors.`;
      successEl.classList.remove("hidden");
    }

    nccPreviewData = null;
    panel?.classList.add("hidden");
    if (remarksInput) remarksInput.value = "";
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";

    registerLoadedOnce = true;
    await refreshRegisterPanel();

    if (dateInput?.value) await loadDayClosingBreakdown(dateInput.value);
  } catch (err) {
    AppError.report(err, { context: "recordNightCashCollection" });
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to record collection.";
      errorEl.classList.remove("hidden");
    }
  } finally {
    if (collectBtn) {
      collectBtn.textContent = "Record collection";
      collectBtn.disabled = !nccPreviewData || Number(nccPreviewData.day_count ?? 0) === 0;
    }
  }
}

function initNightCashCollection() {
  const { nccPreviewBtn: previewBtn } = dcDom || {};
  const form = document.getElementById("ncc-collect-form");
  const fillBtn = document.getElementById("ncc-fill-range-btn");
  if (!previewBtn && !form) return;

  previewBtn?.addEventListener("click", () => previewNightCashCollection());
  fillBtn?.addEventListener("click", fillNightCashCollectRange);
  form?.addEventListener("submit", recordNightCashCollection);
}

async function refreshRegisterPanel() {
  await loadRegisterNightCashData({ alsoLoadClosings: true });
}

function isRegisterSectionActive() {
  return (location.hash || "").replace(/^#/, "") === "register";
}

async function loadRegisterNightCashData({ alsoLoadClosings = false } = {}) {
  const start = dcDom?.registerStart?.value?.trim();
  const end = dcDom?.registerEnd?.value?.trim();
  const tasks = [loadNightCashAvailable(), loadNightCashCollectionRegister()];

  if (alsoLoadClosings) {
    registerLoadedOnce = true;
    if (start && end) tasks.push(loadDayClosingRegister());
  }

  await Promise.all(tasks);
  applyNightCashCollectRange({ onlyIfEmpty: true });
}

async function onRegisterSectionShown() {
  await loadRegisterNightCashData({ alsoLoadClosings: true });
}

async function loadDayClosingRegister() {
  const {
    registerStart,
    registerEnd,
    registerLoadBtn,
    registerBody,
    registerFoot,
    registerStatus: statusFilter,
    registerSummary: summaryEl,
  } = dcDom || {};
  if (!registerStart || !registerEnd || !registerBody) return;

  const start = registerStart.value?.trim();
  const end = registerEnd.value?.trim();
  if (!start || !end) {
    if (summaryEl) summaryEl.textContent = "Select a date range and load.";
    return;
  }

  const colCount = isAdmin ? 13 : 12;
  if (registerLoadBtn) registerLoadBtn.disabled = true;
  registerBody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>Loading…</td></tr>`;
  if (registerFoot) registerFoot.hidden = true;

  try {
    const status = statusFilter?.value || "all";
    let closingsQuery = supabaseClient
      .from("day_closing")
      .select("id, date, closing_reference, total_sale, collection, short_previous, credit_today, expenses_today, night_cash, phone_pay, short_today, remarks, night_cash_collection_id, night_cash_collections(collection_reference)")
      .gte("date", start)
      .lte("date", end);
    if (status === "pending") {
      closingsQuery = closingsQuery.is("night_cash_collection_id", null);
    } else if (status === "collected") {
      closingsQuery = closingsQuery.not("night_cash_collection_id", "is", null);
    }

    const latestQuery = isAdmin
      ? supabaseClient
          .from("day_closing")
          .select("date")
          .order("date", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null });

    const [{ data, error }, { data: latestRow }] = await Promise.all([
      closingsQuery.order("date", { ascending: false }),
      latestQuery,
    ]);
    if (error) throw error;

    const rows = data || [];

    if (!rows.length) {
      registerBody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>No closing statements match this filter.</td></tr>`;
      if (registerFoot) registerFoot.hidden = true;
      updateRegisterPeriodStats({ visible: false });
      if (summaryEl) {
        summaryEl.textContent = `No rows for ${formatDisplayDate(start)} – ${formatDisplayDate(end)} (${status === "all" ? "all" : status}).`;
      }
      return;
    }

    const latestDate = latestRow?.date || null;
    const totals = {
      pendingNightCash: 0,
      collectedNightCash: 0,
      pendingCount: 0,
      collectedCount: 0,
      totalCollection: 0,
      totalCredit: 0,
      totalExpenses: 0,
      totalNightCash: 0,
      totalPhonePay: 0,
    };
    const htmlRows = [];

    for (const row of rows) {
      const d = row.date;
      const ref = row.closing_reference ?? "—";
      const collectedRef = row.night_cash_collections?.collection_reference;
      const isCollected = !!row.night_cash_collection_id;
      const nightCashAmt = Number(row.night_cash ?? 0);

      totals.totalCollection += Number(row.collection ?? 0);
      totals.totalCredit += Number(row.credit_today ?? 0);
      totals.totalExpenses += Number(row.expenses_today ?? 0);
      totals.totalNightCash += nightCashAmt;
      totals.totalPhonePay += Number(row.phone_pay ?? 0);

      if (isCollected) {
        totals.collectedNightCash += nightCashAmt;
        totals.collectedCount += 1;
      } else {
        totals.pendingNightCash += nightCashAmt;
        totals.pendingCount += 1;
      }

      const canDelete = isAdmin && row.id && row.date === latestDate && !isCollected;
      const deleteBtn = canDelete
        ? AdminDelete.buttonHtml({
            selector: "dc-delete-btn",
            data: { id: row.id, date: d, ref },
            title: "Delete latest closing (admin)",
          })
        : isAdmin
          ? `<span class="muted" title="${isCollected ? `Night cash collected (${collectedRef || "locked"})` : "Only the most recent closing can be deleted"}">—</span>`
          : "";
      const actionsCell = isAdmin ? `<td class="table-actions">${deleteBtn}</td>` : "";

      htmlRows.push(`<tr>
        <td class="col-sticky">${escapeHtml(formatDisplayDate(d))}</td>
        <td class="col-ref"><code>${escapeHtml(ref)}</code></td>
        ${amtCell(row.collection, "col-key")}
        ${amtCell(row.credit_today, "col-key")}
        ${amtCell(row.expenses_today, "col-key")}
        ${amtCell(row.night_cash, "col-key")}
        ${amtCell(row.phone_pay, "col-key")}
        ${amtCell(row.total_sale, "col-split-start col-secondary")}
        ${amtCell(row.short_previous, "col-secondary")}
        ${amtCell(row.short_today, "col-secondary")}
        <td class="col-secondary">${renderNightCashStatus(isCollected, collectedRef)}</td>
        <td class="col-secondary">${escapeHtml(row.remarks ?? "—")}</td>
        ${actionsCell}
      </tr>`);
    }

    registerBody.innerHTML = htmlRows.join("");

    if (registerFoot) {
      const actionsFoot = isAdmin ? '<td class="table-actions"></td>' : "";
      registerFoot.innerHTML = `<tr class="dc-register-totals">
        <td class="col-sticky" colspan="2"><strong>Total</strong></td>
        ${amtCell(totals.totalCollection, "col-key")}
        ${amtCell(totals.totalCredit, "col-key")}
        ${amtCell(totals.totalExpenses, "col-key")}
        ${amtCell(totals.totalNightCash, "col-key")}
        ${amtCell(totals.totalPhonePay, "col-key")}
        <td class="col-split-start col-secondary" colspan="5"></td>
        ${actionsFoot}
      </tr>`;
      registerFoot.hidden = false;
    }

    updateRegisterPeriodStats({ ...totals, visible: true });

    if (summaryEl) {
      const parts = [
        `${rows.length} closing${rows.length === 1 ? "" : "s"}`,
        `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`,
      ];
      if (status !== "all") parts.push(status === "pending" ? "at pump only" : "collected only");
      summaryEl.textContent = parts.join(" · ");
    }

    if (!registerBody.dataset.dcDeleteBound) {
      AdminDelete.bindOnce(
        registerBody,
        ".dc-delete-btn",
        (btn) => deleteDayClosing(btn, registerLoadBtn),
        "dcDeleteBound"
      );
    }
  } catch (err) {
    AppError.report(err, { context: "loadDayClosingRegister" });
    registerBody.innerHTML = `<tr><td colspan='${colCount}' class='error'>${escapeHtml(err?.message || "Failed to load.")}</td></tr>`;
    if (registerFoot) registerFoot.hidden = true;
    updateRegisterPeriodStats({ visible: false });
    if (summaryEl) summaryEl.textContent = "Failed to load register.";
  } finally {
    if (registerLoadBtn) registerLoadBtn.disabled = false;
  }
}

function initRegisterSection() {
  const { registerStart, registerEnd, registerLoadBtn, registerStatus } = dcDom;
  const refreshAllBtn = document.getElementById("dc-register-refresh-all");

  if (registerStart && registerEnd) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    registerEnd.value = toLocalDateString(endDate);
    registerStart.value = toLocalDateString(startDate);
  }

  registerLoadBtn?.addEventListener("click", () => {
    registerLoadedOnce = true;
    loadDayClosingRegister();
  });
  registerStatus?.addEventListener("change", () => {
    if (registerLoadedOnce) loadDayClosingRegister();
  });
  refreshAllBtn?.addEventListener("click", () => refreshRegisterPanel());

  initNightCashCollection();
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
  cacheDayClosingDom();

  const registerActionsHead = document.getElementById("dc-register-actions-head");
  if (registerActionsHead) registerActionsHead.hidden = !isAdmin;

  initRegisterSection();

  if (typeof initPageSections === "function") {
    initPageSections({
      defaultSection: "close",
      validSections: ["close", "register"],
      onSectionChange: (section) => {
        if (section === "register") {
          onRegisterSectionShown().catch((err) => {
            AppError.report(err, { context: "onRegisterSectionShown" });
          });
        }
      },
    });
  }

  await loadPumpSettings();
  await initializeDayClosing();
});
