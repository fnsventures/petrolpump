/* global requireAuth, applyRoleVisibility, window.supabaseClient, formatCurrency, formatNumericDate, AppError, escapeHtml, PumpSettings, loadPumpSettings, DsrQueries, buildExpenseCategoryMap, initDocsAccordion, PrintUtils, createRequestGuard, withProgress, AppCache, fetchAllRows, VaultDocuments */
/**
 * Reports page: catalog, data load, and print.
 * Figures live in reportsGst.js, reportsGstr1.js, reportsGstr3b.js, reportsPl.js, reportsSales.js.
 */

/** Report types grouped for the Generate section UI. */
const REPORT_CATALOG = [
  {
    group: "Operations",
    reports: [
      {
        id: "dsr",
        title: "Tank-wise DSR",
        description: "HSD + MS tanks: dips, receipts, shortage, testing, variance, rates, TVA.",
      },
      {
        id: "fuel-income",
        title: "Fuel Income",
        description: "Daily dealer margin: net litres × (selling − landed buying) for MS and HSD.",
      },
      {
        id: "pump-sales",
        title: "Pump-wise sales",
        description: "Sale litres by pump (P1/P2) from daily meters and shift nozzle rollups.",
      },
      {
        id: "shift-sales",
        title: "Shift-wise sales",
        description: "Morning / afternoon sales by fuel with staff count from shift register.",
      },
      {
        id: "salesman-sales",
        title: "Salesman sales",
        description: "Per salesman litres, expected cash, cash + phone + credit + expenses, and short from shift register.",
      },
    ],
  },
  {
    group: "GST — Sales",
    reports: [
      {
        id: "gst-sales-summary",
        title: "GST Sales Summary",
        description:
          "Inside / outside state outward supply: fuel NIL + billing slabs (CGST/SGST/IGST).",
      },
      {
        id: "gst-sales-detail",
        title: "GST Sales Detail",
        description:
          "Daily fuel NIL invoices (SFC) — one MS + one HSD per sale day; billing with GSTIN/IGST when enabled.",
      },
    ],
  },
  {
    group: "GST — Purchases (Fuel inward)",
    reports: [
      {
        id: "gst-purchase-summary",
        title: "GST Purchase Summary",
        description: "Inside / outside state fuel inward by VAT slab (supplier GSTIN vs station).",
      },
      {
        id: "gst-purchase-detail",
        title: "GST Purchase Detail",
        description: "Receipt-wise register with BPCL invoice no, GSTIN, qty, VAT and gross.",
      },
    ],
  },
  {
    group: "Accounts",
    reports: [
      {
        id: "trading",
        title: "Trading account",
        description:
          "Stock-based books (opening/closing stock). Gross income c/d is a balancing figure — not take-home profit.",
      },
      {
        id: "pl",
        title: "Profit & Loss",
        description:
          "Your real profit is Nett Profit here. Gross Profit = margin before expenses; same engine as Analysis and Dashboard Net profit.",
      },
    ],
  },
  {
    group: "GST — Filing aids",
    reports: [
      {
        id: "gstr1",
        title: "GSTR-1 style register",
        description:
          "B2B / B2CS / NIL (fuel SFC) outward summary — printable; CSV and portal-style JSON from the toolbar.",
      },
      {
        id: "gstr3b",
        title: "GSTR-3B style summary",
        description:
          "Tables 3.1 / 3.2 / 4 / 5 from fuel + billing — printable; portal-style JSON from the toolbar.",
      },
    ],
  },
];

let activeReport = "dsr";

let cachedData = null;

let cachedRange = null;

const reportsLoadGuard = typeof createRequestGuard === "function" ? createRequestGuard() : null;

let reportsLoadInFlight = null;

let reportPrintBusy = false;

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "reports",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  await loadPumpSettings();
  initReportsPage();
});

function findReportMeta(reportId) {
  for (const group of REPORT_CATALOG) {
    const hit = group.reports.find((r) => r.id === reportId);
    if (hit) return hit;
  }
  return null;
}

function initReportsAboutAccordion() {
  initDocsAccordion(document.querySelector(".reports-about-accordion"));
}

function initReportsPage() {
  const startInput = document.getElementById("reports-start");
  const endInput = document.getElementById("reports-end");
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  const monthStart = `${y}-${pad(m + 1)}-01`;
  const monthEnd = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;

  if (startInput) startInput.value = monthStart;
  if (endInput) endInput.value = monthEnd;

  renderReportCatalog();
  setActiveReportTab(activeReport);
  PrintUtils.preloadReportPrintCss?.();
  initReportsAboutAccordion();
  initPageSections({
    navItemSelector: ".reports-nav .settings-nav-item",
    panelSelector: ".reports-panels .settings-panel",
    defaultSection: "generate",
    validSections: ["generate", "about"],
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("start") && startInput) startInput.value = params.get("start");
  if (params.get("end") && endInput) endInput.value = params.get("end");
  const tab = params.get("tab");
  if (tab && findReportMeta(tab)) {
    setActiveReportTab(tab);
  }

  VaultDocuments.revokePublicLinks().catch((err) => {
    AppError.report(err, { context: "revokeVaultPublicLinks" });
  });

  document.getElementById("reports-preview")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-vault-document]");
    if (!btn) return;
    event.preventDefault();
    const id = btn.dataset.vaultDocument;
    if (!id) return;
    const preview = window.open("", "_blank");
    try {
      await VaultDocuments.open(id, { previewWindow: preview });
    } catch (err) {
      if (preview && !preview.closed) preview.close();
      AppError.report(err, { context: "vaultDocumentView" });
      AppError.showToast(err.message || "Could not open the document.", "error");
    }
  });

  document.getElementById("reports-catalog")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".reports-pick");
    if (!btn?.dataset.report) return;
    setActiveReportTab(btn.dataset.report);
    document.querySelector(".reports-output")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (!cachedData) {
      const preview = document.getElementById("reports-preview");
      if (preview) preview.innerHTML = "<p class=\"muted\">Loading report data…</p>";
      try {
        await ensureReportsDataLoaded();
      } catch {
        /* loadAndRenderReports surfaces errors in preview */
      }
    }
    renderActiveReport();
  });

  document.getElementById("reports-filter-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await loadAndRenderReports();
  });

  document.getElementById("reports-print-btn")?.addEventListener("click", () => {
    handleReportPrintClick();
  });

  document.getElementById("reports-csv-btn")?.addEventListener("click", () => {
    downloadGstr1Csv();
  });

  document.getElementById("reports-json-btn")?.addEventListener("click", () => {
    if (activeReport === "gstr3b") downloadGstr3bJson();
    else downloadGstr1Json();
  });

  // Load only when user picks a report or clicks Load data (see catalog + form handlers).
  syncReportsAboutHash();
  window.addEventListener("hashchange", syncReportsAboutHash);

  if (typeof bindLiveRefresh === "function") {
    bindLiveRefresh(
      () => {
        if (cachedData) void loadAndRenderReports();
      },
      { match: () => Boolean(document.getElementById("reports-preview")) }
    );
  }
}

function syncReportsAboutHash() {
  if ((location.hash || "").replace(/^#/, "") !== "about") return;
  const panel = document.getElementById("reports-about");
  if (panel?.hidden) return;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function ensureReportsDataLoaded() {
  if (cachedData) return Promise.resolve();
  if (reportsLoadInFlight) return reportsLoadInFlight;
  reportsLoadInFlight = loadAndRenderReports().finally(() => {
    reportsLoadInFlight = null;
  });
  return reportsLoadInFlight;
}

function renderReportCatalog() {
  const container = document.getElementById("reports-catalog");
  if (!container) return;

  container.innerHTML = REPORT_CATALOG.map(
    (group) => `
    <div class="reports-nav-group" role="group" aria-labelledby="reports-group-${slugify(group.group)}">
      <p class="reports-nav-group-title" id="reports-group-${slugify(group.group)}">${escapeHtml(group.group)}</p>
      ${group.reports
        .map(
          (r) => `
        <button type="button" class="reports-pick reports-nav-item${r.id === activeReport ? " is-active" : ""}" data-report="${escapeHtml(r.id)}" aria-pressed="${r.id === activeReport ? "true" : "false"}">
          ${escapeHtml(r.title)}
        </button>`
        )
        .join("")}
    </div>`
  ).join("");
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function setActiveReportTab(reportId) {
  const meta = findReportMeta(reportId);
  activeReport = meta ? meta.id : "dsr";
  document.querySelectorAll(".reports-pick").forEach((btn) => {
    const on = btn.dataset.report === activeReport;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const titleEl = document.getElementById("reports-active-title");
  const descEl = document.getElementById("reports-active-desc");
  const label = findReportMeta(activeReport);
  if (titleEl && label) titleEl.textContent = label.title;
  if (descEl) descEl.textContent = label?.description ?? "";
  updateReportsCsvButtonVisibility();
}

function reportHeader(title, start, end) {
  const gstin = PumpSettings.getStationGstin();
  return `
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
          ${gstin ? `<p class="report-gstin">GSTIN: ${escapeHtml(gstin)}</p>` : ""}
          <p class="report-title">${escapeHtml(title)}</p>
          <p class="report-period">Period: ${formatNumericDate(start)} &nbsp;–&nbsp; ${formatNumericDate(end)}</p>
        </div>
      </div>
    </header>`;
}

async function loadAndRenderReports() {
  const loadId = reportsLoadGuard ? reportsLoadGuard.next() : 0;
  const start = document.getElementById("reports-start")?.value;
  const end = document.getElementById("reports-end")?.value;
  const errorEl = document.getElementById("reports-error");
  const preview = document.getElementById("reports-preview");
  const label = document.getElementById("reports-date-label");

  errorEl?.classList.add("hidden");
  if (!start || !end) {
    if (errorEl) {
      errorEl.textContent = "Please select from and to dates.";
      errorEl.classList.remove("hidden");
    }
    return;
  }
  let rangeStart = start;
  let rangeEnd = end;
  if (rangeEnd < rangeStart) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];

  if (label) {
    label.textContent =
      rangeStart === rangeEnd
        ? formatNumericDate(rangeStart)
        : `${formatNumericDate(rangeStart)} – ${formatNumericDate(rangeEnd)}`;
  }

  if (preview) preview.textContent = "Loading…";
  setReportPrintButtonWaiting();

  const cacheKey = `reports_${rangeStart}_${rangeEnd}`;
  const fetchFn = async () => {
    const data = await fetchReportData(rangeStart, rangeEnd);
    try {
      const { data: breakdown, error: brErr } = await window.supabaseClient.rpc("get_meter_sales_breakdown", {
        p_start: rangeStart,
        p_end: rangeEnd,
      });
      if (brErr) throw brErr;
      data.meterBreakdown = breakdown || null;
    } catch (brErr) {
      AppError.report(brErr, { context: "loadAndRenderReports.meterBreakdown" });
      data.meterBreakdown = null;
    }
    return data;
  };

  const onUpdate = (fresh) => {
    if (reportsLoadGuard && !reportsLoadGuard.isCurrent(loadId)) return;
    cachedData = fresh;
    cachedRange = { start: rangeStart, end: rangeEnd };
    clearReportDerivedCache();
    renderActiveReport();
  };

  try {
    await loadPumpSettings();
    if (typeof withProgress === "function") {
      cachedData = await withProgress(async () => {
        if (typeof AppCache !== "undefined" && AppCache) {
          return AppCache.getWithSWR(cacheKey, fetchFn, "reports_data", onUpdate);
        }
        return fetchFn();
      });
    } else if (typeof AppCache !== "undefined" && AppCache) {
      cachedData = await AppCache.getWithSWR(cacheKey, fetchFn, "reports_data", onUpdate);
    } else {
      cachedData = await fetchFn();
    }
    if (reportsLoadGuard && !reportsLoadGuard.isCurrent(loadId)) return;
    cachedRange = { start: rangeStart, end: rangeEnd };
    clearReportDerivedCache();
    renderActiveReport();
  } catch (err) {
    if (reportsLoadGuard && !reportsLoadGuard.isCurrent(loadId)) return;
    AppError.report(err, { context: "loadAndRenderReports" });
    if (preview) preview.innerHTML = `<p class="error">${escapeHtml(err.message || "Failed to load data.")}</p>`;
  }
}

function normalizeReportsPayload(payload) {
  const errors = [
    payload.dsrError,
    payload.stockError,
    payload.expenseError,
    payload.invoiceError,
    payload.invoiceItemsError,
    payload.categoriesError,
  ].filter(Boolean);
  if (errors.length) throw errors[0];

  return {
    dsrRows: payload.dsrRows ?? [],
    stockRows: payload.stockRows ?? [],
    expenseRows: payload.expenseRows ?? [],
    invoices: payload.invoices ?? [],
    invoiceItems: payload.invoiceItems ?? [],
    vaultPurchases: payload.vaultPurchases ?? [],
    categoryMap: buildExpenseCategoryMap(payload.expenseCategories),
    receiptRows: payload.receiptRows ?? [],
  };
}

/**
 * Fetches reports data using Edge Function (single round-trip) with fallback
 * to parallel client-side queries if the Edge Function is unavailable.
 */
async function fetchReportData(start, end) {
  try {
    const invoke = () =>
      window.supabaseClient.functions.invoke("get-reports-data", {
        body: {
          startDate: start,
          endDate: end,
          receiptHistoryStart: PumpSettings.getReceiptHistoryStart(),
        },
      });

    const { data, error } =
      typeof AppError !== "undefined" && AppError?.withRetry
        ? await AppError.withRetry(invoke, { maxAttempts: 3 })
        : await invoke();

    if (error) throw error;

    return normalizeReportsPayload({
      dsrRows: data.dsrRows,
      receiptRows: data.receiptRows,
      stockRows: data.stockRows,
      expenseRows: data.expenseRows,
      invoices: data.invoices,
      invoiceItems: data.invoiceItems,
      vaultPurchases: data.vaultPurchases,
      expenseCategories: data.expenseCategories,
      dsrError: data.errors?.dsr ? new Error(data.errors.dsr) : null,
      stockError: data.errors?.stock ? new Error(data.errors.stock) : null,
      expenseError: data.errors?.expense ? new Error(data.errors.expense) : null,
      invoiceError: data.errors?.invoice ? new Error(data.errors.invoice) : null,
      invoiceItemsError: data.errors?.invoiceItems ? new Error(data.errors.invoiceItems) : null,
      categoriesError: data.errors?.categories ? new Error(data.errors.categories) : null,
    });
  } catch {
    return fetchReportDataDirect(start, end);
  }
}

/** Fallback: parallel client-side queries (3–4 round trips). */
async function fetchReportDataDirect(start, end) {
  const [
    dsrBundle,
    stockResult,
    expenseResult,
    invoiceResult,
    categoryResult,
    vaultResult,
  ] = await Promise.all([
    DsrQueries.fetchDsrRows(start, end, { select: DsrQueries.DSR_SELECT_FULL }),
    window.supabaseClient.rpc("get_dsr_stock_range", { p_start: start, p_end: end }),
    DsrQueries.fetchExpenses(start, end, "date, category, amount, description"),
    fetchAllRows(() =>
      supabaseClient
        .from("invoices")
        .select(
          "id, invoice_number, invoice_date, party_name, party_gstin, total_amount, cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total"
        )
        .gte("invoice_date", start)
        .lte("invoice_date", end)
        .order("invoice_date", { ascending: true })
        .order("id", { ascending: true })
    ),
    window.supabaseClient.from("expense_categories").select("name, label").order("sort_order").limit(LOOKUP_ROW_LIMIT),
    fetchAllRows(() =>
      supabaseClient
        .from("invoice_documents")
        .select("id, invoice_date, vendor, amount, category, title")
        .eq("category", "purchase")
        .gte("invoice_date", start)
        .lte("invoice_date", end)
        .order("invoice_date", { ascending: true })
        .order("id", { ascending: true })
    ),
  ]);

  const invoices = invoiceResult.data ?? [];
  let invoiceItems = [];
  if (invoices.length) {
    const itemResult = await fetchAllByIds(
      () => supabaseClient.from("invoice_items").select("invoice_id, gst_percent, amount"),
      invoices.map((i) => i.id),
      "invoice_id"
    );
    if (itemResult.error) throw itemResult.error;
    invoiceItems = itemResult.data || [];
  }

  return normalizeReportsPayload({
    dsrRows: dsrBundle.data,
    receiptRows: dsrBundle.receiptRows,
    stockRows: stockResult.data,
    expenseRows: expenseResult.data,
    invoices,
    invoiceItems,
    vaultPurchases: vaultResult.error ? [] : vaultResult.data ?? [],
    expenseCategories: categoryResult.data,
    dsrError: dsrBundle.error,
    stockError: stockResult.error,
    expenseError: expenseResult.error,
    invoiceError: invoiceResult.error,
    invoiceItemsError: null,
    categoriesError: categoryResult.error,
  });
}

/** Memoize heavy GST aggregates while the same payload + range is in view. */
let reportDerivedCache = {
  dataRef: null,
  rangeKey: "",
  gstr1: null,
  purchases: null,
  gstr3b: null,
  tradingPl: null,
};

function clearReportDerivedCache() {
  reportDerivedCache = {
    dataRef: null,
    rangeKey: "",
    gstr1: null,
    purchases: null,
    gstr3b: null,
    tradingPl: null,
  };
}

function reportDerivedSlot(data, range) {
  const rangeKey = `${range?.start || ""}|${range?.end || ""}`;
  if (reportDerivedCache.dataRef !== data || reportDerivedCache.rangeKey !== rangeKey) {
    clearReportDerivedCache();
    reportDerivedCache.dataRef = data;
    reportDerivedCache.rangeKey = rangeKey;
  }
  return reportDerivedCache;
}

function getGstr1Sections(data, range) {
  const slot = reportDerivedSlot(data, range);
  if (!slot.gstr1) slot.gstr1 = buildGstr1Sections(data, range);
  return slot.gstr1;
}

function getFuelPurchaseRows(data, range) {
  const slot = reportDerivedSlot(data, range);
  if (!slot.purchases) slot.purchases = buildFuelPurchaseRows(data, range);
  return slot.purchases;
}

function getGstr3bSummary(data, range) {
  const slot = reportDerivedSlot(data, range);
  if (!slot.gstr3b) slot.gstr3b = buildGstr3bSummary(data, range);
  return slot.gstr3b;
}

function getTradingAndPl(data, range) {
  const slot = reportDerivedSlot(data, range);
  if (!slot.tradingPl) slot.tradingPl = computeTradingAndPl(data, range);
  return slot.tradingPl;
}

function updateReportsCsvButtonVisibility() {
  const csvBtn = document.getElementById("reports-csv-btn");
  const jsonBtn = document.getElementById("reports-json-btn");
  const ready = !!(cachedData && cachedRange);
  const showCsv = activeReport === "gstr1" && ready;
  const showJson = (activeReport === "gstr1" || activeReport === "gstr3b") && ready;
  if (csvBtn) {
    csvBtn.classList.toggle("hidden", !showCsv);
    csvBtn.disabled = !showCsv;
  }
  if (jsonBtn) {
    jsonBtn.classList.toggle("hidden", !showJson);
    jsonBtn.disabled = !showJson;
    jsonBtn.textContent =
      activeReport === "gstr3b" ? "Download GSTR-3B JSON" : "Download GSTR-1 JSON";
  }
}

/** Render report body HTML for the active type (same output as preview / print). */
function renderReportHtml(reportId, data, range) {
  switch (reportId) {
    case "gst-sales-summary":
      return renderGstSalesSummary(data, range);
    case "gst-sales-detail":
      return renderGstSalesDetail(data, range);
    case "gst-purchase-summary":
      return renderGstPurchaseSummary(data, range);
    case "gst-purchase-detail":
      return renderGstPurchaseDetail(data, range);
    case "trading":
      return renderTradingAccount(data, range);
    case "pl":
      return renderProfitLoss(data, range);
    case "gstr1":
      return renderGstr1Register(data, range);
    case "gstr3b":
      return renderGstr3bRegister(data, range);
    case "fuel-income":
      return renderFuelIncome(data, range);
    case "pump-sales":
      return renderPumpSalesReport(data, range);
    case "shift-sales":
      return renderShiftSalesReport(data, range);
    case "salesman-sales":
      return renderSalesmanSalesReport(data, range);
    case "dsr":
    default:
      return renderTankWiseDsr(data, range);
  }
}

function sanitizeReportHtmlForPrint(html) {
  return PrintUtils.applyPrintLogos(html)
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "");
}

function buildPrintSheetWrapped(reportBodyHtml, reportId, range) {
  const meta = findReportMeta(reportId);
  const title = meta?.title || "Report";
  const periodLabel = range
    ? range.start === range.end
      ? formatNumericDate(range.start)
      : `${formatNumericDate(range.start)} – ${formatNumericDate(range.end)}`
    : "";

  return `
    <div class="report-print-sheet" data-report="${escapeHtml(reportId)}">
      ${reportBodyHtml}
      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>${escapeHtml(title)}${periodLabel ? ` · ${escapeHtml(periodLabel)}` : ""}</span>
      </footer>
    </div>`;
}

async function handleReportPrintClick() {
  if (reportPrintBusy) return;
  const btn = document.getElementById("reports-print-btn");
  const prevLabel = btn?.textContent || "Print this report";

  reportPrintBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Preparing…";
  }

  try {
    await runReportPrint();
  } catch (err) {
    AppError?.report?.(err, { context: "runReportPrint" });
    AppError.showToast(AppError?.getUserMessage?.(err) || "Could not open the print dialog.", "error");
  } finally {
    reportPrintBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
}

async function runReportPrint() {
  if (!cachedData || !cachedRange) {
    AppError.showToast("Load report data first (pick dates and click Load data).", "warning");
    return;
  }

  const reportBodyHtml = renderReportHtml(activeReport, cachedData, cachedRange);
  if (!reportBodyHtml?.trim()) {
    AppError.showToast("No report content to print.", "warning");
    return;
  }

  const bodyHtml = sanitizeReportHtmlForPrint(reportBodyHtml);
  const sheetWrapped = buildPrintSheetWrapped(bodyHtml, activeReport, cachedRange);
  const cssText = await PrintUtils.getReportPrintCssText();
  const title = PrintUtils.buildPrintFilename(
    activeReport || "report",
    cachedRange?.start,
    cachedRange?.start !== cachedRange?.end ? cachedRange?.end : null
  );

  await PrintUtils.printInIframe({
    title,
    bodyHtml: sheetWrapped,
    cssText,
    bodyClass: "report-print-body",
    containerClass: "report-print-container",
    iframeTitle: "Report print",
    imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
  });
}

function renderActiveReport() {
  const preview = document.getElementById("reports-preview");
  const printRoot = document.getElementById("reports-print-root");
  const label = findReportMeta(activeReport);

  if (!cachedData || !cachedRange) {
    if (preview && preview.textContent !== "Loading…" && preview.textContent !== "Loading report data…") {
      const title = label?.title ? escapeHtml(label.title) : "this report";
      preview.innerHTML =
        `<p class="muted">Select dates and click <strong>Load data</strong> to preview <strong>${title}</strong>.</p>`;
      preview.classList.add("muted");
    }
    if (printRoot) {
      printRoot.innerHTML = "";
      printRoot.setAttribute("aria-hidden", "true");
    }
    setReportPrintButtonWaiting();
    return;
  }

  const html = renderReportHtml(activeReport, cachedData, cachedRange);
  const sheetHtml =
    typeof PrintUtils !== "undefined" && PrintUtils.ensureReportWatermark
      ? PrintUtils.ensureReportWatermark(
          `<div class="report-print-sheet">${html}</div>`
        )
      : `<div class="report-print-sheet">${html}</div>`;

  if (preview) {
    preview.innerHTML = `<div class="report-preview-inner">${sheetHtml}</div>`;
    preview.classList.remove("muted");
  }
  if (printRoot) {
    printRoot.innerHTML = sheetHtml;
    printRoot.removeAttribute("aria-hidden");
  }

  const printBtn = document.getElementById("reports-print-btn");
  if (printBtn && !reportPrintBusy) {
    printBtn.disabled = false;
    printBtn.title = "";
  }
  updateReportsCsvButtonVisibility();
}

function setReportPrintButtonWaiting() {
  const printBtn = document.getElementById("reports-print-btn");
  if (printBtn && !reportPrintBusy) {
    printBtn.disabled = true;
    printBtn.title = "Load report data first";
  }
  updateReportsCsvButtonVisibility();
}
