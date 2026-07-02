/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppError, PumpSettings, loadPumpSettings, createDateRangeFilter, formatDateInput, formatDateRangeLabel, normalizeProduct, formatQuantity, DsrQueries, buildEffectiveBuyingMap, computeFuelRowMargin, isTestingExpenseCategory */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "analysis",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "setup", validSections: ["setup", "metrics", "charts", "insights"] });
  }

  await loadPumpSettings();
  await initAnalysisPage();
});

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  const sign = n >= 0 ? "" : "";
  return sign + n.toFixed(1) + "%";
}

// --- Data fetch ---


async function fetchAnalysisData(startDate, endDate) {
  const [dsrBundle, expenseResult] = await Promise.all([
    DsrQueries.fetchDsrRows(startDate, endDate),
    DsrQueries.fetchExpenses(startDate, endDate),
  ]);

  if (dsrBundle.error) throw dsrBundle.error;
  if (expenseResult.error) throw expenseResult.error;

  return {
    dsrData: dsrBundle.data ?? [],
    expenseData: expenseResult.data ?? [],
    receiptRows: dsrBundle.receiptRows ?? [],
  };
}

/**
 * Build daily series: for each date in [start, end], compute sales (₹), cost (₹), expenses (₹), profit (₹), petrol L, diesel L.
 * Cost uses landed buying rate: (pre-VAT + delivery/L) × (1 + VAT%). Profit = sales − cost − expenses (testing excluded).
 */
function buildDailySeries(dsrData, expenseData, receiptRows, startDate, endDate) {
  const getEffectiveBuying = buildEffectiveBuyingMap(receiptRows);
  const byDate = new Map();
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = formatDateInput(d);
    byDate.set(key, {
      date: key,
      salesRupees: 0,
      costRupees: 0,
      expenseRupees: 0,
      petrolL: 0,
      dieselL: 0,
      petrolRupees: 0,
      dieselRupees: 0,
    });
  }

  (dsrData ?? []).forEach((row) => {
    const key = row.date;
    if (!byDate.has(key)) return;
    const { revenue, cost, litres } = computeFuelRowMargin(row, getEffectiveBuying);
    if (litres <= 0) return;
    const entry = byDate.get(key);
    entry.salesRupees += revenue;
    entry.costRupees += cost;
    if (normalizeProduct(row.product) === "petrol") {
      entry.petrolL += litres;
      entry.petrolRupees += revenue;
    } else {
      entry.dieselL += litres;
      entry.dieselRupees += revenue;
    }
  });

  (expenseData ?? []).forEach((row) => {
    const key = row.date;
    if (!byDate.has(key)) return;
    if (isTestingExpenseCategory(row.category)) return;
    byDate.get(key).expenseRupees += Number(row.amount ?? 0);
  });

  const series = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => ({
      ...v,
      profitRupees: v.salesRupees - v.costRupees - v.expenseRupees,
    }));

  return series;
}

/**
 * Get previous period of same length (number of days) before current start.
 */
function getPreviousPeriodStartEnd(currentStart, currentEnd) {
  const start = new Date(`${currentStart}T00:00:00`);
  const end = new Date(`${currentEnd}T00:00:00`);
  const days = Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - days + 1);
  return {
    start: formatDateInput(prevStart),
    end: formatDateInput(prevEnd),
  };
}

function computeGrowthPercent(currentTotal, previousTotal) {
  if (!Number.isFinite(previousTotal) || previousTotal === 0) return null;
  if (!Number.isFinite(currentTotal)) return null;
  return ((currentTotal - previousTotal) / previousTotal) * 100;
}

// --- UI: label, KPIs, charts ---

function setStatTone(el, value, isPercent) {
  if (!el) return;
  el.classList.remove("stat-positive", "stat-negative");
  if (value === null || value === undefined || (isPercent && value === 0)) return;
  if (Number(value) > 0) el.classList.add("stat-positive");
  else if (Number(value) < 0) el.classList.add("stat-negative");
}

function formatGrowthPercent(value) {
  if (value === null || value === undefined) return "—";
  return (value >= 0 ? "+" : "") + value.toFixed(1) + "%";
}

function formatDayLabel(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function setKpiCurrency(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value != null ? formatCurrency(value) : "—";
}

function setKpiPercent(id, value, withTone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value != null ? formatPercent(value) : "—";
  if (withTone) setStatTone(el, value, true);
}

function setKpiQuantity(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value != null ? formatQuantity(value) : "—";
}

function setKpiGrowth(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === null) {
    el.textContent = "—";
    el.classList.remove("stat-positive", "stat-negative");
    return;
  }
  el.textContent = formatGrowthPercent(value);
  setStatTone(el, value, true);
}

function renderKPIs(totals, growthPercent, insights) {
  const growthNoteEl = document.getElementById("analysis-growth-note");

  setKpiCurrency("analysis-total-sales", totals.salesRupees);
  setKpiCurrency("analysis-total-expenses", totals.expenseRupees);
  setKpiCurrency("analysis-profit", totals.profitRupees);
  setStatTone(document.getElementById("analysis-profit"), totals.profitRupees, false);

  const growthEl = document.getElementById("analysis-growth");
  if (growthEl) {
    if (growthPercent === null) {
      growthEl.textContent = "—";
      growthEl.classList.remove("stat-positive", "stat-negative");
      if (growthNoteEl) growthNoteEl.textContent = "vs previous period (no prior data)";
    } else {
      growthEl.textContent = formatGrowthPercent(growthPercent);
      setStatTone(growthEl, growthPercent, true);
      if (growthNoteEl) growthNoteEl.textContent = "vs previous period";
    }
  }

  setKpiCurrency("analysis-fuel-cost", insights.fuelCostRupees);
  setKpiCurrency("analysis-gross-profit", insights.grossProfitRupees);
  setStatTone(document.getElementById("analysis-gross-profit"), insights.grossProfitRupees, false);
  setKpiPercent("analysis-gross-margin", insights.grossMarginPct, true);
  setKpiPercent("analysis-cost-ratio", insights.costRatioPct, false);
  setKpiCurrency("analysis-avg-daily-profit", insights.avgDailyProfit);
  setKpiCurrency("analysis-avg-daily-expenses", insights.avgDailyExpenses);
  setKpiCurrency("analysis-revenue-per-litre", insights.revenuePerLitre);
  setKpiCurrency("analysis-profit-per-litre", insights.profitPerLitre);
  setStatTone(document.getElementById("analysis-profit-per-litre"), insights.profitPerLitre, false);

  setKpiQuantity("analysis-total-volume", insights.totalVolumeL);
  setKpiQuantity("analysis-avg-daily-volume", insights.avgDailyVolume);
  setKpiQuantity("analysis-petrol-volume", insights.petrolVolumeL);
  setKpiQuantity("analysis-diesel-volume", insights.dieselVolumeL);
  setKpiPercent("analysis-petrol-share", insights.petrolSharePct, false);
  setKpiPercent("analysis-diesel-share", insights.dieselSharePct, false);

  setKpiCurrency("analysis-avg-daily-sales", insights.avgDailySales);
  setKpiPercent("analysis-profit-margin", insights.profitMarginPct, true);
  setKpiPercent("analysis-expense-ratio", insights.expenseRatioPct, false);
  setKpiGrowth("analysis-profit-growth", insights.profitGrowthPercent);

  const bestDayEl = document.getElementById("analysis-best-day");
  const bestDayDateEl = document.getElementById("analysis-best-day-date");
  if (bestDayEl) bestDayEl.textContent = insights.bestDayAmount != null ? formatCurrency(insights.bestDayAmount) : "—";
  if (bestDayDateEl) bestDayDateEl.textContent = insights.bestDayDate ?? "—";

  const worstProfitEl = document.getElementById("analysis-worst-profit-day");
  const worstProfitDateEl = document.getElementById("analysis-worst-profit-date");
  if (worstProfitEl) worstProfitEl.textContent = insights.worstProfitAmount != null ? formatCurrency(insights.worstProfitAmount) : "—";
  if (worstProfitDateEl) worstProfitDateEl.textContent = insights.worstProfitDate ?? "—";
  setStatTone(worstProfitEl, insights.worstProfitAmount, false);

  const daysWithSalesEl = document.getElementById("analysis-days-with-sales");
  const daysWithSalesNoteEl = document.getElementById("analysis-days-with-sales-note");
  if (daysWithSalesEl) daysWithSalesEl.textContent = insights.daysWithSales != null ? String(insights.daysWithSales) : "—";
  if (daysWithSalesNoteEl) {
    daysWithSalesNoteEl.textContent =
      insights.totalDays != null ? `of ${insights.totalDays} calendar days` : "active days";
  }

  const daysProfitableEl = document.getElementById("analysis-days-profitable");
  const daysProfitableNoteEl = document.getElementById("analysis-days-profitable-note");
  if (daysProfitableEl) daysProfitableEl.textContent = insights.daysProfitable != null ? String(insights.daysProfitable) : "—";
  if (daysProfitableNoteEl) {
    daysProfitableNoteEl.textContent = insights.totalDays != null ? `of ${insights.totalDays} days` : "of period";
  }

  const lossDaysEl = document.getElementById("analysis-loss-days");
  if (lossDaysEl) lossDaysEl.textContent = insights.lossDays != null ? String(insights.lossDays) : "—";
  if (insights.lossDays > 0) lossDaysEl?.classList.add("stat-negative");
  else lossDaysEl?.classList.remove("stat-negative");
}

function renderInsights(series, totals, insights) {
  const list = document.getElementById("analysis-insights-list");
  if (!list) return;

  const items = [];
  if (insights.bestDayDate && insights.bestDayAmount != null) {
    items.push(`Best sales day: ${insights.bestDayDate} — ${formatCurrency(insights.bestDayAmount)}`);
  }
  if (insights.worstProfitDate && insights.worstProfitAmount != null) {
    items.push(`Lowest profit day: ${insights.worstProfitDate} — ${formatCurrency(insights.worstProfitAmount)}`);
  }
  if (insights.grossMarginPct != null && Number.isFinite(insights.grossMarginPct)) {
    items.push(`Gross margin (before expenses): ${formatPercent(insights.grossMarginPct)}`);
  }
  if (insights.profitPerLitre != null && insights.totalVolumeL > 0) {
    items.push(`Net profit per litre: ${formatCurrency(insights.profitPerLitre)}/L across ${formatQuantity(insights.totalVolumeL)} L sold`);
  }
  if (insights.lossDays != null && insights.lossDays > 0 && insights.totalDays != null) {
    items.push(`${insights.lossDays} loss day(s) in the period — review fuel cost and expenses on those dates.`);
  }
  if (insights.daysWithSales != null && insights.totalDays != null && insights.daysWithSales < insights.totalDays) {
    const idle = insights.totalDays - insights.daysWithSales;
    if (idle > 0) {
      items.push(`${idle} calendar day(s) had no recorded sales in DSR.`);
    }
  }
  if (insights.expenseRatioPct != null && totals.salesRupees > 0) {
    items.push(`Expense ratio: ${formatPercent(insights.expenseRatioPct)} of sales`);
  }
  if (insights.petrolSharePct != null) {
    items.push(`Petrol contributed ${formatPercent(insights.petrolSharePct)} of revenue; diesel ${formatPercent(100 - insights.petrolSharePct)}`);
  }
  if (insights.daysProfitable != null && insights.totalDays != null && insights.totalDays > 0) {
    items.push(`Profitable on ${insights.daysProfitable} of ${insights.totalDays} days`);
  }
  if (insights.profitMarginPct != null && Number.isFinite(insights.profitMarginPct)) {
    items.push(`Net profit margin: ${formatPercent(insights.profitMarginPct)}`);
  }
  if (insights.profitGrowthPercent != null && Number.isFinite(insights.profitGrowthPercent)) {
    const dir = insights.profitGrowthPercent >= 0 ? "up" : "down";
    items.push(`Profit ${dir} ${formatPercent(Math.abs(insights.profitGrowthPercent))} vs previous period — ${insights.profitGrowthPercent >= 0 ? "keep it up" : "review costs and pricing"}.`);
  }
  if (insights.expenseRatioPct != null && totals.salesRupees > 0 && insights.expenseRatioPct > 15) {
    items.push(`Expense ratio above 15% — consider tracking categories in Expenses to control costs.`);
  }

  if (items.length === 0) {
    list.innerHTML = "<p class=\"analysis-insight-empty muted\" role=\"listitem\">No insights for this range. Add DSR and expense data to see trends.</p>";
    return;
  }
  list.innerHTML = items
    .map((text) => `<div class="analysis-insight-card" role="listitem">${text}</div>`)
    .join("");
}

let chartSales = null;
let chartProfit = null;
let chartFuelMix = null;
let chartRevenueMix = null;

function updateAnalysisPeriodLabel(range) {
  const label = document.getElementById("analysis-date-label");
  if (!label || !range) return;
  if (typeof formatDateRangeLabel === "function") {
    label.textContent = formatDateRangeLabel(range, range.modeInfo, { style: "compact" });
  }
}

function goToAnalysisSection(sectionId) {
  const btn = document.querySelector(`.settings-nav-item[data-section="${sectionId}"]`);
  if (btn) btn.click();
}

function resizeAnalysisCharts() {
  [chartSales, chartProfit, chartFuelMix, chartRevenueMix].forEach((chart) => {
    try {
      chart?.resize();
    } catch {
      /* chart may not be initialised yet */
    }
  });
}

function wireChartsSectionResize() {
  document.querySelectorAll(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.section === "charts") {
        requestAnimationFrame(() => resizeAnalysisCharts());
      }
    });
  });
}

function destroyCharts() {
  if (chartSales) { chartSales.destroy(); chartSales = null; }
  if (chartProfit) { chartProfit.destroy(); chartProfit = null; }
  if (chartFuelMix) { chartFuelMix.destroy(); chartFuelMix = null; }
  if (chartRevenueMix) { chartRevenueMix.destroy(); chartRevenueMix = null; }
}

function renderCharts(series, totals) {
  destroyCharts();

  const labels = series.map((d) => {
    const date = new Date(`${d.date}T00:00:00`);
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  });
  const salesData = series.map((d) => d.salesRupees);
  const expenseData = series.map((d) => d.expenseRupees);
  const profitData = series.map((d) => d.profitRupees);
  const petrolRevenueData = series.map((d) => d.petrolRupees ?? 0);
  const dieselRevenueData = series.map((d) => d.dieselRupees ?? 0);

  const grid = { color: "rgba(15, 23, 42, 0.06)" };
  const fontFamily = "inherit";
  const rupeeTick = (value) => "₹" + (value >= 1000 ? value / 1000 + "k" : value);
  const legendLabels = { color: "#334155", font: { family: fontFamily, size: 12 } };
  const scaleTicks = { color: "#64748b", font: { family: fontFamily, size: 11 } };
  const bpclBlue = "#0070c0";
  const bpclBlueSoft = "rgba(0, 112, 192, 0.12)";
  const bpclYellow = "#ffcc00";
  const bpclGreen = "#007a33";
  const bpclRed = "#e60012";

  const salesCtx = document.getElementById("chart-sales")?.getContext("2d");
  if (salesCtx) {
    chartSales = new Chart(salesCtx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Net sale (₹)",
            data: salesData,
            borderColor: bpclBlue,
            backgroundColor: bpclBlueSoft,
            fill: true,
            tension: 0.25,
            pointRadius: 2,
            pointHoverRadius: 5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid, ticks: { ...scaleTicks, maxRotation: 45 } },
          y: { grid, ticks: { ...scaleTicks, callback: (v) => rupeeTick(v) } },
        },
      },
    });
  }

  const revenueMixCtx = document.getElementById("chart-revenue-mix")?.getContext("2d");
  if (revenueMixCtx) {
    chartRevenueMix = new Chart(revenueMixCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Petrol (₹)", data: petrolRevenueData, backgroundColor: "rgba(0, 112, 192, 0.85)", borderColor: bpclBlue, borderWidth: 1, borderRadius: 4 },
          { label: "Diesel (₹)", data: dieselRevenueData, backgroundColor: "rgba(255, 204, 0, 0.9)", borderColor: "#e6b800", borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: legendLabels } },
        scales: {
          x: { grid, stacked: true, ticks: { ...scaleTicks, maxRotation: 45 } },
          y: { grid, stacked: true, ticks: { ...scaleTicks, callback: (v) => rupeeTick(v) } },
        },
      },
    });
  }

  const profitCtx = document.getElementById("chart-profit")?.getContext("2d");
  if (profitCtx) {
    chartProfit = new Chart(profitCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Profit (₹)", data: profitData, backgroundColor: "rgba(0, 122, 51, 0.65)", borderColor: bpclGreen, borderWidth: 1, borderRadius: 4 },
          { label: "Expenses (₹)", data: expenseData, backgroundColor: "rgba(230, 0, 18, 0.55)", borderColor: bpclRed, borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: legendLabels } },
        scales: {
          x: { grid, ticks: { ...scaleTicks, maxRotation: 45 } },
          y: { grid, ticks: { ...scaleTicks, callback: (v) => rupeeTick(v) } },
        },
      },
    });
  }

  const fuelCtx = document.getElementById("chart-fuel-mix")?.getContext("2d");
  if (fuelCtx) {
    const petrolL = series.reduce((s, d) => s + d.petrolL, 0);
    const dieselL = series.reduce((s, d) => s + d.dieselL, 0);
    chartFuelMix = new Chart(fuelCtx, {
      type: "doughnut",
      data: {
        labels: ["Petrol (L)", "Diesel (L)"],
        datasets: [
          {
            data: [petrolL, dieselL],
            backgroundColor: [bpclBlue, bpclYellow],
            borderWidth: 2,
            borderColor: "#fff",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: legendLabels },
        },
      },
    });
  }
}

function computeInsights(series, totals, profitGrowthPercent) {
  const numDays = series.length;
  const daysWithSales = series.filter((d) => d.salesRupees > 0).length;
  const avgDailySales = numDays > 0 ? totals.salesRupees / numDays : null;
  const profitMarginPct =
    totals.salesRupees > 0
      ? (totals.profitRupees / totals.salesRupees) * 100
      : null;
  const petrolL = series.reduce((s, d) => s + d.petrolL, 0);
  const dieselL = series.reduce((s, d) => s + d.dieselL, 0);
  const totalVolumeL = petrolL + dieselL;
  const expenseRatioPct =
    totals.salesRupees > 0
      ? (totals.expenseRupees / totals.salesRupees) * 100
      : null;
  const bestDay =
    series.length > 0
      ? series.reduce((a, b) => (b.salesRupees > a.salesRupees ? b : a), series[0])
      : null;
  const worstProfitDay =
    series.length > 0
      ? series.reduce((a, b) => (b.profitRupees < a.profitRupees ? b : a), series[0])
      : null;
  const daysProfitable = series.filter((d) => d.profitRupees > 0).length;
  const lossDays = series.filter((d) => d.profitRupees < 0).length;
  const petrolRevenue = series.reduce((s, d) => s + (d.petrolRupees ?? 0), 0);
  const dieselRevenue = series.reduce((s, d) => s + (d.dieselRupees ?? 0), 0);
  const totalRevenue = petrolRevenue + dieselRevenue;
  const petrolSharePct = totalRevenue > 0 ? (petrolRevenue / totalRevenue) * 100 : null;
  const dieselSharePct = totalRevenue > 0 ? (dieselRevenue / totalRevenue) * 100 : null;

  const fuelCostRupees = totals.costRupees;
  const grossProfitRupees = totals.salesRupees - fuelCostRupees;
  const grossMarginPct =
    totals.salesRupees > 0 ? (grossProfitRupees / totals.salesRupees) * 100 : null;
  const costRatioPct =
    totals.salesRupees > 0 ? (fuelCostRupees / totals.salesRupees) * 100 : null;
  const avgDailyProfit = numDays > 0 ? totals.profitRupees / numDays : null;
  const avgDailyExpenses = numDays > 0 ? totals.expenseRupees / numDays : null;
  const avgDailyVolume = numDays > 0 && totalVolumeL > 0 ? totalVolumeL / numDays : null;
  const revenuePerLitre = totalVolumeL > 0 ? totals.salesRupees / totalVolumeL : null;
  const profitPerLitre = totalVolumeL > 0 ? totals.profitRupees / totalVolumeL : null;

  return {
    numDays,
    avgDailySales,
    profitMarginPct,
    totalVolumeL: totalVolumeL > 0 ? totalVolumeL : null,
    petrolVolumeL: petrolL > 0 ? petrolL : null,
    dieselVolumeL: dieselL > 0 ? dieselL : null,
    avgDailyVolume: avgDailyVolume != null && avgDailyVolume > 0 ? avgDailyVolume : null,
    expenseRatioPct,
    fuelCostRupees,
    grossProfitRupees,
    grossMarginPct,
    costRatioPct,
    avgDailyProfit,
    avgDailyExpenses,
    revenuePerLitre,
    profitPerLitre,
    bestDayAmount: bestDay ? bestDay.salesRupees : null,
    bestDayDate: bestDay?.date ? formatDayLabel(bestDay.date) : null,
    worstProfitAmount: worstProfitDay ? worstProfitDay.profitRupees : null,
    worstProfitDate: worstProfitDay?.date ? formatDayLabel(worstProfitDay.date) : null,
    daysWithSales,
    daysProfitable,
    lossDays,
    totalDays: numDays,
    petrolSharePct,
    dieselSharePct,
    profitGrowthPercent: profitGrowthPercent ?? null,
  };
}

async function loadAndRender(range) {
  const label = document.getElementById("analysis-date-label");
  const salesEl = document.getElementById("analysis-total-sales");
  const applyBtn = document.getElementById("analysis-apply");
  if (label) label.textContent = "Loading…";
  if (salesEl) salesEl.textContent = "…";
  if (applyBtn) applyBtn.disabled = true;

  try {
    await loadChartJs();

    const { dsrData, expenseData, receiptRows } = await fetchAnalysisData(range.start, range.end);
    const series = buildDailySeries(dsrData, expenseData, receiptRows, range.start, range.end);

    const totals = {
      salesRupees: series.reduce((s, d) => s + d.salesRupees, 0),
      costRupees: series.reduce((s, d) => s + (d.costRupees ?? 0), 0),
      expenseRupees: series.reduce((s, d) => s + d.expenseRupees, 0),
      profitRupees: 0,
    };
    totals.profitRupees = totals.salesRupees - totals.costRupees - totals.expenseRupees;

    let growthPercent = null;
    let profitGrowthPercent = null;
    try {
      const prev = getPreviousPeriodStartEnd(range.start, range.end);
      const prevData = await fetchAnalysisData(prev.start, prev.end);
      const prevSeries = buildDailySeries(
        prevData.dsrData,
        prevData.expenseData,
        prevData.receiptRows,
        prev.start,
        prev.end
      );
      const prevSales = prevSeries.reduce((s, d) => s + d.salesRupees, 0);
      const prevProfit = prevSeries.reduce((s, d) => s + (d.profitRupees ?? 0), 0);
      growthPercent = computeGrowthPercent(totals.salesRupees, prevSales);
      profitGrowthPercent = computeGrowthPercent(totals.profitRupees, prevProfit);
    } catch {
      // no prior data or error
    }

    const insights = computeInsights(series, totals, profitGrowthPercent);

    renderKPIs(totals, growthPercent, insights);
    renderInsights(series, totals, insights);
    renderCharts(series, totals);
    goToAnalysisSection("metrics");
  } catch (err) {
    AppError.report(err, { context: "loadAndRender" });
    if (label) label.textContent = "Could not load analysis. Check connection and try again.";
  } finally {
    updateAnalysisPeriodLabel(range);
    if (applyBtn) applyBtn.disabled = false;
  }
}

function loadChartJs() {
  if (typeof window.Chart !== "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1";
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(script);
  });
}

async function initAnalysisPage() {
  if (!document.getElementById("analysis-range")) return;

  const filterApi = createDateRangeFilter({
    storageKey: "analysis",
    ranges: ["this-week", "this-month", "last-3-months", "custom"],
    defaultRange: "this-month",
    rangeSelect: "analysis-range",
    startInput: "analysis-start",
    endInput: "analysis-end",
    customRange: "analysis-custom-range",
    form: "analysis-filter-form",
    applyBtn: "analysis-apply",
    labelEl: "analysis-date-label",
    labelStyle: "compact",
    trigger: "manual",
    runOnInit: false,
    onApply: (range) => loadAndRender(range),
  });

  const previewPeriodLabel = () => {
    const range = filterApi?.getRange();
    if (range) updateAnalysisPeriodLabel(range);
  };
  document.getElementById("analysis-range")?.addEventListener("change", previewPeriodLabel);
  document.getElementById("analysis-start")?.addEventListener("change", previewPeriodLabel);
  document.getElementById("analysis-end")?.addEventListener("change", previewPeriodLabel);
  previewPeriodLabel();

  wireChartsSectionResize();

  try {
    await loadChartJs();
  } catch (err) {
    AppError.report(err, { context: "initAnalysisPage", type: "chartjs" });
  }
}
