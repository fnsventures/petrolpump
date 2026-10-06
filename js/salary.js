/* global requireAuth, applyRoleVisibility, window.supabaseClient, formatCurrency, formatMonthLabel, AppCache, AppError, AppDialog, getLocalDateString, toLocalDateString, escapeHtml, formatDisplayDate, PumpSettings, loadPumpSettings, AppConfig, initPageSections, populateMonthYearSelects, readMonthYearValue, writeMonthYearValue, StaffEmployees, CacheInvalidation, AdminDelete, getMonthRange, initPersistedDateInput, finishRecordFormSave, RECORD_DATE_KEYS, PrintUtils, PayrollRules, formRequestId, clearFormRequestId */

/** YYYY-MM or YYYY-MM-DD → YYYY-MM-01 (pay period key stored in DB). */
function normalizeSalaryMonth(monthValue) {
  if (!monthValue) return "";
  const [year, monthPart] = String(monthValue).split("-");
  if (!year || !monthPart) return "";
  const month = String(monthPart).padStart(2, "0").slice(0, 2);
  return `${year}-${month}-01`;
}

function salaryMonthKey(monthValue) {
  const normalized = normalizeSalaryMonth(monthValue);
  return normalized ? normalized.slice(0, 7) : "";
}

/** Suggest a payment date when paying salary for a given month. */
function suggestPaymentDate(salaryMonthValue) {
  const today = getLocalDateString();
  const key = salaryMonthKey(salaryMonthValue);
  const currentKey = today.slice(0, 7);
  if (!key || key === currentKey) return today;
  if (key < currentKey) {
    const [year, month] = key.split("-").map(Number);
    return toLocalDateString(new Date(year, month, 0));
  }
  return today;
}

function isMissingSalaryMonthColumn(error) {
  const msg = String(error?.message || "");
  return /salary_month/i.test(msg) || error?.code === "PGRST204";
}

function getStaffSalaryMonthContext(staff, paid, monthValue, records, lopExcluded) {
  const balance = computeSalaryBalance(staff.monthly_salary, paid, staff, monthValue, records, {
    lopExcluded,
  });
  const status = salaryStatusFromBalance(balance);
  return {
    label: status.label,
    className: status.className,
    payable: balance.salary,
    pending: status.pending,
    advance: status.advance,
    paid: Number(paid ?? 0),
    balance,
  };
}

const SALARY_SLIP_PRINT_CSS = "css/salary-slip-print.css";

function slipAssetUrl(path) {
  return new URL(path, window.location.href).href;
}

function getPfSettings() {
  const s = PumpSettings.getStation();
  const def = AppConfig.DEFAULT_STATION;
  return {
    establishmentCode: (s.pfEstablishmentCode || def.pfEstablishmentCode || "").trim(),
  };
}

function roundMoney(value) {
  return PayrollRules.roundMoney(value);
}

/** Fixed monthly PF from HR → Staff (e.g. ₹200 or ₹150 per employee). */
function computePfBreakdown(monthlySalary, staff) {
  const gross = roundMoney(Math.max(0, Number(monthlySalary ?? 0)));
  const fixed = roundMoney(Math.max(0, Number(staff?.pf_contribution ?? 0)));
  const employeePf = gross > 0 ? Math.min(fixed, gross) : 0;
  const employerPf = fixed;
  const netSalary = roundMoney(Math.max(0, gross - employeePf));
  return { gross, employeePf, employerPf, netSalary, fixedAmount: fixed };
}

function getPayPeriodLabel(monthValue) {
  if (!monthValue) return "—";
  const [year, month] = monthValue.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const fmt = (d) =>
    d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

const AMOUNT_WORDS_ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const AMOUNT_WORDS_TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function amountWordsUnder100(n) {
  if (n < 20) return AMOUNT_WORDS_ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${AMOUNT_WORDS_TENS[tens]}${ones ? ` ${AMOUNT_WORDS_ONES[ones]}` : ""}`.trim();
}

function amountWordsUnder1000(n) {
  if (n < 100) return amountWordsUnder100(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return `${AMOUNT_WORDS_ONES[hundreds]} Hundred${rest ? ` ${amountWordsUnder100(rest)}` : ""}`.trim();
}

function amountWordsIndian(n) {
  if (n === 0) return "";
  if (n < 1000) return amountWordsUnder1000(n);
  if (n < 100000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    return `${amountWordsUnder1000(thousands)} Thousand${rest ? ` ${amountWordsUnder1000(rest)}` : ""}`.trim();
  }
  if (n < 10000000) {
    const lakhs = Math.floor(n / 100000);
    const rest = n % 100000;
    return `${amountWordsIndian(lakhs)} Lakh${rest ? ` ${amountWordsIndian(rest)}` : ""}`.trim();
  }
  const crores = Math.floor(n / 10000000);
  const rest = n % 10000000;
  return `${amountWordsIndian(crores)} Crore${rest ? ` ${amountWordsIndian(rest)}` : ""}`.trim();
}

function amountInWordsINR(amount) {
  const n = roundMoney(Math.abs(Number(amount) || 0));
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  if (rupees === 0 && paise === 0) return "Zero Rupees Only";
  let words = amountWordsIndian(rupees);
  words = words ? `${words} Rupees` : "Zero Rupees";
  if (paise > 0) {
    words += ` and ${amountWordsIndian(paise)} Paise`;
  }
  return `${words} Only`;
}

function monthPayFor(monthlySalary, monthValue, records) {
  if (typeof PayrollRules === "undefined") return null;
  return PayrollRules.computeMonthPay(monthlySalary, records || [], monthValue);
}

function computeSalaryBalance(monthlySalary, paid, staff, monthValue, records, options) {
  const gross = Number(monthlySalary ?? 0);
  const pf = staff ? computePfBreakdown(gross, staff) : { employeePf: 0, employerPf: 0, netSalary: gross, gross, fixedAmount: 0 };
  const payRaw = monthPayFor(gross, monthValue, records);
  const pay =
    payRaw && typeof PayrollRules !== "undefined"
      ? PayrollRules.applyLopExclusion(payRaw, options?.lopExcluded === true)
      : payRaw;
  const settled =
    typeof PayrollRules !== "undefined"
      ? PayrollRules.settleTakeHome(gross, pay?.lopAmount || 0, pay?.overDutyAmount || 0, pf.employeePf)
      : {
          gross,
          earnings: gross,
          lopAmount: 0,
          overDutyAmount: 0,
          beforePf: gross,
          employeePf: pf.employeePf,
          net: pf.netSalary,
        };
  const payable = settled.net;
  const totalPaid = Number(paid ?? 0);
  const pending = Math.max(0, payable - totalPaid);
  const advance = Math.max(0, totalPaid - payable);
  return { salary: payable, gross, totalPaid, pending, advance, pf, pay, settled };
}

function salaryStatusFromBalance(balance) {
  const { salary, gross, totalPaid, pending, advance, settled } = balance;
  const hasEarnings = gross > 0 || (settled?.overDutyAmount || 0) > 0;
  if (!hasEarnings) {
    return { label: "No salary set", className: "salary-status--none", pending, advance };
  }
  if (salary <= 0.009 && totalPaid <= 0.009) {
    return { label: "Nothing payable", className: "salary-status--none", pending, advance };
  }
  if (advance > 0.009) {
    return { label: "Advance paid", className: "salary-status--advance", pending, advance };
  }
  if (pending <= 0.009) {
    return { label: "Fully paid", className: "salary-status--paid", pending, advance };
  }
  if (totalPaid > 0) {
    return { label: "Partial", className: "salary-status--partial", pending, advance };
  }
  return { label: "Unpaid", className: "salary-status--unpaid", pending, advance };
}

function paymentsForEmployee(payments, employeeId) {
  return (payments || [])
    .filter((p) => p.employee_id === employeeId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function salaryDeleteButtonHtml(payment, staff, isAdmin) {
  if (!isAdmin || !payment?.id) return "";
  const staffName = staff?.name || "staff";
  return AdminDelete.buttonHtml({
    selector: "salary-delete-btn",
    data: {
      paymentId: payment.id,
      staffName,
      date: payment.date,
      amount: payment.amount,
    },
    title: "Delete payment (admin)",
  });
}

function getStaffBalanceForMonth(staffId, payments, employees, monthValue, records, lopExcluded) {
  const staff = (employees || []).find((s) => s.id === staffId);
  if (!staff) return null;
  const paidMap = paidByStaffInRange(payments);
  const paid = paidMap.get(staffId) || 0;
  const balance = computeSalaryBalance(staff.monthly_salary, paid, staff, monthValue, records, { lopExcluded });
  return {
    staff,
    paid,
    ...balance,
    status: salaryStatusFromBalance(balance),
  };
}

function paidByStaffInRange(payments) {
  const byStaff = new Map();
  (payments || []).forEach((p) => {
    const id = p.employee_id;
    byStaff.set(id, (byStaff.get(id) || 0) + Number(p.amount ?? 0));
  });
  return byStaff;
}

function buildSlipRef(employeeId, monthValue) {
  const compact = String(employeeId || "").replace(/-/g, "").slice(0, 8).toUpperCase();
  return `SAL-${monthValue.replace("-", "")}-${compact}`;
}

function slipAttendanceBlock(pay) {
  if (!pay || typeof PayrollRules === "undefined") return "";
  if (!pay.lossOfPayEnabled && !pay.overDutyEnabled) return "";
  const counts = pay.counts || {};
  const leave = pay.lossOfPayEnabled
    ? `Leave ${PayrollRules.leaveUsageLabel(pay)}`
    : `Leave ${PayrollRules.formatDayCount(counts.leave)}`;
  const bits = [`Present ${counts.present}`, `Half-day ${counts.half}`, leave];
  if (pay.overDutyEnabled) bits.push(`Over duty ${PayrollRules.formatDayCount(pay.overDutyDays)}`);
  const basis = pay.config?.dayRateBasis === "fixed" ? "fixed" : "calendar";
  bits.push(`Day rate ${formatCurrency(pay.perDay)} (${pay.divisor} ${basis} days)`);
  const detail = pay.lossOfPayEnabled ? PayrollRules.lopBreakdownLabel(pay) : "";
  return `<div class="salary-slip-attendance"><strong>Attendance.</strong> ${escapeHtml(bits.join(" · "))}.${
    detail ? ` ${escapeHtml(detail)}.` : ""
  }</div>`;
}

function buildSalarySlipHtml(staff, staffPayments, monthValue, records, options) {
  const monthLabel = formatMonthLabel(monthValue);
  const payPeriod = getPayPeriodLabel(monthValue);
  const totalPaid = staffPayments.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const balance = computeSalaryBalance(staff.monthly_salary, totalPaid, staff, monthValue, records, options);
  const pf = balance.pf;
  const { pending: netPending, advance: netAdvance, pay, settled } = balance;
  const netSalary = settled.net;
  const gstin = PumpSettings.getStationGstin();
  const pfSettings = getPfSettings();
  const address = PumpSettings.getStationAddress();
  const contact = PumpSettings.getStationContactLine();
  const slipRef = buildSlipRef(staff.id, monthValue);
  const generatedOn = formatDisplayDate(getLocalDateString());
  const employeePfNo = staff.pf_number?.trim() || "";
  const pan = staff.pan_number?.trim() || "";
  const empPhone = staff.phone_number?.trim() || "";
  const empAddress = staff.address?.trim() || "";

  const statutoryParts = [];
  if (gstin) statutoryParts.push(`<span>GSTIN: ${escapeHtml(gstin)}</span>`);
  if (pfSettings.establishmentCode) {
    statutoryParts.push(`<span>PF Est. code: ${escapeHtml(pfSettings.establishmentCode)}</span>`);
  }

  const paymentRows = staffPayments.length
    ? staffPayments
        .map(
          (p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(formatDisplayDate(p.date))}</td>
          <td class="num">${formatCurrency(p.amount)}</td>
          <td>${escapeHtml(p.note || "—")}</td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="text-align:center;color:#64748b">No salary disbursements recorded for this month</td></tr>`;

  const balanceRow = netAdvance > 0.009
    ? `<tr class="salary-slip-summary-balance"><td>Advance paid (over net salary)</td><td>${formatCurrency(netAdvance)}</td></tr>`
    : netPending > 0.009
      ? `<tr class="salary-slip-summary-balance"><td>Balance payable (net)</td><td>${formatCurrency(netPending)}</td></tr>`
      : `<tr class="salary-slip-summary-paid"><td>Balance payable (net)</td><td>₹ 0.00 — Settled</td></tr>`;

  const employerPfBlock =
    pf.employerPf > 0
      ? `
      <div class="salary-slip-employer">
        <p class="salary-slip-employer-title">Employer contribution (statutory)</p>
        <table>
          <tr>
            <td>Employer PF (fixed monthly)</td>
            <td>${formatCurrency(pf.employerPf)}</td>
          </tr>
        </table>
        <p style="margin:3pt 0 0;font-size:6.8pt;color:#64748b">Employer PF is deposited to EPFO separately and is not deducted from employee take-home pay.</p>
      </div>`
      : "";

  return `
    <article class="salary-slip-sheet" data-slip-ref="${escapeHtml(slipRef)}">
      <header class="salary-slip-head">
        <div class="salary-slip-letterhead">
          <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo salary-slip-logo" width="128" height="128" />
          <div class="salary-slip-letterhead-text">
            <h1 class="salary-slip-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
            <p class="salary-slip-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
            ${address ? `<p class="salary-slip-address">${escapeHtml(address)}</p>` : ""}
            ${contact ? `<p class="salary-slip-contact">${escapeHtml(contact)}</p>` : ""}
            ${statutoryParts.length ? `<p class="salary-slip-statutory">${statutoryParts.join("")}</p>` : ""}
          </div>
        </div>
      </header>

      <div class="salary-slip-title-band">
        <h2 class="salary-slip-doc-title">Salary slip</h2>
        <p class="salary-slip-doc-meta">
          <strong>Slip no.</strong> ${escapeHtml(slipRef)} &nbsp;·&nbsp;
          <strong>Pay period</strong> ${escapeHtml(payPeriod)} &nbsp;·&nbsp;
          <strong>Generated</strong> ${escapeHtml(generatedOn)}
        </p>
      </div>

      <dl class="salary-slip-employee">
        <div>
          <dt>Employee name</dt>
          <dd>${escapeHtml(staff.name)}</dd>
        </div>
        <div>
          <dt>Designation</dt>
          <dd>${escapeHtml(staff.role_display || "—")}</dd>
        </div>
        <div>
          <dt>Salary month</dt>
          <dd>${escapeHtml(monthLabel)}</dd>
        </div>
        <div>
          <dt>PF / UAN no.</dt>
          <dd class="salary-slip-mono">${employeePfNo ? escapeHtml(employeePfNo) : "—"}</dd>
        </div>
        <div>
          <dt>PAN</dt>
          <dd class="salary-slip-mono">${pan ? escapeHtml(pan) : "—"}</dd>
        </div>
        <div>
          <dt>Mobile</dt>
          <dd>${empPhone ? escapeHtml(empPhone) : "—"}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>${empAddress ? escapeHtml(empAddress) : "—"}</dd>
        </div>
        <div>
          <dt>PF wage (gross)</dt>
          <dd>${formatCurrency(pf.gross)}</dd>
        </div>
      </dl>

      ${slipAttendanceBlock(pay)}

      <div class="salary-slip-pay-grid">
        <div class="salary-slip-pay-col">
          <p class="salary-slip-pay-col-title">Earnings</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Gross salary</td>
              <td>${formatCurrency(pf.gross)}</td>
            </tr>
            ${
              pay?.overDutyAmount > 0
                ? `<tr><td>Over duty (${escapeHtml(PayrollRules.formatDayCount(pay.overDutyDays))} day × ${formatCurrency(pay.perDay)})</td><td>${formatCurrency(pay.overDutyAmount)}</td></tr>`
                : ""
            }
            <tr class="salary-slip-pay-total">
              <td>Total earnings</td>
              <td>${formatCurrency(settled.earnings)}</td>
            </tr>
          </table>
        </div>
        <div class="salary-slip-pay-col salary-slip-pay-col--deductions">
          <p class="salary-slip-pay-col-title">Deductions</p>
          <table class="salary-slip-pay-table">
            ${
              pay?.lopExcluded
                ? `<tr><td>Loss of pay excluded (${escapeHtml(PayrollRules.formatDayCount(pay.lopDays))} day, not deducted)</td><td>₹ 0.00</td></tr>`
                : pay?.lopAmount > 0
                  ? `<tr><td>Loss of pay (${escapeHtml(PayrollRules.formatDayCount(pay.lopDays))} day × ${formatCurrency(pay.perDay)})</td><td>${formatCurrency(pay.lopAmount)}</td></tr>`
                  : ""
            }
            <tr>
              <td>Employee PF (fixed monthly)</td>
              <td>${formatCurrency(settled.employeePf)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total deductions</td>
              <td>${formatCurrency(roundMoney((pay?.lopAmount || 0) + settled.employeePf))}</td>
            </tr>
          </table>
        </div>
      </div>

      ${employerPfBlock}

      <div class="salary-slip-net-box">
        <span class="salary-slip-net-label">Net salary (take-home)</span>
        <span class="salary-slip-net-amount">${formatCurrency(netSalary)}</span>
      </div>
      <p class="salary-slip-words"><strong>In words:</strong> ${escapeHtml(amountInWordsINR(netSalary))}</p>

      <p class="salary-slip-section-title">Salary disbursements (${escapeHtml(monthLabel)})</p>
      <table class="salary-slip-payments">
        <thead>
          <tr>
            <th style="width:7%">#</th>
            <th style="width:24%">Payment date</th>
            <th class="num" style="width:22%">Amount (₹)</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>${paymentRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2">Total disbursed</td>
            <td class="num">${formatCurrency(totalPaid)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <table class="salary-slip-summary">
        <tr class="salary-slip-summary-net">
          <td>Net salary for month</td>
          <td>${formatCurrency(netSalary)}</td>
        </tr>
        <tr class="salary-slip-summary-total">
          <td>Total disbursed this month</td>
          <td>${formatCurrency(totalPaid)}</td>
        </tr>
        ${balanceRow}
      </table>

      <footer class="salary-slip-foot">
        <div class="salary-slip-sign">
          <span class="salary-slip-sign-line"></span>
          <span class="salary-slip-sign-label">Employee signature</span>
        </div>
        <div class="salary-slip-sign">
          <span class="salary-slip-sign-line"></span>
          <span class="salary-slip-sign-label">For ${escapeHtml(PumpSettings.getStationLegalName())}<br />Authorised signatory</span>
        </div>
      </footer>
      <p class="salary-slip-note">Computer-generated salary slip. PF is the fixed monthly amount, capped so take-home is not negative. Loss of pay and over duty use marked attendance only; unmarked days are ignored.${
        pay?.lopExcluded
          ? ` Calculated loss of pay (${escapeHtml(formatCurrency(pay.suggestedLopAmount))}) was excluded from this month's salary.`
          : ""
      } Disbursement rows are payments recorded for ${escapeHtml(monthLabel)}.</p>
    </article>`;
}

let salarySlipPrintCssCache = null;

async function getSalarySlipPrintCssText() {
  if (salarySlipPrintCssCache) return salarySlipPrintCssCache;
  const url = slipAssetUrl(SALARY_SLIP_PRINT_CSS);
  const res = await fetch(url, { cache: "default" });
  if (!res.ok) throw new Error("Could not load salary slip print styles.");
  salarySlipPrintCssCache = await res.text();
  return salarySlipPrintCssCache;
}

async function runSalarySlipPrint(staff, staffPayments, monthValue, records) {
  let rows = records;
  let lopExcluded = false;
  if (typeof PayrollRules !== "undefined") {
    const exclusionPromise = PayrollRules.fetchLopExclusions(window.supabaseClient, monthValue).catch((error) => {
      AppError.report(error, { context: "printSalarySlipExclusions" });
      return { ids: new Set(), ready: true };
    });
    const [bundle, exclusions] = await Promise.all([
      rows ? Promise.resolve(null) : PayrollRules.fetchMonthAttendance(window.supabaseClient, monthValue),
      exclusionPromise,
    ]);
    if (!rows) rows = bundle?.byEmployee.get(staff.id) || [];
    lopExcluded = exclusions.ids.has(staff.id);
  }
  const [sheetHtml, cssText] = await Promise.all([
    Promise.resolve(
      buildSalarySlipHtml(staff, staffPayments, monthValue, rows || [], { lopExcluded })
    ),
    getSalarySlipPrintCssText(),
  ]);

  await PrintUtils.printInIframe({
    title: PrintUtils.buildPrintFilename("salary-slip", staff.name || "staff", monthValue),
    bodyHtml: sheetHtml,
    cssText,
    iframeTitle: "Salary slip print",
    imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "salary",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);
  const isAdmin = auth.role === "admin";

  if (typeof loadPumpSettings === "function") {
    await loadPumpSettings();
  }

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "summary", validSections: ["summary", "record", "recent"] });
  }

  const paymentForm = document.getElementById("salary-payment-form");
  const paymentSuccess = document.getElementById("salary-payment-success");
  const paymentError = document.getElementById("salary-payment-error");
  const paymentStaffSelect = document.getElementById("payment-staff");
  const paymentDateInput = document.getElementById("payment-date");
  const paymentAmountInput = document.getElementById("payment-amount");
  const paymentFillRemainingBtn = document.getElementById("payment-fill-remaining");
  const paymentSalaryMonthSelect = document.getElementById("payment-salary-month-month");
  const paymentSalaryYearSelect = document.getElementById("payment-salary-month-year");
  const paymentMonthHint = document.getElementById("payment-month-hint");
  const salaryMonthSelect = document.getElementById("salary-month-month");
  const salaryYearSelect = document.getElementById("salary-month-year");
  const historyMonthSelect = document.getElementById("salary-history-month-month");
  const historyYearSelect = document.getElementById("salary-history-month-year");

  const detailOverlay = document.getElementById("salary-detail-overlay");
  const detailBackdrop = document.getElementById("salary-detail-backdrop");
  const detailClose = document.getElementById("salary-detail-close");
  const detailDismiss = document.getElementById("salary-detail-dismiss");
  const detailPrintBtn = document.getElementById("salary-detail-print-slip");
  const detailAddPaymentBtn = document.getElementById("salary-detail-add-payment");

  if (paymentDateInput) {
    initPersistedDateInput(paymentDateInput, RECORD_DATE_KEYS.salaryPayment);
  }

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  populateMonthYearSelects(salaryMonthSelect, salaryYearSelect);
  populateMonthYearSelects(historyMonthSelect, historyYearSelect);
  populateMonthYearSelects(paymentSalaryMonthSelect, paymentSalaryYearSelect);
  writeMonthYearValue(salaryMonthSelect, salaryYearSelect, currentMonth);
  writeMonthYearValue(historyMonthSelect, historyYearSelect, currentMonth);
  writeMonthYearValue(paymentSalaryMonthSelect, paymentSalaryYearSelect, currentMonth);

  let staffList = [];
  let monthPayments = [];
  let attendanceByEmployee = new Map();
  let attendanceMonthLoaded = "";
  let attendanceNote = "";
  let detailStaffId = null;
  let lopExclusionIds = new Set();
  let lopExclusionMonth = "";
  let lopExclusionReady = true;

  function isLopExcluded(staffId) {
    return lopExclusionIds.has(staffId);
  }

  function lopExcludeControlHtml(staffId, pay) {
    if (!isAdmin || !pay?.lossOfPayEnabled) return "";
    const suggested = Number(pay.suggestedLopAmount ?? pay.lopAmount) || 0;
    if (suggested <= 0 || !lopExclusionReady) return "";
    const excludeNext = pay.lopExcluded ? "0" : "1";
    const label = pay.lopExcluded ? "Include in salary" : "Exclude from salary";
    return `<div class="salary-lop-actions"><button type="button" class="button-secondary button-small salary-lop-toggle" data-staff-id="${escapeHtml(staffId)}" data-exclude="${excludeNext}" data-amount="${suggested}">${label}</button></div>`;
  }

  function appendLopExclusionNote() {
    if (lopExclusionReady) return;
    const extra =
      "Loss-of-pay exclusions need the latest database update. Calculated loss of pay is still deducted.";
    attendanceNote = attendanceNote ? `${attendanceNote} ${extra}` : extra;
  }

  async function loadLopExclusions(monthValue, options) {
    lopExclusionMonth = salaryMonthKey(monthValue);
    lopExclusionReady = true;
    if (typeof PayrollRules === "undefined" || !PayrollRules.getPayrollConfig().lossOfPayEnabled) {
      lopExclusionIds = new Set();
      return lopExclusionIds;
    }
    try {
      const result = await PayrollRules.fetchLopExclusions(window.supabaseClient, monthValue, options);
      lopExclusionIds = result.ids;
      lopExclusionReady = result.ready !== false;
    } catch (error) {
      lopExclusionIds = new Set();
      lopExclusionReady = false;
      AppError.report(error, { context: "loadLopExclusions" });
    }
    return lopExclusionIds;
  }

  async function excludedForStaff(staffId, monthValue) {
    if (salaryMonthKey(monthValue) === lopExclusionMonth) return lopExclusionIds.has(staffId);
    if (typeof PayrollRules === "undefined") return false;
    try {
      const result = await PayrollRules.fetchLopExclusions(window.supabaseClient, monthValue);
      return result.ids.has(staffId);
    } catch (error) {
      AppError.report(error, { context: "excludedForStaff" });
      return false;
    }
  }

  async function setLopExcluded(staffId, monthValue, exclude) {
    const salaryMonth = normalizeSalaryMonth(monthValue);
    const userId = auth.session?.user?.id;
    if (!salaryMonth || !staffId || !userId) {
      throw new Error("Could not save the loss-of-pay exclusion.");
    }
    if (exclude) {
      const { error } = await window.supabaseClient.from("salary_lop_exclusions").insert({
        employee_id: staffId,
        salary_month: salaryMonth,
        created_by: userId,
      });
      if (error && error.code !== "23505") throw error;
      return;
    }
    const { error } = await window.supabaseClient
      .from("salary_lop_exclusions")
      .delete()
      .eq("employee_id", staffId)
      .eq("salary_month", salaryMonth);
    if (error) throw error;
  }

  async function toggleLopExclusion(staffId, monthValue, exclude, suggestedAmount) {
    const staff = staffList.find((s) => s.id === staffId);
    const suggested = Number(suggestedAmount) || 0;
    const monthLabel = formatMonthLabel(monthValue);
    const name = staff?.name || "this employee";
    const ok = exclude
      ? await AppDialog.confirm(
          `Exclude ${formatCurrency(suggested)} loss of pay from ${name}'s ${monthLabel} salary? Payable will not be reduced by that amount.`,
          { title: "Loss of pay", confirmLabel: "Exclude" }
        )
      : await AppDialog.confirm(`Include loss of pay in ${name}'s ${monthLabel} salary again?`, {
          title: "Loss of pay",
          confirmLabel: "Include",
        });
    if (!ok) return;
    try {
      await setLopExcluded(staffId, monthValue, exclude);
      if (exclude) lopExclusionIds.add(staffId);
      else lopExclusionIds.delete(staffId);
      PayrollRules.setCachedLopExclusion(monthValue, staffId, exclude);
      const selected = getSelectedMonth();
      if (salaryMonthKey(selected) === salaryMonthKey(monthValue)) {
        await renderSummary(selected, { refresh: false });
      } else {
        await renderSummary(selected);
      }
    } catch (error) {
      AppError.report(error, { context: "toggleLopExclusion" });
      AppError.showToast(AppError.getUserMessage(error) || "Could not update loss of pay.", "error");
    }
  }

  async function loadMonthAttendanceMap(monthValue) {
    attendanceNote = "";
    if (typeof PayrollRules === "undefined") {
      attendanceByEmployee = new Map();
      return attendanceByEmployee;
    }
    try {
      const bundle = await PayrollRules.fetchMonthAttendance(window.supabaseClient, monthValue, { force: true });
      attendanceByEmployee = bundle.byEmployee;
      attendanceMonthLoaded = monthValue;
      if (bundle.overDutyColumnReady === false && PayrollRules.getPayrollConfig().overDutyEnabled) {
        attendanceNote =
          "Over duty is turned on, but the database update for over duty is not applied yet. Loss of pay still uses attendance.";
      }
    } catch (error) {
      attendanceByEmployee = new Map();
      attendanceMonthLoaded = monthValue;
      attendanceNote = "Attendance could not be loaded, so loss of pay and over duty are not included.";
      AppError.report(error, { context: "loadMonthAttendanceMap" });
    }
    return attendanceByEmployee;
  }

  function recordsFor(staffId) {
    return attendanceByEmployee.get(staffId) || [];
  }

  async function attendanceRecordsFor(staffId, monthValue) {
    if (attendanceMonthLoaded === monthValue) return recordsFor(staffId);
    if (typeof PayrollRules === "undefined") return [];
    try {
      const bundle = await PayrollRules.fetchMonthAttendance(window.supabaseClient, monthValue);
      return bundle.byEmployee.get(staffId) || [];
    } catch (error) {
      AppError.report(error, { context: "attendanceRecordsFor" });
      return [];
    }
  }

  const historyActionsHead = document.getElementById("salary-history-actions-head");
  const detailActionsHead = document.getElementById("salary-detail-actions-head");
  if (historyActionsHead) {
    historyActionsHead.textContent = isAdmin ? "Actions" : "Slip";
  }
  if (detailActionsHead) {
    detailActionsHead.hidden = !isAdmin;
  }

  async function deleteSalaryPayment(payment, staff) {
    if (!isAdmin) {
      AppError.showToast("Only an admin can delete salary payments.", "warning");
      return;
    }
    if (!payment?.id) return;

    const staffName = staff?.name || "this staff member";
    const confirmed = await AppDialog.confirm(
      `Delete salary payment of ${formatCurrency(payment.amount)} for ${staffName} on ${formatDisplayDate(payment.date)}?\n\nThe linked expense entry will also be removed. This cannot be undone.`,
      { title: "Delete payment", confirmLabel: "Delete", danger: true }
    );
    if (!confirmed) return;

    // Payment and its linked expense are removed in one transaction on the server.
    const { error } = await window.supabaseClient.rpc("delete_salary_payment", { p_payment_id: payment.id });
    if (error) {
      AppError.showToast(AppError.getUserMessage(error), "error");
      AppError.report(error, { context: "deleteSalaryPayment", id: payment.id });
      return;
    }

    if (typeof AppCache !== "undefined" && AppCache) {
      CacheInvalidation.invalidate("operational");
    }

    await refreshAll();
  }

  function bindSalaryDeleteDelegation(container) {
    if (!isAdmin || !container || container.dataset.salaryDeleteBound === "1") return;
    container.dataset.salaryDeleteBound = "1";
    container.addEventListener("click", async (e) => {
      const btn = e.target.closest(".salary-delete-btn");
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();

      const paymentId = btn.getAttribute("data-payment-id");
      const payment =
        monthPayments.find((p) => p.id === paymentId) ||
        (await (async () => {
          const monthVal = getHistoryMonth();
          const all = await loadPaymentsForMonth(monthVal);
          return all.find((p) => p.id === paymentId);
        })());

      if (!payment) {
        AppError.showToast("Payment not found. Refresh the page and try again.", "error");
        return;
      }

      const staff = staffList.find((s) => s.id === payment.employee_id);
      btn.disabled = true;
      try {
        await deleteSalaryPayment(payment, staff);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function getSelectedMonth() {
    return readMonthYearValue(salaryMonthSelect, salaryYearSelect) || currentMonth;
  }

  function getPaymentSalaryMonth() {
    return readMonthYearValue(paymentSalaryMonthSelect, paymentSalaryYearSelect) || getSelectedMonth();
  }

  function getHistoryMonth() {
    return readMonthYearValue(historyMonthSelect, historyYearSelect) || getSelectedMonth();
  }

  function syncHistoryMonth() {
    writeMonthYearValue(historyMonthSelect, historyYearSelect, getSelectedMonth());
  }

  function openDetailModal(staffId) {
    if (!detailOverlay) return;
    detailStaffId = staffId;
    renderDetailModal(staffId, getSelectedMonth());
    AppDialog.show(detailOverlay, {
      focus: "#salary-detail-close",
      onDismiss: closeDetailModal,
    });
  }

  function closeDetailModal() {
    if (!detailOverlay || detailOverlay.getAttribute("aria-hidden") === "true") return;
    AppDialog.hide(detailOverlay);
    detailStaffId = null;
    document.querySelectorAll(".salary-summary-table tbody tr.is-selected").forEach((tr) => {
      tr.classList.remove("is-selected");
    });
  }

  function renderDetailModal(staffId, monthValue) {
    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return;

    const paidMap = paidByStaffInRange(monthPayments);
    const paid = paidMap.get(staffId) || 0;
    const ctx = getStaffSalaryMonthContext(staff, paid, monthValue, recordsFor(staffId), isLopExcluded(staffId));
    const list = paymentsForEmployee(monthPayments, staffId);
    const monthLabel = formatMonthLabel(monthValue);

    const titleEl = document.getElementById("salary-detail-title");
    const subtitleEl = document.getElementById("salary-detail-subtitle");
    const statsEl = document.getElementById("salary-detail-stats");
    const tbody = document.getElementById("salary-detail-payments-body");

    if (titleEl) titleEl.textContent = staff.name;
    if (subtitleEl) {
      subtitleEl.textContent = `${staff.role_display || "Staff"} · ${monthLabel}`;
    }

    const balanceValue = formatCurrency(ctx.pending);
    const balanceClass =
      ctx.pending <= 0.009 ? "salary-detail-balance is-clear" : "salary-detail-balance";

    const pf = ctx.balance.pf;
    const pfNo = staff.pf_number?.trim();
    const pay = ctx.balance?.pay;
    const settled = ctx.balance?.settled;

    if (statsEl) {
      statsEl.innerHTML = `
        <div><dt>Gross salary</dt><dd>${formatCurrency(staff.monthly_salary)}</dd></div>
        <div><dt>Payable</dt><dd>${formatCurrency(ctx.payable)}</dd></div>
        <div><dt>PF contribution</dt><dd>${
          pf.fixedAmount > 0
            ? formatCurrency(settled?.employeePf ?? pf.employeePf)
            : '<span class="muted">Not set — <a href="staff.html">Staff</a></span>'
        }</dd></div>
        <div><dt>Employer PF</dt><dd>${formatCurrency(pf.employerPf)}</dd></div>
        <div><dt>PF / UAN</dt><dd>${pfNo ? escapeHtml(pfNo) : '<span class="muted">Not set</span>'}</dd></div>
        <div><dt>Mobile</dt><dd>${staff.phone_number ? escapeHtml(staff.phone_number) : '<span class="muted">—</span>'}</dd></div>
        <div><dt>Paid this month</dt><dd>${formatCurrency(paid)}</dd></div>
        <div><dt>Remaining</dt><dd class="${balanceClass}">${balanceValue}</dd></div>
        <div><dt>Status</dt><dd><span class="salary-status ${ctx.className}">${escapeHtml(ctx.label)}</span></dd></div>
      `;
    }

    const adjustEl = document.getElementById("salary-detail-adjust");
    if (adjustEl) {
      if (!pay || (!pay.lossOfPayEnabled && !pay.overDutyEnabled)) {
        adjustEl.hidden = true;
        adjustEl.innerHTML = "";
      } else {
        const counts = pay.counts || {};
        adjustEl.hidden = false;
        adjustEl.innerHTML = `
          <div class="salary-adjust-head">
            <h3>Attendance this month</h3>
            <span class="muted">${escapeHtml(PayrollRules.dayRateLabel(pay))} · ${escapeHtml(formatCurrency(pay.perDay))} / day</span>
          </div>
          <dl class="salary-adjust-grid">
            <div><dt>Present</dt><dd>${counts.present}</dd></div>
            <div><dt>Half-day</dt><dd>${counts.half}</dd></div>
            <div><dt>Leave</dt><dd>${escapeHtml(PayrollRules.leaveUsageLabel(pay))}</dd></div>
            <div><dt>Loss of pay</dt><dd class="${pay.lopExcluded ? "salary-lop-excluded" : pay.lopAmount > 0 ? "salary-money-deduct" : ""}">${
              !pay.lossOfPayEnabled
                ? "Off"
                : pay.lopExcluded
                  ? `Excluded · ${escapeHtml(formatCurrency(pay.suggestedLopAmount))}`
                  : pay.lopAmount > 0
                    ? `${escapeHtml(PayrollRules.formatDayCount(pay.lopDays))} · ${escapeHtml(formatCurrency(pay.lopAmount))}`
                    : "—"
            }</dd></div>
            <div><dt>Over duty</dt><dd class="${pay.overDutyAmount > 0 ? "salary-money-earn" : ""}">${
              pay.overDutyEnabled
                ? `${escapeHtml(PayrollRules.formatDayCount(pay.overDutyDays))} · ${escapeHtml(formatCurrency(pay.overDutyAmount))}`
                : "Off"
            }</dd></div>
          </dl>
          <p class="salary-adjust-note">${escapeHtml(pay.lossOfPayEnabled ? PayrollRules.lopBreakdownLabel(pay) : "Loss of pay is off.")} Unmarked days are ignored.</p>
          ${lopExcludeControlHtml(staffId, pay)}
        `;
        adjustEl.querySelector(".salary-lop-toggle")?.addEventListener("click", (e) => {
          e.stopPropagation();
          const button = e.currentTarget;
          toggleLopExclusion(staffId, monthValue, button.getAttribute("data-exclude") === "1", button.getAttribute("data-amount"));
        });
      }
    }

    if (tbody) {
      const colSpan = isAdmin ? 4 : 3;
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="${colSpan}" class="muted">No payments recorded for this month.</td></tr>`;
      } else {
        tbody.innerHTML = list
          .map(
            (p) => `
          <tr>
            <td>${escapeHtml(formatDisplayDate(p.date))}</td>
            <td class="num">${formatCurrency(p.amount)}</td>
            <td>${escapeHtml(p.note ?? "—")}</td>
            ${isAdmin ? `<td class="table-actions">${salaryDeleteButtonHtml(p, staff, true)}</td>` : ""}
          </tr>`
          )
          .join("");
      }
    }

    if (detailPrintBtn) {
      detailPrintBtn.disabled = false;
      detailPrintBtn.title = "";
      detailPrintBtn.onclick = async () => {
        try {
          await runSalarySlipPrint(staff, list, monthValue);
        } catch (err) {
          AppError.report(err, { context: "printSalarySlip" });
          AppError.showToast(AppError.getUserMessage(err) || "Could not open the print dialog.", "error");
        }
      };
    }

    if (detailAddPaymentBtn) {
      detailAddPaymentBtn.disabled = false;
      detailAddPaymentBtn.title = "";
    }
  }

  async function loadStaffMembers() {
    try {
      staffList = await StaffEmployees.loadActiveEmployees(window.supabaseClient, {
        isAdmin,
        useCache: true,
      });
    } catch (error) {
      AppError.report(error, { context: "loadStaffMembers" });
      staffList = [];
    }
    return staffList;
  }

  /** Active roster + inactive lookups for history / slips. */
  async function staffMapForIds(ids) {
    const map = new Map(staffList.map((s) => [s.id, s]));
    const missing = [...new Set((ids || []).filter((id) => id && !map.has(id)))];
    if (!missing.length) return map;
    try {
      const resolved = await StaffEmployees.resolveEmployeesByIds(window.supabaseClient, missing);
      resolved.forEach((emp, id) => map.set(id, emp));
    } catch (err) {
      AppError.report(err, { context: "staffMapForIds" });
    }
    return map;
  }

  function fillStaffSelect(selectEl, includeEmpty = true) {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML = includeEmpty ? '<option value="">Select staff</option>' : "";
    staffList.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.name}${s.role_display ? ` (${s.role_display})` : ""}`;
      selectEl.appendChild(opt);
    });
    if (current && staffList.some((s) => s.id === current)) {
      selectEl.value = current;
    }
  }

  async function loadPaymentsInRange(startDate, endDate) {
    const { data, error } = await fetchAllRows(() =>
      window.supabaseClient
        .from("salary_payments")
        .select("id, employee_id, date, amount, note, salary_month")
        .gte("date", startDate)
        .lte("date", endDate)
        .order("date", { ascending: false })
        .order("id", { ascending: true })
    );

    if (error) {
      if (isMissingSalaryMonthColumn(error)) {
        const { data: legacyData, error: legacyError } = await fetchAllRows(() =>
          window.supabaseClient
            .from("salary_payments")
            .select("id, employee_id, date, amount, note")
            .gte("date", startDate)
            .lte("date", endDate)
            .order("date", { ascending: false })
            .order("id", { ascending: true })
        );
        if (legacyError) {
          AppError.report(legacyError, { context: "loadPaymentsInRange" });
          return [];
        }
        return legacyData ?? [];
      }
      AppError.report(error, { context: "loadPaymentsInRange" });
      return [];
    }
    return data ?? [];
  }

  async function loadPaymentsForSalaryMonth(monthValue) {
    const salaryMonth = normalizeSalaryMonth(monthValue);
    if (!salaryMonth) return [];

    const { data, error } = await fetchAllRows(() =>
      window.supabaseClient
        .from("salary_payments")
        .select("id, employee_id, date, amount, note, salary_month")
        .eq("salary_month", salaryMonth)
        .order("date", { ascending: false })
        .order("id", { ascending: true })
    );

    if (error) {
      if (isMissingSalaryMonthColumn(error)) {
        const [year, month] = monthValue.split("-").map(Number);
        const { start, end } = getMonthRange(year, month - 1);
        return loadPaymentsInRange(start, end);
      }
      AppError.report(error, { context: "loadPaymentsForSalaryMonth" });
      return [];
    }
    return data ?? [];
  }

  async function getPaymentsForSalaryMonth(monthValue) {
    if (monthValue === getSelectedMonth() && monthPayments.length) {
      return monthPayments;
    }
    return loadPaymentsForSalaryMonth(monthValue);
  }

  async function updatePaymentMonthHint() {
    if (!paymentMonthHint) return;
    const staffId = paymentStaffSelect?.value;
    const monthVal = getPaymentSalaryMonth();
    if (!staffId || !monthVal) {
      paymentMonthHint.classList.add("hidden");
      return;
    }
    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return;

    const payments = await getPaymentsForSalaryMonth(monthVal);
    const records = await attendanceRecordsFor(staffId, monthVal);
    const balance = getStaffBalanceForMonth(
      staffId,
      payments,
      staffList,
      monthVal,
      records,
      await excludedForStaff(staffId, monthVal)
    );
    if (!balance) return;

    const monthLabel = formatMonthLabel(monthVal);
    let remainingText;
    if ((balance.gross || 0) <= 0 && !(balance.pay?.overDutyAmount > 0)) {
      remainingText = "no salary configured";
    } else if (balance.status.advance > 0.009) {
      remainingText = `advance ${formatCurrency(balance.status.advance)} paid`;
    } else if (balance.pending <= 0.009) {
      remainingText = "fully paid";
    } else {
      remainingText = `${formatCurrency(balance.pending)} remaining`;
    }
    const extras = [];
    if (balance.pay?.lopExcluded) {
      extras.push(`loss of pay excluded ${formatCurrency(balance.pay.suggestedLopAmount)}`);
    } else if (balance.pay?.lossOfPayEnabled && balance.pay.lopAmount > 0) {
      extras.push(`loss of pay ${formatCurrency(balance.pay.lopAmount)}`);
    }
    if (balance.pay?.overDutyEnabled) extras.push(`over duty ${formatCurrency(balance.pay.overDutyAmount)}`);
    const extraText = extras.length ? ` · ${extras.join(" · ")}` : "";

    paymentMonthHint.textContent = `${monthLabel}: payable ${formatCurrency(balance.salary)}${extraText} · ${formatCurrency(balance.paid)} paid · ${remainingText}`;
    paymentMonthHint.classList.remove("hidden");
  }

  async function fillPaymentRemaining() {
    const staffId = paymentStaffSelect?.value;
    if (!staffId) {
      if (paymentError) {
        paymentError.textContent = "Select a staff member first.";
        paymentError.classList.remove("hidden");
      }
      return;
    }
    paymentError?.classList.add("hidden");

    const monthVal = getPaymentSalaryMonth();
    const payments = await getPaymentsForSalaryMonth(monthVal);
    const records = await attendanceRecordsFor(staffId, monthVal);
    const balance = getStaffBalanceForMonth(
      staffId,
      payments,
      staffList,
      monthVal,
      records,
      await excludedForStaff(staffId, monthVal)
    );
    if (!balance || balance.pending <= 0.009) {
      if (paymentAmountInput) paymentAmountInput.value = "";
      return;
    }
    if (paymentAmountInput) {
      paymentAmountInput.value = balance.pending.toFixed(2);
    }
  }

  async function renderSummary(monthValue, options) {
    const tbody = document.getElementById("salary-summary-body");
    const kpiPayroll = document.getElementById("salary-kpi-payroll");
    const kpiPaid = document.getElementById("salary-kpi-paid");
    const kpiPending = document.getElementById("salary-kpi-pending");
    if (!tbody) return;

    const kpiLop = document.getElementById("salary-kpi-lop");
    const kpiOd = document.getElementById("salary-kpi-od");
    const summaryTable = document.getElementById("salary-summary-table");
    const payrollNote = document.getElementById("salary-payroll-note");
    const payCfg = typeof PayrollRules !== "undefined" ? PayrollRules.getPayrollConfig() : null;
    summaryTable?.classList.toggle("show-lop", Boolean(payCfg?.lossOfPayEnabled));
    summaryTable?.classList.toggle("show-od", Boolean(payCfg?.overDutyEnabled));
    document.getElementById("salary-kpi-lop-card")?.classList.toggle("hidden", !payCfg?.lossOfPayEnabled);
    document.getElementById("salary-kpi-od-card")?.classList.toggle("hidden", !payCfg?.overDutyEnabled);

    if (!staffList.length) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="muted">Add staff in <a href="staff.html">HR → Staff</a> first.</td></tr>';
      if (kpiPayroll) kpiPayroll.textContent = "—";
      if (kpiPaid) kpiPaid.textContent = "—";
      if (kpiPending) kpiPending.textContent = "—";
      if (kpiLop) kpiLop.textContent = "—";
      if (kpiOd) kpiOd.textContent = "—";
      return;
    }

    if (options?.refresh !== false) {
      const [payments] = await Promise.all([
        loadPaymentsForSalaryMonth(monthValue),
        loadMonthAttendanceMap(monthValue),
        loadLopExclusions(monthValue, { force: true }),
      ]);
      monthPayments = payments;
      appendLopExclusionNote();
    }
    const paidMap = paidByStaffInRange(monthPayments);

    let totalPayroll = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let totalLop = 0;
    let totalOd = 0;

    const summaryRows = staffList.map((s) => {
      const paid = paidMap.get(s.id) || 0;
      const ctx = getStaffSalaryMonthContext(s, paid, monthValue, recordsFor(s.id), isLopExcluded(s.id));
      const pay = ctx.balance?.pay;
      totalPayroll += ctx.payable;
      totalPaid += paid;
      totalPending += ctx.pending;
      totalLop += pay?.lopAmount || 0;
      totalOd += pay?.overDutyAmount || 0;
      const remaining =
        ctx.advance > 0.009
          ? `<span class="muted">Advance ${formatCurrency(ctx.advance)}</span>`
          : formatCurrency(ctx.pending);
      const name = escapeHtml(s.name);
      const role = escapeHtml(s.role_display ?? "—");
      const suggestedLop = Number(pay?.suggestedLopAmount ?? pay?.lopAmount) || 0;
      const lopText = !pay?.lossOfPayEnabled
        ? "Off"
        : pay.lopExcluded
          ? `<span class="salary-lop-excluded">Excluded</span> <span class="muted">${escapeHtml(formatCurrency(suggestedLop))}</span>`
          : pay.lopAmount > 0
            ? escapeHtml(formatCurrency(pay.lopAmount))
            : "—";
      const lopAction = lopExcludeControlHtml(s.id, pay);
      const odText = pay?.overDutyEnabled ? formatCurrency(pay.overDutyAmount) : "Off";
      return `
          <tr data-staff-id="${escapeHtml(s.id)}" tabindex="0" role="button" aria-label="View ${name} salary details">
            <td>${name}</td>
            <td>${role}</td>
            <td class="num">${formatCurrency(ctx.payable)}</td>
            <td class="num salary-col-lop${pay?.lopAmount > 0 ? " salary-money-deduct" : ""}"><div class="salary-lop-cell">${lopText}${lopAction}</div></td>
            <td class="num salary-col-od${pay?.overDutyAmount > 0 ? " salary-money-earn" : ""}">${odText}</td>
            <td class="num">${formatCurrency(paid)}</td>
            <td class="num">${remaining}</td>
            <td><span class="salary-status ${ctx.className}">${escapeHtml(ctx.label)}</span></td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small salary-view-btn" data-staff-id="${escapeHtml(s.id)}">Details</button>
              <button type="button" class="button-secondary button-small salary-slip-btn" data-staff-id="${escapeHtml(s.id)}">Slip</button>
              <button type="button" class="button-secondary button-small add-payment-btn" data-staff-id="${escapeHtml(s.id)}">Pay</button>
            </td>
          </tr>
        `;
    });

    if (kpiPayroll) kpiPayroll.textContent = formatCurrency(totalPayroll);
    if (kpiPaid) kpiPaid.textContent = formatCurrency(totalPaid);
    if (kpiPending) kpiPending.textContent = formatCurrency(totalPending);
    if (kpiLop) kpiLop.textContent = formatCurrency(totalLop);
    if (kpiOd) kpiOd.textContent = formatCurrency(totalOd);
    if (payrollNote) {
      const summary = payCfg && PayrollRules.rulesAffectPay(payCfg) ? PayrollRules.policySummary(payCfg) : null;
      const text = [attendanceNote, summary?.rate].filter(Boolean).join(" ");
      payrollNote.textContent = text;
      payrollNote.classList.toggle("hidden", !text);
    }

    const kpiNote = document.getElementById("salary-kpi-note");
    if (kpiNote) {
      kpiNote.classList.add("hidden");
      kpiNote.textContent = "";
    }

    tbody.innerHTML = summaryRows.join("");

    tbody.querySelectorAll("tr[data-staff-id]").forEach((row) => {
      const staffId = row.getAttribute("data-staff-id");
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        openDetailModal(staffId);
        tbody.querySelectorAll("tr.is-selected").forEach((tr) => tr.classList.remove("is-selected"));
        row.classList.add("is-selected");
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetailModal(staffId);
        }
      });
    });

    tbody.querySelectorAll(".salary-view-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDetailModal(btn.getAttribute("data-staff-id"));
      });
    });

    tbody.querySelectorAll(".salary-slip-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const staffId = btn.getAttribute("data-staff-id");
        const staff = staffList.find((s) => s.id === staffId);
        if (!staff) return;
        const list = paymentsForEmployee(monthPayments, staffId);
        try {
          await runSalarySlipPrint(staff, list, monthValue);
        } catch (err) {
          AppError.report(err, { context: "printSalarySlipQuick" });
          AppError.showToast(AppError.getUserMessage(err) || "Could not open the print dialog.", "error");
        }
      });
    });

    tbody.querySelectorAll(".salary-lop-toggle").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const staffId = btn.getAttribute("data-staff-id");
        const exclude = btn.getAttribute("data-exclude") === "1";
        toggleLopExclusion(staffId, monthValue, exclude, btn.getAttribute("data-amount"));
      });
    });

    tbody.querySelectorAll(".add-payment-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const staffId = btn.getAttribute("data-staff-id");
        prefillPayment(staffId);
      });
    });

    if (detailStaffId) {
      renderDetailModal(detailStaffId, monthValue);
    }
    updatePaymentMonthHint();
  }

  function prefillPayment(staffId, options = {}) {
    const salaryMonth = options.salaryMonth || getSelectedMonth();
    if (paymentStaffSelect) paymentStaffSelect.value = staffId;
    writeMonthYearValue(paymentSalaryMonthSelect, paymentSalaryYearSelect, salaryMonth);
    if (paymentDateInput) {
      paymentDateInput.value = suggestPaymentDate(salaryMonth);
    }
    if (paymentAmountInput) paymentAmountInput.value = "";
    updatePaymentMonthHint().then(() => fillPaymentRemaining());
    const recordNav = document.querySelector('.settings-nav-item[data-section="record"]');
    recordNav?.click();
    paymentForm?.scrollIntoView({ behavior: "smooth" });
  }

  async function loadPaymentHistory(monthValue) {
    const tbody = document.getElementById("salary-payments-body");
    if (!tbody) return;

    const list = await loadPaymentsForSalaryMonth(monthValue);

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="${isAdmin ? 5 : 5}" class="muted">No payments for ${escapeHtml(formatMonthLabel(monthValue))} salary.</td></tr>`;
      return;
    }

    const staffById = await staffMapForIds(list.map((p) => p.employee_id));

    tbody.innerHTML = list
      .map((p) => {
        const staff = staffById.get(p.employee_id);
        const name = escapeHtml(StaffEmployees.displayName(staff));
        const staffId = p.employee_id;
        const slipDisabled = staff ? "" : " disabled title=\"Staff record not found\"";
        return `
          <tr>
            <td>${escapeHtml(formatDisplayDate(p.date))}</td>
            <td>${name}</td>
            <td class="num">${formatCurrency(p.amount)}</td>
            <td>${escapeHtml(p.note ?? "—")}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small history-slip-btn" data-staff-id="${escapeHtml(staffId)}"${slipDisabled}>Slip</button>
              ${salaryDeleteButtonHtml(p, staff, isAdmin)}
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".history-slip-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const staffId = btn.getAttribute("data-staff-id");
        const staff = staffById.get(staffId);
        if (!staff) return;
        const payments = await loadPaymentsForMonth(monthValue);
        const list = paymentsForEmployee(payments, staffId);
        try {
          await runSalarySlipPrint(staff, list, monthValue);
        } catch (err) {
          AppError.report(err, { context: "printHistorySlip" });
          AppError.showToast(AppError.getUserMessage(err) || "Could not open the print dialog.", "error");
        }
      });
    });
  }

  async function loadPaymentsForMonth(monthValue) {
    return loadPaymentsForSalaryMonth(monthValue);
  }

  async function refreshAll() {
    await loadStaffMembers();
    fillStaffSelect(paymentStaffSelect);
    const monthVal = getSelectedMonth();
    const historyMonthVal = getHistoryMonth();
    if (monthVal) {
      await renderSummary(monthVal);
      await loadPaymentHistory(historyMonthVal);
    }
  }

  if (paymentForm) {
    paymentForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = paymentForm.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Saving…";
      }
      paymentSuccess?.classList.add("hidden");
      paymentError?.classList.add("hidden");

      const staffId = paymentStaffSelect?.value;
      const date = paymentDateInput?.value;
      const amount = Number(paymentAmountInput?.value || 0);
      const note = document.getElementById("payment-note")?.value?.trim() || null;
      const salaryMonthVal = getPaymentSalaryMonth();
      const salaryMonth = normalizeSalaryMonth(salaryMonthVal || date?.slice(0, 7));

      const resetSubmitBtn = () => {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Save payment";
        }
      };

      if (!staffId) {
        resetSubmitBtn();
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Select a staff member.";
        return;
      }
      if (!date) {
        resetSubmitBtn();
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Payment date is required.";
        return;
      }
      if (date > getLocalDateString()) {
        resetSubmitBtn();
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Payment date cannot be in the future.";
        return;
      }
      if (amount <= 0) {
        resetSubmitBtn();
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Amount must be greater than 0.";
        return;
      }
      if (!salaryMonth) {
        resetSubmitBtn();
        paymentError?.classList.remove("hidden");
        if (paymentError) paymentError.textContent = "Select the salary month this payment applies to.";
        return;
      }

      const payments = await getPaymentsForSalaryMonth(salaryMonthVal);
      const records = await attendanceRecordsFor(staffId, salaryMonthVal);
      const balance = getStaffBalanceForMonth(
        staffId,
        payments,
        staffList,
        salaryMonthVal,
        records,
        await excludedForStaff(staffId, salaryMonthVal)
      );
      // Browser check is for a friendly prompt; record_salary_payment re-checks under a lock.
      let allowOverpay = false;
      if (balance && balance.salary > 0 && amount > balance.pending + 0.009) {
        const overBy = roundMoney(amount - balance.pending);
        const msg =
          balance.pending <= 0.009
            ? `Net salary for ${formatMonthLabel(salaryMonthVal)} is already settled. Record ${formatCurrency(amount)} as advance?`
            : `Amount exceeds remaining balance (${formatCurrency(balance.pending)}). This will overpay by ${formatCurrency(overBy)}. Continue?`;
        if (!(await AppDialog.confirm(msg, { title: "Record payment", confirmLabel: "Record" }))) {
          resetSubmitBtn();
          return;
        }
        allowOverpay = true;
      }

      const requestId = formRequestId(paymentForm, [staffId, date, salaryMonth, amount, note]);
      const recordPayment = (allow) =>
        window.supabaseClient.rpc("record_salary_payment", {
          p_employee_id: staffId,
          p_date: date,
          p_salary_month: salaryMonth,
          p_amount: amount,
          p_note: note,
          p_allow_overpay: allow,
          p_request_id: requestId,
        });

      let { error: saveError } = await recordPayment(allowOverpay);

      // Another payment for this month landed since the summary loaded.
      if (saveError?.hint === "salary_overpay") {
        let pending = null;
        try {
          pending = Number(JSON.parse(saveError.details || "{}").pending);
        } catch (_) {
          pending = null;
        }
        const msg = Number.isFinite(pending)
          ? `Remaining salary for ${formatMonthLabel(salaryMonthVal)} is now ${formatCurrency(pending)} (another payment was recorded). Record ${formatCurrency(amount)} anyway?`
          : `This amount exceeds the remaining salary for ${formatMonthLabel(salaryMonthVal)}. Record it anyway?`;
        if (!(await AppDialog.confirm(msg, { title: "Record payment", confirmLabel: "Record anyway" }))) {
          resetSubmitBtn();
          await refreshAll();
          return;
        }
        ({ error: saveError } = await recordPayment(true));
      }

      if (saveError) {
        resetSubmitBtn();
        AppError.handle(saveError, { target: paymentError });
        return;
      }
      clearFormRequestId(paymentForm);

      resetSubmitBtn();

      const savedDate = date;
      const savedSalaryMonth = salaryMonthVal;
      const savedStaffId = staffId;

      finishRecordFormSave(
        paymentForm,
        { date: savedDate },
        { date: RECORD_DATE_KEYS.salaryPayment }
      );
      if (savedSalaryMonth) {
        writeMonthYearValue(paymentSalaryMonthSelect, paymentSalaryYearSelect, savedSalaryMonth);
      }

      paymentSuccess?.classList.remove("hidden");
      await refreshAll();

      if (paymentStaffSelect && savedStaffId && staffList.some((s) => s.id === savedStaffId)) {
        paymentStaffSelect.value = savedStaffId;
      }
      updatePaymentMonthHint();
      if (typeof AppCache !== "undefined" && AppCache) {
        CacheInvalidation.invalidate("operational");
      }
    });
  }

  paymentStaffSelect?.addEventListener("change", updatePaymentMonthHint);
  paymentFillRemainingBtn?.addEventListener("click", fillPaymentRemaining);

  function onPaymentSalaryMonthChange() {
    const monthVal = getPaymentSalaryMonth();
    if (paymentDateInput && monthVal) {
      paymentDateInput.value = suggestPaymentDate(monthVal);
    }
    updatePaymentMonthHint();
  }

  paymentSalaryMonthSelect?.addEventListener("change", onPaymentSalaryMonthChange);
  paymentSalaryYearSelect?.addEventListener("change", onPaymentSalaryMonthChange);

  function bindMonthYearFilter(monthSelect, yearSelect, onChange) {
    if (!monthSelect || !yearSelect) return;
    const handler = async () => {
      const val = readMonthYearValue(monthSelect, yearSelect);
      if (val) await onChange(val);
    };
    monthSelect.addEventListener("change", handler);
    yearSelect.addEventListener("change", handler);
  }

  bindMonthYearFilter(salaryMonthSelect, salaryYearSelect, async (val) => {
    syncHistoryMonth();
    writeMonthYearValue(paymentSalaryMonthSelect, paymentSalaryYearSelect, val);
    await renderSummary(val);
    await loadPaymentHistory(val);
  });

  bindMonthYearFilter(historyMonthSelect, historyYearSelect, async (val) => {
    await loadPaymentHistory(val);
  });

  const downloadCsvBtn = document.getElementById("salary-download-csv");
  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener("click", async () => {
      const monthVal = getSelectedMonth();
      if (!monthVal) return;
      await loadStaffMembers();
      const monthReady =
        attendanceMonthLoaded === monthVal && lopExclusionMonth === salaryMonthKey(monthVal);
      const [payments] = await Promise.all([
        loadPaymentsForSalaryMonth(monthVal),
        monthReady ? Promise.resolve() : loadMonthAttendanceMap(monthVal),
        monthReady ? Promise.resolve() : loadLopExclusions(monthVal),
      ]);
      if (!monthReady) appendLopExclusionNote();
      const paidMap = paidByStaffInRange(payments);
      const headers = [
        "Name",
        "Role",
        "Payable (₹)",
        "Loss of pay (₹)",
        "Loss of pay days",
        "Loss of pay excluded",
        "Over duty (₹)",
        "Over duty days",
        "Paid this month (₹)",
        "Remaining (₹)",
        "Status",
      ];
      const rows = staffList.map((s) => {
        const paid = paidMap.get(s.id) || 0;
        const ctx = getStaffSalaryMonthContext(s, paid, monthVal, recordsFor(s.id), isLopExcluded(s.id));
        const pay = ctx.balance?.pay;
        const remaining =
          ctx.advance > 0.009 ? `Advance ${ctx.advance}` : String(ctx.pending);
        return [
          String(s.name ?? "").replace(/"/g, '""'),
          String(s.role_display ?? "").replace(/"/g, '""'),
          String(ctx.payable),
          String(pay?.lopAmount ?? 0),
          String(pay?.lopDays ?? 0),
          pay?.lopExcluded ? "Yes" : "No",
          String(pay?.overDutyAmount ?? 0),
          String(pay?.overDutyDays ?? 0),
          String(paid),
          remaining,
          ctx.label,
        ];
      });
      const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `salary-summary-${monthVal}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  detailClose?.addEventListener("click", closeDetailModal);
  detailDismiss?.addEventListener("click", closeDetailModal);
  detailBackdrop?.addEventListener("click", closeDetailModal);
  detailAddPaymentBtn?.addEventListener("click", () => {
    if (detailStaffId) {
      closeDetailModal();
      prefillPayment(detailStaffId);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && detailOverlay?.getAttribute("aria-hidden") === "false") {
      closeDetailModal();
    }
  });

  bindSalaryDeleteDelegation(document.getElementById("salary-payments-body"));
  bindSalaryDeleteDelegation(document.getElementById("salary-detail-payments-body"));

  await refreshAll();
});
