/* global window.supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, initPageSections, debounce, setFilterState, CacheInvalidation */

const PAGE_SIZE = 25;

let creditPagination = {
  offset: 0,
  hasMore: true,
  totalCount: 0,
  isLoading: false,
  ledgerData: [],
  searchQuery: "",
  openCreditTotal: null,
  sortBy: "balance-desc",
  statusFilter: "open",
};


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
  lastCustomerSummaryContext: null,
  creditSummaryPrintBusy: false,
};

function creditEntryOutstanding(row) {
  return Math.max(0, Number(row?.amount ?? 0) - Number(row?.amount_settled ?? 0));
}

function isCustomerView() {
  return Boolean(creditState.customerName);
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
  const name = row.customer_name || row || "";
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

function initListView() {
  setSidebarMode("list");
  setCustomerToolbarVisible(false);
  hideCustomerPanels();

  if (typeof initPageSections === "function") {
    initPageSections({
      navItemSelector: "#credit-list-nav .settings-nav-item",
      panelSelector: "#credit-panel-overview, #credit-panel-record, #credit-panel-outstanding",
      defaultSection: "overview",
      validSections: ["overview", "record", "outstanding"],
      onSectionChange: (section) => {
        void ensureListTab(section);
      },
    });
  }

  const hash = (location.hash || "").replace(/^#/, "");
  const initial = ["overview", "record", "outstanding"].includes(hash) ? hash : "overview";
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
  if (window.CreditOverview?.isReady?.()) window.CreditOverview.refresh();
}

function invalidateAndRefreshCreditPortfolio() {
  invalidateCreditCaches();
  refreshCreditPortfolioViews();
}

function invalidateCreditCaches() {
  creditPagination.openCreditTotal = null;
  if (typeof AppCache !== "undefined" && AppCache) {
    CacheInvalidation.invalidate("credit");
    CacheInvalidation.invalidate("operational");
  }
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
}

function initPaginationControls() {
  const tableSection = document.querySelector("#credit-panel-outstanding");
  if (!tableSection || tableSection.querySelector(".pagination-controls")) return;

  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="credit-pagination-info" class="muted"></span>
    </div>
    <button id="credit-load-more" class="button-secondary hidden">Load more</button>
  `;
  tableSection.appendChild(paginationDiv);
  document.getElementById("credit-load-more")?.addEventListener("click", () => {
    const filtered = getFilteredLedger();
    creditPagination.offset = Math.min(
      creditPagination.offset + PAGE_SIZE,
      filtered.length
    );
    renderLedgerPage(false);
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
  let listed = creditPagination.ledgerData.filter((row) => ledgerRowMatchesStatusFilter(row));
  if (q) {
    const needle = q.toLowerCase();
    listed = listed.filter((row) => {
      const name = (row.customer_name || "").toLowerCase();
      const vehicle = (row.vehicle_no || "").toLowerCase();
      return name.includes(needle) || vehicle.includes(needle);
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

async function fetchOpenCreditTotal(forceReload = false) {
  if (!forceReload && creditPagination.openCreditTotal != null) {
    return creditPagination.openCreditTotal;
  }
  const { data, error } = await runCreditRequest("Outstanding total", () =>
    window.supabaseClient.rpc("get_open_credit_as_of", {
      p_date: getLocalDateString(),
    })
  );
  if (error) throw error;
  creditPagination.openCreditTotal = Number(data) || 0;
  return creditPagination.openCreditTotal;
}

async function fetchLedgerData() {
  const { data: ledgerData, error } = await runCreditRequest("Credit ledger", () =>
    window.supabaseClient.rpc("get_credit_ledger_aggregated")
  );
  if (error) throw error;
  creditPagination.ledgerData = ledgerData ?? [];
}

async function ensurePortfolioData(forceReload = false) {
  if (forceReload) {
    creditPagination.ledgerData = [];
    creditPagination.openCreditTotal = null;
  }
  const needLedger = creditPagination.ledgerData.length === 0;
  const needTotal = creditPagination.openCreditTotal == null;
  if (!needLedger && !needTotal) return;
  await Promise.all([
    needLedger ? fetchLedgerData() : Promise.resolve(),
    needTotal ? fetchOpenCreditTotal() : Promise.resolve(),
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

async function loadPortfolioSnapshot(forceReload = false) {
  if (creditPagination.isLoading) return;
  creditPagination.isLoading = true;
  try {
    await ensurePortfolioData(forceReload);
    refreshSummaryStats();
  } catch (err) {
    if (err?.code !== "CANCELLED" && !isCancelledRequestError(err)) {
      AppError.report(err, { context: "loadPortfolioSnapshot" });
    }
  } finally {
    resetCreditLoadingState();
  }
}

function renderLedgerBalanceCell(net, prepaid, isAdvance) {
  const display = formatCustomerBalanceDisplay(net, prepaid);
  const amountClass = isAdvance ? "credit-ledger-balance--advance" : "";
  return `<td class="num ${amountClass}" data-amount="${net}">${display}</td>`;
}

function renderLedgerCustomerCell(row, detailHref, isAdvance, isFullyCleared) {
  const advanceTag = isAdvance
    ? '<span class="credit-advance-tag">Advance</span>'
    : "";
  const settledTag =
    isFullyCleared && isAdmin
      ? '<span class="credit-settled-tag">Settled</span>'
      : "";
  return `<td><a class="customer-link" href="${detailHref}">${escapeHtml(row.customer_name)}</a>${advanceTag}${settledTag}</td>`;
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
      msg = "No customers with outstanding balance.";
    } else {
      msg = "No open balances — all customers are cleared.";
    }
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>${escapeHtml(msg)}</p>${
      creditPagination.searchQuery || creditPagination.statusFilter !== "open"
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
      <td>${escapeHtml(row.vehicle_no ?? "—")}</td>
      ${renderLedgerBalanceCell(net, prepaid, isAdvance)}
      <td class="${lastPaid.className}" title="${escapeHtml(lastPaid.title)}">${escapeHtml(lastPaid.text)}</td>
      <td class="table-actions"><a class="button-secondary button-small" href="${detailHref}">View details</a></td>
    `;
    tbody.appendChild(tr);
  });

  creditPagination.hasMore = sliceEnd < filtered.length;
  updatePaginationUI(filtered);
}

async function loadCreditLedger(reset = false) {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody || creditPagination.isLoading) return;
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
        await ensurePortfolioData(reset);
      } catch (error) {
        if (error?.code === "CANCELLED" || isCancelledRequestError(error)) return;
        renderCreditRetryRow(AppError.getUserMessage(error), () => loadCreditLedger(true));
        AppError.report(error, { context: "loadCreditLedger" });
        return;
      }
    }

    creditPagination.offset = reset ? 0 : creditPagination.offset;
    renderLedgerPage(true);
  } catch (err) {
    if (err?.code === "CANCELLED" || isCancelledRequestError(err)) return;
    renderCreditRetryRow(AppError.getUserMessage(err), () => loadCreditLedger(true));
    AppError.report(err, { context: "loadCreditLedger" });
  } finally {
    resetCreditLoadingState();
  }
}

function updatePaginationUI(filtered = getFilteredLedger()) {
  const loadMoreBtn = document.getElementById("credit-load-more");
  const paginationInfo = document.getElementById("credit-pagination-info");
  const summaryEl = document.getElementById("credit-ledger-summary");

  const showing = Math.min(creditPagination.offset + PAGE_SIZE, filtered.length);

  const infoText =
    filtered.length > 0 ? `Showing ${Math.min(showing, filtered.length)} of ${filtered.length} customers` : "";

  if (paginationInfo) paginationInfo.textContent = infoText;
  if (summaryEl) summaryEl.textContent = infoText;

  if (loadMoreBtn) {
    if (creditPagination.hasMore && creditPagination.offset + PAGE_SIZE < filtered.length) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
}

const listTabReady = { overview: false, record: false, outstanding: false };

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
      }
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

function initOutstandingTab() {
  initPaginationControls();
  const onCreditSearch = debounce((value) => {
    creditPagination.searchQuery = value;
    creditPagination.offset = 0;
    renderLedgerPage(true);
  }, 150);
  document.getElementById("credit-search")?.addEventListener("input", (e) => {
    onCreditSearch((e.target.value || "").trim().toLowerCase());
  });

  const statusFilter = document.getElementById("credit-status-filter");
  if (statusFilter && !isAdmin) {
    statusFilter.querySelectorAll("[data-role='admin-only']").forEach((opt) => opt.remove());
  }
  statusFilter?.addEventListener("change", (e) => {
    creditPagination.statusFilter = e.target.value || "open";
    creditPagination.offset = 0;
    renderLedgerPage(true);
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
  await loadCreditModule("js/creditCustomer.js?v=16");
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
  creditState.customerName = (params.get("name") || "").trim();
  creditState.customerId = params.get("id") || null;

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

bindLiveRefresh(refreshCreditOnVisible, {
  match: () =>
    document.body.classList.contains("credit-list-view") ||
    document.body.classList.contains("credit-customer-view"),
});