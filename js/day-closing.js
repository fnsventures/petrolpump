/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getLocalDateString, toLocalDateString, escapeHtml, AdminDelete, CacheInvalidation, initPersistedDateInput, savePersistedDate, PumpSettings, loadPumpSettings, formatFuelBadge, formatDisplayDate, PrintUtils */

// Day closing & short: (Total sale + Collection + Short previous) − (Night cash + Phone pay + Credit + Expenses) = Today's short
// Same-day settlements (checkbox on payment) are excluded from Collection/Credit and entered via Night cash / Phone pay.
let dayClosingBreakdown = null;
let isAdmin = false;
let dcBreakdownRequestId = 0;
let dcCertifyInFlight = false;
let dcDetailsCache = { date: null, collection: null, credit: null, expenses: null };
let dcSettleMapsCache = { date: null, data: null, promise: null };
let dcShiftChannelCache = { date: null, data: null, promise: null };
let dcCloseLoadedDate = null;
let expenseCategoryLabels = null;
let dcDom = null;
let dcRegisterPrintRows = [];
let dcRegisterPrintRange = null;
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
    { label: "Fuel", format: (row) => (row.legacy ? "Legacy" : formatFuelBadge(row.fuel)), escape: false },
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
    nightCashHint: document.getElementById("dc-night-cash-hint"),
    phonePayHint: document.getElementById("dc-phone-pay-hint"),
    useSuggestedCashBtn: document.getElementById("dc-use-suggested-cash"),
    useSuggestedPhoneBtn: document.getElementById("dc-use-suggested-phone"),
    remarksInput: document.getElementById("dc-remarks"),
    saveBtn: document.getElementById("day-closing-save"),
    referenceLine: document.getElementById("dc-reference-line"),
    noActivityHint: document.getElementById("dc-no-activity-hint"),
    successEl: document.getElementById("day-closing-success"),
    errorEl: document.getElementById("day-closing-error"),
    alreadySavedEl: document.getElementById("day-closing-already-saved"),
    certifyPanel: document.getElementById("dc-certify-panel"),
    certifyTitle: document.getElementById("dc-certify-title"),
    certifyDetail: document.getElementById("dc-certify-detail"),
    certifyBtn: document.getElementById("dc-certify-btn"),
    uncertifyBtn: document.getElementById("dc-uncertify-btn"),
    certifyError: document.getElementById("dc-certify-error"),
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

  card?.classList.remove("dc-short--shortage", "dc-short--balanced", "dc-short--surplus");
  dcDom.shortTodayEl.classList.remove("dc-short--shortage", "stat-positive", "stat-negative");

  if (shortage) {
    card?.classList.add("dc-short--shortage");
    dcDom.shortTodayEl.classList.add("dc-short--shortage");
    if (statusEl) statusEl.textContent = "Still unaccounted — check night cash & PhonePe totals";
  } else if (surplus) {
    card?.classList.add("dc-short--surplus");
    dcDom.shortTodayEl.classList.add("stat-negative");
    if (statusEl) statusEl.textContent = formatCurrency(Math.abs(amount)) + " over-accounted";
  } else {
    card?.classList.add("dc-short--balanced");
    dcDom.shortTodayEl.classList.add("stat-positive");
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
    dcDom.resultCardEl?.classList.remove("dc-short--shortage", "dc-short--balanced", "dc-short--surplus");
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
  await Promise.all(DC_DETAIL_KINDS.map(async (kind) => {
    const { toggle } = getDcDetailElements(kind);
    if (toggle?.getAttribute("aria-expanded") === "true") {
      dcDetailsCache[kind] = null;
      await loadDayClosingDetail(kind, dateStr);
    }
  }));
}

function clearDayClosingChannelHints() {
  if (dcDom?.nightCashHint) dcDom.nightCashHint.innerHTML = "";
  if (dcDom?.phonePayHint) dcDom.phonePayHint.innerHTML = "";
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

function renderDayClosingDetailTable(rows, columns, kind, { sameDayRouted = 0 } = {}) {
  let note = "";
  if (kind === "collection" && sameDayRouted > 0.005) {
    note = `<p class="muted dc-same-day-note">${formatCurrency(sameDayRouted)} same-day settlement → Night cash / Phone pay.</p>`;
  }
  if (!rows.length) {
    if (kind === "collection") {
      return (
        note ||
        '<p class="muted">No prior-debt settlements. <a href="credit.html#settle">Record payment</a></p>'
      );
    }
    if (kind === "credit") {
      return '<p class="muted">No open credit. <a href="credit.html#record">Record sale</a></p>';
    }
    if (kind === "expenses") {
      return '<p class="muted">No expenses. <a href="expenses.html">Add expense</a></p>';
    }
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
          data: {
            paymentId: row.id,
            amount: String(row.paymentAmount ?? row.amount ?? ""),
            date: row.date || "",
          },
          title: "Delete settlement (admin)",
        })}</td>`;
      } else if (kind === "credit" && row.id && !row.legacy) {
        actions = `<td class="table-actions">${AdminDelete.buttonHtml({
          selector: "dc-delete-credit",
          data: {
            entryId: row.id,
            amount: String(row.entryAmount ?? row.amount ?? ""),
            date: row.date || "",
          },
          title: "Delete credit sale (admin)",
        })}</td>`;
      } else {
        actions = '<td class="table-actions muted">—</td>';
      }
    }
    return `<tr>${cells}${actions}</tr>`;
  }).join("");
  return `${note}<table class="dc-breakdown-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Load credit/payment totals for a date (cached per date).
 * Same-day pool comes from payments flagged same_day_settlement.
 */
async function loadDayCreditSettleMaps(dateStr) {
  if (dcSettleMapsCache.date === dateStr && dcSettleMapsCache.data) {
    return dcSettleMapsCache.data;
  }
  if (dcSettleMapsCache.date === dateStr && dcSettleMapsCache.promise) {
    return dcSettleMapsCache.promise;
  }

  const promise = (async () => {
    const [entriesRes, paysRes] = await Promise.all([
      supabaseClient
        .from("credit_entries")
        .select(
          "id, credit_customer_id, amount, fuel_type, quantity, transaction_date, shift, employee_id, created_at, employees(name), credit_customers(customer_name)"
        )
        .eq("transaction_date", dateStr)
        .order("created_at", { ascending: false }),
      supabaseClient
        .from("credit_payments")
        .select(
          "id, amount, payment_mode, date, credit_customer_id, created_at, same_day_settlement, credit_customers(customer_name)"
        )
        .eq("date", dateStr)
        .order("created_at", { ascending: true }),
    ]);
    if (entriesRes.error) throw entriesRes.error;
    if (paysRes.error) throw paysRes.error;

    const entries = entriesRes.data || [];
    const payments = paysRes.data || [];
    const byId = new Map();
    let settleCash = 0;
    let settleUpi = 0;

    const ensure = (id) => {
      if (!byId.has(id)) byId.set(id, { creditToday: 0, payToday: 0, sameDay: 0 });
      return byId.get(id);
    };

    for (const row of entries) {
      ensure(row.credit_customer_id).creditToday += Number(row.amount ?? 0);
    }
    for (const row of payments) {
      const amt = Number(row.amount ?? 0);
      const cur = ensure(row.credit_customer_id);
      cur.payToday += amt;
      if (row.same_day_settlement) cur.sameDay += amt;
      const mode = String(row.payment_mode || "Cash").trim().toLowerCase();
      if (mode === "upi") settleUpi += amt;
      else if (mode !== "bank") settleCash += amt;
    }
    // Cap same-day credit netting at today's credit (matches server).
    for (const cur of byId.values()) {
      cur.sameDay = Math.min(cur.sameDay, cur.creditToday);
    }

    const data = { entries, payments, byId, settleCash, settleUpi };
    dcSettleMapsCache = { date: dateStr, data, promise: null };
    return data;
  })();

  dcSettleMapsCache = { date: dateStr, data: null, promise };
  try {
    return await promise;
  } catch (err) {
    if (dcSettleMapsCache.promise === promise) {
      dcSettleMapsCache = { date: null, data: null, promise: null };
    }
    throw err;
  }
}

function invalidateDcSettleMapsCache(dateStr) {
  if (!dateStr || dcSettleMapsCache.date === dateStr) {
    dcSettleMapsCache = { date: null, data: null, promise: null };
  }
}

function invalidateDcShiftChannelCache(dateStr) {
  if (!dateStr || dcShiftChannelCache.date === dateStr) {
    dcShiftChannelCache = { date: null, data: null, promise: null };
  }
}

function invalidateDcCloseCaches(dateStr) {
  invalidateDcSettleMapsCache(dateStr);
  invalidateDcShiftChannelCache(dateStr);
  if (dateStr) {
    dcDetailsCache = { date: dateStr, collection: null, credit: null, expenses: null };
  }
}

async function fetchCollectionDetails(dateStr) {
  const { payments } = await loadDayCreditSettleMaps(dateStr);

  // Explicit flag: same-day settlements are omitted from Collection.
  let sameDayRouted = 0;
  const rows = [];
  for (const row of payments) {
    const amt = Number(row.amount ?? 0);
    if (row.same_day_settlement) {
      sameDayRouted += amt;
      continue;
    }
    if (amt <= 0.005) continue;
    rows.push({
      id: row.id ?? null,
      date: row.date || dateStr,
      customer: row.credit_customers?.customer_name || "—",
      mode: row.payment_mode || "—",
      amount: amt,
      paymentAmount: amt,
    });
  }
  return { rows, sameDayRouted };
}

async function fetchCreditTodayDetails(dateStr) {
  const [{ entries, byId }, legacyRes] = await Promise.all([
    loadDayCreditSettleMaps(dateStr),
    supabaseClient
      .from("credit_customers")
      .select("id, customer_name, amount_due")
      .eq("date", dateStr)
      .gt("amount_due", 0),
  ]);
  if (legacyRes.error) throw legacyRes.error;

  const sameDayLeft = new Map();
  for (const [id, c] of byId) sameDayLeft.set(id, c.sameDay);

  // Entries already newest-first; settle newest first (LIFO within the day).
  const entryRows = [];
  for (const row of entries) {
    const cid = row.credit_customer_id;
    const amt = Number(row.amount ?? 0);
    let sameLeft = sameDayLeft.get(cid) || 0;
    const settle = Math.min(amt, sameLeft);
    sameDayLeft.set(cid, sameLeft - settle);
    const remain = amt - settle;
    if (remain <= 0.005) continue;
    const staff = row.employees?.name;
    const shiftLabel = row.shift === "afternoon" ? "Afternoon" : row.shift === "morning" ? "Morning" : "";
    const via = staff ? ` · Shift ${shiftLabel}: ${staff}` : "";
    const qty = Number(row.quantity ?? 0);
    const qtyRemain = amt > 0 && qty > 0 ? (qty * remain) / amt : qty;
    entryRows.push({
      id: row.id ?? null,
      date: row.transaction_date || dateStr,
      customer: (row.credit_customers?.customer_name || "—") + via,
      fuel: row.fuel_type || "—",
      quantity: qtyRemain,
      amount: remain,
      entryAmount: amt,
      legacy: false,
    });
  }

  const legacyCandidates = legacyRes.data || [];
  let legacyRows = [];
  if (legacyCandidates.length) {
    const ids = legacyCandidates.map((row) => row.id);
    const hasEntry = new Set(entries.map((e) => e.credit_customer_id));
    // Also exclude any legacy ids that have entries (even if not in today's entry list)
    const missing = ids.filter((id) => !hasEntry.has(id));
    if (missing.length) {
      const { data: withEntries, error: entryCheckError } = await supabaseClient
        .from("credit_entries")
        .select("credit_customer_id")
        .in("credit_customer_id", missing);
      if (entryCheckError) throw entryCheckError;
      for (const row of withEntries || []) hasEntry.add(row.credit_customer_id);
    }
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
      .select("category, description, amount, shift, employee_id, employees(name)")
      .eq("date", dateStr)
      .order("created_at", { ascending: true }),
    loadExpenseCategoryLabels(),
  ]);
  if (expensesRes.error) throw expensesRes.error;
  const getCategoryLabel = (value) => labelMap[value] || DC_LEGACY_EXPENSE_LABELS[value] || value || "—";
  return (expensesRes.data || []).map((row) => {
    const staff = row.employees?.name;
    const shiftLabel = row.shift === "afternoon" ? "Afternoon" : row.shift === "morning" ? "Morning" : "";
    const via = staff ? ` · Shift ${shiftLabel}: ${staff}` : "";
    return {
      category: getCategoryLabel(row.category),
      description: (row.description || "—") + via,
      amount: Number(row.amount ?? 0),
    };
  });
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
    const fetched = await DC_DETAIL_FETCHERS[kind](dateStr);
    const rows = Array.isArray(fetched) ? fetched : fetched.rows;
    const sameDayRouted = Array.isArray(fetched) ? 0 : Number(fetched.sameDayRouted || 0);
    let html = renderDayClosingDetailTable(rows, DC_DETAIL_COLUMNS[kind], kind, { sameDayRouted });
    if (kind === "credit") {
      html = renderDayClosingCreditDetailIntro() + html;
    } else if (kind === "expenses") {
      html = renderExpensesDetailIntro() + html;
    }
    dcDetailsCache.date = dateStr;
    dcDetailsCache[kind] = html;
    panel.innerHTML = html;
  } catch (err) {
    AppError.report(err, { context: `loadDayClosingDetail:${kind}` });
    panel.innerHTML = `<p class="error">${escapeHtml(err?.message || "Failed to load details.")}</p>`;
  }
}

function renderDayClosingCreditDetailIntro() {
  const b = dayClosingBreakdown || {};
  const shiftGross = dcMoney(b.credit_shift_gross);
  const sameDay = dcMoney(b.same_day_settle);
  const creditToday = dcMoney(b.credit_today);
  const openShift = Math.max(0, shiftGross - sameDay);
  const ledger = dcMoney(b.credit_ledger ?? Math.max(0, creditToday - openShift));
  if (creditToday <= 0.005 && shiftGross <= 0.005 && sameDay <= 0.005) return "";
  return renderDayClosingCreditBreakdown({
    shiftGross,
    sameDay,
    creditToday,
    ledgerCredit: ledger,
    emptyLabel: "No open credit for this date.",
  });
}

function renderExpensesDetailIntro() {
  const b = dayClosingBreakdown || {};
  const ledger = dcMoney(b.expenses_ledger);
  const shift = dcMoney(b.expenses_shift);
  if (!ledger && !shift) return "";
  return `<p class="muted dc-detail-intro">Expense book ${formatCurrency(ledger)} · Shift ${formatCurrency(shift)}</p>`;
}

async function toggleDayClosingDetail(kind) {
  const dateStr = dcDom?.dateInput?.value?.trim();
  if (!dateStr) return;

  const { toggle, panel } = getDcDetailElements(kind);
  if (!toggle || !panel) return;

  // Ignore re-entrant clicks while a load is in flight for this panel.
  if (toggle.dataset.dcToggleBusy === "1") return;

  const isOpen = toggle.getAttribute("aria-expanded") === "true";
  if (isOpen) {
    toggle.setAttribute("aria-expanded", "false");
    panel.hidden = true;
    return;
  }

  toggle.setAttribute("aria-expanded", "true");
  panel.hidden = false;
  toggle.dataset.dcToggleBusy = "1";
  try {
    await loadDayClosingDetail(kind, dateStr);
  } finally {
    delete toggle.dataset.dcToggleBusy;
  }
}

async function loadDayClosingBreakdown(dateStr, { preserveSuccess = false } = {}) {
  if (!dateStr || !dcDom?.dateInput) return;

  if (dcDom.dateInput.value !== dateStr) dcDom.dateInput.value = dateStr;
  if (dcCloseLoadedDate && dcCloseLoadedDate !== dateStr) {
    collapseDayClosingDetails();
  }
  dcCloseLoadedDate = dateStr;
  invalidateDcCloseCaches(dateStr);

  const requestId = ++dcBreakdownRequestId;

  if (!preserveSuccess) dcDom.successEl?.classList.add("hidden");
  dcDom.errorEl?.classList.add("hidden");
  setBreakdownAmounts(DC_LOADING);
  clearDayClosingChannelHints();
  syncDayClosingUseSuggestedButtons(null);

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
    syncDayClosingCertifyPanel(null);
    if (dcDom.errorEl) {
      dcDom.errorEl.textContent = err?.message || "Failed to load day closing breakdown.";
      dcDom.errorEl.classList.remove("hidden");
    }
    return;
  }

  if (requestId !== dcBreakdownRequestId) return;

  let b = dayClosingBreakdown || {};
  try {
    b = await enrichDayClosingSettleSuggestions(b, dateStr);
    dayClosingBreakdown = b;
  } catch (err) {
    AppError.report(err, { context: "enrichDayClosingSettleSuggestions" });
  }
  if (requestId !== dcBreakdownRequestId) return;

  applyDayClosingBreakdownUi(b, { preserveSuccess });

  await refreshDayClosingDetailsState(dateStr).catch((err) => {
    AppError.report(err, { context: "refreshDayClosingDetailsState" });
  });
}

function applyDayClosingBreakdownUi(b, { preserveSuccess = false } = {}) {
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

  const canOverwrite = canOverwriteDayClosing(b);
  const alreadySaved = !!b.already_saved;
  const editable = !alreadySaved || canOverwrite;

  setDayClosingMoneyInput(
    dcDom.nightCashInput,
    alreadySaved ? b.saved_night_cash ?? b.night_cash : b.suggested_night_cash ?? b.night_cash
  );
  setDayClosingMoneyInput(
    dcDom.phonePayInput,
    alreadySaved ? b.saved_phone_pay ?? b.phone_pay : b.suggested_phone_pay ?? b.phone_pay
  );
  syncDayClosingShiftCashHints(b);
  syncDayClosingUseSuggestedButtons(b);
  syncDayClosingSaveButton(dcDom.saveBtn);
  syncDayClosingAlreadySavedNotice(b);
  syncDayClosingCertifyPanel(b);

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
    dcDom.remarksInput.disabled = !editable;
  }
  if (dcDom.nightCashInput) dcDom.nightCashInput.disabled = !editable;
  if (dcDom.phonePayInput) dcDom.phonePayInput.disabled = !editable;
  if (dcDom.noActivityHint) {
    const hasActivity = totalSale || collection || shortPrevious || creditToday || expensesToday;
    dcDom.noActivityHint.classList.toggle("hidden", hasActivity || alreadySaved);
  }
  if (!preserveSuccess) dcDom.successEl?.classList.add("hidden");

  if (!editable && alreadySaved && b.short_today != null) {
    updateShortDisplay(Number(b.short_today));
  } else {
    updateDayClosingShortLive();
  }
}

function syncDayClosingUseSuggestedButtons(breakdown) {
  const b = breakdown || {};
  const editable = !b.already_saved || canOverwriteDayClosing(b);
  const cashBtn = dcDom?.useSuggestedCashBtn;
  const phoneBtn = dcDom?.useSuggestedPhoneBtn;
  if (!cashBtn && !phoneBtn) return;

  const suggestedCash = dcMoney(b.suggested_night_cash);
  const suggestedPhone = dcMoney(b.suggested_phone_pay);
  const currentCash = dcMoney(dcDom?.nightCashInput?.value);
  const currentPhone = dcMoney(dcDom?.phonePayInput?.value);

  if (cashBtn) {
    const show = editable && suggestedCash > 0.005 && Math.abs(suggestedCash - currentCash) > 0.005;
    cashBtn.classList.toggle("hidden", !show);
    cashBtn.disabled = !show;
  }
  if (phoneBtn) {
    const show = editable && suggestedPhone > 0.005 && Math.abs(suggestedPhone - currentPhone) > 0.005;
    phoneBtn.classList.toggle("hidden", !show);
    phoneBtn.disabled = !show;
  }
}

function applySuggestedNightCash() {
  const suggested = dcMoney(dayClosingBreakdown?.suggested_night_cash);
  if (!dcDom?.nightCashInput || suggested <= 0) return;
  setDayClosingMoneyInput(dcDom.nightCashInput, suggested);
  updateDayClosingShortLive();
  syncDayClosingUseSuggestedButtons(dayClosingBreakdown);
}

function applySuggestedPhonePay() {
  const suggested = dcMoney(dayClosingBreakdown?.suggested_phone_pay);
  if (!dcDom?.phonePayInput || suggested <= 0) return;
  setDayClosingMoneyInput(dcDom.phonePayInput, suggested);
  updateDayClosingShortLive();
  syncDayClosingUseSuggestedButtons(dayClosingBreakdown);
}

function canOverwriteDayClosing(breakdown) {
  return !!breakdown?.can_overwrite;
}

function dcMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function setDayClosingMoneyInput(el, value) {
  if (!el) return;
  const n = Number(value);
  el.value = Number.isFinite(n) ? String(n) : "";
}

/**
 * Ensure night cash / phone pay suggestions = shift till + Cash/UPI settlements.
 * Uses RPC settle_* when present; otherwise one shared payments fetch via settle maps cache.
 * When already saved, night_cash / phone_pay always reflect registered amounts (not suggestions).
 */
async function enrichDayClosingSettleSuggestions(breakdown, dateStr) {
  const b = { ...(breakdown || {}) };

  const needsSettleMaps = b.settle_cash_total == null || b.settle_upi_total == null;
  const hasRpcShiftSplit =
    b.shift_morning_cash != null ||
    b.shift_afternoon_cash != null ||
    b.shift_morning_phone != null ||
    b.shift_afternoon_phone != null;

  const [maps, shiftSplitFromFetch] = await Promise.all([
    needsSettleMaps ? loadDayCreditSettleMaps(dateStr) : null,
    hasRpcShiftSplit ? null : loadDayClosingShiftChannelTotals(dateStr).catch((err) => {
      AppError.report(err, { context: "loadDayClosingShiftChannelTotals" });
      return null;
    }),
  ]);

  let settleCash = b.settle_cash_total;
  let settleUpi = b.settle_upi_total;
  if (needsSettleMaps && maps) {
    settleCash = maps.settleCash;
    settleUpi = maps.settleUpi;
  }
  settleCash = dcMoney(settleCash);
  settleUpi = dcMoney(settleUpi);

  const sameCash = dcMoney(b.same_day_settle_cash);
  const sameUpi = dcMoney(b.same_day_settle_upi);
  const collectionCash = dcMoney(b.collection_cash_total ?? settleCash - sameCash);
  const collectionUpi = dcMoney(b.collection_upi_total ?? settleUpi - sameUpi);

  let shiftSplit = {
    morningCash: dcMoney(b.shift_morning_cash),
    afternoonCash: dcMoney(b.shift_afternoon_cash),
    morningPhone: dcMoney(b.shift_morning_phone),
    afternoonPhone: dcMoney(b.shift_afternoon_phone),
  };
  if (!hasRpcShiftSplit && shiftSplitFromFetch) {
    shiftSplit = shiftSplitFromFetch;
  }

  b.settle_cash_total = settleCash;
  b.settle_upi_total = settleUpi;
  b.collection_cash_total = collectionCash;
  b.collection_upi_total = collectionUpi;
  b.shift_morning_cash = shiftSplit.morningCash;
  b.shift_afternoon_cash = shiftSplit.afternoonCash;
  b.shift_morning_phone = shiftSplit.morningPhone;
  b.shift_afternoon_phone = shiftSplit.afternoonPhone;
  b.suggested_night_cash =
    shiftSplit.morningCash + shiftSplit.afternoonCash + collectionCash + sameCash;
  b.suggested_phone_pay =
    shiftSplit.morningPhone + shiftSplit.afternoonPhone + collectionUpi + sameUpi;

  if (b.already_saved) {
    // Prefer saved_* from RPC; fall back to night_cash/phone_pay only when saved_* missing.
    b.saved_night_cash = dcMoney(b.saved_night_cash ?? b.night_cash);
    b.saved_phone_pay = dcMoney(b.saved_phone_pay ?? b.phone_pay);
    b.night_cash = b.saved_night_cash;
    b.phone_pay = b.saved_phone_pay;
  }
  return b;
}

/** Shift till cash / phone pay split by morning and afternoon (cached per date). */
async function loadDayClosingShiftChannelTotals(dateStr) {
  if (dcShiftChannelCache.date === dateStr && dcShiftChannelCache.data) {
    return dcShiftChannelCache.data;
  }
  if (dcShiftChannelCache.date === dateStr && dcShiftChannelCache.promise) {
    return dcShiftChannelCache.promise;
  }

  const promise = (async () => {
    const { data, error } = await supabaseClient
      .from("meter_shift_cash")
      .select("shift, cash_collected, phone_pay")
      .eq("reading_date", dateStr);
    if (error) throw error;

    const out = {
      morningCash: 0,
      afternoonCash: 0,
      morningPhone: 0,
      afternoonPhone: 0,
    };
    for (const row of data || []) {
      const cash = dcMoney(row.cash_collected);
      const phone = dcMoney(row.phone_pay);
      if (row.shift === "morning") {
        out.morningCash += cash;
        out.morningPhone += phone;
      } else if (row.shift === "afternoon") {
        out.afternoonCash += cash;
        out.afternoonPhone += phone;
      }
    }
    dcShiftChannelCache = { date: dateStr, data: out, promise: null };
    return out;
  })();

  dcShiftChannelCache = { date: dateStr, data: null, promise };
  return promise;
}

function dcShiftChannelLabels() {
  const cfg = typeof PumpSettings?.getShiftConfig === "function" ? PumpSettings.getShiftConfig() : {};
  return {
    morning: cfg.morningName || "Morning shift",
    afternoon: cfg.afternoonName || "Afternoon shift",
  };
}

/**
 * Credit today breakdown for expanded detail panel.
 */
function renderDayClosingCreditBreakdown({ shiftGross, sameDay, creditToday, ledgerCredit, emptyLabel }) {
  const gross = dcMoney(shiftGross);
  const same = dcMoney(sameDay);
  const total = dcMoney(creditToday);
  const ledger = dcMoney(ledgerCredit);
  const hasParts = gross > 0.005 || same > 0.005 || ledger > 0.005;

  if (!hasParts && total <= 0.005) {
    return `<p class="dc-channel-empty muted">${escapeHtml(emptyLabel)}</p>`;
  }

  const lines = [];
  if (gross > 0.005) {
    lines.push(
      `<div class="dc-channel-line">
        <span class="dc-channel-line-label">Shift credit</span>
        <span>${formatCurrency(gross)}</span>
      </div>`
    );
  }
  if (same > 0.005) {
    lines.push(
      `<div class="dc-channel-line dc-channel-line--part">
        <span class="dc-channel-line-label"><span class="dc-channel-op" aria-hidden="true">−</span> Same day</span>
        <span>${formatCurrency(same)}</span>
      </div>`
    );
  }
  if (ledger > 0.005) {
    lines.push(
      `<div class="dc-channel-line dc-channel-line--part">
        <span class="dc-channel-line-label"><span class="dc-channel-op" aria-hidden="true">+</span> Credit book</span>
        <span>${formatCurrency(ledger)}</span>
      </div>`
    );
  }
  if (total > 0.005 || lines.length) {
    lines.push(
      `<div class="dc-channel-line dc-channel-line--total dc-channel-suggested">
        <span class="dc-channel-line-label"><span class="dc-channel-op" aria-hidden="true">=</span> Open credit</span>
        <span>${formatCurrency(total)}</span>
      </div>`
    );
  }

  return `<div class="dc-channel-formula dc-channel-formula--detail">${lines.join("")}</div>`;
}

function renderDayClosingChannelBreakdown({
  morningShift,
  afternoonShift,
  collection,
  sameDay,
  suggested,
  morningLabel,
  afternoonLabel,
  emptyLabel,
}) {
  const morning = dcMoney(morningShift);
  const afternoon = dcMoney(afternoonShift);
  const coll = dcMoney(collection);
  const same = dcMoney(sameDay);
  const total = dcMoney(suggested);

  const rows = [
    { label: morningLabel, amount: morning },
    { label: afternoonLabel, amount: afternoon },
    { label: "Collection", amount: coll },
    { label: "Same day", amount: same },
  ].filter((row) => row.amount > 0.005);

  if (!rows.length && total <= 0.005) {
    return `<p class="dc-channel-empty muted">${escapeHtml(emptyLabel)}</p>`;
  }

  if (!rows.length) {
    return `<p class="dc-channel-summary muted">Suggested ${formatCurrency(total)}</p>`;
  }

  const partLines = rows.map((row, index) => {
    const op = index === 0 ? "" : "+";
    return `<div class="dc-channel-line${index > 0 ? " dc-channel-line--part" : ""}">
      <span class="dc-channel-line-label">${op ? `<span class="dc-channel-op" aria-hidden="true">${op}</span> ` : ""}${escapeHtml(row.label)}</span>
      <span>${formatCurrency(row.amount)}</span>
    </div>`;
  });

  return `<details class="dc-channel-details">
    <summary class="dc-channel-summary">
      <span class="dc-channel-summary-label">Suggested</span>
      <span class="dc-channel-summary-amount">${formatCurrency(total)}</span>
    </summary>
    <div class="dc-channel-formula">${partLines.join("")}</div>
  </details>`;
}

function syncDayClosingShiftCashHints(breakdown) {
  const b = breakdown || {};
  const morningCash = dcMoney(b.shift_morning_cash);
  const afternoonCash = dcMoney(b.shift_afternoon_cash);
  const morningPhone = dcMoney(b.shift_morning_phone);
  const afternoonPhone = dcMoney(b.shift_afternoon_phone);
  const settleCash = dcMoney(b.settle_cash_total);
  const settleUpi = dcMoney(b.settle_upi_total);
  const sameCash = dcMoney(b.same_day_settle_cash);
  const sameUpi = dcMoney(b.same_day_settle_upi);
  const sameBank = dcMoney(b.same_day_settle_bank);
  const collectionCash = dcMoney(b.collection_cash_total ?? settleCash - sameCash);
  const collectionUpi = dcMoney(b.collection_upi_total ?? settleUpi - sameUpi);
  const suggestedCash = dcMoney(b.suggested_night_cash ?? morningCash + afternoonCash + collectionCash + sameCash);
  const suggestedPhone = dcMoney(
    b.suggested_phone_pay ?? morningPhone + afternoonPhone + collectionUpi + sameUpi
  );
  const labels = dcShiftChannelLabels();

  const cashHint = dcDom?.nightCashHint;
  if (cashHint) {
    let html = renderDayClosingChannelBreakdown({
      morningShift: morningCash,
      afternoonShift: afternoonCash,
      collection: collectionCash,
      sameDay: sameCash,
      suggested: suggestedCash,
      morningLabel: labels.morning,
      afternoonLabel: labels.afternoon,
      emptyLabel: "No shift cash or cash settlements for this date.",
    });
    if (suggestedCash > 0.005 && sameBank > 0.005) {
      html += `<p class="dc-channel-note muted">Bank ${formatCurrency(sameBank)} not included in night cash</p>`;
    }
    cashHint.innerHTML = html;
  }

  const phoneHint = dcDom?.phonePayHint;
  if (phoneHint) {
    phoneHint.innerHTML = renderDayClosingChannelBreakdown({
      morningShift: morningPhone,
      afternoonShift: afternoonPhone,
      collection: collectionUpi,
      sameDay: sameUpi,
      suggested: suggestedPhone,
      morningLabel: labels.morning,
      afternoonLabel: labels.afternoon,
      emptyLabel: "No shift PhonePe/UPI or UPI settlements for this date.",
    });
  }
}

function formatCertifiedWhen(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

function certifiedLabel(breakdown) {
  if (!breakdown?.certified) return "";
  const name = String(breakdown.certified_by_name || "").trim();
  const when = formatCertifiedWhen(breakdown.certified_at);
  if (name && when) return `Certified by ${name} on ${when}`;
  if (name) return `Certified by ${name}`;
  if (when) return `Certified on ${when}`;
  return "Certified";
}

function syncDayClosingCertifyPanel(breakdown, { clearError = true } = {}) {
  const panel = dcDom?.certifyPanel;
  if (!panel) return;

  const alreadySaved = !!breakdown?.already_saved;
  const certified = !!breakdown?.certified;
  const canCertify =
    breakdown?.can_certify != null
      ? !!breakdown.can_certify
      : isAdmin && alreadySaved && !certified;
  const errorEl = dcDom.certifyError;

  if (clearError) {
    errorEl?.classList.add("hidden");
    if (errorEl) errorEl.textContent = "";
  }

  if (!alreadySaved) {
    panel.classList.add("hidden");
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  panel.classList.remove("hidden", "dc-certify--pending", "dc-certify--done");
  panel.classList.add(certified ? "dc-certify--done" : "dc-certify--pending");

  if (dcDom.certifyTitle) {
    dcDom.certifyTitle.textContent = certified ? "Certified" : "Awaiting acknowledgment";
  }
  if (dcDom.certifyDetail) {
    if (certified) {
      dcDom.certifyDetail.textContent =
        certifiedLabel(breakdown) +
        (isAdmin
          ? " Saving changes will remove certification so you can acknowledge again."
          : " This statement is locked for supervisors.");
    } else if (isAdmin) {
      dcDom.certifyDetail.textContent =
        "Review night cash, PhonePe/UPI, and today's short, then acknowledge to certify. Supervisors cannot edit once certified.";
    } else {
      dcDom.certifyDetail.textContent =
        "Saved. Waiting for an admin to acknowledge and certify this statement.";
    }
  }

  if (dcDom.certifyBtn) {
    dcDom.certifyBtn.classList.toggle("hidden", !canCertify);
    dcDom.certifyBtn.disabled = !canCertify || dcCertifyInFlight;
  }
  if (dcDom.uncertifyBtn) {
    const showUnlock = isAdmin && certified;
    dcDom.uncertifyBtn.classList.toggle("hidden", !showUnlock);
    dcDom.uncertifyBtn.disabled = !showUnlock || dcCertifyInFlight;
  }
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
  if (!breakdown?.already_saved) {
    el.classList.add("hidden");
    return;
  }
  // Certification copy lives in the certify panel; this notice is only for night-cash lock.
  if (!breakdown.night_cash_collected) {
    el.classList.add("hidden");
    return;
  }
  const canOverwrite = canOverwriteDayClosing(breakdown);
  const ref = breakdown.night_cash_collection_reference || "collection";
  el.textContent = canOverwrite
    ? "Night cash collected. As admin you can still update values and save again."
    : `Night cash collected (${ref}). Locked for supervisors — only an admin can modify this day closing.`;
  el.classList.remove("hidden");
}

function computeDayClosingShort({
  totalSale = 0,
  collection = 0,
  shortPrevious = 0,
  nightCash = 0,
  phonePay = 0,
  creditToday = 0,
  expensesToday = 0,
} = {}) {
  return totalSale + collection + shortPrevious - (nightCash + phonePay + creditToday + expensesToday);
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

  updateShortDisplay(
    computeDayClosingShort({
      totalSale,
      collection,
      shortPrevious,
      nightCash,
      phonePay,
      creditToday,
      expensesToday,
    })
  );
}

const DC_REGISTER_MONEY_KEYS = [
  "collection",
  "credit_today",
  "expenses_today",
  "night_cash",
  "phone_pay",
  "total_sale",
  "short_previous",
  "short_today",
];

function dcPrintNum(value) {
  return `<td class="num">${escapeHtml(formatCurrency(value))}</td>`;
}

function getDayClosingStatementAmounts() {
  const dateStr = dcDom?.dateInput?.value?.trim();
  if (!dateStr || !dayClosingBreakdown) {
    throw new Error("Load a day closing first.");
  }
  const b = dayClosingBreakdown;
  const nightCash = Number(dcDom.nightCashInput?.value ?? b.night_cash ?? 0) || 0;
  const phonePay = Number(dcDom.phonePayInput?.value ?? b.phone_pay ?? 0) || 0;
  const totalSale = Number(b.total_sale ?? 0);
  const collection = Number(b.collection ?? 0);
  const shortPrevious = Number(b.short_previous ?? 0);
  const creditToday = Number(b.credit_today ?? 0);
  const expensesToday = Number(b.expenses_today ?? 0);
  return {
    dateStr,
    dateLabel: formatDisplayDate(dateStr),
    ref: b.closing_reference || "",
    remarks: dcDom.remarksInput?.value?.trim() || b.remarks || "",
    rows: [
      ["Total sale", totalSale],
      ["Collection", collection],
      ["Short previous", shortPrevious],
      ["Night cash", nightCash],
      ["Phone pay", phonePay],
      ["Credit today", creditToday],
      ["Expenses today", expensesToday],
      [
        "Today's short",
        computeDayClosingShort({
          totalSale,
          collection,
          shortPrevious,
          nightCash,
          phonePay,
          creditToday,
          expensesToday,
        }),
        true,
      ],
    ],
  };
}

function formatRegisterCashStatusText(row) {
  const collected = !!row.night_cash_collection_id;
  const collRef = row.night_cash_collections?.collection_reference;
  return collected ? `Collected${collRef ? ` (${collRef})` : ""}` : "At pump";
}

function renderCertifiedStatus(isCertified, certifiedAt) {
  if (isCertified) {
    const when = formatCertifiedWhen(certifiedAt);
    return `<span class="dc-status-stack"><span class="dc-status-badge dc-status-badge--certified">Certified</span>${
      when ? `<span class="dc-status-ref">${escapeHtml(when)}</span>` : ""
    }</span>`;
  }
  return '<span class="dc-status-badge dc-status-badge--pending">Awaiting</span>';
}

function buildDayClosingStatementHtml() {
  const { dateLabel, ref, remarks, rows } = getDayClosingStatementAmounts();
  const certified = !!dayClosingBreakdown?.certified;
  const certLine = certifiedLabel(dayClosingBreakdown);
  const body = `
      <table class="report-table">
        <thead><tr><th>Particulars</th><th class="num">Amount (₹)</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ([label, amt, isTotal]) =>
                `<tr${isTotal ? ' class="report-total-row"' : ""}><td>${escapeHtml(label)}</td>${dcPrintNum(amt)}</tr>`
            )
            .join("")}
        </tbody>
      </table>
      ${remarks ? `<p class="report-summary-line"><strong>Remarks:</strong> ${escapeHtml(remarks)}</p>` : ""}
      <p class="report-note muted">Formula: (Total sale + Collection + Short previous) − (Night cash + Phone pay + Credit + Expenses) = Today's short.</p>
      <div class="report-certify">
        <p class="report-certify-statement">I acknowledge that the night cash, PhonePe/UPI, and short on this statement are correct.</p>
        <div class="report-certify-sign">
          <div>
            <div class="line">${certified ? escapeHtml(certLine) : ""}</div>
            <div class="cap">Dealer / Admin</div>
          </div>
          <div>
            <div class="line"></div>
            <div class="cap">Supervisor</div>
          </div>
        </div>
      </div>`;
  return PrintUtils.wrapReportPrintSheet(
    "Day closing statement",
    [`Date: ${escapeHtml(dateLabel)}`, ref ? `Reference: <strong>${escapeHtml(ref)}</strong>` : ""],
    body,
    dateLabel
  );
}

function buildDayClosingRegisterHtml() {
  if (!dcRegisterPrintRows?.length || !dcRegisterPrintRange) {
    throw new Error("Load the register for a date range first.");
  }
  const { start, end, status } = dcRegisterPrintRange;
  const statusLabel =
    status === "pending" ? "at pump only" : status === "collected" ? "collected only" : "all";
  const periodLabel = `${formatDisplayDate(start)} – ${formatDisplayDate(end)} (${statusLabel})`;
  const body = `
      <table class="report-table report-table-compact">
        <thead>
          <tr>
            <th>Date</th><th>Ref</th>
            <th class="num">Collection</th><th class="num">Credit</th><th class="num">Expenses</th>
            <th class="num">Night cash</th><th class="num">Phone pay</th>
            <th class="num">Total sale</th><th class="num">Short prev</th><th class="num">Short</th>
            <th>Status</th><th>Certified</th><th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          ${dcRegisterPrintRows
            .map(
              (row) => `<tr>
                <td>${escapeHtml(formatDisplayDate(row.date))}</td>
                <td>${escapeHtml(row.closing_reference ?? "—")}</td>
                ${DC_REGISTER_MONEY_KEYS.map((key) => dcPrintNum(row[key])).join("")}
                <td>${escapeHtml(formatRegisterCashStatusText(row))}</td>
                <td>${escapeHtml(row.certified ? "Certified" : "Awaiting")}</td>
                <td>${escapeHtml(row.remarks ?? "—")}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p class="report-note muted">${dcRegisterPrintRows.length} closing statement(s).</p>`;
  return PrintUtils.wrapReportPrintSheet(
    "Day closing register",
    [escapeHtml(periodLabel)],
    body,
    periodLabel
  );
}

async function runDayClosingPrint(bodyHtml, filenameParts) {
  await loadPumpSettings();
  const cssText = await PrintUtils.getReportPrintCssText();
  await PrintUtils.printInIframe({
    title: PrintUtils.buildPrintFilename(...filenameParts),
    bodyHtml,
    cssText,
    bodyClass: "report-print-body",
    containerClass: "report-print-container",
    iframeTitle: "Day closing print",
    imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
  });
}

async function printDayClosingStatement() {
  try {
    const bodyHtml = buildDayClosingStatementHtml();
    await runDayClosingPrint(bodyHtml, ["day-closing", dcDom?.dateInput?.value?.trim() || "statement"]);
  } catch (err) {
    AppError.handle(err, { target: dcDom?.errorEl });
  }
}

async function printDayClosingRegister() {
  try {
    const bodyHtml = buildDayClosingRegisterHtml();
    const start = dcRegisterPrintRange?.start || "";
    const end = dcRegisterPrintRange?.end || "";
    await runDayClosingPrint(bodyHtml, ["day-closing-register", start, start !== end ? end : null]);
  } catch (err) {
    AppError.report(err, { context: "printDayClosingRegister" });
    const summaryEl = document.getElementById("dc-register-summary");
    if (summaryEl) summaryEl.textContent = err?.message || "Print failed.";
  }
}

async function setDayClosingCertified(certified) {
  if (!isAdmin || dcCertifyInFlight) return;
  const dateStr = dcDom?.dateInput?.value?.trim();
  if (!dateStr) return;
  if (!dayClosingBreakdown?.already_saved) {
    if (dcDom.certifyError) {
      dcDom.certifyError.textContent = "Save day closing before certifying.";
      dcDom.certifyError.classList.remove("hidden");
    }
    return;
  }
  if (!!dayClosingBreakdown.certified === !!certified) {
    syncDayClosingCertifyPanel(dayClosingBreakdown);
    return;
  }

  const ref = dayClosingBreakdown?.closing_reference || "";
  const dateLabel = formatDisplayDate(dateStr);
  const collected = !!dayClosingBreakdown?.night_cash_collected;
  const confirmed = window.confirm(
    certified
      ? `Acknowledge and certify day closing for ${dateLabel}${ref ? ` (${ref})` : ""}?\n\nSupervisors will no longer be able to edit these figures.`
      : collected
        ? `Remove certification for ${dateLabel}${ref ? ` (${ref})` : ""}?\n\nSupervisors remain locked because night cash was already collected.`
        : `Remove certification for ${dateLabel}${ref ? ` (${ref})` : ""}?\n\nThe statement can be edited again until you recertify or night cash is collected.`
  );
  if (!confirmed) return;

  const certifyBtn = dcDom.certifyBtn;
  const uncertifyBtn = dcDom.uncertifyBtn;
  const errorEl = dcDom.certifyError;
  errorEl?.classList.add("hidden");
  dcDom.successEl?.classList.add("hidden");
  dcDom.errorEl?.classList.add("hidden");

  dcCertifyInFlight = true;
  if (certifyBtn) {
    certifyBtn.disabled = true;
    if (certified) certifyBtn.textContent = "Certifying…";
  }
  if (uncertifyBtn) {
    uncertifyBtn.disabled = true;
    if (!certified) uncertifyBtn.textContent = "Removing…";
  }

  try {
    const { data, error } = await supabaseClient.rpc("set_day_closing_certified", {
      p_date: dateStr,
      p_certified: !!certified,
    });
    if (error) throw error;

    if (dcDom.dateInput?.value?.trim() !== dateStr) return;

    if (dcDom.successEl) {
      dcDom.successEl.textContent = certified
        ? `Day closing certified${data?.certified_by_name ? ` by ${data.certified_by_name}` : ""}.`
        : "Certification removed. You can edit and acknowledge again.";
      dcDom.successEl.classList.remove("hidden");
    }

    if (typeof CacheInvalidation !== "undefined") {
      CacheInvalidation.invalidate("operational");
    }
    await loadDayClosingBreakdown(dateStr, { preserveSuccess: true });
    if (isRegisterSectionActive() && registerLoadedOnce) {
      await loadDayClosingRegister();
    }
  } catch (err) {
    AppError.report(err, { context: "setDayClosingCertified", certified });
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to update certification.";
      errorEl.classList.remove("hidden");
    }
  } finally {
    dcCertifyInFlight = false;
    if (certifyBtn) certifyBtn.textContent = "Acknowledge & certify";
    if (uncertifyBtn) uncertifyBtn.textContent = "Remove certification";
    syncDayClosingCertifyPanel(dayClosingBreakdown, { clearError: false });
  }
}

function openCloseDayForDate(dateStr) {
  if (!dateStr || !dcDom?.dateInput) return;
  savePersistedDate("day_closing_close", dateStr);
  if (location.hash !== "#close") location.hash = "close";
  if (dcDom.dateInput.value !== dateStr) dcDom.dateInput.value = dateStr;
  return loadDayClosingBreakdown(dateStr);
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

  const debouncedShortUpdate = debounce(() => {
    updateDayClosingShortLive();
    syncDayClosingUseSuggestedButtons(dayClosingBreakdown);
  }, 120);
  if (nightCashInput) {
    nightCashInput.addEventListener("input", debouncedShortUpdate);
    nightCashInput.addEventListener("change", () => {
      updateDayClosingShortLive();
      syncDayClosingUseSuggestedButtons(dayClosingBreakdown);
    });
  }
  if (phonePayInput) {
    phonePayInput.addEventListener("input", debouncedShortUpdate);
    phonePayInput.addEventListener("change", () => {
      updateDayClosingShortLive();
      syncDayClosingUseSuggestedButtons(dayClosingBreakdown);
    });
  }

  dcDom.useSuggestedCashBtn?.addEventListener("click", applySuggestedNightCash);
  dcDom.useSuggestedPhoneBtn?.addEventListener("click", applySuggestedPhonePay);

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
    if (isAdmin && dayClosingBreakdown?.already_saved && dayClosingBreakdown?.certified) {
      const confirmed = window.confirm(
        "This statement is certified. Saving will remove certification so you can acknowledge again after the change. Continue?"
      );
      if (!confirmed) {
        syncDayClosingSaveButton(submitBtn);
        return;
      }
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
      dayClosingBreakdown = {
        ...data,
        already_saved: true,
        certified: false,
        can_certify: isAdmin,
        can_overwrite: true,
        night_cash_collected: !!dayClosingBreakdown?.night_cash_collected,
        night_cash_collection_reference: dayClosingBreakdown?.night_cash_collection_reference ?? null,
      };
      updateDayClosingShortLive();
      syncDayClosingSaveButton(submitBtn);
      syncDayClosingAlreadySavedNotice(dayClosingBreakdown);
      syncDayClosingCertifyPanel(dayClosingBreakdown);
      if (dcDom.successEl) {
        const refPart = data?.closing_reference ? " Reference: " + data.closing_reference + "." : "";
        const action = data?.overwritten ? "Day closing updated." : "Day closing saved.";
        dcDom.successEl.classList.remove("hidden");
        dcDom.successEl.textContent =
          action +
          refPart +
          " Today's short: " +
          formatCurrency(Number(data?.short_today ?? 0)) +
          " (stored for next day).";
      }
      if (dcDom.referenceLine && data?.closing_reference) {
        dcDom.referenceLine.textContent = "Reference: " + data.closing_reference + (data.remarks ? " · " + data.remarks : "");
        dcDom.referenceLine.classList.remove("hidden");
      }
      dcDom.errorEl?.classList.add("hidden");
      dateInput.value = dateStr;
      savePersistedDate("day_closing_close", dateStr);
      await loadDayClosingBreakdown(dateStr, { preserveSuccess: true });
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
  document.getElementById("day-closing-print")?.addEventListener("click", () => {
    printDayClosingStatement();
  });

  dcDom.certifyBtn?.addEventListener("click", () => setDayClosingCertified(true));
  dcDom.uncertifyBtn?.addEventListener("click", () => setDayClosingCertified(false));

  document.querySelector(".day-closing-breakdown")?.addEventListener("click", (event) => {
    // Links / buttons inside details (delete, record payment) must not toggle.
    if (event.target.closest("a, input, textarea, select, .dc-breakdown-details button, .admin-delete-btn, .dc-delete-payment, .dc-delete-credit")) {
      return;
    }
    const group = event.target.closest(".dc-breakdown-group[data-breakdown]");
    if (!group) return;
    // Toggle from the header row (label, chevron, or amount) — not from the open details panel.
    if (event.target.closest(".dc-breakdown-details")) return;
    const kind = group.dataset.breakdown;
    if (kind && DC_DETAIL_KINDS.includes(kind)) {
      event.preventDefault();
      toggleDayClosingDetail(kind);
    }
  });

  initDayClosingCreditDeleteHandlers();

  window.addEventListener("storage", (e) => {
    if (e.key !== "credit-updated" && e.key !== "expenses-updated" && e.key !== "shift-updated") return;
    const dateStr = dateInput.value?.trim();
    if (!dateStr) return;
    dcDetailsCache = { date: dateStr, collection: null, credit: null, expenses: null };
    invalidateDcCloseCaches(dateStr);
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
  invalidateDcSettleMapsCache(dateStr);
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

  const colCount = isAdmin ? 14 : 13;
  if (registerLoadBtn) registerLoadBtn.disabled = true;
  registerBody.innerHTML = `<tr><td colspan='${colCount}' class='muted'>Loading…</td></tr>`;
  if (registerFoot) registerFoot.hidden = true;

  try {
    const status = statusFilter?.value || "all";
    let closingsQuery = supabaseClient
      .from("day_closing")
      .select("id, date, closing_reference, total_sale, collection, short_previous, credit_today, expenses_today, night_cash, phone_pay, short_today, remarks, certified, certified_at, night_cash_collection_id, night_cash_collections(collection_reference)")
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
    dcRegisterPrintRows = rows;
    dcRegisterPrintRange = { start, end, status };

    if (!rows.length) {
      dcRegisterPrintRows = [];
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
        <td class="col-sticky"><a href="day-closing.html?date=${encodeURIComponent(d)}#close" data-dc-date="${escapeHtml(d)}">${escapeHtml(formatDisplayDate(d))}</a></td>
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
        <td class="col-secondary">${renderCertifiedStatus(!!row.certified, row.certified_at)}</td>
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
        <td class="col-split-start col-secondary" colspan="6"></td>
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
    if (!registerBody.dataset.dcDateNavBound) {
      registerBody.dataset.dcDateNavBound = "1";
      registerBody.addEventListener("click", (event) => {
        const link = event.target.closest?.("a[data-dc-date]");
        if (!link || !registerBody.contains(link)) return;
        const dateStr = link.getAttribute("data-dc-date")?.trim();
        if (!dateStr) return;
        event.preventDefault();
        openCloseDayForDate(dateStr)?.catch((err) => {
          AppError.report(err, { context: "openCloseDayForDate", dateStr });
        });
      });
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
  const registerPrintBtn = document.getElementById("dc-register-print");

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
  registerPrintBtn?.addEventListener("click", () => printDayClosingRegister());

  initNightCashCollection();
  PrintUtils.preloadReportPrintCss?.();
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

bindAppResume(
  () => {
    if (isSettingsPanelActive("register")) {
      void onRegisterSectionShown();
      return;
    }
    if (document.getElementById("day-closing-date")) {
      void initializeDayClosing();
    }
  },
  { match: () => Boolean(document.getElementById("day-closing-date") || document.getElementById("dc-register-body")) }
);
