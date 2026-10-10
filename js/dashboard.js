/* global window.supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, AppDialog, getValidFilterState, setFilterState, escapeHtml, PumpSettings, loadPumpSettings, AppConfig, createDateRangeFilter, normalizeProduct, formatQuantity, formatDisplayDate, formatDateInput, getRangeForSelection, CacheInvalidation, getDsrNetSaleLitres, calculateDsrSaleRupees, computeProfitLossSummary, buildExpenseCategoryMap, sumByProduct, resolveDayFuelStock, initPersistedDateInput, getLocalDateString, getYesterdayDateString, getMonthRange, DsrQueries, TaskUtils, addDaysToDateString, appendDatedNote, toLocalDateString, mountDateStepper */

/**
 * Generate cache key for dashboard data queries
 */
function getDashboardCacheKey(startDate, endDate) {
  return `dashboard_${startDate}_${endDate}`;
}

/**
 * Generate cache key for today's sales
 * (v2: includes shift-register fallback when no finished DSR sheet)
 */
function getTodaySalesCacheKey(dateStr) {
  return `today_sales_v2_${dateStr}`;
}

/**
 * Merge finished DSR sheet rows with shift-register sales for the same date.
 * Clean model: shifts do not insert dsr_* stubs, so snapshot must read
 * get_shift_aggregated_daily_meters when the meter sheet is missing or has 0 sales.
 */
function mergeDsrRowsWithShiftSales(dsrRows, shiftAgg, dateStr) {
  const byProduct = new Map();
  for (const row of dsrRows ?? []) {
    const product = normalizeProduct(row.product);
    if (product) byProduct.set(product, { ...row, product });
  }

  for (const product of ["petrol", "diesel"]) {
    const block = shiftAgg?.[product];
    if (!block?.has_shifts) continue;
    const shiftSales = Number(block.total_sales ?? 0);
    if (!(shiftSales > 0)) continue;

    const existing = byProduct.get(product);
    const sheetSales = Number(existing?.total_sales ?? 0);
    if (sheetSales > 0) continue;

    if (existing) {
      byProduct.set(product, {
        ...existing,
        total_sales: shiftSales,
        testing: Number(block.testing ?? existing.testing ?? 0),
        _fromShiftAggregate: true,
      });
    } else {
      byProduct.set(product, {
        product,
        date: dateStr,
        total_sales: shiftSales,
        testing: Number(block.testing ?? 0),
        petrol_rate: null,
        diesel_rate: null,
        _fromShiftAggregate: true,
      });
    }
  }

  return Array.from(byProduct.values());
}

/** Copy resolved (on-date or last-entered) rates onto rows for ₹ totals. */
function applyResolvedRatesToSalesRows(rows, rates) {
  return (rows ?? []).map((row) => {
    const product = normalizeProduct(row.product);
    const next = { ...row };
    if (product === "petrol" && !(Number(next.petrol_rate) > 0) && Number(rates?.petrolRate) > 0) {
      next.petrol_rate = rates.petrolRate;
    }
    if (product === "diesel" && !(Number(next.diesel_rate) > 0) && Number(rates?.dieselRate) > 0) {
      next.diesel_rate = rates.dieselRate;
    }
    return next;
  });
}

/**
 * Generate cache key for credit summary
 */
function getCreditSummaryCacheKey(dateStr) {
  return `credit_summary_${dateStr}`;
}

let lastCreditTotalRupees = null;
let dashboardRole = null;

function formatRatePerLitre(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "—";
  }
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function updateDsrQuickLinks(dateStr) {
  const q = dateStr ? `?date=${encodeURIComponent(dateStr)}` : "";
  const petrolCta = document.getElementById("hero-petrol-cta");
  const dieselCta = document.getElementById("hero-diesel-cta");
  if (petrolCta) petrolCta.href = `meter-reading.html${q}#petrol`;
  if (dieselCta) dieselCta.href = `meter-reading.html${q}#diesel`;
}

function parseTankCapacityLiters(capacityStr) {
  if (!capacityStr) return null;
  const s = String(capacityStr).trim().toUpperCase().replace(/\s/g, "");
  const kl = s.match(/^([\d.]+)KL$/);
  if (kl) return Number(kl[1]) * 1000;
  const l = s.match(/^([\d.]+)L$/);
  if (l) return Number(l[1]);
  const num = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Physical tank capacities for dip % on the dashboard (one MS tank, one HSD tank). */
function getTankCapacities() {
  const settings = PumpSettings.getCachedSync();
  const pumps = settings.pumps || {};
  let petrol = parseTankCapacityLiters(pumps.petrol?.tankCapacity);
  let diesel = parseTankCapacityLiters(pumps.diesel?.tankCapacity);

  // reports.tanks is one section per product (HSD + MS). Prefer pumps.*.tankCapacity
  // for physical dip % (see Settings → Pump configuration).
  if (!petrol || !diesel) {
    const tanks = settings.reports?.tanks || [];
    tanks.forEach((t) => {
      const cap = parseTankCapacityLiters(t.capacity);
      if (!cap) return;
      if (!petrol && normalizeProduct(t.product) === "petrol") petrol = cap;
      if (!diesel && normalizeProduct(t.product) === "diesel") diesel = cap;
    });
  }

  if (!petrol) petrol = 15000;
  if (!diesel) diesel = 20000;
  return { petrol, diesel };
}

const tankLevelState = { petrol: 0, diesel: 0 };

function setTankFillLevel(fillEl, level01) {
  const clamped = Math.min(1, Math.max(0, Number(level01) || 0));
  const shell = fillEl?.closest(".fuel-tank-shell");
  const cylinder = fillEl?.closest(".fuel-tank-cylinder");
  const tankArticle = fillEl?.closest(".fuel-tank");
  const meter = tankArticle?.querySelector(".fuel-tank-visual[role='meter']");
  const badge = tankArticle?.querySelector(".fuel-tank-level-badge");
  if (!fillEl) return;

  const pct = Math.round(clamped * 100);

  const apply = () => {
    fillEl.style.setProperty("--tank-level", String(clamped));
    if (cylinder) cylinder.style.setProperty("--tank-level", String(clamped));
    if (shell) {
      shell.style.setProperty("--tank-level", String(clamped));
      shell.setAttribute("data-level", String(pct));
    }
    if (badge) {
      badge.textContent = clamped > 0 ? `${pct}%` : "—";
      badge.classList.toggle("fuel-tank-level-badge--hidden", clamped <= 0);
    }
    if (meter) {
      meter.setAttribute("aria-valuenow", String(pct));
    }
  };

  if (!fillEl.dataset.tankReady) {
    fillEl.dataset.tankReady = "1";
    fillEl.style.setProperty("--tank-level", "0");
    if (cylinder) cylinder.style.setProperty("--tank-level", "0");
    if (shell) shell.style.setProperty("--tank-level", "0");
    requestAnimationFrame(() => {
      requestAnimationFrame(apply);
    });
    return;
  }

  apply();
}

const DSR_RATE_FIELD = { petrol: "petrol_rate", diesel: "diesel_rate" };

function rateFromDsrRows(rows, product) {
  const field = DSR_RATE_FIELD[product];
  const entry = (rows ?? []).find((row) => normalizeProduct(row.product) === product);
  const num = Number(entry?.[field] ?? 0);
  if (!Number.isFinite(num) || num <= 0) return null;
  return { rate: num, date: entry.date ?? null };
}

function formatRateUnitLabel(isFallback, rateDate) {
  if (!isFallback) return "per litre";
  if (rateDate) return `per litre · last entered · ${formatDisplayDate(rateDate)}`;
  return "per litre · last entered";
}

/**
 * Resolve hero/snapshot rates: selected date first, then last entered rate in DSR.
 */
async function resolveRatesForDate(selectedDate, rows) {
  const petrolOnDate = rateFromDsrRows(rows, "petrol");
  const dieselOnDate = rateFromDsrRows(rows, "diesel");
  let petrolRate = petrolOnDate?.rate ?? null;
  let dieselRate = dieselOnDate?.rate ?? null;
  let petrolRateDate = petrolOnDate?.date ?? null;
  let dieselRateDate = dieselOnDate?.date ?? null;
  let petrolFallback = false;
  let dieselFallback = false;

  const [lastPetrol, lastDiesel] = await Promise.all([
    !petrolRate ? DsrQueries.fetchLastDsrRate("petrol") : Promise.resolve(null),
    !dieselRate ? DsrQueries.fetchLastDsrRate("diesel") : Promise.resolve(null),
  ]);
  if (!petrolRate && lastPetrol) {
    petrolRate = lastPetrol.rate;
    petrolRateDate = lastPetrol.date;
    petrolFallback = true;
  }
  if (!dieselRate && lastDiesel) {
    dieselRate = lastDiesel.rate;
    dieselRateDate = lastDiesel.date;
    dieselFallback = true;
  }

  return {
    petrolRate,
    dieselRate,
    petrolRateDate,
    dieselRateDate,
    petrolFallback,
    dieselFallback,
  };
}

function findLastDipStockEntry(stockData, dsrData, product, asOfDate) {
  const prod = normalizeProduct(product);
  const stockRows = (stockData ?? [])
    .filter(
      (row) =>
        row.date <= asOfDate &&
        normalizeProduct(row.product) === prod &&
        row.dip_stock != null &&
        Number.isFinite(Number(row.dip_stock)) &&
        Number(row.dip_stock) > 0
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  if (stockRows.length) {
    return { stock: Number(stockRows[0].dip_stock), date: stockRows[0].date, fromDip: true };
  }

  const dsrRows = (dsrData ?? [])
    .filter(
      (row) =>
        row.date <= asOfDate &&
        normalizeProduct(row.product) === prod &&
        row.stock != null &&
        Number.isFinite(Number(row.stock)) &&
        Number(row.stock) > 0
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  if (dsrRows.length) {
    return { stock: Number(dsrRows[0].stock), date: dsrRows[0].date, fromDip: false };
  }
  return null;
}

function dipStockOnDate(stockData, dsrData, product, dateStr) {
  const prod = normalizeProduct(product);
  const stockRows = (stockData ?? []).filter(
    (row) => row.date === dateStr && normalizeProduct(row.product) === prod
  );
  const hasDipRow = stockRows.some((row) => row.dip_stock != null && Number.isFinite(Number(row.dip_stock)));
  if (hasDipRow) {
    return {
      stock: sumByProduct(stockRows, prod, (row) => Number(row.dip_stock ?? 0)),
      date: dateStr,
      fromDip: true,
      isFallback: false,
    };
  }
  return null;
}

/**
 * Dip stock for selected date; if missing, use last entered on or before that date.
 */
function resolveDipStockWithFallback(stockData, dsrData, dateStr) {
  const petrolOnDate = dipStockOnDate(stockData, dsrData, "petrol", dateStr);
  const dieselOnDate = dipStockOnDate(stockData, dsrData, "diesel", dateStr);

  const petrolLast = petrolOnDate ?? findLastDipStockEntry(stockData, dsrData, "petrol", dateStr);
  const dieselLast = dieselOnDate ?? findLastDipStockEntry(stockData, dsrData, "diesel", dateStr);

  return {
    petrolStock: petrolLast?.stock ?? null,
    dieselStock: dieselLast?.stock ?? null,
    petrolMeta: petrolLast
      ? { date: petrolLast.date, isFallback: petrolLast.isFallback ?? petrolOnDate == null }
      : null,
    dieselMeta: dieselLast
      ? { date: dieselLast.date, isFallback: dieselLast.isFallback ?? dieselOnDate == null }
      : null,
  };
}

function formatLastEnteredHint(dateStr) {
  if (!dateStr) return "last entered";
  return `last entered · ${formatDisplayDate(dateStr)}`;
}

function updateHeroTanks(petrolStock, dieselStock, meta = {}) {
  const caps = getTankCapacities();
  const th = getLowStockThresholds();

  const applyTank = (product, stock, capacity, thresholds, stockMeta) => {
    const fillEl = document.getElementById(`hero-${product}-tank-fill`);
    const stockEl = document.getElementById(`hero-${product}-stock`);
    const pctEl = document.getElementById(`hero-${product}-stock-pct`);
    const tankEl = document.getElementById(`hero-${product}-tank`);
    if (!fillEl || !stockEl) return;

    if (stock === null || stock === undefined || !Number.isFinite(stock)) {
      tankLevelState[product] = 0;
      setTankFillLevel(fillEl, 0);
      stockEl.textContent = "—";
      if (pctEl) pctEl.textContent = "No dip reading for this date";
      if (tankEl) {
        tankEl.classList.remove("fuel-tank--low", "fuel-tank--ok");
        tankEl.classList.add("fuel-tank--empty");
      }
      return;
    }

    const level = capacity > 0 ? Math.min(1, Math.max(0, stock / capacity)) : 0;
    const pctDisplay = level * 100;
    tankLevelState[product] = level;
    setTankFillLevel(fillEl, level);
    stockEl.textContent = `${formatQuantity(stock)} L`;
    if (pctEl) {
      const capPart = `${pctDisplay.toFixed(0)}% · capacity ${formatQuantity(capacity)} L`;
      pctEl.textContent = stockMeta?.isFallback
        ? `${capPart} · ${formatLastEnteredHint(stockMeta.date)}`
        : capPart;
    }

    if (tankEl) {
      tankEl.classList.remove("fuel-tank--empty");
      const low = stock < thresholds;
      tankEl.classList.toggle("fuel-tank--low", low);
      tankEl.classList.toggle("fuel-tank--ok", !low && stock > 0);
    }
  };

  applyTank("petrol", petrolStock, caps.petrol, th.petrol, meta.petrolMeta);
  applyTank("diesel", dieselStock, caps.diesel, th.diesel, meta.dieselMeta);
}

async function loadHeroStock(dateStr) {
  const selectedDate = dateStr || getLocalDateString();
  const historyStart = PumpSettings.getReceiptHistoryStart();
  try {
    const [stockResult, dsrResult] = await Promise.all([
      window.supabaseClient.rpc("get_dsr_stock_range", {
        p_start: historyStart,
        p_end: selectedDate,
      }),
      fetchAllRows(() =>
        window.supabaseClient
          .from("dsr")
          .select("date, product, stock, dip_reading")
          .gte("date", historyStart)
          .lte("date", selectedDate)
          .order("date", { ascending: false })
          .order("product", { ascending: true })
      ),
    ]);

    if (stockResult.error) {
      AppError.report(stockResult.error, { context: "loadHeroStock", type: "stock" });
    }
    if (dsrResult.error) {
      AppError.report(dsrResult.error, { context: "loadHeroStock", type: "dsr" });
    }

    const resolved = resolveDipStockWithFallback(
      stockResult.data,
      dsrResult.data,
      selectedDate
    );
    updateHeroTanks(resolved.petrolStock, resolved.dieselStock, {
      petrolMeta: resolved.petrolMeta,
      dieselMeta: resolved.dieselMeta,
    });

    const todayStr = getLocalDateString();
    if (selectedDate === todayStr) {
      updateLowStockAlert(resolved.petrolStock, resolved.dieselStock);
    }
  } catch (error) {
    AppError.report(error, { context: "loadHeroStock" });
    updateHeroTanks(null, null);
  }
}

function updateHeroDate() {
  const dateEl = document.getElementById("dashboard-hero-date");
  const badgeEl = document.getElementById("dashboard-hero-badge");
  if (!dateEl) return;
  const todayStr = getLocalDateString();
  updateDsrQuickLinks(todayStr);
  const labelDate = new Date(`${todayStr}T00:00:00`);
  dateEl.textContent = labelDate.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  if (badgeEl) badgeEl.classList.remove("hidden");
}

function updateFuelRateDisplay(petrolRate, dieselRate, options = {}) {
  const petrolEl = document.getElementById("hero-petrol-rate");
  const dieselEl = document.getElementById("hero-diesel-rate");
  const petrolCta = document.getElementById("hero-petrol-cta");
  const dieselCta = document.getElementById("hero-diesel-cta");
  const petrolCard = document.querySelector(".fuel-rate-card--petrol");
  const dieselCard = document.querySelector(".fuel-rate-card--diesel");
  const petrolUnit = petrolCard?.querySelector(".fuel-rate-unit");
  const dieselUnit = dieselCard?.querySelector(".fuel-rate-unit");

  const petrolValid = Number.isFinite(petrolRate) && petrolRate > 0;
  const dieselValid = Number.isFinite(dieselRate) && dieselRate > 0;

  if (petrolEl) petrolEl.textContent = formatRatePerLitre(petrolRate);
  if (dieselEl) dieselEl.textContent = formatRatePerLitre(dieselRate);
  if (petrolCta) petrolCta.classList.toggle("hidden", petrolValid);
  if (dieselCta) dieselCta.classList.toggle("hidden", dieselValid);
  if (petrolCard) petrolCard.classList.toggle("fuel-rate-card--empty", !petrolValid);
  if (dieselCard) dieselCard.classList.toggle("fuel-rate-card--empty", !dieselValid);
  if (petrolUnit) {
    petrolUnit.textContent = formatRateUnitLabel(options.petrolFallback, options.petrolRateDate);
  }
  if (dieselUnit) {
    dieselUnit.textContent = formatRateUnitLabel(options.dieselFallback, options.dieselRateDate);
  }
}

function updateFuelVolumeSplit(petrolLiters, dieselLiters) {
  const petrolChip = document.getElementById("today-petrol-liters");
  const dieselChip = document.getElementById("today-diesel-liters");
  if (petrolChip) {
    petrolChip.textContent = Number.isFinite(petrolLiters) ? `${formatQuantity(petrolLiters)} L` : "—";
  }
  if (dieselChip) {
    dieselChip.textContent = Number.isFinite(dieselLiters) ? `${formatQuantity(dieselLiters)} L` : "—";
  }
}

function getLowStockThresholds() {
  const t = PumpSettings.getAlertThresholds();
  return { petrol: t.petrol, diesel: t.diesel };
}

function updateLowStockAlert(petrolStock, dieselStock) {
  window.AppNotifications?.updateLowStock?.(petrolStock, dieselStock);
}





let snapshotDsrRows = [];

let statFitRaf = null;
let statFitResizeTimer = null;

/**
 * Batch write → read → write to avoid layout thrashing across many stat tiles.
 */
function autoFitStats(scope = document) {
  if (document.hidden) return;

  const elements = Array.from(
    scope.querySelectorAll(".metric-box .stat, .stat-tile .stat")
  );
  if (!elements.length) return;

  const jobs = [];
  for (const el of elements) {
    const parent = el.parentElement;
    if (!parent) continue;
    const maxFontPx =
      Number(el.dataset.maxFontPx) ||
      Number.parseFloat(window.getComputedStyle(el).fontSize) ||
      16;
    if (!el.dataset.maxFontPx) {
      el.dataset.maxFontPx = String(maxFontPx);
    }
    const minFontPx = el.classList.contains("stat-sub") ? 10 : 12;
    jobs.push({ el, parent, maxFontPx, minFontPx, paddingPx: 2 });
  }

  // Phase 1: reset all to max size (writes only).
  for (const job of jobs) {
    job.el.style.fontSize = `${job.maxFontPx}px`;
  }

  // Phase 2: measure all (reads only).
  const sizes = jobs.map((job) => {
    const available = Math.max(
      0,
      job.parent.getBoundingClientRect().width - job.paddingPx
    );
    const needed = job.el.scrollWidth;
    return { ...job, available, needed };
  });

  // Phase 3: apply fitted sizes (writes only).
  for (const job of sizes) {
    if (!job.available || !job.needed || job.needed <= job.available) {
      job.el.style.fontSize = `${job.maxFontPx}px`;
      continue;
    }
    const ratio = job.available / job.needed;
    const next = Math.max(job.minFontPx, Math.floor(job.maxFontPx * ratio * 0.98));
    job.el.style.fontSize = `${next}px`;
  }
}

function scheduleAutoFitStats() {
  if (document.hidden) return;
  if (statFitRaf) cancelAnimationFrame(statFitRaf);
  statFitRaf = requestAnimationFrame(() => {
    statFitRaf = null;
    const scope =
      document.querySelector(".settings-panel.is-visible") ||
      document.querySelector(".settings-panel:not([hidden])") ||
      document;
    autoFitStats(scope);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "dashboard",
  });
  if (!auth) return;

  await loadPumpSettings();

  const { session, role } = auth;
  dashboardRole = role;
  applyRoleVisibility(role);

  if (typeof initPageSections === "function") {
    const dashboardSections =
      role === "admin" ? ["snapshot", "dsr", "pl"] : ["snapshot", "dsr"];
    initPageSections({
      defaultSection: "snapshot",
      validSections: dashboardSections,
      onSectionChange: (section) => {
        if (section === "dsr") void ensureDsrSectionLoaded();
        if (section === "pl" && role === "admin") void ensurePlSectionLoaded();
      },
    });
  }

  window.AppNotifications?.mount?.();

  const operatorNameEl = document.getElementById("operator-name");
  const operatorRoleEl = document.getElementById("operator-role");
  if (operatorNameEl) {
    const nameToShow = auth.display_name?.trim() || (() => {
      const email = session.user?.email ?? "";
      return email.includes("@") ? email.split("@")[0] : email || "User";
    })();
    operatorNameEl.textContent = nameToShow;
  }
  if (operatorRoleEl && role) {
    const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
    operatorRoleEl.textContent = `(${roleLabel})`;
  }

  const snapshotDateInput = document.getElementById("snapshot-date");
  const yesterdayStr = getYesterdayDateString();

  const updateSalesDailyLink = () => {
    const date = snapshotDateInput?.value || yesterdayStr;
    const base = `dsr.html?date=${encodeURIComponent(date)}`;
    for (const [id, hash] of [
      ["sales-daily-link", ""],
      ["sales-daily-ms-link", "#dsr-petrol"],
      ["sales-daily-hsd-link", "#dsr-diesel"],
    ]) {
      document.getElementById(id)?.setAttribute("href", base + hash);
    }
  };

  let snapshotDateStr = yesterdayStr;
  if (snapshotDateInput) {
    const onSnapshotDate = async (dateValue) => {
      updateSalesDailyLink();
      await Promise.all([
        loadTodaySales(dateValue),
        loadCreditSummary(dateValue),
        loadHeroStock(dateValue),
      ]);
    };
    snapshotDateStr = initPersistedDateInput(snapshotDateInput, "dashboard_snapshot", {
      fallback: yesterdayStr,
      onChange: onSnapshotDate,
    });
    if (typeof mountDateStepper === "function") {
      mountDateStepper(snapshotDateInput, {
        max: () => (typeof getLocalDateString === "function" ? getLocalDateString() : ""),
      });
    }
    updateHeroDate();
    updateSalesDailyLink();
    const rememberSnapshotDateForDsr = () => {
      try {
        sessionStorage.setItem("petrolpump_sales_daily_from_dashboard", snapshotDateInput.value || yesterdayStr);
      } catch (_) {}
    };
    for (const id of ["sales-daily-link", "sales-daily-ms-link", "sales-daily-hsd-link"]) {
      document.getElementById(id)?.addEventListener("click", rememberSnapshotDateForDsr);
    }
  }

  const snapshotCard = document.getElementById("snapshot-card");

  if (typeof window.showProgress === "function") window.showProgress();
  try {
    setupDsrFilter();
    if (role === "admin") setupPlFilter();

    await Promise.all([
      loadTodaySales(snapshotDateStr),
      loadCreditSummary(snapshotDateStr),
      loadHeroStock(snapshotDateStr),
    ]);
    if (snapshotCard) snapshotCard.classList.remove("loading");

    // Initialize credit mask toggle (button is outside the card link)
    const creditUnhideBtn = document.getElementById("credit-unhide-btn");
    if (creditUnhideBtn) {
      syncCreditMaskButton(isCreditMasked());
      creditUnhideBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCreditMask();
      });
    }

    const initialSection = (location.hash || "").replace(/^#/, "") || "snapshot";
    if (initialSection === "dsr") {
      await ensureDsrSectionLoaded();
    } else if (initialSection === "pl" && role === "admin") {
      await ensurePlSectionLoaded();
    }

    scheduleAutoFitStats();
  } catch (error) {
    AppError.handle(error, { context: { source: "dashboardInit" } });
    if (snapshotCard) snapshotCard.classList.remove("loading");
  } finally {
    if (typeof window.hideProgress === "function") window.hideProgress();
  }
});


function syncCreditSmartAlert() {
  window.AppNotifications?.syncCreditTotal?.(lastCreditTotalRupees);
}


async function updateSmartAlerts(options) {
  await window.AppNotifications?.refreshSmartAlerts?.(options);
}


const REMINDERS_POPUP_SESSION_KEY = "bpf_reminders_landing_dismissed";
const TASKS_PREVIEW_COUNT = 3;

let dueRemindersCache = [];
let remindersLandingBound = false;
let remindersLandingEscapeHandler = null;

function wasRemindersLandingDismissed() {
  try {
    return sessionStorage.getItem(REMINDERS_POPUP_SESSION_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function markRemindersLandingDismissed() {
  try {
    sessionStorage.setItem(REMINDERS_POPUP_SESSION_KEY, "1");
  } catch (_) {
    /* ignore */
  }
}

function taskOutstandingLabel(row) {
  if (!TaskUtils.isCreditTask(row)) return "";
  const amountDue = TaskUtils.amountDueOf(row);
  if (amountDue == null || amountDue <= 0) return "";
  return `Outstanding ${formatCurrency(amountDue)}`;
}

function buildDashboardLaterPanel(id, { credit = false } = {}) {
  if (typeof TaskUtils?.laterPanelHtml === "function") {
    return TaskUtils.laterPanelHtml(id, {
      credit,
      escapeHtml,
      today: getLocalDateString(),
    });
  }
  return "";
}

function taskContactHtml(row) {
  if (!TaskUtils.isCreditTask(row) || typeof TaskUtils.contactRowHtml !== "function") return "";
  const embedded = Array.isArray(row.credit_customers) ? row.credit_customers[0] : row.credit_customers;
  const mobile = embedded?.mobile || "";
  const customerName = TaskUtils.customerNameOf(row);
  const waText = TaskUtils.waMessageForCustomer(customerName, TaskUtils.amountDueOf(row));
  return TaskUtils.contactRowHtml(mobile, waText);
}


function buildLandingTaskHtml(row, todayStr) {
  const undated = !row.due_date;
  const overdue = !undated && row.due_date < todayStr;
  const isHigh = row.priority === "high";
  const isCredit = TaskUtils.isCreditTask(row);
  const customerName = TaskUtils.customerNameOf(row);
  const when = undated
    ? "No date"
    : overdue
      ? `Overdue · ${formatDisplayDate(row.due_date)}`
      : "Due today";
  const outstanding = taskOutstandingLabel(row);
  const href = TaskUtils.customerHref(customerName);
  const itemClass = [
    "reminders-landing-item",
    overdue || isHigh || undated ? "is-overdue" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const amountHtml = outstanding
    ? `<p class="reminders-landing-item-amount">${escapeHtml(outstanding)}</p>`
    : "";
  const accountLink = customerName
    ? `<a class="task-dash-account" href="${escapeHtml(href)}">Account</a>`
    : "";

  return `<article class="${itemClass}" data-reminder-id="${escapeHtml(row.id)}">
    <div class="reminders-landing-item-main">
      <h3 class="reminders-landing-item-title">${escapeHtml(row.title)}</h3>
      ${amountHtml}
      <p class="reminders-landing-item-meta"><span>${escapeHtml(when)}</span>${
        customerName ? `<span>${escapeHtml(customerName)}</span>` : ""
      }${accountLink}</p>
      ${taskContactHtml(row)}
    </div>
    <div class="reminders-landing-item-actions task-action-bar">
      <button type="button" class="button-secondary button-small reminder-done-btn" data-reminder-id="${escapeHtml(row.id)}">Done</button>
      <button type="button" class="button-secondary button-small reminder-later-btn" data-reminder-later="reschedule" data-reminder-id="${escapeHtml(row.id)}" data-days="3" title="Follow up in 3 days">+3 days</button>
      <button type="button" class="button-secondary button-small reminder-later-toggle" data-reminder-id="${escapeHtml(row.id)}" aria-expanded="false">More…</button>
    </div>
    ${buildDashboardLaterPanel(row.id, { credit: isCredit })}
  </article>`;
}

function renderTaskGroupHtml(rows, todayStr, builder) {
  if (!rows.length) return "";
  const preview = rows.slice(0, TASKS_PREVIEW_COUNT);
  const more = rows.slice(TASKS_PREVIEW_COUNT);
  return TaskUtils.wrapMoreCollapse(
    preview.map((r) => builder(r, todayStr)).join(""),
    more.map((r) => builder(r, todayStr)).join(""),
    more.length,
    { escapeHtml }
  );
}

async function loadRemindersBanners() {
  await window.AppNotifications?.refreshReminders?.();
}



function renderSnapshotRemindersStrip(rows, todayStr = getLocalDateString()) {
  const strip = document.getElementById("snapshot-reminders-strip");
  const messageEl = document.getElementById("snapshot-reminders-strip-message");
  if (!strip) return;

  if (!rows.length) {
    strip.classList.add("hidden");
    strip.hidden = true;
    strip.classList.remove("is-urgent");
    return;
  }

  const { credit, todo } = TaskUtils.splitCreditTodo(rows);
  const parts = [];
  if (credit.length) parts.push(`${credit.length} credit call${credit.length === 1 ? "" : "s"}`);
  if (todo.length) parts.push(`${todo.length} todo${todo.length === 1 ? "" : "s"}`);
  if (messageEl) {
    const first = rows[0]?.title || "";
    messageEl.textContent =
      rows.length === 1 && first
        ? `${parts.join(" · ")} · ${first}`
        : `${parts.join(" · ")}${first ? ` · ${first}` : ""}${rows.length > 1 ? ` · +${rows.length - 1} more` : ""}`;
  }

  const urgent = rows.some((r) => (r.due_date && r.due_date < todayStr) || r.priority === "high");
  strip.classList.toggle("is-urgent", urgent);
  strip.classList.remove("hidden");
  strip.hidden = false;

  const reviewBtn = document.getElementById("snapshot-reminders-review-btn");
  if (reviewBtn && !reviewBtn.dataset.bound) {
    reviewBtn.dataset.bound = "1";
    reviewBtn.addEventListener("click", () => {
      openRemindersLanding(dueRemindersCache, getLocalDateString(), { force: true });
    });
  }
}

function maybeShowRemindersLanding(rows, todayStr) {
  const overlay = document.getElementById("reminders-landing-overlay");
  const landingOpen = Boolean(overlay && !overlay.hidden);

  if (!rows.length) {
    closeRemindersLanding({ dismissSession: false });
    return;
  }

  // Always refresh an open popup (e.g. reopened via Review after session dismiss).
  if (landingOpen) {
    openRemindersLanding(rows, todayStr, { force: true });
    return;
  }

  if (wasRemindersLandingDismissed()) return;
  openRemindersLanding(rows, todayStr, { force: false });
}

function openRemindersLanding(rows, todayStr = getLocalDateString(), { force = false } = {}) {
  const overlay = document.getElementById("reminders-landing-overlay");
  const card = overlay?.querySelector(".reminders-landing-card");
  if (!overlay || !rows?.length) return;

  const wasOpen = !overlay.hidden;
  renderRemindersLandingList(rows, todayStr);
  bindRemindersLandingOnce();

  const hasOverdue = rows.some((r) => r.due_date && r.due_date < todayStr);
  card?.classList.toggle("is-urgent", hasOverdue || rows.some((r) => r.priority === "high"));

  const titleEl = document.getElementById("reminders-landing-title");
  if (titleEl) titleEl.textContent = hasOverdue ? "Tasks need attention" : "Today’s tasks";

  if (!force && wasRemindersLandingDismissed()) return;

  // Don't steal focus when refreshing an already-open popup after Done/defer.
  AppDialog.show(overlay, {
    onDismiss: () => closeRemindersLanding({ dismissSession: true }),
    focus: wasOpen ? false : "#reminders-landing-dismiss",
  });
}

function closeRemindersLanding({ dismissSession = true } = {}) {
  const overlay = document.getElementById("reminders-landing-overlay");
  if (!overlay || overlay.hidden) return;
  AppDialog.hide(overlay);
  if (dismissSession) markRemindersLandingDismissed();
  if (remindersLandingEscapeHandler) {
    document.removeEventListener("keydown", remindersLandingEscapeHandler);
    remindersLandingEscapeHandler = null;
  }
}

function renderRemindersLandingList(rows, todayStr = getLocalDateString()) {
  const list = document.getElementById("reminders-landing-list");
  if (!list) return;

  const { credit, todo } = TaskUtils.splitCreditTodo(rows);
  const parts = [];
  if (credit.length) {
    parts.push(
      `<div class="tasks-dash-group"><h4 class="tasks-dash-group-title">Credit collection</h4>${renderTaskGroupHtml(credit, todayStr, buildLandingTaskHtml)}</div>`
    );
  }
  if (todo.length) {
    parts.push(
      `<div class="tasks-dash-group"><h4 class="tasks-dash-group-title">Todo</h4>${renderTaskGroupHtml(todo, todayStr, buildLandingTaskHtml)}</div>`
    );
  }
  list.innerHTML = parts.join("");
  bindReminderDoneButtons(list);
}

function bindRemindersLandingOnce() {
  if (remindersLandingBound) {
    if (!remindersLandingEscapeHandler) {
      remindersLandingEscapeHandler = (e) => {
        if (e.key === "Escape") closeRemindersLanding({ dismissSession: true });
      };
      document.addEventListener("keydown", remindersLandingEscapeHandler);
    }
    return;
  }
  remindersLandingBound = true;

  const close = () => closeRemindersLanding({ dismissSession: true });
  document.getElementById("reminders-landing-close")?.addEventListener("click", close);
  document.getElementById("reminders-landing-dismiss")?.addEventListener("click", close);
  document.querySelector("[data-reminders-landing-close]")?.addEventListener("click", close);

  remindersLandingEscapeHandler = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", remindersLandingEscapeHandler);
}

function taskAddDays(yyyyMmDd, days) {
  if (typeof addDaysToDateString === "function") return addDaysToDateString(yyyyMmDd, days);
  if (typeof TaskUtils?.addDaysYmd === "function") return TaskUtils.addDaysYmd(yyyyMmDd, days);
  const [y, m, d] = String(yyyyMmDd || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(yyyyMmDd || "").slice(0, 10);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + (Number(days) || 0));
  return typeof toLocalDateString === "function" ? toLocalDateString(dt) : dt.toISOString().slice(0, 10);
}

function setLaterControlsDisabled(panel, disabled) {
  panel?.querySelectorAll("button, input").forEach((el) => {
    el.disabled = disabled;
  });
}

function removeDashboardTaskCard(id) {
  if (!id) return;
  document.querySelectorAll(`article[data-reminder-id="${CSS.escape(id)}"]`).forEach((el) => {
    const group = el.closest(".tasks-dash-group");
    el.remove();
    if (group && !group.querySelector("article[data-reminder-id]")) group.remove();
  });
  dueRemindersCache = (dueRemindersCache || []).filter((row) => row.id !== id);
  if (!dueRemindersCache.length) {
    renderSnapshotRemindersStrip([]);
    closeRemindersLanding({ dismissSession: false });
    return;
  }
  renderSnapshotRemindersStrip(dueRemindersCache, getLocalDateString());
}


function bindReminderDoneButtons(container) {
  if (!container || container.dataset.reminderDoneBound) return;
  container.dataset.reminderDoneBound = "1";
  const inFlight = new Set();

  function taskCardEl(fromEl) {
    // Prefer article — action buttons also carry data-reminder-id, so a bare
    // [data-reminder-id] closest() would stop on the button and miss the panel.
    return fromEl?.closest?.("article[data-reminder-id]") || null;
  }

  function laterPanelFor(card, id) {
    if (!card || !id) return null;
    return card.querySelector(`[data-later-for="${CSS.escape(id)}"]`);
  }

  container.addEventListener("click", async (e) => {
    const laterToggle = e.target.closest?.(".reminder-later-toggle");
    if (laterToggle) {
      e.preventDefault();
      const id = laterToggle.getAttribute("data-reminder-id");
      if (!id) return;
      const card = taskCardEl(laterToggle);
      const panel = laterPanelFor(card, id);
      if (!panel) return;
      const willOpen = panel.hidden;
      container.querySelectorAll(".task-later-panel").forEach((p) => {
        p.hidden = true;
        const err = p.querySelector("[data-later-error]");
        if (err) {
          err.hidden = true;
          err.textContent = "";
        }
      });
      container.querySelectorAll(".reminder-later-toggle").forEach((b) => {
        b.setAttribute("aria-expanded", "false");
      });
      if (!willOpen) return;
      panel.hidden = false;
      panel.removeAttribute("hidden");
      laterToggle.setAttribute("aria-expanded", "true");
      const today = getLocalDateString();
      const dateInput = panel.querySelector("[data-later-date]");
      if (dateInput) {
        dateInput.min = today;
        if (!dateInput.value || dateInput.value < today) {
          dateInput.value = taskAddDays(today, 3);
        }
      }
      panel.querySelector(".task-later-choice")?.focus?.();
      panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }

    const laterBtn = e.target.closest?.(".reminder-later-btn");
    if (laterBtn) {
      e.preventDefault();
      const id = laterBtn.getAttribute("data-reminder-id");
      const action = laterBtn.getAttribute("data-reminder-later");
      if (!id || !action) return;
      if (inFlight.has(id)) return;

      const card = taskCardEl(laterBtn);
      const panel = laterPanelFor(card, id);
      const errEl = panel?.querySelector?.("[data-later-error]");

      if (action === "cancel") {
        if (panel) panel.hidden = true;
        if (errEl) {
          errEl.hidden = true;
          errEl.textContent = "";
        }
        card
          ?.querySelector?.(`.reminder-later-toggle[data-reminder-id="${CSS.escape(id)}"]`)
          ?.setAttribute("aria-expanded", "false");
        return;
      }

      let dueDate = "";
      const note = laterBtn.getAttribute("data-note") || "";
      if (action === "reschedule") {
        const days = Number(laterBtn.getAttribute("data-days"));
        if (!Number.isFinite(days) || days < 1) return;
        dueDate = taskAddDays(getLocalDateString(), days);
      } else if (action === "reschedule-pick") {
        dueDate = panel?.querySelector?.("[data-later-date]")?.value || "";
        if (!dueDate) {
          if (errEl) {
            errEl.textContent = "Pick a follow-up date.";
            errEl.hidden = false;
          }
          return;
        }
      } else {
        return;
      }

      const today = getLocalDateString();
      if (dueDate < today) {
        if (errEl) {
          errEl.textContent = "Follow-up date cannot be in the past.";
          errEl.hidden = false;
        }
        return;
      }

      inFlight.add(id);
      laterBtn.disabled = true;
      setLaterControlsDisabled(panel, true);
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = "";
      }

      const { error } =
        typeof TaskUtils?.rescheduleOpenTask === "function"
          ? await TaskUtils.rescheduleOpenTask(window.supabaseClient, {
              id,
              dueDate,
              note,
              dateLabel: formatDisplayDate(today),
            })
          : { error: new Error("Reschedule helper unavailable") };

      if (error) {
        inFlight.delete(id);
        laterBtn.disabled = false;
        setLaterControlsDisabled(panel, false);
        AppError.handle(error, { context: { source: "dashboardReschedule" } });
        return;
      }

      if (typeof TaskUtils?.showTaskToast === "function") {
        TaskUtils.showTaskToast(`Follow-up set for ${formatDisplayDate(dueDate)}`);
      }
      // Dashboard only lists due today / overdue — same-day picks stay visible.
      if (dueDate > today) removeDashboardTaskCard(id);
      else if (panel) {
        panel.hidden = true;
        card
          ?.querySelector?.(`.reminder-later-toggle[data-reminder-id="${CSS.escape(id)}"]`)
          ?.setAttribute("aria-expanded", "false");
      }
      TaskUtils.notifyTasksUpdated();
      await loadRemindersBanners();
      inFlight.delete(id);
      return;
    }

    const btn = e.target.closest?.(".reminder-done-btn");
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute("data-reminder-id");
    if (!id) return;
    if (inFlight.has(id)) return;
    inFlight.add(id);
    btn.disabled = true;
    const { data: deleted, error } = await window.supabaseClient
      .from("reminders")
      .delete()
      .eq("id", id)
      .eq("status", "open")
      .select("id");
    if (error || !deleted?.length) {
      inFlight.delete(id);
      btn.disabled = false;
      AppError.handle(error || new Error("Could not remove this reminder."), {
        context: { source: "dashboardCompleteReminder" },
      });
      return;
    }
    if (typeof TaskUtils?.showTaskToast === "function") TaskUtils.showTaskToast("Reminder removed");
    removeDashboardTaskCard(id);
    TaskUtils.notifyTasksUpdated();
    await loadRemindersBanners();
    inFlight.delete(id);
  });

  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = e.target.closest?.("[data-later-date]");
    if (!input || !container.contains(input)) return;
    e.preventDefault();
    input
      .closest(".task-later-pick")
      ?.querySelector('.reminder-later-btn[data-reminder-later="reschedule-pick"]')
      ?.click();
  });
}

async function loadDayClosingBanners(prefetched) {
  await window.AppNotifications?.refreshDayClosing?.(prefetched);
}


let dsrFilterApi = null;
let plFilterApi = null;
let dsrSectionLoaded = false;
let plSectionLoaded = false;
const dsrSummaryGuard = createRequestGuard();
const plSummaryGuard = createRequestGuard();
const todaySalesGuard = createRequestGuard();
const creditSummaryGuard = createRequestGuard();

function setupDsrFilter() {
  if (dsrFilterApi || !document.getElementById("dsr-range")) return dsrFilterApi;
  dsrFilterApi = createDateRangeFilter({
    storageKey: "dashboard_dsr",
    ranges: ["today", "yesterday", "this-week", "this-month", "custom"],
    defaultRange: "yesterday",
    rangeSelect: "dsr-range",
    startInput: "dsr-start",
    endInput: "dsr-end",
    customRange: "dsr-custom-range",
    form: "dsr-filter-form",
    labelEl: "dsr-date-label",
    trigger: "manual",
    runOnInit: false,
    onApply: (range) => loadDsrSummary(range),
  });
  return dsrFilterApi;
}

async function ensureDsrSectionLoaded() {
  setupDsrFilter();
  if (!dsrFilterApi) return;
  if (!dsrSectionLoaded) {
    dsrSectionLoaded = true;
    await dsrFilterApi.refresh();
  }
}

function setupPlFilter() {
  if (plFilterApi || !document.getElementById("pl-range")) return plFilterApi;
  plFilterApi = createDateRangeFilter({
    storageKey: "dashboard_pl",
    ranges: ["today", "this-week", "this-month", "custom"],
    defaultRange: "today",
    rangeSelect: "pl-range",
    startInput: "pl-start",
    endInput: "pl-end",
    customRange: "pl-custom-range",
    form: "pl-filter-form",
    labelEl: "pl-date-label",
    trigger: "manual",
    runOnInit: false,
    onApply: (range) => loadProfitLossSummary(range),
  });
  return plFilterApi;
}

async function ensurePlSectionLoaded() {
  setupPlFilter();
  if (!plFilterApi) return;
  if (!plSectionLoaded) {
    plSectionLoaded = true;
    await plFilterApi.refresh();
  }
}

async function fetchProfitLossData(range, onUpdate = null) {
  await loadPumpSettings();
  const receiptStart = PumpSettings.getReceiptHistoryStart();
  const cacheKey = `pl_${range.start}_${range.end}_${receiptStart}`;

  const loadFresh = async () => {
    try {
      const { data, error } = await AppError.withRetry(
        () =>
          window.supabaseClient.functions.invoke("get-pl-data", {
            body: {
              startDate: range.start,
              endDate: range.end,
              receiptHistoryStart: receiptStart,
            },
          }),
        { maxAttempts: 3 }
      );

      if (error) throw error;

      return {
        dsrRows: data?.dsrRows ?? [],
        receiptRows: data?.receiptRows ?? [],
        expenseRows: data?.expenseRows ?? [],
        lubeSales: Number(data?.lubeSales ?? 0),
        lubeCogs: Number(data?.lubeCogs ?? 0),
        categoryMap: buildExpenseCategoryMap(data?.expenseCategories),
        dsrError: data?.errors?.dsr ? new Error(data.errors.dsr) : null,
        expenseError: data?.errors?.expense ? new Error(data.errors.expense) : null,
        lubeError: data?.errors?.lube ? new Error(data.errors.lube) : null,
      };
    } catch {
      const [dsrResult, expenseResult, lubeResult, vaultResult, categoryResult] = await Promise.all([
        DsrQueries.fetchDsrRows(range.start, range.end, {
          select:
            "id, date, product, total_sales, testing, petrol_rate, diesel_rate, receipts, buying_price_per_litre, supplier_invoice_no, supplier_gstin, invoice_document_id, purchase_delivery_per_kl, purchase_lfr_per_kl",
        }),
        DsrQueries.fetchExpenses(range.start, range.end),
        DsrQueries.fetchLubeSales(range.start, range.end),
        fetchAllRows(() =>
          supabaseClient
            .from("invoice_documents")
            .select("id, amount")
            .eq("category", "purchase")
            .gte("invoice_date", range.start)
            .lte("invoice_date", range.end)
            .gt("amount", 0)
            .order("invoice_date", { ascending: true })
            .order("id", { ascending: true })
        ),
        window.supabaseClient.from("expense_categories").select("name, label").limit(LOOKUP_ROW_LIMIT),
      ]);

      const lubeCogs = (vaultResult.data ?? []).reduce(
        (s, row) => s + Number(row.amount ?? 0),
        0
      );

      return {
        dsrRows: dsrResult.data ?? [],
        receiptRows: dsrResult.receiptRows ?? [],
        expenseRows: expenseResult.data ?? [],
        lubeSales: lubeResult.total ?? 0,
        lubeCogs,
        categoryMap: buildExpenseCategoryMap(categoryResult.data),
        dsrError: dsrResult.error,
        expenseError: expenseResult.error,
        lubeError: lubeResult.error || vaultResult.error,
      };
    }
  };

  if (typeof AppCache !== "undefined" && AppCache?.getWithSWR) {
    return AppCache.getWithSWR(cacheKey, loadFresh, "profit_loss", onUpdate);
  }
  return loadFresh();
}

async function loadTodaySales(dateStr) {
  const loadId = todaySalesGuard.next();
  const todayStat = document.getElementById("today-total");
  const todayRupees = document.getElementById("today-total-rupees");
  const todayDate = document.getElementById("today-date");

  const selectedDate = dateStr || getLocalDateString();
  const cacheKey = getTodaySalesCacheKey(selectedDate);

  // Use stale-while-revalidate pattern for cached data
  const fetchFn = async () => {
    const { data, error } = await window.supabaseClient
      .from("dsr")
      .select("product, total_sales, testing, petrol_rate, diesel_rate")
      .eq("date", selectedDate)
      .limit(10);

    if (error) {
      AppError.report(error, { context: "loadTodaySales", date: selectedDate });
      return null;
    }

    const dsrRows = data ?? [];
    const missingProductSales = ["petrol", "diesel"].some((product) => {
      const row = dsrRows.find((r) => normalizeProduct(r.product) === product);
      return !(Number(row?.total_sales ?? 0) > 0);
    });
    if (!missingProductSales) return dsrRows;

    // Missing sheet sales for a product — fill from shift register rollup
    // (clean model no longer inserts dsr_* stubs from shifts).
    const { data: shiftAgg, error: shiftErr } = await window.supabaseClient.rpc(
      "get_shift_aggregated_daily_meters",
      { p_date: selectedDate }
    );
    if (shiftErr) {
      AppError.report(shiftErr, { context: "loadTodaySales.shiftAgg", date: selectedDate });
      return dsrRows;
    }
    return mergeDsrRowsWithShiftSales(dsrRows, shiftAgg, selectedDate);
  };

  const renderSalesBlock = async (rows) => {
    const rates = await resolveRatesForDate(selectedDate, rows ?? []);
    renderTodaySales(rows, selectedDate, todayStat, todayRupees, todayDate, rates);
  };

  const onUpdate = (freshData) => {
    if (!todaySalesGuard.isCurrent(loadId)) return;
    void renderSalesBlock(freshData);
  };

  let data;
  if (AppCache) {
    data = await AppCache.getWithSWR(cacheKey, fetchFn, "today_sales", onUpdate);
    if (!todaySalesGuard.isCurrent(loadId)) return;
    if (data !== undefined) {
      await renderSalesBlock(data);
    }
  } else {
    data = await fetchFn();
    if (!todaySalesGuard.isCurrent(loadId)) return;
    await renderSalesBlock(data);
  }
}

/**
 * Render today's sales data to UI
 */
function renderTodaySales(data, selectedDate, todayStat, todayRupees, todayDate, rates = {}) {
  if (!data) {
    snapshotDsrRows = [];
    if (todayStat) todayStat.textContent = "—";
    if (todayDate) todayDate.textContent = formatSnapshotDatePill(selectedDate);
    if (todayRupees) todayRupees.textContent = "—";
    updateFuelRateDisplay(rates.petrolRate ?? null, rates.dieselRate ?? null, {
      petrolFallback: rates.petrolFallback,
      dieselFallback: rates.dieselFallback,
      petrolRateDate: rates.petrolRateDate,
      dieselRateDate: rates.dieselRateDate,
    });
    updateFuelVolumeSplit(null, null);
    scheduleAutoFitStats();
    return;
  }

  snapshotDsrRows = applyResolvedRatesToSalesRows(data, rates);
  const fromShifts = snapshotDsrRows.some((row) => row._fromShiftAggregate);

  // Total quantity = net + testing (i.e. total_sales) for Daily Snapshot
  const petrolTotalQty = sumByProduct(
    snapshotDsrRows,
    "petrol",
    (row) => Number(row.total_sales ?? 0)
  );
  const dieselTotalQty = sumByProduct(
    snapshotDsrRows,
    "diesel",
    (row) => Number(row.total_sales ?? 0)
  );
  const totalLiters = petrolTotalQty + dieselTotalQty;

  updateFuelRateDisplay(rates.petrolRate ?? null, rates.dieselRate ?? null, {
    petrolFallback: rates.petrolFallback,
    dieselFallback: rates.dieselFallback,
    petrolRateDate: rates.petrolRateDate,
    dieselRateDate: rates.dieselRateDate,
  });
  updateFuelVolumeSplit(petrolTotalQty, dieselTotalQty);

  if (todayStat) {
    todayStat.textContent = formatQuantity(totalLiters);
  }
  updateTotalSaleRupees();
  if (todayDate) {
    todayDate.textContent = formatSnapshotDatePill(selectedDate, { fromShifts });
  }
  scheduleAutoFitStats();
}

function formatSnapshotDatePill(dateStr, { fromShifts = false } = {}) {
  const labelDate = new Date(`${dateStr}T00:00:00`);
  const short = labelDate.toLocaleDateString("en-IN", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const base = dateStr === getLocalDateString() ? `Today · ${short}` : short;
  return fromShifts ? `${base} · shifts` : base;
}

function updateTotalSaleRupees() {
  const todayRupees = document.getElementById("today-total-rupees");
  if (!todayRupees) return;

  const totalAmount = calculateDsrSaleRupees(snapshotDsrRows, { includeTesting: true });

  if (totalAmount === 0) {
    todayRupees.textContent = "—";
  } else {
    todayRupees.textContent = formatCurrency(totalAmount);
  }
  scheduleAutoFitStats();
}

async function loadCreditSummary(dateStr) {
  const loadId = creditSummaryGuard.next();
  const creditTotal = document.getElementById("credit-total");
  const selectedDate = dateStr || getLocalDateString();
  const cacheKey = getCreditSummaryCacheKey(selectedDate);

  const fetchFn = async () => {
    const { data, error } = await window.supabaseClient.rpc("get_open_credit_as_of", {
      p_date: selectedDate,
    });

    if (error) {
      AppError.report(error, { context: "loadCreditSummary", date: selectedDate });
      return null;
    }
    return data;
  };

  let total;
  if (typeof AppCache !== "undefined" && AppCache) {
    total = await AppCache.getWithSWR(cacheKey, fetchFn, "credit_summary", (fresh) => {
      if (!creditSummaryGuard.isCurrent(loadId)) return;
      renderCreditSummary(fresh, creditTotal);
    });
  } else {
    total = await fetchFn();
  }
  if (!creditSummaryGuard.isCurrent(loadId)) return;
  renderCreditSummary(total, creditTotal);
}

const CREDIT_MASK_STORAGE_KEY = "petrolpump_credit_masked";

/**
 * Credit total is hidden by default (first visit / no preference).
 * Only "false" in localStorage means the user chose to show it.
 */
function isCreditMasked() {
  try {
    return localStorage.getItem(CREDIT_MASK_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setCreditMasked(masked) {
  try {
    localStorage.setItem(CREDIT_MASK_STORAGE_KEY, masked ? "true" : "false");
  } catch {}
}

function renderMaskedCredit(creditTotal) {
  if (!creditTotal) return;
  creditTotal.textContent = "₹ ******";
  creditTotal.dataset.masked = "true";
}

function renderUnmaskedCredit(creditTotal, value) {
  if (!creditTotal) return;
  creditTotal.textContent = formatCurrency(value);
  creditTotal.dataset.masked = "false";
}

function syncCreditMaskButton(masked) {
  const btn = document.getElementById("credit-unhide-btn");
  const wrapper = document.querySelector(".credit-total-wrapper");
  if (wrapper) wrapper.classList.toggle("masked", masked);
  if (!btn) return;
  btn.setAttribute("aria-pressed", masked ? "false" : "true");
  btn.setAttribute("aria-label", masked ? "Show credit total" : "Hide credit total");
  btn.textContent = masked ? "Show" : "Hide";
}

/**
 * Update credit total UI with mask support
 */
function updateCreditTotalUI(total, creditTotal) {
  if (total === null || total === undefined) {
    lastCreditTotalRupees = null;
    if (creditTotal) creditTotal.textContent = "—";
    syncCreditSmartAlert();
    return;
  }

  const value = Number(total);
  lastCreditTotalRupees = value;
  const isMasked = isCreditMasked();
  syncCreditMaskButton(isMasked);

  if (isMasked) {
    renderMaskedCredit(creditTotal);
  } else {
    renderUnmaskedCredit(creditTotal, value);
  }

  syncCreditSmartAlert();
}

/**
 * Render credit summary to UI (total is numeric from get_open_credit_as_of)
 */
function renderCreditSummary(total, creditTotal) {
  updateCreditTotalUI(total, creditTotal);
}

/**
 * Toggle credit mask — stays on dashboard; does not follow the card link.
 */
function toggleCreditMask() {
  const newMasked = !isCreditMasked();
  setCreditMasked(newMasked);
  syncCreditMaskButton(newMasked);

  const creditTotal = document.getElementById("credit-total");
  if (newMasked) {
    renderMaskedCredit(creditTotal);
  } else if (Number.isFinite(lastCreditTotalRupees)) {
    renderUnmaskedCredit(creditTotal, lastCreditTotalRupees);
  }
}

/**
 * Fetches dashboard data using Edge Function (single round-trip) with fallback
 * to parallel client-side queries if the Edge Function is unavailable.
 * Uses stale-while-revalidate caching pattern.
 */
async function fetchDashboardData(startDate, endDate, onUpdate = null) {
  const cacheKey = getDashboardCacheKey(startDate, endDate);

  const fetchFn = async () => {
    try {
      // Edge Function with retry; we retry only on transient errors (via isTransientError)
      const { data, error } = await AppError.withRetry(
        () =>
          window.supabaseClient.functions.invoke("get-dashboard-data", {
            body: { startDate, endDate },
          }),
        { maxAttempts: 3 }
      );

      if (error) {
        throw error;
      }

      return {
        dsrData: data.dsrData,
        stockData: data.stockData,
        expenseData: data.expenseData,
        creditData: data.creditData ?? [],
        dsrError: data.errors?.dsr ? new Error(data.errors.dsr) : null,
        stockError: data.errors?.stock ? new Error(data.errors.stock) : null,
        expenseError: data.errors?.expense ? new Error(data.errors.expense) : null,
        creditError: data.errors?.credit ? new Error(data.errors.credit) : null,
      };
    } catch {
      // Fallback: use parallel client-side queries
      const [dsrResult, stockResult, expenseResult, creditResult] = await Promise.all([
        fetchAllRows(() =>
          supabaseClient
            .from("dsr")
            .select("date, product, total_sales, testing, stock, petrol_rate, diesel_rate")
            .gte("date", startDate)
            .lte("date", endDate)
            .order("date", { ascending: true })
            .order("product", { ascending: true })
        ),
        window.supabaseClient.rpc("get_dsr_stock_range", { p_start: startDate, p_end: endDate }),
        fetchAllRows(() =>
          supabaseClient
            .from("expenses")
            .select("date, amount, category, description")
            .gte("date", startDate)
            .lte("date", endDate)
            .order("date", { ascending: true })
        ),
        fetchAllRows(() =>
          supabaseClient
            .from("credit_entries")
            .select("amount, amount_settled")
            .gte("transaction_date", startDate)
            .lte("transaction_date", endDate)
            .order("transaction_date", { ascending: true })
            .order("id", { ascending: true })
        ),
      ]);

      return {
        dsrData: dsrResult.data,
        stockData: stockResult.data,
        expenseData: expenseResult.data,
        creditData: creditResult.data ?? [],
        dsrError: dsrResult.error,
        stockError: stockResult.error,
        expenseError: expenseResult.error,
        creditError: creditResult.error,
      };
    }
  };

  // Use stale-while-revalidate pattern
  if (AppCache) {
    return AppCache.getWithSWR(cacheKey, fetchFn, "dashboard_data", onUpdate);
  }

  return fetchFn();
}

async function loadDsrSummary(range) {
  const loadId = dsrSummaryGuard.next();
  const elements = {
    petrolStockEl: document.getElementById("dsr-petrol-stock"),
    dieselStockEl: document.getElementById("dsr-diesel-stock"),
    petrolNetSaleEl: document.getElementById("dsr-petrol-net-sale"),
    dieselNetSaleEl: document.getElementById("dsr-diesel-net-sale"),
    petrolNetSaleRupeesEl: document.getElementById("dsr-petrol-net-sale-rupees"),
    dieselNetSaleRupeesEl: document.getElementById("dsr-diesel-net-sale-rupees"),
    petrolVariationEl: document.getElementById("dsr-petrol-variation"),
    dieselVariationEl: document.getElementById("dsr-diesel-variation"),
    totalNetSaleEl: document.getElementById("dsr-total-net-sale"),
    summaryExpenseEl: document.getElementById("dsr-summary-expense"),
    summaryCreditEl: document.getElementById("dsr-summary-credit"),
    inHandEl: document.getElementById("dsr-in-hand"),
  };

  // Show loading state
  Object.values(elements).forEach((el) => {
    if (el) el.textContent = "Loading…";
  });

  // Callback to update UI when fresh data arrives
  const onUpdate = (freshData) => {
    if (!dsrSummaryGuard.isCurrent(loadId)) return;
    renderDsrSummary(freshData, elements, range);
  };

  // Use Edge Function for single round-trip (with fallback and caching)
  const dashboardData = await fetchDashboardData(range.start, range.end, onUpdate);

  if (!dsrSummaryGuard.isCurrent(loadId)) return;

  if (dashboardData.creditError) {
    const { data: creditRows, error: creditErr } = await fetchAllRows(() =>
      window.supabaseClient
        .from("credit_entries")
        .select("amount, amount_settled")
        .gte("transaction_date", range.start)
        .lte("transaction_date", range.end)
        .order("transaction_date", { ascending: true })
        .order("id", { ascending: true })
    );
    if (!creditErr) {
      dashboardData.creditData = creditRows ?? [];
      dashboardData.creditError = null;
    } else {
      dashboardData.creditError = creditErr;
    }
  }

  renderDsrSummary(dashboardData, elements, range);
  const todayStr = getLocalDateString();
  if (range.start === todayStr && range.end === todayStr) {
    const snapshotDate = document.getElementById("snapshot-date")?.value || todayStr;
    if (range.end === snapshotDate) {
      loadHeroStock(snapshotDate);
    }
    const lastDayStockForAlert = (dashboardData.stockData || []).filter((row) => row.date === range.end);
    const lastDayDsrForAlert = (dashboardData.dsrData || []).filter((row) => row.date === range.end);
    const { petrolStock, dieselStock } = resolveDayFuelStock(
      lastDayStockForAlert,
      lastDayDsrForAlert,
      range.end
    );
    updateLowStockAlert(petrolStock, dieselStock);
    updateSmartAlerts();
    loadDayClosingBanners();
  } else {
    updateLowStockAlert(null, null);
    updateSmartAlerts();
  }
}

/**
 * Render DSR summary data to UI elements.
 * Stock (L) tiles show dip stock for the selected day (single day) or the last day of the selected range.
 */
function renderDsrSummary(data, elements, range) {
  const {
    petrolStockEl, dieselStockEl, petrolNetSaleEl, dieselNetSaleEl,
    petrolNetSaleRupeesEl, dieselNetSaleRupeesEl, petrolVariationEl,
    dieselVariationEl,
    totalNetSaleEl, summaryExpenseEl, summaryCreditEl, inHandEl
  } = elements;

  const { dsrData, stockData, expenseData, creditData, dsrError, stockError, expenseError } = data || {};

  if (dsrError) AppError.report(dsrError, { context: "renderDsrSummary", type: "dsr" });
  if (stockError) AppError.report(stockError, { context: "renderDsrSummary", type: "stock" });
  if (expenseError) AppError.report(expenseError, { context: "renderDsrSummary", type: "expense" });

  const hasDsr = !dsrError;
  const hasStock = !stockError;
  const hasExpense = !expenseError;

  // Stock tiles: dip stock for the selected day (or last day of range only).
  // Prefer dsr_stock.dip_stock; fall back to dsr.stock when dsr_stock has no row for that day.
  const lastDay = range?.end;
  const { petrolStock, dieselStock, hasAnyRow: hasLastDayStock } = lastDay
    ? resolveDayFuelStock(stockData, dsrData, lastDay)
    : { petrolStock: 0, dieselStock: 0, hasAnyRow: false };
  const petrolNetSale = sumByProduct(dsrData, "petrol", getDsrNetSaleLitres);
  const dieselNetSale = sumByProduct(dsrData, "diesel", getDsrNetSaleLitres);
  // Variation tiles: single day = that day's variation; range = sum of all variations in the period.
  // Prefer dsr_stock.variation; when dsr_stock has no rows in range, derive from dsr.stock (stock change over period).
  const stockInRange = range
    ? (stockData ?? []).filter(
        (row) => row.date >= range.start && row.date <= range.end
      )
    : [];
  let petrolVariation = sumByProduct(stockInRange, "petrol", (row) => Number(row.variation ?? 0));
  let dieselVariation = sumByProduct(stockInRange, "diesel", (row) => Number(row.variation ?? 0));
  let hasVariation = range && stockInRange.length > 0;
  const isRange = range && range.start !== range.end;
  if (!hasVariation && isRange && hasDsr && (dsrData ?? []).length > 0) {
    const firstDayDsr = (dsrData ?? []).filter((row) => row.date === range.start);
    const lastDayDsrForVar = (dsrData ?? []).filter((row) => row.date === range.end);
    const petrolFirst = sumByProduct(firstDayDsr, "petrol", (row) => Number(row.stock ?? 0));
    const dieselFirst = sumByProduct(firstDayDsr, "diesel", (row) => Number(row.stock ?? 0));
    const petrolLast = sumByProduct(lastDayDsrForVar, "petrol", (row) => Number(row.stock ?? 0));
    const dieselLast = sumByProduct(lastDayDsrForVar, "diesel", (row) => Number(row.stock ?? 0));
    petrolVariation = petrolLast - petrolFirst;
    dieselVariation = dieselLast - dieselFirst;
    hasVariation = firstDayDsr.length > 0 && lastDayDsrForVar.length > 0;
  }
  const expenseTotal = (expenseData ?? []).reduce((sum, row) => {
    const amount = Number(row.amount ?? 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  // Get rates from DSR data (use the latest non-zero rate)
  const petrolRates = (dsrData ?? [])
    .filter((row) => normalizeProduct(row.product) === "petrol" && row.petrol_rate > 0)
    .map((row) => row.petrol_rate);
  const dieselRates = (dsrData ?? [])
    .filter((row) => normalizeProduct(row.product) === "diesel" && row.diesel_rate > 0)
    .map((row) => row.diesel_rate);
  const dsrPetrolRate = petrolRates.length > 0 ? petrolRates[petrolRates.length - 1] : 0;
  const dsrDieselRate = dieselRates.length > 0 ? dieselRates[dieselRates.length - 1] : 0;

  const canShowStock =
    (hasStock || hasDsr) &&
    lastDay &&
    hasLastDayStock &&
    (Number.isFinite(petrolStock) || Number.isFinite(dieselStock));
  if (petrolStockEl) {
    petrolStockEl.textContent = canShowStock ? formatQuantity(petrolStock) : "—";
  }
  if (dieselStockEl) {
    dieselStockEl.textContent = canShowStock ? formatQuantity(dieselStock) : "—";
  }
  if (petrolNetSaleEl) {
    petrolNetSaleEl.textContent = hasDsr ? formatQuantity(petrolNetSale) : "—";
  }
  if (dieselNetSaleEl) {
    dieselNetSaleEl.textContent = hasDsr ? formatQuantity(dieselNetSale) : "—";
  }
  updateDsrNetSaleRupees(petrolNetSale, dieselNetSale, hasDsr, dsrPetrolRate, dsrDieselRate);
  const canShowVariation = (hasStock || hasDsr) && hasVariation;
  if (petrolVariationEl) {
    petrolVariationEl.textContent = canShowVariation ? formatQuantity(petrolVariation) : "—";
    applyVariationTone(petrolVariationEl, petrolVariation, canShowVariation);
  }
  if (dieselVariationEl) {
    dieselVariationEl.textContent = canShowVariation ? formatQuantity(dieselVariation) : "—";
    applyVariationTone(dieselVariationEl, dieselVariation, canShowVariation);
  }

  // Day summary: total sale (₹, incl. testing), expenses, net cash (single-day only; matches day closing)
  const totalSaleRupees = hasDsr ? calculateDsrSaleRupees(dsrData, { includeTesting: true }) : 0;
  const isSingleDay = range && range.start === range.end;
  const creditGivenInRange = (creditData ?? []).reduce((sum, row) => {
    const amt = Number(row.amount ?? 0);
    return sum + (Number.isFinite(amt) ? amt : 0);
  }, 0);
  const inHand =
    isSingleDay && (hasDsr || hasExpense)
      ? totalSaleRupees - expenseTotal - creditGivenInRange
      : null;

  if (totalNetSaleEl) {
    totalNetSaleEl.textContent = hasDsr ? formatCurrency(totalSaleRupees) : "—";
  }
  if (summaryExpenseEl) {
    summaryExpenseEl.textContent = hasExpense ? formatCurrency(expenseTotal) : "—";
  }
  if (summaryCreditEl) {
    summaryCreditEl.textContent =
      creditData?.length || creditGivenInRange > 0 ? formatCurrency(creditGivenInRange) : formatCurrency(0);
  }
  if (inHandEl) {
    inHandEl.textContent = inHand != null ? formatCurrency(inHand) : "—";
    inHandEl.classList.remove("stat-positive", "stat-negative");
    if (inHand != null) {
      if (inHand > 0) inHandEl.classList.add("stat-positive");
      else if (inHand < 0) inHandEl.classList.add("stat-negative");
    }
  }
  scheduleAutoFitStats();
}

async function refreshMissingBuyingPriceUi() {
  return window.AppNotifications?.refreshBuyingPrice?.();
}


async function loadProfitLossSummary(range) {
  const loadId = plSummaryGuard.next();
  const plValueEl = document.getElementById("pl-value");
  const plLabelEl = document.getElementById("pl-label");
  const plProfitHintEl = document.getElementById("pl-profit-hint");

  if (plValueEl) plValueEl.textContent = "Loading…";
  if (plProfitHintEl) {
    plProfitHintEl.classList.add("hidden");
    plProfitHintEl.textContent = "";
  }

  const plData = await fetchProfitLossData(range, (fresh) => {
    if (!plSummaryGuard.isCurrent(loadId)) return;
    renderProfitLossFromData(fresh, { plValueEl, plLabelEl, plProfitHintEl, range });
  });
  if (!plSummaryGuard.isCurrent(loadId)) return;
  if (plData.dsrError) AppError.report(plData.dsrError, { context: "profitLossSummary", type: "dsr" });
  if (plData.expenseError) AppError.report(plData.expenseError, { context: "profitLossSummary", type: "expense" });
  if (plData.lubeError) AppError.report(plData.lubeError, { context: "profitLossSummary", type: "lube" });

  renderProfitLossFromData(plData, { plValueEl, plLabelEl, plProfitHintEl, range });
}

function renderProfitLossFromData(plData, { plValueEl, plLabelEl, plProfitHintEl }) {
  const hasDsr = !plData.dsrError;
  const hasExpense = !plData.expenseError;
  const pl = computeProfitLossSummary({
    dsrRows: plData.dsrRows,
    receiptRows: plData.receiptRows,
    expenseRows: plData.expenseRows,
    lubeSales: plData.lubeSales,
    lubeCogs: plData.lubeCogs ?? 0,
    categoryMap: plData.categoryMap ?? null,
  });

  if (plValueEl && plLabelEl) {
    plLabelEl.textContent = "Nett Profit";
    if (!hasDsr || !hasExpense) {
      plValueEl.textContent = "—";
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else if (!pl.canCalculate) {
      plValueEl.textContent = "—";
      if (plProfitHintEl) {
        plProfitHintEl.innerHTML =
          'Enter pre-VAT ₹/KL on <a href="meter-reading.html#purchase-cost">Meter Reading → Purchase cost</a>. No prior receipt rate is available yet, so net profit cannot be calculated.';
        plProfitHintEl.classList.remove("hidden");
      }
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else {
      const profitLoss = pl.netProfit;
      plValueEl.textContent = formatCurrency(profitLoss);
      plValueEl.classList.toggle("stat-positive", profitLoss >= 0);
      plValueEl.classList.toggle("stat-negative", profitLoss < 0);
      if (pl.usingProvisionalBuying && plProfitHintEl) {
        plProfitHintEl.innerHTML =
          'Some receipt days still need ₹/KL — net profit uses the previous receipt rate until you save the correct price on <a href="meter-reading.html#purchase-cost">Purchase cost</a>.';
        plProfitHintEl.classList.remove("hidden");
      }
    }
  }

  const plMethodologyEl = document.getElementById("pl-methodology-note");
  if (plMethodologyEl) {
    plMethodologyEl.textContent =
      "Nett Profit = fuel gross + (lube sales − vault purchases) − operating expenses. Trading Account “Gross income c/d” is a different stock-based figure — do not use it as take-home profit.";
  }
  scheduleAutoFitStats();
}

window.addEventListener("resize", () => {
  clearTimeout(statFitResizeTimer);
  statFitResizeTimer = setTimeout(() => scheduleAutoFitStats(), 200);
});

document.addEventListener("app-notifications:reminders", (e) => {
  dueRemindersCache = e.detail?.rows || [];
  const todayStr = e.detail?.todayStr || getLocalDateString();
  renderSnapshotRemindersStrip(dueRemindersCache, todayStr);
  maybeShowRemindersLanding(dueRemindersCache, todayStr);
});

// Listen for credit / reminder updates from other pages/tabs
window.addEventListener("storage", (e) => {
  if (e.key === "credit-updated") {
    const dateInput = document.getElementById("snapshot-date");
    const date = dateInput?.value || getLocalDateString();
    loadCreditSummary(date);
    return;
  }
});

// Refetch dashboard data when user returns or another tab invalidates cache
function refreshDashboardOnVisible() {
  const dateInput = document.getElementById("snapshot-date");
  if (!dateInput) return;
  const date = dateInput.value || getLocalDateString();

  void loadTodaySales(date);
  loadCreditSummary(date);
  void loadHeroStock(date);
  void loadDayClosingBanners();
  void loadRemindersBanners();
  if (dashboardRole === "admin") void refreshMissingBuyingPriceUi();

  if (dsrSectionLoaded && dsrFilterApi) {
    const range = dsrFilterApi.getRange();
    if (range?.start && range?.end) void loadDsrSummary(range);
  }
  if (plSectionLoaded && plFilterApi && dashboardRole === "admin") {
    const range = plFilterApi.getRange();
    if (range?.start && range?.end) void loadProfitLossSummary(range);
  }
}

bindLiveRefresh(refreshDashboardOnVisible, {
  match: () => Boolean(document.getElementById("snapshot-card")),
});

function applyVariationTone(element, value, isActive) {
  element.classList.remove("stat-positive", "stat-negative");
  if (!isActive) return;
  if (value > 0) {
    element.classList.add("stat-positive");
  } else if (value < 0) {
    element.classList.add("stat-negative");
  }
}

// DSR Dashboard specific - uses rates from DSR data only
function updateDsrNetSaleRupees(petrolLiters, dieselLiters, isActive, petrolRate, dieselRate) {
  const petrolNetSaleRupeesEl = document.getElementById(
    "dsr-petrol-net-sale-rupees"
  );
  const dieselNetSaleRupeesEl = document.getElementById(
    "dsr-diesel-net-sale-rupees"
  );
  if (!petrolNetSaleRupeesEl || !dieselNetSaleRupeesEl) return;

  if (!isActive) {
    petrolNetSaleRupeesEl.textContent = "—";
    dieselNetSaleRupeesEl.textContent = "—";
    return;
  }

  if (!petrolRate || petrolRate === 0) {
    petrolNetSaleRupeesEl.textContent = "—";
  } else {
    petrolNetSaleRupeesEl.textContent = formatCurrency(petrolLiters * petrolRate);
  }

  if (!dieselRate || dieselRate === 0) {
    dieselNetSaleRupeesEl.textContent = "—";
  } else {
    dieselNetSaleRupeesEl.textContent = formatCurrency(dieselLiters * dieselRate);
  }
}

