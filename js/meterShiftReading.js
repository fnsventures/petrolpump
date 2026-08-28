/**
 * Shift-wise meter readings with staff attribution and cash short.
 * Shift tables are source of truth until the daily MS/HSD sheet is saved.
 * Prefill uses get_shift_aggregated_daily_meters; finished sheets own dsr_*.
 */
/* global supabaseClient, AppError, escapeHtml, PumpSettings, StaffEmployees, formatQuantity, formatCurrency, formatDisplayDate, initPersistedDateInput, RECORD_DATE_KEYS, AdminDelete, debounce, getLocalDateString, toLocalDateString, CacheInvalidation, DsrSalesBreakdown, MeterReadingForms, ShiftStaffLedger */

(function (global) {
  const PRODUCTS = ["petrol", "diesel"];
  const PRODUCT_LABEL = { petrol: "MS", diesel: "HSD" };

  let isAdmin = false;
  let currentUserId = null;
  let staffList = [];
  let loadGeneration = 0;
  let cashByEmployee = new Map(); // employee_id -> { cash, phone_pay, credit, expense }

  function emptyCashEntry() {
    return { cash: 0, phone_pay: 0, credit: 0, expense: 0 };
  }

  function cashEntryFor(empId) {
    const cur = cashByEmployee.get(empId);
    if (!cur) return emptyCashEntry();
    return {
      cash: Number(cur.cash) || 0,
      phone_pay: Number(cur.phone_pay) || 0,
      credit: Number(cur.credit) || 0,
      expense: Number(cur.expense) || 0,
    };
  }

  function setCashFromRow(c) {
    if (!c?.employee_id) return;
    cashByEmployee.set(c.employee_id, {
      cash: Number(c.cash_collected) || 0,
      phone_pay: Number(c.phone_pay) || 0,
      credit: Number(c.credit_amount) || 0,
      expense: Number(c.expense_amount) || 0,
    });
  }

  function applyShiftRemarks(cashRows) {
    const remarksEl = el("shift-meter-remarks");
    if (!remarksEl) return;
    const note = (cashRows || [])
      .map((c) => (c?.remarks != null ? String(c.remarks).trim() : ""))
      .find((t) => t);
    remarksEl.value = note || "";
  }

  function syncCashFromDom() {
    document
      .querySelectorAll(
        "#shift-meter-staff-body .shift-cash-collected, #shift-meter-staff-body .shift-phone-pay"
      )
      .forEach((input) => {
        const empId = input.dataset.employeeId;
        if (!empId) return;
        const cur = cashEntryFor(empId);
        if (input.classList.contains("shift-phone-pay")) {
          cur.phone_pay = parseNum(input.value);
        } else {
          cur.cash = parseNum(input.value);
        }
        cashByEmployee.set(empId, cur);
      });
  }

  function applyLedgerTotals(totalsMap) {
    const ids = new Set(cashByEmployee.keys());
    if (totalsMap) {
      totalsMap.forEach((_, empId) => ids.add(empId));
    }
    ids.forEach((empId) => {
      const vals = totalsMap?.get(empId);
      const cur = cashEntryFor(empId);
      cur.credit = Number(vals?.credit) || 0;
      cur.expense = Number(vals?.expense) || 0;
      cashByEmployee.set(empId, cur);
    });
  }

  async function refreshLedgerTotalsForCurrentShift() {
    const date = el("shift-meter-date")?.value;
    const shift = el("shift-meter-shift")?.value;
    if (!date || !shift || typeof ShiftStaffLedger?.fetchTotalsByEmployee !== "function") {
      return;
    }
    try {
      const map = await ShiftStaffLedger.fetchTotalsByEmployee(date, shift);
      applyLedgerTotals(map);
      updateDerivedUi({ forceStaffRender: true });
    } catch (err) {
      AppError.report(err, { context: "MeterShiftReading.refreshLedgerTotals" });
    }
  }

  function openStaffLedger(employeeId, employeeName, focusTab) {
    const date = el("shift-meter-date")?.value;
    const shift = el("shift-meter-shift")?.value;
    if (!date || !shift || !employeeId || typeof ShiftStaffLedger?.open !== "function") return;
    ShiftStaffLedger.open({
      date,
      shift,
      employeeId,
      employeeName,
      readonly: supervisorReadonly,
      isAdmin,
      userId: currentUserId,
      focusTab: focusTab === "expense" ? "expense" : "credit",
      onChange: ({ employeeId: empId, credit, expense }) => {
        const cur = cashEntryFor(empId);
        cur.credit = Number(credit) || 0;
        cur.expense = Number(expense) || 0;
        cashByEmployee.set(empId, cur);
        updateDerivedUi({ forceStaffRender: true });
      },
    });
  }
  let initialized = false;
  let supervisorReadonly = false;
  let lockReason = "";
  let shiftHasSavedRows = false;
  let lastStaffStructureKey = "";
  let shiftViewFocusReturn = null;
  let shiftViewCurrent = { date: "", shift: "" };
  let shiftViewGeneration = 0;

  const MSG_DAY_CLOSING_SAVED =
    "Day closing is saved for this date. Only an admin can change shifts.";
  const MSG_DAY_LOCKED =
    "Day closing is certified or night cash is collected. Only an admin can change meters.";
  const MSG_LOCK_UNAVAILABLE =
    "Unable to verify shift lock. Refresh and try again.";

  function getShiftConfig() {
    return PumpSettings.getShiftConfig();
  }

  function shiftLabel(key) {
    const cfg = getShiftConfig();
    if (key === "morning") return cfg.morningName || "Morning shift";
    if (key === "afternoon") return cfg.afternoonName || "Afternoon shift";
    return key || "—";
  }

  /** "06:00" → "6 am", "14:00" → "2 pm" */
  function formatShiftClock(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return "";
    const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return hhmm;
    let h = Number(m[1]);
    const min = m[2];
    if (!Number.isFinite(h) || h < 0 || h > 23) return hhmm;
    const suffix = h < 12 ? "am" : "pm";
    h = h % 12;
    if (h === 0) h = 12;
    return min === "00" ? `${h} ${suffix}` : `${h}:${min} ${suffix}`;
  }

  function shiftHoursLabel(key) {
    const cfg = getShiftConfig();
    const start = key === "afternoon" ? cfg.afternoonStart : cfg.morningStart;
    const end = key === "afternoon" ? cfg.afternoonEnd : cfg.morningEnd;
    const from = formatShiftClock(start);
    const to = formatShiftClock(end);
    if (!from || !to) return "";
    return `(${from} to ${to})`;
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

  function staffOptionsHtml(selectedId, selectedName) {
    const opts = ['<option value="">— Unassigned —</option>'];
    const selected = selectedId ? String(selectedId) : "";
    const seen = new Set();
    for (const s of staffList) {
      const id = String(s.id);
      seen.add(id);
      const sel = id === selected ? " selected" : "";
      opts.push(
        `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(s.name || "Staff")}</option>`
      );
    }
    if (selected && !seen.has(selected)) {
      const label = (selectedName || "Staff").trim() || "Staff";
      opts.push(
        `<option value="${escapeHtml(selected)}" selected>${escapeHtml(label)}</option>`
      );
    }
    return opts.join("");
  }

  /** Include saved shift assignees (e.g. inactive staff on past dates) in dropdown options. */
  async function ensureShiftStaffRoster(shiftData) {
    const ids = new Set();
    (shiftData?.nozzles || []).forEach((n) => {
      if (n?.employee_id) ids.add(String(n.employee_id));
    });
    (shiftData?.cash || []).forEach((c) => {
      if (c?.employee_id) ids.add(String(c.employee_id));
    });
    (shiftData?.attendance_hints || []).forEach((h) => {
      if (h?.employee_id) ids.add(String(h.employee_id));
    });
    const missing = [...ids].filter((id) => !staffList.some((s) => String(s.id) === id));
    if (!missing.length || typeof StaffEmployees?.resolveEmployeesByIds !== "function") return;

    try {
      const byId = await StaffEmployees.resolveEmployeesByIds(supabaseClient, missing);
      byId.forEach((emp) => {
        staffList.push({
          id: emp.id,
          name: StaffEmployees.displayName(emp),
          role_display: emp.role_display,
          monthly_salary: emp.monthly_salary ?? 0,
          display_order: emp.display_order,
          is_active: emp.is_active !== false,
        });
      });
      staffList.sort((a, b) => {
        const order = (Number(a.display_order) || 0) - (Number(b.display_order) || 0);
        return order !== 0 ? order : String(a.name || "").localeCompare(String(b.name || ""));
      });
    } catch (err) {
      AppError.report(err, { context: "MeterShiftReading.ensureShiftStaffRoster" });
    }
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
   * Resolve selling rates without touching the DOM (safe under concurrent loadShift).
   * Prefer same-day daily rates; otherwise last entered selling rate.
   */
  async function resolveShiftRates(rpcRates) {
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

    return { petrol, diesel, fromFallback };
  }

  function writeShiftRatesToDom(resolved) {
    const ratePetrol = el("shift-meter-rate-petrol");
    const rateDiesel = el("shift-meter-rate-diesel");
    if (ratePetrol) {
      ratePetrol.value =
        resolved?.petrol != null ? formatMeterInput(resolved.petrol) : "";
    }
    if (rateDiesel) {
      rateDiesel.value =
        resolved?.diesel != null ? formatMeterInput(resolved.diesel) : "";
    }
  }

  /** @deprecated use resolveShiftRates + writeShiftRatesToDom */
  async function applyShiftRates(rpcRates) {
    const resolved = await resolveShiftRates(rpcRates);
    writeShiftRatesToDom(resolved);
    return resolved;
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

  function lockFromInfo(lockInfo) {
    if (isAdmin) return { locked: false, reason: "" };
    if (lockInfo?.supervisor_readonly) {
      return {
        locked: true,
        reason:
          lockInfo.lock_reason ||
          (lockInfo.day_locked ? MSG_DAY_LOCKED : MSG_DAY_CLOSING_SAVED),
      };
    }
    // Fail closed when lock RPC is unavailable.
    if (lockInfo == null) {
      return { locked: true, reason: MSG_LOCK_UNAVAILABLE };
    }
    return { locked: false, reason: "" };
  }

  async function resolveSupervisorLock(date, shift) {
    if (isAdmin) return { locked: false, reason: "" };
    return lockFromInfo(await fetchLockInfo(date, shift));
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

  function updateShiftContext(opts = {}) {
    const date = opts.date ?? el("shift-meter-date")?.value;
    const shift = opts.shift ?? el("shift-meter-shift")?.value;
    const labelEl = el("shift-meter-context-label");
    const statusEl = el("shift-meter-context-status");
    if (!labelEl || !statusEl) return;

    if (!date || !shift) {
      labelEl.textContent = "Select a date and shift";
      statusEl.textContent = "—";
      statusEl.className = "shift-status-badge shift-status-badge--idle";
      return;
    }

    const dateLabel =
      typeof formatDisplayDate === "function" ? formatDisplayDate(date) : date;
    const hours = shiftHoursLabel(shift);
    labelEl.innerHTML = `${escapeHtml(dateLabel)} · ${escapeHtml(shiftLabel(shift))}${
      hours ? ` <span class="shift-context-hours">${escapeHtml(hours)}</span>` : ""
    }`;

    if (supervisorReadonly) {
      statusEl.textContent = "Locked";
      statusEl.className = "shift-status-badge shift-status-badge--locked";
      statusEl.title = lockReason || MSG_DAY_CLOSING_SAVED;
    } else if (opts.hasSaved ?? shiftHasSavedRows) {
      statusEl.textContent = "Saved · can update";
      statusEl.className = "shift-status-badge shift-status-badge--saved";
      statusEl.title = isAdmin
        ? ""
        : "You can save again with updated values until day closing is saved";
    } else {
      statusEl.textContent = "Not saved yet";
      statusEl.className = "shift-status-badge shift-status-badge--draft";
      statusEl.title = "";
    }
  }

  function applySupervisorLockUi(locked, reason) {
    supervisorReadonly = Boolean(locked) && !isAdmin;
    lockReason = supervisorReadonly ? reason || MSG_DAY_CLOSING_SAVED : "";

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
    const saveRow = el("shift-save-row");
    if (saveBtn) {
      saveBtn.disabled = supervisorReadonly;
      saveBtn.hidden = supervisorReadonly;
      saveBtn.title = supervisorReadonly ? lockReason : "";
      saveBtn.setAttribute("aria-disabled", supervisorReadonly ? "true" : "false");
    }
    if (saveRow) {
      saveRow.classList.toggle("shift-save-row--locked", supervisorReadonly);
      saveRow.hidden = false;
    }
    if (copyBtn) {
      copyBtn.disabled = supervisorReadonly;
      copyBtn.title = supervisorReadonly
        ? lockReason
        : isAdmin
          ? "Copy openings from prior shift / daily"
          : "Fill openings from prior shift / daily (openings stay locked after fill)";
    }

    updateShiftContext();

    const ratePetrol = el("shift-meter-rate-petrol");
    const rateDiesel = el("shift-meter-rate-diesel");
    const remarksEl = el("shift-meter-remarks");
    if (ratePetrol) {
      ratePetrol.readOnly = supervisorReadonly;
      ratePetrol.disabled = supervisorReadonly;
    }
    if (rateDiesel) {
      rateDiesel.readOnly = supervisorReadonly;
      rateDiesel.disabled = supervisorReadonly;
    }
    if (remarksEl) {
      remarksEl.readOnly = supervisorReadonly;
      remarksEl.disabled = supervisorReadonly;
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
      rows.push({
        product,
        pump_no,
        nozzle_no,
        employee_id,
        opening_meter,
        closing_meter,
        // Testing is entered on the daily MS/HSD sheet, not per-nozzle on shift register
        testing_litres: 0,
      });
    });
    return rows;
  }

  function cashEntryFromMap(cashMap, empId) {
    const cur = cashMap?.get?.(empId);
    if (!cur) return emptyCashEntry();
    return {
      cash: Number(cur.cash) || 0,
      phone_pay: Number(cur.phone_pay) || 0,
      credit: Number(cur.credit) || 0,
      expense: Number(cur.expense) || 0,
    };
  }

  function shortClassFor(short) {
    if (short == null) return "";
    if (short > 0.5) return "shift-short--shortage";
    if (short < -0.5) return "shift-short--surplus";
    return "shift-short--balanced";
  }

  function staffStructureKey(summary) {
    return summary
      .map((s) => s.employee_id)
      .sort()
      .join("|");
  }

  function readRatesFromDom() {
    const petrolEl = el("shift-meter-rate-petrol");
    const dieselEl = el("shift-meter-rate-diesel");
    return {
      petrol: petrolEl?.value ? parseNum(petrolEl.value) : null,
      diesel: dieselEl?.value ? parseNum(dieselEl.value) : null,
    };
  }

  function computeStaffSummary(nozzleRows, rates, cashMap = cashByEmployee) {
    const nameById = new Map(staffList.map((s) => [s.id, s.name]));
    const byEmp = new Map();
    for (const row of nozzleRows) {
      if (!row.employee_id) continue;
      const gross = Math.max(row.closing_meter - row.opening_meter, 0);
      const net = Math.max(gross - (Number(row.testing_litres) || 0), 0);
      let agg = byEmp.get(row.employee_id);
      if (!agg) {
        agg = {
          employee_id: row.employee_id,
          name: nameById.get(row.employee_id) || "Staff",
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
      const entry = cashEntryFromMap(cashMap, agg.employee_id);
      const cash = entry.cash;
      const phonePay = entry.phone_pay;
      const credit = entry.credit;
      const expense = entry.expense;
      const collected = cash + phonePay + credit + expense;
      const short = expected != null ? expected - collected : null;
      return {
        ...agg,
        expected,
        cash,
        phone_pay: phonePay,
        credit,
        expense,
        collected,
        short,
      };
    });
  }

  function updateNozzleSaleFields() {
    document.querySelectorAll("#shift-meter-nozzle-tables tbody tr[data-product]").forEach((tr) => {
      const opening = parseNum(tr.querySelector(".shift-opening")?.value);
      const closing = parseNum(tr.querySelector(".shift-closing")?.value);
      const sale = Math.max(closing - opening, 0);
      const saleEl = tr.querySelector(".shift-sale");
      if (saleEl) saleEl.value = sale ? formatQuantity(sale) : "";
      tr.classList.toggle("shift-row--warn", closing < opening);
      tr.classList.toggle("shift-row--assigned", Boolean(tr.querySelector(".shift-staff")?.value));
    });
  }

  function lockStaffCashInputs() {
    if (!supervisorReadonly) return;
    document
      .querySelectorAll(
        "#shift-meter-staff-body .shift-cash-collected, #shift-meter-staff-body .shift-phone-pay"
      )
      .forEach((input) => {
        input.readOnly = true;
        input.disabled = true;
      });
  }

  function updateDerivedUi(opts = {}) {
    const rates = readRatesFromDom();
    updateNozzleSaleFields();
    syncCashFromDom();

    const nozzleRows = readNozzleRowsFromDom();
    const summary = computeStaffSummary(nozzleRows, rates);
    const structureKey = staffStructureKey(summary);
    const forceStaff = opts.forceStaffRender === true;
    const structureChanged = structureKey !== lastStaffStructureKey;
    const host = el("shift-meter-staff-body");
    const hasTable = Boolean(host?.querySelector(".shift-staff-cards"));

    if (forceStaff || structureChanged || !hasTable) {
      lastStaffStructureKey = structureKey;
      renderStaffSummary(summary, rates);
      lockStaffCashInputs();
    } else {
      patchStaffSummary(summary, rates);
    }

    renderReconcile(nozzleRows);
    renderShiftTotals(summary, nozzleRows);
  }

  const debouncedDerived = typeof debounce === "function" ? debounce(updateDerivedUi, 120) : updateDerivedUi;

  function moneyInputValue(amount) {
    const n = Number(amount) || 0;
    return n === 0 ? "" : formatMeterInput(n);
  }

  function renderRateHint(rates) {
    if (rates.petrol == null && rates.diesel == null) {
      return '<p class="muted shift-rate-hint">Enter MS / HSD rates above to see expected ₹ and short.</p>';
    }
    if (el("shift-meter-reconcile")?.dataset.rateFallback === "1") {
      return '<p class="muted shift-rate-hint">Rates prefilled from the last daily sheet — change if today’s price is different.</p>';
    }
    return "";
  }

  function staffMoneyField(opts) {
    const { id, empId, name, kind, value, label } = opts;
    const cls = kind === "phone" ? "shift-phone-pay" : "shift-cash-collected";
    return `<label class="shift-coll-field">
      <span class="shift-coll-label">${escapeHtml(label)}</span>
      <input id="${escapeHtml(id)}" type="text" inputmode="decimal"
        class="${cls} meter-reading shift-money-input"
        data-employee-id="${escapeHtml(empId)}"
        value="${escapeHtml(moneyInputValue(value))}"
        placeholder="0" maxlength="14"
        aria-label="${escapeHtml(label)} for ${escapeHtml(name)}" />
    </label>`;
  }

  function staffLedgerCombined(opts) {
    const { empId, name, credit, expense } = opts;
    const creditAmt = Number(credit) || 0;
    const expenseAmt = Number(expense) || 0;
    const hasAny = creditAmt > 0 || expenseAmt > 0;
    const creditDisplay = creditAmt ? formatCurrency(creditAmt) : "—";
    const expenseDisplay = expenseAmt ? formatCurrency(expenseAmt) : "—";
    const btnText = supervisorReadonly ? "View" : hasAny ? "Edit" : "Add";
    const title = supervisorReadonly
      ? `View credit and expenses for ${name}`
      : `${btnText} credit and expenses for ${name}`;
    return `<div class="shift-coll-field shift-coll-field--ledger">
      <span class="shift-coll-label">Credit / Exp</span>
      <div class="shift-coll-ledger-box">
        <div class="shift-coll-ledger-amounts">
          <span class="shift-coll-ledger-pair">
            <span class="shift-coll-ledger-tag">Cr</span>
            <span class="shift-metric-credit shift-coll-ledger-amt">${creditDisplay}</span>
          </span>
          <span class="shift-coll-ledger-pair">
            <span class="shift-coll-ledger-tag">Exp</span>
            <span class="shift-metric-expense shift-coll-ledger-amt">${expenseDisplay}</span>
          </span>
        </div>
        <button type="button"
          class="shift-ledger-open shift-coll-add-btn"
          data-employee-id="${escapeHtml(empId)}"
          data-employee-name="${escapeHtml(name)}"
          data-focus-tab="credit"
          title="${escapeHtml(title)}"
          aria-label="${escapeHtml(title)}">${escapeHtml(btnText)}</button>
      </div>
    </div>`;
  }

  function staffMoneyInputKind(el) {
    if (!el?.classList) return null;
    if (el.classList.contains("shift-phone-pay")) return "phone";
    if (el.classList.contains("shift-cash-collected")) return "cash";
    return null;
  }

  function staffMoneyInputClass(kind) {
    return kind === "phone" ? "shift-phone-pay" : "shift-cash-collected";
  }

  function renderStaffSummary(summary, rates) {
    const host = el("shift-meter-staff-body");
    if (!host) return;

    const active = document.activeElement;
    const activeKind = staffMoneyInputKind(active);
    const activeEmp = activeKind ? active.dataset.employeeId : null;
    const selStart = activeEmp != null ? active.selectionStart : null;
    const selEnd = activeEmp != null ? active.selectionEnd : null;

    const hintHost = el("shift-meter-staff-hint");
    if (hintHost) {
      const rateHint = renderRateHint(rates);
      hintHost.innerHTML =
        rateHint ||
        '<p class="muted shift-rate-hint">Total = cash + phone + credit + expenses. Tap Add to enter credit or expenses.</p>';
    }

    if (!summary.length) {
      host.innerHTML =
        '<p class="muted shift-staff-empty">Assign staff to nozzles above to see collections.</p>';
      return;
    }

    const cards = summary
      .map((s) => {
        const shortClass = shortClassFor(s.short);
        const shortText = s.short == null ? "—" : formatCurrency(s.short);
        const expectedText = s.expected == null ? "—" : formatCurrency(s.expected);
        const cashId = `shift-cash-${s.employee_id}`;
        const phoneId = `shift-phone-${s.employee_id}`;
        const initial = (s.name || "?").trim().charAt(0).toUpperCase() || "?";
        return `<article class="shift-staff-card shift-staff-row" data-employee-id="${escapeHtml(s.employee_id)}">
          <div class="shift-coll-identity">
            <span class="shift-coll-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
            <div class="shift-coll-who">
              <div class="shift-coll-name-row">
                <h4 class="shift-staff-name">${escapeHtml(s.name)}</h4>
                <span class="shift-coll-due" title="Expected collection">
                  <span class="shift-coll-due-label">Due</span>
                  <strong class="shift-metric-expected">${expectedText}</strong>
                </span>
              </div>
              <p class="muted shift-meter-list">${escapeHtml(s.meters.join(" · "))}</p>
              <div class="shift-coll-meta">
                <span><span class="muted">MS</span> <strong class="shift-metric-ms">${formatQuantity(s.petrol_litres)}</strong></span>
                <span><span class="muted">HSD</span> <strong class="shift-metric-hsd">${formatQuantity(s.diesel_litres)}</strong></span>
              </div>
            </div>
          </div>
          <div class="shift-coll-money">
            ${staffMoneyField({
              id: cashId,
              empId: s.employee_id,
              name: s.name,
              kind: "cash",
              value: s.cash,
              label: "Cash",
            })}
            ${staffMoneyField({
              id: phoneId,
              empId: s.employee_id,
              name: s.name,
              kind: "phone",
              value: s.phone_pay,
              label: "Phone",
            })}
            ${staffLedgerCombined({
              empId: s.employee_id,
              name: s.name,
              credit: s.credit,
              expense: s.expense,
            })}
          </div>
          <div class="shift-coll-foot">
            <div class="shift-coll-result">
              <span class="muted">Total</span>
              <strong class="shift-metric-total">${formatCurrency(s.collected || 0)}</strong>
            </div>
            <div class="shift-coll-result shift-staff-short ${shortClass}">
              <span class="muted">Short</span>
              <strong class="shift-metric-short">${shortText}</strong>
            </div>
          </div>
        </article>`;
      })
      .join("");

    host.innerHTML = `<div class="shift-staff-cards">${cards}</div>`;

    host.querySelectorAll(".shift-ledger-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        openStaffLedger(btn.dataset.employeeId, btn.dataset.employeeName, btn.dataset.focusTab);
      });
    });

    if (activeEmp && activeKind) {
      const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(activeEmp) : activeEmp;
      const cls = staffMoneyInputClass(activeKind);
      const restored = host.querySelector(`.${cls}[data-employee-id="${sel}"]`);
      if (restored) {
        restored.focus();
        if (typeof selStart === "number" && typeof selEnd === "number") {
          try {
            restored.setSelectionRange(selStart, selEnd);
          } catch (_) {
            /* ignore */
          }
        }
      }
    }
  }

  function patchStaffSummary(summary, rates) {
    const hintHost = el("shift-meter-staff-hint");
    if (hintHost) {
      const rateHint = renderRateHint(rates);
      hintHost.innerHTML =
        rateHint ||
        '<p class="muted shift-rate-hint">Total = cash + phone + credit + expenses. Tap Add to enter credit or expenses.</p>';
    }

    summary.forEach((s) => {
      const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s.employee_id) : s.employee_id;
      const row = document.querySelector(
        `#shift-meter-staff-body .shift-staff-row[data-employee-id="${sel}"]`
      );
      if (!row) return;
      const meterList = row.querySelector(".shift-meter-list");
      if (meterList) meterList.textContent = s.meters.join(" · ");
      const ms = row.querySelector(".shift-metric-ms");
      if (ms) ms.textContent = formatQuantity(s.petrol_litres);
      const hsd = row.querySelector(".shift-metric-hsd");
      if (hsd) hsd.textContent = formatQuantity(s.diesel_litres);
      const expected = row.querySelector(".shift-metric-expected");
      if (expected) expected.textContent = s.expected == null ? "—" : formatCurrency(s.expected);
      const credit = row.querySelector(".shift-metric-credit");
      if (credit) {
        const has = Number(s.credit) > 0;
        credit.textContent = has ? formatCurrency(s.credit) : "—";
      }
      const expense = row.querySelector(".shift-metric-expense");
      if (expense) {
        const has = Number(s.expense) > 0;
        expense.textContent = has ? formatCurrency(s.expense) : "—";
      }
      const ledgerBtn = row.querySelector(".shift-ledger-open");
      if (ledgerBtn && !supervisorReadonly) {
        const hasAny = Number(s.credit) > 0 || Number(s.expense) > 0;
        ledgerBtn.textContent = hasAny ? "Edit" : "Add";
      }
      const total = row.querySelector(".shift-metric-total");
      if (total) total.textContent = formatCurrency(s.collected || 0);
      const cashInput = row.querySelector(".shift-cash-collected");
      if (cashInput && document.activeElement !== cashInput) {
        cashInput.value = moneyInputValue(s.cash);
      }
      const phoneInput = row.querySelector(".shift-phone-pay");
      if (phoneInput && document.activeElement !== phoneInput) {
        phoneInput.value = moneyInputValue(s.phone_pay);
      }
      const shortCell = row.querySelector(".shift-staff-short");
      if (shortCell) {
        shortCell.className = `shift-coll-result shift-staff-short ${shortClassFor(s.short)}`;
        const shortVal = shortCell.querySelector(".shift-metric-short");
        if (shortVal) shortVal.textContent = s.short == null ? "—" : formatCurrency(s.short);
      }
    });
  }

  function shiftSaleBreakdown(nozzleRows) {
    let petrol = 0;
    let diesel = 0;
    let petrolNet = 0;
    let dieselNet = 0;
    let petrolAssigned = 0;
    let dieselAssigned = 0;
    let activeNozzles = 0;
    for (const r of nozzleRows) {
      const g = Math.max(r.closing_meter - r.opening_meter, 0);
      const net = Math.max(g - (Number(r.testing_litres) || 0), 0);
      if (g > 0 || r.opening_meter > 0 || r.closing_meter > 0 || r.employee_id) {
        activeNozzles += 1;
      }
      if (r.product === "petrol") {
        petrol += g;
        petrolNet += net;
        if (r.employee_id) petrolAssigned += g;
      } else if (r.product === "diesel") {
        diesel += g;
        dieselNet += net;
        if (r.employee_id) dieselAssigned += g;
      }
    }
    return {
      petrol,
      diesel,
      petrolNet,
      dieselNet,
      petrolAssigned,
      dieselAssigned,
      total: petrol + diesel,
      totalNet: petrolNet + dieselNet,
      activeNozzles,
    };
  }

  function renderShiftTotals(summary, nozzleRows) {
    const host = el("shift-meter-totals");
    if (!host) return;
    const sales = shiftSaleBreakdown(nozzleRows);
    const rates = readRatesFromDom();
    let expected = null;
    if (rates.petrol != null || rates.diesel != null) {
      expected =
        (rates.petrol != null ? sales.petrolNet * rates.petrol : 0) +
        (rates.diesel != null ? sales.dieselNet * rates.diesel : 0);
    }
    const totalCashHard = summary.reduce(
      (acc, s) => {
        acc.cash += Number(s.cash) || 0;
        acc.phone += Number(s.phone_pay) || 0;
        acc.credit += Number(s.credit) || 0;
        acc.expense += Number(s.expense) || 0;
        acc.collected += Number(s.collected) || 0;
        if (s.short != null) {
          acc.short += s.short;
          acc.hasShort = true;
        }
        return acc;
      },
      { cash: 0, phone: 0, credit: 0, expense: 0, collected: 0, short: 0, hasShort: false }
    );
    const totalCash = totalCashHard.collected;
    const totalShort = totalCashHard.short;
    const hasShort = totalCashHard.hasShort;
    const shortClass = hasShort
      ? totalShort > 0.5
        ? "shift-short--shortage"
        : totalShort < -0.5
          ? "shift-short--surplus"
          : "shift-short--balanced"
      : "";

    const inParts = summary.length
      ? `Cash ${formatCurrency(totalCashHard.cash)} · Phone ${formatCurrency(totalCashHard.phone)} · Credit ${formatCurrency(totalCashHard.credit)} · Exp ${formatCurrency(totalCashHard.expense)}`
      : "";

    host.innerHTML = `
      <div class="shift-totals-strip">
        <span class="shift-strip-item shift-total--petrol">MS <strong>${formatQuantity(sales.petrol)} L</strong></span>
        <span class="shift-strip-item shift-total--diesel">HSD <strong>${formatQuantity(sales.diesel)} L</strong></span>
        <span class="shift-strip-item">Expected <strong>${expected != null ? formatCurrency(expected) : "—"}</strong></span>
        <span class="shift-strip-item">Total <strong>${summary.length ? formatCurrency(totalCash) : "—"}</strong>${
          summary.length ? ` <span class="muted shift-strip-breakdown">${inParts}</span>` : ""
        }</span>
        <span class="shift-strip-item ${shortClass}">Short <strong>${hasShort ? formatCurrency(totalShort) : "—"}</strong></span>
      </div>`;

    const saveSummary = el("shift-save-summary");
    if (saveSummary) {
      const bits = [];
      if (sales.petrol) bits.push(`MS ${formatQuantity(sales.petrol)} L`);
      if (sales.diesel) bits.push(`HSD ${formatQuantity(sales.diesel)} L`);
      if (hasShort) bits.push(`Short ${formatCurrency(totalShort)}`);
      saveSummary.textContent = bits.length ? bits.join(" · ") : "Enter meters and staff cash, then save";
    }
  }

  function productSheetLine(opts) {
    const {
      label,
      hash,
      hasSheet,
      dailyLitres,
      shiftLitres,
      assignedLitres,
    } = opts;
    const assignedNote =
      assignedLitres != null && assignedLitres !== shiftLitres
        ? ` · assigned ${formatQuantity(assignedLitres)} L`
        : "";
    if (hasSheet) {
      return `<a class="shift-sheet-card shift-sheet-card--done" href="meter-reading.html#${escapeHtml(hash)}">
        <span class="shift-sheet-card-title">${escapeHtml(label)} sheet</span>
        <span class="shift-sheet-card-meta">Day ${formatQuantity(dailyLitres)} L · this shift ${formatQuantity(shiftLitres)} L${assignedNote}</span>
        <span class="shift-sheet-card-action">Open ${escapeHtml(label)} →</span>
      </a>`;
    }
    return `<a class="shift-sheet-card" href="meter-reading.html#${escapeHtml(hash)}">
      <span class="shift-sheet-card-title">${escapeHtml(label)} sheet</span>
      <span class="shift-sheet-card-meta">Not saved yet · this shift ${formatQuantity(shiftLitres)} L${assignedNote}</span>
      <span class="shift-sheet-card-action">Open to enter dip / stock →</span>
    </a>`;
  }

  function renderReconcile(nozzleRows) {
    const host = el("shift-meter-reconcile");
    if (!host) return;
    const dailyPetrol =
      host.dataset.dailyPetrol !== "" && host.dataset.dailyPetrol != null
        ? Number(host.dataset.dailyPetrol)
        : null;
    const dailyDiesel =
      host.dataset.dailyDiesel !== "" && host.dataset.dailyDiesel != null
        ? Number(host.dataset.dailyDiesel)
        : null;
    const hasPetrol = host.dataset.hasPetrol === "1";
    const hasDiesel = host.dataset.hasDiesel === "1";
    const syncNote = host.dataset.syncNote || "";
    const sales = shiftSaleBreakdown(nozzleRows);

    const parts = [];
    if (syncNote) parts.push(`<p class="success">${escapeHtml(syncNote)}</p>`);

    parts.push('<div class="shift-sheet-cards">');
    parts.push(
      productSheetLine({
        label: "MS",
        hash: "petrol",
        hasSheet: hasPetrol,
        dailyLitres: Number.isFinite(dailyPetrol) ? dailyPetrol : 0,
        shiftLitres: sales.petrol,
        assignedLitres: sales.petrolAssigned,
      })
    );
    parts.push(
      productSheetLine({
        label: "HSD",
        hash: "diesel",
        hasSheet: hasDiesel,
        dailyLitres: Number.isFinite(dailyDiesel) ? dailyDiesel : 0,
        shiftLitres: sales.diesel,
        assignedLitres: sales.dieselAssigned,
      })
    );
    parts.push("</div>");

    parts.push(
      `<p class="muted shift-reconcile-footer"><a href="dsr.html#by-salesman">View salesman totals on DSR →</a></p>`
    );

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
          const openingReadonly = !isAdmin ? " readonly" : "";
          const openingClass = !isAdmin
            ? "shift-opening meter-reading shift-opening--locked"
            : "shift-opening meter-reading";
          return `<tr data-product="${product}" data-pump="${slot.pump_no}" data-nozzle="${slot.nozzle_no}">
            <td class="shift-meter-label">${escapeHtml(slot.label)}</td>
            <td><select class="shift-staff" aria-label="Staff for ${PRODUCT_LABEL[product]} ${slot.label}">${staffOptionsHtml(empId, saved?.employee_name)}</select></td>
            <td><input type="text" inputmode="numeric" maxlength="15" class="${openingClass}" value="${escapeHtml(opening)}" placeholder="0"${openingReadonly} title="${!isAdmin ? "Opening comes from the prior shift / day and cannot be edited" : ""}" aria-label="Opening for ${PRODUCT_LABEL[product]} ${slot.label}" /></td>
            <td><input type="text" inputmode="numeric" maxlength="15" class="shift-closing meter-reading" value="${escapeHtml(closing)}" placeholder="Enter" aria-label="Closing for ${PRODUCT_LABEL[product]} ${slot.label}" /></td>
            <td><input type="text" readonly class="shift-sale calc-field" tabindex="-1" aria-label="Sale litres" /></td>
          </tr>`;
        })
        .join("");

      return `<div class="shift-product-block shift-product-block--${product}">
        <div class="shift-product-head">
          <span class="fuel-rate-icon${product === "diesel" ? " fuel-rate-icon--diesel" : ""}" aria-hidden="true">${PRODUCT_LABEL[product]}</span>
          <h3 class="meter-title">${PRODUCT_LABEL[product]}</h3>
        </div>
        <div class="table-scroll">
          <table class="dsr-table meter-table compact shift-nozzle-table">
            <thead>
              <tr>
                <th>Meter</th>
                <th>Staff</th>
                <th>Opening</th>
                <th class="shift-th-focus">Closing</th>
                <th>Sale</th>
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
      if (!m || m.is_complete !== true) continue;
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
      // Only finished sheets — incomplete same-day rows must not poison openings.
      if (!m || m.is_complete !== true) continue;
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
      if (!/meter_shift_readings|PGRST|42P01/i.test(err.message || "")) {
        AppError.report(err, { context: "MeterShiftReading.fetchMorningShiftClosings" });
      }
    }
    return map;
  }

  /**
   * Opening suggestions: prior RPC + morning handoff for afternoon.
   * Prefer payload from get_meter_shift_readings to avoid extra round-trips.
   */
  async function resolveOpeningSuggestions(date, shift, data) {
    const map = {};

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
      includeDailyClosings: shift === "morning",
    });

    if (shift === "afternoon") {
      const hasFromPrior = (prior?.from_shift || []).length > 0;
      const sug = data?.suggested_openings;
      const hasSug =
        sug &&
        typeof sug === "object" &&
        Object.keys(sug).some((k) => sug[k] != null && sug[k] !== "");
      // Only hit the table when the main RPC did not already supply openings
      if (!hasFromPrior && !hasSug) {
        const morning = await fetchMorningShiftClosings(date);
        Object.keys(morning).forEach((k) => offerOpening(map, k, morning[k]));
      }
    }

    if (shift === "morning") {
      mergeDailyMeterOpenings(map, data?.daily_meters);
    }

    // Server suggestions as fill-in
    const sug = data?.suggested_openings;
    if (sug && typeof sug === "object") {
      Object.keys(sug).forEach((k) => offerOpening(map, k, sug[k]));
    }

    return { openings: map, prior };
  }

  function countMeaningfulSuggestions(map) {
    return Object.values(map || {}).filter((v) => v != null && Number(v) !== 0).length;
  }

  function beginShiftLoadUi(date, shift) {
    if (typeof debouncedDerived?.cancel === "function") debouncedDerived.cancel();
    cashByEmployee = new Map();
    shiftHasSavedRows = false;
    lastStaffStructureKey = "";

    const ratePetrol = el("shift-meter-rate-petrol");
    const rateDiesel = el("shift-meter-rate-diesel");
    if (ratePetrol) ratePetrol.value = "";
    if (rateDiesel) rateDiesel.value = "";

    const nozzleHost = el("shift-meter-nozzle-tables");
    if (nozzleHost) {
      nozzleHost.innerHTML = `<p class="muted">Loading meters for ${escapeHtml(shiftLabel(shift))}…</p>`;
    }
    const staffBody = el("shift-meter-staff-body");
    if (staffBody) staffBody.innerHTML = "";
    const staffHint = el("shift-meter-staff-hint");
    if (staffHint) staffHint.innerHTML = "";
    const totals = el("shift-meter-totals");
    if (totals) totals.innerHTML = "";
    const remarksEl = el("shift-meter-remarks");
    if (remarksEl) remarksEl.value = "";
    const attNote = el("shift-meter-attendance-note");
    if (attNote) {
      attNote.textContent = "";
      attNote.classList.add("hidden");
    }
    const reconcile = el("shift-meter-reconcile");
    if (reconcile) {
      reconcile.dataset.dailyPetrol = "";
      reconcile.dataset.dailyDiesel = "";
      reconcile.dataset.hasPetrol = "0";
      reconcile.dataset.hasDiesel = "0";
      reconcile.dataset.rateFallback = "0";
      reconcile.dataset.syncNote = "";
      reconcile.innerHTML = "";
    }
    updateShiftContext({ date, shift, hasSaved: false });
    applySupervisorLockUi(false, "");
  }

  async function loadStaff() {
    try {
      // Always fetch a fresh roster on shift page — stale staff list is confusing mid-shift
      const roster = await StaffEmployees.loadActiveRoster(supabaseClient, { useCache: false });
      if (Array.isArray(roster) && roster.length) {
        staffList = roster;
      } else if (!staffList.length) {
        staffList = roster || [];
      }
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.loadStaff" });
      if (!staffList.length) staffList = [];
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
    beginShiftLoadUi(date, shift);

    // History is independent — do not block the register UI on it
    void loadRecentHistory();

    try {
      const ledgerPromise =
        typeof ShiftStaffLedger?.fetchTotalsByEmployee === "function"
          ? ShiftStaffLedger.fetchTotalsByEmployee(date, shift).catch((ledgerErr) => {
              AppError.report(ledgerErr, { context: "MeterShiftReading.loadShift.ledger" });
              return null;
            })
          : Promise.resolve(null);

      const [readingsRes, lockInfo, ledgerMap] = await Promise.all([
        supabaseClient.rpc("get_meter_shift_readings", {
          p_date: date,
          p_shift: shift,
        }),
        isAdmin ? Promise.resolve(null) : fetchLockInfo(date, shift),
        ledgerPromise,
      ]);
      if (readingsRes.error) throw readingsRes.error;
      if (gen !== loadGeneration) return;

      const data = readingsRes.data;
      const savedNozzles = data?.nozzles || [];
      const resolvedLock = isAdmin
        ? { locked: false, reason: "" }
        : lockFromInfo(lockInfo);

      cashByEmployee = new Map();
      (data?.cash || []).forEach(setCashFromRow);
      applyShiftRemarks(data?.cash);
      if (ledgerMap) applyLedgerTotals(ledgerMap);

      // Resolve rates/openings without writing DOM — older in-flight loads must not clobber newer ones
      const [appliedRates, resolved] = await Promise.all([
        resolveShiftRates(data?.rates),
        resolveOpeningSuggestions(date, shift, data),
      ]);
      if (gen !== loadGeneration) return;

      writeShiftRatesToDom(appliedRates);

      const reconcile = el("shift-meter-reconcile");
      if (reconcile) {
        const petrolTotal = data?.daily_totals?.petrol?.total_sales;
        const dieselTotal = data?.daily_totals?.diesel?.total_sales;
        reconcile.dataset.dailyPetrol =
          petrolTotal != null && petrolTotal !== "" ? String(petrolTotal) : "";
        reconcile.dataset.dailyDiesel =
          dieselTotal != null && dieselTotal !== "" ? String(dieselTotal) : "";
        reconcile.dataset.hasPetrol = data?.daily_totals?.petrol?.has_complete_row
          ? "1"
          : "0";
        reconcile.dataset.hasDiesel = data?.daily_totals?.diesel?.has_complete_row
          ? "1"
          : "0";
        reconcile.dataset.rateFallback = appliedRates.fromFallback ? "1" : "0";
        reconcile.dataset.syncNote = "";
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

      shiftHasSavedRows = savedNozzles.length > 0;
      await ensureShiftStaffRoster(data);
      if (gen !== loadGeneration) return;

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
      lastStaffStructureKey = "";
      updateDerivedUi({ forceStaffRender: true });
      applySupervisorLockUi(resolvedLock.locked, resolvedLock.reason);
      updateShiftContext({ date, shift, hasSaved: shiftHasSavedRows });

      if (resolvedLock.locked) {
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
    } catch (error) {
      if (gen !== loadGeneration) return;
      AppError.report(error, { context: "MeterShiftReading.loadShift" });
      showMsg(error.message || "Could not load shift register.", true);
      applySupervisorLockUi(false, "");
    } finally {
      if (gen === loadGeneration && loading) loading.classList.add("hidden");
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
      showMsg(lockReason || MSG_DAY_CLOSING_SAVED, true);
      return;
    }

    // Re-check lock before save (per shift — empty afternoon stays writable)
    const lock = await resolveSupervisorLock(date, shift);
    if (lock.locked) {
      applySupervisorLockUi(true, lock.reason);
      showMsg(lock.reason, true);
      return;
    }

    // Pull latest cash / phone pay from DOM before save
    syncCashFromDom();

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

    // Morning re-save: afternoon openings are cascaded server-side; block if any
    // afternoon closing would fall below the new morning closing.
    if (shift === "morning") {
      try {
        const { data: afternoonRows, error: aftErr } = await supabaseClient
          .from("meter_shift_readings")
          .select("product, pump_no, nozzle_no, closing_meter")
          .eq("reading_date", date)
          .eq("shift", "afternoon");
        if (aftErr) throw aftErr;
        const afternoonByKey = new Map();
        (afternoonRows || []).forEach((r) => {
          afternoonByKey.set(nozzleKey(r.product, r.pump_no, r.nozzle_no), Number(r.closing_meter));
        });
        if (afternoonByKey.size) {
          for (const r of nozzles) {
            const key = nozzleKey(r.product, r.pump_no, r.nozzle_no);
            if (!afternoonByKey.has(key)) continue;
            const aftClose = afternoonByKey.get(key);
            if (aftClose < r.closing_meter - 0.001) {
              showMsg(
                `Cannot update morning: afternoon closing for ${PRODUCT_LABEL[r.product]} P${r.pump_no}·N${r.nozzle_no} (${aftClose}) is below the new morning closing (${r.closing_meter}). Fix afternoon first.`,
                true
              );
              return;
            }
          }
        }
      } catch (err) {
        AppError.report(err, { context: "MeterShiftReading.morningHandoffCheck" });
      }
    }

    const staffIds = new Set(nozzles.map((r) => r.employee_id));
    const remarks = (el("shift-meter-remarks")?.value || "").trim().slice(0, 500);
    // credit/expense are ledger-owned; server ignores client values and re-syncs from ledger
    const cash = Array.from(staffIds).map((employee_id) => {
      const entry = cashEntryFor(employee_id);
      return {
        employee_id,
        cash_collected: entry.cash,
        phone_pay: entry.phone_pay,
        remarks: remarks || null,
      };
    });

    const saveButtons = [el("shift-meter-save")].filter(Boolean);
    saveButtons.forEach((btn) => {
      btn.disabled = true;
      btn.textContent = "Saving…";
    });
    showMsg("", false);

    try {
      const { data, error } = await supabaseClient.rpc("save_meter_shift_readings", {
        p_date: date,
        p_shift: shift,
        p_nozzles: nozzles,
        p_cash: cash,
      });
      if (error) throw error;

      // Clean model: shift tables own meters; existing dsr_* meter cols refresh via RPC.
      const products = ["petrol", "diesel"];
      let refreshNote = "";
      if (typeof MeterReadingForms !== "undefined") {
        const touched = [
          ...new Set(nozzles.map((n) => n.product).filter(Boolean)),
        ];
        const dsrUpdated = Array.isArray(data?.dsr_meters_updated)
          ? data.dsr_meters_updated
          : [];
        if (dsrUpdated.length) {
          refreshNote = `Updated meters on ${dsrUpdated
            .map((p) => (p === "petrol" ? "MS" : "HSD"))
            .join(" · ")} sheet(s).`;
        } else if (touched.length) {
          refreshNote = `Meters prefilled on ${touched
            .map((p) => (p === "petrol" ? "MS" : "HSD"))
            .join(" · ")} — enter dip, stock & rate there.`;
        }
        if (typeof CacheInvalidation !== "undefined") {
          CacheInvalidation.invalidate("dsr");
          CacheInvalidation.invalidate("operational");
        }
        if (typeof DsrSalesBreakdown !== "undefined") {
          DsrSalesBreakdown.invalidate?.();
        }
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

      try {
        localStorage.setItem("shift-updated", String(Date.now()));
      } catch (_) {
        /* ignore quota / private mode */
      }

      cashByEmployee = new Map();
      (data?.cash || []).forEach(setCashFromRow);

      const savedCount = data?.saved_nozzles ?? nozzles.length;
      await loadShift();
      showMsg(
        `Saved ${savedCount} nozzle assignment(s) for ${shiftLabel(shift)}.${refreshNote ? " " + refreshNote : ""}`,
        false
      );
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.saveShift" });
      showMsg(error.message || "Save failed.", true);
    } finally {
      saveButtons.forEach((btn) => {
        btn.textContent = "Save shift";
        if (supervisorReadonly && !isAdmin) {
          btn.disabled = true;
          btn.title = lockReason || MSG_DAY_CLOSING_SAVED;
        } else {
          btn.disabled = false;
          btn.title = "";
        }
      });
    }
  }

  async function copyOpenings() {
    const date = el("shift-meter-date")?.value;
    const shift = el("shift-meter-shift")?.value;
    if (!date || !shift) return;

    if (supervisorReadonly && !isAdmin) {
      showMsg(lockReason || MSG_DAY_CLOSING_SAVED, true);
      return;
    }

    try {
      const { data } = await supabaseClient.rpc("get_meter_shift_readings", {
        p_date: date,
        p_shift: shift,
      });
      const resolved = await resolveOpeningSuggestions(date, shift, data || {});

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
      confirmMessage: `Delete shift register for ${formatDisplayDate?.(date) || date} (${shiftLabel(shift)})?\n\nNozzle meters and cash for this shift will be removed. MS/HSD forms will refresh from any remaining shifts.`,
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
        if (typeof MeterReadingForms !== "undefined") {
          try {
            await MeterReadingForms.refreshForShiftDate(date, ["petrol", "diesel"], {
              alignDate: false,
            });
          } catch (refreshErr) {
            AppError.report(refreshErr, {
              context: "MeterShiftReading.clearShift.refreshForms",
            });
          }
        }
        const curDate = el("shift-meter-date")?.value;
        const curShift = el("shift-meter-shift")?.value;
        if (curDate === date && curShift === shift) {
          await loadShift();
        } else {
          await loadRecentHistory();
        }
        showMsg(
          "Shift register deleted. Meter sheets refreshed from any remaining shifts.",
          false
        );
      },
      errorContext: { context: "MeterShiftReading.clearShift", date, shift },
    });
  }

  function staffNameById(id) {
    if (!id) return "—";
    const s = staffList.find((x) => x.id === id);
    return s?.name || "Staff";
  }

  function buildShiftViewModel(data) {
    const nozzles = data?.nozzles || [];
    const cashRows = data?.cash || [];
    const rates = {
      petrol: parseRateValue(data?.rates?.petrol),
      diesel: parseRateValue(data?.rates?.diesel),
    };

    const nameById = new Map();
    nozzles.forEach((n) => {
      if (n.employee_id && n.employee_name) nameById.set(n.employee_id, n.employee_name);
    });
    cashRows.forEach((c) => {
      if (c.employee_id && c.employee_name) nameById.set(c.employee_id, c.employee_name);
    });

    const cashByEmp = new Map();
    cashRows.forEach((c) => {
      cashByEmp.set(c.employee_id, {
        cash: Number(c.cash_collected) || 0,
        phone_pay: Number(c.phone_pay) || 0,
        credit: Number(c.credit_amount) || 0,
        expense: Number(c.expense_amount) || 0,
      });
    });

    const nozzleRows = nozzles.map((n) => ({
      product: n.product,
      pump_no: Number(n.pump_no),
      nozzle_no: Number(n.nozzle_no),
      employee_id: n.employee_id || "",
      employee_name: n.employee_name || nameById.get(n.employee_id) || staffNameById(n.employee_id),
      opening_meter: Number(n.opening_meter) || 0,
      closing_meter: Number(n.closing_meter) || 0,
      testing_litres: Number(n.testing_litres) || 0,
    }));

    const summary = computeStaffSummary(nozzleRows, rates, cashByEmp).map((s) => ({
      ...s,
      name: nameById.get(s.employee_id) || s.name,
    }));

    const sales = shiftSaleBreakdown(nozzleRows);
    let expected = null;
    if (rates.petrol != null || rates.diesel != null) {
      expected =
        (rates.petrol != null ? sales.petrolNet * rates.petrol : 0) +
        (rates.diesel != null ? sales.dieselNet * rates.diesel : 0);
    }
    const totalCashHard = summary.reduce((acc, s) => acc + (Number(s.cash) || 0), 0);
    const totalPhonePay = summary.reduce((acc, s) => acc + (Number(s.phone_pay) || 0), 0);
    const totalCredit = summary.reduce((acc, s) => acc + (Number(s.credit) || 0), 0);
    const totalExpense = summary.reduce((acc, s) => acc + (Number(s.expense) || 0), 0);
    const totalCash = summary.reduce((acc, s) => acc + (Number(s.collected) || 0), 0);
    const totalShort = summary.reduce((acc, s) => acc + (s.short != null ? s.short : 0), 0);
    const hasShort = summary.some((s) => s.short != null);
    const remarks = (cashRows || [])
      .map((c) => (c?.remarks != null ? String(c.remarks).trim() : ""))
      .find((t) => t) || "";

    return {
      nozzles: nozzleRows,
      summary,
      sales,
      rates,
      expected,
      totalCashHard,
      totalPhonePay,
      totalCredit,
      totalExpense,
      totalCash,
      totalShort,
      hasShort,
      remarks,
    };
  }

  function renderShiftViewBody(model) {
    const {
      nozzles,
      summary,
      sales,
      rates,
      expected,
      totalCashHard,
      totalPhonePay,
      totalCredit,
      totalExpense,
      totalCash,
      totalShort,
      hasShort,
      remarks,
    } = model;
    const shortClass = hasShort
      ? totalShort > 0.5
        ? "shift-short--shortage"
        : totalShort < -0.5
          ? "shift-short--surplus"
          : "shift-short--balanced"
      : "";

    const kpi = `
      <div class="shift-view-kpis">
        <div class="shift-view-kpi shift-total--petrol">
          <span>MS sold</span>
          <strong>${formatQuantity(sales.petrol)} L</strong>
        </div>
        <div class="shift-view-kpi shift-total--diesel">
          <span>HSD sold</span>
          <strong>${formatQuantity(sales.diesel)} L</strong>
        </div>
        <div class="shift-view-kpi">
          <span>Expected</span>
          <strong>${expected != null ? formatCurrency(expected) : "—"}</strong>
        </div>
        <div class="shift-view-kpi">
          <span>Total in</span>
          <strong>${formatCurrency(totalCash)}</strong>
          <em class="muted">${formatCurrency(totalCashHard)} cash · ${formatCurrency(totalPhonePay)} phone · ${formatCurrency(totalCredit)} credit · ${formatCurrency(totalExpense)} exp</em>
        </div>
        <div class="shift-view-kpi ${shortClass}">
          <span>Net short</span>
          <strong>${hasShort ? formatCurrency(totalShort) : "—"}</strong>
        </div>
      </div>
      <p class="muted shift-view-rates">
        Rates:
        MS ${rates.petrol != null ? formatCurrency(rates.petrol) + "/L" : "—"}
        · HSD ${rates.diesel != null ? formatCurrency(rates.diesel) + "/L" : "—"}
      </p>`;

    const nozzleBlocks = PRODUCTS.map((product) => {
      const rows = nozzles
        .filter((n) => n.product === product)
        .sort((a, b) => a.pump_no - b.pump_no || a.nozzle_no - b.nozzle_no);
      if (!rows.length) {
        return `<div class="shift-view-block shift-view-block--${product}">
          <h3>${PRODUCT_LABEL[product]} nozzles</h3>
          <p class="muted">No assignments.</p>
        </div>`;
      }
      const body = rows
        .map((r) => {
          const sale = Math.max(r.closing_meter - r.opening_meter, 0);
          return `<tr>
            <td class="shift-meter-label">P${r.pump_no} · N${r.nozzle_no}</td>
            <td class="shift-view-staff">${escapeHtml(r.employee_name || staffNameById(r.employee_id))}</td>
            <td class="num">${formatQuantity(r.opening_meter)}</td>
            <td class="num">${formatQuantity(r.closing_meter)}</td>
            <td class="num">${formatQuantity(sale)}</td>
          </tr>`;
        })
        .join("");
      return `<div class="shift-view-block shift-view-block--${product}">
        <h3>${PRODUCT_LABEL[product]} nozzles</h3>
        <div class="table-scroll">
          <table class="dsr-table meter-table compact shift-view-table">
            <thead>
              <tr>
                <th>Meter</th>
                <th>Staff</th>
                <th>Opening</th>
                <th>Closing</th>
                <th>Sale (L)</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
    }).join("");

    let staffHtml = "";
    if (!summary.length) {
      staffHtml = '<p class="muted">No staff cash recorded.</p>';
    } else {
      staffHtml = `<div class="shift-view-staff-list">
        ${summary
          .map((s) => {
            const shortClass = shortClassFor(s.short);
            return `<article class="shift-view-staff-card">
              <header>
                <strong>${escapeHtml(s.name)}</strong>
                <span class="muted">${escapeHtml(s.meters.join(" · "))}</span>
              </header>
              <div class="shift-view-staff-grid">
                <div><span class="muted">MS</span><strong>${formatQuantity(s.petrol_litres)} L</strong></div>
                <div><span class="muted">HSD</span><strong>${formatQuantity(s.diesel_litres)} L</strong></div>
                <div><span class="muted">Expected</span><strong>${s.expected == null ? "—" : formatCurrency(s.expected)}</strong></div>
                <div><span class="muted">Cash</span><strong>${formatCurrency(s.cash || 0)}</strong></div>
                <div><span class="muted">Phone pay</span><strong>${formatCurrency(s.phone_pay || 0)}</strong></div>
                <div><span class="muted">Credit</span><strong>${formatCurrency(s.credit || 0)}</strong></div>
                <div><span class="muted">Expenses</span><strong>${formatCurrency(s.expense || 0)}</strong></div>
                <div><span class="muted">Total</span><strong>${formatCurrency(s.collected || 0)}</strong></div>
                <div class="${shortClass}"><span class="muted">Short</span><strong>${s.short == null ? "—" : formatCurrency(s.short)}</strong></div>
              </div>
            </article>`;
          })
          .join("")}
      </div>`;
    }

    return `${kpi}
      <div class="shift-view-sections">
        ${nozzleBlocks}
        <div class="shift-view-block">
          <h3>Staff collections</h3>
          ${staffHtml}
        </div>
        ${
          remarks
            ? `<div class="shift-view-block">
          <h3>Comments</h3>
          <p class="shift-view-remarks">${escapeHtml(remarks)}</p>
        </div>`
            : ""
        }
      </div>`;
  }

  function closeShiftViewPopup() {
    const overlay = el("shift-view-overlay");
    if (!overlay || overlay.getAttribute("aria-hidden") === "true") return;
    shiftViewGeneration += 1;
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    shiftViewCurrent = { date: "", shift: "" };
    if (shiftViewFocusReturn && typeof shiftViewFocusReturn.focus === "function") {
      try {
        shiftViewFocusReturn.focus();
      } catch (_) {
        /* ignore */
      }
    }
    shiftViewFocusReturn = null;
  }

  async function openShiftViewPopup(date, shift, triggerEl) {
    if (!date || !shift) return;
    const overlay = el("shift-view-overlay");
    const body = el("shift-view-body");
    const title = el("shift-view-title");
    const subtitle = el("shift-view-subtitle");
    if (!overlay || !body) return;

    const gen = ++shiftViewGeneration;
    shiftViewFocusReturn = triggerEl || document.activeElement;
    shiftViewCurrent = { date, shift };

    const dateLabel =
      typeof formatDisplayDate === "function" ? formatDisplayDate(date) : date;
    if (title) title.textContent = `${dateLabel} · ${shiftLabel(shift)}`;
    if (subtitle) subtitle.textContent = "Read-only view of saved shift register";
    body.innerHTML = '<p class="muted">Loading…</p>';

    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    el("shift-view-close")?.focus();

    try {
      const [{ data, error }, lock] = await Promise.all([
        supabaseClient.rpc("get_meter_shift_readings", {
          p_date: date,
          p_shift: shift,
        }),
        resolveSupervisorLock(date, shift),
      ]);
      if (error) throw error;
      if (gen !== shiftViewGeneration) return;
      if (shiftViewCurrent.date !== date || shiftViewCurrent.shift !== shift) return;

      const nozzles = data?.nozzles || [];
      if (!nozzles.length && !(data?.cash || []).length) {
        body.innerHTML = '<p class="muted">No saved meters or cash for this shift.</p>';
        return;
      }

      if (subtitle) {
        subtitle.textContent = lock.locked
          ? "Saved · locked after day closing"
          : "Saved · can update until day closing";
      }

      body.innerHTML = renderShiftViewBody(buildShiftViewModel(data));
    } catch (err) {
      if (gen !== shiftViewGeneration) return;
      AppError.report(err, { context: "MeterShiftReading.openShiftViewPopup", date, shift });
      body.innerHTML = `<p class="error">${escapeHtml(err.message || "Could not load this shift.")}</p>`;
    }
  }

  function openShiftInEditor(date, shift) {
    closeShiftViewPopup();
    if (date && el("shift-meter-date")) el("shift-meter-date").value = date;
    if (shift && el("shift-meter-shift")) el("shift-meter-shift").value = shift;
    void loadShift();
    if (location.hash !== "#shift-readings") {
      location.hash = "shift-readings";
    }
    el("shift-meter-date")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }

  async function loadRecentHistory() {
    const tbody = el("shift-meter-history-body");
    if (!tbody) return;
    const historyGen = loadGeneration;

    const end = el("shift-meter-date")?.value || getLocalDateString();
    const endDate = new Date(end + "T12:00:00");
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 13);
    const start = toLocalDateString(startDate);

    try {
      const [nozRes, cashRes] = await Promise.all([
        supabaseClient
          .from("meter_shift_readings")
          .select("reading_date, shift, product, employee_id, opening_meter, closing_meter")
          .gte("reading_date", start)
          .lte("reading_date", end)
          .order("reading_date", { ascending: false }),
        supabaseClient
          .from("meter_shift_cash")
          .select("reading_date, shift, employee_id, cash_collected, phone_pay, credit_amount, expense_amount")
          .gte("reading_date", start)
          .lte("reading_date", end),
      ]);
      if (historyGen !== loadGeneration) return;
      if (nozRes.error) throw nozRes.error;
      if (cashRes.error) throw cashRes.error;
      const nozzles = nozRes.data;
      const cashRows = cashRes.data;

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
            phone_pay: 0,
            credit: 0,
            expense: 0,
          };
          groups.set(key, g);
        }
        const sale = Math.max(Number(n.closing_meter) - Number(n.opening_meter), 0);
        if (n.product === "petrol") g.petrol += sale;
        else g.diesel += sale;
        if (n.employee_id) g.staff.add(n.employee_id);
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
            phone_pay: 0,
            credit: 0,
            expense: 0,
          };
          groups.set(key, g);
        }
        g.cash += Number(c.cash_collected) || 0;
        g.phone_pay += Number(c.phone_pay) || 0;
        g.credit += Number(c.credit_amount) || 0;
        g.expense += Number(c.expense_amount) || 0;
        if (c.employee_id) g.staff.add(c.employee_id);
      }

      const rows = Array.from(groups.values()).sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        if (a.shift === b.shift) return 0;
        return a.shift === "afternoon" ? -1 : 1;
      });

      if (historyGen !== loadGeneration) return;

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 8 : 7}" class="muted">No shift register entries in the last 14 days.</td></tr>`;
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
          <th>Total ₹</th>
          <th>View</th>
          ${isAdmin ? "<th>Admin</th>" : ""}`;
      }

      tbody.innerHTML = rows
        .map((g) => {
          const total =
            (Number(g.cash) || 0) +
            (Number(g.phone_pay) || 0) +
            (Number(g.credit) || 0) +
            (Number(g.expense) || 0);
          const deleteCell = isAdmin
            ? `<td class="table-actions">${AdminDelete.buttonHtml({
                selector: "shift-history-delete",
                data: { date: g.date, shift: g.shift },
                label: "Delete",
                title: "Delete this shift register (admin)",
              })}</td>`
            : "";
          return `<tr>
            <td>${escapeHtml(formatDisplayDate?.(g.date) || g.date)}</td>
            <td>${escapeHtml(shiftLabel(g.shift))}</td>
            <td class="num">${formatQuantity(g.petrol)}</td>
            <td class="num">${formatQuantity(g.diesel)}</td>
            <td class="num">${g.staff.size}</td>
            <td class="num" title="Cash ${formatCurrency(g.cash)} · Phone ${formatCurrency(g.phone_pay)} · Credit ${formatCurrency(g.credit)} · Exp ${formatCurrency(g.expense)}">${formatCurrency(total)}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary shift-history-view"
                data-date="${escapeHtml(g.date)}" data-shift="${escapeHtml(g.shift)}"
                title="View this shift register">View</button>
            </td>
            ${deleteCell}
          </tr>`;
        })
        .join("");
    } catch (error) {
      AppError.report(error, { context: "MeterShiftReading.loadRecentHistory" });
      tbody.innerHTML = `<tr><td colspan="${isAdmin ? 8 : 7}" class="muted">Could not load history.</td></tr>`;
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
          ".shift-opening, .shift-closing, .shift-cash-collected, .shift-phone-pay, #shift-meter-rate-petrol, #shift-meter-rate-diesel"
        )
      ) {
        debouncedDerived();
      }
    });
    panel?.addEventListener("change", (e) => {
      if (supervisorReadonly && !isAdmin) return;
      if (e.target.matches?.(".shift-staff")) updateDerivedUi({ forceStaffRender: true });
    });

    el("shift-meter-history-body")?.addEventListener("click", (e) => {
      if (e.target.closest?.(".shift-history-delete")) return;
      const viewBtn = e.target.closest?.(".shift-history-view");
      if (viewBtn) {
        e.preventDefault();
        void openShiftViewPopup(viewBtn.dataset.date, viewBtn.dataset.shift, viewBtn);
        return;
      }
    });

    el("shift-view-close")?.addEventListener("click", closeShiftViewPopup);
    el("shift-view-dismiss")?.addEventListener("click", closeShiftViewPopup);
    el("shift-view-backdrop")?.addEventListener("click", closeShiftViewPopup);
    el("shift-view-open-editor")?.addEventListener("click", () => {
      if (!shiftViewCurrent.date || !shiftViewCurrent.shift) return;
      openShiftInEditor(shiftViewCurrent.date, shiftViewCurrent.shift);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const overlay = el("shift-view-overlay");
      if (overlay?.getAttribute("aria-hidden") === "false") {
        e.preventDefault();
        closeShiftViewPopup();
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
  }

  let initPromise = null;

  async function bootstrapShiftRegister(opts = {}) {
    isAdmin = opts.isAdmin === true;
    currentUserId = opts.userId || null;
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
    if (typeof ShiftStaffLedger?.init === "function") ShiftStaffLedger.init();
    await loadStaff();
    initialized = true;
  }

  async function init(opts = {}) {
    if (!initialized) {
      if (!initPromise) initPromise = bootstrapShiftRegister(opts);
      await initPromise;
    } else {
      isAdmin = opts.isAdmin === true;
      currentUserId = opts.userId || null;
    }
    await loadShift();
  }

  global.MeterShiftReading = { init, reload: loadShift };
})(typeof window !== "undefined" ? window : globalThis);
