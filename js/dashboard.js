/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, getValidFilterState, setFilterState, escapeHtml, PumpSettings, loadPumpSettings, AppConfig, createDateRangeFilter, normalizeProduct, formatQuantity, formatDisplayDate, formatDateInput, getRangeForSelection, CacheInvalidation, getDsrNetSaleLitres, calculateDsrSaleRupees, computeProfitLossSummary, buildExpenseCategoryMap, sumByProduct, resolveDayFuelStock, initPersistedDateInput, getLocalDateString, getYesterdayDateString, getMonthRange, DsrQueries */

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
let dashboardRole = null;

const DAY_CLOSING_LOOKBACK_DAYS = 7;

/**
 * Shared notification card markup for the inbox feed.
 * @param {{ type: string, label: string, message: string, meta?: string, cta?: string, href?: string, role?: string, dataNotif?: string, expandHtml?: string }} opts
 */
function renderNotifItem({
  type,
  label,
  message,
  meta,
  cta,
  href,
  role = "alert",
  dataNotif,
  expandHtml,
}) {
  const metaHtml = meta ? `<span class="notif-item-meta">${escapeHtml(meta)}</span>` : "";
  const expandBlock = expandHtml || "";
  const ctaHtml =
    cta && href
      ? `<a href="${escapeHtml(href)}" class="button-secondary notif-item-cta">${escapeHtml(cta)}</a>`
      : "";
  const dataAttr = dataNotif ? ` data-notif="${escapeHtml(dataNotif)}"` : "";
  return `<article class="notif-item notif-item--${escapeHtml(type)}" role="${escapeHtml(role)}"${dataAttr}>
    <div class="notif-item-body">
      <span class="notif-item-label">${escapeHtml(label)}</span>
      <p class="notif-item-message">${escapeHtml(message)}</p>
      ${metaHtml}
      ${expandBlock}
    </div>
    ${ctaHtml}
  </article>`;
}

function creditCustomerDetailHref(customerName) {
  return `credit.html?${new URLSearchParams({ name: customerName || "" }).toString()}`;
}

/**
 * Expandable customer list for credit alerts.
 * @param {{ name: string, href: string, detail: string }[]} rows
 * @param {string} summaryLabel
 */
function renderNotifCustomerExpand(rows, summaryLabel) {
  if (!rows?.length) return "";
  const items = rows
    .map(
      (r) =>
        `<li class="notif-customer-row">
          <a class="notif-customer-link" href="${escapeHtml(r.href)}">${escapeHtml(r.name)}</a>
          <span class="notif-customer-detail">${escapeHtml(r.detail)}</span>
        </li>`
    )
    .join("");
  return `<details class="notif-customer-expand">
    <summary>${escapeHtml(summaryLabel)}</summary>
    <ul class="notif-customer-list">${items}</ul>
  </details>`;
}

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
  const t = getAlertThresholds();
  return { petrol: t.petrol, diesel: t.diesel };
}

function updateLowStockAlert(petrolStock, dieselStock) {
  const wrap = document.getElementById("low-stock-alert");
  const msg = document.getElementById("low-stock-message");
  if (!wrap || !msg) return;
  const th = getLowStockThresholds();
  const parts = [];
  if (Number.isFinite(petrolStock) && petrolStock < th.petrol) {
    parts.push(`Petrol ${formatQuantity(petrolStock)} L (below ${formatQuantity(th.petrol)} L)`);
  }
  if (Number.isFinite(dieselStock) && dieselStock < th.diesel) {
    parts.push(`Diesel ${formatQuantity(dieselStock)} L (below ${formatQuantity(th.diesel)} L)`);
  }
  if (parts.length === 0) {
    wrap.classList.add("hidden");
    updateDashboardAlertsVisibility();
    return;
  }
  msg.textContent = parts.join(" · ");
  wrap.classList.remove("hidden");
  updateDashboardAlertsVisibility();
}

function countVisibleNotificationItems() {
  let count = 0;
  const dayClosing = document.getElementById("day-closing-banners");
  if (dayClosing) {
    count += dayClosing.querySelectorAll(".notif-item:not(.notif-item--success)").length;
  }
  const alerts = document.getElementById("dashboard-alerts");
  const alertsVisible = alerts && !alerts.classList.contains("dashboard-alerts-empty");
  if (alertsVisible) {
    const lowStock = document.getElementById("low-stock-alert");
    if (lowStock && !lowStock.classList.contains("hidden")) count += 1;
    const smartPanel = document.getElementById("smart-alerts-panel");
    if (smartPanel && !smartPanel.classList.contains("hidden")) {
      count += smartPanel.querySelectorAll(".notif-item").length;
    }
  }
  const plTodo = document.getElementById("pl-todo-banner");
  if (plTodo && !plTodo.classList.contains("hidden")) count += 1;
  return count;
}

function updateNotificationsPanelState() {
  const feed = document.getElementById("notifications-feed");
  const empty = document.getElementById("notifications-empty");
  const countBadge = document.getElementById("notifications-count-badge");
  const navBadge = document.getElementById("notifications-nav-badge");

  const dayBlock = document.getElementById("day-closing-block");
  const dayHasItems = dayBlock && !dayBlock.classList.contains("hidden");
  const alerts = document.getElementById("dashboard-alerts");
  const alertsVisible = alerts && !alerts.classList.contains("dashboard-alerts-empty");
  const plTodo = document.getElementById("pl-todo-banner");
  const plVisible = plTodo && !plTodo.classList.contains("hidden");

  const hasAny = Boolean(dayHasItems || alertsVisible || plVisible);
  feed?.classList.toggle("hidden", !hasAny);
  empty?.classList.toggle("hidden", hasAny);

  const openCount = countVisibleNotificationItems();
  if (countBadge) {
    if (openCount > 0) {
      countBadge.textContent = openCount === 1 ? "1 open" : `${openCount} open`;
      countBadge.classList.remove("hidden");
    } else {
      countBadge.classList.add("hidden");
    }
  }
  if (navBadge) {
    if (openCount > 0) {
      navBadge.textContent = String(openCount);
      navBadge.classList.remove("hidden");
      navBadge.setAttribute("aria-label", `${openCount} open notification${openCount === 1 ? "" : "s"}`);
    } else {
      navBadge.classList.add("hidden");
      navBadge.removeAttribute("aria-label");
    }
  }
}

function updateDashboardAlertsVisibility() {
  const container = document.getElementById("dashboard-alerts");
  if (!container) return;
  const lowStock = document.getElementById("low-stock-alert");
  const smartPanel = document.getElementById("smart-alerts-panel");
  const hasVisible = (lowStock && !lowStock.classList.contains("hidden")) ||
    (smartPanel && !smartPanel.classList.contains("hidden") && smartPanel.children.length > 0);
  container.classList.toggle("dashboard-alerts-empty", !hasVisible);
  updateNotificationsPanelState();
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
  dashboardRole = role;
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

    const closingWindow = await fetchDayClosingWindow();
    await Promise.all([
      updateSmartAlerts({ closingRows: closingWindow.data, todayStr: closingWindow.todayStr }),
      loadDayClosingBanners(closingWindow),
      role === "admin" ? refreshMissingBuyingPriceUi() : Promise.resolve(),
    ]);
    updateDashboardAlertsVisibility();
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
    petrol: t.petrol,
    diesel: t.diesel,
    highCredit: t.highCredit > 0 ? t.highCredit : 0,
    individualHighCredit: t.individualHighCredit > 0 ? t.individualHighCredit : 0,
    highVariation: t.highVariation > 0 ? t.highVariation : 0,
    dayClosingReminder: t.dayClosingReminder,
    dayClosingShortage: t.dayClosingShortage,
    shortageAlert: t.shortageAlert,
    surplusAlert: t.surplusAlert,
    nightCashAlert: t.nightCashAlert,
    nightCashMinAmount: t.nightCashMinAmount,
    missingMeterAlert: t.missingMeterAlert,
    missingRateAlert: t.missingRateAlert,
    missingDipAlert: t.missingDipAlert,
    staleCreditAlert: t.staleCreditAlert,
    staleCreditDays: t.staleCreditDays,
    unpaidSalaryAlert: t.unpaidSalaryAlert,
    attendanceAlert: t.attendanceAlert,
    expenseRatioAlert: t.expenseRatioAlert,
    expenseRatioPct: t.expenseRatioPct,
    missingInvoiceAlert: t.missingInvoiceAlert,
    missingInvoiceLookbackDays: t.missingInvoiceLookbackDays,
  };
}

function daysBetweenDateStrings(fromStr, toStr) {
  if (!fromStr || !toStr) return null;
  const from = new Date(`${fromStr}T00:00:00`);
  const to = new Date(`${toStr}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function isPastLocalHm(hhmm) {
  const parts = String(hhmm || "22:00").split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h)) return false;
  const now = new Date();
  const minsNow = now.getHours() * 60 + now.getMinutes();
  return minsNow >= h * 60 + (Number.isFinite(m) ? m : 0);
}

function currentSalaryMonthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function approxNetMonthlySalary(emp) {
  const gross = Math.max(0, Number(emp?.monthly_salary ?? 0));
  const pf = Math.max(0, Number(emp?.pf_contribution ?? 0));
  return Math.max(0, gross - Math.min(pf, gross));
}

/**
 * One day_closing window for banners (date) + shortage/surplus alert (short_today).
 */
async function fetchDayClosingWindow() {
  const today = new Date();
  const todayStr = formatDateInput(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - DAY_CLOSING_LOOKBACK_DAYS);
  const startStr = formatDateInput(startDate);
  const th = getAlertThresholds();

  if (!th.dayClosingReminder && !th.shortageAlert && !th.surplusAlert) {
    return { data: [], error: null, todayStr, startStr };
  }

  const { data, error } = await supabaseClient
    .from("day_closing")
    .select("date, short_today")
    .gte("date", startStr)
    .lte("date", todayStr);

  return { data: data ?? [], error, todayStr, startStr };
}

/**
 * Patch only the outstanding-credit smart alert (no network).
 * Used when credit SWR refreshes so the inbox stays in sync.
 */
function syncCreditSmartAlert() {
  const panel = document.getElementById("smart-alerts-panel");
  if (!panel) return;
  const th = getAlertThresholds();
  const existing = panel.querySelector('[data-notif="credit"]');
  const shouldShow =
    th.highCredit > 0 &&
    Number.isFinite(lastCreditTotalRupees) &&
    lastCreditTotalRupees > th.highCredit;

  if (!shouldShow) {
    if (!existing) return;
    existing.remove();
    if (!panel.querySelector(".notif-item")) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    }
    updateDashboardAlertsVisibility();
    return;
  }

  const html = renderNotifItem({
    type: "warning",
    label: "Total high credit",
    message: `${formatCurrency(lastCreditTotalRupees)} is above your portfolio limit (${formatCurrency(th.highCredit)}).`,
    cta: "Open credit",
    href: "credit.html#outstanding",
    dataNotif: "credit",
  });
  if (existing) existing.outerHTML = html;
  else {
    panel.insertAdjacentHTML("afterbegin", html);
    panel.classList.remove("hidden");
  }
  updateDashboardAlertsVisibility();
}

async function updateSmartAlerts(options = {}) {
  const panel = document.getElementById("smart-alerts-panel");
  if (!panel) return;
  const alerts = [];
  const th = getAlertThresholds();
  const todayStr = options.todayStr || getLocalDateString();
  const driveEnabled = PumpSettings.getCachedSync()?.integrations?.googleDrive?.enabled === true;
  const isAdmin = dashboardRole === "admin";

  if (th.highCredit > 0 && Number.isFinite(lastCreditTotalRupees) && lastCreditTotalRupees > th.highCredit) {
    alerts.push({
      type: "warning",
      label: "Total high credit",
      message: `${formatCurrency(lastCreditTotalRupees)} is above your portfolio limit (${formatCurrency(th.highCredit)}).`,
      cta: "Open credit",
      href: "credit.html#outstanding",
      dataNotif: "credit",
    });
  }

  const needClosingFetch = (th.shortageAlert || th.surplusAlert) && !Array.isArray(options.closingRows);
  const needDsrToday = th.missingMeterAlert || th.missingRateAlert || th.missingDipAlert;
  const needStockToday = th.missingDipAlert || th.highVariation > 0;
  const needCreditList = th.staleCreditAlert || th.individualHighCredit > 0;
  const salaryMonth = currentSalaryMonthValue();
  const monthRange = getMonthRange(new Date().getFullYear(), new Date().getMonth());
  const invoiceStart = (() => {
    const d = new Date(`${todayStr}T00:00:00`);
    d.setDate(d.getDate() - (Number(th.missingInvoiceLookbackDays) || 30));
    return formatDateInput(d);
  })();

  const [
    closingRes,
    nightRes,
    dsrRes,
    stockRes,
    creditListRes,
    rosterRes,
    attendanceRes,
    salaryEmpRes,
    salaryPayRes,
    salaryExclRes,
    mtdDsrRes,
    mtdExpenseRes,
    missingInvoiceRes,
  ] = await Promise.all([
    needClosingFetch
      ? supabaseClient.from("day_closing").select("short_today").eq("date", todayStr).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    th.nightCashAlert
      ? supabaseClient.rpc("get_night_cash_available")
      : Promise.resolve({ data: null, error: null }),
    needDsrToday
      ? supabaseClient
          .from("dsr")
          .select("date, product, petrol_rate, diesel_rate, stock, dip_reading")
          .eq("date", todayStr)
      : Promise.resolve({ data: [], error: null }),
    needStockToday
      ? supabaseClient.rpc("get_dsr_stock_range", { p_start: todayStr, p_end: todayStr })
      : Promise.resolve({ data: [], error: null }),
    needCreditList
      ? supabaseClient.rpc("get_outstanding_credit_list_as_of", { p_date: todayStr })
      : Promise.resolve({ data: [], error: null }),
    th.attendanceAlert
      ? supabaseClient.rpc("list_employees_roster")
      : Promise.resolve({ data: [], error: null }),
    th.attendanceAlert
      ? supabaseClient
          .from("employee_attendance")
          .select("id, employee_id")
          .eq("date", todayStr)
      : Promise.resolve({ data: [], error: null }),
    th.unpaidSalaryAlert && isAdmin
      ? supabaseClient.rpc("list_employees_salary")
      : Promise.resolve({ data: [], error: null }),
    th.unpaidSalaryAlert && isAdmin
      ? supabaseClient
          .from("salary_payments")
          .select("employee_id, amount")
          .eq("salary_month", salaryMonth)
      : Promise.resolve({ data: [], error: null }),
    th.unpaidSalaryAlert && isAdmin
      ? supabaseClient
          .from("salary_month_exclusions")
          .select("employee_id")
          .eq("salary_month", salaryMonth)
      : Promise.resolve({ data: [], error: null }),
    th.expenseRatioAlert
      ? supabaseClient
          .from("dsr")
          .select("product, total_sales, testing, petrol_rate, diesel_rate")
          .gte("date", monthRange.start)
          .lte("date", monthRange.end)
      : Promise.resolve({ data: [], error: null }),
    th.expenseRatioAlert
      ? supabaseClient
          .from("expenses")
          .select("amount")
          .gte("date", monthRange.start)
          .lte("date", monthRange.end)
      : Promise.resolve({ data: [], error: null }),
    th.missingInvoiceAlert && driveEnabled
      ? supabaseClient
          .from("dsr")
          .select("date, product, receipts, invoice_document_id")
          .gt("receipts", 0)
          .is("invoice_document_id", null)
          .gte("date", invoiceStart)
          .lte("date", todayStr)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const dsrToday = dsrRes.error ? [] : dsrRes.data ?? [];
  const stockToday = stockRes.error ? [] : stockRes.data ?? [];

  if (lastPetrolVariation == null && stockToday.length) {
    lastPetrolVariation = sumByProduct(stockToday, "petrol", (row) => row.variation);
    lastDieselVariation = sumByProduct(stockToday, "diesel", (row) => row.variation);
  }

  if (th.highVariation > 0) {
    const petrolVar = Math.abs(Number(lastPetrolVariation));
    const dieselVar = Math.abs(Number(lastDieselVariation));
    const petrolOver = Number.isFinite(petrolVar) && petrolVar > th.highVariation;
    const dieselOver = Number.isFinite(dieselVar) && dieselVar > th.highVariation;
    if (petrolOver || dieselOver) {
      const parts = [];
      if (petrolOver) parts.push(`Petrol ${formatQuantity(petrolVar)} L`);
      if (dieselOver) parts.push(`Diesel ${formatQuantity(dieselVar)} L`);
      alerts.push({
        type: "warning",
        label: "Stock variation",
        message: `Above ${formatQuantity(th.highVariation)} L: ${parts.join(", ")}. Verify meter readings.`,
        cta: "View DSR",
        href: "dsr.html",
      });
    }
  }

  let shortAmount = null;
  if (th.shortageAlert || th.surplusAlert) {
    if (Array.isArray(options.closingRows)) {
      const row = options.closingRows.find((r) => r.date === todayStr);
      if (row?.short_today != null) shortAmount = Number(row.short_today);
    } else if (!closingRes.error && closingRes.data?.short_today != null) {
      shortAmount = Number(closingRes.data.short_today);
    }
  }

  if (shortAmount != null) {
    const thresholdLabel =
      th.dayClosingShortage > 0
        ? `your threshold (${formatCurrency(th.dayClosingShortage)})`
        : "zero";
    if (th.shortageAlert && PumpSettings.isDayClosingShortage(shortAmount)) {
      alerts.push({
        type: "warning",
        label: "Cash shortage",
        message: `Today's short is ${formatCurrency(shortAmount)} (above ${thresholdLabel}). Review night cash and PhonePe.`,
        cta: "Day closing",
        href: `day-closing.html?date=${encodeURIComponent(todayStr)}`,
      });
    } else if (th.surplusAlert && PumpSettings.isDayClosingSurplus(shortAmount)) {
      alerts.push({
        type: "warning",
        label: "Cash surplus",
        message: `Today's closing is over by ${formatCurrency(Math.abs(shortAmount))} (beyond ${thresholdLabel}). Check PhonePe and night cash.`,
        cta: "Day closing",
        href: `day-closing.html?date=${encodeURIComponent(todayStr)}`,
      });
    }
  }

  if (th.nightCashAlert) {
    if (!nightRes.error && nightRes.data) {
      const nightTotal = Number(nightRes.data.total_available ?? 0);
      const nightDays = Number(nightRes.data.day_count ?? 0);
      const minAmount = Number(th.nightCashMinAmount) || 0;
      if (nightDays > 0 && nightTotal > 0 && nightTotal >= minAmount) {
        const rangeHint =
          nightRes.data.from_date && nightRes.data.to_date
            ? nightRes.data.from_date === nightRes.data.to_date
              ? formatDisplayDate(nightRes.data.from_date)
              : `${formatDisplayDate(nightRes.data.from_date)} – ${formatDisplayDate(nightRes.data.to_date)}`
            : "";
        alerts.push({
          type: "warning",
          label: "Night cash at pump",
          message: `${formatCurrency(nightTotal)} across ${nightDays} day${nightDays === 1 ? "" : "s"} still uncollected${rangeHint ? ` (${rangeHint})` : ""}.`,
          cta: "Collect",
          href: "day-closing.html#register",
        });
      }
    } else if (nightRes.error) {
      AppError.report(nightRes.error, { context: "updateSmartAlerts", type: "night_cash" });
    }
  }

  if (dsrRes.error) AppError.report(dsrRes.error, { context: "updateSmartAlerts", type: "dsr_today" });
  if (stockRes.error) AppError.report(stockRes.error, { context: "updateSmartAlerts", type: "stock_today" });

  const hasPetrolMeter = dsrToday.some((row) => normalizeProduct(row.product) === "petrol");
  const hasDieselMeter = dsrToday.some((row) => normalizeProduct(row.product) === "diesel");

  const missingMeter = [];
  if (th.missingMeterAlert) {
    if (!hasPetrolMeter) missingMeter.push("Petrol");
    if (!hasDieselMeter) missingMeter.push("Diesel");
    if (missingMeter.length > 0) {
      const hash = !hasPetrolMeter && hasDieselMeter ? "#petrol" : hasPetrolMeter && !hasDieselMeter ? "#diesel" : "";
      alerts.push({
        type: "danger",
        label: "Meter reading",
        message: `No reading for today (${missingMeter.join(" · ")}). Enter nozzle totals before day closing.`,
        cta: "Enter reading",
        href: `meter-reading.html?date=${encodeURIComponent(todayStr)}${hash}`,
      });
    }
  }

  if (th.missingRateAlert) {
    // Match settings copy: alert only when there is no usable rate (today or last entered).
    const rates = await resolveRatesForDate(todayStr, dsrToday);
    const missingRate = [];
    if (!(Number.isFinite(rates.petrolRate) && rates.petrolRate > 0)) missingRate.push("Petrol");
    if (!(Number.isFinite(rates.dieselRate) && rates.dieselRate > 0)) missingRate.push("Diesel");
    if (missingRate.length > 0) {
      const hash =
        missingRate.length === 1 && missingRate[0] === "Petrol"
          ? "#petrol"
          : missingRate.length === 1
            ? "#diesel"
            : "";
      alerts.push({
        type: "warning",
        label: "Selling rate",
        message: `No selling rate for ${missingRate.join(" · ")}. Enter today's rate so sale value is correct.`,
        cta: "Enter rate",
        href: `meter-reading.html?date=${encodeURIComponent(todayStr)}${hash}`,
      });
    }
  }

  if (th.missingDipAlert) {
    const meterMissingPetrol = th.missingMeterAlert ? missingMeter.includes("Petrol") : !hasPetrolMeter;
    const meterMissingDiesel = th.missingMeterAlert ? missingMeter.includes("Diesel") : !hasDieselMeter;
    const missingDip = [];
    if (!meterMissingPetrol && !dipStockOnDate(stockToday, dsrToday, "petrol", todayStr)) {
      missingDip.push("Petrol");
    }
    if (!meterMissingDiesel && !dipStockOnDate(stockToday, dsrToday, "diesel", todayStr)) {
      missingDip.push("Diesel");
    }
    if (missingDip.length > 0) {
      const hash =
        missingDip.length === 1 && missingDip[0] === "Petrol"
          ? "#petrol"
          : missingDip.length === 1
            ? "#diesel"
            : "";
      alerts.push({
        type: "warning",
        label: "Dip stock",
        message: `No dip for today (${missingDip.join(" · ")}). Tank levels and variation need a current reading.`,
        cta: "Enter dip",
        href: `meter-reading.html?date=${encodeURIComponent(todayStr)}${hash}`,
      });
    }
  }

  if (th.staleCreditAlert || th.individualHighCredit > 0) {
    if (creditListRes.error) {
      AppError.report(creditListRes.error, { context: "updateSmartAlerts", type: "credit_list" });
    } else {
      const creditRows = creditListRes.data ?? [];

      if (th.individualHighCredit > 0) {
        const overLimit = creditRows
          .filter((row) => Number(row.amount_due_as_of ?? 0) > th.individualHighCredit)
          .sort((a, b) => Number(b.amount_due_as_of ?? 0) - Number(a.amount_due_as_of ?? 0));
        if (overLimit.length > 0) {
          const totalOver = overLimit.reduce((s, r) => s + Number(r.amount_due_as_of ?? 0), 0);
          const expandRows = overLimit.map((row) => {
            const due = Number(row.amount_due_as_of ?? 0);
            const overBy = due - th.individualHighCredit;
            return {
              name: row.customer_name || "Customer",
              href: creditCustomerDetailHref(row.customer_name),
              detail: `${formatCurrency(due)} · over by ${formatCurrency(overBy)}`,
            };
          });
          alerts.push({
            type: "warning",
            label: "Individual high credit",
            message: `${overLimit.length} customer${overLimit.length === 1 ? "" : "s"} above ${formatCurrency(th.individualHighCredit)} (${formatCurrency(totalOver)} total).`,
            cta: "Outstanding",
            href: "credit.html#outstanding",
            dataNotif: "credit-individual",
            expandHtml: renderNotifCustomerExpand(
              expandRows,
              `Show ${overLimit.length} customer${overLimit.length === 1 ? "" : "s"}`
            ),
          });
        }
      }

      if (th.staleCreditAlert) {
        const staleDays = Number(th.staleCreditDays) || 30;
        const stale = creditRows
          .filter((row) => {
            const due = Number(row.amount_due_as_of ?? 0);
            if (!(due > 0)) return false;
            const anchor = row.last_payment_date || row.sale_date;
            const age = daysBetweenDateStrings(anchor, todayStr);
            return age != null && age >= staleDays;
          })
          .sort((a, b) => Number(b.amount_due_as_of ?? 0) - Number(a.amount_due_as_of ?? 0));
        if (stale.length > 0) {
          const totalDue = stale.reduce((s, r) => s + Number(r.amount_due_as_of ?? 0), 0);
          const expandRows = stale.map((row) => {
            const due = Number(row.amount_due_as_of ?? 0);
            const age = daysBetweenDateStrings(row.last_payment_date || row.sale_date, todayStr);
            const ageLabel = age != null ? `${age} day${age === 1 ? "" : "s"}` : "—";
            return {
              name: row.customer_name || "Customer",
              href: creditCustomerDetailHref(row.customer_name),
              detail: `${formatCurrency(due)} · ${ageLabel}`,
            };
          });
          alerts.push({
            type: "warning",
            label: "Stale credit",
            message: `${stale.length} customer${stale.length === 1 ? "" : "s"} unpaid ${staleDays}+ days (${formatCurrency(totalDue)}).`,
            cta: "Outstanding",
            href: "credit.html#outstanding",
            dataNotif: "credit-stale",
            expandHtml: renderNotifCustomerExpand(
              expandRows,
              `Show ${stale.length} customer${stale.length === 1 ? "" : "s"}`
            ),
          });
        }
      }
    }
  }

  if (th.unpaidSalaryAlert && isAdmin) {
    if (salaryEmpRes.error) {
      AppError.report(salaryEmpRes.error, { context: "updateSmartAlerts", type: "unpaid_salary_employees" });
    } else if (salaryPayRes.error) {
      AppError.report(salaryPayRes.error, { context: "updateSmartAlerts", type: "unpaid_salary_payments" });
    } else {
      const excluded = new Set((salaryExclRes.data ?? []).map((r) => r.employee_id));
      if (salaryExclRes.error) {
        AppError.report(salaryExclRes.error, { context: "updateSmartAlerts", type: "unpaid_salary_exclusions" });
      }
      const paidMap = new Map();
      for (const p of salaryPayRes.data ?? []) {
        paidMap.set(p.employee_id, (paidMap.get(p.employee_id) || 0) + Number(p.amount ?? 0));
      }
      let unpaidCount = 0;
      let pendingTotal = 0;
      for (const emp of salaryEmpRes.data ?? []) {
        if (excluded.has(emp.id)) continue;
        const payable = approxNetMonthlySalary(emp);
        if (payable <= 0) continue;
        const pending = Math.max(0, payable - (paidMap.get(emp.id) || 0));
        if (pending > 0.009) {
          unpaidCount += 1;
          pendingTotal += pending;
        }
      }
      if (unpaidCount > 0) {
        alerts.push({
          type: "info",
          label: "Unpaid salary",
          message: `${unpaidCount} staff with ${formatCurrency(pendingTotal)} pending for ${salaryMonth}.`,
          cta: "Open salary",
          href: "salary.html",
        });
      }
    }
  }

  if (th.attendanceAlert) {
    const shifts = PumpSettings.getShiftConfig();
    if (isPastLocalHm(shifts.afternoonEnd)) {
      if (rosterRes.error) {
        AppError.report(rosterRes.error, { context: "updateSmartAlerts", type: "attendance_roster" });
      } else if (attendanceRes.error) {
        AppError.report(attendanceRes.error, { context: "updateSmartAlerts", type: "attendance_today" });
      } else {
        const rosterCount = (rosterRes.data ?? []).length;
        const markedCount = (attendanceRes.data ?? []).length;
        if (rosterCount > 0 && markedCount === 0) {
          alerts.push({
            type: "warning",
            label: "Attendance",
            message: `No attendance marked for today after ${shifts.afternoonEnd} (${rosterCount} on roster).`,
            cta: "Mark attendance",
            href: `attendance.html?date=${encodeURIComponent(todayStr)}`,
          });
        }
      }
    }
  }

  if (th.expenseRatioAlert) {
    if (mtdDsrRes.error) {
      AppError.report(mtdDsrRes.error, { context: "updateSmartAlerts", type: "expense_ratio_dsr" });
    } else if (mtdExpenseRes.error) {
      AppError.report(mtdExpenseRes.error, { context: "updateSmartAlerts", type: "expense_ratio_expenses" });
    } else {
      const sales = calculateDsrSaleRupees(mtdDsrRes.data ?? [], { includeTesting: true });
      const expenses = (mtdExpenseRes.data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
      if (sales > 0) {
        const ratioPct = (expenses / sales) * 100;
        if (ratioPct > th.expenseRatioPct) {
          alerts.push({
            type: "warning",
            label: "Expense ratio",
            message: `MTD expenses are ${ratioPct.toFixed(1)}% of fuel sales (threshold ${th.expenseRatioPct}%).`,
            cta: "Open analysis",
            href: "analysis.html",
          });
        }
      }
    }
  }

  if (th.missingInvoiceAlert && driveEnabled) {
    if (missingInvoiceRes.error) {
      AppError.report(missingInvoiceRes.error, { context: "updateSmartAlerts", type: "missing_invoice" });
    } else {
      const rows = missingInvoiceRes.data ?? [];
      if (rows.length > 0) {
        const uniqueDays = new Set(rows.map((r) => r.date)).size;
        alerts.push({
          type: "info",
          label: "Invoice upload",
          message: `${rows.length} receipt row${rows.length === 1 ? "" : "s"} across ${uniqueDays} day${uniqueDays === 1 ? "" : "s"} missing a linked invoice PDF.`,
          cta: "Open vault",
          href: "invoices.html",
        });
      }
    }
  }

  if (alerts.length === 0) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    updateDashboardAlertsVisibility();
    return;
  }
  panel.innerHTML = alerts.map((a) => renderNotifItem(a)).join("");
  panel.classList.remove("hidden");
  updateDashboardAlertsVisibility();
}

/**
 * Load day closing status for today and past days; render one card per day.
 * Respects dayClosingReminder setting.
 * @param {{ data?: Array, error?: unknown, todayStr?: string }|null} [prefetched]
 */
async function loadDayClosingBanners(prefetched = null) {
  const block = document.getElementById("day-closing-block");
  const container = document.getElementById("day-closing-banners");
  if (!block || !container) return;

  const th = getAlertThresholds();
  if (!th.dayClosingReminder) {
    block.classList.add("hidden");
    container.innerHTML = "";
    updateNotificationsPanelState();
    return;
  }

  let closedRows;
  let error;
  let todayStr;

  if (prefetched) {
    closedRows = prefetched.data;
    error = prefetched.error;
    todayStr = prefetched.todayStr || getLocalDateString();
  } else {
    const windowResult = await fetchDayClosingWindow();
    closedRows = windowResult.data;
    error = windowResult.error;
    todayStr = windowResult.todayStr;
  }

  if (error) {
    AppError.report(error, { context: "loadDayClosingBanners" });
    block.classList.add("hidden");
    container.innerHTML = "";
    updateNotificationsPanelState();
    return;
  }

  const closedSet = new Set((closedRows ?? []).map((r) => r.date));
  const today = new Date();
  const datesToShow = [];
  for (let i = 0; i <= DAY_CLOSING_LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    datesToShow.push(formatDateInput(d));
  }

  function bannerForDate(dateStr, showDone) {
    const done = closedSet.has(dateStr);
    if (!showDone && done) return null;
    const label = formatDisplayDate(dateStr);
    const isToday = dateStr === todayStr;
    const dayLabel = isToday ? "Today" : label;
    if (done) {
      return renderNotifItem({
        type: "success",
        label: "Done",
        message: `Day closing complete for ${isToday ? "today" : label}`,
        role: "status",
      });
    }
    return renderNotifItem({
      type: isToday ? "warning" : "danger",
      label: dayLabel,
      message: "Day closing not done",
      meta: isToday
        ? "Finish tonight's cash, PhonePe, and short before you leave."
        : "Past day still open — fill it to keep DSR and cash aligned.",
      cta: "Fill day closing",
      href: `day-closing.html?date=${encodeURIComponent(dateStr)}`,
    });
  }

  const parts = [];
  parts.push(bannerForDate(datesToShow[0], true));
  datesToShow.slice(1).forEach((dateStr) => {
    const html = bannerForDate(dateStr, false);
    if (html) parts.push(html);
  });

  const visible = parts.filter(Boolean);
  container.innerHTML = visible.join("");
  block.classList.toggle("hidden", visible.length === 0);
  updateNotificationsPanelState();
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
    syncCreditSmartAlert();
    return;
  }

  const value = Number(total);
  lastCreditTotalRupees = value;
  if (creditTotal) creditTotal.textContent = formatCurrency(value);
  syncCreditSmartAlert();
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
 * Fetch missing buying-price rows and update the notifications banner.
 */
async function refreshMissingBuyingPriceUi() {
  const bannerEl = document.getElementById("pl-todo-banner");
  const countEl = document.getElementById("pl-todo-count");

  const { data, error } = await DsrQueries.fetchMissingBuyingPriceRows();
  if (error) {
    AppError.report(error, { context: "refreshMissingBuyingPriceUi" });
    bannerEl?.classList.add("hidden");
    updateNotificationsPanelState();
    return [];
  }

  const rows = data ?? [];
  if (bannerEl && countEl) {
    if (rows.length > 0) {
      countEl.textContent = String(rows.length);
      bannerEl.classList.remove("hidden");
    } else {
      bannerEl.classList.add("hidden");
    }
  }
  updateNotificationsPanelState();
  return rows;
}

async function loadProfitLossSummary(range) {
  const plValueEl = document.getElementById("pl-value");
  const plLabelEl = document.getElementById("pl-label");
  const plProfitHintEl = document.getElementById("pl-profit-hint");

  if (plValueEl) plValueEl.textContent = "Loading…";
  if (plProfitHintEl) {
    plProfitHintEl.classList.add("hidden");
    plProfitHintEl.textContent = "";
  }

  const plData = await fetchProfitLossData(range);
  if (plData.dsrError) AppError.report(plData.dsrError, { context: "profitLossSummary", type: "dsr" });
  if (plData.expenseError) AppError.report(plData.expenseError, { context: "profitLossSummary", type: "expense" });
  if (plData.lubeError) AppError.report(plData.lubeError, { context: "profitLossSummary", type: "lube" });

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
  scheduleAutoFitStats();
});

// Listen for credit updates from other pages/tabs and refresh credit summary
window.addEventListener("storage", (e) => {
  if (e.key !== "credit-updated") return;
  const dateInput = document.getElementById("snapshot-date");
  const date = dateInput?.value || getLocalDateString();
  loadCreditSummary(date);
});

// Refetch open credit + notification sources when user returns to the dashboard
function refreshDashboardOnVisible() {
  const dateInput = document.getElementById("snapshot-date");
  if (!dateInput) return;
  const date = dateInput.value || getLocalDateString();
  loadCreditSummary(date);
  void loadDayClosingBanners();
  if (dashboardRole === "admin") void refreshMissingBuyingPriceUi();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.getElementById("snapshot-card")) {
    refreshDashboardOnVisible();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && document.getElementById("snapshot-card")) {
    refreshDashboardOnVisible();
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

