/**
 * DSR sales detail — pump / shift / salesman for the shared DSR date range.
 * Shown on dsr.html (not meter entry).
 */
/* global supabaseClient, AppError, escapeHtml, PumpSettings, formatQuantity, formatCurrency, formatDisplayDate */

(function (global) {
  const PRODUCT_LABEL = { petrol: "MS", diesel: "HSD" };
  const VIEW_BY_SECTION = {
    "by-pump": "pump",
    "by-shift": "shift",
    "by-salesman": "salesman",
  };

  let lastRangeKey = "";
  let lastData = null;
  let lastRates = null;
  let loadGen = 0;

  function el(id) {
    return document.getElementById(id);
  }

  function shiftLabel(key) {
    const cfg = PumpSettings.getShiftConfig?.() || {};
    if (key === "morning") return cfg.morningName || "Morning";
    if (key === "afternoon") return cfg.afternoonName || "Afternoon";
    return key || "—";
  }

  function showError(msg) {
    const err = el("dsr-breakdown-error");
    if (!err) return;
    err.textContent = msg || "";
    err.classList.toggle("hidden", !msg);
  }

  function setLoading(on) {
    el("dsr-breakdown-loading")?.classList.toggle("hidden", !on);
  }

  async function loadRatesMap(start, end) {
    const map = new Map();
    try {
      const [pRes, dRes] = await Promise.all([
        supabaseClient
          .from("dsr_petrol")
          .select("date, petrol_rate, created_at")
          .gte("date", start)
          .lte("date", end)
          .order("created_at", { ascending: false }),
        supabaseClient
          .from("dsr_diesel")
          .select("date, diesel_rate, created_at")
          .gte("date", start)
          .lte("date", end)
          .order("created_at", { ascending: false }),
      ]);
      const seenPetrol = new Set();
      const seenDiesel = new Set();
      (pRes.data || []).forEach((r) => {
        if (seenPetrol.has(r.date)) return;
        seenPetrol.add(r.date);
        const cur = map.get(r.date) || {};
        cur.petrol = Number(r.petrol_rate) || 0;
        map.set(r.date, cur);
      });
      (dRes.data || []).forEach((r) => {
        if (seenDiesel.has(r.date)) return;
        seenDiesel.add(r.date);
        const cur = map.get(r.date) || {};
        cur.diesel = Number(r.diesel_rate) || 0;
        map.set(r.date, cur);
      });
    } catch (err) {
      AppError.report(err, { context: "DsrSalesBreakdown.loadRates" });
    }
    return map;
  }

  function dailyPumpFallbackRows(dailyPump, skipKeys) {
    return (dailyPump || [])
      .flatMap((r) => {
        const date = r.date;
        const fuel = r.product;
        const out = [];
        for (const pumpNo of [1, 2]) {
          const key = `${date}|${fuel}|${pumpNo}`;
          if (skipKeys.has(key)) continue;
          const litres = pumpNo === 1 ? r.sales_pump1 : r.sales_pump2;
          out.push({
            reading_date: date,
            product: fuel,
            pump_no: pumpNo,
            litres: Number(litres) || 0,
            net_litres: null,
            from_daily: true,
          });
        }
        return out;
      });
  }

  function renderPump(rows, dailyPump) {
    const host = el("dsr-breakdown-body");
    if (!host) return;

    const shiftRows = rows || [];
    const shiftKeys = new Set(
      shiftRows.map((r) => `${r.reading_date}|${r.product}|${r.pump_no}`)
    );
    const merged = [
      ...shiftRows,
      ...dailyPumpFallbackRows(dailyPump, shiftKeys),
    ].sort((a, b) => {
      const d = String(b.reading_date).localeCompare(String(a.reading_date));
      if (d) return d;
      const p = String(a.product).localeCompare(String(b.product));
      if (p) return p;
      return (a.pump_no || 0) - (b.pump_no || 0);
    });

    if (!merged.length) {
      host.innerHTML =
        '<p class="muted">No pump sales for this period. Enter meters under <a href="meter-reading.html">Meter Reading</a> or assign nozzles in <a href="meter-reading.html#shift-readings">Shift register</a>.</p>';
      return;
    }

    const body = merged
      .map(
        (r) => `<tr>
            <td>${escapeHtml(formatDisplayDate?.(r.reading_date) || r.reading_date)}</td>
            <td>${PRODUCT_LABEL[r.product] || r.product}</td>
            <td>Pump ${r.pump_no}${r.from_daily ? ' <span class="muted">(daily)</span>' : ""}</td>
            <td class="num">${formatQuantity(r.litres)}</td>
            <td class="num">${r.net_litres == null ? "—" : formatQuantity(r.net_litres)}</td>
          </tr>`
      )
      .join("");

    host.innerHTML = `
      <div class="table-scroll">
        <table class="dsr-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Fuel</th>
              <th>Pump</th>
              <th>Sale (L)</th>
              <th>Net (L)</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="muted margin-top">Shift nozzle totals when available; days without shift data fall back to daily P1/P2 from the MS/HSD register.</p>`;
  }

  function renderShift(rows) {
    const host = el("dsr-breakdown-body");
    if (!host) return;
    if (!rows?.length) {
      host.innerHTML =
        '<p class="muted">No shift sales yet. Enter data under <a href="meter-reading.html#shift-readings">Meter Reading → Shift register</a>.</p>';
      return;
    }
    const body = rows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date) || r.reading_date)}</td>
          <td>${escapeHtml(shiftLabel(r.shift))}</td>
          <td>${PRODUCT_LABEL[r.product] || r.product}</td>
          <td class="num">${formatQuantity(r.litres)}</td>
          <td class="num">${formatQuantity(r.net_litres)}</td>
          <td class="num">${r.staff_count ?? "—"}</td>
        </tr>`
      )
      .join("");
    host.innerHTML = `
      <div class="table-scroll">
        <table class="dsr-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Fuel</th>
              <th>Sale (L)</th>
              <th>Net (L)</th>
              <th>Staff</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  function renderSalesman(rows, ratesByDate) {
    const host = el("dsr-breakdown-body");
    if (!host) return;
    if (!rows?.length) {
      host.innerHTML =
        '<p class="muted">No salesman sales yet. Assign staff on nozzles in <a href="meter-reading.html#shift-readings">Shift register</a>.</p>';
      return;
    }

    const body = rows
      .map((r) => {
        const rates = ratesByDate?.get(r.reading_date) || {};
        // Net litres (after testing) — matches shift register expected cash
        const petrolNet =
          r.petrol_net_litres != null
            ? Number(r.petrol_net_litres)
            : Number(r.petrol_litres) || 0;
        const dieselNet =
          r.diesel_net_litres != null
            ? Number(r.diesel_net_litres)
            : Number(r.diesel_litres) || 0;
        const expected =
          petrolNet * (rates.petrol || 0) + dieselNet * (rates.diesel || 0);
        const collected = Number(r.cash_collected) || 0;
        const short = rates.petrol || rates.diesel ? expected - collected : null;
        const shortClass =
          short == null
            ? ""
            : short > 0.5
              ? "dsr-short--shortage"
              : short < -0.5
                ? "dsr-short--surplus"
                : "dsr-short--balanced";
        return `<tr>
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date) || r.reading_date)}</td>
          <td>${escapeHtml(shiftLabel(r.shift))}</td>
          <td>${escapeHtml(r.employee_name || "Staff")}</td>
          <td class="num">${formatQuantity(r.petrol_litres)}</td>
          <td class="num">${formatQuantity(r.diesel_litres)}</td>
          <td class="num">${formatQuantity(r.total_litres)}</td>
          <td class="num">${short == null ? "—" : formatCurrency(expected)}</td>
          <td class="num">${formatCurrency(collected)}</td>
          <td class="num ${shortClass}">${short == null ? "—" : formatCurrency(short)}</td>
        </tr>`;
      })
      .join("");

    host.innerHTML = `
      <div class="table-scroll">
        <table class="dsr-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Salesman</th>
              <th>MS (L)</th>
              <th>HSD (L)</th>
              <th>Total (L)</th>
              <th>Expected ₹</th>
              <th>Cash ₹</th>
              <th>Short ₹</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="muted margin-top">Expected ₹ uses net litres (sale − testing) × that day’s selling rates from the MS/HSD sheets.</p>`;
  }

  function renderView(view) {
    if (!lastData) {
      el("dsr-breakdown-body").innerHTML = '<p class="muted">Select a date range to load.</p>';
      return;
    }
    if (view === "pump") renderPump(lastData.by_pump || [], lastData.daily_pump || []);
    else if (view === "shift") renderShift(lastData.by_shift || []);
    else renderSalesman(lastData.by_salesman || [], lastRates);
  }

  function updateReportsLink(start, end, view) {
    const link = el("dsr-breakdown-reports-link");
    if (!link) return;
    const tab =
      view === "pump" ? "pump-sales" : view === "shift" ? "shift-sales" : "salesman-sales";
    link.href = `reports.html?tab=${tab}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  }

  async function loadForRange(start, end, section, { force = false } = {}) {
    const view = VIEW_BY_SECTION[section] || "pump";
    if (!start || !end) return;

    const rangeKey = `${start}|${end}`;
    const gen = ++loadGen;
    showError("");
    updateReportsLink(start, end, view);

    if (!force && lastData && lastRangeKey === rangeKey) {
      renderView(view);
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabaseClient.rpc("get_meter_sales_breakdown", {
        p_start: start,
        p_end: end,
      });
      if (error) throw error;
      if (gen !== loadGen) return;

      lastData = data || {};
      lastRangeKey = rangeKey;
      lastRates = await loadRatesMap(start, end);
      if (gen !== loadGen) return;
      renderView(view);
    } catch (err) {
      AppError.report(err, { context: "DsrSalesBreakdown.loadForRange" });
      showError(err.message || "Could not load sales detail.");
      lastData = null;
      lastRangeKey = "";
      const body = el("dsr-breakdown-body");
      if (body) body.innerHTML = "";
    } finally {
      setLoading(false);
    }
  }

  function invalidate() {
    lastData = null;
    lastRangeKey = "";
    lastRates = null;
  }

  function isBreakdownSection(section) {
    return Boolean(VIEW_BY_SECTION[section]);
  }

  global.DsrSalesBreakdown = {
    loadForRange,
    invalidate,
    isBreakdownSection,
    VIEW_BY_SECTION,
  };
})(typeof window !== "undefined" ? window : globalThis);
