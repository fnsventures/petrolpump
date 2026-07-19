/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppError, escapeHtml, GST_SLABS, PumpSettings, loadPumpSettings, AppConfig, formatBuyingRatePerKl, getBuyingPriceUnitLabel, normalizeProduct, getPetrolPurchaseVatPct, getDieselPurchaseVatPct, getPurchaseTaxPct, getPurchaseGstSummaryNote, getPurchaseGstDetailNote, calcPurchaseLineTax, DsrQueries, getDsrNetSaleLitres, getDsrSaleRate, createBuyingRateContext, resolveStoredBuyingRate, getEffectiveBuyingRate, getLandedBuyingRateForDate, computeProfitLossSummary, computeFuelRowMargin, isTestingExpenseCategory, formatNumericDate, formatNumberPlain, initDocsAccordion, PrintUtils, fuelRowClass, formatFuelBadge */

/** Report types grouped for the Generate section UI. */
const REPORT_CATALOG = [
  {
    group: "Operations",
    reports: [
      {
        id: "dsr",
        title: "Tank-wise DSR",
        description: "Daily pump sales, stock, receipts and rates by tank.",
      },
    ],
  },
  {
    group: "GST — Sales",
    reports: [
      {
        id: "gst-sales-summary",
        title: "GST Sales Summary",
        description: "Month-wise nil-rated petrol and diesel (qty × daily selling price); billing when enabled.",
      },
      {
        id: "gst-sales-detail",
        title: "GST Sales Detail",
        description: "Month-wise nil-rated fuel register; billing invoices when enabled in Settings.",
      },
    ],
  },
  {
    group: "GST — Purchases (Fuel inward)",
    reports: [
      {
        id: "gst-purchase-summary",
        title: "GST Purchase Summary",
        description: "Fuel receipt totals with MS/HSD VAT or LST.",
      },
      {
        id: "gst-purchase-detail",
        title: "GST Purchase Detail",
        description: "Receipt-wise inward fuel register.",
      },
    ],
  },
  {
    group: "Accounts",
    reports: [
      {
        id: "trading",
        title: "Trading account",
        description: "Stock-based account: sales, purchases, opening/closing stock. Gross income is a balancing figure — not the same as P&L net profit.",
      },
      {
        id: "pl",
        title: "Profit & Loss",
        description: "Margin-based net profit — same formula as Dashboard P&L and Analysis.",
      },
    ],
  },
];

let activeReport = "dsr";
let cachedData = null;
let cachedRange = null;
let reportsLoadInFlight = null;
let reportPrintCssCache = null;
let reportPrintBusy = false;

document.addEventListener("DOMContentLoaded", async () => {
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

function getFuelGstPct() {
  return Number(PumpSettings.getCachedSync().reports?.fuelGstPct) || AppConfig.DEFAULT_REPORTS.fuelGstPct;
}

function isBillingIncludedInGstReports() {
  const billing = PumpSettings.getCachedSync().billing || {};
  const reports = PumpSettings.getCachedSync().reports || {};
  if (typeof billing.includeInGstReports === "boolean") return billing.includeInGstReports;
  if (typeof reports.includeBillingInGst === "boolean") return reports.includeBillingInGst;
  return AppConfig.DEFAULT_BILLING.includeInGstReports !== false;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

/** Outward supply of MS/HSD is nil-rated (no CGST/SGST on fuel sales). */
const FUEL_OUTWARD_GST_PCT = 0;

/**
 * Daily fuel sale value: net litres × that day's selling rate.
 * @returns {{ litres: number, gross: number }}
 */
function calcDailyFuelSale(row) {
  const { revenue, litres } = computeFuelRowMargin(row, null);
  return { litres, gross: revenue };
}

/**
 * Aggregate net fuel sales by calendar month and product.
 * Each DSR day uses its own selling price before rolling up to the month.
 * @returns {Map<string, { petrol: { litres: number, gross: number }, diesel: { litres: number, gross: number } }>}
 */
function aggregateFuelSalesByMonth(dsrRows, range) {
  const months = new Map();
  (dsrRows ?? []).forEach((row) => {
    if (row.date < range.start || row.date > range.end) return;
    const product = normalizeProduct(row.product);
    if (product !== "petrol" && product !== "diesel") return;

    const { litres, gross } = calcDailyFuelSale(row);
    if (litres <= 0 && gross <= 0) return;

    const monthKey = row.date.slice(0, 7);
    if (!months.has(monthKey)) {
      months.set(monthKey, {
        petrol: { litres: 0, gross: 0 },
        diesel: { litres: 0, gross: 0 },
      });
    }
    const bucket = months.get(monthKey)[product];
    bucket.litres += litres;
    bucket.gross += gross;
  });
  return months;
}

/** Flat month × product lines (nil GST), sorted by month then product. */
function buildFuelSalesMonthLines(dsrRows, range) {
  const gstPct = FUEL_OUTWARD_GST_PCT;
  const slabKey = classifyGstSlab(gstPct);
  const lines = [];

  [...aggregateFuelSalesByMonth(dsrRows, range).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([monthKey, data]) => {
      ["petrol", "diesel"].forEach((product) => {
        const { litres, gross } = data[product];
        if (litres <= 0 && gross <= 0) return;
        lines.push({
          monthKey,
          monthLabel: formatMonthLabel(monthKey),
          product,
          productLabel: product === "petrol" ? "Petrol (MS)" : "Diesel (HSD)",
          litres,
          gstPct,
          slabKey,
          taxable: 0,
          cgst: 0,
          sgst: 0,
          gross,
          nilValue: gross,
        });
      });
    });

  return lines;
}

function sumFuelSalesLines(lines) {
  return lines.reduce(
    (acc, line) => ({
      litres: acc.litres + line.litres,
      taxable: acc.taxable + line.taxable,
      cgst: acc.cgst + line.cgst,
      sgst: acc.sgst + line.sgst,
      gross: acc.gross + line.gross,
    }),
    { litres: 0, taxable: 0, cgst: 0, sgst: 0, gross: 0 }
  );
}

function mergeSlabTotals(base, addition) {
  const out = {};
  GST_SLABS.forEach((s) => {
    const b = base[s.key] || { taxable: 0, cgst: 0, sgst: 0, gross: 0 };
    const a = addition[s.key] || { taxable: 0, cgst: 0, sgst: 0, gross: 0 };
    out[s.key] = {
      taxable: b.taxable + a.taxable,
      cgst: b.cgst + a.cgst,
      sgst: b.sgst + a.sgst,
      gross: b.gross + a.gross,
    };
  });
  return out;
}

function fuelSalesToSlabTotals(lines) {
  const slabTotals = {};
  GST_SLABS.forEach((s) => {
    slabTotals[s.key] = { taxable: 0, cgst: 0, sgst: 0, gross: 0 };
  });
  lines.forEach((line) => {
    const key = line.slabKey || classifyGstSlab(line.gstPct);
    if (!slabTotals[key]) return;
    const nilValue = Number(line.nilValue ?? line.gross ?? 0);
    if (key === "nil") {
      slabTotals[key].taxable += nilValue;
      slabTotals[key].gross += nilValue;
    } else {
      slabTotals[key].taxable += line.taxable;
      slabTotals[key].cgst += line.cgst;
      slabTotals[key].sgst += line.sgst;
      slabTotals[key].gross += line.gross;
    }
  });
  return slabTotals;
}

function getFuelSupplierLabel() {
  return PumpSettings.getCachedSync().reports?.fuelSupplierLabel || AppConfig.DEFAULT_REPORTS.fuelSupplierLabel;
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
  preloadReportPrintCss();
  initReportsAboutAccordion();
  initPageSections({
    navItemSelector: ".reports-nav .settings-nav-item",
    panelSelector: ".reports-panels .settings-panel",
    defaultSection: "generate",
    validSections: ["generate", "about"],
  });

  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab && findReportMeta(tab)) {
    setActiveReportTab(tab);
  }

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

  ensureReportsDataLoaded();
  syncReportsAboutHash();
  window.addEventListener("hashchange", syncReportsAboutHash);
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
}

function splitRatio(a, b) {
  const t = Number(a) + Number(b);
  if (!Number.isFinite(t) || t <= 0) return [0.5, 0.5];
  return [Number(a) / t, Number(b) / t];
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
  const fetchFn = () => fetchReportData(rangeStart, rangeEnd);

  try {
    await loadPumpSettings();
    if (typeof withProgress === "function") {
      cachedData = await withProgress(async () => {
        if (typeof AppCache !== "undefined" && AppCache) {
          return AppCache.getWithSWR(cacheKey, fetchFn, "reports_data");
        }
        return fetchFn();
      });
    } else if (typeof AppCache !== "undefined" && AppCache) {
      cachedData = await AppCache.getWithSWR(cacheKey, fetchFn, "reports_data");
    } else {
      cachedData = await fetchFn();
    }
    cachedRange = { start: rangeStart, end: rangeEnd };
    renderActiveReport();
  } catch (err) {
    AppError.report(err, { context: "loadAndRenderReports" });
    if (preview) preview.innerHTML = `<p class="error">${escapeHtml(err.message || "Failed to load data.")}</p>`;
  }
}

function buildExpenseCategoryMap(categories) {
  const categoryMap = {};
  (categories ?? []).forEach((c) => {
    categoryMap[c.name] = c.label;
  });
  return categoryMap;
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
      supabaseClient.functions.invoke("get-reports-data", {
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
  ] = await Promise.all([
    DsrQueries.fetchDsrRows(start, end, { select: DsrQueries.DSR_SELECT_FULL }),
    supabaseClient.rpc("get_dsr_stock_range", { p_start: start, p_end: end }),
    DsrQueries.fetchExpenses(start, end, "date, category, amount, description"),
    supabaseClient
      .from("invoices")
      .select(
        "id, invoice_number, invoice_date, party_name, party_gstin, total_amount, cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total"
      )
      .gte("invoice_date", start)
      .lte("invoice_date", end)
      .order("invoice_date", { ascending: true }),
    supabaseClient.from("expense_categories").select("name, label").order("sort_order"),
  ]);

  const invoices = invoiceResult.data ?? [];
  let invoiceItems = [];
  if (invoices.length) {
    const ids = invoices.map((i) => i.id);
    const { data: items, error: itemsError } = await supabaseClient
      .from("invoice_items")
      .select("invoice_id, gst_percent, amount")
      .in("invoice_id", ids);
    if (itemsError) throw itemsError;
    invoiceItems = items ?? [];
  }

  return normalizeReportsPayload({
    dsrRows: dsrBundle.data,
    receiptRows: dsrBundle.receiptRows,
    stockRows: stockResult.data,
    expenseRows: expenseResult.data,
    invoices,
    invoiceItems,
    expenseCategories: categoryResult.data,
    dsrError: dsrBundle.error,
    stockError: stockResult.error,
    expenseError: expenseResult.error,
    invoiceError: invoiceResult.error,
    invoiceItemsError: null,
    categoriesError: categoryResult.error,
  });
}

function buildTankDsrSection(product, tankLabel, capacity, pumpIndex, rows, rateField) {
  let cumSale = 0;
  let cumVariance = 0;
  let totalPurchase = 0;
  let totalTesting = 0;
  let totalMeter = 0;
  let totalActual = 0;
  let lastClosing = 0;

  const bodyRows = rows
    .map((row) => {
      const r1 = Number(row.sales_pump1 ?? 0);
      const r2 = Number(row.sales_pump2 ?? 0);
      const [ratio1] = splitRatio(r1, r2);
      const ratio = pumpIndex === 1 ? ratio1 : 1 - ratio1;

      const openingDip = Number(row.opening_stock ?? 0) * ratio;
      const purchase = Number(row.receipts ?? 0) * ratio;
      const testing = Number(row.testing ?? 0) * ratio;
      const saleMeter = pumpIndex === 1 ? r1 : r2;
      const actualSale = Math.max(saleMeter - testing, 0);
      cumSale += actualSale;
      const closingDip = Number(row.dip_stock ?? row.stock ?? 0) * ratio;
      const saleByDip = Math.max(openingDip + purchase - closingDip, 0);
      lastClosing = closingDip;
      const variance = actualSale - saleByDip;
      cumVariance += variance;

      totalPurchase += purchase;
      totalTesting += testing;
      totalMeter += saleMeter;
      totalActual += actualSale;

      const rate = Number(row[rateField] ?? 0);

      return `<tr>
        <td>${formatNumericDate(row.date)}</td>
        <td class="num">${formatNumberPlain(openingDip)}</td>
        <td class="num">${formatNumberPlain(purchase)}</td>
        <td class="num">${formatNumberPlain(testing)}</td>
        <td class="num">${formatNumberPlain(saleMeter)}</td>
        <td class="num">${formatNumberPlain(actualSale)}</td>
        <td class="num">${formatNumberPlain(cumSale)}</td>
        <td class="num">${formatNumberPlain(saleByDip)}</td>
        <td class="num">${formatNumberPlain(closingDip)}</td>
        <td class="num">${formatNumberPlain(variance)}</td>
        <td class="num">${formatNumberPlain(cumVariance)}</td>
        <td class="num">${formatNumberPlain(rate)}</td>
      </tr>`;
    })
    .join("");

  const productLabel = product === "diesel" ? "Diesel" : "Petrol";

  return `
    <section class="report-tank-section report-tank-section--${product}">
      <h3 class="report-tank-title">Tank: ${escapeHtml(tankLabel)} · ${escapeHtml(capacity)} · ${escapeHtml(productLabel)}</h3>
      <table class="report-table report-dsr-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" class="num" title="Opening dip (L)">Open</th>
            <th scope="col" class="num" title="Purchase (L)">Buy</th>
            <th scope="col" class="num" title="Testing (L)">Test</th>
            <th scope="col" class="num" title="Sale by meter (L)">Meter</th>
            <th scope="col" class="num" title="Actual sale (L)">Actual</th>
            <th scope="col" class="num" title="Cumulative sale (L)">Cum</th>
            <th scope="col" class="num" title="Sale by dip (L)">Dip</th>
            <th scope="col" class="num" title="Closing dip (L)">Close</th>
            <th scope="col" class="num" title="Variance (L)">Var</th>
            <th scope="col" class="num" title="Cumulative variance (L)">CumV</th>
            <th scope="col" class="num" title="Rate (₹/L)">Rate</th>
          </tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="12" class="muted">No entries</td></tr>`}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(totalPurchase)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalTesting)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalMeter)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalActual)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(lastClosing)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(cumVariance)}</strong></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <p class="report-note muted">Stock dip is shared across pumps; purchase, opening, and dip are split by pump sale ratio.</p>
    </section>`;
}

function renderTankWiseDsr(data, range) {
  const merged = DsrQueries.mergeDsrStock(data.dsrRows, data.stockRows);
  const tanks = PumpSettings.getCachedSync().reports?.tanks || AppConfig.DEFAULT_REPORT_TANKS;

  let sections = reportHeader("Tank-wise DSR report", range.start, range.end);
  let any = false;
  tanks.forEach((tank, idx) => {
    const rows = merged.filter((r) => normalizeProduct(r.product) === tank.product);
    if (!rows.length) return;
    any = true;
    const rateField = tank.product === "petrol" ? "petrol_rate" : "diesel_rate";
    const pumpIndex = tank.product === "diesel" ? (tank.key === "hsd2" ? 2 : 1) : 1;
    sections += buildTankDsrSection(tank.product, tank.label, tank.capacity, pumpIndex, rows, rateField);
  });
  if (!any) {
    sections += `<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>`;
  }
  return sections;
}

function classifyGstSlab(pct) {
  const n = Number(pct);
  if (n < 0) return "non_gst";
  if (n === 0) return "nil";
  if (n === 5) return "r5";
  if (n === 12) return "r12";
  if (n === 18) return "r18";
  if (n === 24) return "r24";
  if (n === 28) return "r28";
  return "r18";
}

function slabHasActivity(totals) {
  if (!totals) return false;
  return (
    Math.abs(Number(totals.taxable ?? 0)) > 0.005 ||
    Math.abs(Number(totals.gross ?? 0)) > 0.005
  );
}

/** Sum line-item amounts into taxable / non-GST / NIL buckets. */
function sumInvoiceLineAmounts(items) {
  let taxable = 0;
  let nonGst = 0;
  let nilRate = 0;
  items.forEach((item) => {
    const amt = Number(item.amount ?? 0);
    const pct = Number(item.gst_percent ?? 0);
    if (pct > 0) {
      taxable += amt / (1 + pct / 100);
    } else if (pct === 0) {
      nilRate += amt;
    } else {
      nonGst += amt;
    }
  });
  return { taxable, nonGst, nilRate };
}

/** Taxable value from invoice header when line items are missing. */
function invoiceHeaderTaxable(inv) {
  const cgst = Number(inv.cgst_total ?? 0);
  const sgst = Number(inv.sgst_total ?? 0);
  const igst = Number(inv.igst_total ?? 0);
  const nonGst = Number(inv.non_gst_total ?? 0);
  const nilRate = Number(inv.nil_rate_total ?? 0);
  const gross = Number(inv.total_amount ?? 0);
  const derived = gross - cgst - sgst - igst - nonGst - nilRate;
  if (Number.isFinite(derived) && derived >= 0) return derived;
  const sub = Number(inv.subtotal ?? 0) - Number(inv.discount ?? 0);
  return Number.isFinite(sub) && sub >= 0 ? sub : 0;
}

function aggregateInvoiceGst(invoices, invoiceItems) {
  const itemsByInvoice = new Map();
  invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const slabTotals = {};
  GST_SLABS.forEach((s) => {
    slabTotals[s.key] = { taxable: 0, cgst: 0, sgst: 0, gross: 0 };
  });

  invoices.forEach((inv) => {
    const items = itemsByInvoice.get(inv.id) || [];
    if (items.length) {
      items.forEach((item) => {
        const amt = Number(item.amount ?? 0);
        const pct = Number(item.gst_percent ?? 0);
        const key = classifyGstSlab(pct);
        if (pct > 0) {
          const taxable = amt / (1 + pct / 100);
          const gst = amt - taxable;
          slabTotals[key].taxable += taxable;
          slabTotals[key].cgst += gst / 2;
          slabTotals[key].sgst += gst / 2;
          slabTotals[key].gross += amt;
        } else if (pct === 0) {
          slabTotals.nil.gross += amt;
          slabTotals.nil.taxable += amt;
        } else {
          slabTotals.non_gst.gross += amt;
          slabTotals.non_gst.taxable += amt;
        }
      });
    } else {
      const nonGst = Number(inv.non_gst_total ?? 0);
      const nilRate = Number(inv.nil_rate_total ?? 0);
      const cgst = Number(inv.cgst_total ?? 0);
      const sgst = Number(inv.sgst_total ?? 0);
      const igst = Number(inv.igst_total ?? 0);
      const gross = Number(inv.total_amount ?? 0);
      const taxable = invoiceHeaderTaxable(inv);

      if (cgst > 0 || sgst > 0 || igst > 0) {
        const key = classifyGstSlab(18);
        slabTotals[key].taxable += taxable;
        slabTotals[key].cgst += cgst;
        slabTotals[key].sgst += sgst;
        slabTotals[key].gross += taxable + cgst + sgst + igst;
      } else if (nilRate > 0) {
        slabTotals.nil.taxable += nilRate;
        slabTotals.nil.gross += nilRate;
      } else if (nonGst > 0) {
        slabTotals.non_gst.taxable += nonGst;
        slabTotals.non_gst.gross += nonGst;
      } else if (gross > 0) {
        slabTotals.non_gst.gross += gross;
        slabTotals.non_gst.taxable += gross;
      }
    }
  });

  return slabTotals;
}

function renderGstSummaryTable(slabTotals, title, range, inward, options = {}) {
  const { sectionOnly = false, sectionTitle = title } = options;
  const activeSlabs = GST_SLABS.filter((s) => slabHasActivity(slabTotals[s.key]));
  const rows = activeSlabs
    .map((s) => {
      const t = slabTotals[s.key];
      const lineTax = t.cgst + t.sgst;
      return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${inward ? formatNumberPlain(lineTax) : formatNumberPlain(t.cgst)}</td>
      <td class="num">${inward ? "—" : formatNumberPlain(t.sgst)}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
    })
    .join("");

  const totalTaxable = GST_SLABS.reduce((s, x) => s + slabTotals[x.key].taxable, 0);
  const totalCgst = GST_SLABS.reduce((s, x) => s + slabTotals[x.key].cgst, 0);
  const totalSgst = GST_SLABS.reduce((s, x) => s + slabTotals[x.key].sgst, 0);
  const totalVat = totalCgst + totalSgst;
  const totalGross = GST_SLABS.reduce((s, x) => s + slabTotals[x.key].gross, 0);

  const taxCol1 = inward ? "VAT/LST" : "CGST";
  const taxCol2 = inward ? "—" : "SGST";
  const subtitle = inward
    ? `Inward supply · ${escapeHtml(getPurchaseTaxPctLabel())} · ${
        isPurchaseTaxInclusive() ? "tax-inclusive rate" : "pre-tax rate (BPCL)"
      }`
    : "Outward supply · Inside state (CGST + SGST)";

  const lead = sectionOnly
    ? `<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(sectionTitle)}</h3>`
    : reportHeader(title, range.start, range.end);
  const tail = sectionOnly ? "</section>" : "";

  return `
    ${lead}
    <p class="report-subtitle${sectionOnly ? " muted" : ""}">${subtitle}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>
          <th>Slab</th>
          <th class="num">Taxable</th>
          <th class="num">${taxCol1}</th>
          <th class="num">${taxCol2}</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(inward ? totalVat : totalCgst)}</strong></td>
          <td class="num"><strong>${inward ? "—" : formatNumberPlain(totalSgst)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Total taxable ${inward ? "inward" : "outward"} value: <strong>${formatNumberPlain(totalTaxable)}</strong> · Gross: <strong>${formatNumberPlain(totalGross)}</strong></p>${tail}`;
}

function renderFuelSalesMonthTable(lines, title) {
  const rows = lines
    .map(
      (line) => `<tr class="${fuelRowClass(line.product)}">
        <td>${escapeHtml(line.monthLabel)}</td>
        <td>${escapeHtml(line.productLabel)}</td>
        <td class="num">${formatNumberPlain(line.litres)}</td>
        <td class="num">${formatNumberPlain(line.nilValue ?? line.gross)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${formatNumberPlain(line.gross)}</td>
      </tr>`
    )
    .join("");
  const totals = sumFuelSalesLines(lines);

  return `
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(title)}</h3>
      <p class="report-subtitle muted">Outward fuel supply · NIL rate · Value = daily qty (L) × that day&apos;s selling price from DSR</p>
      <table class="report-table report-gst-fuel-month">
        <thead>
          <tr>
            <th>Month</th>
            <th>Product</th>
            <th class="num">Qty (L)</th>
            <th class="num">Nil value</th>
            <th class="num">CGST</th>
            <th class="num">SGST</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="7" class="muted">No fuel sales in this period</td></tr>`}</tbody>
        ${
          lines.length
            ? `<tfoot>
          <tr class="report-total-row">
            <td colspan="2"><strong>Fuel total</strong></td>
            <td class="num"><strong>${formatNumberPlain(totals.litres)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totals.gross)}</strong></td>
            <td class="num"><strong>—</strong></td>
            <td class="num"><strong>—</strong></td>
            <td class="num"><strong>${formatNumberPlain(totals.gross)}</strong></td>
          </tr>
        </tfoot>`
            : ""
        }
      </table>
    </section>`;
}

function renderGstSalesSummary(data, range) {
  const includeBilling = isBillingIncludedInGstReports();
  const fuelLines = buildFuelSalesMonthLines(data.dsrRows, range);
  const fuelSlabs = fuelSalesToSlabTotals(fuelLines);
  const billingSlabs = includeBilling ? aggregateInvoiceGst(data.invoices, data.invoiceItems) : null;
  const combinedSlabs = billingSlabs ? mergeSlabTotals(fuelSlabs, billingSlabs) : fuelSlabs;

  const fuelSection = renderFuelSalesMonthTable(fuelLines, "Fuel sales — month-wise");
  const billingSection = includeBilling
    ? renderGstSummaryTable(billingSlabs, "Billing — GST slab summary", range, false, {
        sectionOnly: true,
        sectionTitle: "Billing — GST slab summary",
      })
    : `<p class="report-note muted">Billing invoices are excluded (enable in Settings → Billing → Include billing in GST sales reports).</p>`;
  const grandTotal = renderGstSummaryTable(
    combinedSlabs,
    "Combined outward supply — GST summary",
    range,
    false,
    { sectionOnly: true, sectionTitle: "Combined outward supply — GST summary" }
  );

  return `
    ${reportHeader("Outward supply — GST summary", range.start, range.end)}
    ${fuelSection}
    ${billingSection}
    ${grandTotal}`;
}

function renderGstSalesDetail(data, range) {
  const includeBilling = isBillingIncludedInGstReports();
  const fuelLines = buildFuelSalesMonthLines(data.dsrRows, range);

  const fuelRows = fuelLines
    .map(
      (line) => `<tr class="${fuelRowClass(line.product)}">
        <td>${escapeHtml(line.monthLabel)}</td>
        <td>${escapeHtml(line.productLabel)}</td>
        <td>—</td>
        <td class="num">${formatNumberPlain(line.litres)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${formatNumberPlain(line.nilValue ?? line.gross)}</td>
        <td class="num">${formatNumberPlain(line.gross)}</td>
      </tr>`
    )
    .join("");

  const itemsByInvoice = new Map();
  data.invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const billingRows = includeBilling
    ? data.invoices
        .map((inv) => {
          const items = itemsByInvoice.get(inv.id) || [];
          const cgst = Number(inv.cgst_total ?? 0);
          const sgst = Number(inv.sgst_total ?? 0);
          const igst = Number(inv.igst_total ?? 0);
          const hasGst = cgst + sgst + igst > 0;

          let taxable = 0;
          let nonGst = 0;
          let nilRate = 0;

          if (items.length) {
            const sums = sumInvoiceLineAmounts(items);
            taxable = sums.taxable;
            nonGst = sums.nonGst;
            nilRate = sums.nilRate;
          } else {
            nonGst = Number(inv.non_gst_total ?? 0);
            nilRate = Number(inv.nil_rate_total ?? 0);
            taxable = invoiceHeaderTaxable(inv);
          }

          return `<tr class="report-billing-row">
        <td>${formatNumericDate(inv.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(inv.invoice_number)} · ${escapeHtml(inv.party_name)}</td>
        <td class="num">—</td>
        <td class="num">${hasGst || taxable > 0 ? formatNumberPlain(taxable) : "—"}</td>
        <td class="num">${formatNumberPlain(cgst)}</td>
        <td class="num">${formatNumberPlain(sgst)}</td>
        <td class="num">${formatNumberPlain(nonGst + nilRate)}</td>
        <td class="num">${formatNumberPlain(inv.total_amount)}</td>
      </tr>`;
        })
        .join("")
    : "";

  const fuelTotals = sumFuelSalesLines(fuelLines);
  const hasFuel = fuelLines.length > 0;
  const hasBilling = includeBilling && data.invoices.length > 0;
  const emptyMessage =
    !hasFuel && !hasBilling
      ? `<tr><td colspan="9" class="muted">${
          includeBilling ? "No fuel sales or billing in this period" : "No fuel sales in this period"
        }</td></tr>`
      : "";

  const billingNote = includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices are excluded (enable in Settings → Billing).</p>`;

  return `
    ${reportHeader("Outward supply — GST detail register", range.start, range.end)}
    ${billingNote}
    <table class="report-table report-gst-detail">
      <thead>
        <tr>
          <th>Period / Date</th>
          <th>Type</th>
          <th>Reference / Party</th>
          <th class="num">Qty (L)</th>
          <th class="num">Taxable</th>
          <th class="num">CGST</th>
          <th class="num">SGST</th>
          <th class="num">Exempt</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>
        ${fuelRows}
        ${billingRows}
        ${emptyMessage}
      </tbody>
      ${
        hasFuel
          ? `<tfoot>
        <tr class="report-total-row">
          <td colspan="3"><strong>Fuel total</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.litres)}</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.gross)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.gross)}</strong></td>
        </tr>
      </tfoot>`
          : ""
      }
    </table>`;
}

/**
 * Collect fuel receipt lines in range with a resolvable pre-VAT buying rate.
 * GST inward reports apply VAT + delivery via calcPurchaseLineTax (gross = landed cost).
 * Margin/P&amp;L/trading use getEffectiveBuyingRate instead (landed rate directly).
 */
function collectFuelPurchaseLines(data, range, getStored) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  const resolveStored = getStored ?? createBuyingRateContext(data.receiptRows ?? []).getStored;
  const lines = [];
  const seen = new Set();

  const addLine = (date, product, litres, rate) => {
    const l = Number(litres);
    const rt = Number(rate);
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(rt) || rt <= 0) return;
    const key = `${date}-${normalizeProduct(product)}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ date, product, litres: l, rate: rt });
  };

  (data.receiptRows ?? []).filter(inRange).forEach((r) => {
    addLine(r.date, r.product, Number(r.receipts ?? 0), Number(r.buying_price_per_litre));
  });

  (data.dsrRows ?? []).filter(inRange).forEach((r) => {
    const litres = Number(r.receipts ?? 0);
    if (litres <= 0) return;
    addLine(r.date, r.product, litres, resolveStoredBuyingRate(r, resolveStored));
  });

  return lines.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      normalizeProduct(a.product).localeCompare(normalizeProduct(b.product))
  );
}

function countReceiptsMissingBuying(data, range, getStored) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  const resolveStored = getStored ?? createBuyingRateContext(data.receiptRows ?? []).getStored;
  return (data.dsrRows ?? []).filter((r) => {
    if (!inRange(r) || Number(r.receipts ?? 0) <= 0) return false;
    const rate = resolveStoredBuyingRate(r, resolveStored);
    return rate == null || rate <= 0;
  }).length;
}

function buildFuelPurchaseRows(data, range) {
  const getStored = createBuyingRateContext(data.receiptRows ?? []).getStored;
  const purchaseLines = collectFuelPurchaseLines(data, range, getStored);
  const missingBuyingCount = countReceiptsMissingBuying(data, range, getStored);
  const slabTotals = {};
  GST_SLABS.forEach((s) => {
    slabTotals[s.key] = { taxable: 0, cgst: 0, sgst: 0, gross: 0 };
  });

  const detailRows = purchaseLines.map(({ date, product, litres, rate }) => {
    const taxPct = getPurchaseTaxPct(product);
    const slabKey = classifyGstSlab(taxPct);
    const { taxable, tax, gross, cgst, sgst } = calcPurchaseLineTax(litres, rate, taxPct);

    if (slabTotals[slabKey]) {
      slabTotals[slabKey].taxable += taxable;
      slabTotals[slabKey].cgst += cgst;
      slabTotals[slabKey].sgst += sgst;
      slabTotals[slabKey].gross += gross;
    }

    return { date, product, litres, rate, taxPct, taxable, tax, gross, cgst, sgst };
  });

  return {
    detailRows,
    slabTotals,
    missingBuyingCount,
  };
}

function renderGstPurchaseSummary(data, range) {
  const { slabTotals, detailRows, missingBuyingCount } = buildFuelPurchaseRows(data, range);
  const missingNote =
    missingBuyingCount > 0
      ? `<p class="report-note warning">${missingBuyingCount} receipt(s) in this period have no buying price — excluded. Enter buying price on the P&amp;L dashboard.</p>`
      : "";
  const emptyNote =
    detailRows.length === 0
      ? `<p class="report-note muted">No fuel receipts with buying price in this period.</p>`
      : "";
  return `
    ${renderGstSummaryTable(slabTotals, "Inward supply — GST summary (Fuel receipts)", range, true)}
    ${emptyNote}
    ${missingNote}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())}</p>`;
}

function renderGstPurchaseDetail(data, range) {
  const { detailRows, missingBuyingCount } = buildFuelPurchaseRows(data, range);

  const rows = detailRows
    .map(
      (r) => {
        const prod = normalizeProduct(r.product);
        const ref = prod === "petrol" ? "MS" : prod === "diesel" ? "HSD" : String(r.product).toUpperCase();
        return `<tr class="${fuelRowClass(prod)}">
      <td>${formatNumericDate(r.date)}</td>
      <td>${formatFuelBadge(ref)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td class="num">${formatNumberPlain(r.litres)}</td>
      <td class="num">${formatBuyingRatePerKl(r.rate)}</td>
      <td class="num">${formatNumberPlain(r.taxable)}</td>
      <td class="num">${r.taxPct}%</td>
      <td class="num">${formatNumberPlain(r.tax)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`;
      }
    )
    .join("");

  return `
    ${reportHeader("Inward supply — GST detail (Fuel receipts)", range.start, range.end)}
    <table class="report-table report-gst-detail report-gst-detail--purchase">
      <thead>
        <tr>
          <th>Date</th>
          <th>Prod</th>
          <th>Party</th>
          <th class="num">Qty (L)</th>
          <th class="num">Rate (${escapeHtml(getBuyingPriceUnitLabel())})</th>
          <th class="num">Taxable</th>
          <th class="num">VAT%</th>
          <th class="num">VAT</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="9" class="muted">No receipts with buying price in period</td></tr>`}</tbody>
    </table>
    ${
      missingBuyingCount > 0
        ? `<p class="report-note warning">${missingBuyingCount} receipt(s) excluded — buying price not set on dashboard.</p>`
        : ""
    }
    <p class="report-note muted">${escapeHtml(getPurchaseGstDetailNote())}</p>`;
}

/** Trading account (stock-based) + P&L figures via shared computeProfitLossSummary. */
function computeTradingAndPl(data, range) {
  const buyingContext = createBuyingRateContext(data.receiptRows);
  const merged = DsrQueries.mergeDsrStock(data.dsrRows, data.stockRows);

  const products = {
    petrol: { label: "Petrol (MS)", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0, openingL: 0, closingL: 0 },
    diesel: { label: "Diesel (HSD)", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0, openingL: 0, closingL: 0 },
    lube: { label: "Lubricant / Billing", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0 },
  };

  const productBounds = {
    petrol: { first: null, last: null },
    diesel: { first: null, last: null },
  };

  merged.forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!products[p]) return;
    const netL = getDsrNetSaleLitres(row);
    const rate = getDsrSaleRate(row);
    const receiptL = Number(row.receipts ?? 0);
    if (receiptL > 0) {
      const landedRate = getEffectiveBuyingRate(row, buyingContext) ?? 0;
      products[p].purchase += receiptL * landedRate;
    }
    products[p].sales += netL * rate;
    if (productBounds[p]) {
      if (!productBounds[p].first) productBounds[p].first = row;
      productBounds[p].last = row;
    }
  });

  ["petrol", "diesel"].forEach((p) => {
    const first = productBounds[p].first;
    const last = productBounds[p].last;
    if (!first || !last) return;
    products[p].openingL = Number(first.opening_stock ?? 0);
    products[p].closingL = Number(last.dip_stock ?? last.stock ?? 0);
    const openBuy = getLandedBuyingRateForDate(p, first.date, buyingContext) ?? 0;
    const closeBuy = getLandedBuyingRateForDate(p, last.date, buyingContext) ?? openBuy;
    products[p].openingStockVal = products[p].openingL * openBuy;
    products[p].closingStockVal = products[p].closingL * closeBuy;
  });

  products.lube.sales = data.invoices.reduce((s, i) => s + Number(i.total_amount ?? 0), 0);

  const grossSales = Object.values(products).reduce((s, x) => s + x.sales, 0);
  const totalPurchase = Object.values(products).reduce((s, x) => s + x.purchase, 0);
  const openingStock = Object.values(products).reduce((s, x) => s + x.openingStockVal, 0);
  const closingStock = Object.values(products).reduce((s, x) => s + x.closingStockVal, 0);

  const grossIncome = grossSales + closingStock - openingStock - totalPurchase;
  const pl = computeProfitLossSummary({
    dsrRows: merged,
    receiptRows: data.receiptRows,
    expenseRows: data.expenseRows,
    lubeSales: products.lube.sales,
    requireAllBuying: true,
    buyingContext,
  });

  const expensesByCategory = new Map();
  const testingExpensesByCategory = new Map();
  data.expenseRows.forEach((e) => {
    const key = e.category || "misc";
    const label = data.categoryMap[key] || key || "Miscellaneous";
    const amount = Number(e.amount ?? 0);
    const bucket = isTestingExpenseCategory(key, label) ? testingExpensesByCategory : expensesByCategory;
    if (!bucket.has(key)) bucket.set(key, { label, amount: 0 });
    bucket.get(key).amount += amount;
  });

  return {
    products,
    grossSales,
    totalPurchase,
    openingStock,
    closingStock,
    grossIncome,
    fuelGrossProfit: pl.canCalculate ? (pl.fuelGrossProfit ?? 0) : null,
    grossProfit: pl.canCalculate ? (pl.grossProfit ?? 0) : null,
    expensesByCategory,
    testingExpensesByCategory,
    totalExpenses: pl.totalExpenses,
    testingExpenses: pl.testingExpenses,
    netProfit: pl.canCalculate ? pl.netProfit : null,
    canCalculate: pl.canCalculate,
    missingBuyingPrice: pl.missingBuyingPrice,
  };
}

function renderTradingAccount(data, range) {
  const t = computeTradingAndPl(data, range);
  const creditRows = [
    ["Sales — Petrol", t.products.petrol.sales, "petrol"],
    ["Sales — Diesel", t.products.diesel.sales, "diesel"],
    ["Sales — Lube / Billing", t.products.lube.sales, null],
    ["Closing stock (at cost)", t.closingStock, null],
  ];
  const debitRows = [
    ["Opening stock (at cost)", t.openingStock],
    ["Purchases — Fuel receipts", t.totalPurchase],
    ["Gross income c/d", t.grossIncome],
  ];

  const renderSide = (title, rows, excludeFromTotal = []) => {
    const body = rows
      .map(
        ([label, amt, product]) =>
          `<tr class="${fuelRowClass(product)}"><td>${escapeHtml(label)}</td><td class="num">${formatNumberPlain(amt)}</td></tr>`
      )
      .join("");
    const total = rows
      .filter(([label]) => !excludeFromTotal.includes(label))
      .reduce((s, [, a]) => s + Number(a), 0);
    return `
      <div class="report-pl-column">
        <h3>${escapeHtml(title)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (₹)</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(total)}</strong></td></tr></tfoot>
        </table>
      </div>`;
  };

  return `
    ${reportHeader("Trading account", range.start, range.end)}
    <div class="report-pl-grid report-trading-grid">
      ${renderSide("Debit", debitRows, ["Gross income c/d"])}
      ${renderSide("Credit", creditRows)}
    </div>
    <p class="report-note muted">Debit and credit totals should match; gross income is the balancing figure.</p>
    <p class="report-summary-line">Gross income for period: <strong>${formatCurrency(t.grossIncome)}</strong></p>
    <p class="report-note muted">Stock-based trading account: gross income adjusts for opening/closing stock at cost. This is <strong>not</strong> the same as net profit on the P&amp;L report (margin-based). Fuel sales use net litres (meter minus testing). Lube sales from billing invoices.</p>`;
}

function renderProfitLoss(data, range) {
  const t = computeTradingAndPl(data, range);
  const expenseRows = Array.from(t.expensesByCategory.values()).sort(
    (a, b) => b.amount - a.amount
  );
  const testingExpenseRows = Array.from(t.testingExpensesByCategory.values()).sort(
    (a, b) => b.amount - a.amount
  );

  const expenseHtml = expenseRows
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.label)}</td><td class="num">${formatNumberPlain(e.amount)}</td></tr>`
    )
    .join("");

  const testingExpenseHtml = testingExpenseRows.length
    ? `<tr class="report-subhead-row"><td colspan="2">MS/HS & density testing (excluded from net profit — day closing only)</td></tr>${testingExpenseRows
        .map(
          (e) =>
            `<tr class="muted"><td>${escapeHtml(e.label)}</td><td class="num">${formatNumberPlain(e.amount)}</td></tr>`
        )
        .join("")}`
    : "";

  const lubeProfitRow =
    t.products.lube.sales > 0
      ? `<tr><td>Gross profit — Lube / Billing</td><td class="num">${formatNumberPlain(t.products.lube.sales)}</td></tr>`
      : "";

  const buyingWarning =
    !t.canCalculate && t.missingBuyingPrice?.length
      ? `<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) need a buying price — enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on the Dashboard P&amp;L before net profit can be calculated.</p>`
      : "";

  const netProfitDisplay = t.canCalculate ? formatNumberPlain(t.netProfit) : "—";
  const fuelGrossDisplay = t.canCalculate ? formatNumberPlain(t.fuelGrossProfit) : "—";
  const grossProfitDisplay = t.canCalculate ? formatNumberPlain(t.grossProfit) : "—";

  return `
    ${reportHeader("Profit & loss account", range.start, range.end)}
    ${buyingWarning}
    <table class="report-table">
      <thead><tr><th>Particulars</th><th>Amount (₹)</th></tr></thead>
      <tbody>
        <tr><td>Gross profit — Fuel (net litres × (selling − landed buying incl. VAT + delivery))</td><td class="num">${fuelGrossDisplay}</td></tr>
        ${lubeProfitRow}
        <tr class="report-total-row"><td><strong>Gross profit</strong></td><td class="num"><strong>${grossProfitDisplay}</strong></td></tr>
        ${expenseHtml}
        <tr class="report-total-row"><td><strong>Total expenses</strong></td><td class="num"><strong>${formatNumberPlain(t.totalExpenses)}</strong></td></tr>
        <tr class="report-total-row"><td><strong>Net profit</strong></td><td class="num"><strong>${netProfitDisplay}</strong></td></tr>
        ${testingExpenseHtml}
      </tbody>
    </table>
    <p class="report-note muted">Margin-based P&amp;L — same formula as Dashboard and Analysis: net profit = gross profit − operating expenses. MS/HS and density testing are excluded (handled in day closing). Fuel margin uses net sale litres × (selling − landed buying incl. VAT + delivery). Matches Dashboard P&amp;L and Analysis for the same date range.</p>`;
}

const REPORT_PRINT_CSS_URL = "css/reports-print.css?v=6";

function reportsAssetUrl(path) {
  return new URL(path, window.location.href).href;
}

function preloadReportPrintCss() {
  getReportPrintCssText().catch(() => {});
}

async function getReportPrintCssText() {
  if (reportPrintCssCache) return reportPrintCssCache;
  const url = reportsAssetUrl(REPORT_PRINT_CSS_URL);
  const res = await fetch(url, { cache: "default" });
  if (!res.ok) {
    return fetchReportPrintCssViaLink(url);
  }
  reportPrintCssCache = await res.text();
  return reportPrintCssCache;
}

/** Fallback when fetch() is blocked or fails (e.g. offline file quirks). */
function fetchReportPrintCssViaLink(url) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    const timeout = window.setTimeout(() => {
      link.remove();
      reject(new Error("Timed out loading print styles."));
    }, 8000);
    link.onload = () => {
      window.clearTimeout(timeout);
      let cssText = "";
      try {
        cssText = [...link.sheet.cssRules].map((r) => r.cssText).join("\n");
      } catch {
        link.remove();
        reject(new Error("Could not read print styles."));
        return;
      }
      link.remove();
      reportPrintCssCache = cssText;
      resolve(cssText);
    };
    link.onerror = () => {
      window.clearTimeout(timeout);
      link.remove();
      reject(new Error("Could not load report print styles."));
    };
    document.head.appendChild(link);
  });
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
    alert(AppError?.getUserMessage?.(err) || "Could not open the print dialog.");
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
    alert("Load report data first (pick dates and click Load data).");
    return;
  }

  const reportBodyHtml = renderReportHtml(activeReport, cachedData, cachedRange);
  if (!reportBodyHtml?.trim()) {
    alert("No report content to print.");
    return;
  }

  const bodyHtml = sanitizeReportHtmlForPrint(reportBodyHtml);
  const sheetWrapped = buildPrintSheetWrapped(bodyHtml, activeReport, cachedRange);
  const cssText = await getReportPrintCssText();
  const meta = findReportMeta(activeReport);
  const title = meta?.title || "Report";

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

  if (preview) {
    preview.innerHTML = `<div class="report-preview-inner">${html}</div>`;
    preview.classList.remove("muted");
  }
  if (printRoot) {
    printRoot.innerHTML = `<div class="report-print-sheet">${html}</div>`;
    printRoot.removeAttribute("aria-hidden");
  }

  const printBtn = document.getElementById("reports-print-btn");
  if (printBtn && !reportPrintBusy) {
    printBtn.disabled = false;
    printBtn.title = "";
  }
}

function setReportPrintButtonWaiting() {
  const printBtn = document.getElementById("reports-print-btn");
  if (printBtn && !reportPrintBusy) {
    printBtn.disabled = true;
    printBtn.title = "Load report data first";
  }
}
