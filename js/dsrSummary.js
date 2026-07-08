/* global supabaseClient, AppError, escapeHtml, formatQuantity, getDsrNetSaleLitres, getLocalDateString, getValidFilterState, setFilterState */

/**
 * DSR summary section (filters / MS / HSD tabs) — lazy-loaded from dsr.js.
 */
(function () {
  const DSR_DAILY_TABLE_COLS = 11;
  const DSR_DAILY_FILTER_RANGES = new Set(["custom"]);

  let filtersReady = false;
  let dsrDailySummaryLoaded = false;
  let dsrDailyDateRange = { start: "", end: "" };
  let lastDailyPeriodStats = null;
  let periodStatEls = null;
  let pendingInvalidate = false;

  function getCurrentSection() {
    return window.DsrPage?.getCurrentSection?.() || "filters";
  }

  function initFilters(dateFromDashboard, urlDateParam) {
    if (filtersReady) return;
    const startInput = document.getElementById("dsr-daily-start-date");
    const endInput = document.getElementById("dsr-daily-end-date");
    if (!startInput || !endInput) return;

    const now = new Date();
    const todayStr = getLocalDateString();
    const curY = now.getFullYear();
    const curM = now.getMonth();
    const pad2 = (n) => String(n).padStart(2, "0");
    const currentMonthRange = {
      start: `${curY}-${pad2(curM + 1)}-01`,
      end: `${curY}-${pad2(curM + 1)}-${pad2(new Date(curY, curM + 1, 0).getDate())}`,
    };

    const stored =
      typeof getValidFilterState === "function"
        ? getValidFilterState("sales_daily", DSR_DAILY_FILTER_RANGES)
        : null;

    const initialDate = dateFromDashboard || urlDateParam;
    if (initialDate) {
      startInput.value = initialDate;
      endInput.value = initialDate;
      setFilterState &&
        setFilterState("sales_daily", { range: "custom", start: initialDate, end: initialDate });
    } else if (stored?.start && stored?.end) {
      startInput.value = stored.start;
      endInput.value = stored.end;
    } else {
      startInput.value = currentMonthRange.start;
      endInput.value = currentMonthRange.end;
    }

    dsrDailyDateRange = { start: startInput.value, end: endInput.value };

    const saveDailyFilter = () => {
      setFilterState &&
        setFilterState("sales_daily", {
          range: "custom",
          start: startInput.value || undefined,
          end: endInput.value || undefined,
        });
    };

    const onChange = () => {
      const start = startInput.value || todayStr;
      const end = endInput.value || todayStr;
      dsrDailyDateRange = { start, end };
      saveDailyFilter();
      void loadDailySummary(start, end);
    };

    startInput.addEventListener("change", onChange);
    endInput.addEventListener("change", onChange);
    filtersReady = true;
  }

  function invalidate() {
    dsrDailySummaryLoaded = false;
    pendingInvalidate = true;
    void refreshIfNeeded(true);
  }

  async function refreshIfNeeded(force = false) {
    const section = getCurrentSection();
    const summarySections = window.DsrSections?.SUMMARY;
    if (!summarySections?.has(section)) {
      if (force) dsrDailySummaryLoaded = false;
      return;
    }

    const start = dsrDailyDateRange.start || document.getElementById("dsr-daily-start-date")?.value;
    const end = dsrDailyDateRange.end || document.getElementById("dsr-daily-end-date")?.value;
    if (!start || !end) return;

    const shouldReload = force || pendingInvalidate || !dsrDailySummaryLoaded;
    pendingInvalidate = false;

    if (shouldReload) {
      await loadDailySummary(start, end);
    } else {
      updateDailyPeriodStatsForSection(section);
    }
  }

  function setDailyTableLoading(tbody) {
    tbody.innerHTML = `<tr><td colspan="${DSR_DAILY_TABLE_COLS}" class="muted">Loading…</td></tr>`;
  }

  function aggregateFuelRows(rows) {
    let net = 0;
    let receipts = 0;
    let variation = 0;
    for (const row of rows) {
      net += Number(getDsrNetSaleLitres(row)) || 0;
      receipts += Number(row.receipts) || 0;
      variation += Number(row.variation) || 0;
    }
    return { net, receipts, variation, dayCount: rows.length };
  }

  function computeDailyPeriodStats(petrolRows, dieselRows) {
    const petrol = aggregateFuelRows(petrolRows);
    const diesel = aggregateFuelRows(dieselRows);
    const dayCount = new Set([...petrolRows, ...dieselRows].map((row) => row.date)).size;

    return {
      petrolNet: petrol.net,
      dieselNet: diesel.net,
      petrolReceipts: petrol.receipts,
      dieselReceipts: diesel.receipts,
      petrolVariation: petrol.variation,
      dieselVariation: diesel.variation,
      totalReceipts: petrol.receipts + diesel.receipts,
      totalVariation: petrol.variation + diesel.variation,
      dayCount,
      petrolDayCount: petrol.dayCount,
      dieselDayCount: diesel.dayCount,
    };
  }

  function getPeriodStatEls() {
    if (!periodStatEls) {
      periodStatEls = {
        root: document.getElementById("dsr-period-stats"),
        petrolNet: document.getElementById("dsr-period-petrol-net"),
        dieselNet: document.getElementById("dsr-period-diesel-net"),
        receipts: document.getElementById("dsr-period-receipts"),
        variation: document.getElementById("dsr-period-variation"),
        daysMeta: document.getElementById("dsr-period-days-meta"),
      };
    }
    return periodStatEls;
  }

  function getSectionPeriodMetrics(stats, section) {
    if (section === "dsr-petrol") {
      return {
        receipts: stats.petrolReceipts,
        variation: stats.petrolVariation,
        days: stats.petrolDayCount,
      };
    }
    if (section === "dsr-diesel") {
      return {
        receipts: stats.dieselReceipts,
        variation: stats.dieselVariation,
        days: stats.dieselDayCount,
      };
    }
    return {
      receipts: stats.totalReceipts,
      variation: stats.totalVariation,
      days: stats.dayCount,
    };
  }

  function updateDailyPeriodStatsForSection(section = getCurrentSection()) {
    if (!lastDailyPeriodStats) return;
    updateDailyPeriodStats({ ...lastDailyPeriodStats, visible: true, section });
  }

  function updateDailyPeriodStats({
    petrolNet = 0,
    dieselNet = 0,
    petrolReceipts = 0,
    dieselReceipts = 0,
    petrolVariation = 0,
    dieselVariation = 0,
    totalReceipts = 0,
    totalVariation = 0,
    dayCount = 0,
    petrolDayCount = 0,
    dieselDayCount = 0,
    visible = false,
    section = getCurrentSection(),
  } = {}) {
    const els = getPeriodStatEls();
    if (!els.root) return;

    if (!visible) {
      els.root.classList.add("hidden");
      return;
    }

    const { receipts, variation, days } = getSectionPeriodMetrics(
      {
        petrolReceipts,
        dieselReceipts,
        petrolVariation,
        dieselVariation,
        totalReceipts,
        totalVariation,
        petrolDayCount,
        dieselDayCount,
        dayCount,
      },
      section
    );

    els.root.classList.remove("hidden");
    if (els.petrolNet) els.petrolNet.textContent = formatQuantity(petrolNet);
    if (els.dieselNet) els.dieselNet.textContent = formatQuantity(dieselNet);
    if (els.receipts) els.receipts.textContent = formatQuantity(receipts);
    if (els.variation) els.variation.textContent = formatQuantity(variation);
    if (els.daysMeta) {
      els.daysMeta.textContent = days
        ? `${days} day${days === 1 ? "" : "s"} in range`
        : "No entries in range";
    }
  }

  function renderDailyProductRows(tbody, rows) {
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${DSR_DAILY_TABLE_COLS}" class="muted">No entries found.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        const netSale = getDsrNetSaleLitres(row);
        return `<tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${formatQuantity(row.sales_pump1)}</td>
        <td>${formatQuantity(row.sales_pump2)}</td>
        <td>${formatQuantity(row.total_sales)}</td>
        <td>${formatQuantity(row.testing)}</td>
        <td>${formatQuantity(netSale)}</td>
        <td>${formatQuantity(row.stock)}</td>
        <td>${formatQuantity(row.opening_stock)}</td>
        <td>${formatQuantity(row.receipts)}</td>
        <td>${formatQuantity(row.closing_stock)}</td>
        <td>${formatQuantity(row.variation)}</td>
      </tr>`;
      })
      .join("");
  }

  async function loadDailySummary(startDate, endDate) {
    const tbodyPetrol = document.getElementById("dsr-daily-petrol-body");
    const tbodyDiesel = document.getElementById("dsr-daily-diesel-body");
    if (!tbodyPetrol || !tbodyDiesel) return;

    setDailyTableLoading(tbodyPetrol);
    setDailyTableLoading(tbodyDiesel);
    updateDailyPeriodStats({ visible: false });

    const [
      { data: dsrData, error: dsrError },
      { data: stockData, error: stockError },
    ] = await Promise.all([
      supabaseClient
        .from("dsr")
        .select("date, product, sales_pump1, sales_pump2, total_sales, testing, stock")
        .gte("date", startDate)
        .lte("date", endDate)
        .order("date", { ascending: false }),
      supabaseClient.rpc("get_dsr_stock_range", { p_start: startDate, p_end: endDate }),
    ]);

    if (dsrError || stockError) {
      const err = dsrError || stockError;
      AppError.report(err, { context: "dsrDailySummaryLoad" });
      const message = escapeHtml(AppError.getUserMessage(err));
      const errRow = `<tr><td colspan="${DSR_DAILY_TABLE_COLS}" class="error">${message}</td></tr>`;
      tbodyPetrol.innerHTML = errRow;
      tbodyDiesel.innerHTML = errRow;
      updateDailyPeriodStats({ visible: false });
      return;
    }

    const combined = mergeDailySummaryData(dsrData ?? [], stockData ?? []);
    const petrolRows = [];
    const dieselRows = [];
    for (const row of combined) {
      const p = (row.product || "").toLowerCase();
      if (p === "petrol") petrolRows.push(row);
      else if (p === "diesel") dieselRows.push(row);
    }

    renderDailyProductRows(tbodyPetrol, petrolRows);
    renderDailyProductRows(tbodyDiesel, dieselRows);
    lastDailyPeriodStats = computeDailyPeriodStats(petrolRows, dieselRows);
    updateDailyPeriodStats({
      ...lastDailyPeriodStats,
      visible: true,
      section: getCurrentSection(),
    });
    dsrDailySummaryLoaded = true;
  }

  function mergeDailySummaryData(dsrRows, stockRows) {
    const map = new Map();

    dsrRows.forEach((row) => {
      const key = `${row.date}-${row.product}`;
      map.set(key, {
        date: row.date,
        product: row.product,
        sales_pump1: row.sales_pump1,
        sales_pump2: row.sales_pump2,
        total_sales: row.total_sales,
        testing: row.testing,
        stock: row.stock,
      });
    });

    stockRows.forEach((row) => {
      const key = `${row.date}-${row.product}`;
      const existing = map.get(key) || { date: row.date, product: row.product };
      map.set(key, {
        ...existing,
        opening_stock: row.opening_stock,
        receipts: row.receipts,
        closing_stock: row.closing_stock,
        variation: row.variation,
      });
    });

    return Array.from(map.values()).sort((a, b) => {
      if (a.date === b.date) {
        return a.product.localeCompare(b.product);
      }
      return b.date.localeCompare(a.date);
    });
  }

  window.DsrSummary = {
    initFilters,
    refreshIfNeeded,
    invalidate,
  };
})();
