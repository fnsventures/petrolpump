/* global requireAuth, applyRoleVisibility, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, initPageSections, debounce, setFilterState, CacheInvalidation, mountLoadMorePager, syncLoadMorePager, bindAppResume, bindCacheInvalidate, resetPaginationLoading, runAppRequest, renderTableRetryRow, normCustomerName, fetchAllRows, isCancelledRequestError, loadScript, searchCreditCustomers */

const PAGE_SIZE = 25;

let creditPagination = {
  offset: 0,
  hasMore: true,
  totalCount: 0,
  isLoading: false,
  ledgerData: [],
  searchQuery: "",
  phoneMatchKeys: null,
  openCreditTotal: null,
  sortBy: "balance-desc",
  statusFilter: "outstanding",
};

// Overview and Outstanding share one in-flight flag. A ledger load requested
// while a snapshot is running is remembered and started when that flag clears.
let portfolioLoadSeq = 0;
let portfolioLoadKind = null;
let ledgerReloadQueued = false;
let outstandingLedgerShown = false;


let isAdmin = false;

function resetCreditLoadingState() {
  resetPaginationLoading(creditPagination, document.getElementById("credit-load-more"));
}

async function runCreditRequest(label, fn) {
  return runAppRequest(label, fn);
}

function renderCreditRetryRow(message, retryFn) {
  renderTableRetryRow(document.getElementById("credit-table-body"), 5, message, retryFn);
}

function refreshCreditOnVisible() {
  resetCreditLoadingState();
  creditPagination.openCreditTotal = null;
  if (isCustomerView()) {
    void window.CreditCustomer?.refresh?.();
    return;
  }
  refreshCreditPortfolioViews();
}

const creditState = {
  customerName: "",
  customerId: null,
  customerIds: [],
  customerOutstandingDue: 0,
  customerPrepaidBalance: 0,
  customerNetBalance: 0,
  customerContact: { mobile: "", address: "" },
  customerVehicleNos: [],
  lastCustomerSummary: null,
  lastCustomerSummaryFull: null,
  lastCustomerSummaryContext: null,
  creditSummaryPrintBusy: false,
};

function creditEntryOutstanding(row) {
  return Math.max(0, Number(row?.amount ?? 0) - Number(row?.amount_settled ?? 0));
}

function isCustomerView() {
  return Boolean(creditState.customerName || creditState.customerId);
}

function updateCustomerBalanceState(amountDue, prepaidBalance) {
  creditState.customerOutstandingDue = Number(amountDue) || 0;
  creditState.customerPrepaidBalance = Number(prepaidBalance) || 0;
  creditState.customerNetBalance = creditState.customerOutstandingDue - creditState.customerPrepaidBalance;
}

function customerHasAdvance(netBalance, prepaidBalance) {
  return prepaidBalance > 0 && netBalance <= 0;
}

function formatCustomerBalanceDisplay(netBalance, prepaidBalance) {
  if (customerHasAdvance(netBalance, prepaidBalance)) {
    return `+ ${formatCurrency(prepaidBalance)}`;
  }
  return formatCurrency(netBalance);
}

function getCustomerBalanceLabel(netBalance, prepaidBalance) {
  if (customerHasAdvance(netBalance, prepaidBalance)) return "Credit balance";
  return "Outstanding";
}

function ledgerRowAmountDue(row) {
  return Number(row?.amount_due ?? 0);
}

function ledgerRowPrepaid(row) {
  return Number(row?.prepaid_balance ?? 0);
}

function ledgerRowNetBalance(row) {
  return ledgerRowAmountDue(row) - ledgerRowPrepaid(row);
}

function ledgerRowIsFullyCleared(row) {
  return ledgerRowAmountDue(row) <= 0 && ledgerRowPrepaid(row) <= 0;
}

function ledgerRowIsListed(row) {
  if (isAdmin) return true;
  return ledgerRowAmountDue(row) > 0 || ledgerRowPrepaid(row) > 0;
}

function applyCustomerBalanceHero(netBalance, prepaidBalance) {
  const label = getCustomerBalanceLabel(netBalance, prepaidBalance);
  const labelEl = document.querySelector(".customer-balance-label");
  if (labelEl) labelEl.textContent = label;

  const outstandingEl = document.getElementById("stat-outstanding");
  if (outstandingEl) {
    outstandingEl.textContent = formatCustomerBalanceDisplay(netBalance, prepaidBalance);
  }

  const heroAmount = outstandingEl?.closest(".customer-balance-hero-amount");
  if (heroAmount) {
    heroAmount.classList.toggle("has-credit", customerHasAdvance(netBalance, prepaidBalance));
    heroAmount.classList.toggle("is-cleared", netBalance <= 0 && prepaidBalance <= 0);
  }

  const payCta = document.getElementById("customer-record-payment-cta");
  if (payCta) payCta.classList.remove("hidden");

  const reminderCta = document.getElementById("customer-set-reminder-cta");
  if (reminderCta) {
    const customerName = creditState.customerName || "";
    const customerId = creditState.customerId || "";
    const params = new URLSearchParams({
      kind: "credit",
      type: "credit_followup",
      priority: "high",
    });
    if (customerName) params.set("name", customerName);
    if (customerId) params.set("customer", customerId);
    reminderCta.href = `reminders.html?${params.toString()}#add`;
    reminderCta.textContent = "Add reminder";
    reminderCta.classList.remove("hidden");
  }

  const settleNav = document.querySelector("#credit-customer-nav .settings-nav-item[data-section='settle']");
  if (settleNav) {
    settleNav.classList.remove("hidden");
    settleNav.hidden = false;
  }
}

function customerDetailUrl(row) {
  const id = row && typeof row === "object" ? row.id : "";
  if (id) return `credit.html?${new URLSearchParams({ id: String(id) }).toString()}`;
  const name = typeof row === "string" ? row : row?.customer_name || "";
  return `credit.html?${new URLSearchParams({ name: name || "" }).toString()}`;
}

function customerSummaryUrl(name, period) {
  const params = new URLSearchParams({ name: name || "" });
  if (period?.period) {
    params.set("period", period.period);
    if (period.period === "custom") {
      if (period.from) params.set("from", period.from);
      if (period.to) params.set("to", period.to);
    }
  }
  return `credit.html?${params.toString()}#summary`;
}

function setSidebarMode(mode) {
  const isCustomer = mode === "customer";
  document.body.classList.toggle("credit-customer-view", isCustomer);
  document.body.classList.toggle("credit-list-view", !isCustomer);

  const listNav = document.getElementById("credit-list-nav");
  const customerNav = document.getElementById("credit-customer-nav");
  if (listNav) {
    listNav.classList.toggle("hidden", isCustomer);
    listNav.hidden = isCustomer;
  }
  if (customerNav) {
    customerNav.classList.toggle("hidden", !isCustomer);
    customerNav.hidden = !isCustomer;
  }
}

function creditListDefaultSection() {
  return isAdmin ? "overview" : "record";
}

/** Supervisors record sales all day. Show that tab before auth finishes so Overview does not flash. */
function showSupervisorRecordSale() {
  if (location.hash || document.documentElement.classList.contains("role-admin")) return;
  const params = new URLSearchParams(location.search);
  if (params.get("id") || params.get("name")) return;
  const recordBtn = document.querySelector('#credit-list-nav [data-section="record"]');
  const overviewBtn = document.querySelector('#credit-list-nav [data-section="overview"]');
  const record = document.getElementById("credit-panel-record");
  const overview = document.getElementById("credit-panel-overview");
  if (!record || !overview) return;
  overviewBtn?.classList.remove("is-active");
  recordBtn?.classList.add("is-active");
  overview.classList.remove("is-visible");
  overview.hidden = true;
  record.classList.add("is-visible");
  record.hidden = false;
}

showSupervisorRecordSale();

function initListView() {
  setSidebarMode("list");
  setCustomerToolbarVisible(false);
  hideCustomerPanels();

  const defaultSection = creditListDefaultSection();
  if (typeof initPageSections === "function") {
    initPageSections({
      navItemSelector: "#credit-list-nav .settings-nav-item",
      panelSelector: "#credit-panel-overview, #credit-panel-record, #credit-panel-outstanding, #credit-panel-aging",
      defaultSection,
      validSections: ["overview", "record", "outstanding", "aging"],
      onSectionChange: (section) => {
        void ensureListTab(section);
      },
    });
  }

  const hash = (location.hash || "").replace(/^#/, "");
  const initial = ["overview", "record", "outstanding", "aging"].includes(hash) ? hash : defaultSection;
  void ensureListTab(initial);
}

function hideCustomerPanels() {
  const ids = [
    "customer-balance-hero",
    "customer-period-toolbar",
    "customer-panel-summary",
    "settle-section",
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });
  document.querySelectorAll("section[data-panel='credit'], section[data-panel='payments']").forEach((el) => {
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });
}

function setCustomerToolbarVisible(visible) {
  ["customer-balance-hero", "customer-period-toolbar"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("hidden", !visible);
    el.hidden = !visible;
  });
}

function refreshCreditPortfolioViews() {
  if (isCustomerView()) return;
  if (listTabReady.outstanding) {
    void loadCreditLedger(true);
  } else {
    void loadPortfolioSnapshot(true);
  }
}

function invalidateAndRefreshCreditPortfolio() {
  // Invalidation reloads the open list once via bindCacheInvalidate.
  // A direct refresh here used to start a second load that could finish last.
  invalidateCreditCaches();
}

function invalidateCreditCaches() {
  creditPagination.openCreditTotal = null;
  if (typeof AppCache !== "undefined" && AppCache && typeof CacheInvalidation !== "undefined") {
    if (typeof CacheInvalidation.invalidateMultiple === "function") {
      CacheInvalidation.invalidateMultiple(["credit", "operational"]);
    } else {
      CacheInvalidation.invalidate("credit");
      CacheInvalidation.invalidate("operational");
    }
  }
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
}

function initPaginationControls() {
  mountLoadMorePager(document.querySelector("#credit-panel-outstanding"), {
    infoId: "credit-pagination-info",
    buttonId: "credit-load-more",
    onMore: () => {
      const filtered = getFilteredLedger();
      creditPagination.offset = Math.min(creditPagination.offset + PAGE_SIZE, filtered.length);
      renderLedgerPage(false);
    },
  });
}

function ledgerRowStatus(row) {
  if (ledgerRowIsFullyCleared(row)) return "settled";
  const prepaid = ledgerRowPrepaid(row);
  const net = ledgerRowNetBalance(row);
  if (customerHasAdvance(net, prepaid)) return "advance";
  return "outstanding";
}

function ledgerRowMatchesStatusFilter(row, filter = creditPagination.statusFilter) {
  const status = ledgerRowStatus(row);
  if (filter === "all") return isAdmin || status !== "settled";
  if (filter === "open") return status === "outstanding" || status === "advance";
  if (filter === "outstanding") return status === "outstanding";
  if (filter === "advance") return status === "advance";
  if (filter === "settled") return isAdmin && status === "settled";
  return ledgerRowIsListed(row);
}

function compareLedgerLastPaid(a, b) {
  const aPay = a.last_payment || "";
  const bPay = b.last_payment || "";
  if (!aPay && !bPay) return 0;
  if (!aPay) return 1;
  if (!bPay) return -1;
  return aPay.localeCompare(bPay);
}

function sortLedgerRows(rows, sortBy = creditPagination.sortBy) {
  const sorted = rows.slice();
  sorted.sort((a, b) => {
    const aNet = ledgerRowNetBalance(a);
    const bNet = ledgerRowNetBalance(b);
    const aPrepaid = ledgerRowPrepaid(a);
    const bPrepaid = ledgerRowPrepaid(b);
    const aAbs = customerHasAdvance(aNet, aPrepaid) ? aPrepaid : Math.max(0, aNet);
    const bAbs = customerHasAdvance(bNet, bPrepaid) ? bPrepaid : Math.max(0, bNet);

    if (sortBy === "name") {
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""), undefined, {
        sensitivity: "base",
      });
    }
    if (sortBy === "last-paid-asc") return compareLedgerLastPaid(a, b);
    if (sortBy === "last-paid-desc") return compareLedgerLastPaid(b, a);
    if (sortBy === "balance-asc") {
      if (aAbs !== bAbs) return aAbs - bAbs;
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""), undefined, {
        sensitivity: "base",
      });
    }
    // balance-desc (default)
    if (aAbs !== bAbs) return bAbs - aAbs;
    return String(a.customer_name || "").localeCompare(String(b.customer_name || ""), undefined, {
      sensitivity: "base",
    });
  });
  return sorted;
}

function daysSinceDateString(dateStr) {
  if (!dateStr || typeof getLocalDateString !== "function") return null;
  const today = getLocalDateString();
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${today}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.round((end - start) / 86400000);
}

function formatLedgerLastPaid(dateStr) {
  if (!dateStr) {
    return { text: "Never", title: "No payment recorded", className: "muted" };
  }
  const days = daysSinceDateString(dateStr);
  const absolute = formatDisplayDate(dateStr);
  if (days == null) {
    return { text: absolute, title: absolute, className: "" };
  }
  if (days <= 0) {
    return { text: "Today", title: absolute, className: "" };
  }
  if (days === 1) {
    return { text: "Yesterday", title: absolute, className: "" };
  }
  if (days < 30) {
    return {
      text: `${days} days ago`,
      title: absolute,
      className: days >= 14 ? "muted" : "",
    };
  }
  return {
    text: absolute,
    title: absolute,
    className: "",
  };
}

function getFilteredLedger() {
  const q = creditPagination.searchQuery;
  const selected = creditSearchState.selected;
  if (selected && normCustomerName(q) === selected.nameNorm) {
    const listed = creditPagination.ledgerData.filter(
      (row) => selected.ids.has(row.id) || normCustomerName(row.customer_name) === selected.nameNorm
    );
    return sortLedgerRows(listed);
  }
  let listed = creditPagination.ledgerData.filter((row) => ledgerRowMatchesStatusFilter(row));
  if (q) {
    const needle = q.toLowerCase();
    const phoneKeys = creditPagination.phoneMatchKeys;
    listed = listed.filter((row) => {
      const name = (row.customer_name || "").toLowerCase();
      const vehicle = (row.vehicle_no || "").toLowerCase();
      if (name.includes(needle) || vehicle.includes(needle)) return true;
      if (!phoneKeys) return false;
      return phoneKeys.ids.has(row.id) || phoneKeys.names.has(normCustomerName(row.customer_name));
    });
  }
  return sortLedgerRows(listed);
}

function updateSummaryStats(portfolioTotal = null) {
  const withBalance = creditPagination.ledgerData.filter((r) => ledgerRowMatchesStatusFilter(r, "open"));
  const total =
    portfolioTotal != null
      ? Number(portfolioTotal) || 0
      : withBalance.reduce((s, r) => s + Math.max(0, ledgerRowNetBalance(r)), 0);
  const totalEl = document.getElementById("credit-total-outstanding");
  const countEl = document.getElementById("credit-customer-count");
  if (totalEl) totalEl.textContent = formatCurrency(total);
  if (countEl) countEl.textContent = String(withBalance.length);
}

async function fetchOpenCreditTotal(forceReload = false, seq) {
  if (!forceReload && creditPagination.openCreditTotal != null) {
    return creditPagination.openCreditTotal;
  }
  const { data, error } = await runCreditRequest("Outstanding total", () =>
    window.supabaseClient.rpc("get_open_credit_as_of", {
      p_date: getLocalDateString(),
    })
  );
  if (error) throw error;
  if (seq != null && seq !== portfolioLoadSeq) return creditPagination.openCreditTotal;
  creditPagination.openCreditTotal = Number(data) || 0;
  return creditPagination.openCreditTotal;
}

async function fetchLedgerData(seq) {
  const { data: ledgerData, error } = await runCreditRequest("Credit ledger", () =>
    fetchAllRows(() =>
      window.supabaseClient
        .rpc("get_credit_ledger_aggregated")
        .order("customer_name", { ascending: true })
        .order("id", { ascending: true })
    )
  );
  if (error) throw error;
  if (seq != null && seq !== portfolioLoadSeq) return;
  creditPagination.ledgerData = ledgerData ?? [];
}

async function ensurePortfolioData(forceReload = false, seq) {
  if (seq != null && seq !== portfolioLoadSeq) return;
  if (forceReload) {
    creditPagination.ledgerData = [];
    creditPagination.openCreditTotal = null;
  }
  const needLedger = creditPagination.ledgerData.length === 0;
  const needTotal = creditPagination.openCreditTotal == null;
  if (!needLedger && !needTotal) return;
  await Promise.all([
    needLedger ? fetchLedgerData(seq) : Promise.resolve(),
    needTotal ? fetchOpenCreditTotal(false, seq) : Promise.resolve(),
  ]);
}

function refreshSummaryStats() {
  if (creditPagination.openCreditTotal != null) {
    updateSummaryStats(creditPagination.openCreditTotal);
    return;
  }
  void fetchOpenCreditTotal()
    .then((total) => updateSummaryStats(total))
    .catch((err) => {
      updateSummaryStats(null);
      AppError.report(err, { context: "refreshSummaryStats" });
    });
}

function flushQueuedLedgerReload() {
  if (!ledgerReloadQueued) return;
  ledgerReloadQueued = false;
  void loadCreditLedger(true);
}

async function loadPortfolioSnapshot(forceReload = false) {
  if (creditPagination.isLoading) return;
  const seq = ++portfolioLoadSeq;
  portfolioLoadKind = "snapshot";
  creditPagination.isLoading = true;
  try {
    await ensurePortfolioData(forceReload, seq);
    if (seq !== portfolioLoadSeq) return;
    refreshSummaryStats();
  } catch (err) {
    if (seq !== portfolioLoadSeq) return;
    if (err?.code !== "CANCELLED" && !isCancelledRequestError(err)) {
      AppError.report(err, { context: "loadPortfolioSnapshot" });
    }
  } finally {
    if (seq !== portfolioLoadSeq) return;
    portfolioLoadKind = null;
    resetCreditLoadingState();
    flushQueuedLedgerReload();
  }
}

function renderLedgerBalanceCell(net, prepaid, isAdvance) {
  const display = formatCustomerBalanceDisplay(net, prepaid);
  const amountClass = isAdvance ? "credit-ledger-balance--advance" : "";
  return `<td class="num ${amountClass}" data-label="Balance" data-amount="${net}">${display}</td>`;
}

function renderLedgerCustomerCell(row, detailHref, isAdvance, isFullyCleared) {
  const advanceTag = isAdvance
    ? '<span class="badge badge--success credit-tag">Advance</span>'
    : "";
  const settledTag =
    isFullyCleared && isAdmin
      ? '<span class="badge badge--neutral credit-tag">Settled</span>'
      : "";
  return `<td data-label="Customer"><a class="customer-link" href="${detailHref}">${escapeHtml(row.customer_name)}</a>${advanceTag}${settledTag}</td>`;
}

function renderLedgerPage(resetTable) {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody) return;

  const filtered = getFilteredLedger();
  creditPagination.totalCount = filtered.length;
  refreshSummaryStats();

  if (filtered.length === 0) {
    let msg;
    if (creditPagination.searchQuery) {
      msg = "No matching credit customers.";
    } else if (creditPagination.ledgerData.length === 0) {
      msg = "No credit customers yet.";
    } else if (creditPagination.statusFilter === "settled") {
      msg = "No settled customers.";
    } else if (creditPagination.statusFilter === "advance") {
      msg = "No customers with advance balance.";
    } else if (creditPagination.statusFilter === "outstanding") {
      msg = "No customers with an amount due.";
    } else {
      msg = "No customers in this list.";
    }
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>${escapeHtml(msg)}</p>${
      creditPagination.searchQuery || creditPagination.statusFilter !== "outstanding"
        ? ""
        : '<p class="empty-cta"><a href="#record">Record credit sale</a>.</p>'
    }</div></td></tr>`;
    creditPagination.hasMore = false;
    updatePaginationUI(filtered);
    return;
  }

  if (resetTable) {
    tbody.innerHTML = "";
    creditPagination.offset = 0;
  }

  const sliceStart = creditPagination.offset;
  const sliceEnd = sliceStart + PAGE_SIZE;
  const rowsToShow = filtered.slice(sliceStart, sliceEnd);

  rowsToShow.forEach((row) => {
    const tr = document.createElement("tr");
    const detailHref = customerDetailUrl(row);
    const prepaid = ledgerRowPrepaid(row);
    const net = ledgerRowNetBalance(row);
    const isAdvance = customerHasAdvance(net, prepaid);
    const isFullyCleared = ledgerRowIsFullyCleared(row);
    const lastPaid = formatLedgerLastPaid(row.last_payment);
    tr.className = "credit-ledger-row";
    tr.dataset.href = detailHref;
    tr.innerHTML = `
      ${renderLedgerCustomerCell(row, detailHref, isAdvance, isFullyCleared)}
      <td data-label="Vehicle">${escapeHtml(row.vehicle_no ?? "—")}</td>
      ${renderLedgerBalanceCell(net, prepaid, isAdvance)}
      <td data-label="Last paid" class="${lastPaid.className}" title="${escapeHtml(lastPaid.title)}">${escapeHtml(lastPaid.text)}</td>
      <td class="table-actions" data-label=""><a class="button-secondary button-small" href="${detailHref}">View details</a></td>
    `;
    tbody.appendChild(tr);
  });

  creditPagination.hasMore = sliceEnd < filtered.length;
  updatePaginationUI(filtered);
}

async function loadCreditLedger(reset = false) {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody) return;
  if (creditPagination.isLoading) {
    // Overview's snapshot holds the flag. Remember the ledger request so the
    // table does not stay on "Loading…" after that snapshot finishes.
    if (portfolioLoadKind !== "ledger") ledgerReloadQueued = true;
    return;
  }
  ledgerReloadQueued = false;
  const seq = ++portfolioLoadSeq;
  portfolioLoadKind = "ledger";
  creditPagination.isLoading = true;

  if (reset) {
    creditPagination.offset = 0;
    tbody.innerHTML = "<tr><td colspan='5' class='muted'>Fetching credit ledger…</td></tr>";
  }

  const loadMoreBtn = document.getElementById("credit-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    if (reset || creditPagination.ledgerData.length === 0 || creditPagination.openCreditTotal == null) {
      try {
        await ensurePortfolioData(reset, seq);
      } catch (error) {
        if (seq !== portfolioLoadSeq) return;
        if (error?.code === "CANCELLED" || isCancelledRequestError(error)) return;
        renderCreditRetryRow(AppError.getUserMessage(error), () => loadCreditLedger(true));
        AppError.report(error, { context: "loadCreditLedger" });
        return;
      }
    }

    if (seq !== portfolioLoadSeq) return;
    creditPagination.offset = reset ? 0 : creditPagination.offset;
    renderLedgerPage(true);
    outstandingLedgerShown = true;
  } catch (err) {
    if (seq !== portfolioLoadSeq) return;
    if (err?.code === "CANCELLED" || isCancelledRequestError(err)) return;
    renderCreditRetryRow(AppError.getUserMessage(err), () => loadCreditLedger(true));
    AppError.report(err, { context: "loadCreditLedger" });
  } finally {
    if (seq !== portfolioLoadSeq) return;
    portfolioLoadKind = null;
    resetCreditLoadingState();
    flushQueuedLedgerReload();
  }
}

function updatePaginationUI(filtered = getFilteredLedger()) {
  const shown = Math.min(creditPagination.offset + PAGE_SIZE, filtered.length);
  syncLoadMorePager({
    info: document.getElementById("credit-pagination-info"),
    extraInfo: document.getElementById("credit-ledger-summary"),
    button: document.getElementById("credit-load-more"),
    shown,
    total: filtered.length,
    hasMore: creditPagination.hasMore && shown < filtered.length,
    noun: "customers",
  });
}

const listTabReady = { overview: false, record: false, outstanding: false, aging: false };

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCreditLedgerCsv() {
  const rows = getFilteredLedger();
  const lines = [
    ["Customer", "Vehicle", "Amount due", "Advance", "Net", "Last paid"].map(csvCell).join(","),
  ];
  rows.forEach((row) => {
    const due = ledgerRowAmountDue(row);
    const prepaid = ledgerRowPrepaid(row);
    lines.push(
      [row.customer_name, row.vehicle_no || "", due.toFixed(2), prepaid.toFixed(2), (due - prepaid).toFixed(2), row.last_payment || ""]
        .map(csvCell)
        .join(",")
    );
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `credit-ledger-${getLocalDateString()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const CREDIT_AGING_BUCKETS = [
  { key: "0-30", id: "0-30" },
  { key: "31-60", id: "31-60" },
  { key: "61-90", id: "61-90" },
  { key: "90+", id: "90plus" },
];

function renderCreditAgingRows(rows) {
  return rows
    .map((row) => {
      const href = customerDetailUrl({ id: row.customer_id, customer_name: row.customer_name });
      return `<tr class="credit-ledger-row" data-href="${href}">
          <td data-label="Customer"><a class="customer-link" href="${href}">${escapeHtml(row.customer_name)}</a></td>
          <td data-label="Oldest bill">${escapeHtml(formatDisplayDate(row.oldest_unpaid))}</td>
          <td data-label="Age">${escapeHtml(String(row.age_days))} days</td>
          <td class="num" data-label="Open (₹)">${formatCurrency(row.open_amount)}</td>
        </tr>`;
    })
    .join("");
}

function renderCreditAgingBucket(bucketId, rows) {
  const el = document.getElementById(`credit-aging-body-${bucketId}`);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<p class="credit-aging-empty">No unpaid bills in this period.</p>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap">
      <table class="credit-ledger-table credit-aging-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Oldest bill</th>
            <th>Age</th>
            <th class="num">Open (₹)</th>
          </tr>
        </thead>
        <tbody>${renderCreditAgingRows(rows)}</tbody>
      </table>
    </div>`;
}

async function loadCreditAging() {
  const status = document.getElementById("credit-aging-status");
  const groups = document.getElementById("credit-aging-groups");
  if (!groups) return;
  if (status) {
    status.hidden = false;
    status.classList.remove("error");
    status.textContent = "Loading…";
  }
  groups.setAttribute("aria-busy", "true");
  try {
    const { data, error } = await window.supabaseClient.rpc("get_credit_aging", {
      p_as_of: getLocalDateString(),
    });
    if (error) throw error;
    const grouped = { "0-30": [], "31-60": [], "61-90": [], "90+": [] };
    const totals = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    (data || []).forEach((row) => {
      const bucket = row.bucket;
      if (!grouped[bucket]) return;
      grouped[bucket].push(row);
      totals[bucket] += Number(row.open_amount) || 0;
    });
    CREDIT_AGING_BUCKETS.forEach(({ key, id }) => {
      const el = document.getElementById(`credit-aging-${id}`);
      if (el) el.textContent = formatCurrency(totals[key]);
      grouped[key].sort((a, b) => {
        const byAge = (Number(b.age_days) || 0) - (Number(a.age_days) || 0);
        if (byAge) return byAge;
        return String(a.customer_name || "").localeCompare(String(b.customer_name || ""), undefined, {
          sensitivity: "base",
        });
      });
      renderCreditAgingBucket(id, grouped[key]);
    });
    if (status) status.hidden = true;
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.classList.add("error");
      status.textContent = AppError.getUserMessage(err);
    }
    AppError.report(err, { context: "loadCreditAging" });
  } finally {
    groups.removeAttribute("aria-busy");
  }
}

async function runCreditBalanceCheck() {
  const out = document.getElementById("credit-balance-check-result");
  if (out) out.textContent = "Checking…";
  try {
    const { data, error } = await window.supabaseClient.rpc("check_credit_balances");
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) {
      if (out) out.textContent = "Stored balances match the entries.";
      return;
    }
    if (out) {
      out.textContent = rows
        .map(
          (row) =>
            `${row.customer_name}: ${row.issue} (stored due ${row.stored_due}, book due ${row.book_due})`
        )
        .join("\n");
    }
  } catch (err) {
    if (out) out.textContent = AppError.getUserMessage(err);
    AppError.report(err, { context: "checkCreditBalances" });
  }
}

async function loadCreditModule(src) {
  if (typeof loadScript !== "function") {
    throw new Error("loadScript is unavailable");
  }
  await loadScript(src);
}

async function ensureListTab(section) {
  try {
    if (section === "outstanding") {
      if (!listTabReady.outstanding) {
        initOutstandingTab();
        listTabReady.outstanding = true;
      } else if (!outstandingLedgerShown) {
        void loadCreditLedger(true);
      }
      return;
    }
    if (section === "aging") {
      if (!listTabReady.aging) {
        document.getElementById("credit-aging-refresh")?.addEventListener("click", () => {
          void loadCreditAging();
        });
        document.getElementById("credit-aging-groups")?.addEventListener("click", (event) => {
          if (event.target.closest("a, button")) return;
          const row = event.target.closest("tr.credit-ledger-row[data-href]");
          if (!row?.dataset.href) return;
          window.location.href = row.dataset.href;
        });
        listTabReady.aging = true;
      }
      void loadCreditAging();
      return;
    }
    if (listTabReady[section]) {
      if (section === "overview") void loadPortfolioSnapshot();
      return;
    }
    if (section === "overview") {
      await loadCreditModule("js/creditOverview.js");
      window.CreditOverview?.init?.();
      void loadPortfolioSnapshot();
    }
    if (section === "record") {
      await loadCreditModule("js/creditRecord.js");
      window.CreditRecord?.init?.();
    }
    listTabReady[section] = true;
  } catch (err) {
    resetCreditLoadingState();
    AppError.report(err, { context: "ensureListTab", section });
    AppError.showGlobalBanner(`${AppError.getUserMessage(err)} Refresh the page or try again.`);
  }
}

const creditSearchState = {
  seq: 0,
  matches: [],
  active: -1,
  selected: null,
};

function creditSearchMobile(mobiles, needle) {
  const digits = String(needle || "").replace(/\D/g, "");
  return (
    mobiles.find((value) => {
      const text = value.toLowerCase();
      return text.includes(String(needle || "").toLowerCase()) || (digits && value.replace(/\D/g, "").includes(digits));
    }) ||
    mobiles[0] ||
    ""
  );
}

function creditSearchSuggestions(rows, query) {
  const byName = new Map();
  for (const row of rows || []) {
    const name = String(row.customer_name ?? "").trim();
    const key = normCustomerName(name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }
  return [...byName.entries()].map(([key, groupRows]) => {
    const mobiles = [...new Set(groupRows.map((row) => String(row.mobile ?? "").trim()).filter(Boolean))];
    return {
      name: groupRows[0].customer_name.trim(),
      nameNorm: key,
      mobile: creditSearchMobile(mobiles, query),
      customerIds: groupRows.map((row) => row.id).filter(Boolean),
    };
  });
}

function setCreditSearchOpen(open) {
  const input = document.getElementById("credit-search");
  const list = document.getElementById("credit-search-suggestions");
  if (!input || !list) return;
  input.setAttribute("aria-expanded", open ? "true" : "false");
  list.classList.toggle("hidden", !open);
  list.hidden = !open;
  if (!open) creditSearchState.active = -1;
}

function renderCreditSearchSuggestions(matches, query) {
  const list = document.getElementById("credit-search-suggestions");
  if (!list) return;
  creditSearchState.matches = matches;
  creditSearchState.active = -1;
  if (!matches.length) {
    list.innerHTML = `<li class="combobox-empty" role="presentation">No matching customers</li>`;
    setCreditSearchOpen(Boolean(String(query || "").trim()));
    return;
  }
  list.innerHTML = matches
    .map((item, index) => {
      const mobile = item.mobile ? ` <span class="muted">${escapeHtml(item.mobile)}</span>` : "";
      return `<li class="combobox-option" role="option" id="credit-search-opt-${index}" data-index="${index}">${escapeHtml(item.name)}${mobile}</li>`;
    })
    .join("");
  list.querySelectorAll(".combobox-option").forEach((el) => {
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectCreditSearchSuggestion(matches[Number(el.getAttribute("data-index"))]);
    });
  });
  setCreditSearchOpen(true);
}

function highlightCreditSearchOption(index) {
  const list = document.getElementById("credit-search-suggestions");
  const input = document.getElementById("credit-search");
  if (!list) return;
  const options = list.querySelectorAll(".combobox-option");
  options.forEach((el, i) => el.classList.toggle("is-active", i === index));
  creditSearchState.active = index;
  const active = options[index];
  if (active) {
    active.scrollIntoView({ block: "nearest" });
    input?.setAttribute("aria-activedescendant", active.id);
  }
}

function selectCreditSearchSuggestion(item) {
  if (!item) return;
  const input = document.getElementById("credit-search");
  if (input) input.value = item.name;
  creditSearchState.selected = {
    nameNorm: item.nameNorm,
    ids: new Set(item.customerIds),
  };
  creditPagination.searchQuery = item.name;
  creditPagination.phoneMatchKeys = {
    ids: new Set(item.customerIds),
    names: new Set([item.nameNorm]),
  };
  creditPagination.offset = 0;
  setCreditSearchOpen(false);
  renderLedgerPage(true);
}

async function refreshCreditSearchMatches(value) {
  const query = String(value || "").trim();
  if (!query || typeof searchCreditCustomers !== "function") {
    creditPagination.phoneMatchKeys = null;
    creditSearchState.matches = [];
    setCreditSearchOpen(false);
    return;
  }
  const seq = ++creditSearchState.seq;
  const rows = await searchCreditCustomers(query);
  if (seq !== creditSearchState.seq || creditPagination.searchQuery !== query) return;
  const matches = creditSearchSuggestions(rows, query);
  creditPagination.phoneMatchKeys = {
    ids: new Set(rows.map((row) => row.id)),
    names: new Set(matches.map((item) => item.nameNorm)),
  };
  const input = document.getElementById("credit-search");
  if (input && document.activeElement === input && creditPagination.searchQuery === query) {
    renderCreditSearchSuggestions(matches, query);
  }
}

function initOutstandingTab() {
  initPaginationControls();
  const input = document.getElementById("credit-search");
  const list = document.getElementById("credit-search-suggestions");
  const onCreditSearch = debounce((value) => {
    creditPagination.searchQuery = value;
    creditPagination.offset = 0;
    void refreshCreditSearchMatches(value)
      .catch((err) => {
        AppError.report(err, { context: "creditPhoneSearch" });
        creditPagination.phoneMatchKeys = null;
        setCreditSearchOpen(false);
      })
      .then(() => {
        if (creditPagination.searchQuery === value) renderLedgerPage(true);
      });
  }, 150);
  input?.addEventListener("input", (e) => {
    const value = (e.target.value || "").trim();
    if (creditSearchState.selected && normCustomerName(value) !== creditSearchState.selected.nameNorm) {
      creditSearchState.selected = null;
    }
    onCreditSearch(value);
  });
  input?.addEventListener("focus", () => {
    const value = (input.value || "").trim();
    if (value) onCreditSearch(value);
  });
  input?.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && list?.hidden && creditSearchState.matches.length) {
      renderCreditSearchSuggestions(creditSearchState.matches, input.value);
    }
    const options = list?.querySelectorAll(".combobox-option") || [];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!options.length) return;
      const next = creditSearchState.active < options.length - 1 ? creditSearchState.active + 1 : 0;
      highlightCreditSearchOption(next);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      const prev = creditSearchState.active > 0 ? creditSearchState.active - 1 : options.length - 1;
      highlightCreditSearchOption(prev);
      return;
    }
    if (event.key === "Enter" && creditSearchState.active >= 0 && list && !list.hidden) {
      event.preventDefault();
      selectCreditSearchSuggestion(creditSearchState.matches[creditSearchState.active]);
      return;
    }
    if (event.key === "Escape") setCreditSearchOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!document.getElementById("credit-search-combobox")?.contains(event.target)) setCreditSearchOpen(false);
  });

  const statusFilter = document.getElementById("credit-status-filter");
  if (statusFilter && !isAdmin) {
    statusFilter.querySelectorAll("[data-role='admin-only']").forEach((opt) => opt.remove());
  }
  statusFilter?.addEventListener("change", (e) => {
    creditPagination.statusFilter = e.target.value || "outstanding";
    creditPagination.offset = 0;
    renderLedgerPage(true);
  });

  document.getElementById("credit-export-csv")?.addEventListener("click", () => {
    exportCreditLedgerCsv();
  });
  document.getElementById("credit-balance-check")?.addEventListener("click", () => {
    void runCreditBalanceCheck();
  });

  document.getElementById("credit-sort")?.addEventListener("change", (e) => {
    creditPagination.sortBy = e.target.value || "balance-desc";
    creditPagination.offset = 0;
    renderLedgerPage(true);
  });

  const tbody = document.getElementById("credit-table-body");
  tbody?.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    const row = e.target.closest("tr.credit-ledger-row[data-href]");
    if (!row?.dataset.href) return;
    window.location.href = row.dataset.href;
  });

  void loadCreditLedger(true);
}

async function ensureCreditCustomer() {
  await loadCreditModule("js/creditCustomerDetail.js");
  await loadCreditModule("js/creditCustomer.js");
  return window.CreditCustomer.init();
}

window.CreditPage = {
  state: creditState,
  get isAdmin() { return isAdmin; },
  isCustomerView,
  setSidebarMode,
  setCustomerToolbarVisible,
  hideCustomerPanels,
  customerDetailUrl,
  customerSummaryUrl,
  formatCustomerBalanceDisplay,
  customerHasAdvance,
  getCustomerBalanceLabel,
  applyCustomerBalanceHero,
  updateCustomerBalanceState,
  invalidateCreditCaches,
  invalidateAndRefreshCreditPortfolio,
  refreshCreditPortfolioViews,
};

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    pageName: "credit",
  });
  if (!auth) return;

  isAdmin = auth.role === "admin";
  applyRoleVisibility(auth.role);

  const params = new URLSearchParams(window.location.search);
  creditState.customerName = (params.get("name") || params.get("customer_name") || "").trim();
  creditState.customerId = params.get("id") || params.get("customer_id") || null;
  if (!creditState.customerId) {
    const legacyCustomer = (params.get("customer") || "").trim();
    if (/^[0-9a-f-]{36}$/i.test(legacyCustomer)) creditState.customerId = legacyCustomer;
    else if (!creditState.customerName && legacyCustomer) creditState.customerName = legacyCustomer;
  }

  try {
    if (isCustomerView()) {
      await ensureCreditCustomer();
      return;
    }

    initListView();
  } catch (err) {
    resetCreditLoadingState();
    AppError.report(err, { context: "creditPageInit" });
    AppError.showGlobalBanner(`${AppError.getUserMessage(err)} Pull down to refresh or reopen the page.`);
  }
});

const creditLiveRefreshMatch = () =>
  document.body.classList.contains("credit-list-view") ||
  document.body.classList.contains("credit-customer-view");

bindAppResume(refreshCreditOnVisible, { match: creditLiveRefreshMatch });
bindCacheInvalidate((event) => {
  // This page reloads the open customer after a write. Reloading again from
  // the same local event races that reload and can paint older rows.
  if (event?.detail?.local && isCustomerView()) return;
  refreshCreditOnVisible();
}, { match: creditLiveRefreshMatch });