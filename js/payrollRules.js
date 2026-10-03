/* global AppConfig, PumpSettings */
/**
 * Monthly leave allowance, loss of pay, and over-duty pay.
 * Day rate = monthly salary ÷ (calendar days, or a fixed divisor).
 * Days that are not marked do not change pay.
 */
(function (global) {
  function roundMoney(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function defaults() {
    return (
      global.AppConfig?.DEFAULT_PAYROLL || {
        lossOfPayEnabled: true,
        paidLeaveDaysPerMonth: 2,
        overDutyEnabled: true,
        dayRateBasis: "calendar",
        fixedDaysInMonth: 30,
      }
    );
  }

  /** Missing keys use defaults. An explicit false in saved settings stays off. */
  function getPayrollConfig() {
    const saved =
      (typeof PumpSettings !== "undefined" && PumpSettings.getCachedSync
        ? PumpSettings.getCachedSync().payroll
        : null) || {};
    const d = defaults();
    const lop =
      saved.lossOfPayEnabled === undefined ? d.lossOfPayEnabled !== false : saved.lossOfPayEnabled === true;
    const od =
      saved.overDutyEnabled === undefined ? d.overDutyEnabled !== false : saved.overDutyEnabled === true;
    return {
      lossOfPayEnabled: lop,
      paidLeaveDaysPerMonth: clampInt(
        saved.paidLeaveDaysPerMonth === undefined ? d.paidLeaveDaysPerMonth : saved.paidLeaveDaysPerMonth,
        0,
        31,
        d.paidLeaveDaysPerMonth
      ),
      overDutyEnabled: od,
      dayRateBasis:
        saved.dayRateBasis === "fixed" || saved.dayRateBasis === "calendar"
          ? saved.dayRateBasis
          : d.dayRateBasis === "fixed"
            ? "fixed"
            : "calendar",
      fixedDaysInMonth: clampInt(
        saved.fixedDaysInMonth === undefined ? d.fixedDaysInMonth : saved.fixedDaysInMonth,
        1,
        31,
        d.fixedDaysInMonth
      ),
    };
  }

  function rulesAffectPay(config) {
    const cfg = config || getPayrollConfig();
    return cfg.lossOfPayEnabled || cfg.overDutyEnabled;
  }

  function parseMonth(monthValue) {
    const key = String(monthValue || "").slice(0, 7);
    const [year, month] = key.split("-").map(Number);
    if (!year || !month || month < 1 || month > 12) return null;
    const calendarDays = new Date(year, month, 0).getDate();
    return { year, month, key, calendarDays };
  }

  function isOverDuty(record) {
    const value = record?.over_duty;
    return value === true || value === "true" || value === "t" || value === 1 || value === "1";
  }

  /** Over duty only counts on a present day. */
  function isMarkedOverDuty(record) {
    return record?.status === "present" && isOverDuty(record);
  }

  /** Older rows stored "absent". That is the same day off as leave. */
  function canonicalStatus(status) {
    return status === "absent" ? "leave" : status;
  }

  function isMissingOverDutyColumn(error) {
    const msg = String(error?.message || "");
    return /over_duty/i.test(msg);
  }

  function emptyCounts() {
    return { present: 0, half: 0, leave: 0, overDuty: 0, marked: 0 };
  }

  function countAttendance(records) {
    const counts = emptyCounts();
    (records || []).forEach((record) => {
      const status = canonicalStatus(record?.status);
      if (!status) return;
      counts.marked += 1;
      if (status === "present") counts.present += 1;
      else if (status === "half_day") counts.half += 1;
      else if (status === "leave") counts.leave += 1;
      if (isMarkedOverDuty(record)) counts.overDuty += 1;
    });
    return counts;
  }

  function formatDayCount(value) {
    const n = Math.round(Number(value) * 10) / 10;
    if (!Number.isFinite(n)) return "0";
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function computeMonthPay(monthlySalary, records, monthValue, config) {
    const cfg = config || getPayrollConfig();
    const parsed = parseMonth(monthValue) || { year: 0, month: 0, key: "", calendarDays: 30 };
    const inMonth = parsed.key
      ? (records || []).filter((row) => String(row?.date || "").startsWith(parsed.key))
      : records || [];
    const counts = countAttendance(inMonth);
    const divisor =
      cfg.dayRateBasis === "fixed" ? cfg.fixedDaysInMonth : Math.max(1, parsed.calendarDays);
    const gross = roundMoney(Math.max(0, Number(monthlySalary) || 0));
    const perDayExact = divisor > 0 ? gross / divisor : 0;
    const excessLeave = cfg.lossOfPayEnabled ? Math.max(0, counts.leave - cfg.paidLeaveDaysPerMonth) : 0;
    const halfLopDays = cfg.lossOfPayEnabled ? counts.half * 0.5 : 0;
    const lopDays = excessLeave + halfLopDays;
    const overDutyDays = cfg.overDutyEnabled ? counts.overDuty : 0;
    const lopAmount = roundMoney(lopDays * perDayExact);
    const overDutyAmount = roundMoney(overDutyDays * perDayExact);
    return {
      ...parsed,
      counts,
      config: cfg,
      divisor,
      perDay: roundMoney(perDayExact),
      perDayExact,
      gross,
      paidLeaveAllowance: cfg.paidLeaveDaysPerMonth,
      paidLeaveUsed: Math.min(counts.leave, cfg.paidLeaveDaysPerMonth),
      leaveRemaining: Math.max(0, cfg.paidLeaveDaysPerMonth - counts.leave),
      excessLeave,
      halfLopDays,
      lopDays,
      lopAmount,
      overDutyDays,
      overDutyAmount,
      lossOfPayEnabled: cfg.lossOfPayEnabled,
      overDutyEnabled: cfg.overDutyEnabled,
    };
  }

  /**
   * Take-home after fixed employee PF, loss of pay, and over duty.
   * PF is the configured monthly amount, capped so net is never negative.
   */
  function settleTakeHome(monthlySalary, lopAmount, overDutyAmount, employeePfFixed) {
    const gross = roundMoney(Math.max(0, Number(monthlySalary) || 0));
    const overDuty = roundMoney(Math.max(0, Number(overDutyAmount) || 0));
    const lop = roundMoney(Math.max(0, Number(lopAmount) || 0));
    const earnings = roundMoney(gross + overDuty);
    const beforePf = roundMoney(Math.max(0, earnings - lop));
    const pfCap = roundMoney(Math.max(0, Number(employeePfFixed) || 0));
    const employeePf = beforePf > 0 ? Math.min(pfCap, beforePf) : 0;
    const net = roundMoney(Math.max(0, beforePf - employeePf));
    return { gross, earnings, lopAmount: lop, overDutyAmount: overDuty, beforePf, employeePf, net };
  }

  /**
   * Default keeps the calculated deduction. An admin exclusion zeros it for payable pay
   * and keeps the calculated amount on suggestedLopAmount.
   */
  function applyLopExclusion(pay, excluded) {
    if (!pay) return pay;
    const suggestedLopAmount = roundMoney(Math.max(0, Number(pay.suggestedLopAmount ?? pay.lopAmount) || 0));
    const lopExcluded = excluded === true && suggestedLopAmount > 0;
    return {
      ...pay,
      suggestedLopAmount,
      lopExcluded,
      lopAmount: lopExcluded ? 0 : suggestedLopAmount,
    };
  }

  function isMissingLopExclusionTable(error) {
    const msg = String(error?.message || error?.details || "");
    return error?.code === "PGRST205" || error?.code === "42P01" || /salary_lop_exclusions/i.test(msg);
  }

  let lopExclusionCacheKey = "";
  let lopExclusionCacheValue = null;

  function emptyLopExclusions() {
    return { ids: new Set(), ready: true };
  }

  /**
   * Employee ids whose calculated loss of pay is excluded for this salary month.
   * One month is cached. Skips the query when loss of pay is off.
   */
  async function fetchLopExclusions(client, monthValue, options) {
    if (!getPayrollConfig().lossOfPayEnabled) return emptyLopExclusions();
    const parsed = parseMonth(monthValue);
    if (!client || !parsed) return emptyLopExclusions();
    const force = options?.force === true;
    if (!force && lopExclusionCacheKey === parsed.key && lopExclusionCacheValue) {
      return lopExclusionCacheValue;
    }
    const { data, error } = await client
      .from("salary_lop_exclusions")
      .select("employee_id")
      .eq("salary_month", `${parsed.key}-01`);
    if (error) {
      if (isMissingLopExclusionTable(error)) return { ids: new Set(), ready: false };
      const err = error;
      err.payrollContext = "lop-exclusion";
      throw err;
    }
    const ids = new Set();
    (data || []).forEach((row) => {
      if (row.employee_id) ids.add(row.employee_id);
    });
    const value = { ids, ready: true };
    lopExclusionCacheKey = parsed.key;
    lopExclusionCacheValue = value;
    return value;
  }

  function invalidateLopExclusionCache() {
    lopExclusionCacheKey = "";
    lopExclusionCacheValue = null;
  }

  /** Keep the cached month in step after an exclude or include, without another read. */
  function setCachedLopExclusion(monthValue, employeeId, excluded) {
    const parsed = parseMonth(monthValue);
    if (!parsed || !employeeId) return;
    if (lopExclusionCacheKey !== parsed.key || !lopExclusionCacheValue?.ids) {
      invalidateLopExclusionCache();
      return;
    }
    const ids = new Set(lopExclusionCacheValue.ids);
    if (excluded) ids.add(employeeId);
    else ids.delete(employeeId);
    lopExclusionCacheValue = { ids, ready: lopExclusionCacheValue.ready !== false };
  }

  function lopBreakdownLabel(pay) {
    if (!pay?.lossOfPayEnabled) return "Loss of pay is off";
    if (pay.lopExcluded) {
      return `${formatDayCount(pay.lopDays)} day calculated, excluded from this month's salary`;
    }
    const parts = [];
    if (pay.excessLeave > 0) {
      parts.push(
        `${formatDayCount(pay.excessLeave)} leave over the ${formatDayCount(pay.paidLeaveAllowance)}-day allowance`
      );
    }
    if (pay.halfLopDays > 0) parts.push(`${formatDayCount(pay.halfLopDays)} half-day`);
    if (!parts.length) {
      const left = formatDayCount(pay.leaveRemaining);
      return `Within allowance · ${left} paid leave day${pay.leaveRemaining === 1 ? "" : "s"} left`;
    }
    return parts.join(" · ");
  }

  function leaveUsageLabel(pay) {
    const used = pay?.counts?.leave || 0;
    if (!pay?.lossOfPayEnabled) {
      return used ? `${formatDayCount(used)} leave` : "—";
    }
    return `${formatDayCount(used)} of ${formatDayCount(pay.paidLeaveAllowance)}`;
  }

  function dayRateLabel(pay) {
    if (!pay) return "";
    const basis = pay.config?.dayRateBasis === "fixed" ? "fixed days" : "calendar days";
    return `${pay.divisor} ${basis}`;
  }

  function policySummary(config) {
    const cfg = config || getPayrollConfig();
    const basis =
      cfg.dayRateBasis === "fixed"
        ? `monthly salary ÷ ${cfg.fixedDaysInMonth}`
        : "monthly salary ÷ days in that month";
    return {
      lossOfPay: cfg.lossOfPayEnabled
        ? `${cfg.paidLeaveDaysPerMonth} paid leave day${cfg.paidLeaveDaysPerMonth === 1 ? "" : "s"} a month. Only leave past that is loss of pay. A half-day counts as half. An admin can exclude that deduction for one person and month.`
        : "Loss of pay is off.",
      overDuty: cfg.overDutyEnabled
        ? "Each present day marked over duty adds one day’s salary."
        : "Over-duty pay is off.",
      rate: `Day rate is ${basis}. Unmarked days are ignored.`,
    };
  }

  let attendanceCacheKey = "";
  let attendanceCacheValue = null;

  function groupRows(rows) {
    const byEmployee = new Map();
    (rows || []).forEach((row) => {
      const id = row.employee_id;
      if (!id) return;
      const list = byEmployee.get(id);
      if (list) list.push(row);
      else byEmployee.set(id, [row]);
    });
    return byEmployee;
  }

  async function fetchMonthAttendance(client, monthValue, options) {
    const parsed = parseMonth(monthValue);
    if (!client || !parsed) {
      return { byEmployee: new Map(), rows: [], overDutyColumnReady: true, monthValue: "" };
    }
    const force = options?.force === true;
    if (!force && attendanceCacheKey === parsed.key && attendanceCacheValue) {
      return attendanceCacheValue;
    }
    const start = `${parsed.key}-01`;
    const end = `${parsed.key}-${String(parsed.calendarDays).padStart(2, "0")}`;
    const fullSelect = "id, employee_id, date, status, shift, note, over_duty";
    let response = await client
      .from("employee_attendance")
      .select(fullSelect)
      .gte("date", start)
      .lte("date", end);
    let overDutyColumnReady = true;
    if (response.error && isMissingOverDutyColumn(response.error)) {
      overDutyColumnReady = false;
      response = await client
        .from("employee_attendance")
        .select("id, employee_id, date, status, shift, note")
        .gte("date", start)
        .lte("date", end);
    }
    if (response.error) {
      const err = response.error;
      err.payrollContext = "attendance";
      throw err;
    }
    const rows = (response.data || []).map((row) => ({
      ...row,
      over_duty: overDutyColumnReady ? isOverDuty(row) : false,
    }));
    const value = {
      byEmployee: groupRows(rows),
      rows,
      overDutyColumnReady,
      monthValue: parsed.key,
    };
    attendanceCacheKey = parsed.key;
    attendanceCacheValue = value;
    return value;
  }

  function invalidateAttendanceCache() {
    attendanceCacheKey = "";
    attendanceCacheValue = null;
  }

  const PayrollRules = {
    roundMoney,
    clampInt,
    getPayrollConfig,
    rulesAffectPay,
    parseMonth,
    isOverDuty,
    isMarkedOverDuty,
    canonicalStatus,
    isMissingOverDutyColumn,
    countAttendance,
    formatDayCount,
    computeMonthPay,
    settleTakeHome,
    applyLopExclusion,
    isMissingLopExclusionTable,
    fetchLopExclusions,
    invalidateLopExclusionCache,
    setCachedLopExclusion,
    lopBreakdownLabel,
    leaveUsageLabel,
    dayRateLabel,
    policySummary,
    fetchMonthAttendance,
    invalidateAttendanceCache,
  };

  global.PayrollRules = PayrollRules;
})(typeof window !== "undefined" ? window : globalThis);
