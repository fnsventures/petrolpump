/* global requireAuth, applyRoleVisibility, window.supabaseClient, getLocalDateString, AppCache, AppError, escapeHtml, PumpSettings, loadPumpSettings, CacheInvalidation, AdminDelete, initPersistedDateInput, RECORD_DATE_KEYS, StaffEmployees, populateMonthYearSelects, readMonthYearValue, writeMonthYearValue, PayrollRules, formatCurrency */

const STATUS_LABELS = {
  present: "Present",
  half_day: "Half-day",
  leave: "Leave",
};

const MARK_STATUSES = ["present", "half_day", "leave"];

function displayStatus(status) {
  return typeof PayrollRules !== "undefined" ? PayrollRules.canonicalStatus(status) : status === "absent" ? "leave" : status;
}

/** Single-letter codes in the month matrix */
const STATUS_SHORT = {
  present: "P",
  half_day: "H",
  leave: "L",
};

const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function monthDayMetas(year, month) {
  const last = new Date(year, month, 0).getDate();
  const out = [];
  const p2 = (n) => String(n).padStart(2, "0");
  const ym = `${year}-${p2(month)}-`;
  let weekday = new Date(year, month - 1, 1).getDay();
  for (let d = 1; d <= last; d++) {
    out.push({ day: d, dateStr: `${ym}${p2(d)}`, weekday });
    weekday = (weekday + 1) % 7;
  }
  return out;
}

const MATRIX_STATUS_CLASS = {
  present: "att-cell att-cell-present",
  half_day: "att-cell att-cell-half",
  leave: "att-cell att-cell-leave",
};

function matrixCellClass(status) {
  return MATRIX_STATUS_CLASS[displayStatus(status)] ?? "att-cell att-cell-empty";
}

function matrixCellLetter(record) {
  if (!record) return "—";
  return STATUS_SHORT[displayStatus(record.status)] ?? "—";
}

function matrixOverDutySuffix(record) {
  if (typeof PayrollRules === "undefined" || !PayrollRules.isMarkedOverDuty(record)) return "";
  return "Over duty";
}

/** Tooltip line; shift names are passed in so the month grid does not re-read settings per cell. */
function matrixCellTitleWithCfg(record, morningName, afternoonName) {
  if (!record) return "Not marked";
  const parts = [STATUS_LABELS[displayStatus(record.status)] ?? displayStatus(record.status)];
  let sh = "—";
  if (record.shift === "morning") sh = morningName;
  else if (record.shift === "afternoon") sh = afternoonName;
  else if (record.shift) sh = record.shift;
  if (sh && sh !== "—") parts.push(sh);
  const n = (record.note ?? "").toString().trim();
  if (n) parts.push(n);
  const od = matrixOverDutySuffix(record);
  if (od) parts.push(od);
  return parts.join(" · ");
}

/** Small sub-line under P/H/L; does not change cell background (shift is secondary to status). */
function matrixShiftAbbrev(shiftValue) {
  if (shiftValue === "morning") return "Mo";
  if (shiftValue === "afternoon") return "Af";
  return "";
}

function matrixCellContents(record) {
  const letter = matrixCellLetter(record);
  const main = escapeHtml(letter);
  const shiftAbbr = record && letter !== "—" ? matrixShiftAbbrev(record.shift) : "";
  const showOd = Boolean(matrixOverDutySuffix(record));
  const parts = [`<span class="att-cell-main">${main}</span>`];
  if (showOd) parts.push(`<span class="att-cell-od">OD</span>`);
  else if (shiftAbbr) parts.push(`<span class="att-cell-shift">${escapeHtml(shiftAbbr)}</span>`);
  return `<div class="att-cell-stack">${parts.join("")}</div>`;
}

function getShiftConfig() {
  return PumpSettings.getShiftConfig();
}

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "attendance",
  });
  if (!auth) return;
  const isAdmin = auth.role === "admin";
  await loadPumpSettings();
  applyRoleVisibility(auth.role);

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "mark", validSections: ["mark", "history"] });
  }

  const attendanceDateInput = document.getElementById("attendance-date");
  const historyMonthSelect = document.getElementById("history-month-month");
  const historyYearSelect = document.getElementById("history-month-year");
  const attendanceBody = document.getElementById("attendance-body");
  const attendanceSummary = document.getElementById("attendance-summary");
  const attendanceMessage = document.getElementById("attendance-message");
  const attendanceError = document.getElementById("attendance-error");
  const saveAllBtn = document.getElementById("attendance-save-all");
  const historyMatrixWrap = document.getElementById("attendance-matrix-wrap");
  const historyMatrixSummary = document.getElementById("attendance-matrix-summary");
  const historyRefreshBtn = document.getElementById("history-refresh");
  const historyDownloadBtn = document.getElementById("history-download-csv");

  function getHistoryMonthValue() {
    return readMonthYearValue(historyMonthSelect, historyYearSelect);
  }

  function syncMarkRowClass(row) {
    if (!row) return;
    row.classList.remove("att-row-absent", "att-row-half", "att-row-leave", "att-row-overduty");
    const st = displayStatus(row.querySelector(".att-status")?.value ?? "present");
    if (st === "half_day") row.classList.add("att-row-half");
    else if (st === "leave") row.classList.add("att-row-leave");
    const od = row.querySelector(".att-over-duty");
    if (od) {
      const allow = st === "present";
      od.disabled = !allow || monthBundle?.overDutyColumnReady === false;
      if (!allow) od.checked = false;
      if (allow && od.checked) row.classList.add("att-row-overduty");
    }
    refreshRowEffect(row);
  }

  attendanceBody?.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.classList) return;
    if (t.classList.contains("att-status") || t.classList.contains("att-over-duty")) {
      syncMarkRowClass(t.closest("tr"));
    }
  });

  attendanceBody?.addEventListener("click", (e) => {
    const saveBtn = e.target.closest?.(".att-save-row");
    if (saveBtn && attendanceBody.contains(saveBtn)) {
      const date = attendanceDateInput?.value;
      if (date) saveRow(saveBtn, date);
      return;
    }

    const deleteBtn = e.target.closest?.(".att-delete-row");
    if (deleteBtn && attendanceBody.contains(deleteBtn)) {
      const date = attendanceDateInput?.value;
      if (date) deleteRow(deleteBtn, date);
    }
  });

  if (attendanceDateInput) {
    initPersistedDateInput(attendanceDateInput, RECORD_DATE_KEYS.attendance, { urlParam: "date" });
  }
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  populateMonthYearSelects(historyMonthSelect, historyYearSelect);
  writeMonthYearValue(historyMonthSelect, historyYearSelect, currentMonth);

  let staffList = [];
  let attendanceByDate = new Map();
  let monthBundle = { byEmployee: new Map(), rows: [], overDutyColumnReady: true, monthValue: "" };
  let lopExcludedIds = new Set();
  let lopExcludedMonth = "";

  async function loadLopExcludedIds(monthValue) {
    lopExcludedMonth = String(monthValue || "").slice(0, 7);
    if (
      typeof PayrollRules === "undefined" ||
      !lopExcludedMonth ||
      !PayrollRules.getPayrollConfig().lossOfPayEnabled
    ) {
      lopExcludedIds = new Set();
      return lopExcludedIds;
    }
    try {
      const result = await PayrollRules.fetchLopExclusions(window.supabaseClient, lopExcludedMonth);
      lopExcludedIds = result.ids;
    } catch (error) {
      lopExcludedIds = new Set();
      AppError.report(error, { context: "loadLopExcludedIds" });
    }
    return lopExcludedIds;
  }

  function payWithExclusion(staff, records, monthValue) {
    const pay = PayrollRules.computeMonthPay(staff.monthly_salary, records, monthValue);
    const key = String(monthValue || "").slice(0, 7);
    const excluded = key === lopExcludedMonth && lopExcludedIds.has(staff.id);
    return PayrollRules.applyLopExclusion(pay, excluded);
  }

  function payrollConfig() {
    return typeof PayrollRules !== "undefined" ? PayrollRules.getPayrollConfig() : null;
  }

  function renderPolicyBanner() {
    const el = document.getElementById("attendance-policy");
    if (!el || typeof PayrollRules === "undefined") return;
    const cfg = PayrollRules.getPayrollConfig();
    const summary = PayrollRules.policySummary(cfg);
    const lopChip = cfg.lossOfPayEnabled
      ? `<span class="payroll-chip is-deduct">${cfg.paidLeaveDaysPerMonth} paid leave / month</span>`
      : `<span class="payroll-chip is-off">Loss of pay off</span>`;
    const odChip = cfg.overDutyEnabled
      ? `<span class="payroll-chip is-earn">Over duty adds a day</span>`
      : `<span class="payroll-chip is-off">Over duty off</span>`;
    const settingsLink = isAdmin ? ` <a href="settings.html#attendance">Change in Settings</a>` : "";
    el.hidden = false;
    el.innerHTML = `<span class="payroll-policy-chips">${lopChip}${odChip}</span><p>${escapeHtml(summary.lossOfPay)} ${escapeHtml(summary.overDuty)} ${escapeHtml(summary.rate)}${settingsLink}</p>`;
  }

  function previewRecords(staffId, date, status, overDuty) {
    const kept = (monthBundle.byEmployee.get(staffId) || []).filter((row) => row.date !== date);
    kept.push({
      employee_id: staffId,
      date,
      status,
      over_duty: status === "present" && overDuty,
    });
    return kept;
  }

  function monthEffectHtml(staff, records, monthValue) {
    if (typeof PayrollRules === "undefined") return "";
    const pay = payWithExclusion(staff, records, monthValue);
    const lines = [`<span>Leave ${escapeHtml(PayrollRules.leaveUsageLabel(pay))}</span>`];
    if (pay.lossOfPayEnabled && pay.lopExcluded) {
      lines.push(`<span class="salary-lop-excluded">LOP excluded</span>`);
    } else if (pay.lossOfPayEnabled && pay.lopAmount > 0) {
      lines.push(`<span class="is-deduct">LOP ${escapeHtml(formatCurrency(pay.lopAmount))}</span>`);
    }
    if (pay.overDutyEnabled) {
      lines.push(
        `<span class="${pay.overDutyAmount > 0 ? "is-earn" : ""}">OD ${escapeHtml(formatCurrency(pay.overDutyAmount))}</span>`
      );
    }
    return `<div class="att-month-effect">${lines.join("")}</div>`;
  }

  function refreshRowEffect(row) {
    const cell = row?.querySelector(".att-month-effect-cell");
    const staffId = row?.getAttribute("data-staff-id");
    const date = attendanceDateInput?.value;
    if (!cell || !staffId || !date) return;
    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return;
    const status = row.querySelector(".att-status")?.value ?? "present";
    const overDuty = Boolean(row.querySelector(".att-over-duty")?.checked);
    cell.innerHTML = monthEffectHtml(staff, previewRecords(staffId, date, status, overDuty), date.slice(0, 7));
  }

  function rowOverDuty(row, status, staffId) {
    if (status !== "present") return false;
    const cfg = payrollConfig();
    if (cfg?.overDutyEnabled) return Boolean(row.querySelector(".att-over-duty")?.checked);
    const existing = attendanceByDate.get(staffId);
    return Boolean(existing && typeof PayrollRules !== "undefined" && PayrollRules.isMarkedOverDuty(existing));
  }

  function syncPayrollTableMode() {
    const table = document.getElementById("attendance-mark-table");
    const cfg = payrollConfig();
    const showPay = Boolean(cfg && (cfg.lossOfPayEnabled || cfg.overDutyEnabled));
    table?.classList.toggle("show-month-effect", showPay);
    table?.classList.toggle("show-od", Boolean(cfg?.overDutyEnabled));
  }

  async function loadStaffMembers() {
    try {
      staffList = await StaffEmployees.loadActiveRoster(window.supabaseClient, { useCache: true });
      return staffList;
    } catch (error) {
      AppError.report(error, { context: "loadStaffMembers" });
      staffList = [];
      return [];
    }
  }

  async function loadAttendanceForDate(date) {
    if (!date || typeof PayrollRules === "undefined") {
      attendanceByDate = new Map();
      return [];
    }
    try {
      const monthValue = date.slice(0, 7);
      const [bundle] = await Promise.all([
        PayrollRules.fetchMonthAttendance(window.supabaseClient, monthValue, { force: true }),
        loadLopExcludedIds(monthValue),
      ]);
      monthBundle = bundle;
    } catch (error) {
      AppError.report(error, { context: "loadAttendanceForDate" });
      attendanceByDate = new Map();
      return [];
    }
    const map = new Map();
    (monthBundle.rows || []).forEach((row) => {
      if (row.date === date) map.set(row.employee_id, row);
    });
    attendanceByDate = map;
    return monthBundle.rows || [];
  }

  function showMessage(msg, isError = false) {
    if (attendanceMessage) {
      attendanceMessage.textContent = isError ? "" : msg;
      attendanceMessage.classList.toggle("hidden", isError);
    }
    if (attendanceError) {
      attendanceError.textContent = isError ? msg : "";
      attendanceError.classList.toggle("hidden", !isError);
    }
  }

  function renderAttendanceTable(date) {
    if (!attendanceBody) return;
    renderPolicyBanner();
    syncPayrollTableMode();

    if (!staffList.length) {
      attendanceBody.innerHTML =
        '<tr><td colspan="7" class="muted">Add staff in <a href="staff.html">HR → Staff</a> first.</td></tr>';
      if (attendanceSummary) attendanceSummary.textContent = "";
      return;
    }

    const shiftConfig = getShiftConfig();
    const shiftOptions = [
      { value: "", label: "—" },
      { value: "morning", label: shiftConfig.morningName },
      { value: "afternoon", label: shiftConfig.afternoonName },
    ];

    const dayRecords = [];
    for (const s of staffList) {
      const r = attendanceByDate.get(s.id);
      if (r) dayRecords.push(r);
    }
    const counts =
      typeof PayrollRules !== "undefined"
        ? PayrollRules.countAttendance(dayRecords)
        : { present: 0, half: 0, leave: 0, overDuty: 0 };
    const present = counts.present;
    const halfDay = counts.half;
    const leave = counts.leave;
    const overDuty = counts.overDuty;
    const unmarked = staffList.length - present - halfDay - leave;

    if (attendanceSummary) {
      const parts = [];
      if (present) parts.push(`${present} present`);
      if (halfDay) parts.push(`${halfDay} half-day`);
      if (leave) parts.push(`${leave} on leave`);
      if (overDuty) parts.push(`${overDuty} over duty`);
      if (unmarked) parts.push(`${unmarked} not marked`);
      let text = parts.length ? `Summary: ${parts.join(", ")}.` : `No attendance recorded for ${date}.`;
      if (monthBundle.overDutyColumnReady === false) {
        text += " Over duty needs the latest database update before it can be saved.";
      }
      attendanceSummary.textContent = text;
    }

    attendanceBody.innerHTML = staffList
      .map((s) => {
        const r = attendanceByDate.get(s.id);
        const id = r?.id ?? "";
        const status = displayStatus(r?.status ?? "present");
        const shift = r?.shift ?? "";
        const note = escapeHtml((r?.note ?? "").toString());
        const name = escapeHtml(s.name);
        const role = s.role_display ? ` (${escapeHtml(s.role_display)})` : "";
        const odOn = Boolean(r && typeof PayrollRules !== "undefined" && PayrollRules.isMarkedOverDuty(r));
        const monthCell = monthEffectHtml(s, previewRecords(s.id, date, status, odOn), String(date || "").slice(0, 7));
        const options = MARK_STATUSES
          .map((st) => `<option value="${st}" ${st === status ? "selected" : ""}>${STATUS_LABELS[st]}</option>`)
          .join("");
        const shiftSelectOptions = shiftOptions
          .map((opt) => `<option value="${escapeHtml(opt.value)}" ${opt.value === shift ? "selected" : ""}>${escapeHtml(opt.label)}</option>`)
          .join("");
        const deleteBtn =
          isAdmin && id
            ? AdminDelete.buttonHtml({
                selector: "att-delete-row",
                data: { staffId: s.id, recordId: id },
                label: "Clear",
                title: "Clear attendance (admin)",
              })
            : "";
        const saveBtn = `<button type="button" class="att-save-row button-secondary" data-staff-id="${escapeHtml(s.id)}" data-record-id="${escapeHtml(id)}">Save</button>`;
        const actionsCell = deleteBtn ? `${saveBtn} ${deleteBtn}` : saveBtn;
        return `
          <tr data-staff-id="${escapeHtml(s.id)}" data-record-id="${escapeHtml(id)}">
            <td>${name}${role}</td>
            <td class="att-col-month att-month-effect-cell">${monthCell}</td>
            <td>
              <select class="att-status" data-staff-id="${escapeHtml(s.id)}" aria-label="Status for ${name}">
                ${options}
              </select>
            </td>
            <td>
              <select class="att-shift" data-staff-id="${escapeHtml(s.id)}" aria-label="Shift for ${name}">
                ${shiftSelectOptions}
              </select>
            </td>
            <td class="att-col-od">
              <label class="att-od-label">
                <input type="checkbox" class="att-over-duty" data-staff-id="${escapeHtml(s.id)}" ${odOn ? "checked" : ""} aria-label="Over duty for ${name}" />
                OD
              </label>
            </td>
            <td><input type="text" class="att-note" value="${note}" maxlength="200" placeholder="Note" data-staff-id="${escapeHtml(s.id)}" /></td>
            <td class="table-actions">${actionsCell}</td>
          </tr>
        `;
      })
      .join("");

    attendanceBody.querySelectorAll("tr[data-staff-id]").forEach(syncMarkRowClass);
  }

  async function deleteRow(btn, date) {
    if (!isAdmin) {
      alert("Only an admin can clear attendance records.");
      return;
    }

    const recordId = btn.getAttribute("data-record-id");
    const staffId = btn.getAttribute("data-staff-id");
    if (!recordId) return;

    const staff = staffList.find((s) => s.id === staffId);
    const staffName = staff?.name || "this staff member";
    const confirmed = confirm(
      `Clear attendance for ${staffName} on ${date}? This cannot be undone.`
    );
    if (!confirmed) return;

    btn.disabled = true;
    const { error } = await window.supabaseClient.from("employee_attendance").delete().eq("id", recordId);

    if (error) {
      btn.disabled = false;
      showMessage(AppError.getUserMessage(error), true);
      AppError.report(error, { context: "attendance deleteRow", recordId });
      return;
    }

    showMessage("Attendance cleared.");
    if (typeof CacheInvalidation !== "undefined") {
      CacheInvalidation.invalidate("operational");
    }
    await loadAttendanceForDate(date);
    renderAttendanceTable(date);
    if (getHistoryMonthValue()) {
      await loadHistoryMonth(getHistoryMonthValue());
    }
  }

  async function saveRow(btn, date) {
    const staffId = btn.getAttribute("data-staff-id");
    const recordId = btn.getAttribute("data-record-id");
    const row = attendanceBody?.querySelector(`tr[data-staff-id="${staffId}"]`);
    if (!row) return;

    const statusEl = row.querySelector(".att-status");
    const shiftEl = row.querySelector(".att-shift");
    const noteEl = row.querySelector(".att-note");

    const status = displayStatus(statusEl?.value ?? "present");
    const shift = (shiftEl?.value || "").trim() || null;
    const note = noteEl?.value?.trim() || null;

    const payload = {
      employee_id: staffId,
      date,
      status,
      shift,
      note,
      updated_at: new Date().toISOString(),
    };
    if (monthBundle.overDutyColumnReady !== false) {
      payload.over_duty = rowOverDuty(row, status, staffId);
    }
    if (auth?.session?.user?.id) payload.created_by = auth.session.user.id;

    let error;
    if (recordId) {
      const { error: updateErr } = await window.supabaseClient
        .from("employee_attendance")
        .update(payload)
        .eq("id", recordId);
      error = updateErr;
    } else {
      const { error: insertErr } = await window.supabaseClient.from("employee_attendance").insert(payload);
      error = insertErr;
    }

    if (error) {
      showMessage(AppError.getUserMessage(error), true);
      AppError.report(error, { context: "attendance saveRow" });
      return;
    }
    showMessage("Saved.");
    if (typeof CacheInvalidation !== "undefined") {
      CacheInvalidation.invalidate(["recent_activity"]);
    }
    loadAttendanceForDate(date).then(() => renderAttendanceTable(date));
  }

  async function saveAll(date) {
    if (!staffList.length) return;
    showMessage("");

    const rows = [];
    for (const s of staffList) {
      const row = attendanceBody?.querySelector(`tr[data-staff-id="${s.id}"]`);
      if (!row) continue;

      const statusEl = row.querySelector(".att-status");
      const shiftEl = row.querySelector(".att-shift");
      const noteEl = row.querySelector(".att-note");

      const status = displayStatus(statusEl?.value ?? "present");
      rows.push({
        employee_id: s.id,
        status,
        shift: (shiftEl?.value || "").trim() || "",
        note: noteEl?.value?.trim() || "",
        over_duty: rowOverDuty(row, status, s.id),
      });
    }

    if (!rows.length) {
      showMessage("No changes to save.");
      return;
    }

    const { data, error } = await window.supabaseClient.rpc("save_employee_attendance_batch", {
      p_date: date,
      p_rows: rows,
    });

    if (error) {
      showMessage(AppError.getUserMessage(error), true);
      AppError.report(error, { context: "attendance saveAll" });
      return;
    }

    const saved = Number(data?.saved ?? 0);
    showMessage(saved ? `Saved ${saved} record(s).` : "No changes to save.");
    if (typeof CacheInvalidation !== "undefined") {
      CacheInvalidation.invalidate(["recent_activity"]);
    }
    loadAttendanceForDate(date).then(() => renderAttendanceTable(date));
  }

  async function loadHistoryMonth(monthValue) {
    if (!historyMatrixWrap) return;

    if (!monthValue) {
      if (historyMatrixSummary) historyMatrixSummary.textContent = "";
      historyMatrixWrap.innerHTML = '<p class="muted att-matrix-placeholder">Select a month.</p>';
      return;
    }

    const [year, month] = monthValue.split("-").map(Number);
    let bundle;
    try {
      const [attendance] = await Promise.all([
        PayrollRules.fetchMonthAttendance(window.supabaseClient, monthValue, { force: true }),
        loadLopExcludedIds(monthValue),
      ]);
      bundle = attendance;
    } catch (error) {
      if (historyMatrixSummary) historyMatrixSummary.textContent = "";
      historyMatrixWrap.innerHTML = `<p class="error att-matrix-placeholder">${escapeHtml(AppError.getUserMessage(error))}</p>`;
      AppError.report(error, { context: "loadHistoryMonth" });
      return;
    }

    if (!staffList.length) {
      if (historyMatrixSummary) historyMatrixSummary.textContent = "";
      historyMatrixWrap.innerHTML =
        '<p class="muted att-matrix-placeholder">Add staff in <a href="staff.html">HR → Staff</a> first.</p>';
      const panel = document.getElementById("attendance-pay-panel");
      if (panel) panel.innerHTML = "";
      return;
    }

    const list = bundle.rows ?? [];
    const recordMap = new Map();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      recordMap.set(`${r.employee_id}|${r.date}`, r);
    }

    const dayMetas = monthDayMetas(year, month);
    const totalCells = staffList.length * dayMetas.length;
    const counts = PayrollRules.countAttendance(list);
    const nPresent = counts.present;
    const nHalf = counts.half;
    const nLeave = counts.leave;
    const nOver = counts.overDuty;
    const nUnmarked = Math.max(0, totalCells - recordMap.size);

    const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
    if (historyMatrixSummary) {
      historyMatrixSummary.textContent = `${monthLabel} · ${staffList.length} staff × ${dayMetas.length} days — Present ${nPresent}, half-day ${nHalf}, leave ${nLeave}, over duty ${nOver}, not marked ${nUnmarked}.`;
    }

    const shiftCfg = getShiftConfig();
    const morningName = shiftCfg.morningName;
    const afternoonName = shiftCfg.afternoonName;

    const headerParts = new Array(dayMetas.length);
    for (let i = 0; i < dayMetas.length; i++) {
      const dm = dayMetas[i];
      const wk = dm.weekday === 0 || dm.weekday === 6 ? " att-matrix-weekend" : "";
      headerParts[i] = `<th scope="col" class="att-matrix-day${wk}" title="${escapeHtml(dm.dateStr)}"><span class="att-matrix-daynum">${dm.day}</span><span class="att-matrix-wd">${WEEKDAY_SHORT[dm.weekday]}</span></th>`;
    }
    const headerDays = headerParts.join("");

    const bodyParts = new Array(staffList.length);
    for (let si = 0; si < staffList.length; si++) {
      const s = staffList[si];
      const name = escapeHtml(s.name);
      const role = s.role_display
        ? ` <span class="muted att-matrix-role">(${escapeHtml(s.role_display)})</span>`
        : "";
      const idPrefix = `${s.id}|`;
      const cellParts = new Array(dayMetas.length);
      for (let di = 0; di < dayMetas.length; di++) {
        const dm = dayMetas[di];
        const r = recordMap.get(idPrefix + dm.dateStr);
        const cls = matrixCellClass(r?.status);
        const title = matrixCellTitleWithCfg(r, morningName, afternoonName);
        const inner = matrixCellContents(r);
        cellParts[di] = `<td class="${cls}" title="${escapeHtml(title)}">${inner}</td>`;
      }
      bodyParts[si] = `<tr><th scope="row" class="att-matrix-staff-col">${name}${role}</th>${cellParts.join("")}</tr>`;
    }
    const bodyRows = bodyParts.join("");

    historyMatrixWrap.innerHTML = `<table class="attendance-matrix"><thead><tr><th scope="col" class="att-matrix-staff-col">Staff</th>${headerDays}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    renderHistoryPayPanel(year, month, bundle.byEmployee);
  }

  function renderHistoryPayPanel(year, month, byEmployee) {
    const panel = document.getElementById("attendance-pay-panel");
    if (!panel || typeof PayrollRules === "undefined") return;
    const cfg = PayrollRules.getPayrollConfig();
    const monthValue = `${year}-${String(month).padStart(2, "0")}`;

    let lopTotal = 0;
    let odTotal = 0;
    let excessPeople = 0;
    const body = staffList
      .map((staff) => {
        const pay = payWithExclusion(staff, byEmployee.get(staff.id) || [], monthValue);
        lopTotal += pay.lopAmount;
        odTotal += pay.overDutyAmount;
        if (pay.lopAmount > 0) excessPeople += 1;
        const lopCell =
          Number(staff.monthly_salary) <= 0
            ? "No salary"
            : pay.lopExcluded
              ? `Excluded · ${escapeHtml(formatCurrency(pay.suggestedLopAmount))}`
              : pay.lopAmount > 0
                ? `${escapeHtml(PayrollRules.formatDayCount(pay.lopDays))} · ${escapeHtml(formatCurrency(pay.lopAmount))}`
                : "—";
        const odCell =
          Number(staff.monthly_salary) > 0
            ? `${escapeHtml(PayrollRules.formatDayCount(pay.overDutyDays))} · ${escapeHtml(formatCurrency(pay.overDutyAmount))}`
            : "No salary";
        return `<tr>
          <td>${escapeHtml(staff.name)}</td>
          <td class="num">${pay.counts.present}</td>
          <td class="num">${pay.counts.half}</td>
          <td class="num">${escapeHtml(PayrollRules.leaveUsageLabel(pay))}</td>
          <td class="num att-col-lop${pay.lopExcluded ? " salary-lop-excluded" : pay.lopAmount > 0 ? " salary-money-deduct" : ""}">${lopCell}</td>
          <td class="num att-col-od${pay.overDutyAmount > 0 ? " salary-money-earn" : ""}">${odCell}</td>
        </tr>`;
      })
      .join("");

    const showLop = cfg.lossOfPayEnabled;
    const showOd = cfg.overDutyEnabled;
    panel.innerHTML = `
      <h3>Pay effect this month</h3>
      <p class="muted">Same day rate as salary. Leave inside the monthly allowance is not a deduction. Unmarked days are ignored. ${escapeHtml(PayrollRules.policySummary(cfg).rate)}</p>
      <div class="att-pay-kpis">
        ${showLop ? `<div class="att-pay-kpi is-deduct"><span>Loss of pay</span><strong>${escapeHtml(formatCurrency(lopTotal))}</strong></div>` : ""}
        ${showOd ? `<div class="att-pay-kpi is-earn"><span>Over-duty pay</span><strong>${escapeHtml(formatCurrency(odTotal))}</strong></div>` : ""}
        ${showLop ? `<div class="att-pay-kpi"><span>Staff with a deduction</span><strong>${excessPeople}</strong></div>` : ""}
      </div>
      <div class="table-wrap">
        <table class="attendance-pay-table${showLop ? " show-lop" : ""}${showOd ? " show-od" : ""}">
          <thead>
            <tr>
              <th>Staff</th>
              <th class="num">Present</th>
              <th class="num">Half-day</th>
              <th class="num">Leave</th>
              <th class="num att-col-lop">Loss of pay</th>
              <th class="num att-col-od">Over duty</th>
            </tr>
          </thead>
          <tbody>${body || '<tr><td colspan="6" class="muted">No staff.</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  async function downloadHistoryCsv(monthValue) {
    if (!monthValue) return;
    const [year, month] = monthValue.split("-").map(Number);

    try {
      const bundle = await PayrollRules.fetchMonthAttendance(window.supabaseClient, monthValue, { force: true });
      const list = [...(bundle.rows ?? [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const staffById = new Map(staffList.map((s) => [s.id, s]));
      const missingIds = [
        ...new Set(list.map((r) => r.employee_id).filter((id) => id && !staffById.has(id))),
      ];
      if (missingIds.length) {
        const resolved = await StaffEmployees.resolveEmployeesByIds(window.supabaseClient, missingIds);
        resolved.forEach((emp, id) => staffById.set(id, emp));
      }
      const cfg = getShiftConfig();
      const shiftLabelCsv = (shift) => {
        if (!shift) return "—";
        if (shift === "morning") return cfg.morningName;
        if (shift === "afternoon") return cfg.afternoonName;
        return shift;
      };
      const headers = ["Date", "Staff", "Status", "Shift", "Over duty", "Note"];
      const rows = list.map((r) => {
        const staff = staffById.get(r.employee_id);
        const name = StaffEmployees.displayName(staff);
        const od = typeof PayrollRules !== "undefined" && PayrollRules.isMarkedOverDuty(r) ? "Yes" : "No";
        return [
          r.date,
          name,
          STATUS_LABELS[displayStatus(r.status)] ?? displayStatus(r.status),
          shiftLabelCsv(r.shift),
          od,
          (r.note ?? "").toString().replace(/"/g, '""'),
        ];
      });
      const csv = [headers.join(","), ...rows.map((row) => row.map((c) => `"${c}"`).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `attendance_${year}-${String(month).padStart(2, "0")}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showMessage(AppError.getUserMessage(err), true);
    }
  }

  await loadStaffMembers();
  const initialDate = attendanceDateInput?.value ?? getLocalDateString();
  await loadAttendanceForDate(initialDate);
  renderAttendanceTable(initialDate);

  attendanceDateInput?.addEventListener("change", async () => {
    const date = attendanceDateInput.value;
    if (!date) return;
    await loadAttendanceForDate(date);
    renderAttendanceTable(date);
  });

  saveAllBtn?.addEventListener("click", () => {
    const date = attendanceDateInput?.value;
    if (date) saveAll(date);
  });

  function onHistoryMonthChange() {
    const monthValue = getHistoryMonthValue();
    if (monthValue) loadHistoryMonth(monthValue);
  }

  historyMonthSelect?.addEventListener("change", onHistoryMonthChange);
  historyYearSelect?.addEventListener("change", onHistoryMonthChange);

  async function refreshHistoryMonth() {
    const monthValue = getHistoryMonthValue();
    if (historyRefreshBtn) {
      historyRefreshBtn.disabled = true;
      historyRefreshBtn.setAttribute("aria-busy", "true");
    }
    try {
      await loadStaffMembers();
      await loadHistoryMonth(monthValue);
    } finally {
      if (historyRefreshBtn) {
        historyRefreshBtn.disabled = false;
        historyRefreshBtn.removeAttribute("aria-busy");
      }
    }
  }

  historyRefreshBtn?.addEventListener("click", () => {
    refreshHistoryMonth();
  });

  historyDownloadBtn?.addEventListener("click", () => {
    downloadHistoryCsv(getHistoryMonthValue());
  });

  loadHistoryMonth(getHistoryMonthValue());
});
