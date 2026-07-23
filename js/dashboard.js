/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getValidFilterState, setFilterState, escapeHtml, PumpSettings, loadPumpSettings, AppConfig, createDateRangeFilter, validateBuyingRateKlInput, buyingRatePerLitreForDb, getPlBuyingPriceFieldLabel, getPlBuyingPricePlaceholder, getPlBuyingPriceHint, normalizeProduct, formatQuantity, formatDisplayDate, formatDateInput, getRangeForSelection, CacheInvalidation, getDsrNetSaleLitres, calculateDsrSaleRupees, computeProfitLossSummary, buildExpenseCategoryMap, sumByProduct, resolveDayFuelStock, initPersistedDateInput, getLocalDateString, getYesterdayDateString, DsrQueries */

/**
 * Generate cache key for dashboard data queries
 */
function getDashboardCacheKey(startDate, endDate) {
  return `dashboard_${startDate}_${endDate}`;
}

/**
 * Generate cache key for today's sales
 */
function getTodaySalesCacheKey(dateStr) {
  return `today_sales_net_${dateStr}`;
}

/**
 * Generate cache key for credit summary
 */
function getCreditSummaryCacheKey(dateStr) {
  return `credit_summary_${dateStr}`;
}

let lastCreditTotalRupees = null;
let lastPetrolVariation = null;
let lastDieselVariation = null;

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

/**
 * Latest non-zero selling rate for a product (same logic as Meter Reading prefill).
 */
async function fetchLastDsrRate(product) {
  const rateField = DSR_RATE_FIELD[product];
  if (!rateField) return null;
  const { data, error } = await supabaseClient
    .from("dsr")
    .select(`date, ${rateField}`)
    .eq("product", product)
    .not(rateField, "is", null)
    .order("date", { ascending: false })
    .limit(30);

  if (error) {
    AppError.report(error, { context: "fetchLastDsrRate", product });
    return null;
  }
  for (const row of data ?? []) {
    const num = Number(row[rateField]);
    if (Number.isFinite(num) && num > 0) {
      return { rate: num, date: row.date ?? null };
    }
  }
  return null;
}

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
    !petrolRate ? fetchLastDsrRate("petrol") : Promise.resolve(null),
    !dieselRate ? fetchLastDsrRate("diesel") : Promise.resolve(null),
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
        Number.isFinite(Number(row.dip_stock))
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
        Number.isFinite(Number(row.stock))
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
      supabaseClient.rpc("get_dsr_stock_range", {
        p_start: historyStart,
        p_end: selectedDate,
      }),
      supabaseClient
        .from("dsr")
        .select("date, product, stock, dip_reading")
        .gte("date", historyStart)
        .lte("date", selectedDate)
        .order("date", { ascending: false }),
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
  const wrap = document.getElementById("low-stock-alert");
  const msg = document.getElementById("low-stock-message");
  if (!wrap || !msg) return;
  const th = getLowStockThresholds();
  const parts = [];
  if (Number.isFinite(petrolStock) && petrolStock < th.petrol) {
    parts.push(`Petrol: ${formatQuantity(petrolStock)} L (below ${formatQuantity(th.petrol)} L)`);
  }
  if (Number.isFinite(dieselStock) && dieselStock < th.diesel) {
    parts.push(`Diesel: ${formatQuantity(dieselStock)} L (below ${formatQuantity(th.diesel)} L)`);
  }
  if (parts.length === 0) {
    wrap.classList.add("hidden");
    updateDashboardAlertsVisibility();
    return;
  }
  msg.textContent = "Low stock alert: " + parts.join(" · ");
  wrap.classList.remove("hidden");
  updateDashboardAlertsVisibility();
}

function updateDashboardAlertsVisibility() {
  const container = document.getElementById("dashboard-alerts");
  if (!container) return;
  const lowStock = document.getElementById("low-stock-alert");
  const smartPanel = document.getElementById("smart-alerts-panel");
  const hasVisible = (lowStock && !lowStock.classList.contains("hidden")) ||
    (smartPanel && !smartPanel.classList.contains("hidden") && smartPanel.children.length > 0);
  container.classList.toggle("dashboard-alerts-empty", !hasVisible);
}

let snapshotDsrRows = [];

let statFitRaf = null;

function fitTextToContainer(el, options = {}) {
  if (!el) return;
  const {
    minFontPx = 12,
    paddingPx = 2,
  } = options;

  const parent = el.parentElement;
  if (!parent) return;

  const maxFontPx =
    Number(el.dataset.maxFontPx) ||
    Number.parseFloat(window.getComputedStyle(el).fontSize) ||
    16;
  if (!el.dataset.maxFontPx) {
    el.dataset.maxFontPx = String(maxFontPx);
  }

  // Measure at max size first.
  el.style.fontSize = `${maxFontPx}px`;
  // Force a reflow to update scrollWidth accurately in some browsers.
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth;

  const available = Math.max(0, parent.getBoundingClientRect().width - paddingPx);
  const needed = el.scrollWidth;
  if (!available || !needed) return;

  if (needed <= available) {
    el.style.fontSize = `${maxFontPx}px`;
    return;
  }

  const ratio = available / needed;
  const next = Math.max(minFontPx, Math.floor(maxFontPx * ratio * 0.98));
  el.style.fontSize = `${next}px`;
}

function autoFitStats(scope = document) {
  const elements = scope.querySelectorAll(
    ".metric-box .stat, .stat-tile .stat"
  );
  elements.forEach((el) => {
    const isSub = el.classList.contains("stat-sub");
    fitTextToContainer(el, { minFontPx: isSub ? 10 : 12 });
  });
}

function scheduleAutoFitStats() {
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
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "dashboard",
  });
  if (!auth) return;

  await loadPumpSettings();

  const { session, role } = auth;
  applyRoleVisibility(role);

  if (typeof initPageSections === "function") {
    const dashboardSections =
      role === "admin"
        ? ["snapshot", "dsr", "pl", "notifications"]
        : ["snapshot", "dsr", "notifications"];
    initPageSections({
      defaultSection: "snapshot",
      validSections: dashboardSections,
      onSectionChange: (section) => {
        if (section === "dsr") void ensureDsrSectionLoaded();
        if (section === "pl" && role === "admin") void ensurePlSectionLoaded();
      },
    });
  }

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

    const initialSection = (location.hash || "").replace(/^#/, "") || "snapshot";
    if (initialSection === "dsr") {
      await ensureDsrSectionLoaded();
    } else if (initialSection === "pl" && role === "admin") {
      await ensurePlSectionLoaded();
    }

    await updateSmartAlerts();
    await loadDayClosingBanners();
    if (role === "admin") void loadPlTodoBanner();
    updateDashboardAlertsVisibility();
    if (window.location.hash === "#pl") {
      setTimeout(scrollToPlBuyingPriceAlert, 300);
    }

    document.getElementById("pl-todo-goto")?.addEventListener("click", () => {
      void ensurePlSectionLoaded().then(() => {
        setTimeout(scrollToPlBuyingPriceAlert, 150);
      });
    });
    scheduleAutoFitStats();
  } catch (error) {
    AppError.handle(error, { context: { source: "dashboardInit" } });
    if (snapshotCard) snapshotCard.classList.remove("loading");
  } finally {
    if (typeof window.hideProgress === "function") window.hideProgress();
  }
});

function getAlertThresholds() {
  const t = PumpSettings.getAlertThresholds();
  return {
    highCredit: t.highCredit > 0 ? t.highCredit : 0,
    highVariation: t.highVariation > 0 ? t.highVariation : 0,
    dayClosingReminder: t.dayClosingReminder,
    dayClosingShortage: t.dayClosingShortage,
    shortageAlert: t.shortageAlert,
  };
}

async function updateSmartAlerts() {
  const panel = document.getElementById("smart-alerts-panel");
  if (!panel) return;
  const alerts = [];
  const th = getAlertThresholds();

  if (th.highCredit > 0 && Number.isFinite(lastCreditTotalRupees) && lastCreditTotalRupees > th.highCredit) {
    alerts.push({
      type: "warning",
      message: `Outstanding credit (${formatCurrency(lastCreditTotalRupees)}) is above your alert threshold (${formatCurrency(th.highCredit)}).`,
      cta: "Credit",
      href: "credit.html",
    });
  }

  if (th.highVariation > 0 && (Number(lastPetrolVariation) > th.highVariation || Number(lastDieselVariation) > th.highVariation)) {
    const parts = [];
    if (Number(lastPetrolVariation) > th.highVariation) parts.push(`Petrol ${formatQuantity(lastPetrolVariation)} L`);
    if (Number(lastDieselVariation) > th.highVariation) parts.push(`Diesel ${formatQuantity(lastDieselVariation)} L`);
    alerts.push({
      type: "warning",
      message: `Stock variation exceeds threshold (${formatQuantity(th.highVariation)} L): ${parts.join(", ")}. Verify meter readings.`,
      cta: "View DSR",
      href: "dsr.html",
    });
  }

  if (th.shortageAlert) {
    const todayStr = formatDateInput(new Date());
    const { data: closingRow, error: closingError } = await supabaseClient
      .from("day_closing")
      .select("short_today")
      .eq("date", todayStr)
      .maybeSingle();

    if (!closingError && closingRow?.short_today != null && PumpSettings.isDayClosingShortage(closingRow.short_today)) {
      const shortAmount = Number(closingRow.short_today);
      const thresholdLabel =
        th.dayClosingShortage > 0
          ? `your alert threshold (${formatCurrency(th.dayClosingShortage)})`
          : "zero";
      alerts.push({
        type: "warning",
        message: `Today's short (${formatCurrency(shortAmount)}) is above ${thresholdLabel}. Review night cash and PhonePe totals.`,
        cta: "Day closing",
        href: `day-closing.html?date=${encodeURIComponent(todayStr)}`,
      });
    }
  }

  if (alerts.length === 0) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    updateDashboardAlertsVisibility();
    return;
  }
  panel.classList.remove("hidden");
  updateDashboardAlertsVisibility();
  panel.innerHTML = alerts
    .map(
      (a) =>
        `<div class="smart-alert smart-alert--${a.type}" role="alert">
          <p class="smart-alert-message">${escapeHtml(a.message)}</p>
          <a href="${escapeHtml(a.href)}" class="button-secondary smart-alert-cta">${escapeHtml(a.cta)}</a>
        </div>`
    )
    .join("");
}

const DAY_CLOSING_LOOKBACK_DAYS = 7;

/**
 * Load day closing status for today and past days; render one banner per day (done or not done).
 * Respects dayClosingReminder setting. No "Day closing" title; separate banner per event.
 */
async function loadDayClosingBanners() {
  const block = document.getElementById("day-closing-block");
  const container = document.getElementById("day-closing-banners");
  if (!block || !container) return;

  const th = getAlertThresholds();
  if (!th.dayClosingReminder) {
    block.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const today = new Date();
  const todayStr = formatDateInput(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - DAY_CLOSING_LOOKBACK_DAYS);
  const startStr = formatDateInput(startDate);

  const { data: closedRows, error } = await supabaseClient
    .from("day_closing")
    .select("date")
    .gte("date", startStr)
    .lte("date", todayStr);

  if (error) {
    AppError.report(error, { context: "loadDayClosingBanners" });
    block.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const closedSet = new Set((closedRows ?? []).map((r) => r.date));

  const datesToShow = [];
  for (let i = 0; i <= DAY_CLOSING_LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    datesToShow.push(formatDateInput(d));
  }

  const parts = [];

  function bannerForDate(dateStr, showDone) {
    const done = closedSet.has(dateStr);
    if (!showDone && done) return null;
    const label = formatDisplayDate(dateStr);
    const isToday = dateStr === todayStr;
    const dayLabel = isToday ? "today" : label;
    if (done) {
      return `<div class="day-closing-banner day-closing-cta done" role="status">
        <span class="cta-text">Day closing done for ${escapeHtml(dayLabel)}</span>
      </div>`;
    }
    const fillUrl = `day-closing.html?date=${encodeURIComponent(dateStr)}`;
    return `<div class="day-closing-banner day-closing-cta" role="alert">
      <span class="cta-text">Day closing not done for ${escapeHtml(dayLabel)}</span>
      <a href="${escapeHtml(fillUrl)}" class="day-closing-cta-btn">Fill day closing</a>
    </div>`;
  }

  parts.push(bannerForDate(datesToShow[0], true));
  datesToShow.slice(1).forEach((dateStr) => {
    const html = bannerForDate(dateStr, false);
    if (html) parts.push(html);
  });

  container.innerHTML = parts.join("");
  block.classList.toggle("hidden", parts.length === 0);
}

let dsrFilterApi = null;
let plFilterApi = null;
let dsrSectionLoaded = false;
let plSectionLoaded = false;

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
  let pendingFromDsr = false;
  try {
    pendingFromDsr = sessionStorage.getItem("pl_todo_pending") === "1";
    if (pendingFromDsr) sessionStorage.removeItem("pl_todo_pending");
  } catch (_) {}
  if (pendingFromDsr) {
    setTimeout(scrollToPlBuyingPriceAlert, 200);
  }
}

async function fetchProfitLossData(range) {
  await loadPumpSettings();
  const receiptStart = PumpSettings.getReceiptHistoryStart();
  const cacheKey = `pl_${range.start}_${range.end}_${receiptStart}`;

  const loadFresh = async () => {
    try {
      const { data, error } = await AppError.withRetry(
        () =>
          supabaseClient.functions.invoke("get-pl-data", {
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
            "id, date, product, total_sales, testing, petrol_rate, diesel_rate, receipts, buying_price_per_litre, supplier_invoice_no, supplier_gstin, invoice_document_id",
        }),
        DsrQueries.fetchExpenses(range.start, range.end),
        DsrQueries.fetchLubeSales(range.start, range.end),
        supabaseClient
          .from("invoice_documents")
          .select("amount")
          .eq("category", "purchase")
          .gte("invoice_date", range.start)
          .lte("invoice_date", range.end)
          .gt("amount", 0),
        supabaseClient.from("expense_categories").select("name, label"),
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
    return AppCache.getWithSWR(cacheKey, loadFresh, "profit_loss");
  }
  return loadFresh();
}

async function loadTodaySales(dateStr) {
  const todayStat = document.getElementById("today-total");
  const todayRupees = document.getElementById("today-total-rupees");
  const todayDate = document.getElementById("today-date");

  const selectedDate = dateStr || getLocalDateString();
  const cacheKey = getTodaySalesCacheKey(selectedDate);

  // Use stale-while-revalidate pattern for cached data
  const fetchFn = async () => {
    const { data, error } = await supabaseClient
      .from("dsr")
      .select("product, total_sales, testing, petrol_rate, diesel_rate")
      .eq("date", selectedDate);

    if (error) {
      AppError.report(error, { context: "loadTodaySales", date: selectedDate });
      return null;
    }
    return data ?? [];
  };

  const renderSalesBlock = async (rows) => {
    const rates = await resolveRatesForDate(selectedDate, rows ?? []);
    renderTodaySales(rows, selectedDate, todayStat, todayRupees, todayDate, rates);
  };

  const onUpdate = (freshData) => {
    void renderSalesBlock(freshData);
  };

  let data;
  if (AppCache) {
    data = await AppCache.getWithSWR(cacheKey, fetchFn, "today_sales", onUpdate);
    if (data !== undefined) {
      await renderSalesBlock(data);
    }
  } else {
    data = await fetchFn();
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

  snapshotDsrRows = data;

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
  if (todayDate) todayDate.textContent = formatSnapshotDatePill(selectedDate);
  scheduleAutoFitStats();
}

function formatSnapshotDatePill(dateStr) {
  const labelDate = new Date(`${dateStr}T00:00:00`);
  const short = labelDate.toLocaleDateString("en-IN", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return dateStr === getLocalDateString() ? `Today · ${short}` : short;
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
  const creditTotal = document.getElementById("credit-total");
  const selectedDate = dateStr || getLocalDateString();
  const cacheKey = getCreditSummaryCacheKey(selectedDate);

  const fetchFn = async () => {
    const { data, error } = await supabaseClient.rpc("get_open_credit_as_of", {
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
      renderCreditSummary(fresh, creditTotal);
    });
  } else {
    total = await fetchFn();
  }
  renderCreditSummary(total, creditTotal);
}

/**
 * Render credit summary to UI (total is numeric from get_open_credit_as_of)
 */
function renderCreditSummary(total, creditTotal) {
  if (total === null || total === undefined) {
    lastCreditTotalRupees = null;
    if (creditTotal) creditTotal.textContent = "—";
    return;
  }

  const value = Number(total);
  lastCreditTotalRupees = value;
  if (creditTotal) creditTotal.textContent = formatCurrency(value);
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
          supabaseClient.functions.invoke("get-dashboard-data", {
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
        supabaseClient
          .from("dsr")
          .select("date, product, total_sales, testing, stock, petrol_rate, diesel_rate")
          .gte("date", startDate)
          .lte("date", endDate),
        supabaseClient.rpc("get_dsr_stock_range", { p_start: startDate, p_end: endDate }),
        supabaseClient
          .from("expenses")
          .select("date, amount, category, description")
          .gte("date", startDate)
          .lte("date", endDate),
        supabaseClient
          .from("credit_entries")
          .select("amount, amount_settled")
          .gte("transaction_date", startDate)
          .lte("transaction_date", endDate),
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
    renderDsrSummary(freshData, elements, range);
  };

  // Use Edge Function for single round-trip (with fallback and caching)
  const dashboardData = await fetchDashboardData(range.start, range.end, onUpdate);

  if (dashboardData.creditError) {
    const { data: creditRows, error: creditErr } = await supabaseClient
      .from("credit_entries")
      .select("amount, amount_settled")
      .gte("transaction_date", range.start)
      .lte("transaction_date", range.end);
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
    lastPetrolVariation = sumByProduct(lastDayStockForAlert, "petrol", (row) => row.variation);
    lastDieselVariation = sumByProduct(lastDayStockForAlert, "diesel", (row) => row.variation);
    updateSmartAlerts();
    loadDayClosingBanners();
  } else {
    lastPetrolVariation = null;
    lastDieselVariation = null;
    const wrap = document.getElementById("low-stock-alert");
    if (wrap) wrap.classList.add("hidden");
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

/**
 * Fetch missing buying-price rows once and update banner (and optionally the P&L list).
 */
async function refreshMissingBuyingPriceUi(options = {}) {
  const { renderList = false } = options;
  const bannerEl = document.getElementById("pl-todo-banner");
  const countEl = document.getElementById("pl-todo-count");

  const { data, error } = await DsrQueries.fetchMissingBuyingPriceRows();
  if (error) {
    AppError.report(error, { context: "refreshMissingBuyingPriceUi" });
    bannerEl?.classList.add("hidden");
    if (renderList) renderPlMissingBuyingList([]);
    return [];
  }

  const rows = data ?? [];
  if (bannerEl && countEl) {
    if (rows.length > 0) {
      countEl.textContent = String(rows.length);
      bannerEl.classList.remove("hidden");
    } else {
      bannerEl.classList.add("hidden");
      try { sessionStorage.removeItem("pl_todo_pending"); } catch (_) {}
    }
  }
  if (renderList) renderPlMissingBuyingList(rows);
  return rows;
}

async function loadPlTodoBanner() {
  await refreshMissingBuyingPriceUi({ renderList: false });
}

/**
 * Get current P&L range from the filter form (for reload after saving buying price).
 */
function getCurrentPlRange() {
  const rangeSelect = document.getElementById("pl-range");
  const startEl = document.getElementById("pl-start");
  const endEl = document.getElementById("pl-end");
  if (!rangeSelect || !startEl || !endEl) return null;
  return getRangeForSelection(rangeSelect.value, startEl, endEl);
}

/**
 * Match a vault purchase PDF by invoice title (and optional receipt date).
 * Exact title first, then case-insensitive partial — avoids scanning unrelated docs.
 * @returns {Promise<string|null>} invoice_documents.id
 */
async function findVaultDocumentIdForInvoice(invoiceNo, receiptDate) {
  const title = String(invoiceNo || "").trim();
  if (!title) return null;

  const exactQuery = (withDate) => {
    let q = supabaseClient
      .from("invoice_documents")
      .select("id")
      .eq("category", "purchase")
      .eq("title", title)
      .order("invoice_date", { ascending: false })
      .limit(1);
    if (withDate && receiptDate) q = q.eq("invoice_date", receiptDate);
    return q;
  };

  let { data, error } = await exactQuery(true);
  if (!error && data?.[0]?.id) return data[0].id;
  if (receiptDate) {
    ({ data, error } = await exactQuery(false));
    if (!error && data?.[0]?.id) return data[0].id;
  }

  const safePattern = `%${title.replace(/[%_\\]/g, "\\$&")}%`;
  let fuzzy = supabaseClient
    .from("invoice_documents")
    .select("id, title")
    .eq("category", "purchase")
    .ilike("title", safePattern)
    .order("invoice_date", { ascending: false })
    .limit(10);
  if (receiptDate) fuzzy = fuzzy.eq("invoice_date", receiptDate);
  const fuzzyResult = await fuzzy;
  if (fuzzyResult.error || !fuzzyResult.data?.length) {
    if (receiptDate) return findVaultDocumentIdForInvoice(title, null);
    return null;
  }
  const needle = title.toLowerCase();
  const exact = fuzzyResult.data.find((d) => String(d.title || "").trim().toLowerCase() === needle);
  if (exact) return exact.id;
  const partial = fuzzyResult.data.find((d) => String(d.title || "").toLowerCase().includes(needle));
  return partial?.id ?? null;
}

/**
 * Save buying price for a DSR row (receipt day) and reload P&L summary.
 */
async function handleSaveBuyingPrice(dsrId) {
  const input = document.getElementById(`pl-buying-${dsrId}`);
  const invInput = document.getElementById(`pl-inv-${dsrId}`);
  const gstinInput = document.getElementById(`pl-gstin-${dsrId}`);
  const saveBtn = document.querySelector(`.pl-buying-save[data-dsr-id="${dsrId}"]`);
  const itemEl = document.querySelector(`.pl-missing-item[data-dsr-id="${dsrId}"]`);
  const product =
    saveBtn?.dataset?.product || itemEl?.dataset?.product;
  const receiptDate = itemEl?.dataset?.date || null;
  const valueKl = Number.parseFloat((input?.value ?? "").trim());
  const parsed = validateBuyingRateKlInput(valueKl);
  if (!parsed.ok) {
    showPlBuyingPriceError(
      parsed.message || `Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`
    );
    return;
  }
  const value = buyingRatePerLitreForDb(parsed.valuePerLitre, product);
  if (value == null) {
    showPlBuyingPriceError(`Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`);
    return;
  }
  const supplierInvoiceNo = (invInput?.value ?? "").trim();
  let supplierGstin = (gstinInput?.value ?? "").trim().toUpperCase();
  if (!supplierGstin) {
    supplierGstin = (
      PumpSettings.getCachedSync().reports?.fuelSupplierGstin ||
      AppConfig.DEFAULT_REPORTS.fuelSupplierGstin ||
      ""
    )
      .toString()
      .trim()
      .toUpperCase();
  }
  if (supplierGstin && !/^[0-9A-Z]{15}$/.test(supplierGstin)) {
    showPlBuyingPriceError("Supplier GSTIN must be 15 characters (or leave blank).");
    return;
  }
  document.getElementById("pl-buying-price-error")?.classList.add("hidden");
  const btn = saveBtn;
  const resetBtn = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save";
      btn.classList.remove("pl-save-success");
    }
  };
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }

  let vaultDocId = null;
  try {
    if (supplierInvoiceNo) {
      vaultDocId = await findVaultDocumentIdForInvoice(supplierInvoiceNo, receiptDate || null);
    }
  } catch (_) {
    vaultDocId = null;
  }

  const rpc = await supabaseClient.rpc("update_dsr_buying_price", {
    p_dsr_id: dsrId,
    p_value: value,
    p_supplier_invoice_no: supplierInvoiceNo || null,
    p_supplier_gstin: supplierGstin || null,
    p_invoice_document_id: vaultDocId,
  });
  if (rpc.error) {
    AppError.report(rpc.error, { context: "handleSaveBuyingPrice", type: "dsr" });
    showPlBuyingPriceError(rpc.error.message || "Could not save. Ensure you are logged in as admin.");
    resetBtn();
    return;
  }
  if (btn) {
    btn.textContent = "Saved";
    btn.classList.add("pl-save-success");
  }
  // Invalidate cache so other tabs / next load see updated P&L immediately
  if (typeof AppCache !== "undefined" && AppCache) {
    CacheInvalidation.invalidate("reports");
  }
  const range = getCurrentPlRange();
  if (range) await loadProfitLossSummary(range);
  else await refreshMissingBuyingPriceUi({ renderList: true });
  resetBtn();
}

function showPlBuyingPriceError(message) {
  const el = document.getElementById("pl-buying-price-error");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

function scrollToPlBuyingPriceAlert() {
  const alert = document.getElementById("pl-buying-price-alert");
  if (alert && !alert.classList.contains("hidden")) {
    alert.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelector(".pl-buying-input")?.focus({ preventScroll: true });
    return;
  }
  document.getElementById("pl")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPlMissingBuyingList(rows) {
  const plAlertEl = document.getElementById("pl-buying-price-alert");
  const plMissingListEl = document.getElementById("pl-missing-buying-list");
  if (!plAlertEl || !plMissingListEl) return;

  if (!rows?.length) {
    plAlertEl.classList.add("hidden");
    plMissingListEl.innerHTML = "";
    return;
  }

  plAlertEl.classList.remove("hidden");
  const defaultGstin =
    PumpSettings.getCachedSync().reports?.fuelSupplierGstin ||
    AppConfig.DEFAULT_REPORTS.fuelSupplierGstin ||
    "";
  plMissingListEl.innerHTML = rows
    .map((row) => {
      const productLabel = normalizeProduct(row.product) === "petrol" ? "Petrol" : "Diesel";
      const rowId = row.id;
      const invVal = escapeHtml(row.supplier_invoice_no || "");
      const gstinVal = escapeHtml(row.supplier_gstin || defaultGstin || "");
      return `
        <li class="pl-missing-item" data-dsr-id="${escapeHtml(rowId)}" data-product="${escapeHtml(normalizeProduct(row.product))}" data-date="${escapeHtml(row.date)}">
          <span class="pl-missing-label">${escapeHtml(row.date)} · ${productLabel}</span>
          <label for="pl-buying-${rowId}" class="sr-only">${escapeHtml(getPlBuyingPriceFieldLabel())}</label>
          <input id="pl-buying-${rowId}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="${escapeHtml(getPlBuyingPricePlaceholder())}" class="pl-buying-input" data-dsr-id="${escapeHtml(rowId)}" />
          <label for="pl-inv-${rowId}" class="sr-only">Supplier invoice no</label>
          <input id="pl-inv-${rowId}" type="text" maxlength="40" placeholder="BPCL invoice no" class="pl-inv-input" value="${invVal}" data-dsr-id="${escapeHtml(rowId)}" />
          <label for="pl-gstin-${rowId}" class="sr-only">Supplier GSTIN</label>
          <input id="pl-gstin-${rowId}" type="text" maxlength="15" placeholder="Supplier GSTIN" class="pl-gstin-input" value="${gstinVal}" data-dsr-id="${escapeHtml(rowId)}" />
          <button type="button" class="button-secondary pl-buying-save" data-dsr-id="${escapeHtml(rowId)}" data-product="${escapeHtml(normalizeProduct(row.product))}">Save</button>
        </li>`;
    })
    .join("");
  plMissingListEl.querySelectorAll(".pl-buying-save").forEach((btn) => {
    btn.addEventListener("click", () => handleSaveBuyingPrice(btn.dataset.dsrId));
  });
}

async function loadProfitLossSummary(range) {
  const plNetSaleEl = document.getElementById("pl-net-sale");
  const plExpenseEl = document.getElementById("pl-expense");
  const plValueEl = document.getElementById("pl-value");
  const plLabelEl = document.getElementById("pl-label");
  const incomeEl = document.getElementById("income-total");
  const incomeNoteEl = document.getElementById("income-note");

  if (plNetSaleEl) plNetSaleEl.textContent = "Loading…";
  if (plExpenseEl) plExpenseEl.textContent = "Loading…";
  if (plValueEl) plValueEl.textContent = "Loading…";
  if (incomeEl) incomeEl.textContent = "Loading…";
  if (incomeNoteEl) incomeNoteEl.textContent = "";
  const plBuyingErrorEl = document.getElementById("pl-buying-price-error");
  if (plBuyingErrorEl) plBuyingErrorEl.classList.add("hidden");
  const plBuyingHintEl = document.getElementById("pl-buying-hint");
  if (plBuyingHintEl && typeof getPlBuyingPriceHint === "function") {
    plBuyingHintEl.textContent = getPlBuyingPriceHint();
  }

  const plData = await fetchProfitLossData(range);
  if (plData.dsrError) AppError.report(plData.dsrError, { context: "profitLossSummary", type: "dsr" });
  if (plData.expenseError) AppError.report(plData.expenseError, { context: "profitLossSummary", type: "expense" });
  if (plData.lubeError) AppError.report(plData.lubeError, { context: "profitLossSummary", type: "lube" });

  const dsrRows = plData.dsrRows;
  const receiptRows = plData.receiptRows;
  const expenseData = plData.expenseRows;

  const hasDsr = !plData.dsrError;
  const hasExpense = !plData.expenseError;
  const pl = computeProfitLossSummary({
    dsrRows,
    receiptRows,
    expenseRows: expenseData,
    lubeSales: plData.lubeSales,
    lubeCogs: plData.lubeCogs ?? 0,
    categoryMap: plData.categoryMap ?? null,
  });
  const income = { total: pl.revenue, missingRates: pl.missingRates };
  const allBuyingPricesEntered = pl.canCalculate;

  const plProfitHintEl = document.getElementById("pl-profit-hint");
  await refreshMissingBuyingPriceUi({ renderList: true });

  const expenseTotal = pl.totalExpenses;

  if (plNetSaleEl) {
    plNetSaleEl.textContent = hasDsr && dsrRows.length ? formatCurrency(income.total) : "—";
  }
  if (plExpenseEl) {
    plExpenseEl.textContent = hasExpense ? formatCurrency(expenseTotal) : "—";
  }

  if (plValueEl && plLabelEl) {
    if (plLabelEl) plLabelEl.textContent = "Profit / Loss";
    if (plProfitHintEl) {
      plProfitHintEl.classList.add("hidden");
      plProfitHintEl.textContent = "";
    }
    if (!hasDsr || !hasExpense) {
      plValueEl.textContent = "—";
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else if (!allBuyingPricesEntered) {
      plValueEl.textContent = "—";
      if (plProfitHintEl) {
        plProfitHintEl.textContent =
          "Enter pre-VAT ₹/KL for receipt days above. No prior receipt rate is available yet, so net profit cannot be calculated.";
        plProfitHintEl.classList.remove("hidden");
      }
      plValueEl.classList.remove("stat-negative", "stat-positive");
    } else {
      const profitLoss = pl.netProfit;
      plValueEl.textContent = formatCurrency(profitLoss);
      plValueEl.classList.toggle("stat-positive", profitLoss >= 0);
      plValueEl.classList.toggle("stat-negative", profitLoss < 0);
      if (pl.usingProvisionalBuying && plProfitHintEl) {
        plProfitHintEl.textContent =
          "Some receipt days still need ₹/KL — net profit uses the previous receipt rate until you save the correct price above.";
        plProfitHintEl.classList.remove("hidden");
      }
    }
  }

  if (incomeEl) {
    incomeEl.textContent =
      hasDsr && dsrRows.length ? formatCurrency(income.total) : "—";
  }
  if (incomeNoteEl) {
    const parts = [];
    if (income.missingRates > 0) {
      parts.push("Some DSR entries are missing rates, so income totals may be partial.");
    }
    if (pl.lubeSales > 0) {
      const lubeNet =
        pl.lubeCogs > 0
          ? `Lube/billing sales ${formatCurrency(pl.lubeSales)} − vault purchases ${formatCurrency(pl.lubeCogs)}.`
          : `Lube/billing sales (${formatCurrency(pl.lubeSales)}) included in net profit.`;
      parts.push(lubeNet);
    }
    incomeNoteEl.textContent = parts.join(" ");
  }
  const plMethodologyEl = document.getElementById("pl-methodology-note");
  if (plMethodologyEl) {
    plMethodologyEl.textContent =
      "Net profit = fuel gross profit + (lube sales − vault purchase amounts) − operating expenses. Net sale (above) is fuel only. Fuel uses net litres and landed buying cost. MS/HS and density testing expenses excluded. Same formula as Analysis and Reports.";
  }
  scheduleAutoFitStats();
}

window.addEventListener("resize", () => {
  scheduleAutoFitStats();
});

// Listen for credit updates from other pages/tabs and refresh credit summary
window.addEventListener("storage", (e) => {
  if (e.key !== "credit-updated") return;
  const dateInput = document.getElementById("snapshot-date");
  const date = dateInput?.value || getLocalDateString();
  loadCreditSummary(date);
});

// Refetch open credit when user returns to dashboard tab or page (e.g. from Credit page)
function refreshCreditSummaryOnVisible() {
  const dateInput = document.getElementById("snapshot-date");
  if (!dateInput) return;
  const date = dateInput.value || getLocalDateString();
  loadCreditSummary(date);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.getElementById("snapshot-card")) {
    refreshCreditSummaryOnVisible();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && document.getElementById("snapshot-card")) {
    refreshCreditSummaryOnVisible();
  }
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

