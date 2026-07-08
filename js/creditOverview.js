/* global supabaseClient, formatCurrency, AppCache, AppError, escapeHtml, createDateRangeFilter, readDateRangeFromControls, setFilterState, getRangeForSelection */

(function () {
  const page = () => window.CreditPage;
  let overviewRequestId = 0;
  let ready = false;
  const OVERVIEW_EMPTY = Object.freeze({ credit_taken: 0, settled: 0, overdue: 0, customers: [] });

function readOverviewDateRange() {
  return readDateRangeFromControls(
    document.getElementById("credit-overview-range"),
    document.getElementById("credit-overview-start"),
    document.getElementById("credit-overview-end")
  );
}

function getOverviewFilterForLinks() {
  const resolved = readOverviewDateRange();
  if (!resolved) return null;
  return {
    period: resolved.modeInfo?.mode || "custom",
    from: resolved.start,
    to: resolved.end,
  };
}

function getOverviewDateRange() {
  const range = readOverviewDateRange();
  if (range) return { start: range.start, end: range.end };
  const fallback = getRangeForSelection("all-time");
  return { start: fallback.start, end: fallback.end };
}

function initOverviewPanel() {
  createDateRangeFilter({
    storageKey: "credit_overview_period",
    ranges: ["today", "this-week", "this-month", "all-time", "custom"],
    defaultRange: "all-time",
    rangeSelect: "credit-overview-range",
    startInput: "credit-overview-start",
    endInput: "credit-overview-end",
    customRange: "credit-overview-custom-range",
    applyBtn: "credit-overview-apply-filter",
    trigger: "apply",
    runOnInit: true,
    onApply: () => loadOverviewPeriodActivity(),
  });
}

function overviewPeriodOutstanding(creditTaken, settled) {
  return (Number(creditTaken) || 0) - (Number(settled) || 0);
}

function normalizeOverviewPeriodData(raw) {
  if (!raw || typeof raw !== "object") return { ...OVERVIEW_EMPTY, customers: [] };
  const creditTaken = Number(raw.credit_taken) || 0;
  const settled = Number(raw.settled) || 0;
  const customers = Array.isArray(raw.customers)
    ? raw.customers.map((row) => {
        const rowCredit = Number(row.credit_taken) || 0;
        const rowSettled = Number(row.settled) || 0;
        return {
          ...row,
          credit_taken: rowCredit,
          settled: rowSettled,
          overdue: overviewPeriodOutstanding(rowCredit, rowSettled),
        };
      })
    : [];
  return {
    credit_taken: creditTaken,
    settled,
    overdue: overviewPeriodOutstanding(creditTaken, settled),
    customers,
  };
}

function overviewCacheKey(start, end) {
  return `credit_overview_${start || "all"}_${end}`;
}

function applyOverviewPeriodData(data, periodFilter = getOverviewFilterForLinks()) {
  const tbody = document.getElementById("credit-overview-body");
  const emptyCta = document.getElementById("credit-overview-empty");
  const tableEl = tbody?.closest("table");
  if (!tbody) return;

  const normalized = normalizeOverviewPeriodData(data);
  setOverviewPeriodStats(normalized.credit_taken, normalized.settled, normalized.overdue);

  if (!normalized.customers.length) {
    tbody.innerHTML = "";
    tableEl?.classList.add("hidden");
    emptyCta?.classList.remove("hidden");
    return;
  }

  renderOverviewCustomerRows(tbody, normalized.customers, periodFilter);
  tableEl?.classList.remove("hidden");
  emptyCta?.classList.add("hidden");
}

function renderOverviewCustomerRows(tbody, rows, periodFilter) {
  tbody.innerHTML = rows
    .map((row) => {
      const detailHref = page().customerSummaryUrl(row.customer_name, periodFilter);
      const isOverpaid = row.overdue < 0;
      const rowClass = isOverpaid ? ' class="credit-overview-row--overpaid"' : "";
      return `<tr${rowClass}>
        <td><a class="customer-link" href="${detailHref}">${escapeHtml(row.customer_name)}</a></td>
        <td class="num">${formatCurrency(row.credit_taken)}</td>
        <td class="num${isOverpaid ? " credit-overview-settled" : ""}">${formatCurrency(row.settled)}</td>
        <td class="num credit-overview-outstanding">${formatCurrency(row.overdue)}</td>
      </tr>`;
    })
    .join("");
}

function setOverviewPeriodStats(creditTaken, settled, overdue) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatCurrency(value);
  };
  set("credit-overview-credit-taken", creditTaken);
  set("credit-overview-settled", settled);
  set("credit-overview-overdue", overdue);
}

async function loadOverviewPeriodActivity() {
  const tbody = document.getElementById("credit-overview-body");
  const emptyCta = document.getElementById("credit-overview-empty");
  const tableEl = tbody?.closest("table");
  if (!tbody) return;

  const { start, end } = getOverviewDateRange();
  const periodFilter = getOverviewFilterForLinks();
  const requestId = ++overviewRequestId;
  const cacheKey = overviewCacheKey(start, end);
  const cached =
    typeof AppCache !== "undefined" && AppCache?.get ? AppCache.get(cacheKey) : null;
  const hasCached = cached && !cached.isMiss && cached.data;

  if (hasCached) {
    applyOverviewPeriodData(cached.data, periodFilter);
  } else {
    tbody.innerHTML = "<tr><td colspan='4' class='muted'>Loading…</td></tr>";
    emptyCta?.classList.add("hidden");
    tableEl?.classList.remove("hidden");
  }

  try {
    const fetchFn = async () => {
      const { data, error } = await supabaseClient.rpc("get_credit_overview_period", {
        p_from: start || null,
        p_to: end,
      });
      if (error) throw error;
      return data;
    };

    let data;
    if (typeof AppCache !== "undefined" && AppCache?.getWithSWR) {
      data = await AppCache.getWithSWR(cacheKey, fetchFn, "credit_overview", (fresh) => {
        if (requestId !== overviewRequestId) return;
        applyOverviewPeriodData(fresh, periodFilter);
      });
    } else {
      data = await fetchFn();
    }

    if (requestId !== overviewRequestId) return;
    if (!hasCached) applyOverviewPeriodData(data, periodFilter);
  } catch (err) {
    if (requestId !== overviewRequestId) return;
    tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    AppError.report(err, { context: "loadOverviewPeriodActivity" });
  }
}

  function init() {
    if (ready) return;
    initOverviewPanel();
    ready = true;
  }

  window.CreditOverview = {
    init,
    isReady: () => ready,
    refresh: () => {
      void loadOverviewPeriodActivity();
    },
  };
})();
