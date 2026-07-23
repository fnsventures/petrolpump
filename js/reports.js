/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppError, escapeHtml, GST_SLABS, PumpSettings, loadPumpSettings, AppConfig, formatBuyingRatePerKl, getBuyingPriceUnitLabel, normalizeProduct, getPetrolPurchaseVatPct, getDieselPurchaseVatPct, getPurchaseTaxPct, getPurchaseGstSummaryNote, getPurchaseGstDetailNote, calcPurchaseLineTax, DsrQueries, getDsrNetSaleLitres, getDsrSaleRate, createBuyingRateContext, resolveStoredBuyingRate, getEffectiveBuyingRate, getLandedBuyingRateForDate, computeProfitLossSummary, computeFuelRowMargin, isTestingExpenseCategory, isTestingExpenseRow, getExpenseCategoryLabel, buildExpenseCategoryMap, formatNumericDate, formatNumberPlain, initDocsAccordion, PrintUtils, fuelRowClass, formatFuelBadge */

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
          "MS/HSD stock, sales, purchases; optional vault lube purchases. Gross income c/d balances debit and credit.",
      },
      {
        id: "pl",
        title: "Profit & Loss",
        description:
          "Margin-based books layout: Gross Profit on credit; expense heads and Nett Profit on debit (same as Dashboard).",
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

/**
 * Daily fuel outward invoices for GST detail (SFC-style).
 * One NIL-rated voucher per product per day with sale — MS tank then HSD tank.
 * Numbers are sequential within the selected report range (SFC/0001 …).
 */
function buildFuelSalesDailyInvoices(dsrRows, range) {
  const gstPct = FUEL_OUTWARD_GST_PCT;
  const slabKey = classifyGstSlab(gstPct);
  const productOrder = { petrol: 0, diesel: 1 };

  const daily = (dsrRows ?? [])
    .filter((row) => row.date >= range.start && row.date <= range.end)
    .map((row) => {
      const product = normalizeProduct(row.product);
      if (product !== "petrol" && product !== "diesel") return null;
      const { litres, gross } = calcDailyFuelSale(row);
      if (litres <= 0 && gross <= 0) return null;
      return {
        date: row.date,
        product,
        productLabel: product === "petrol" ? "Petrol (MS)" : "Diesel (HSD)",
        litres,
        gross,
        nilValue: gross,
        gstPct,
        slabKey,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        partyName: "Cash A/c",
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (productOrder[a.product] ?? 9) - (productOrder[b.product] ?? 9)
    );

  return daily.map((line, index) => ({
    ...line,
    invoiceNumber: `SFC/${String(index + 1).padStart(4, "0")}`,
  }));
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
    const b = base[s.key] || emptySlabBucket();
    const a = addition[s.key] || emptySlabBucket();
    out[s.key] = {
      taxable: b.taxable + a.taxable,
      cgst: b.cgst + a.cgst,
      sgst: b.sgst + a.sgst,
      igst: (b.igst || 0) + (a.igst || 0),
      gross: b.gross + a.gross,
    };
  });
  return out;
}

function emptySlabBucket() {
  return { taxable: 0, cgst: 0, sgst: 0, igst: 0, gross: 0 };
}

function emptySlabTotals() {
  const slabTotals = {};
  GST_SLABS.forEach((s) => {
    slabTotals[s.key] = emptySlabBucket();
  });
  return slabTotals;
}

function fuelSalesToSlabTotals(lines) {
  const slabTotals = emptySlabTotals();
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
      slabTotals[key].igst += Number(line.igst || 0);
      slabTotals[key].gross += line.gross;
    }
  });
  return slabTotals;
}

/** First two chars of GSTIN = Indian state code. */
function gstinStateCode(gstin) {
  const g = String(gstin || "")
    .trim()
    .toUpperCase();
  return g.length >= 2 ? g.slice(0, 2) : "";
}

function getStationGstinStateCode() {
  return gstinStateCode(typeof PumpSettings !== "undefined" ? PumpSettings.getStationGstin() : "");
}

/** True when party GSTIN state differs from station GSTIN state. Missing party GSTIN → intra-state. */
function isInterstatePartyGstin(partyGstin) {
  const partyState = gstinStateCode(partyGstin);
  const stationState = getStationGstinStateCode();
  if (!partyState || !stationState) return false;
  return partyState !== stationState;
}

function getFuelSupplierLabel() {
  return PumpSettings.getCachedSync().reports?.fuelSupplierLabel || AppConfig.DEFAULT_REPORTS.fuelSupplierLabel;
}

function getFuelSupplierGstin() {
  const fromSettings = PumpSettings.getCachedSync().reports?.fuelSupplierGstin;
  if (fromSettings != null && String(fromSettings).trim()) return String(fromSettings).trim().toUpperCase();
  return AppConfig.DEFAULT_REPORTS.fuelSupplierGstin || "";
}

/** Prefer receipt-row GSTIN, else Settings default. */
function resolveSupplierGstin(rowGstin) {
  const fromRow = rowGstin != null ? String(rowGstin).trim() : "";
  if (fromRow) return fromRow.toUpperCase();
  return getFuelSupplierGstin();
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

/** Parse tank capacity strings like "20KL" / "15 Kl" / "15000L" to litres. */
function parseReportTankCapacityLiters(capacityStr) {
  if (!capacityStr) return null;
  const s = String(capacityStr).trim().toUpperCase().replace(/\s/g, "");
  const kl = s.match(/^([\d.]+)KL$/);
  if (kl) return Number(kl[1]) * 1000;
  const l = s.match(/^([\d.]+)L$/);
  if (l) return Number(l[1]);
  const num = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function buildTankDsrSection(product, tankLabel, capacity, rows, rateField) {
  let cumSale = 0;
  let cumVariance = 0;
  let totalPurchase = 0;
  let totalShortage = 0;
  let totalTesting = 0;
  let totalMeter = 0;
  let totalActual = 0;
  let lastClosing = 0;
  let lastTva = null;
  const capacityL = parseReportTankCapacityLiters(capacity);

  const bodyRows = rows
    .map((row) => {
      const openingDip = Number(row.opening_stock ?? 0);
      const purchase = Number(row.receipts ?? 0);
      const testing = Number(row.testing ?? 0);
      const saleMeter = Number(row.total_sales ?? 0);
      const actualSale = getDsrNetSaleLitres(row);
      cumSale += actualSale;
      const closingDip = Number(row.dip_stock ?? row.stock ?? 0);
      // Physical shortage (L): book closing − dip when books are higher than dip.
      const shortage = Math.max(0, Number(row.variation ?? 0));
      const bookTotal = Math.max(openingDip + purchase - shortage, 0);
      // Sale by dip uses full open+buy−close (shortage is a separate stock signal).
      const saleByDip = Math.max(openingDip + purchase - closingDip, 0);
      lastClosing = closingDip;
      const variance = actualSale - saleByDip;
      cumVariance += variance;
      const tva =
        capacityL != null && Number.isFinite(closingDip)
          ? Math.max(0, capacityL - closingDip)
          : null;
      lastTva = tva;

      totalPurchase += purchase;
      totalShortage += shortage;
      totalTesting += testing;
      totalMeter += saleMeter;
      totalActual += actualSale;

      const rate = Number(row[rateField] ?? 0);

      return `<tr>
        <td>${formatNumericDate(row.date)}</td>
        <td class="num">${formatNumberPlain(openingDip)}</td>
        <td class="num">${formatNumberPlain(purchase)}</td>
        <td class="num">${formatNumberPlain(shortage)}</td>
        <td class="num">${formatNumberPlain(bookTotal)}</td>
        <td class="num">${formatNumberPlain(testing)}</td>
        <td class="num">${formatNumberPlain(saleMeter)}</td>
        <td class="num">${formatNumberPlain(actualSale)}</td>
        <td class="num">${formatNumberPlain(cumSale)}</td>
        <td class="num">${formatNumberPlain(saleByDip)}</td>
        <td class="num">${formatNumberPlain(closingDip)}</td>
        <td class="num">${formatNumberPlain(variance)}</td>
        <td class="num">${formatNumberPlain(cumVariance)}</td>
        <td class="num">${formatNumberPlain(rate)}</td>
        <td class="num">${tva == null ? "—" : formatNumberPlain(tva)}</td>
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
            <th scope="col" class="num" title="Purchase / receipts (L)">Buy</th>
            <th scope="col" class="num" title="Physical shortage (L): max(0, book − dip)">Short</th>
            <th scope="col" class="num" title="Book total = open + buy − short (L)">Total</th>
            <th scope="col" class="num" title="Testing (L)">Test</th>
            <th scope="col" class="num" title="Sale by meter (L)">Meter</th>
            <th scope="col" class="num" title="Actual sale (L)">Actual</th>
            <th scope="col" class="num" title="Cumulative sale (L)">Cum</th>
            <th scope="col" class="num" title="Sale by dip (L)">Dip</th>
            <th scope="col" class="num" title="Closing dip (L)">Close</th>
            <th scope="col" class="num" title="Variance = actual − sale by dip (L)">Var</th>
            <th scope="col" class="num" title="Cumulative variance (L)">CumV</th>
            <th scope="col" class="num" title="Selling rate (₹/L)">Rate</th>
            <th scope="col" class="num" title="Tank volume available = capacity − closing dip (L)">TVA</th>
          </tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="15" class="muted">No entries</td></tr>`}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(totalPurchase)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalShortage)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(totalTesting)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalMeter)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalActual)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(lastClosing)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(cumVariance)}</strong></td>
            <td></td>
            <td class="num"><strong>${lastTva == null ? "—" : formatNumberPlain(lastTva)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </section>`;
}

function renderTankWiseDsr(data, range) {
  const merged = DsrQueries.mergeDsrStock(data.dsrRows, data.stockRows);
  const tanks = PumpSettings.getCachedSync().reports?.tanks || AppConfig.DEFAULT_REPORT_TANKS;

  let sections = reportHeader("Tank-wise DSR report", range.start, range.end);
  let any = false;
  tanks.forEach((tank) => {
    const rows = merged.filter((r) => normalizeProduct(r.product) === tank.product);
    if (!rows.length) return;
    any = true;
    const rateField = tank.product === "petrol" ? "petrol_rate" : "diesel_rate";
    sections += buildTankDsrSection(tank.product, tank.label, tank.capacity, rows, rateField);
  });
  if (!any) {
    sections += `<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>`;
  } else {
    sections += `<p class="report-note muted">One section per physical tank (HSD and MS). Short = max(0, book − dip); Total = open + buy − short; Actual = meter − testing; Var = actual − sale by dip (open + buy − close); TVA = tank capacity − closing dip.</p>`;
  }
  return sections;
}

/** Per-product Fuel Income metrics for one DSR day. */
function fuelIncomeMetrics(row, buyingCtx) {
  if (!row) {
    return { litres: 0, saleRate: 0, buyRate: null, income: null, missingBuy: false };
  }
  const litres = getDsrNetSaleLitres(row);
  const saleRate = getDsrSaleRate(row);
  const buyRate = getEffectiveBuyingRate(row, buyingCtx);
  const missingBuy = litres > 0 && buyRate == null;
  const income =
    buyRate != null && litres > 0 ? litres * (saleRate - buyRate) : null;
  return { litres, saleRate, buyRate, income, missingBuy };
}

function formatFuelIncomeCell(value, { empty = "—" } = {}) {
  if (value == null || !Number.isFinite(value)) return empty;
  return formatNumberPlain(value);
}

function renderFuelIncome(data, range) {
  const buyingContext = createBuyingRateContext(data.receiptRows);
  const byDate = new Map();

  (data.dsrRows ?? []).forEach((row) => {
    const date = row.date;
    if (!date) return;
    if (!byDate.has(date)) byDate.set(date, { petrol: null, diesel: null });
    const product = normalizeProduct(row.product);
    if (product === "petrol" || product === "diesel") {
      byDate.get(date)[product] = row;
    }
  });

  const dates = [...byDate.keys()].sort();
  let totalPetrolL = 0;
  let totalDieselL = 0;
  let totalPetrolInc = 0;
  let totalDieselInc = 0;
  let missingBuyDays = 0;

  const bodyRows = dates
    .map((date) => {
      const day = byDate.get(date);
      const petrol = fuelIncomeMetrics(day.petrol, buyingContext);
      const diesel = fuelIncomeMetrics(day.diesel, buyingContext);
      if (petrol.missingBuy || diesel.missingBuy) missingBuyDays += 1;

      totalPetrolL += petrol.litres;
      totalDieselL += diesel.litres;
      if (petrol.income != null) totalPetrolInc += petrol.income;
      if (diesel.income != null) totalDieselInc += diesel.income;

      const dayIncome =
        (petrol.income != null ? petrol.income : 0) + (diesel.income != null ? diesel.income : 0);
      const dayIncomeDisplay =
        petrol.income == null && diesel.income == null && (petrol.litres > 0 || diesel.litres > 0)
          ? "—"
          : formatNumberPlain(dayIncome);

      return `<tr>
        <td>${formatNumericDate(date)}</td>
        <td class="num">${formatFuelIncomeCell(petrol.litres || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(petrol.saleRate || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(petrol.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(petrol.income)}</td>
        <td class="num">${formatFuelIncomeCell(diesel.litres || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(diesel.saleRate || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(diesel.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(diesel.income)}</td>
        <td class="num"><strong>${dayIncomeDisplay}</strong></td>
      </tr>`;
    })
    .join("");

  const totalIncome = totalPetrolInc + totalDieselInc;
  const missingNote =
    missingBuyDays > 0
      ? `<p class="report-note warning">${missingBuyDays} day(s) have sale litres but no landed buying rate — P.Rate / P.Income blank for those products. Enter buying price on the Dashboard P&amp;L for receipt days.</p>`
      : "";

  return `
    ${reportHeader("Fuel Sale Income Report", range.start, range.end)}
    <table class="report-table report-fuel-income-table">
      <thead>
        <tr>
          <th rowspan="2" scope="col">Date</th>
          <th colspan="4" scope="colgroup">Petrol (MS)</th>
          <th colspan="4" scope="colgroup">Diesel (HSD)</th>
          <th rowspan="2" scope="col" class="num">Total Income</th>
        </tr>
        <tr>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate ₹/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate ₹/L">P.Rate</th>
          <th scope="col" class="num" title="Margin ₹">P.Income</th>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate ₹/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate ₹/L">P.Rate</th>
          <th scope="col" class="num" title="Margin ₹">P.Income</th>
        </tr>
      </thead>
      <tbody>${
        bodyRows ||
        `<tr><td colspan="10" class="muted">No meter readings in this period.</td></tr>`
      }</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalPetrolL)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(totalPetrolInc)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalDieselL)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(totalDieselInc)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalIncome)}</strong></td>
        </tr>
      </tfoot>
    </table>
    ${missingNote}
    <p class="report-note muted">P.Income = net litres (meter − testing) × (selling rate − landed buying rate incl. VAT + delivery). Same fuel-margin basis as Dashboard P&amp;L.</p>`;
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
    clearReportDerivedCache();
    renderActiveReport();
  } catch (err) {
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
    supabaseClient
      .from("invoice_documents")
      .select("id, invoice_date, vendor, amount, category, title, drive_web_view_link")
      .eq("category", "purchase")
      .gte("invoice_date", start)
      .lte("invoice_date", end),
  ]);

  const invoices = invoiceResult.data ?? [];
  let invoiceItems = [];
  if (invoices.length) {
    const ids = invoices.map((i) => i.id);
    const chunkSize = 80;
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        supabaseClient
          .from("invoice_items")
          .select("invoice_id, gst_percent, amount")
          .in("invoice_id", chunk)
      )
    );
    for (const result of chunkResults) {
      if (result.error) throw result.error;
      if (result.data?.length) invoiceItems.push(...result.data);
    }
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

/**
 * Aggregate billing invoices into GST slabs.
 * When an invoice has IGST, tax is treated as interstate (igst bucket); otherwise CGST+SGST.
 */
function aggregateInvoiceGst(invoices, invoiceItems) {
  return aggregateInvoiceGstByPlace(invoices, invoiceItems).combined;
}

/** Split billing GST into inside-state (CGST+SGST) vs outside-state (IGST). */
function aggregateInvoiceGstByPlace(invoices, invoiceItems) {
  const itemsByInvoice = new Map();
  invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const inside = emptySlabTotals();
  const outside = emptySlabTotals();

  const addTo = (target, key, { taxable = 0, cgst = 0, sgst = 0, igst = 0, gross = 0 }) => {
    if (!target[key]) return;
    target[key].taxable += taxable;
    target[key].cgst += cgst;
    target[key].sgst += sgst;
    target[key].igst += igst;
    target[key].gross += gross;
  };

  invoices.forEach((inv) => {
    const items = itemsByInvoice.get(inv.id) || [];
    const headerIgst = Number(inv.igst_total ?? 0);
    const headerCgst = Number(inv.cgst_total ?? 0);
    const headerSgst = Number(inv.sgst_total ?? 0);
    const interstate =
      headerIgst > 0 || (headerCgst + headerSgst <= 0 && isInterstatePartyGstin(inv.party_gstin));
    const target = interstate ? outside : inside;

    if (items.length) {
      items.forEach((item) => {
        const amt = Number(item.amount ?? 0);
        const pct = Number(item.gst_percent ?? 0);
        const key = classifyGstSlab(pct);
        if (pct > 0) {
          const taxable = amt / (1 + pct / 100);
          const gst = amt - taxable;
          if (interstate) {
            addTo(target, key, { taxable, igst: gst, gross: amt });
          } else {
            addTo(target, key, { taxable, cgst: gst / 2, sgst: gst / 2, gross: amt });
          }
        } else if (pct === 0) {
          addTo(target, "nil", { taxable: amt, gross: amt });
        } else {
          addTo(target, "non_gst", { taxable: amt, gross: amt });
        }
      });
    } else {
      const nonGst = Number(inv.non_gst_total ?? 0);
      const nilRate = Number(inv.nil_rate_total ?? 0);
      const gross = Number(inv.total_amount ?? 0);
      const taxable = invoiceHeaderTaxable(inv);

      if (headerCgst > 0 || headerSgst > 0 || headerIgst > 0) {
        const key = classifyGstSlab(18);
        if (interstate) {
          addTo(target, key, {
            taxable,
            igst: headerIgst > 0 ? headerIgst : headerCgst + headerSgst,
            gross: taxable + headerCgst + headerSgst + headerIgst,
          });
        } else {
          addTo(target, key, {
            taxable,
            cgst: headerCgst,
            sgst: headerSgst,
            gross: taxable + headerCgst + headerSgst + headerIgst,
          });
        }
      } else if (nilRate > 0) {
        addTo(target, "nil", { taxable: nilRate, gross: nilRate });
      } else if (nonGst > 0) {
        addTo(target, "non_gst", { taxable: nonGst, gross: nonGst });
      } else if (gross > 0) {
        addTo(target, "non_gst", { taxable: gross, gross });
      }
    }
  });

  return {
    inside,
    outside,
    combined: mergeSlabTotals(inside, outside),
  };
}

function renderGstSummaryTable(slabTotals, title, range, inward, options = {}) {
  const {
    sectionOnly = false,
    sectionTitle = title,
    place = "inside", // inside | outside | all
    showIgst = place === "outside" || place === "all",
  } = options;
  const activeSlabs = GST_SLABS.filter((s) => slabHasActivity(slabTotals[s.key]));
  const rows = activeSlabs
    .map((s) => {
      const t = slabTotals[s.key] || emptySlabBucket();
      const lineTax = t.cgst + t.sgst;
      if (place === "outside") {
        return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${formatNumberPlain(t.igst || 0)}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
      }
      if (inward) {
        return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${formatNumberPlain(lineTax)}</td>
      <td class="num">${showIgst ? formatNumberPlain(t.igst || 0) : "—"}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
      }
      return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${formatNumberPlain(t.cgst)}</td>
      <td class="num">${formatNumberPlain(t.sgst)}</td>
      <td class="num">${showIgst ? formatNumberPlain(t.igst || 0) : "—"}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
    })
    .join("");

  const totalTaxable = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.taxable || 0), 0);
  const totalCgst = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.cgst || 0), 0);
  const totalSgst = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.sgst || 0), 0);
  const totalIgst = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.igst || 0), 0);
  const totalVat = totalCgst + totalSgst;
  const totalGross = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.gross || 0), 0);

  let headCols;
  let footCols;
  let colSpanEmpty;
  if (place === "outside") {
    headCols = `<th>Slab</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">Total</th>`;
    footCols = `<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalIgst)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>`;
    colSpanEmpty = 4;
  } else if (inward) {
    headCols = `<th>Slab</th><th class="num">Taxable</th><th class="num">VAT/LST</th><th class="num">${showIgst ? "IGST" : "—"}</th><th class="num">Total</th>`;
    footCols = `<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalVat)}</strong></td>
          <td class="num"><strong>${showIgst ? formatNumberPlain(totalIgst) : "—"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>`;
    colSpanEmpty = 5;
  } else {
    headCols = `<th>Slab</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">${showIgst ? "IGST" : "—"}</th><th class="num">Total</th>`;
    footCols = `<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalCgst)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalSgst)}</strong></td>
          <td class="num"><strong>${showIgst ? formatNumberPlain(totalIgst) : "—"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>`;
    colSpanEmpty = 6;
  }

  const placeLabel =
    place === "outside"
      ? "Outside state (IGST)"
      : place === "all"
        ? inward
          ? "Combined inward supply"
          : "Combined outward supply"
        : inward
          ? "Inside state inward supply"
          : "Inside state outward supply (CGST + SGST)";
  const subtitle = inward
    ? `${placeLabel} · ${escapeHtml(getPurchaseTaxPctLabel())} · ${
        isPurchaseTaxInclusive() ? "tax-inclusive rate" : "pre-tax rate (BPCL)"
      }`
    : placeLabel;

  const lead = sectionOnly
    ? `<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(sectionTitle)}</h3>`
    : reportHeader(title, range.start, range.end);
  const tail = sectionOnly ? "</section>" : "";

  const taxSummaryBits = inward
    ? `VAT/LST: <strong>${formatNumberPlain(totalVat)}</strong>${
        showIgst ? ` · IGST: <strong>${formatNumberPlain(totalIgst)}</strong>` : ""
      }`
    : `CGST: <strong>${formatNumberPlain(totalCgst)}</strong> · SGST: <strong>${formatNumberPlain(
        totalSgst
      )}</strong>${showIgst ? ` · IGST: <strong>${formatNumberPlain(totalIgst)}</strong>` : ""}`;

  return `
    ${lead}
    <p class="report-subtitle${sectionOnly ? " muted" : ""}">${subtitle}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>${headCols}</tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="${colSpanEmpty}" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          ${footCols}
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Taxable: <strong>${formatNumberPlain(totalTaxable)}</strong> · ${taxSummaryBits} · Gross: <strong>${formatNumberPlain(totalGross)}</strong></p>${tail}`;
}

function slabTotalsHaveActivity(slabTotals) {
  return GST_SLABS.some((s) => slabHasActivity(slabTotals[s.key]));
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
  const fuelInvoices = buildFuelSalesDailyInvoices(data.dsrRows, range);

  const fuelEntries = fuelInvoices.map((line) => ({
    sortDate: line.date,
    sortKey: `0-${line.invoiceNumber}`,
    html: `<tr class="${fuelRowClass(line.product)}">
        <td>${formatNumericDate(line.date)}</td>
        <td>Fuel · ${escapeHtml(line.productLabel)}</td>
        <td>${escapeHtml(line.invoiceNumber)} · ${escapeHtml(line.partyName)}</td>
        <td>—</td>
        <td class="num">${formatNumberPlain(line.litres)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${formatNumberPlain(line.nilValue ?? line.gross)}</td>
        <td class="num">${formatNumberPlain(line.gross)}</td>
      </tr>`,
  }));

  const itemsByInvoice = new Map();
  data.invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const billingEntries = includeBilling
    ? data.invoices.map((inv) => {
        const items = itemsByInvoice.get(inv.id) || [];
        const cgst = Number(inv.cgst_total ?? 0);
        const sgst = Number(inv.sgst_total ?? 0);
        const igst = Number(inv.igst_total ?? 0);
        const hasGst = cgst + sgst + igst > 0;
        const gstin = (inv.party_gstin || "").trim().toUpperCase() || "—";

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

        return {
          sortDate: inv.invoice_date,
          sortKey: `1-${inv.invoice_number}`,
          html: `<tr class="report-billing-row">
        <td>${formatNumericDate(inv.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(inv.invoice_number)} · ${escapeHtml(inv.party_name)}</td>
        <td>${escapeHtml(gstin)}</td>
        <td class="num">—</td>
        <td class="num">${hasGst || taxable > 0 ? formatNumberPlain(taxable) : "—"}</td>
        <td class="num">${formatNumberPlain(cgst)}</td>
        <td class="num">${formatNumberPlain(sgst)}</td>
        <td class="num">${formatNumberPlain(igst)}</td>
        <td class="num">${formatNumberPlain(nonGst + nilRate)}</td>
        <td class="num">${formatNumberPlain(inv.total_amount)}</td>
      </tr>`,
        };
      })
    : [];

  const bodyRows = [...fuelEntries, ...billingEntries]
    .sort(
      (a, b) => a.sortDate.localeCompare(b.sortDate) || a.sortKey.localeCompare(b.sortKey)
    )
    .map((e) => e.html)
    .join("");

  const fuelTotals = sumFuelSalesLines(fuelInvoices);
  const hasFuel = fuelInvoices.length > 0;
  const hasBilling = includeBilling && data.invoices.length > 0;
  const emptyMessage =
    !hasFuel && !hasBilling
      ? `<tr><td colspan="11" class="muted">${
          includeBilling ? "No fuel sales or billing in this period" : "No fuel sales in this period"
        }</td></tr>`
      : "";

  const billingNote = includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices are excluded (enable in Settings → Billing).</p>`;

  return `
    ${reportHeader("Outward supply — GST detail register", range.start, range.end)}
    <p class="report-subtitle muted">Fuel days as NIL invoices (SFC/####) — one voucher per tank sale day (MS, HSD). Value = net litres × that day&apos;s selling rate. Billing rows show party GSTIN and IGST when interstate.</p>
    ${billingNote}
    <table class="report-table report-gst-detail">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Invoice / Party</th>
          <th>GSTIN</th>
          <th class="num">Qty (L)</th>
          <th class="num">Taxable</th>
          <th class="num">CGST</th>
          <th class="num">SGST</th>
          <th class="num">IGST</th>
          <th class="num">Exempt / NIL</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
        ${emptyMessage}
      </tbody>
      ${
        hasFuel
          ? `<tfoot>
        <tr class="report-total-row">
          <td colspan="4"><strong>Fuel total (${fuelInvoices.length} SFC)</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.litres)}</strong></td>
          <td class="num"><strong>—</strong></td>
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
  const vaultDocs = data.vaultPurchases ?? [];
  const vaultById = new Map(vaultDocs.map((d) => [d.id, d]));
  const vaultByExactTitle = new Map();
  vaultDocs.forEach((d) => {
    const key = String(d.title || "")
      .trim()
      .toLowerCase();
    if (key && !vaultByExactTitle.has(key)) vaultByExactTitle.set(key, d);
  });
  const lines = [];
  const seen = new Set();

  const matchVaultDoc = (meta) => {
    if (meta.invoiceDocumentId && vaultById.has(meta.invoiceDocumentId)) {
      return vaultById.get(meta.invoiceDocumentId);
    }
    const invNo = String(meta.supplierInvoiceNo || "")
      .trim()
      .toLowerCase();
    if (!invNo) return null;
    if (vaultByExactTitle.has(invNo)) return vaultByExactTitle.get(invNo);
    return vaultDocs.find((d) => String(d.title || "").toLowerCase().includes(invNo)) || null;
  };

  const addLine = (date, product, litres, rate, meta = {}) => {
    const l = Number(litres);
    const rt = Number(rate);
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(rt) || rt <= 0) return;
    const key = `${date}-${normalizeProduct(product)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const vault = matchVaultDoc(meta);
    lines.push({
      date,
      product,
      litres: l,
      rate: rt,
      supplierInvoiceNo: meta.supplierInvoiceNo || vault?.title || "",
      supplierGstin: meta.supplierGstin || "",
      invoiceDocumentId: meta.invoiceDocumentId || vault?.id || null,
      driveWebViewLink: vault?.drive_web_view_link || null,
    });
  };

  (data.receiptRows ?? []).filter(inRange).forEach((r) => {
    addLine(r.date, r.product, Number(r.receipts ?? 0), Number(r.buying_price_per_litre), {
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierGstin: r.supplier_gstin,
      invoiceDocumentId: r.invoice_document_id,
    });
  });

  (data.dsrRows ?? []).filter(inRange).forEach((r) => {
    const litres = Number(r.receipts ?? 0);
    if (litres <= 0) return;
    // GST purchase register requires an entered rate on the receipt day (no provisional carry-forward).
    const ownRate = Number(r.buying_price_per_litre);
    if (!Number.isFinite(ownRate) || ownRate <= 0) return;
    addLine(r.date, r.product, litres, ownRate, {
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierGstin: r.supplier_gstin,
      invoiceDocumentId: r.invoice_document_id,
    });
  });

  return lines.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      normalizeProduct(a.product).localeCompare(normalizeProduct(b.product))
  );
}

function countReceiptsMissingBuying(data, range) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  return (data.dsrRows ?? []).filter((r) => {
    if (!inRange(r) || Number(r.receipts ?? 0) <= 0) return false;
    const rate = Number(r.buying_price_per_litre);
    return !Number.isFinite(rate) || rate <= 0;
  }).length;
}

function buildFuelPurchaseRows(data, range) {
  const getStored = createBuyingRateContext(data.receiptRows ?? []).getStored;
  const purchaseLines = collectFuelPurchaseLines(data, range, getStored);
  const missingBuyingCount = countReceiptsMissingBuying(data, range);
  const insideSlabs = emptySlabTotals();
  const outsideSlabs = emptySlabTotals();

  const detailRows = purchaseLines.map(
    ({
      date,
      product,
      litres,
      rate,
      supplierInvoiceNo,
      supplierGstin,
      invoiceDocumentId,
      driveWebViewLink,
    }) => {
    const taxPct = getPurchaseTaxPct(product);
    const slabKey = classifyGstSlab(taxPct);
    const { taxable, tax, gross, cgst, sgst } = calcPurchaseLineTax(litres, rate, taxPct);
    const gstin = resolveSupplierGstin(supplierGstin);
    const interstate = isInterstatePartyGstin(gstin);
    const target = interstate ? outsideSlabs : insideSlabs;

    if (target[slabKey]) {
      target[slabKey].taxable += taxable;
      if (interstate) {
        target[slabKey].igst += tax;
      } else {
        target[slabKey].cgst += cgst;
        target[slabKey].sgst += sgst;
      }
      target[slabKey].gross += gross;
    }

    return {
      date,
      product,
      litres,
      rate,
      taxPct,
      taxable,
      tax,
      gross,
      cgst: interstate ? 0 : cgst,
      sgst: interstate ? 0 : sgst,
      igst: interstate ? tax : 0,
      interstate,
      supplierInvoiceNo: supplierInvoiceNo || "",
      supplierGstin: gstin,
      invoiceDocumentId: invoiceDocumentId || null,
      driveWebViewLink: driveWebViewLink || null,
    };
  });

  return {
    detailRows,
    insideSlabs,
    outsideSlabs,
    slabTotals: mergeSlabTotals(insideSlabs, outsideSlabs),
    missingBuyingCount,
  };
}

function renderGstPurchaseSummary(data, range) {
  const { insideSlabs, outsideSlabs, slabTotals, detailRows, missingBuyingCount } =
    getFuelPurchaseRows(data, range);
  const missingNote =
    missingBuyingCount > 0
      ? `<p class="report-note warning">${missingBuyingCount} receipt(s) in this period have no buying price — excluded. Enter buying price on the P&amp;L dashboard.</p>`
      : "";
  const emptyNote =
    detailRows.length === 0
      ? `<p class="report-note muted">No fuel receipts with buying price in this period.</p>`
      : "";

  const insideSection = renderGstSummaryTable(insideSlabs, "Inside state", range, true, {
    sectionOnly: true,
    sectionTitle: "Inside state inward supply",
    place: "inside",
    showIgst: false,
  });
  const outsideSection = slabTotalsHaveActivity(outsideSlabs)
    ? renderGstSummaryTable(outsideSlabs, "Outside state", range, true, {
        sectionOnly: true,
        sectionTitle: "Outside state inward supply",
        place: "outside",
        showIgst: true,
      })
    : `<section class="report-gst-section"><h3 class="report-section-title">Outside state inward supply</h3><p class="muted">No interstate inward supply in this period (supplier GSTIN state matches station, or GSTIN blank).</p></section>`;
  const combined = renderGstSummaryTable(slabTotals, "Combined", range, true, {
    sectionOnly: true,
    sectionTitle: "Total inward supply summary",
    place: "all",
    showIgst: true,
  });

  return `
    ${reportHeader("Inward supply — GST summary (Fuel receipts)", range.start, range.end)}
    ${emptyNote}
    ${insideSection}
    ${outsideSection}
    ${combined}
    ${missingNote}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())} Place of supply uses supplier GSTIN vs station GSTIN.</p>`;
}

function renderGstPurchaseDetail(data, range) {
  const { detailRows, missingBuyingCount } = getFuelPurchaseRows(data, range);

  const rows = detailRows
    .map(
      (r) => {
        const prod = normalizeProduct(r.product);
        const ref = prod === "petrol" ? "MS" : prod === "diesel" ? "HSD" : String(r.product).toUpperCase();
        const invNo = r.supplierInvoiceNo ? escapeHtml(r.supplierInvoiceNo) : "—";
        const gstin = r.supplierGstin ? escapeHtml(r.supplierGstin) : "—";
        const vaultCell = r.driveWebViewLink
          ? `<a href="${escapeHtml(r.driveWebViewLink)}" target="_blank" rel="noopener">View PDF</a>`
          : r.invoiceDocumentId
            ? "Linked"
            : "—";
        return `<tr class="${fuelRowClass(prod)}">
      <td>${formatNumericDate(r.date)}</td>
      <td>${formatFuelBadge(ref)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td>${invNo}</td>
      <td>${gstin}</td>
      <td class="num">${vaultCell}</td>
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
          <th>Invoice No</th>
          <th>GSTIN</th>
          <th>Vault</th>
          <th class="num">Qty (L)</th>
          <th class="num">Rate (${escapeHtml(getBuyingPriceUnitLabel())})</th>
          <th class="num">Taxable</th>
          <th class="num">VAT%</th>
          <th class="num">VAT</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="12" class="muted">No receipts with buying price in period</td></tr>`}</tbody>
    </table>
    ${
      missingBuyingCount > 0
        ? `<p class="report-note warning">${missingBuyingCount} receipt(s) excluded — buying price not set on dashboard.</p>`
        : ""
    }
    <p class="report-note muted">Vault PDF links match DSR receipt → Invoices (purchase) by document id or invoice title. Enter invoice no with buying price on Dashboard P&amp;L. ${escapeHtml(getPurchaseGstDetailNote())}</p>`;
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
      // Prefer entered rate; else previous receipt rate (same as P&L carry-forward).
      const landedRate = getEffectiveBuyingRate(row, buyingContext);
      if (landedRate != null) products[p].purchase += receiptL * landedRate;
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
  // Vault purchase PDFs with amounts (lube / other inward — fuel purchases stay on DSR lines).
  const vaultPurchaseTotal = (data.vaultPurchases ?? []).reduce((s, row) => {
    const amt = Number(row.amount ?? 0);
    return amt > 0 ? s + amt : s;
  }, 0);
  products.lube.purchase = vaultPurchaseTotal;

  const grossSales = Object.values(products).reduce((s, x) => s + x.sales, 0);
  const totalPurchase = Object.values(products).reduce((s, x) => s + x.purchase, 0);
  const openingStock = Object.values(products).reduce((s, x) => s + x.openingStockVal, 0);
  const closingStock = Object.values(products).reduce((s, x) => s + x.closingStockVal, 0);

  // Stock-based balancing figure only (Dealer Margin is margin P&L, not a trading credit).
  const grossIncome = grossSales + closingStock - openingStock - totalPurchase;
  const pl = computeProfitLossSummary({
    dsrRows: merged,
    receiptRows: data.receiptRows,
    expenseRows: data.expenseRows,
    lubeSales: products.lube.sales,
    lubeCogs: vaultPurchaseTotal,
    requireAllBuying: true,
    buyingContext,
    categoryMap: data.categoryMap,
  });

  const expensesByCategory = new Map();
  const testingExpensesByCategory = new Map();
  data.expenseRows.forEach((e) => {
    const key = e.category || "misc";
    const label = getExpenseCategoryLabel(e, data.categoryMap);
    const amount = Number(e.amount ?? 0);
    const bucket = isTestingExpenseRow(e, data.categoryMap)
      ? testingExpensesByCategory
      : expensesByCategory;
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
    vaultPurchaseTotal,
    fuelGrossProfit: pl.canCalculate ? (pl.fuelGrossProfit ?? 0) : null,
    lubeGrossProfit: pl.canCalculate ? (pl.lubeGrossProfit ?? 0) : null,
    lubeCogs: vaultPurchaseTotal,
    grossProfit: pl.canCalculate ? (pl.grossProfit ?? 0) : null,
    expensesByCategory,
    testingExpensesByCategory,
    totalExpenses: pl.totalExpenses,
    testingExpenses: pl.testingExpenses,
    netProfit: pl.canCalculate ? pl.netProfit : null,
    canCalculate: pl.canCalculate,
    missingBuyingPrice: pl.missingBuyingPrice,
    unresolvedBuying: pl.unresolvedBuying,
    usingProvisionalBuying: pl.usingProvisionalBuying,
  };
}

function renderTradingAccount(data, range) {
  const t = getTradingAndPl(data, range);

  const creditRows = [
    ["Sales — Petrol (MS)", t.products.petrol.sales, "petrol"],
    ["Sales — Diesel (HSD)", t.products.diesel.sales, "diesel"],
    ["Sales — Lube / Billing", t.products.lube.sales, null],
    ["Closing stock — Petrol", t.products.petrol.closingStockVal, "petrol"],
    ["Closing stock — Diesel", t.products.diesel.closingStockVal, "diesel"],
  ];

  const debitRows = [
    ["Opening stock — Petrol", t.products.petrol.openingStockVal, "petrol"],
    ["Opening stock — Diesel", t.products.diesel.openingStockVal, "diesel"],
    ["Purchases — Petrol", t.products.petrol.purchase, "petrol"],
    ["Purchases — Diesel", t.products.diesel.purchase, "diesel"],
  ];
  if (t.vaultPurchaseTotal > 0) {
    debitRows.push(["Purchases — Lube / other (vault)", t.vaultPurchaseTotal, null]);
  }
  debitRows.push(["Gross income c/d", t.grossIncome, null]);

  const renderSide = (title, rows) => {
    const body = rows
      .map(
        ([label, amt, product]) =>
          `<tr class="${fuelRowClass(product)}"><td>${escapeHtml(label)}</td><td class="num">${formatNumberPlain(amt)}</td></tr>`
      )
      .join("");
    const total = rows.reduce((s, [, a]) => s + Number(a), 0);
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

  const provisionalNote =
    t.usingProvisionalBuying && t.missingBuyingPrice?.length
      ? `<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) use the previous buying rate for stock/purchases — enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on Dashboard P&amp;L to lock the correct rate.</p>`
      : !t.canCalculate
        ? formatUnresolvedBuyingWarning(t)
        : "";

  const marginNote =
    t.fuelGrossProfit != null
      ? `<p class="report-note muted">Dealer Margin (ops check, not a trading credit) = net litres × (selling − landed buying): <strong>${formatCurrency(t.fuelGrossProfit)}</strong> — same as Dashboard / P&amp;L fuel gross.</p>`
      : "";

  const vaultNote =
    t.vaultPurchaseTotal > 0
      ? `<p class="report-note muted">Lube / other purchases = sum of vault <strong>Purchase invoice</strong> amounts in this period (Invoices page). Fuel inward remains on MS/HSD purchase lines from DSR.</p>`
      : `<p class="report-note muted">No vault purchase amounts in this period — lube stock/COGS is not tracked separately. Add purchase PDFs with amounts on Invoices to populate Lube purchases.</p>`;

  return `
    ${reportHeader("Trading account", range.start, range.end)}
    <div class="report-pl-grid report-trading-grid">
      ${renderSide("Debit", debitRows)}
      ${renderSide("Credit", creditRows)}
    </div>
    <p class="report-note muted">Debit and credit totals match via Gross income c/d (stock-based: Sales + Closing − Opening − Purchases).</p>
    ${provisionalNote}
    ${marginNote}
    ${vaultNote}
    <p class="report-summary-line">Gross income c/d: <strong>${formatCurrency(t.grossIncome)}</strong></p>`;
}

function formatUnresolvedBuyingWarning(t) {
  const unit = escapeHtml(getBuyingPriceUnitLabel());
  const unresolved = t.unresolvedBuying?.length ?? 0;
  const missingOwn = t.missingBuyingPrice?.length ?? 0;
  if (!t.canCalculate) {
    const dayNote =
      unresolved > 0
        ? `${unresolved} sale/receipt day(s) have no resolvable buying rate (no prior receipt rate in history)`
        : "Some days have no resolvable buying rate";
    const ownNote =
      missingOwn > 0 ? ` (${missingOwn} receipt day(s) also have no entered ₹/KL yet)` : "";
    return `<p class="report-note warning">${dayNote}${ownNote}. Enter pre-VAT ${unit} on the Dashboard P&amp;L before net profit can be calculated.</p>`;
  }
  if (t.usingProvisionalBuying && missingOwn > 0) {
    return `<p class="report-note warning">${missingOwn} receipt day(s) still need an entered buying price — figures below use the previous receipt rate until you save ${unit} on Dashboard P&amp;L.</p>`;
  }
  return "";
}

function renderProfitLoss(data, range) {
  const t = getTradingAndPl(data, range);
  const expenseRows = Array.from(t.expensesByCategory.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );
  const testingExpenseRows = Array.from(t.testingExpensesByCategory.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );

  const buyingWarning = formatUnresolvedBuyingWarning(t);
  const expensesTotal = Number(t.totalExpenses ?? 0);

  const testingNote = testingExpenseRows.length
    ? `<p class="report-note muted">Testing expenses excluded from net profit (day closing): ${testingExpenseRows
        .map((e) => `${escapeHtml(e.label)} ₹${formatNumberPlain(e.amount)}`)
        .join("; ")}.</p>`
    : "";

  // When buying rates cannot be resolved, do not render a partial books layout
  // (credit GP=0 vs debit expenses would not balance).
  if (!t.canCalculate) {
    const expenseList =
      expenseRows.length > 0
        ? `<table class="report-table">
            <thead><tr><th>Expense head</th><th class="num">Amount (₹)</th></tr></thead>
            <tbody>${expenseRows
              .map(
                (e) =>
                  `<tr><td>${escapeHtml(e.label)}</td><td class="num">${formatNumberPlain(e.amount)}</td></tr>`
              )
              .join("")}</tbody>
            <tfoot><tr class="report-total-row"><td><strong>Total (excl. testing)</strong></td><td class="num"><strong>${formatNumberPlain(expensesTotal)}</strong></td></tr></tfoot>
          </table>`
        : `<p class="muted">No operating expenses in this period.</p>`;
    return `
      ${reportHeader("Profit & loss account", range.start, range.end)}
      ${buyingWarning}
      <p class="report-summary-line">Gross profit: <strong>—</strong> · Expenses: <strong>${formatCurrency(expensesTotal)}</strong> · Nett profit: <strong>—</strong></p>
      <h3>Operating expenses</h3>
      ${expenseList}
      ${testingNote}
      <p class="report-note muted">Books debit/credit layout is hidden until every sale/receipt day can resolve a buying rate (entered or prior receipt).</p>`;
  }

  // Margin-based books layout (same formula as Dashboard / Analysis).
  const grossProfit = Number(t.grossProfit ?? 0);
  const nettProfit = Number(t.netProfit ?? 0);

  const creditRows = [["Gross Profit", grossProfit]];
  const debitRows = expenseRows.map((e) => [e.label, e.amount]);
  debitRows.push(["Nett Profit", nettProfit]);

  const renderBooksSide = (title, rows, { boldLast = false } = {}) => {
    const body = rows
      .map(([label, amt], idx) => {
        const isLast = boldLast && idx === rows.length - 1;
        const cls = isLast ? ' class="report-total-row"' : "";
        const lab = isLast ? `<strong>${escapeHtml(label)}</strong>` : escapeHtml(label);
        const val = isLast ? `<strong>${formatNumberPlain(amt)}</strong>` : formatNumberPlain(amt);
        return `<tr${cls}><td>${lab}</td><td class="num">${val}</td></tr>`;
      })
      .join("");
    const total = rows.reduce((s, [, a]) => s + Number(a), 0);
    return `
      <div class="report-pl-column">
        <h3>${escapeHtml(title)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (₹)</th></tr></thead>
          <tbody>${body || `<tr><td colspan="2" class="muted">No entries</td></tr>`}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(total)}</strong></td></tr></tfoot>
        </table>
      </div>`;
  };

  const breakdownNote = `<p class="report-note muted">Gross profit = fuel gross <strong>${formatCurrency(t.fuelGrossProfit)}</strong>${
    t.lubeCogs > 0 || t.products.lube.sales > 0
      ? ` + lube gross <strong>${formatCurrency(t.lubeGrossProfit)}</strong> (sales − vault purchases)`
      : ""
  }. Same formula as Dashboard P&amp;L and Analysis.</p>`;

  return `
    ${reportHeader("Profit & loss account", range.start, range.end)}
    ${buyingWarning}
    <div class="report-pl-grid report-trading-grid">
      ${renderBooksSide("Debit (indirect expenses)", debitRows, { boldLast: true })}
      ${renderBooksSide("Credit", creditRows, { boldLast: true })}
    </div>
    <p class="report-summary-line">Gross profit: <strong>${formatCurrency(grossProfit)}</strong> · Expenses: <strong>${formatCurrency(expensesTotal)}</strong> · Nett profit: <strong>${formatCurrency(nettProfit)}</strong></p>
    ${testingNote}
    ${breakdownNote}`;
}

/**
 * GSTR-1 style outward register: B2B (GSTIN), B2CS (no GSTIN billing), NIL (fuel SFC).
 */
function buildGstr1Sections(data, range) {
  const includeBilling = isBillingIncludedInGstReports();
  const fuelInvoices = buildFuelSalesDailyInvoices(data.dsrRows, range);
  const nilRows = fuelInvoices.map((line) => ({
    date: line.date,
    invoiceNumber: line.invoiceNumber,
    party: line.partyName,
    gstin: "",
    taxable: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    nilValue: Number(line.nilValue ?? line.gross ?? 0),
    gross: Number(line.gross ?? 0),
    product: line.productLabel,
  }));

  const b2b = [];
  const b2cs = [];
  if (includeBilling) {
    data.invoices.forEach((inv) => {
      const gstin = (inv.party_gstin || "").trim().toUpperCase();
      const cgst = Number(inv.cgst_total ?? 0);
      const sgst = Number(inv.sgst_total ?? 0);
      const igst = Number(inv.igst_total ?? 0);
      const nonGst = Number(inv.non_gst_total ?? 0);
      const nilRate = Number(inv.nil_rate_total ?? 0);
      const taxable = invoiceHeaderTaxable(inv);
      const row = {
        date: inv.invoice_date,
        invoiceNumber: inv.invoice_number,
        party: inv.party_name,
        gstin,
        taxable,
        cgst,
        sgst,
        igst,
        nilValue: nonGst + nilRate,
        gross: Number(inv.total_amount ?? 0),
      };
      if (gstin.length >= 15) b2b.push(row);
      else b2cs.push(row);
    });
  }

  const sumRows = (rows, keys) =>
    rows.reduce((acc, r) => {
      keys.forEach((k) => {
        acc[k] = (acc[k] || 0) + Number(r[k] || 0);
      });
      return acc;
    }, {});

  return {
    includeBilling,
    nilRows,
    b2b,
    b2cs,
    nilTotals: sumRows(nilRows, ["nilValue", "gross"]),
    b2bTotals: sumRows(b2b, ["taxable", "cgst", "sgst", "igst", "gross"]),
    b2csTotals: sumRows(b2cs, ["taxable", "cgst", "sgst", "igst", "nilValue", "gross"]),
  };
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

function renderGstr1Table(title, subtitle, headers, rowsHtml, footHtml) {
  return `
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(title)}</h3>
      <p class="report-subtitle muted">${subtitle}</p>
      <table class="report-table report-gst-detail">
        <thead><tr>${headers}</tr></thead>
        <tbody>${rowsHtml}</tbody>
        ${footHtml || ""}
      </table>
    </section>`;
}

function renderGstr1Register(data, range) {
  const g = getGstr1Sections(data, range);
  const billingNote = g.includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices excluded (enable in Settings → Billing). Fuel NIL section still included.</p>`;

  const nilBody =
    g.nilRows
      .map((r) => {
        const prod = String(r.product || "").toLowerCase().includes("diesel") ? "diesel" : "petrol";
        return `<tr class="${fuelRowClass(prod)}">
      <td>${formatNumericDate(r.date)}</td>
      <td>${escapeHtml(r.invoiceNumber)}</td>
      <td>${escapeHtml(r.product || "Fuel")}</td>
      <td class="num">${formatNumberPlain(r.nilValue)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`;
      })
      .join("") || `<tr><td colspan="5" class="muted">No fuel sales in this period</td></tr>`;

  const nilFoot = g.nilRows.length
    ? `<tfoot><tr class="report-total-row">
        <td colspan="3"><strong>NIL total (${g.nilRows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(g.nilTotals.nilValue)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(g.nilTotals.gross)}</strong></td>
      </tr></tfoot>`
    : "";

  const billHeaders = `
    <th>Date</th><th>Invoice</th><th>Party</th><th>GSTIN</th>
    <th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th>
    <th class="num">IGST</th><th class="num">Exempt/NIL</th><th class="num">Gross</th>`;

  const mapBillRows = (rows) =>
    rows
      .map(
        (r) => `<tr>
      <td>${formatNumericDate(r.date)}</td>
      <td>${escapeHtml(r.invoiceNumber)}</td>
      <td>${escapeHtml(r.party)}</td>
      <td>${escapeHtml(r.gstin || "—")}</td>
      <td class="num">${formatNumberPlain(r.taxable)}</td>
      <td class="num">${formatNumberPlain(r.cgst)}</td>
      <td class="num">${formatNumberPlain(r.sgst)}</td>
      <td class="num">${formatNumberPlain(r.igst)}</td>
      <td class="num">${formatNumberPlain(r.nilValue)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="10" class="muted">No invoices in this section</td></tr>`;

  const billFoot = (rows, totals) =>
    rows.length
      ? `<tfoot><tr class="report-total-row">
        <td colspan="4"><strong>Total (${rows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.taxable)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.cgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.sgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.igst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.nilValue || 0)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.gross)}</strong></td>
      </tr></tfoot>`
      : "";

  return `
    ${reportHeader("GSTR-1 style outward register", range.start, range.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-1 — not a GST portal JSON upload. Sections mirror B2B, B2CS and NIL rated fuel (SFC).</p>
    ${billingNote}
    ${renderGstr1Table(
      "4A/4B — B2B (registered party GSTIN)",
      "Billing invoices with a 15-character party GSTIN.",
      billHeaders,
      mapBillRows(g.b2b),
      billFoot(g.b2b, g.b2bTotals)
    )}
    ${renderGstr1Table(
      "7 — B2CS (unregistered / Cash)",
      "Billing invoices without a party GSTIN.",
      billHeaders,
      mapBillRows(g.b2cs),
      billFoot(g.b2cs, g.b2csTotals)
    )}
    ${renderGstr1Table(
      "8 — NIL rated (fuel SFC)",
      "Daily fuel outward vouchers from DSR (NIL rate).",
      `<th>Date</th><th>Invoice</th><th>Product</th><th class="num">NIL value</th><th class="num">Gross</th>`,
      nilBody,
      nilFoot
    )}
    <p class="report-note muted">Use <strong>Download CSV</strong> for a flat file you can reconcile in Excel. Portal filing still requires the official GST offline tool / API.</p>`;
}

function buildGstr1Csv(data, range) {
  const g = getGstr1Sections(data, range);
  const lines = [
    ["section", "date", "invoice", "party", "gstin", "product", "taxable", "cgst", "sgst", "igst", "nil_value", "gross"].join(
      ","
    ),
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const push = (section, r) => {
    lines.push(
      [
        section,
        r.date,
        r.invoiceNumber,
        r.party || "",
        r.gstin || "",
        r.product || "",
        r.taxable ?? "",
        r.cgst ?? "",
        r.sgst ?? "",
        r.igst ?? "",
        r.nilValue ?? "",
        r.gross ?? "",
      ]
        .map(esc)
        .join(",")
    );
  };
  g.b2b.forEach((r) => push("B2B", r));
  g.b2cs.forEach((r) => push("B2CS", r));
  g.nilRows.forEach((r) => push("NIL", r));
  return lines.join("\n");
}

function downloadGstr1Csv() {
  if (!cachedData || !cachedRange) return;
  const csv = buildGstr1Csv(cachedData, cachedRange);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const start = cachedRange.start.replace(/-/g, "");
  const end = cachedRange.end.replace(/-/g, "");
  a.href = url;
  a.download = `gstr1-register_${start}_${end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatGstr1PortalDate(isoDate) {
  if (!isoDate || String(isoDate).length < 10) return "";
  const [y, m, d] = String(isoDate).slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

function gstr1FilingPeriod(range) {
  const end = String(range?.end || "").slice(0, 10);
  if (end.length < 7) return "";
  const [y, m] = end.split("-");
  return `${m}${y}`;
}

function gstr1StateCodeFromGstin(gstin) {
  const g = String(gstin || "").trim().toUpperCase();
  return g.length >= 2 ? g.slice(0, 2) : "";
}

function gstr1InvoiceRate(row) {
  const taxable = Number(row.taxable || 0);
  if (taxable <= 0) return 0;
  const tax = Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0);
  const pct = (tax / taxable) * 100;
  if (pct < 3) return 0;
  if (pct < 8) return 5;
  if (pct < 15) return 12;
  if (pct < 21) return 18;
  if (pct < 26) return 24;
  return 28;
}

/**
 * Offline GSTR-1-style JSON (aid for portal tools — verify before upload).
 */
function buildGstr1Json(data, range) {
  const g = getGstr1Sections(data, range);
  const gstin = (PumpSettings.getStationGstin?.() || PumpSettings.getCachedSync().station?.gstin || "")
    .trim()
    .toUpperCase();
  const pos = gstr1StateCodeFromGstin(gstin) || "21";
  const fp = gstr1FilingPeriod(range);

  const b2bByCtin = new Map();
  g.b2b.forEach((row) => {
    const ctin = String(row.gstin || "").trim().toUpperCase();
    if (!b2bByCtin.has(ctin)) b2bByCtin.set(ctin, []);
    const rt = gstr1InvoiceRate(row);
    const itmDet = {
      txval: Number(Number(row.taxable || 0).toFixed(2)),
      rt,
    };
    if (Number(row.igst || 0) > 0) itmDet.iamt = Number(Number(row.igst).toFixed(2));
    else {
      itmDet.camt = Number(Number(row.cgst || 0).toFixed(2));
      itmDet.samt = Number(Number(row.sgst || 0).toFixed(2));
    }
    b2bByCtin.get(ctin).push({
      inum: row.invoiceNumber,
      idt: formatGstr1PortalDate(row.date),
      val: Number(Number(row.gross || 0).toFixed(2)),
      pos: gstr1StateCodeFromGstin(ctin) || pos,
      rchrg: "N",
      inv_typ: "R",
      itms: [{ num: 1, itm_det: itmDet }],
    });
  });

  const b2b = Array.from(b2bByCtin.entries()).map(([ctin, inv]) => ({ ctin, inv }));

  const b2csMap = new Map();
  g.b2cs.forEach((row) => {
    const rt = gstr1InvoiceRate(row);
    const inter = Number(row.igst || 0) > 0;
    const key = `${inter ? "INTER" : "INTRA"}|${pos}|${rt}`;
    if (!b2csMap.has(key)) {
      b2csMap.set(key, {
        sply_ty: inter ? "INTER" : "INTRA",
        pos,
        typ: "OE",
        txval: 0,
        rt,
        iamt: 0,
        camt: 0,
        samt: 0,
        csamt: 0,
      });
    }
    const agg = b2csMap.get(key);
    agg.txval += Number(row.taxable || 0);
    agg.iamt += Number(row.igst || 0);
    agg.camt += Number(row.cgst || 0);
    agg.samt += Number(row.sgst || 0);
  });
  const b2cs = Array.from(b2csMap.values()).map((r) => ({
    ...r,
    txval: Number(r.txval.toFixed(2)),
    iamt: Number(r.iamt.toFixed(2)),
    camt: Number(r.camt.toFixed(2)),
    samt: Number(r.samt.toFixed(2)),
  }));

  const nilAmt = Number((g.nilTotals.nilValue || 0).toFixed(2));
  const nil = {
    inv: [
      {
        sply_ty: "INTRB2C",
        expt_amt: 0,
        nil_amt: nilAmt,
        ngsup_amt: 0,
      },
    ],
  };

  const docSeries = (rows, docTyp) => {
    if (!rows.length) return null;
    const nums = rows.map((r) => String(r.invoiceNumber || "")).filter(Boolean).sort();
    return {
      doc_num: docTyp,
      docs: [
        {
          num: 1,
          from: nums[0],
          to: nums[nums.length - 1],
          totnum: nums.length,
          cancel: 0,
          net_issue: nums.length,
        },
      ],
    };
  };

  const docDet = [];
  const billingDocs = [...g.b2b, ...g.b2cs];
  const billingSeries = docSeries(billingDocs, 1);
  if (billingSeries) docDet.push(billingSeries);
  const nilSeries = docSeries(g.nilRows, 4);
  if (nilSeries) docDet.push(nilSeries);

  return {
    gstin: gstin || null,
    fp,
    version: "GST3.1.6",
    hash: "hash",
    b2b,
    b2cs,
    nil,
    doc_issue: { doc_det: docDet },
    _meta: {
      note: "Internal aid for GSTR-1 filing tools. Verify every figure before portal upload.",
      range: { start: range.start, end: range.end },
      generatedAt: new Date().toISOString(),
      fuelNilCount: g.nilRows.length,
      b2bCount: g.b2b.length,
      b2csCount: g.b2cs.length,
    },
  };
}

function downloadGstr1Json() {
  if (!cachedData || !cachedRange) return;
  const payload = buildGstr1Json(cachedData, cachedRange);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const start = cachedRange.start.replace(/-/g, "");
  const end = cachedRange.end.replace(/-/g, "");
  a.href = url;
  a.download = `gstr1_${payload.fp || `${start}_${end}`}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function gstrMoney(n) {
  return Number(Number(n || 0).toFixed(2));
}

function gstrTaxBucket(txval = 0, iamt = 0, camt = 0, samt = 0, csamt = 0) {
  return {
    txval: gstrMoney(txval),
    iamt: gstrMoney(iamt),
    camt: gstrMoney(camt),
    samt: gstrMoney(samt),
    csamt: gstrMoney(csamt),
  };
}

/**
 * GSTR-3B summary figures from the same sources as GSTR-1 / purchase GST reports.
 */
function buildGstr3bSummary(data, range) {
  const g1 = getGstr1Sections(data, range);
  const purchase = getFuelPurchaseRows(data, range);

  let billingNil = 0;
  let billingNonGst = 0;
  if (g1.includeBilling) {
    (data.invoices || []).forEach((inv) => {
      billingNil += Number(inv.nil_rate_total ?? 0);
      billingNonGst += Number(inv.non_gst_total ?? 0);
    });
  }

  const osupDet = gstrTaxBucket(
    (g1.b2bTotals.taxable || 0) + (g1.b2csTotals.taxable || 0),
    (g1.b2bTotals.igst || 0) + (g1.b2csTotals.igst || 0),
    (g1.b2bTotals.cgst || 0) + (g1.b2csTotals.cgst || 0),
    (g1.b2bTotals.sgst || 0) + (g1.b2csTotals.sgst || 0),
    0
  );
  const osupNil = { txval: gstrMoney((g1.nilTotals.nilValue || 0) + billingNil) };
  const osupNongst = { txval: gstrMoney(billingNonGst) };
  const osupZero = gstrTaxBucket(0, 0, 0, 0, 0);
  const isupRev = gstrTaxBucket(0, 0, 0, 0, 0);

  // Table 3.2 — interstate B2CS (unregistered). POS not stored on invoices; omit rows when unknown.
  let interUnregTaxable = 0;
  let interUnregIgst = 0;
  g1.b2cs.forEach((row) => {
    const igst = Number(row.igst || 0);
    if (igst <= 0) return;
    interUnregTaxable += Number(row.taxable || 0);
    interUnregIgst += igst;
  });

  let itcIamt = 0;
  let itcCamt = 0;
  let itcSamt = 0;
  (purchase.detailRows || []).forEach((r) => {
    itcIamt += Number(r.igst || 0);
    itcCamt += Number(r.cgst || 0);
    itcSamt += Number(r.sgst || 0);
  });
  const itcOth = {
    ty: "OTH",
    iamt: gstrMoney(itcIamt),
    camt: gstrMoney(itcCamt),
    samt: gstrMoney(itcSamt),
    csamt: 0,
  };
  const itcZero = { iamt: 0, camt: 0, samt: 0, csamt: 0 };

  return {
    includeBilling: g1.includeBilling,
    retPeriod: gstr1FilingPeriod(range),
    osupDet,
    osupZero,
    osupNil,
    osupNongst,
    isupRev,
    interUnregTaxable: gstrMoney(interUnregTaxable),
    interUnregIgst: gstrMoney(interUnregIgst),
    itcOth,
    itcNet: {
      iamt: itcOth.iamt,
      camt: itcOth.camt,
      samt: itcOth.samt,
      csamt: 0,
    },
    itcZero,
    purchaseMissingBuying: purchase.missingBuyingCount || 0,
    purchaseLineCount: (purchase.detailRows || []).length,
    g1,
  };
}

function renderGstr3bRegister(data, range) {
  const s = getGstr3bSummary(data, range);
  const billingNote = s.includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices excluded (enable in Settings → Billing). Fuel NIL still included in 3.1(c).</p>`;
  const purchaseNote =
    s.purchaseMissingBuying > 0
      ? `<p class="report-note warning">${s.purchaseMissingBuying} fuel receipt(s) missing buying price — excluded from Table 4 ITC.</p>`
      : "";

  const row3_1 = (code, label, bucket, showTax = true) => {
    if (showTax) {
      return `<tr>
        <td>${escapeHtml(code)}</td>
        <td>${escapeHtml(label)}</td>
        <td class="num">${formatNumberPlain(bucket.txval)}</td>
        <td class="num">${formatNumberPlain(bucket.iamt)}</td>
        <td class="num">${formatNumberPlain(bucket.camt)}</td>
        <td class="num">${formatNumberPlain(bucket.samt)}</td>
        <td class="num">${formatNumberPlain(bucket.csamt || 0)}</td>
      </tr>`;
    }
    return `<tr>
      <td>${escapeHtml(code)}</td>
      <td>${escapeHtml(label)}</td>
      <td class="num">${formatNumberPlain(bucket.txval)}</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">—</td>
    </tr>`;
  };

  const interNote =
    s.interUnregIgst > 0
      ? `<p class="report-note warning">Interstate B2CS found (taxable ${formatNumberPlain(
          s.interUnregTaxable
        )}, IGST ${formatNumberPlain(
          s.interUnregIgst
        )}). Place of supply is not stored on cash invoices — enter Table 3.2 POS manually on the portal / offline tool.</p>`
      : `<p class="report-note muted">No interstate B2CS (unregistered) detected in this period.</p>`;

  return `
    ${reportHeader("GSTR-3B style summary", range.start, range.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-3B — not a guaranteed GST portal upload. Figures roll up from DSR fuel (NIL) and billing invoices; ITC from fuel receipt VAT.</p>
    ${billingNote}
    <section class="report-gst-section">
      <h3 class="report-section-title">3.1 — Outward supplies &amp; inward liable to reverse charge</h3>
      <table class="report-table report-gst-detail">
        <thead>
          <tr>
            <th>Nature</th><th>Particulars</th>
            <th class="num">Taxable</th><th class="num">IGST</th>
            <th class="num">CGST</th><th class="num">SGST</th><th class="num">Cess</th>
          </tr>
        </thead>
        <tbody>
          ${row3_1("(a)", "Outward taxable supplies (other than zero / nil / exempt)", s.osupDet)}
          ${row3_1("(b)", "Outward taxable supplies (zero rated)", s.osupZero)}
          ${row3_1("(c)", "Other outward supplies (nil rated, exempted)", s.osupNil, false)}
          ${row3_1("(d)", "Inward supplies liable to reverse charge", s.isupRev)}
          ${row3_1("(e)", "Non-GST outward supplies", s.osupNongst, false)}
        </tbody>
      </table>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">3.2 — Inter-state supplies to unregistered / composition / UIN</h3>
      ${interNote}
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">4 — Eligible ITC (from fuel receipts)</h3>
      <table class="report-table report-gst-detail">
        <thead>
          <tr>
            <th>Details</th><th class="num">IGST</th><th class="num">CGST</th>
            <th class="num">SGST</th><th class="num">Cess</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>(A) ITC Available — Other (OTH) · ${s.purchaseLineCount} receipt line(s)</td>
            <td class="num">${formatNumberPlain(s.itcOth.iamt)}</td>
            <td class="num">${formatNumberPlain(s.itcOth.camt)}</td>
            <td class="num">${formatNumberPlain(s.itcOth.samt)}</td>
            <td class="num">${formatNumberPlain(s.itcOth.csamt)}</td>
          </tr>
          <tr class="report-total-row">
            <td><strong>(C) Net ITC available</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.iamt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.camt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.samt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.csamt)}</strong></td>
          </tr>
        </tbody>
      </table>
      ${purchaseNote}
      <p class="report-note muted">Import / ISD / RCM ITC and reversals are not tracked here — leave those rows blank or fill from books.</p>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">5 — Exempt / nil / non-GST inward</h3>
      <p class="report-note muted">Not auto-filled (composition / exempt inward not tracked). Leave zeros unless you have separate purchase books.</p>
    </section>
    <p class="report-note muted">Use <strong>Download GSTR-3B JSON</strong> for an offline-utility-style summary file. Verify every figure before portal upload.</p>`;
}

/**
 * Offline GSTR-3B-style JSON (aid for portal tools — verify before upload).
 */
function buildGstr3bJson(data, range) {
  const s = getGstr3bSummary(data, range);
  const gstin = (PumpSettings.getStationGstin?.() || PumpSettings.getCachedSync().station?.gstin || "")
    .trim()
    .toUpperCase();

  const zeroTy = (ty) => ({ ty, ...s.itcZero });

  return {
    gstin: gstin || null,
    ret_period: s.retPeriod,
    sup_details: {
      osup_det: s.osupDet,
      osup_zero: { txval: s.osupZero.txval, iamt: s.osupZero.iamt, csamt: s.osupZero.csamt },
      osup_nil_exmp: s.osupNil,
      isup_rev: s.isupRev,
      osup_nongst: s.osupNongst,
    },
    inter_sup: {
      unreg_details: [],
      comp_details: [],
      uin_details: [],
    },
    eco_dtls: {
      eco_sup: gstrTaxBucket(0),
      eco_reg_sup: { txval: 0 },
    },
    itc_elg: {
      itc_avl: [
        zeroTy("IMPG"),
        zeroTy("IMPS"),
        zeroTy("ISRC"),
        zeroTy("ISD"),
        { ...s.itcOth },
      ],
      itc_rev: [zeroTy("RUL"), zeroTy("OTH")],
      itc_net: s.itcNet,
      itc_inelg: [zeroTy("RUL"), zeroTy("OTH")],
    },
    inward_sup: {
      isup_details: [
        { ty: "GST", inter: 0, intra: 0 },
        { ty: "NONGST", inter: 0, intra: 0 },
      ],
    },
    intr_ltfee: {
      intr_details: { iamt: 0, camt: 0, samt: 0, csamt: 0 },
      ltfee_details: { camt: 0, samt: 0 },
    },
    _meta: {
      note: "Internal aid for GSTR-3B filing tools. Verify every figure before portal upload. Table 3.2 POS omitted when unknown.",
      range: { start: range.start, end: range.end },
      generatedAt: new Date().toISOString(),
      interUnregTaxable: s.interUnregTaxable,
      interUnregIgst: s.interUnregIgst,
      purchaseLineCount: s.purchaseLineCount,
      purchaseMissingBuying: s.purchaseMissingBuying,
      includeBilling: s.includeBilling,
    },
  };
}

function downloadGstr3bJson() {
  if (!cachedData || !cachedRange) return;
  const payload = buildGstr3bJson(cachedData, cachedRange);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const start = cachedRange.start.replace(/-/g, "");
  const end = cachedRange.end.replace(/-/g, "");
  a.href = url;
  a.download = `gstr3b_${payload.ret_period || `${start}_${end}`}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
    case "gstr1":
      return renderGstr1Register(data, range);
    case "gstr3b":
      return renderGstr3bRegister(data, range);
    case "fuel-income":
      return renderFuelIncome(data, range);
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
