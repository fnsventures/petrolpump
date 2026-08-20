/**
 * Shift-wise meter readings with staff attribution and cash short.
 * Optional enrichment alongside daily MS/HSD DSR forms (unchanged).
 */
/* global supabaseClient, AppError, escapeHtml, PumpSettings, StaffEmployees, formatQuantity, formatCurrency, formatDisplayDate, initPersistedDateInput, RECORD_DATE_KEYS, AdminDelete, debounce, getLocalDateString, toLocalDateString, CacheInvalidation, DsrSalesBreakdown, MeterReadingForms */

(function (global) {
  const PRODUCTS = ["petrol", "diesel"];
  const PRODUCT_LABEL = { petrol: "MS", diesel: "HSD" };

  let isAdmin = false;
  let staffList = [];
  let loadGeneration = 0;
  let cashByEmployee = new Map();
  let initialized = false;
  let supervisorReadonly = false;
  let lockReason = "";

  const MSG_PAST_CLOSED =
    "This shift is already saved for a past date with daily meters. Only an admin can change it.";
  const MSG_DAY_LOCKED =
    "Day closing is certified or night cash is collected. Only an admin can change meters.";

  function getShiftConfig() {
    return PumpSettings.getShiftConfig();
  }

  function shiftLabel(key) {
    const cfg = getShiftConfig();
    if (key === "morning") return cfg.morningName || "Morning shift";
    if (key === "afternoon") return cfg.afternoonName || "Afternoon shift";
    return key || "—";
  }

  function pumpConfig() {
    const pumps = PumpSettings.getPumpConfig?.() || {};
    return {
      petrol: {
        pumps: Number(pumps.petrol?.pumps) || 2,
        nozzlesPerPump: Number(pumps.petrol?.nozzlesPerPump) || 2,
      },
      diesel: {
        pumps: Number(pumps.diesel?.pumps) || 2,
        nozzlesPerPump: Number(pumps.diesel?.nozzlesPerPump) || 2,
      },
    };
  }

  function nozzleSlots(product) {
    const cfg = pumpConfig()[product];
    const slots = [];
    for (let p = 1; p <= cfg.pumps; p++) {
      for (let n = 1; n <= cfg.nozzlesPerPump; n++) {
        slots.push({ product, pump_no: p, nozzle_no: n, label: `P${p} · N${n}` });
      }
    }
    return slots;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function parseNum(raw) {
    if (raw == null || raw === "") return 0;
    const n = Number(String(raw).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }

  function formatMeterInput(n) {
    if (n == null || n === "" || Number.isNaN(Number(n))) return "";
    const num = Number(n);
    return Number.isInteger(num) ? String(num) : String(num);
  }

  function staffOptionsHtml(selectedId) {
    const opts = ['<option value="">— Unassigned —</option>'];
    for (const s of staffList) {
      const sel = s.id === selectedId ? " selected" : "";
      opts.push(
        `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(s.name || "Staff")}</option>`
      );
    }
    return opts.join("");
  }

  function parseRateValue(raw) {
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async function fetchLastDsrRate(product) {
    const table = product === "diesel" ? "dsr_diesel" : "dsr_petrol";
    const rateField = product === "diesel" ? "diesel_rate" : "petrol_rate";
    try {
      const { data, error } = await supabaseClient
        .from(table)
        .select(rateField)
        .not(rateField, "is", null)
        .order("date", { ascending: false })
        .limit(15);
      if (error) throw error;
      for (const row of data || []) {
        const n = parseRateValue(row[rateField]);
        if (n != null) return n;
      }
    } catch (err) {
      AppError.report(err, { context: "MeterShiftReading.fetchLastDsrRate", product });
    }
    return null;
  }

  /**
   * Prefer same-day daily rates; otherwise last entered selling rate so expected ₹ shows by default.
   */
  async function applyShiftRates(rpcRates) {
    const ratePetrol = el("shift-meter-rate-petrol");
    const rateDiesel = el("shift-meter-rate-diesel");
    if (!ratePetrol && !rateDiesel) return { petrol: null, diesel: null, fromFallback: false };

    let petrol = parseRateValue(rpcRates?.petrol);
    let diesel = parseRateValue(rpcRates?.diesel);
    let fromFallback = false;

    const needPetrol = petrol == null;
    const needDiesel = diesel == null;
    if (needPetrol || needDiesel) {
      const [lastPetrol, lastDiesel] = await Promise.all([
        needPetrol ? fetchLastDsrRate("petrol") : Promise.resolve(null),
        needDiesel ? fetchLastDsrRate("diesel") : Promise.resolve(null),
      ]);
      if (needPetrol && lastPetrol != null) {
        petrol = lastPetrol;
        fromFallback = true;
      }
      if (needDiesel && lastDiesel != null) {
        diesel = lastDiesel;
        fromFallback = true;
      }
    }

    if (ratePetrol) ratePetrol.value = petrol != null ? formatMeterInput(petrol) : "";
    if (rateDiesel) rateDiesel.value = diesel != null ? formatMeterInput(diesel) : "";

    return { petrol, diesel, fromFallback };
  }

  function showMsg(text, isError) {
    const ok = el("shift-meter-success");
    const err = el("shift-meter-error");
    if (ok) {
      ok.textContent = isError ? "" : text || "";
      ok.classList.toggle("hidden", isError || !text);
    }
    if (err) {
      err.textContent = isError ? text || "" : "";
      err.classList.toggle("hidden", !isError || !text);
      err.classList.toggle(
        "dsr-meter-locked-msg",
        Boolean(isError && text && supervisorReadonly)
      );
    }
  }

  async function fetchLockInfo(date, shift) {
    try {
      const { data, error } = await supabaseClient.rpc("meter_shift_lock_info", {
        p_date: date,
        p_shift: shift || null,
      });
      if (error) throw error;
      return data || null;
    } catch (err) {
      AppError.report(err, { context: "MeterShiftReading.fetchLockInfo" });
      return null;
    }
  }

  function shiftHasSavedNozzles(data) {
    return Array.isArray(data?.nozzles) && data.nozzles.length > 0;
  }

  function isCompletedDailyHint(data) {
    // Soft fallback only — stubs (meters only) are NOT complete
    const check = (t, rateKey) => {
      if (!t?.has_row) return false;
      // daily_totals from RPC does not expose rate/dip; never treat has_row alone as complete
      return false;
    };
    return check(data?.daily_totals?.petrol, "petrol") || check(data?.daily_totals?.diesel, "diesel");
  }

  async function resolveSupervisorLock(date, shift, data) {
    if (isAdmin) return { locked: false, reason: "" };
    const lockInfo = await fetchLockInfo(date, shift);
    if (lockInfo) {
      if (lockInfo.supervisor_readonly) {
        return {
          locked: true,
          reason:
            lockInfo.lock_reason ||
            (lockInfo.day_locked ? MSG_DAY_LOCKED : MSG_PAST_CLOSED),
        };
      }
      return { locked: false, reason: "" };
    }

    // Fallback if RPC missing: only lock certified-like cases we can't know —
    // never lock an empty afternoon just because morning/daily exists.
    const today = getLocalDateString();
    if (date && today && date < today && shiftHasSavedNozzles(data) && isCompletedDailyHint(data)) {
      return { locked: true, reason: MSG_PAST_CLOSED };
    }
    return { locked: false, reason: "" };
  }

  function applyOpeningFieldAccess() {
    // Supervisors cannot edit openings (handoff / prior-day chain). Admins can.
    document.querySelectorAll("#shift-meter-nozzle-tables .shift-opening").forEach((input) => {
      const lockOpenings = !isAdmin || supervisorReadonly;
      input.readOnly = lockOpenings;
      input.disabled = false; // keep value submitted / readable; readonly is enough
      input.classList.toggle("shift-opening--locked", lockOpenings);
      input.title = lockOpenings
        ? isAdmin
          ? lockReason || ""
          : "Opening comes from the prior shift / day and cannot be edited"
        : "";
    });
  }

  function applySupervisorLockUi(locked, reason) {
    supervisorReadonly = Boolean(locked) && !isAdmin;
    lockReason = supervisorReadonly ? reason || MSG_PAST_CLOSED : "";

    const panel = el("shift-readings") || document.querySelector('[data-panel="shift-readings"]');
    panel?.classList.toggle("shift-register-supervisor-locked", supervisorReadonly);

    const banner = el("shift-meter-locked-banner");
    if (banner) {
      banner.textContent = lockReason;
      banner.classList.toggle("hidden", !supervisorReadonly);
    }

    const editZone = el("shift-meter-edit-zone");
    if (editZone) {
      if (supervisorReadonly) editZone.setAttribute("inert", "");
      else editZone.removeAttribute("inert");
      editZone.setAttribute("aria-disabled", supervisorReadonly ? "true" : "false");
    }

    const saveBtn = el("shift-meter-save");
    const copyBtn = el("shift-meter-copy-openings");
    if (saveBtn) {
      saveBtn.disabled = supervisorReadonly;
      saveBtn.title = supervisorReadonly ? lockReason : "";
      saveBtn.setAttribute("aria-disabled", supervisorReadonly ? "true" : "false");
    }
    if (copyBtn) {
      // Supervisors may still copy openings into the locked opening fields
      copyBtn.disabled = supervisorReadonly;
      copyBtn.title = supervisorReadonly
        ? lockReason
        : isAdmin
          ? "Copy openings from prior shift / daily"
          : "Fill openings from prior shift / daily (openings stay locked after fill)";
    }

    const ratePetrol = el("shift-meter-rate-petrol");
    const rateDiesel = el("shift-meter-rate-diesel");
    if (ratePetrol) {
      ratePetrol.readOnly = supervisorReadonly;
      ratePetrol.disabled = supervisorReadonly;
    }
    if (rateDiesel) {
      rateDiesel.readOnly = supervisorReadonly;
      rateDiesel.disabled = supervisorReadonly;
    }

    document
      .querySelectorAll(
        "#shift-meter-nozzle-tables select, #shift-meter-nozzle-tables input, #shift-meter-staff-body select, #shift-meter-staff-body input"
      )
      .forEach((node) => {
        if (node.classList.contains("calc-field") || node.classList.contains("shift-sale")) {
          node.readOnly = true;
          return;
        }
        if (node.classList.contains("shift-opening")) {
          return; // handled by applyOpeningFieldAccess
        }
        if (node.tagName === "SELECT") {
          node.disabled = supervisorReadonly;
          return;
        }
        node.readOnly = supervisorReadonly;
        node.disabled = supervisorReadonly;
      });

    applyOpeningFieldAccess();
  }

  function nozzleKey(product, pump, nozzle) {
    return `${product}:${pump}:${nozzle}`;
  }

  function readNozzleRowsFromDom() {
    const rows = [];
    document.querySelectorAll("#shift-meter-nozzle-tables tbody tr[data-product]").forEach((tr) => {
      const product = tr.dataset.product;
      const pump_no = Number(tr.dataset.pump);
      const nozzle_no = Number(tr.dataset.nozzle);
      const employee_id = tr.querySelector(".shift-staff")?.value || "";
      const opening_meter = parseNum(tr.querySelector(".shift-opening")?.value);
      const closing_meter = parseNum(tr.querySelector(".shift-closing")?.value);
      const testing_litres = parseNum(tr.querySelector(".shift-testing")?.value);
      rows.push({
        product,
        pump_no,
        nozzle_no,
        employee_id,
        opening_meter,
        closing_meter,
        testing_litres,
      });
    });
    return rows;
  }

  function computeStaffSummary(nozzleRows, rates) {
    const byEmp = new Map();
    for (const row of nozzleRows) {
      if (!row.employee_id) continue;
      const gross = Math.max(row.closing_meter - row.opening_meter, 0);
      const net = Math.max(gross - row.testing_litres, 0);
      let agg = byEmp.get(row.employee_id);
      if (!agg) {
        const staff = staffList.find((s) => s.id === row.employee_id);
        agg = {
          employee_id: row.employee_id,
          name: staff?.name || "Staff",
          petrol_litres: 0,
          diesel_litres: 0,
          petrol_net: 0,
          diesel_net: 0,
          meters: [],
        };
        byEmp.set(row.employee_id, agg);
      }
      if (row.product === "petrol") {
        agg.petrol_litres += gross;
        agg.petrol_net += net;
      } else {
        agg.diesel_litres += gross;
        agg.diesel_net += net;
      }
      agg.meters.push(`P${row.pump_no}·N${row.nozzle_no}`);
    }

    const petrolRate = rates?.petrol != null ? Number(rates.petrol) : null;
    const dieselRate = rates?.diesel != null ? Number(rates.diesel) : null;

    return Array.from(byEmp.values()).map((agg) => {
      let expected = null;
      if (petrolRate != null || dieselRate != null) {
        expected =
          (petrolRate != null ? agg.petrol_net * petrolRate : 0) +
          (dieselRate != null ? agg.diesel_net * dieselRate : 0);
      }
      const collected = cashByEmployee.has(agg.employee_id)
        ? cashByEmployee.get(agg.employee_id)
        : 0;
      const short =
        expected != null ? expected - collected : null;
      return { ...agg, expected, collected, short };
    });
  }

  function updateDerivedUi() {
    const rates = {
      petrol: parseNum(el("shift-meter-rate-petrol")?.value) || null,
      diesel: parseNum(el("shift-meter-rate-diesel")?.value) || null,
    };
    // Prefer explicit rate inputs; empty → treat as null for expected calc
    if (!el("shift-meter-rate-petrol")?.value) rates.petrol = null;
    if (!el("shift-meter-rate-diesel")?.value) rates.diesel = null;

    document.querySelectorAll("#shift-meter-nozzle-tables tbody tr[data-product]").forEach((tr) => {
      const opening = parseNum(tr.querySelector(".shift-opening")?.value);
      const closing = parseNum(tr.querySelector(".shift-closing")?.value);
      const testing = parseNum(tr.querySelector(".shift-testing")?.value);
      const sale = Math.max(closing - opening, 0);
      const saleEl = tr.querySelector(".shift-sale");
      if (saleEl) saleEl.value = sale ? formatQuantity(sale) : "";
      tr.classList.toggle("shift-row--warn", closing < opening);
      tr.classList.toggle("shift-row--assigned", Boolean(tr.querySelector(".shift-staff")?.value));
    });

    // Sync cash map from summary inputs if present
    document.querySelectorAll("#shift-meter-staff-body .shift-cash-collected").forEach((input) => {
      const empId = input.dataset.employeeId;
      if (empId) cashByEmployee.set(empId, parseNum(input.value));
    });

    const nozzleRows = readNozzleRowsFromDom();
    const summary = computeStaffSummary(nozzleRows, rates);
    renderStaffSummary(summary, rates);
    renderReconcile(nozzleRows);
    renderShiftTotals(summary, nozzleRows);

    // Staff summary rebuilds inputs — keep supervisor lock applied
    if (supervisorReadonly) {
      applySupervisorLockUi(true, lockReason);
    }
  }

  const debouncedDerived = typeof debounce === "function" ? debounce(updateDerivedUi, 120) : updateDerivedUi;

  function renderStaffSummary(summary, rates) {
    const tbody = el("shift-meter-staff-body");
    if (!tbody) return;

    if (!summary.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="muted">Assign staff to nozzles above to see litres and short.</td></tr>';
      return;
    }

    const rateHint =
      rates.petrol == null && rates.diesel == null
        ? '<p class="muted shift-rate-hint">Enter selling rates to compute expected ₹ and short.</p>'
        : el("shift-meter-reconcile")?.dataset.rateFallback === "1"
          ? '<p class="muted shift-rate-hint">Rates prefilled from the last entered daily sheet. Adjust if today’s price differs.</p>'
          : "";

    const hintHost = el("shift-meter-staff-hint");
    if (hintHost) hintHost.innerHTML = rateHint;

    tbody.innerHTML = summary
      .map((s) => {
        const shortClass =
          s.short == null
            ? ""
            : s.short > 0.5
              ? "shift-short--shortage"
              : s.short < -0.5
                ? "shift-short--surplus"
                : "shift-short--balanced";
        const shortText =
          s.short == null
            ? "—"
            : formatCurrency(s.short);
        const expectedText = s.expected == null ? "—" : formatCurrency(s.expected);
        return `<tr data-employee-id="${escapeHtml(s.employee_id)}">
          <td class="shift-staff-name">${escapeHtml(s.name)}
            <span class="muted shift-meter-list">${escapeHtml(s.meters.join(", "))}</span>
          </td>
          <td class="num">${formatQuantity(s.petrol_litres)}</td>
          <td class="num">${formatQuantity(s.diesel_litres)}</td>
          <td class="num calc-field">${expectedText}</td>
          <td>
            <input type="text" inputmode="decimal" class="shift-cash-collected meter-reading"
              data-employee-id="${escapeHtml(s.employee_id)}"
              value="${s.collected ? formatMeterInput(s.collected) : ""}"
              placeholder="0" aria-label="Cash collected for ${escapeHtml(s.name)}" />
          </td>
          <td class="num shift-short ${shortClass}">${shortText}</td>
          <td class="muted">${s.short == null ? "—" : s.short > 0.5 ? "Short" : s.short < -0.5 ? "Surplus" : "OK"}</td>
        </tr>`;
      })
      .join("");
  }

  function renderShiftTotals(summary, nozzleRows) {
    const host = el("shift-meter-totals");
    if (!host) return;
    let petrol = 0;
    let diesel = 0;
    for (const r of nozzleRows) {
      if (!r.employee_id) continue;
      const g = Math.max(r.closing_meter - r.opening_meter, 0);
      if (r.product === "petrol") petrol += g;
      else diesel += g;
    }
    const totalShort = summary.reduce((acc, s) => acc + (s.short != null ? s.short : 0), 0);
    const hasShort = summary.some((s) => s.short != null);
    host.innerHTML = `
      <div class="shift-totals-grid">
        <div class="shift-total--petrol"><span class="muted">MS sale</span><strong>${formatQuantity(petrol)} L</strong></div>
        <div class="shift-total--diesel"><span class="muted">HSD sale</span><strong>${formatQuantity(diesel)} L</strong></div>
        <div><span class="muted">Staff on shift</span><strong>${summary.length}</strong></div>
        <div class="${hasShort ? (totalShort > 0.5 ? "shift-short--shortage" : totalShort < -0.5 ? "shift-short--surplus" : "shift-short--balanced") : ""}">
          <span class="muted">Net short</span><strong>${hasShort ? formatCurrency(totalShort) : "—"}</strong>
        </div>
      </div>`;
  }

  function renderReconcile(nozzleRows) {
    const host = el("shift-meter-reconcile");
    if (!host) return;
    const dailyPetrol = host.dataset.dailyPetrol != null ? Number(host.dataset.dailyPetrol) : null;
    const dailyDiesel = host.dataset.dailyDiesel != null ? Number(host.dataset.dailyDiesel) : null;
    const hasPetrol = host.dataset.hasPetrol === "1";
    const hasDiesel = host.dataset.hasDiesel === "1";
    const syncNote = host.dataset.syncNote || "";

    let petrolShift = 0;
    let dieselShift = 0;
    let petrolAssigned = 0;
    let dieselAssigned = 0;
    for (const r of nozzleRows) {
      const g = Math.max(r.closing_meter - r.opening_meter, 0);
      if (r.product === "petrol") {
        petrolShift += g;
        if (r.employee_id) petrolAssigned += g;
      } else {
        dieselShift += g;
        if (r.employee_id) dieselAssigned += g;
      }
    }

    const parts = [];
    parts.push(
      `<p class="muted">Saving a shift updates daily MS/HSD meter open/close and sales. Saving daily MS/HSD updates existing shift openings (and afternoon closings). Dip, receipts, and rates stay on the daily sheets. Locked (certified) days require an admin.</p>`
    );
    if (syncNote) parts.push(`<p class="success">${escapeHtml(syncNote)}</p>`);
    if (hasPetrol) {
      parts.push(
        `<p>MS daily: <strong>${formatQuantity(dailyPetrol)} L</strong> · this shift: <strong>${formatQuantity(petrolShift)} L</strong>${
          petrolAssigned !== petrolShift
            ? ` (assigned ${formatQuantity(petrolAssigned)} L)`
            : ""
        }
        · <a href="meter-reading.html#petrol">Open MS sheet</a> · <a href="dsr.html#by-salesman">Sales detail (DSR) →</a></p>`
      );
    } else {
      parts.push(
        `<p class="muted">No daily MS row yet — saving this shift will create meter fields on the daily sheet (add dip/rate after).</p>`
      );
    }
    if (hasDiesel) {
      parts.push(
        `<p>HSD daily: <strong>${formatQuantity(dailyDiesel)} L</strong> · this shift: <strong>${formatQuantity(dieselShift)} L</strong>${
          dieselAssigned !== dieselShift
            ? ` (assigned ${formatQuantity(dieselAssigned)} L)`
            : ""
        }
        · <a href="meter-reading.html#diesel">Open HSD sheet</a></p>`
      );
    } else {
      parts.push(
        `<p class="muted">No daily HSD row yet — saving this shift will create meter fields on the daily sheet.</p>`
      );
    }
    host.innerHTML = parts.join("");
  }

  function renderNozzleTables(savedNozzles, attendanceHints, suggestedOpenings, suggestedClosings) {
    const host = el("shift-meter-nozzle-tables");
    if (!host) return;

    const byKey = new Map();
    (savedNozzles || []).forEach((n) => {
      byKey.set(nozzleKey(n.product, n.pump_no, n.nozzle_no), n);
    });

    const hintIds = new Set((attendanceHints || []).map((h) => h.employee_id));
    const defaultStaff =
      hintIds.size === 1 ? Array.from(hintIds)[0] : "";

    const suggestOpen = suggestedOpenings || {};
    const suggestClose = suggestedClosings || {};

    const blocks = PRODUCTS.map((product) => {
      const slots = nozzleSlots(product);
      const rows = slots
        .map((slot) => {
          const key = nozzleKey(product, slot.pump_no, slot.nozzle_no);
          const saved = byKey.get(key);
          const empId = saved?.employee_id || defaultStaff || "";
          let opening = saved ? formatMeterInput(saved.opening_meter) : "";
          let closing = saved ? formatMeterInput(saved.closing_meter) : "";
          // Auto-fill empty openings from daily / prior shift
          if ((!opening || opening === "0") && suggestOpen[key] != null && suggestOpen[key] !== "") {
            if (!saved || Number(saved.opening_meter) === 0) {
              opening = formatMeterInput(suggestOpen[key]);
            }
          }
          // Auto-fill empty closings from daily (end of day) when suggested
          if ((!closing || closing === "0") && suggestClose[key] != null && suggestClose[key] !== "") {
            if (!saved || Number(saved.closing_meter) === 0) {
              closing = formatMeterInput(suggestClose[key]);
            }
          }
          const testing = saved && saved.testing_litres ? formatMeterInput(saved.testing_litres) : "";
          const openingReadonly = !isAdmin ? " readonly" : "";
          const openingClass = !isAdmin
            ? "shift-opening meter-reading shift-opening--locked"
            : "shift-opening meter-reading";
          return `<tr data-product="${product}" data-pump="${slot.pump_no}" data-nozzle="${slot.nozzle_no}">
            <td class="shift-meter-label">${escapeHtml(slot.label)}</td>
            <td><select class="shift-staff" aria-label="Staff for ${PRODUCT_LABEL[product]} ${slot.label}">${staffOptionsHtml(empId)}</select></td>
            <td><input type="text" inputmode="numeric" maxlength="15" class="${openingClass}" value="${escapeHtml(opening)}" placeholder="0"${openingReadonly} title="${!isAdmin ? "Opening comes from the prior shift / day and cannot be edited" : ""}" /></td>
            <td><input type="text" inputmode="numeric" maxlength="15" class="shift-closing meter-reading" value="${escapeHtml(closing)}" placeholder="0" /></td>
            <td><input type="text" readonly class="shift-sale calc-field" tabindex="-1" /></td>
            <td><input type="text" inputmode="decimal" class="shift-testing meter-reading" value="${escapeHtml(testing)}" placeholder="0" /></td>
          </tr>`;
        })
        .join("");

      return `<div class="shift-product-block shift-product-block--${product}">
        <h3 class="meter-title">${PRODUCT_LABEL[product]} nozzles</h3>
        <div class="table-scroll">
          <table class="dsr-table meter-table compact shift-nozzle-table">
            <thead>
              <tr>
                <th>Meter</th>
                <th>Staff</th>
                <th>Opening</th>
                <th>Closing</th>
                <th>Sale (L)</th>
                <th>Testing</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    });

    host.innerHTML = blocks.join("");
  }

  /**
   * Suggest end-of-day closings only when afternoon already has saved rows.
   * Never prefill a blank afternoon from daily — after morning sync, daily
   * closings equal morning closings and look like leftover values.
   */
  function buildSuggestedClosings(shift, dailyMeters, { hasSavedNozzles = false } = {}) {
    const out = {};
    if (!dailyMeters || shift !== "afternoon" || !hasSavedNozzles) return out;
    for (const product of PRODUCTS) {
      const m = dailyMeters[product];
      if (!m) continue;
      for (const slot of nozzleSlots(product)) {
        if (slot.pump_no > 2 || slot.nozzle_no > 2) continue; // daily schema is 2×2
        const val = m[`closing_pump${slot.pump_no}_nozzle${slot.nozzle_no}`];
        if (val != null && val !== "" && Number(val) !== 0) {
          out[`${product}:${slot.pump_no}:${slot.nozzle_no}`] = Number(val);
        }
      }
    }
    return out;
  }

  /** Prefer first meaningful meter value (skip null/empty; allow 0 only if nothing better later). */
  function offerOpening(map, key, raw) {
    if (raw == null || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const existing = map[key];
    if (existing == null || existing === "") {
      map[key] = n;
      return;
    }
    // Prefer non-zero over zero placeholder
    if (Number(existing) === 0 && n !== 0) map[key] = n;
  }

  function mergeDailyMeterOpenings(map, dailyMeters) {
    if (!dailyMeters) return;
    for (const product of PRODUCTS) {
      const m = dailyMeters[product];
      if (!m) continue;
      for (const slot of nozzleSlots(product)) {
        if (slot.pump_no > 2 || slot.nozzle_no > 2) continue;
        offerOpening(
          map,
          `${product}:${slot.pump_no}:${slot.nozzle_no}`,
          m[`opening_pump${slot.pump_no}_nozzle${slot.nozzle_no}`]
        );
      }
    }
  }

  function mergePriorPayload(map, prior, { includeDailyClosings = true } = {}) {
    if (!prior) return;
    (prior.from_shift || []).forEach((r) => {
      offerOpening(
        map,
        nozzleKey(r.product, r.pump_no, r.nozzle_no),
        r.closing_meter
      );
    });
    if (!includeDailyClosings) return;
    const fromDaily = prior.from_daily || {};
    for (const product of PRODUCTS) {
      const m = fromDaily[product];
      if (!m) continue;
      for (const slot of nozzleSlots(product)) {
        if (slot.pump_no > 2 || slot.nozzle_no > 2) continue;
        offerOpening(
          map,
          `${product}:${slot.pump_no}:${slot.nozzle_no}`,
          m[`closing_pump${slot.pump_no}_nozzle${slot.nozzle_no}`]
        );
      }
    }
  }

  async function fetchPrevDayDailyClosings(dateStr) {
    const map = {};
    const prev = (() => {
      const d = new Date(dateStr + "T12:00:00");
      d.setDate(d.getDate() - 1);
      return toLocalDateString(d);
    })();

    try {
      const [pRes, dRes] = await Promise.all([
        supabaseClient
          .from("dsr_petrol")
          .select(
            "closing_pump1_nozzle1, closing_pump1_nozzle2, closing_pump2_nozzle1, closing_pump2_nozzle2"
          )
          .eq("date", prev)
          .order("created_at", { ascending: false })
          .limit(1),
        supabaseClient
          .from("dsr_diesel")
          .select(
            "closing_pump1_nozzle1, closing_pump1_nozzle2, closing_pump2_nozzle1, closing_pump2_nozzle2"
          )
          .eq("date", prev)
          .order("created_at", { ascending: false })
          .limit(1),
      ]);
      if (pRes.error) throw pRes.error;
      if (dRes.error) throw dRes.error;
      const pack = {
        petrol: (pRes.data && pRes.data[0]) || null,
        diesel: (dRes.data && dRes.data[0]) || null,
      };
      for (const product of PRODUCTS) {
        const m = pack[product];
        if (!m) continue;
        for (let p = 1; p <= 2; p++) {
          for (let n = 1; n <= 2; n++) {
            offerOpening(map, `${product}:${p}:${n}`, m[`closing_pump${p}_nozzle${n}`]);
          }
        }
      }
    } catch (err) {
      AppError.report(err, { context: "MeterShiftReading.fetchPrevDayDailyClosings" });
    }
    return map;
  }

  async function fetchMorningShiftClosings(dateStr) {
    const map = {};
    try {
      const { data, error } = await supabaseClient
        .from("meter_shift_readings")
        .select("product, pump_no, nozzle_no, closing_meter")
        .eq("reading_date", dateStr)
        .eq("shift", "morning");
      if (error) throw error;
      (data || []).forEach((r) => {
        offerOpening(map, nozzleKey(r.product, r.pump_no, r.nozzle_no), r.closing_meter);
      });
    } catch (err) {
      // Table may be missing if migration not applied — ignore
      if (!/meter_shift_readings|PGRST|42P01/i.test(err.message || "")) {
        AppError.report(err, { context: "MeterShiftReading.fetchMorningShiftClosings" });
      }
    }
    return map;
  }

  /**
   * Build opening suggestions from every available source so autofill works
   * even when the enhanced RPC (suggested_openings) is not deployed yet.
   */
  async function resolveOpeningSuggestions(date, shift, data) {
    const map = {};

    // Prefer prior closings first (correct chain), then same-day daily openings.
    let prior = data?.prior || null;
    if (!prior) {
      try {
        const { data: priorData, error } = await supabaseClient.rpc("get_meter_shift_prior_closings", {
          p_date: date,
          p_shift: shift,
        });
        if (!error) prior = priorData;
      } catch (_) {
        /* optional */
      }
    }
    mergePriorPayload(map, prior, {
      // Afternoon prior.from_daily is same-day end closings — not valid as openings
      includeDailyClosings: shift === "morning",
    });

    if (shift === "afternoon") {
      const morning = await fetchMorningShiftClosings(date);
      Object.keys(morning).forEach((k) => offerOpening(map, k, morning[k]));
    }

    if (shift === "morning") {
      // Same-day daily openings (if supervisor already entered the daily sheet)
      mergeDailyMeterOpenings(map, data?.daily_meters);
      // Previous calendar day daily closings
      const prev = await fetchPrevDayDailyClosings(date);
      Object.keys(prev).forEach((k) => offerOpening(map, k, prev[k]));
    }

    // Server suggestions last as fill-in only (may be missing if migration not applied)
    const sug = data?.suggested_openings;
    if (sug && typeof sug === "object") {
      Object.keys(sug).forEach((k) => offerOpening(map, k, sug[k]));
    }

    return { openings: map, prior };
  }

  function countMeaningfulSuggestions(map) {
    return Object.values(map || {}).filter((v) => v != null && Number(v) !== 0).length;
  }

  async function loadStaff() {
    try {
      staffList = await StaffEmployees.loadActiveRoster(supabaseClient, { useCache: true });
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.loadStaff" });
      staffList = [];
    }
  }

  async function loadShift() {
    const date = el("shift-meter-date")?.value;
    const shift = el("shift-meter-shift")?.value;
    if (!date || !shift) return;

    const gen = ++loadGeneration;
    showMsg("", false);
    const loading = el("shift-meter-loading");
    if (loading) loading.classList.remove("hidden");

    try {
      const { data, error } = await supabaseClient.rpc("get_meter_shift_readings", {
        p_date: date,
        p_shift: shift,
      });
      if (error) throw error;
      if (gen !== loadGeneration) return;

      const resolvedLock = await resolveSupervisorLock(date, shift, data);
      if (gen !== loadGeneration) return;

      cashByEmployee = new Map();
      (data?.cash || []).forEach((c) => {
        cashByEmployee.set(c.employee_id, Number(c.cash_collected) || 0);
      });

      const appliedRates = await applyShiftRates(data?.rates);
      if (gen !== loadGeneration) return;

      const reconcile = el("shift-meter-reconcile");
      if (reconcile) {
        reconcile.dataset.dailyPetrol = String(data?.daily_totals?.petrol?.total_sales ?? "");
        reconcile.dataset.dailyDiesel = String(data?.daily_totals?.diesel?.total_sales ?? "");
        reconcile.dataset.hasPetrol = data?.daily_totals?.petrol?.has_row ? "1" : "0";
        reconcile.dataset.hasDiesel = data?.daily_totals?.diesel?.has_row ? "1" : "0";
        reconcile.dataset.rateFallback = appliedRates.fromFallback ? "1" : "0";
      }

      const attNote = el("shift-meter-attendance-note");
      if (attNote) {
        const hints = data?.attendance_hints || [];
        if (hints.length) {
          attNote.textContent = `Attendance on this shift: ${hints.map((h) => h.employee_name).join(", ")}.`;
          attNote.classList.remove("hidden");
        } else {
          attNote.textContent = "";
          attNote.classList.add("hidden");
        }
      }

      const resolved = await resolveOpeningSuggestions(date, shift, data);
      if (gen !== loadGeneration) return;

      const savedNozzles = data?.nozzles || [];
      const suggestClose =
        resolvedLock.locked
          ? null
          : buildSuggestedClosings(shift, data?.daily_meters, {
              hasSavedNozzles: savedNozzles.length > 0,
            });

      renderNozzleTables(
        savedNozzles,
        data?.attendance_hints || [],
        resolvedLock.locked ? null : resolved.openings,
        suggestClose
      );
      updateDerivedUi();
      applySupervisorLockUi(resolvedLock.locked, resolvedLock.reason);

      if (resolvedLock.locked) {
        // Banner already explains — keep error area clear
        showMsg("", false);
      } else {
        const filled = countMeaningfulSuggestions(resolved.openings);
        if (filled && !savedNozzles.length) {
          showMsg(
            shift === "afternoon"
              ? `Openings set from morning closing (${filled} meter${filled === 1 ? "" : "s"}). Enter afternoon closings.`
              : `Openings auto-filled from previous day closing / daily (${filled} meter${filled === 1 ? "" : "s"}).`,
            false
          );
        } else if (!filled && !savedNozzles.length) {
          showMsg(
            isAdmin
              ? "No prior meter closings found to auto-fill openings. Enter openings manually, or save yesterday’s daily MS/HSD first."
              : "No prior meter closings found for openings. Ask an admin to set yesterday’s meters, or use Copy openings if available.",
            true
          );
        } else {
          showMsg("", false);
        }
      }

      await loadRecentHistory();
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.loadShift" });
      showMsg(error.message || "Could not load shift register.", true);
      applySupervisorLockUi(false, "");
    } finally {
      if (loading) loading.classList.add("hidden");
    }
  }

  async function saveShift() {
    const date = el("shift-meter-date")?.value;
    const shift = el("shift-meter-shift")?.value;
    if (!date || !shift) {
      showMsg("Choose date and shift.", true);
      return;
    }

    if (supervisorReadonly && !isAdmin) {
      showMsg(lockReason || MSG_PAST_CLOSED, true);
      return;
    }

    // Re-check lock before save (per shift — empty afternoon stays writable)
    const lock = await resolveSupervisorLock(date, shift, {
      nozzles: readNozzleRowsFromDom().filter((r) => r.employee_id),
    });
    if (lock.locked) {
      applySupervisorLockUi(true, lock.reason);
      showMsg(lock.reason, true);
      return;
    }

    // Pull latest cash from DOM before save
    document.querySelectorAll("#shift-meter-staff-body .shift-cash-collected").forEach((input) => {
      const empId = input.dataset.employeeId;
      if (empId) cashByEmployee.set(empId, parseNum(input.value));
    });

    const allRows = readNozzleRowsFromDom();
    const nozzles = allRows.filter((r) => r.employee_id);

    if (!nozzles.length) {
      showMsg(
        "Assign staff to at least one nozzle before saving. To remove a saved shift, use Delete shift (admin).",
        true
      );
      return;
    }

    for (const r of nozzles) {
      if (r.closing_meter < r.opening_meter) {
        showMsg(
          `Closing must be ≥ opening for ${PRODUCT_LABEL[r.product]} P${r.pump_no}·N${r.nozzle_no}.`,
          true
        );
        return;
      }
      if (r.testing_litres > Math.max(r.closing_meter - r.opening_meter, 0)) {
        showMsg(
          `Testing cannot exceed sale for ${PRODUCT_LABEL[r.product]} P${r.pump_no}·N${r.nozzle_no}.`,
          true
        );
        return;
      }
    }

    // Afternoon handoff: openings must match morning closings when morning exists
    if (shift === "afternoon") {
      try {
        const morning = await fetchMorningShiftClosings(date);
        for (const r of nozzles) {
          const key = nozzleKey(r.product, r.pump_no, r.nozzle_no);
          if (morning[key] == null) continue;
          if (Math.abs(r.opening_meter - Number(morning[key])) > 0.001) {
            showMsg(
              `Afternoon opening for ${PRODUCT_LABEL[r.product]} P${r.pump_no}·N${r.nozzle_no} (${r.opening_meter}) must match morning closing (${morning[key]}). Use “Copy openings”.`,
              true
            );
            return;
          }
        }
      } catch (err) {
        AppError.report(err, { context: "MeterShiftReading.handoffCheck" });
      }
    }

    const staffIds = new Set(nozzles.map((r) => r.employee_id));
    const cash = Array.from(staffIds).map((employee_id) => ({
      employee_id,
      cash_collected: cashByEmployee.get(employee_id) || 0,
    }));

    const btn = el("shift-meter-save");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving…";
    }
    showMsg("", false);

    try {
      const { data, error } = await supabaseClient.rpc("save_meter_shift_readings", {
        p_date: date,
        p_shift: shift,
        p_nozzles: nozzles,
        p_cash: cash,
      });
      if (error) throw error;

      // Roll meters into daily MS/HSD (open/close/sales/testing)
      let syncNote = "";
      try {
        const { data: syncData, error: syncErr } = await supabaseClient.rpc(
          "sync_dsr_meters_from_shifts",
          { p_date: date }
        );
        if (syncErr) throw syncErr;
        const products = syncData?.synced_products || [];
        const skipped = syncData?.skipped_complete || [];
        if (products.length) {
          syncNote = `Daily meters updated for ${products
            .map((p) => (p === "petrol" ? "MS" : "HSD"))
            .join(" · ")}.`;
          if (typeof CacheInvalidation !== "undefined") {
            CacheInvalidation.invalidate("dsr");
          }
          if (typeof DsrSalesBreakdown !== "undefined") {
            DsrSalesBreakdown.invalidate?.();
          }
          // Reload MS/HSD sheets for this date so meters appear immediately
          if (typeof MeterReadingForms !== "undefined") {
            try {
              await MeterReadingForms.refreshForShiftDate(date, products, {
                alignDate: true,
              });
            } catch (refreshErr) {
              AppError.report(refreshErr, {
                context: "MeterShiftReading.refreshDailyForms",
              });
            }
          }
        }
        if (skipped.length) {
          const labels = skipped.map((p) => (p === "petrol" ? "MS" : "HSD")).join(" · ");
          syncNote += syncNote
            ? ` ${labels} already completed — meters left unchanged.`
            : `${labels} already completed — shift meters not pushed to daily sheets.`;
        }
      } catch (syncErr) {
        AppError.report(syncErr, { context: "MeterShiftReading.syncDaily" });
        syncNote = "Shift saved, but daily meter sync failed — check MS/HSD sheets.";
      }

      cashByEmployee = new Map();
      (data?.cash || []).forEach((c) => {
        cashByEmployee.set(c.employee_id, Number(c.cash_collected) || 0);
      });

      const savedCount = data?.saved_nozzles ?? nozzles.length;
      await loadShift();
      showMsg(
        `Saved ${savedCount} nozzle assignment(s) for ${shiftLabel(shift)}.${syncNote ? " " + syncNote : ""}`,
        false
      );
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.saveShift" });
      showMsg(error.message || "Save failed.", true);
    } finally {
      if (btn) {
        btn.textContent = "Save shift";
        if (supervisorReadonly) {
          btn.disabled = true;
          btn.title = lockReason || MSG_PAST_CLOSED;
        } else {
          btn.disabled = false;
          btn.title = "";
        }
      }
    }
  }

  async function copyOpenings() {
    const date = el("shift-meter-date")?.value;
    const shift = el("shift-meter-shift")?.value;
    if (!date || !shift) return;

    if (supervisorReadonly && !isAdmin) {
      showMsg(lockReason || MSG_PAST_CLOSED, true);
      return;
    }

    try {
      const resolved = await resolveOpeningSuggestions(date, shift, {
        daily_meters: null,
        suggested_openings: null,
        prior: null,
      });
      // Also pull current daily meters if present on the page rates/reconcile path
      try {
        const { data } = await supabaseClient.rpc("get_meter_shift_readings", {
          p_date: date,
          p_shift: shift,
        });
        const again = await resolveOpeningSuggestions(date, shift, data || {});
        Object.assign(resolved.openings, again.openings);
        resolved.prior = again.prior || resolved.prior;
      } catch (_) {
        /* keep first resolution */
      }

      let filled = 0;
      document.querySelectorAll("#shift-meter-nozzle-tables tbody tr[data-product]").forEach((tr) => {
        const product = tr.dataset.product;
        const pump = Number(tr.dataset.pump);
        const nozzle = Number(tr.dataset.nozzle);
        const openingInput = tr.querySelector(".shift-opening");
        if (!openingInput) return;
        const value = resolved.openings[nozzleKey(product, pump, nozzle)];
        if (value != null && Number.isFinite(Number(value))) {
          openingInput.value = formatMeterInput(value);
          filled++;
        }
      });

      updateDerivedUi();
      applyOpeningFieldAccess();
      const prior = resolved.prior;
      const priorLabel = prior
        ? `${formatDisplayDate?.(prior.prior_date) || prior.prior_date} · ${shiftLabel(prior.prior_shift)}`
        : "prior meters";
      showMsg(
        filled
          ? `Copied ${filled} opening(s) from ${priorLabel}.`
          : `No prior closings found for ${priorLabel}. Save the previous day’s MS/HSD meters first.`,
        !filled
      );
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.copyOpenings" });
      showMsg(error.message || "Could not copy openings.", true);
    }
  }

  async function clearShift(opts = {}) {
    const date = opts.date || el("shift-meter-date")?.value;
    const shift = opts.shift || el("shift-meter-shift")?.value;
    const btn = opts.btn || el("shift-meter-clear");
    if (!date || !shift || !isAdmin) return;

    await AdminDelete.execute({
      btn,
      auth: isAdmin ? { role: "admin" } : null,
      actionLabel: "delete shift register entries",
      confirmMessage: `Delete shift register for ${formatDisplayDate?.(date) || date} (${shiftLabel(shift)})?\n\nNozzle meters and cash for this shift will be removed. Daily MS/HSD will be re-synced from any remaining shift. Use this if something went wrong.`,
      deleteFn: () =>
        supabaseClient.rpc("delete_meter_shift_readings", {
          p_date: date,
          p_shift: shift,
        }),
      onSuccess: async () => {
        if (btn) btn.disabled = false;
        const clearBtn = el("shift-meter-clear");
        if (clearBtn) clearBtn.disabled = false;
        cashByEmployee = new Map();
        if (typeof CacheInvalidation !== "undefined") {
          CacheInvalidation.invalidate("dsr");
        }
        if (typeof DsrSalesBreakdown !== "undefined") {
          DsrSalesBreakdown.invalidate?.();
        }
        const curDate = el("shift-meter-date")?.value;
        const curShift = el("shift-meter-shift")?.value;
        if (curDate === date && curShift === shift) {
          await loadShift();
        } else {
          await loadRecentHistory();
        }
        showMsg(
          "Shift register deleted. Daily meters were re-synced from remaining shifts (unchanged if none remain).",
          false
        );
      },
      errorContext: { context: "MeterShiftReading.clearShift", date, shift },
    });
  }

  async function loadRecentHistory() {
    const tbody = el("shift-meter-history-body");
    if (!tbody) return;

    const end = el("shift-meter-date")?.value || getLocalDateString();
    const endDate = new Date(end + "T12:00:00");
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 13);
    const start = toLocalDateString(startDate);

    try {
      const { data: nozzles, error } = await supabaseClient
        .from("meter_shift_readings")
        .select("reading_date, shift, product, employee_id, opening_meter, closing_meter, testing_litres, pump_no, nozzle_no")
        .gte("reading_date", start)
        .lte("reading_date", end)
        .order("reading_date", { ascending: false });
      if (error) throw error;

      const { data: cashRows, error: cashErr } = await supabaseClient
        .from("meter_shift_cash")
        .select("reading_date, shift, employee_id, cash_collected")
        .gte("reading_date", start)
        .lte("reading_date", end);
      if (cashErr) throw cashErr;

      const groups = new Map();
      for (const n of nozzles || []) {
        const key = `${n.reading_date}|${n.shift}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            date: n.reading_date,
            shift: n.shift,
            petrol: 0,
            diesel: 0,
            staff: new Set(),
            cash: 0,
          };
          groups.set(key, g);
        }
        const sale = Math.max(Number(n.closing_meter) - Number(n.opening_meter), 0);
        if (n.product === "petrol") g.petrol += sale;
        else g.diesel += sale;
        g.staff.add(n.employee_id);
      }
      for (const c of cashRows || []) {
        const key = `${c.reading_date}|${c.shift}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            date: c.reading_date,
            shift: c.shift,
            petrol: 0,
            diesel: 0,
            staff: new Set(),
            cash: 0,
          };
          groups.set(key, g);
        }
        g.cash += Number(c.cash_collected) || 0;
        g.staff.add(c.employee_id);
      }

      const rows = Array.from(groups.values()).sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        if (a.shift === b.shift) return 0;
        return a.shift === "afternoon" ? -1 : 1;
      });

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 7 : 6}" class="muted">No shift register entries in the last 14 days.</td></tr>`;
        return;
      }

      const head = tbody.closest("table")?.querySelector("thead tr");
      if (head) {
        head.innerHTML = `
          <th>Date</th>
          <th>Shift</th>
          <th>MS (L)</th>
          <th>HSD (L)</th>
          <th>Staff</th>
          <th>Cash ₹</th>
          ${isAdmin ? "<th>Admin</th>" : ""}`;
      }

      tbody.innerHTML = rows
        .map((g) => {
          const openLink = `meter-reading.html?date=${encodeURIComponent(g.date)}&shift=${encodeURIComponent(g.shift)}#shift-readings`;
          const deleteCell = isAdmin
            ? `<td class="table-actions">${AdminDelete.buttonHtml({
                selector: "shift-history-delete",
                data: { date: g.date, shift: g.shift },
                label: "Delete",
                title: "Delete this shift register (admin)",
              })}</td>`
            : "";
          return `<tr>
            <td><a href="${openLink}" class="shift-history-link" data-date="${escapeHtml(g.date)}" data-shift="${escapeHtml(g.shift)}">${escapeHtml(formatDisplayDate?.(g.date) || g.date)}</a></td>
            <td>${escapeHtml(shiftLabel(g.shift))}</td>
            <td class="num">${formatQuantity(g.petrol)}</td>
            <td class="num">${formatQuantity(g.diesel)}</td>
            <td class="num">${g.staff.size}</td>
            <td class="num">${formatCurrency(g.cash)}</td>
            ${deleteCell}
          </tr>`;
        })
        .join("");
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.loadRecentHistory" });
      tbody.innerHTML = `<tr><td colspan="${isAdmin ? 7 : 6}" class="muted">Could not load history.</td></tr>`;
    }
  }

  function applyUrlParams() {
    const params = new URLSearchParams(location.search);
    const hash = (location.hash || "").replace(/^#/, "");
    const hashParams = hash.includes("?") ? new URLSearchParams(hash.split("?")[1]) : null;
    const date = params.get("date") || hashParams?.get("date");
    const shift = params.get("shift") || hashParams?.get("shift");
    if (date && el("shift-meter-date")) el("shift-meter-date").value = date;
    if (shift && (shift === "morning" || shift === "afternoon") && el("shift-meter-shift")) {
      el("shift-meter-shift").value = shift;
    }
  }

  function bindEvents() {
    el("shift-meter-date")?.addEventListener("change", () => void loadShift());
    el("shift-meter-shift")?.addEventListener("change", () => void loadShift());
    el("shift-meter-save")?.addEventListener("click", () => void saveShift());
    el("shift-meter-copy-openings")?.addEventListener("click", () => void copyOpenings());
    el("shift-meter-clear")?.addEventListener("click", () => void clearShift());

    AdminDelete.bindOnce(
      el("shift-meter-history-body"),
      ".shift-history-delete",
      async (btn) => {
        const date = btn.dataset.date;
        const shift = btn.dataset.shift;
        if (!date || !shift) return;
        await clearShift({ date, shift, btn });
      },
      "shiftHistoryDeleteBound"
    );

    const panel = el("shift-readings") || document.querySelector('[data-panel="shift-readings"]');
    panel?.addEventListener("input", (e) => {
      if (supervisorReadonly && !isAdmin) return;
      if (
        e.target.matches?.(
          ".shift-opening, .shift-closing, .shift-testing, .shift-cash-collected, #shift-meter-rate-petrol, #shift-meter-rate-diesel"
        )
      ) {
        debouncedDerived();
      }
    });
    panel?.addEventListener("change", (e) => {
      if (supervisorReadonly && !isAdmin) return;
      if (e.target.matches?.(".shift-staff")) updateDerivedUi();
    });

    el("shift-meter-history-body")?.addEventListener("click", (e) => {
      if (e.target.closest?.(".shift-history-delete")) return;
      const a = e.target.closest?.("a.shift-history-link");
      if (!a) return;
      e.preventDefault();
      const date = a.dataset.date;
      const shift = a.dataset.shift;
      if (date && el("shift-meter-date")) el("shift-meter-date").value = date;
      if (shift && el("shift-meter-shift")) el("shift-meter-shift").value = shift;
      void loadShift();
      if (location.hash !== "#shift-readings") {
        location.hash = "shift-readings";
      }
    });
  }

  function fillShiftSelect() {
    const select = el("shift-meter-shift");
    if (!select) return;
    const cfg = getShiftConfig();
    const current = select.value || "morning";
    select.innerHTML = `
      <option value="morning">${escapeHtml(cfg.morningName || "Morning shift")}</option>
      <option value="afternoon">${escapeHtml(cfg.afternoonName || "Afternoon shift")}</option>`;
    select.value = current === "afternoon" ? "afternoon" : "morning";

    const meta = el("shift-meter-shift-meta");
    if (meta) {
      meta.textContent = `${cfg.morningName || "Morning"} ${cfg.morningStart || "06:00"}–${cfg.morningEnd || "14:00"} · ${cfg.afternoonName || "Afternoon"} ${cfg.afternoonStart || "14:00"}–${cfg.afternoonEnd || "22:00"}`;
    }
  }

  async function init(opts = {}) {
    if (initialized) {
      await loadShift();
      return;
    }
    isAdmin = opts.isAdmin === true;
    const clearBtn = el("shift-meter-clear");
    if (clearBtn) clearBtn.classList.toggle("hidden", !isAdmin);

    const dateInput = el("shift-meter-date");
    if (dateInput && typeof initPersistedDateInput === "function") {
      initPersistedDateInput(dateInput, RECORD_DATE_KEYS.meterShift, { urlParam: "date" });
    } else if (dateInput && !dateInput.value) {
      dateInput.value = getLocalDateString();
    }

    fillShiftSelect();
    applyUrlParams();
    bindEvents();
    await loadStaff();
    initialized = true;
    await loadShift();
  }

  global.MeterShiftReading = { init, reload: loadShift };
})(typeof window !== "undefined" ? window : globalThis);
