/**
 * DSR sales detail — staff / shift / pump with professional filter bar.
 */
/* global window.supabaseClient, AppError, escapeHtml, PumpSettings, formatQuantity, formatDisplayDate, formatFuelBadge */

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
  let lastView = "salesman";
  let loadGen = 0;
  let filtersBound = false;

  const filters = {
    shift: "",
    staff: "",
    short: "",
    pump: "",
  };

  function el(id) {
    return document.getElementById(id);
  }

  function shiftLabel(key) {
    const cfg = PumpSettings.getShiftConfig?.() || {};
    if (key === "morning") return cfg.morningName || "Morning";
    if (key === "afternoon") return cfg.afternoonName || "Afternoon";
    return key || "—";
  }

  function money(value) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
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

  function readFiltersFromDom() {
    filters.shift = el("dsr-filter-shift")?.value || "";
    filters.staff = el("dsr-filter-staff")?.value || "";
    filters.short = el("dsr-filter-short")?.value || "";
    filters.pump = el("dsr-filter-pump")?.value || "";
  }

  function syncFilterVisibility(view) {
    el("dsr-filter-staff-wrap")?.toggleAttribute("hidden", view !== "salesman");
    el("dsr-filter-short-wrap")?.toggleAttribute("hidden", view !== "salesman");
    el("dsr-filter-pump-wrap")?.toggleAttribute("hidden", view !== "pump");
  }

  function syncShiftOptionLabels() {
    const sel = el("dsr-filter-shift");
    if (!sel) return;
    const morning = sel.querySelector('option[value="morning"]');
    const afternoon = sel.querySelector('option[value="afternoon"]');
    if (morning) morning.textContent = shiftLabel("morning");
    if (afternoon) afternoon.textContent = shiftLabel("afternoon");
  }

  function populateStaffOptions(rows) {
    const sel = el("dsr-filter-staff");
    if (!sel) return;
    const prev = filters.staff || sel.value || "";
    const names = new Map();
    (rows || []).forEach((r) => {
      const id = r.employee_id != null ? String(r.employee_id) : "";
      if (!id) return;
      names.set(id, r.employee_name || "Staff");
    });
    const opts = [`<option value="">All staff</option>`];
    [...names.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }))
      .forEach(([id, name]) => {
        opts.push(`<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`);
      });
    sel.innerHTML = opts.join("");
    if (prev && names.has(prev)) {
      sel.value = prev;
      filters.staff = prev;
    } else {
      sel.value = "";
      filters.staff = "";
    }
  }

  function setMeta(html) {
    const meta = el("dsr-breakdown-meta");
    if (!meta) return;
    if (!html) {
      meta.hidden = true;
      meta.innerHTML = "";
      return;
    }
    meta.hidden = false;
    meta.innerHTML = html;
  }

  function emptyHtml(title, hint) {
    setMeta("");
    return `<div class="dsr-breakdown-empty">
      <p class="dsr-breakdown-empty-title">${escapeHtml(title)}</p>
      <p class="muted">${hint}</p>
    </div>`;
  }

  function salesmanShort(r, ratesByDate) {
    const rates = ratesByDate?.get(r.reading_date) || {};
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
    const cash = Number(r.cash_collected) || 0;
    const phonePay = Number(r.phone_pay) || 0;
    const credit = Number(r.credit_amount) || 0;
    const expense = Number(r.expense_amount) || 0;
    const collected =
      r.total_collected != null
        ? Number(r.total_collected) || 0
        : cash + phonePay + credit + expense;
    const hasRates = Boolean(rates.petrol || rates.diesel);
    const short = hasRates ? expected - collected : null;
    let kind = "";
    if (short != null) {
      if (short > 0.5) kind = "shortage";
      else if (short < -0.5) kind = "surplus";
      else kind = "ok";
    }
    return { cash, phonePay, credit, expense, collected, short, kind, hasRates };
  }

  function dailyPumpFallbackRows(dailyPump, skipKeys) {
    return (dailyPump || []).flatMap((r) => {
      const date = r.date;
      const fuel = r.product;
      const out = [];
      for (const pumpNo of [1, 2]) {
        const key = `${date}|${fuel}|${pumpNo}`;
        if (skipKeys.has(key)) continue;
        const litres = pumpNo === 1 ? r.sales_pump1 : r.sales_pump2;
        out.push({
          reading_date: date,
          shift: null,
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

  function mergePumpRows(rows, dailyPump) {
    const shiftRows = rows || [];
    const shiftKeys = new Set(
      shiftRows.map((r) => `${r.reading_date}|${r.product}|${r.pump_no}`)
    );
    return [...shiftRows, ...dailyPumpFallbackRows(dailyPump, shiftKeys)].sort((a, b) => {
      const d = String(b.reading_date).localeCompare(String(a.reading_date));
      if (d) return d;
      const s = String(a.shift || "").localeCompare(String(b.shift || ""));
      if (s) return s;
      const p = String(a.product).localeCompare(String(b.product));
      if (p) return p;
      return (a.pump_no || 0) - (b.pump_no || 0);
    });
  }

  function filterPumpRows(merged) {
    return merged.filter((r) => {
      if (filters.shift && (r.from_daily || r.shift !== filters.shift)) return false;
      if (filters.pump && String(r.pump_no) !== filters.pump) return false;
      return true;
    });
  }

  function filterShiftRows(rows) {
    return (rows || []).filter((r) => !filters.shift || r.shift === filters.shift);
  }

  function filterSalesmanRows(rows, ratesByDate) {
    return (rows || []).filter((r) => {
      if (filters.shift && r.shift !== filters.shift) return false;
      if (filters.staff && String(r.employee_id) !== filters.staff) return false;
      if (filters.short) {
        const { kind } = salesmanShort(r, ratesByDate);
        if (kind !== filters.short) return false;
      }
      return true;
    });
  }

  function metaPill(label, value, mod) {
    return `<span class="dsr-sd-pill${mod ? ` dsr-sd-pill--${mod}` : ""}"><span class="dsr-sd-pill-label">${escapeHtml(label)}</span><strong>${value}</strong></span>`;
  }

  function renderPump(rows, dailyPump) {
    const host = el("dsr-breakdown-body");
    if (!host) return;

    const merged = mergePumpRows(rows, dailyPump);
    if (!merged.length) {
      host.innerHTML = emptyHtml("No pump sales", 'Add meters in <a href="meter-reading.html">Meter Reading</a>.');
      return;
    }

    const filtered = filterPumpRows(merged);
    if (!filtered.length) {
      host.innerHTML = emptyHtml("No matching rows", "Change Shift or Pump, or widen the dates.");
      return;
    }

    let totalSale = 0;
    const body = filtered
      .map((r) => {
        totalSale += Number(r.litres) || 0;
        return `<tr>
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date) || r.reading_date)}</td>
          <td>${r.from_daily ? '<span class="muted">Daily</span>' : escapeHtml(shiftLabel(r.shift))}</td>
          <td>${formatFuelBadge(PRODUCT_LABEL[r.product] || r.product)}</td>
          <td>P${r.pump_no}</td>
          <td class="num">${formatQuantity(r.litres)}</td>
        </tr>`;
      })
      .join("");

    setMeta(
      [
        metaPill("Rows", String(filtered.length)),
        metaPill("Sale", `${formatQuantity(totalSale)} L`, "accent"),
      ].join("")
    );

    host.innerHTML = `
      <div class="table-scroll dsr-sd-table-wrap">
        <table class="dsr-sd-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Fuel</th>
              <th>Pump</th>
              <th class="num">Sale (L)</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td colspan="4">Period total</td>
              <td class="num">${formatQuantity(totalSale)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  function renderShift(rows) {
    const host = el("dsr-breakdown-body");
    if (!host) return;
    if (!rows?.length) {
      host.innerHTML = emptyHtml(
        "No shift sales",
        'Enter data in <a href="meter-reading.html#shift-readings">Shift register</a>.'
      );
      return;
    }

    const filtered = filterShiftRows(rows);
    if (!filtered.length) {
      host.innerHTML = emptyHtml("No matching rows", "Change Shift, or widen the dates.");
      return;
    }

    let totalSale = 0;
    const body = filtered
      .map((r) => {
        totalSale += Number(r.litres) || 0;
        return `<tr>
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date) || r.reading_date)}</td>
          <td>${escapeHtml(shiftLabel(r.shift))}</td>
          <td>${formatFuelBadge(PRODUCT_LABEL[r.product] || r.product)}</td>
          <td class="num">${formatQuantity(r.litres)}</td>
          <td class="num">${r.staff_count ?? "—"}</td>
        </tr>`;
      })
      .join("");

    setMeta(
      [
        metaPill("Rows", String(filtered.length)),
        metaPill("Sale", `${formatQuantity(totalSale)} L`, "accent"),
      ].join("")
    );

    host.innerHTML = `
      <div class="table-scroll dsr-sd-table-wrap">
        <table class="dsr-sd-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Fuel</th>
              <th class="num">Sale (L)</th>
              <th class="num">Staff</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Period total</td>
              <td class="num">${formatQuantity(totalSale)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  function renderSalesman(rows, ratesByDate) {
    const host = el("dsr-breakdown-body");
    if (!host) return;
    if (!rows?.length) {
      host.innerHTML = emptyHtml(
        "No staff sales",
        'Assign staff in <a href="meter-reading.html#shift-readings">Shift register</a>.'
      );
      return;
    }

    const filtered = filterSalesmanRows(rows, ratesByDate);
    if (!filtered.length) {
      host.innerHTML = emptyHtml(
        "No matching rows",
        "Clear filters, or widen the date range."
      );
      return;
    }

    let sumMs = 0;
    let sumHsd = 0;
    let sumCash = 0;
    let sumPhone = 0;
    let sumCredit = 0;
    let sumExpense = 0;
    let sumShort = 0;
    let shortCount = 0;
    let shortageRows = 0;

    const body = filtered
      .map((r) => {
        const m = salesmanShort(r, ratesByDate);
        const ms = Number(r.petrol_litres) || 0;
        const hsd = Number(r.diesel_litres) || 0;
        sumMs += ms;
        sumHsd += hsd;
        sumCash += m.cash;
        sumPhone += m.phonePay;
        sumCredit += m.credit;
        sumExpense += m.expense;
        if (m.kind === "shortage") shortageRows += 1;
        if (m.short != null) {
          sumShort += m.short;
          shortCount += 1;
        }
        const shortClass =
          m.kind === "shortage"
            ? "dsr-short--shortage"
            : m.kind === "surplus"
              ? "dsr-short--surplus"
              : "";
        return `<tr class="${m.kind === "shortage" ? "dsr-row--shortage" : ""}">
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date) || r.reading_date)}</td>
          <td>${escapeHtml(shiftLabel(r.shift))}</td>
          <td class="dsr-staff-name">${escapeHtml(r.employee_name || "Staff")}</td>
          <td class="num">${formatQuantity(ms)}</td>
          <td class="num">${formatQuantity(hsd)}</td>
          <td class="num">${money(m.cash)}</td>
          <td class="num">${money(m.phonePay)}</td>
          <td class="num">${money(m.credit)}</td>
          <td class="num">${money(m.expense)}</td>
          <td class="num ${shortClass}">${m.short == null ? "—" : money(m.short)}</td>
        </tr>`;
      })
      .join("");

    setMeta(
      [
        metaPill("Rows", String(filtered.length)),
        metaPill("MS", `${formatQuantity(sumMs)} L`, "petrol"),
        metaPill("HSD", `${formatQuantity(sumHsd)} L`, "diesel"),
        metaPill("Short", shortCount ? `₹${money(sumShort)}` : "—", shortageRows ? "danger" : ""),
      ].join("")
    );

    host.innerHTML = `
      <div class="table-scroll dsr-sd-table-wrap">
        <table class="dsr-sd-table dsr-breakdown-table dsr-staff-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Staff</th>
              <th class="num">MS (L)</th>
              <th class="num">HSD (L)</th>
              <th class="num">Cash ₹</th>
              <th class="num">Phone ₹</th>
              <th class="num">Credit ₹</th>
              <th class="num">Exp ₹</th>
              <th class="num">Short ₹</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Period total</td>
              <td class="num">${formatQuantity(sumMs)}</td>
              <td class="num">${formatQuantity(sumHsd)}</td>
              <td class="num">${money(sumCash)}</td>
              <td class="num">${money(sumPhone)}</td>
              <td class="num">${money(sumCredit)}</td>
              <td class="num">${money(sumExpense)}</td>
              <td class="num">${shortCount ? money(sumShort) : "—"}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  function renderView(view) {
    lastView = view || lastView;
    syncShiftOptionLabels();
    syncFilterVisibility(lastView);
    readFiltersFromDom();

    if (!lastData) {
      setMeta("");
      const host = el("dsr-breakdown-body");
      if (host) host.innerHTML = '<p class="muted">Select a date range above.</p>';
      return;
    }

    populateStaffOptions(lastData.by_salesman || []);

    if (lastView === "pump") renderPump(lastData.by_pump || [], lastData.daily_pump || []);
    else if (lastView === "shift") renderShift(lastData.by_shift || []);
    else renderSalesman(lastData.by_salesman || [], lastRates);
  }

  function bindFilters() {
    if (filtersBound) return;
    filtersBound = true;
    ["dsr-filter-shift", "dsr-filter-staff", "dsr-filter-short", "dsr-filter-pump"].forEach((id) => {
      el(id)?.addEventListener("change", () => renderView(lastView));
    });
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

  function updateReportsLink(start, end, view) {
    const link = el("dsr-breakdown-reports-link");
    if (!link) return;
    const tab =
      view === "pump" ? "pump-sales" : view === "shift" ? "shift-sales" : "salesman-sales";
    link.href = `reports.html?tab=${tab}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  }

  async function loadForRange(start, end, section, { force = false } = {}) {
    const view = VIEW_BY_SECTION[section] || "salesman";
    if (!start || !end) return;
    bindFilters();

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
      const { data, error } = await window.supabaseClient.rpc("get_meter_sales_breakdown", {
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
      setMeta("");
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
