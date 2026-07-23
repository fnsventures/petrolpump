/* global supabaseClient, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, createDateRangeFilter, readDateRangeFromControls, setFilterState, getRangeForSelection, formatDateRangeLabel, formatNumberPlain, PumpSettings, loadPumpSettings, PrintUtils, loadScript */

(function () {
  const page = () => window.CreditPage;
  let overviewRequestId = 0;
  let ready = false;
  let overviewPrintBusy = false;
  let lastOverviewData = null;
  let lastOverviewPeriodLabel = "";
  const OVERVIEW_EMPTY = Object.freeze({ credit_taken: 0, settled: 0, overdue: 0, customers: [] });
  const CREDIT_OVERVIEW_PRINT_CSS = "css/credit-summary-print.css?v=2";

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

function getOverviewPeriodLabel() {
  const range = readOverviewDateRange();
  if (!range) return "All time";
  return formatDateRangeLabel(range, range.modeInfo, { style: "dashboard" });
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

  document.getElementById("credit-overview-print-btn")?.addEventListener("click", () => {
    void handleOverviewPrintClick();
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

function updateOverviewPrintButton() {
  const btn = document.getElementById("credit-overview-print-btn");
  if (!btn) return;
  btn.disabled = overviewPrintBusy || !lastOverviewData?.customers?.length;
}

function applyOverviewPeriodData(data, periodFilter = getOverviewFilterForLinks()) {
  const tbody = document.getElementById("credit-overview-body");
  const emptyCta = document.getElementById("credit-overview-empty");
  const tableEl = tbody?.closest("table");
  if (!tbody) return;

  const normalized = normalizeOverviewPeriodData(data);
  lastOverviewData = normalized;
  lastOverviewPeriodLabel = getOverviewPeriodLabel();
  setOverviewPeriodStats(normalized.credit_taken, normalized.settled, normalized.overdue);
  updateOverviewPrintButton();

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
    lastOverviewData = null;
    updateOverviewPrintButton();
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
    lastOverviewData = null;
    updateOverviewPrintButton();
    tbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    AppError.report(err, { context: "loadOverviewPeriodActivity" });
  }
}

function overviewReportHeader(title, subtitleLines) {
  const gstin = PumpSettings.getStationGstin();
  const subtitles = (subtitleLines || [])
    .filter(Boolean)
    .map((line) => `<p class="report-subtitle">${line}</p>`)
    .join("");
  return `
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
          ${gstin ? `<p class="report-gstin">GSTIN: ${escapeHtml(gstin)}</p>` : ""}
          <p class="report-title">${escapeHtml(title)}</p>
          ${subtitles}
        </div>
      </div>
    </header>`;
}

function buildOverviewCustomerPrintRows(customers) {
  if (!customers.length) {
    return `<tr><td colspan="5" class="muted" style="text-align:center">No credit activity for this period</td></tr>`;
  }
  return customers
    .map((row, i) => {
      const outstanding = Number(row.overdue) || 0;
      const outstandingClass = outstanding < 0 ? ' class="num credit-overview-print-overpaid"' : ' class="num"';
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(row.customer_name)}</td>
          <td class="num">₹ ${formatNumberPlain(row.credit_taken)}</td>
          <td class="num">₹ ${formatNumberPlain(row.settled)}</td>
          <td${outstandingClass}>₹ ${formatNumberPlain(outstanding)}</td>
        </tr>`;
    })
    .join("");
}

function buildOverviewPrintHtml(data, periodLabel) {
  const generatedOn = formatDisplayDate(getLocalDateString());
  const period = periodLabel || "All time";
  const creditTaken = Number(data.credit_taken) || 0;
  const settled = Number(data.settled) || 0;
  const outstanding = Number(data.overdue) || 0;
  const customers = Array.isArray(data.customers) ? data.customers : [];
  const customerCount = customers.length;

  return `
    <article class="credit-summary-sheet report-print-sheet credit-overview-print-sheet">
      ${overviewReportHeader("Credit overview — customer list", [
        `Period: <strong>${escapeHtml(period)}</strong>`,
        `Generated: ${escapeHtml(generatedOn)} · ${customerCount} customer${customerCount === 1 ? "" : "s"}`,
      ])}

      <div class="credit-summary-title-band">
        <h2 class="credit-summary-doc-title">Period activity by customer</h2>
        <p class="credit-summary-doc-meta">
          Credit taken, settlements received, and outstanding for sales in the selected period.
        </p>
      </div>

      <div class="credit-summary-kpis">
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Credit taken</span>
          <span class="credit-summary-kpi-value">₹ ${formatNumberPlain(creditTaken)}</span>
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Settled</span>
          <span class="credit-summary-kpi-value">₹ ${formatNumberPlain(settled)}</span>
        </div>
        <div class="credit-summary-kpi credit-summary-kpi--outstanding">
          <span class="credit-summary-kpi-label">Outstanding</span>
          <span class="credit-summary-kpi-value">₹ ${formatNumberPlain(outstanding)}</span>
          <span class="credit-summary-kpi-meta">Credit taken minus settled</span>
        </div>
      </div>

      <section class="credit-summary-block">
        <h3 class="credit-summary-block-title">By customer</h3>
        <p class="credit-summary-block-lead">All customers with credit activity in ${escapeHtml(period)}.</p>
        <table class="report-table credit-overview-print-table">
          <thead>
            <tr>
              <th style="width:6%">#</th>
              <th>Customer</th>
              <th class="num">Credit taken (₹)</th>
              <th class="num">Settled (₹)</th>
              <th class="num">Outstanding (₹)</th>
            </tr>
          </thead>
          <tbody>${buildOverviewCustomerPrintRows(customers)}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td colspan="2">Total</td>
              <td class="num">₹ ${formatNumberPlain(creditTaken)}</td>
              <td class="num">₹ ${formatNumberPlain(settled)}</td>
              <td class="num">₹ ${formatNumberPlain(outstanding)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <p class="credit-summary-note">
        Computer-generated credit overview. Outstanding = credit taken minus settlements for the selected period
        (not the live portfolio due). Negative outstanding means settlements exceeded credit in this period.
      </p>

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>Credit overview · ${escapeHtml(period)}</span>
      </footer>
    </article>`;
}

async function ensureOverviewPrintDeps() {
  if (typeof PrintUtils === "undefined") {
    await loadScript("js/printUtils.js?v=3");
  }
  if (typeof loadPumpSettings === "function") {
    await loadPumpSettings();
  }
}

async function runOverviewPrint() {
  if (!lastOverviewData?.customers?.length) {
    const msg = "Load period activity first, then print.";
    if (typeof AppError?.showGlobalBanner === "function") {
      AppError.showGlobalBanner(msg);
    } else {
      alert(msg);
    }
    return;
  }

  await ensureOverviewPrintDeps();

  const periodLabel = lastOverviewPeriodLabel || getOverviewPeriodLabel();
  const sheetHtml = buildOverviewPrintHtml(lastOverviewData, periodLabel);
  const title = `Credit overview · ${periodLabel}`;

  await PrintUtils.printInIframe({
    title,
    bodyHtml: sheetHtml,
    cssHref: CREDIT_OVERVIEW_PRINT_CSS,
    bodyClass: "report-print-body",
    containerClass: "report-print-container",
    iframeTitle: "Credit overview print",
    imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
  });
}

async function handleOverviewPrintClick() {
  if (overviewPrintBusy) return;
  const btn = document.getElementById("credit-overview-print-btn");
  const prevLabel = btn?.textContent || "Print report";

  overviewPrintBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Preparing…";
  }

  try {
    await runOverviewPrint();
  } catch (err) {
    AppError?.report?.(err, { context: "runOverviewPrint" });
    const msg = AppError?.getUserMessage?.(err) || "Could not open the print dialog.";
    if (typeof AppError?.showGlobalBanner === "function") {
      AppError.showGlobalBanner(msg);
    } else {
      alert(msg);
    }
  } finally {
    overviewPrintBusy = false;
    if (btn) btn.textContent = prevLabel;
    updateOverviewPrintButton();
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
