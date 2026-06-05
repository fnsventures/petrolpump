/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppError, escapeHtml, GST_SLABS, PumpSettings, loadPumpSettings, AppConfig, formatBuyingRatePerKl, getBuyingPriceUnitLabel */

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
    group: "GST — Sales (Lube billing)",
    reports: [
      {
        id: "gst-sales-summary",
        title: "GST Sales Summary",
        description: "Outward supply totals by GST rate slab.",
      },
      {
        id: "gst-sales-detail",
        title: "GST Sales Detail",
        description: "Invoice-wise outward supply register.",
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
        description: "Income, purchases and expenses for the period.",
      },
      {
        id: "pl",
        title: "Profit & Loss",
        description: "Profit and loss statement for the period.",
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

  if (typeof initPageSections === "function") {
    const hash = (location.hash || "").replace(/^#/, "");
    const defaultSection = hash === "generate" ? "generate" : "about";
    initPageSections({ defaultSection, validSections: ["about", "generate"] });
  }

  await loadPumpSettings();
  initReportsPage();
});

function getStation() {
  return PumpSettings.getCachedSync().station || AppConfig.DEFAULT_STATION;
}

function getStationLegalName() {
  return getStation().legalName || AppConfig.DEFAULT_STATION.legalName;
}

function getStationTagline() {
  return PumpSettings.getCachedSync().station?.tagline || AppConfig.DEFAULT_STATION.tagline;
}

function getStationGstin() {
  return PumpSettings.getCachedSync().station?.gstin || AppConfig.DEFAULT_STATION.gstin;
}

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

function getPetrolPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.petrolPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct;
}

function getDieselPurchaseVatPct() {
  const v = Number(PumpSettings.getCachedSync().reports?.dieselPurchaseVatPct);
  return Number.isFinite(v) && v >= 0 ? v : AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct;
}

function isPurchaseTaxInclusive() {
  const r = PumpSettings.getCachedSync().reports || {};
  if (typeof r.purchaseTaxInclusive === "boolean") return r.purchaseTaxInclusive;
  return AppConfig.DEFAULT_REPORTS.purchaseTaxInclusive === true;
}

/** VAT/LST % for inward fuel by product (MS = petrol, HSD = diesel). */
function getPurchaseTaxPct(product) {
  const p = normalizeProduct(product);
  if (p === "petrol") return getPetrolPurchaseVatPct();
  if (p === "diesel") return getDieselPurchaseVatPct();
  return getFuelGstPct();
}

function getPurchaseTaxPctLabel() {
  return `MS ${getPetrolPurchaseVatPct()}% · HSD ${getDieselPurchaseVatPct()}%`;
}

/**
 * @returns {{ taxable: number, tax: number, gross: number, cgst: number, sgst: number }}
 */
function calcPurchaseLineTax(litres, ratePerLitre, taxPct, options) {
  const base = Number(litres) * Number(ratePerLitre);
  const pct = Number(taxPct);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(pct) || pct < 0) {
    return { taxable: 0, tax: 0, gross: 0, cgst: 0, sgst: 0 };
  }

  const storedGrossRate = options?.storedGrossRate === true;
  let taxable;
  let tax;
  let gross;
  if (storedGrossRate || isPurchaseTaxInclusive()) {
    gross = base;
    taxable = gross / (1 + pct / 100);
    tax = gross - taxable;
  } else {
    taxable = base;
    tax = taxable * (pct / 100);
    gross = taxable + tax;
  }

  const half = tax / 2;
  return { taxable, tax, gross, cgst: half, sgst: half };
}

function getFuelSupplierLabel() {
  return PumpSettings.getCachedSync().reports?.fuelSupplierLabel || AppConfig.DEFAULT_REPORTS.fuelSupplierLabel;
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

  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab && findReportMeta(tab)) {
    setActiveReportTab(tab);
    openGenerateSection();
  }

  document.getElementById("reports-catalog")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".reports-pick");
    if (!btn?.dataset.report) return;
    setActiveReportTab(btn.dataset.report);
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

  const initialSection = (location.hash || "").replace(/^#/, "") || "about";
  const hasReportTab = Boolean(params.get("tab") && findReportMeta(params.get("tab")));
  if (initialSection === "generate" || hasReportTab) {
    ensureReportsDataLoaded();
  }

  document.querySelectorAll('.settings-nav-item[data-section="generate"]').forEach((btn) => {
    btn.addEventListener("click", () => ensureReportsDataLoaded());
  });

  window.addEventListener("hashchange", () => {
    if ((location.hash || "").replace(/^#/, "") === "generate") {
      ensureReportsDataLoaded();
    }
  });
}

function ensureReportsDataLoaded() {
  if (cachedData) return Promise.resolve();
  if (reportsLoadInFlight) return reportsLoadInFlight;
  reportsLoadInFlight = loadAndRenderReports().finally(() => {
    reportsLoadInFlight = null;
  });
  return reportsLoadInFlight;
}

function openGenerateSection() {
  const btn = document.querySelector('.settings-nav-item[data-section="generate"]');
  if (btn) btn.click();
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

function formatDateInput(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDisplayDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatQty(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatAmt(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeProduct(v) {
  return String(v ?? "").trim().toLowerCase();
}

function splitRatio(a, b) {
  const t = Number(a) + Number(b);
  if (!Number.isFinite(t) || t <= 0) return [0.5, 0.5];
  return [Number(a) / t, Number(b) / t];
}

function reportHeader(title, start, end) {
  const gstin = getStationGstin();
  return `
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${AppConfig.BPCL_LOGO_SRC}" alt="Bharat Petroleum" class="report-bpcl-logo" width="56" height="68" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(getStationTagline())}</p>
          ${gstin ? `<p class="report-gstin">GSTIN: ${escapeHtml(gstin)}</p>` : ""}
          <p class="report-title">${escapeHtml(title)}</p>
          <p class="report-period">Period: ${formatDisplayDate(start)} &nbsp;–&nbsp; ${formatDisplayDate(end)}</p>
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
        ? formatDisplayDate(rangeStart)
        : `${formatDisplayDate(rangeStart)} – ${formatDisplayDate(rangeEnd)}`;
  }

  if (preview) preview.textContent = "Loading…";
  setReportPrintButtonWaiting();

  const cacheKey = `reports_${rangeStart}_${rangeEnd}`;
  const fetchFn = () => fetchReportData(rangeStart, rangeEnd);

  try {
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

async function fetchReportData(start, end) {
  const receiptHistoryStart = PumpSettings.getReceiptHistoryStart();
  const [
    dsrResult,
    stockResult,
    expenseResult,
    invoiceResult,
    categoryResult,
  ] = await Promise.all([
    supabaseClient
      .from("dsr")
      .select(
        "date, product, sales_pump1, sales_pump2, total_sales, testing, stock, receipts, petrol_rate, diesel_rate, buying_price_per_litre"
      )
      .gte("date", receiptHistoryStart)
      .lte("date", end)
      .order("date", { ascending: true }),
    supabaseClient.rpc("get_dsr_stock_range", { p_start: start, p_end: end }),
    supabaseClient
      .from("expenses")
      .select("date, category, amount, description")
      .gte("date", start)
      .lte("date", end),
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

  const allDsr = dsrResult.data ?? [];
  const dsrData = allDsr.filter((row) => row.date >= start && row.date <= end);
  const receiptRows = allDsr
    .filter(
      (row) =>
        Number(row.receipts ?? 0) > 0 &&
        row.buying_price_per_litre != null
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  const errors = [
    dsrResult.error,
    stockResult.error,
    expenseResult.error,
    invoiceResult.error,
    categoryResult.error,
  ].filter(Boolean);
  if (errors.length) throw errors[0];

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

  const categoryMap = {};
  (categoryResult.data ?? []).forEach((c) => {
    categoryMap[c.name] = c.label;
  });

  return {
    dsrRows: dsrData,
    stockRows: stockResult.data ?? [],
    expenseRows: expenseResult.data ?? [],
    invoices,
    invoiceItems,
    categoryMap,
    receiptRows,
  };
}

function mergeDsrStock(dsrRows, stockRows) {
  const map = new Map();
  dsrRows.forEach((row) => {
    const key = `${row.date}-${row.product}`;
    map.set(key, { ...row });
  });
  stockRows.forEach((row) => {
    const key = `${row.date}-${row.product}`;
    map.set(key, { ...(map.get(key) || {}), ...row, product: row.product, date: row.date });
  });
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function buildEffectiveBuyingMap(receiptRows) {
  const byProduct = new Map();
  receiptRows.forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!byProduct.has(p)) byProduct.set(p, []);
    byProduct.get(p).push({
      date: row.date,
      buying_price_per_litre: Number(row.buying_price_per_litre),
    });
  });
  byProduct.forEach((list) => list.sort((a, b) => b.date.localeCompare(a.date)));
  return function getEffectiveBuying(product, date) {
    const list = byProduct.get(normalizeProduct(product));
    if (!list?.length) return null;
    const found = list.find((r) => r.date <= date);
    return found != null && Number.isFinite(found.buying_price_per_litre)
      ? found.buying_price_per_litre
      : null;
  };
}

function buildTankDsrSection(product, tankLabel, capacity, pumpIndex, rows, rateField) {
  const lines = [];
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
        <td>${formatDisplayDate(row.date)}</td>
        <td class="num">${formatQty(openingDip)}</td>
        <td class="num">${formatQty(purchase)}</td>
        <td class="num">${formatQty(testing)}</td>
        <td class="num">${formatQty(saleMeter)}</td>
        <td class="num">${formatQty(actualSale)}</td>
        <td class="num">${formatQty(cumSale)}</td>
        <td class="num">${formatQty(saleByDip)}</td>
        <td class="num">${formatQty(closingDip)}</td>
        <td class="num">${formatQty(variance)}</td>
        <td class="num">${formatQty(cumVariance)}</td>
        <td class="num">${formatAmt(rate)}</td>
      </tr>`;
    })
    .join("");

  const productLabel = product === "diesel" ? "Diesel" : "Petrol";

  return `
    <section class="report-tank-section">
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
            <td class="num"><strong>${formatQty(totalPurchase)}</strong></td>
            <td class="num"><strong>${formatQty(totalTesting)}</strong></td>
            <td class="num"><strong>${formatQty(totalMeter)}</strong></td>
            <td class="num"><strong>${formatQty(totalActual)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatQty(lastClosing)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatQty(cumVariance)}</strong></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <p class="report-note muted">Stock dip is shared across pumps; purchase, opening, and dip are split by pump sale ratio.</p>
    </section>`;
}

function renderTankWiseDsr(data, range) {
  const merged = mergeDsrStock(data.dsrRows, data.stockRows);
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
    sections += `<p class="muted">No meter readings in this period. Enter data on Meter Reading page.</p>`;
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
      }
    }
  });

  return slabTotals;
}

function renderGstSummaryTable(slabTotals, title, range, inward) {
  const activeSlabs = GST_SLABS.filter((s) => slabHasActivity(slabTotals[s.key]));
  const rows = activeSlabs
    .map((s) => {
      const t = slabTotals[s.key];
      const lineTax = t.cgst + t.sgst;
      return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatAmt(t.taxable)}</td>
      <td class="num">${inward ? formatAmt(lineTax) : formatAmt(t.cgst)}</td>
      <td class="num">${inward ? "—" : formatAmt(t.sgst)}</td>
      <td class="num">${formatAmt(t.gross)}</td>
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

  return `
    ${reportHeader(title, range.start, range.end)}
    <p class="report-subtitle">${subtitle}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>
          <th>${inward ? "Slab" : "Slab"}</th>
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
          <td class="num"><strong>${formatAmt(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatAmt(inward ? totalVat : totalCgst)}</strong></td>
          <td class="num"><strong>${inward ? "—" : formatAmt(totalSgst)}</strong></td>
          <td class="num"><strong>${formatAmt(totalGross)}</strong></td>
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Total taxable ${inward ? "inward" : "outward"} value: <strong>${formatAmt(totalTaxable)}</strong> · Gross: <strong>${formatAmt(totalGross)}</strong></p>`;
}

function renderGstSalesSummary(data, range) {
  const slabs = aggregateInvoiceGst(data.invoices, data.invoiceItems);
  return renderGstSummaryTable(slabs, "Outward supply — GST summary (Lube & billing)", range, false);
}

function renderGstSalesDetail(data, range) {
  const itemsByInvoice = new Map();
  data.invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const rows = data.invoices
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

      return `<tr>
        <td>${formatDisplayDate(inv.invoice_date)}</td>
        <td>${escapeHtml(inv.invoice_number)}</td>
        <td>${escapeHtml(inv.party_name)}</td>
        <td>${escapeHtml(inv.party_gstin || "—")}</td>
        <td class="num">${hasGst || taxable > 0 ? formatAmt(taxable) : "—"}</td>
        <td class="num">${formatAmt(cgst)}</td>
        <td class="num">${formatAmt(sgst)}</td>
        <td class="num">${formatAmt(nonGst + nilRate)}</td>
        <td class="num">${formatAmt(inv.total_amount)}</td>
      </tr>`;
    })
    .join("");

  return `
    ${reportHeader("Outward supply — GST detail register", range.start, range.end)}
    <table class="report-table report-gst-detail">
      <thead>
        <tr>
          <th>Date</th>
          <th>Invoice</th>
          <th>Party</th>
          <th>GSTIN</th>
          <th class="num">Taxable</th>
          <th class="num">CGST</th>
          <th class="num">SGST</th>
          <th class="num">Exempt</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="9" class="muted">No invoices in period</td></tr>`}</tbody>
    </table>`;
}

/**
 * Collect fuel receipt lines in range with a resolvable buying rate.
 * Uses row buying price when set; otherwise latest buying price on or before that date
 * (same logic as Trading A/c / P&amp;L).
 */
function collectFuelPurchaseLines(data, range) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  const getBuying = buildEffectiveBuyingMap(data.receiptRows ?? []);
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
    const rowRate = Number(r.buying_price_per_litre);
    const rate =
      Number.isFinite(rowRate) && rowRate > 0 ? rowRate : getBuying(r.product, r.date);
    addLine(r.date, r.product, litres, rate);
  });

  return lines.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      normalizeProduct(a.product).localeCompare(normalizeProduct(b.product))
  );
}

function countReceiptsMissingBuying(data, range) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  const getBuying = buildEffectiveBuyingMap(data.receiptRows ?? []);
  return (data.dsrRows ?? []).filter((r) => {
    if (!inRange(r) || Number(r.receipts ?? 0) <= 0) return false;
    const rowRate = Number(r.buying_price_per_litre);
    if (Number.isFinite(rowRate) && rowRate > 0) return false;
    const effective = getBuying(r.product, r.date);
    return effective == null || !Number.isFinite(effective) || effective <= 0;
  }).length;
}

function buildFuelPurchaseRows(data, range) {
  const purchaseLines = collectFuelPurchaseLines(data, range);
  const slabTotals = {};
  GST_SLABS.forEach((s) => {
    slabTotals[s.key] = { taxable: 0, cgst: 0, sgst: 0, gross: 0 };
  });

  const detailRows = purchaseLines.map(({ date, product, litres, rate }) => {
    const taxPct = getPurchaseTaxPct(product);
    const slabKey = classifyGstSlab(taxPct);
    const { taxable, tax, gross, cgst, sgst } = calcPurchaseLineTax(litres, rate, taxPct, {
      storedGrossRate: true,
    });

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
    missingBuyingCount: countReceiptsMissingBuying(data, range),
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
    <p class="report-note muted">Based on stock receipts (L) and buying price (${escapeHtml(getBuyingPriceUnitLabel())}, ex-VAT on dashboard). VAT/LST: ${escapeHtml(
      getPurchaseTaxPctLabel()
    )}. ${
      isPurchaseTaxInclusive()
        ? "Buying rate treated as tax-inclusive."
        : "Buying rate treated as pre-tax; VAT/LST added on taxable value."
    }</p>`;
}

function renderGstPurchaseDetail(data, range) {
  const { detailRows, missingBuyingCount } = buildFuelPurchaseRows(data, range);

  const rows = detailRows
    .map(
      (r) => {
        const prod = normalizeProduct(r.product);
        const ref = prod === "petrol" ? "MS" : prod === "diesel" ? "HSD" : String(r.product).toUpperCase();
        return `<tr>
      <td>${formatDisplayDate(r.date)}</td>
      <td>${escapeHtml(ref)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td class="num">${formatQty(r.litres)}</td>
      <td class="num">${formatBuyingRatePerKl(r.rate)}</td>
      <td class="num">${formatAmt(r.taxable)}</td>
      <td class="num">${r.taxPct}%</td>
      <td class="num">${formatAmt(r.tax)}</td>
      <td class="num">${formatAmt(r.gross)}</td>
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
    <p class="report-note muted">${escapeHtml(getPurchaseTaxPctLabel())}. Buying rate in database is tax-inclusive (VAT/LST included when saved from P&amp;L).</p>`;
}

function computeTradingAndPl(data, range) {
  const getBuying = buildEffectiveBuyingMap(data.receiptRows);
  const merged = mergeDsrStock(data.dsrRows, data.stockRows);

  const products = {
    petrol: { label: "Petrol (MS)", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0, openingL: 0, closingL: 0 },
    diesel: { label: "Diesel (HSD)", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0, openingL: 0, closingL: 0 },
    lube: { label: "Lubricant / Billing", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0 },
  };

  merged.forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!products[p]) return;
    const netL = Math.max(Number(row.total_sales ?? 0) - Number(row.testing ?? 0), 0);
    const rate = p === "petrol" ? Number(row.petrol_rate ?? 0) : Number(row.diesel_rate ?? 0);
    const buyingRate = getBuying(row.product, row.date) ?? Number(row.buying_price_per_litre ?? 0);
    products[p].sales += netL * rate;
    products[p].purchase += Number(row.receipts ?? 0) * buyingRate;
  });

  ["petrol", "diesel"].forEach((p) => {
    const prodRows = merged.filter((r) => normalizeProduct(r.product) === p);
    if (!prodRows.length) return;
    const first = prodRows[0];
    const last = prodRows[prodRows.length - 1];
    products[p].openingL = Number(first.opening_stock ?? 0);
    products[p].closingL = Number(last.dip_stock ?? last.stock ?? 0);
    const openBuy = getBuying(p, first.date) ?? 0;
    const closeBuy = getBuying(p, last.date) ?? openBuy;
    products[p].openingStockVal = products[p].openingL * openBuy;
    products[p].closingStockVal = products[p].closingL * closeBuy;
  });

  products.lube.sales = data.invoices.reduce((s, i) => s + Number(i.total_amount ?? 0), 0);

  const grossSales = Object.values(products).reduce((s, x) => s + x.sales, 0);
  const totalPurchase = Object.values(products).reduce((s, x) => s + x.purchase, 0);
  const openingStock = Object.values(products).reduce((s, x) => s + x.openingStockVal, 0);
  const closingStock = Object.values(products).reduce((s, x) => s + x.closingStockVal, 0);

  const grossIncome = grossSales + closingStock - openingStock - totalPurchase;

  const expensesByCategory = new Map();
  data.expenseRows.forEach((e) => {
    const key = e.category || "misc";
    const label = data.categoryMap[key] || key || "Miscellaneous";
    if (!expensesByCategory.has(key)) expensesByCategory.set(key, { label, amount: 0 });
    expensesByCategory.get(key).amount += Number(e.amount ?? 0);
  });
  const totalExpenses = data.expenseRows.reduce((s, e) => s + Number(e.amount ?? 0), 0);
  const netProfit = grossIncome - totalExpenses;

  return { products, grossSales, totalPurchase, openingStock, closingStock, grossIncome, expensesByCategory, totalExpenses, netProfit };
}

function renderTradingAccount(data, range) {
  const t = computeTradingAndPl(data, range);
  const creditRows = [
    ["Sales — Petrol", t.products.petrol.sales],
    ["Sales — Diesel", t.products.diesel.sales],
    ["Sales — Lube / Billing", t.products.lube.sales],
    ["Closing stock (at cost)", t.closingStock],
  ];
  const debitRows = [
    ["Opening stock (at cost)", t.openingStock],
    ["Purchases — Fuel receipts", t.totalPurchase],
    ["Gross income c/d", t.grossIncome],
  ];

  const renderSide = (title, rows, excludeFromTotal = []) => {
    const body = rows
      .map(
        ([label, amt]) =>
          `<tr><td>${escapeHtml(label)}</td><td class="num">${formatAmt(amt)}</td></tr>`
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
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatAmt(total)}</strong></td></tr></tfoot>
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
    <p class="report-note muted">Stock valued at effective buying price from receipts (${escapeHtml(getBuyingPriceUnitLabel())} on dashboard, stored per litre). Lube sales from billing invoices.</p>`;
}

function renderProfitLoss(data, range) {
  const t = computeTradingAndPl(data, range);
  const expenseRows = Array.from(t.expensesByCategory.values()).sort(
    (a, b) => b.amount - a.amount
  );

  const expenseHtml = expenseRows
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.label)}</td><td class="num">${formatAmt(e.amount)}</td></tr>`
    )
    .join("");

  return `
    ${reportHeader("Profit & loss account", range.start, range.end)}
    <table class="report-table">
      <thead><tr><th>Particulars</th><th>Amount (₹)</th></tr></thead>
      <tbody>
        <tr><td>Gross income b/f (from trading)</td><td class="num">${formatAmt(t.grossIncome)}</td></tr>
        ${expenseHtml}
        <tr class="report-total-row"><td><strong>Net profit</strong></td><td class="num"><strong>${formatAmt(t.netProfit)}</strong></td></tr>
      </tbody>
      <tfoot>
        <tr><td>Total expenses</td><td class="num">${formatAmt(t.totalExpenses)}</td></tr>
      </tfoot>
    </table>
    <p class="report-note muted">Expenses from Expenses page. Gross income matches trading account for the same period.</p>`;
}

const REPORT_PRINT_CSS_URL = "css/reports-print.css?v=3";

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
  return html
    .replace(/src="[^"]*bpcl-logo[^"]*"/gi, `src="${reportsAssetUrl("assets/bpcl-logo.png")}"`)
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "");
}

function buildPrintSheetWrapped(reportBodyHtml, reportId, range) {
  const meta = findReportMeta(reportId);
  const title = meta?.title || "Report";
  const periodLabel = range
    ? range.start === range.end
      ? formatDisplayDate(range.start)
      : `${formatDisplayDate(range.start)} – ${formatDisplayDate(range.end)}`
    : "";

  return `
    <div class="report-print-sheet" data-report="${escapeHtml(reportId)}">
      ${reportBodyHtml}
      <footer class="report-print-foot">
        <span>${escapeHtml(getStationLegalName())}</span>
        <span>${escapeHtml(title)}${periodLabel ? ` · ${escapeHtml(periodLabel)}` : ""}</span>
      </footer>
    </div>`;
}

async function waitForPrintFrameReady(doc, win) {
  await new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 5000);
    const finish = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    if (win.document.readyState === "complete") {
      finish();
    } else {
      win.addEventListener("load", finish, { once: true });
    }
  });

  const logo = doc.querySelector(".report-bpcl-logo");
  if (logo && !logo.complete) {
    await new Promise((resolve) => {
      logo.addEventListener("load", resolve, { once: true });
      logo.addEventListener("error", resolve, { once: true });
      window.setTimeout(resolve, 2500);
    });
  }

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  void doc.body.offsetHeight;
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

  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Report print");
  iframe.style.cssText =
    "position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    throw new Error("Print frame unavailable");
  }

  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${cssText.replace(/<\/style/gi, "<\\/style")}</style>
</head>
<body class="report-print-body">
  <div class="report-print-container">${sheetWrapped}</div>
</body>
</html>`);
  doc.close();

  try {
    await waitForPrintFrameReady(doc, win);
    const cleanup = () => iframe.remove();
    win.addEventListener("afterprint", cleanup, { once: true });
    win.focus();
    win.print();
    window.setTimeout(cleanup, 5000);
  } catch (err) {
    iframe.remove();
    throw err;
  }
}

function renderActiveReport() {
  const preview = document.getElementById("reports-preview");
  const printRoot = document.getElementById("reports-print-root");

  if (!cachedData || !cachedRange) {
    if (preview && preview.textContent !== "Loading…") {
      preview.innerHTML =
        "<p class=\"muted\">Select dates and click <strong>Load data</strong> to generate this report.</p>";
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
