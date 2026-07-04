/* global requireAuth, applyRoleVisibility, supabaseClient, formatCurrency, AppCache, AppError, getLocalDateString, toLocalDateString, escapeHtml, formatDisplayDate, PumpSettings, loadPumpSettings, AppConfig, initPageSections, populateMonthYearSelects, readMonthYearValue, writeMonthYearValue, StaffEmployees, CacheInvalidation, AdminDelete, getMonthRange, formatNumberPlain, initPersistedDateInput, finishRecordFormSave, RECORD_DATE_KEYS */

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

function isMissingSalaryPaymentIdColumn(error) {
  const msg = String(error?.message || "");
  return /salary_payment_id/i.test(msg) || error?.code === "PGRST204";
}

function isMissingSalaryMonthExclusionsTable(error) {
  const msg = String(error?.message || "");
  return (
    /salary_month_exclusions/i.test(msg) ||
    error?.code === "PGRST204" ||
    error?.code === "42P01"
  );
}

const SALARY_NA_STATUS = {
  label: "Not applicable",
  className: "salary-status--na",
};

function getStaffSalaryMonthContext(staff, paid, exclusion) {
  if (exclusion) {
    return {
      isNa: true,
      label: SALARY_NA_STATUS.label,
      className: SALARY_NA_STATUS.className,
      payable: null,
      pending: null,
      advance: 0,
      paid: Number(paid ?? 0),
      exclusion,
    };
  }
  const status = salaryStatusInfo(staff.monthly_salary, paid, staff);
  const { salary: payable, pending } = computeSalaryBalance(staff.monthly_salary, paid, staff);
  return {
    isNa: false,
    label: status.label,
    className: status.className,
    payable,
    pending: status.pending,
    advance: status.advance,
    paid: Number(paid ?? 0),
    exclusion: null,
  };
}

function formatSalaryAmount(value) {
  return value == null ? "—" : formatCurrency(value);
}

function formatMonthLabel(monthValue) {
  if (!monthValue) return "—";
  const [year, month] = monthValue.split("-").map(Number);
  const d = new Date(year, month - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

const SALARY_SLIP_PRINT_CSS = "css/salary-slip-print.css?v=1";

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
  return Math.round(Number(value) * 100) / 100;
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

function computeSalaryBalance(monthlySalary, paid, staff) {
  const gross = Number(monthlySalary ?? 0);
  const payable = staff ? computePfBreakdown(gross, staff).netSalary : gross;
  const totalPaid = Number(paid ?? 0);
  const pending = Math.max(0, payable - totalPaid);
  const advance = Math.max(0, totalPaid - payable);
  return { salary: payable, gross, totalPaid, pending, advance };
}

function salaryStatusInfo(monthlySalary, paid, staff) {
  const { salary, totalPaid, pending, advance } = computeSalaryBalance(monthlySalary, paid, staff);
  if (salary <= 0) {
    return { label: "No salary set", className: "salary-status--none", pending, advance };
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

function salaryExpenseDescription(staff, note) {
  if (!staff) return "Salary";
  const n = note != null && String(note).trim() !== "" ? String(note).trim() : null;
  return `Salary: ${staff.name}${n ? ` - ${n}` : ""}`;
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

function getStaffBalanceForMonth(staffId, payments, employees) {
  const staff = (employees || []).find((s) => s.id === staffId);
  if (!staff) return null;
  const paidMap = paidByStaffInRange(payments);
  const paid = paidMap.get(staffId) || 0;
  const balance = computeSalaryBalance(staff.monthly_salary, paid, staff);
  return {
    staff,
    paid,
    ...balance,
    status: salaryStatusInfo(staff.monthly_salary, paid, staff),
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

function buildSalarySlipHtml(staff, staffPayments, monthValue) {
  const monthLabel = formatMonthLabel(monthValue);
  const payPeriod = getPayPeriodLabel(monthValue);
  const totalPaid = staffPayments.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const pf = computePfBreakdown(staff.monthly_salary, staff);
  const { pending: netPending, advance: netAdvance } = computeSalaryBalance(
    staff.monthly_salary,
    totalPaid,
    staff
  );
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
          <td class="num">₹ ${formatNumberPlain(p.amount)}</td>
          <td>${escapeHtml(p.note || "—")}</td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="text-align:center;color:#64748b">No salary disbursements recorded for this month</td></tr>`;

  const balanceRow = netAdvance > 0.009
    ? `<tr class="salary-slip-summary-balance"><td>Advance paid (over net salary)</td><td>₹ ${formatNumberPlain(netAdvance)}</td></tr>`
    : netPending > 0.009
      ? `<tr class="salary-slip-summary-balance"><td>Balance payable (net)</td><td>₹ ${formatNumberPlain(netPending)}</td></tr>`
      : `<tr class="salary-slip-summary-paid"><td>Balance payable (net)</td><td>₹ 0.00 — Settled</td></tr>`;

  const employerPfBlock =
    pf.employerPf > 0
      ? `
      <div class="salary-slip-employer">
        <p class="salary-slip-employer-title">Employer contribution (statutory)</p>
        <table>
          <tr>
            <td>Employer PF (fixed monthly)</td>
            <td>₹ ${formatNumberPlain(pf.employerPf)}</td>
          </tr>
        </table>
        <p style="margin:3pt 0 0;font-size:6.8pt;color:#64748b">Employer PF is deposited to EPFO separately and is not deducted from employee take-home pay.</p>
      </div>`
      : "";

  return `
    <article class="salary-slip-sheet" data-slip-ref="${escapeHtml(slipRef)}">
      <header class="salary-slip-head">
        <div class="salary-slip-letterhead">
          <img src="${slipAssetUrl(AppConfig.BPCL_LOGO_SRC)}" alt="Bharat Petroleum" class="salary-slip-logo" width="56" height="68" />
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
          <dd>₹ ${formatNumberPlain(pf.gross)}</dd>
        </div>
      </dl>

      <div class="salary-slip-pay-grid">
        <div class="salary-slip-pay-col">
          <p class="salary-slip-pay-col-title">Earnings</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Gross salary</td>
              <td>₹ ${formatNumberPlain(pf.gross)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total earnings</td>
              <td>₹ ${formatNumberPlain(pf.gross)}</td>
            </tr>
          </table>
        </div>
        <div class="salary-slip-pay-col salary-slip-pay-col--deductions">
          <p class="salary-slip-pay-col-title">Deductions</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Employee PF (fixed monthly)</td>
              <td>₹ ${formatNumberPlain(pf.employeePf)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total deductions</td>
              <td>₹ ${formatNumberPlain(pf.employeePf)}</td>
            </tr>
          </table>
        </div>
      </div>

      ${employerPfBlock}

      <div class="salary-slip-net-box">
        <span class="salary-slip-net-label">Net salary (take-home)</span>
        <span class="salary-slip-net-amount">₹ ${formatNumberPlain(pf.netSalary)}</span>
      </div>
      <p class="salary-slip-words"><strong>In words:</strong> ${escapeHtml(amountInWordsINR(pf.netSalary))}</p>

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
            <td class="num">₹ ${formatNumberPlain(totalPaid)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <table class="salary-slip-summary">
        <tr class="salary-slip-summary-net">
          <td>Net salary for month</td>
          <td>₹ ${formatNumberPlain(pf.netSalary)}</td>
        </tr>
        <tr class="salary-slip-summary-total">
          <td>Total disbursed this month</td>
          <td>₹ ${formatNumberPlain(totalPaid)}</td>
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
      <p class="salary-slip-note">Computer-generated salary slip. PF amounts are fixed per employee (set in HR → Staff). Disbursement rows reflect actual payments recorded for ${escapeHtml(monthLabel)}.</p>
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

async function waitForSalarySlipPrintReady(doc, win) {
  await new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 5000);
    const finish = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    if (win.document.readyState === "complete") {
      finish();
    } else {
      win.addEventListener("load", finish, { once: true });
    }
  });

  const logo = doc.querySelector(".salary-slip-logo");
  if (logo && !logo.complete) {
    await new Promise((resolve) => {
      logo.addEventListener("load", resolve, { once: true });
      logo.addEventListener("error", resolve, { once: true });
      window.setTimeout(resolve, 2500);
    });
  }

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  void doc.body.offsetHeight;
}

async function runSalarySlipPrint(staff, staffPayments, monthValue) {
  const [sheetHtml, cssText] = await Promise.all([
    Promise.resolve(buildSalarySlipHtml(staff, staffPayments, monthValue)),
    getSalarySlipPrintCssText(),
  ]);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Salary slip print");
  iframe.style.cssText =
    "position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    throw new Error("Print frame unavailable");
  }

  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(staff.name || "Staff")} · Salary slip</title>
  <style>${cssText.replace(/<\/style/gi, "<\\/style")}</style>
</head>
<body>
  ${sheetHtml}
</body>
</html>`);
  doc.close();

  try {
    await waitForSalarySlipPrintReady(doc, win);
    const cleanup = () => iframe.remove();
    win.addEventListener("afterprint", cleanup, { once: true });
    win.focus();
    win.print();
    window.setTimeout(cleanup, 5000);
  } catch (err) {
    iframe.remove();
    throw err;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
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
  const detailNaBanner = document.getElementById("salary-detail-na-banner");
  const detailNaBannerText = document.getElementById("salary-detail-na-banner-text");
  const detailAdminNa = document.getElementById("salary-detail-admin-na");
  const detailNaNoteInput = document.getElementById("salary-na-note");
  const detailMarkNaBtn = document.getElementById("salary-detail-mark-na");
  const detailRestoreNaBtn = document.getElementById("salary-detail-restore-na");

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
  let monthExclusions = new Map();
  let monthExclusionsSupported = true;
  let detailStaffId = null;

  const historyActionsHead = document.getElementById("salary-history-actions-head");
  const detailActionsHead = document.getElementById("salary-detail-actions-head");
  if (historyActionsHead) {
    historyActionsHead.textContent = isAdmin ? "Actions" : "Slip";
  }
  if (detailActionsHead) {
    detailActionsHead.hidden = !isAdmin;
  }

  async function deleteLinkedSalaryExpense(payment, staff) {
    if (payment?.id) {
      const { data: linked, error: linkErr } = await supabaseClient
        .from("expenses")
        .select("id")
        .eq("salary_payment_id", payment.id)
        .limit(1);

      if (!linkErr && linked?.length) {
        const { error: delErr } = await supabaseClient.from("expenses").delete().eq("id", linked[0].id);
        if (delErr) AppError.report(delErr, { context: "deleteLinkedSalaryExpenseById" });
        return;
      }
      if (linkErr && !isMissingSalaryPaymentIdColumn(linkErr)) {
        AppError.report(linkErr, { context: "deleteLinkedSalaryExpenseLookupById" });
      }
    }

    const desc = salaryExpenseDescription(staff, payment.note);
    const { data, error } = await supabaseClient
      .from("expenses")
      .select("id")
      .eq("category", "salary")
      .eq("date", payment.date)
      .eq("amount", payment.amount)
      .eq("description", desc)
      .limit(1);

    if (error) {
      AppError.report(error, { context: "deleteLinkedSalaryExpenseLookup" });
      return;
    }
    if (!data?.length) return;

    const { error: delErr } = await supabaseClient.from("expenses").delete().eq("id", data[0].id);
    if (delErr) {
      AppError.report(delErr, { context: "deleteLinkedSalaryExpense" });
    }
  }

  async function deleteSalaryPayment(payment, staff) {
    if (!isAdmin) {
      alert("Only an admin can delete salary payments.");
      return;
    }
    if (!payment?.id) return;

    const staffName = staff?.name || "this staff member";
    const confirmed = confirm(
      `Delete salary payment of ${formatCurrency(payment.amount)} for ${staffName} on ${formatDisplayDate(payment.date)}?\n\nThe linked expense entry will also be removed. This cannot be undone.`
    );
    if (!confirmed) return;

    const { error } = await supabaseClient.from("salary_payments").delete().eq("id", payment.id);
    if (error) {
      alert(AppError.getUserMessage(error));
      AppError.report(error, { context: "deleteSalaryPayment", id: payment.id });
      return;
    }

    await deleteLinkedSalaryExpense(payment, staff);

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
        alert("Payment not found. Refresh the page and try again.");
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
    detailOverlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function closeDetailModal() {
    if (!detailOverlay) return;
    detailOverlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
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
    const exclusion = monthExclusions.get(staffId) || null;
    const ctx = getStaffSalaryMonthContext(staff, paid, exclusion);
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

    if (detailNaBanner) {
      if (ctx.isNa) {
        const reason = exclusion?.note?.trim();
        if (detailNaBannerText) {
          detailNaBannerText.textContent = reason
            ? `Not applicable for ${monthLabel} — ${reason}`
            : `Not applicable for ${monthLabel}. Excluded from payroll totals.`;
        }
        detailNaBanner.classList.remove("hidden");
      } else {
        detailNaBanner.classList.add("hidden");
        if (detailNaBannerText) detailNaBannerText.textContent = "";
      }
    }

    if (detailAdminNa) {
      detailAdminNa.classList.toggle(
        "hidden",
        !isAdmin || !monthExclusionsSupported || ctx.isNa
      );
    }
    if (detailNaNoteInput) {
      detailNaNoteInput.value = "";
      detailNaNoteInput.disabled = false;
    }
    if (detailMarkNaBtn) {
      detailMarkNaBtn.classList.remove("hidden");
    }
    if (detailRestoreNaBtn) {
      detailRestoreNaBtn.classList.toggle("hidden", !ctx.isNa || !isAdmin);
    }

    const balanceValue = ctx.isNa ? "—" : formatCurrency(ctx.pending);
    const balanceClass =
      ctx.isNa || ctx.pending <= 0.009 ? "salary-detail-balance is-clear" : "salary-detail-balance";

    const pf = computePfBreakdown(staff.monthly_salary, staff);
    const pfNo = staff.pf_number?.trim();

    if (statsEl) {
      statsEl.innerHTML = `
        <div><dt>Gross salary</dt><dd>${ctx.isNa ? "—" : formatCurrency(staff.monthly_salary)}</dd></div>
        <div><dt>Net (after PF)</dt><dd>${ctx.isNa ? "—" : formatCurrency(pf.netSalary)}</dd></div>
        <div><dt>PF contribution</dt><dd>${
          ctx.isNa
            ? "—"
            : pf.fixedAmount > 0
              ? formatCurrency(pf.fixedAmount)
              : '<span class="muted">Not set — <a href="staff.html">Staff</a></span>'
        }</dd></div>
        <div><dt>Employer PF</dt><dd>${ctx.isNa ? "—" : formatCurrency(pf.employerPf)}</dd></div>
        <div><dt>PF / UAN</dt><dd>${pfNo ? escapeHtml(pfNo) : '<span class="muted">Not set</span>'}</dd></div>
        <div><dt>Mobile</dt><dd>${staff.phone_number ? escapeHtml(staff.phone_number) : '<span class="muted">—</span>'}</dd></div>
        <div><dt>Paid this month</dt><dd>${formatCurrency(paid)}</dd></div>
        <div><dt>Remaining</dt><dd class="${balanceClass}">${balanceValue}</dd></div>
        <div><dt>Status</dt><dd><span class="salary-status ${ctx.className}">${escapeHtml(ctx.label)}</span></dd></div>
      `;
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
      detailPrintBtn.disabled = ctx.isNa;
      detailPrintBtn.title = ctx.isNa ? "Salary slip is not available for N/A months" : "";
      detailPrintBtn.onclick = async () => {
        if (ctx.isNa) return;
        try {
          await runSalarySlipPrint(staff, list, monthValue);
        } catch (err) {
          AppError.report(err, { context: "printSalarySlip" });
          alert(AppError.getUserMessage(err) || "Could not open the print dialog.");
        }
      };
    }

    if (detailAddPaymentBtn) {
      detailAddPaymentBtn.disabled = ctx.isNa;
      detailAddPaymentBtn.title = ctx.isNa
        ? "Restore this month before recording payment"
        : "";
    }
  }

  async function loadStaffMembers() {
    try {
      staffList = await StaffEmployees.loadActiveEmployees(supabaseClient, {
        isAdmin,
        useCache: true,
      });
    } catch (error) {
      AppError.report(error, { context: "loadStaffMembers" });
      staffList = [];
    }
    return staffList;
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
    const { data, error } = await supabaseClient
      .from("salary_payments")
      .select("id, employee_id, date, amount, note, salary_month")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: false });

    if (error) {
      if (isMissingSalaryMonthColumn(error)) {
        const { data: legacyData, error: legacyError } = await supabaseClient
          .from("salary_payments")
          .select("id, employee_id, date, amount, note")
          .gte("date", startDate)
          .lte("date", endDate)
          .order("date", { ascending: false });
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

    const { data, error } = await supabaseClient
      .from("salary_payments")
      .select("id, employee_id, date, amount, note, salary_month")
      .eq("salary_month", salaryMonth)
      .order("date", { ascending: false });

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

  async function loadSalaryMonthExclusions(monthValue) {
    if (!monthExclusionsSupported) return new Map();

    const salaryMonth = normalizeSalaryMonth(monthValue);
    if (!salaryMonth) return new Map();

    const { data, error } = await supabaseClient
      .from("salary_month_exclusions")
      .select("id, employee_id, note, salary_month")
      .eq("salary_month", salaryMonth);

    if (error) {
      if (isMissingSalaryMonthExclusionsTable(error)) {
        monthExclusionsSupported = false;
        return new Map();
      }
      AppError.report(error, { context: "loadSalaryMonthExclusions" });
      return new Map();
    }

    return new Map((data ?? []).map((row) => [row.employee_id, row]));
  }

  async function markSalaryMonthNa(staffId, monthValue, note) {
    if (!isAdmin) {
      alert("Only an admin can mark a salary month as not applicable.");
      return false;
    }
    if (!monthExclusionsSupported) {
      alert("Salary month exclusions are not available yet. Apply the latest database migration.");
      return false;
    }

    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return false;

    const salaryMonth = normalizeSalaryMonth(monthValue);
    if (!salaryMonth) return false;

    const paid = paidByStaffInRange(monthPayments).get(staffId) || 0;
    const monthLabel = formatMonthLabel(monthValue);
    let msg = `Mark ${staff.name} as not applicable for ${monthLabel}?\n\nThey will be excluded from payroll totals for this month.`;
    if (paid > 0.009) {
      msg += `\n\n${formatCurrency(paid)} is already recorded for this month. Payments stay in history but the month remains excluded from totals.`;
    }
    if (!confirm(msg)) return false;

    const payload = {
      employee_id: staffId,
      salary_month: salaryMonth,
      note: note?.trim() || null,
    };
    if (auth.session?.user?.id) payload.created_by = auth.session.user.id;

    const { error } = await supabaseClient.from("salary_month_exclusions").upsert(payload, {
      onConflict: "employee_id,salary_month",
    });

    if (error) {
      alert(AppError.getUserMessage(error));
      AppError.report(error, { context: "markSalaryMonthNa", staffId, monthValue });
      return false;
    }

    if (typeof AppCache !== "undefined" && AppCache) {
      CacheInvalidation.invalidate("operational");
    }
    await refreshAll();
    return true;
  }

  async function restoreSalaryMonth(staffId, monthValue) {
    if (!isAdmin) {
      alert("Only an admin can restore a salary month.");
      return false;
    }
    if (!monthExclusionsSupported) return false;

    const staff = staffList.find((s) => s.id === staffId);
    if (!staff) return false;

    const salaryMonth = normalizeSalaryMonth(monthValue);
    if (!salaryMonth) return false;

    const monthLabel = formatMonthLabel(monthValue);
    if (
      !confirm(
        `Restore ${staff.name} for ${monthLabel}?\n\nThey will rejoin payroll totals for this month based on their configured salary.`
      )
    ) {
      return false;
    }

    const { error } = await supabaseClient
      .from("salary_month_exclusions")
      .delete()
      .eq("employee_id", staffId)
      .eq("salary_month", salaryMonth);

    if (error) {
      alert(AppError.getUserMessage(error));
      AppError.report(error, { context: "restoreSalaryMonth", staffId, monthValue });
      return false;
    }

    if (typeof AppCache !== "undefined" && AppCache) {
      CacheInvalidation.invalidate("operational");
    }
    await refreshAll();
    return true;
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

    const exclusion = monthExclusions.get(staffId);
    if (exclusion) {
      paymentMonthHint.textContent = `${formatMonthLabel(monthVal)}: marked not applicable${
        exclusion.note?.trim() ? ` (${exclusion.note.trim()})` : ""
      }. Restore the month in salary details before recording payment.`;
      paymentMonthHint.classList.remove("hidden");
      return;
    }

    const payments = await getPaymentsForSalaryMonth(monthVal);
    const balance = getStaffBalanceForMonth(staffId, payments, staffList);
    if (!balance) return;

    const pf = computePfBreakdown(staff.monthly_salary, staff);
    const monthLabel = formatMonthLabel(monthVal);
    let remainingText;
    if (balance.salary <= 0) {
      remainingText = "no salary configured";
    } else if (balance.status.advance > 0.009) {
      remainingText = `advance ${formatCurrency(balance.status.advance)} paid`;
    } else if (balance.pending <= 0.009) {
      remainingText = "fully paid";
    } else {
      remainingText = `${formatCurrency(balance.pending)} remaining`;
    }

    paymentMonthHint.textContent = `${monthLabel}: net ${formatCurrency(pf.netSalary)} · ${formatCurrency(balance.paid)} paid · ${remainingText}`;
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
    const balance = getStaffBalanceForMonth(staffId, payments, staffList);
    if (!balance || balance.pending <= 0.009) {
      if (paymentAmountInput) paymentAmountInput.value = "";
      return;
    }
    if (paymentAmountInput) {
      paymentAmountInput.value = balance.pending.toFixed(2);
    }
  }

  async function renderSummary(monthValue) {
    const tbody = document.getElementById("salary-summary-body");
    const kpiPayroll = document.getElementById("salary-kpi-payroll");
    const kpiPaid = document.getElementById("salary-kpi-paid");
    const kpiPending = document.getElementById("salary-kpi-pending");
    if (!tbody) return;

    if (!staffList.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="muted">Add staff in <a href="staff.html">HR → Staff</a> first (admin).</td></tr>';
      if (kpiPayroll) kpiPayroll.textContent = "—";
      if (kpiPaid) kpiPaid.textContent = "—";
      if (kpiPending) kpiPending.textContent = "—";
      return;
    }

    monthPayments = await loadPaymentsForSalaryMonth(monthValue);
    monthExclusions = await loadSalaryMonthExclusions(monthValue);
    const paidMap = paidByStaffInRange(monthPayments);

    let totalPayroll = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let naCount = 0;

    staffList.forEach((s) => {
      const exclusion = monthExclusions.get(s.id);
      if (exclusion) {
        naCount += 1;
        return;
      }
      const gross = Number(s.monthly_salary ?? 0);
      const paid = paidMap.get(s.id) || 0;
      const { salary: payable, pending } = computeSalaryBalance(gross, paid, s);
      totalPayroll += payable;
      totalPaid += paid;
      totalPending += pending;
    });

    if (kpiPayroll) kpiPayroll.textContent = formatCurrency(totalPayroll);
    if (kpiPaid) kpiPaid.textContent = formatCurrency(totalPaid);
    if (kpiPending) kpiPending.textContent = formatCurrency(totalPending);

    const kpiGrid = document.querySelector(".salary-kpi-grid");
    let kpiNote = document.getElementById("salary-kpi-note");
    if (naCount > 0) {
      if (!kpiNote && kpiGrid) {
        kpiNote = document.createElement("p");
        kpiNote.id = "salary-kpi-note";
        kpiNote.className = "muted salary-kpi-note";
        kpiGrid.insertAdjacentElement("afterend", kpiNote);
      }
      if (kpiNote) {
        kpiNote.textContent = `${naCount} staff excluded as not applicable for ${formatMonthLabel(monthValue)}.`;
        kpiNote.classList.remove("hidden");
      }
    } else if (kpiNote) {
      kpiNote.classList.add("hidden");
      kpiNote.textContent = "";
    }

    tbody.innerHTML = staffList
      .map((s) => {
        const paid = paidMap.get(s.id) || 0;
        const exclusion = monthExclusions.get(s.id) || null;
        const ctx = getStaffSalaryMonthContext(s, paid, exclusion);
        const remaining = ctx.isNa
          ? "—"
          : ctx.advance > 0.009
            ? `<span class="muted">Advance ${formatCurrency(ctx.advance)}</span>`
            : formatCurrency(ctx.pending);
        const name = escapeHtml(s.name);
        const role = escapeHtml(s.role_display ?? "—");
        const rowClass = ctx.isNa ? "salary-row--na" : "";
        const payDisabled = ctx.isNa ? " disabled title=\"Month marked not applicable\"" : "";
        const slipDisabled = ctx.isNa ? " disabled title=\"Salary slip not available for N/A months\"" : "";
        return `
          <tr data-staff-id="${escapeHtml(s.id)}" class="${rowClass}" tabindex="0" role="button" aria-label="View ${name} salary details">
            <td>${name}</td>
            <td>${role}</td>
            <td class="num">${formatSalaryAmount(ctx.payable)}</td>
            <td class="num">${formatCurrency(paid)}</td>
            <td class="num">${remaining}</td>
            <td><span class="salary-status ${ctx.className}">${escapeHtml(ctx.label)}</span></td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small salary-view-btn" data-staff-id="${escapeHtml(s.id)}">Details</button>
              <button type="button" class="button-secondary button-small salary-slip-btn" data-staff-id="${escapeHtml(s.id)}"${slipDisabled}>Slip</button>
              <button type="button" class="button-secondary button-small add-payment-btn" data-staff-id="${escapeHtml(s.id)}"${payDisabled}>Pay</button>
            </td>
          </tr>
        `;
      })
      .join("");

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
        if (!staff || monthExclusions.has(staffId)) return;
        const list = paymentsForEmployee(monthPayments, staffId);
        try {
          await runSalarySlipPrint(staff, list, monthValue);
        } catch (err) {
          AppError.report(err, { context: "printSalarySlipQuick" });
          alert(AppError.getUserMessage(err) || "Could not open the print dialog.");
        }
      });
    });

    tbody.querySelectorAll(".add-payment-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const staffId = btn.getAttribute("data-staff-id");
        if (monthExclusions.has(staffId)) {
          alert("This month is marked not applicable. Open details and restore the month before recording payment.");
          return;
        }
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

    const staffById = new Map(staffList.map((s) => [s.id, s]));

    tbody.innerHTML = list
      .map((p) => {
        const staff = staffById.get(p.employee_id);
        const name = staff ? escapeHtml(staff.name) : "—";
        const staffId = p.employee_id;
        return `
          <tr>
            <td>${escapeHtml(formatDisplayDate(p.date))}</td>
            <td>${name}</td>
            <td class="num">${formatCurrency(p.amount)}</td>
            <td>${escapeHtml(p.note ?? "—")}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small history-slip-btn" data-staff-id="${escapeHtml(staffId)}">Slip</button>
              ${salaryDeleteButtonHtml(p, staff, isAdmin)}
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".history-slip-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const staffId = btn.getAttribute("data-staff-id");
        const staff = staffList.find((s) => s.id === staffId);
        if (!staff) return;
        const payments = await loadPaymentsForMonth(monthValue);
        const list = paymentsForEmployee(payments, staffId);
        try {
          await runSalarySlipPrint(staff, list, monthValue);
        } catch (err) {
          AppError.report(err, { context: "printHistorySlip" });
          alert(AppError.getUserMessage(err) || "Could not open the print dialog.");
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

      const staff = staffList.find((s) => s.id === staffId);

      if (monthExclusions.has(staffId)) {
        resetSubmitBtn();
        paymentError?.classList.remove("hidden");
        if (paymentError) {
          paymentError.textContent = `${staff?.name || "This staff member"} is marked not applicable for ${formatMonthLabel(salaryMonthVal)}. Restore the month in salary details first.`;
        }
        return;
      }
      const payments = await getPaymentsForSalaryMonth(salaryMonthVal);
      const balance = getStaffBalanceForMonth(staffId, payments, staffList);
      if (balance && balance.salary > 0 && amount > balance.pending + 0.009) {
        const overBy = roundMoney(amount - balance.pending);
        const msg =
          balance.pending <= 0.009
            ? `Net salary for ${formatMonthLabel(salaryMonthVal)} is already settled. Record ${formatCurrency(amount)} as advance?`
            : `Amount exceeds remaining balance (${formatCurrency(balance.pending)}). This will overpay by ${formatCurrency(overBy)}. Continue?`;
        if (!confirm(msg)) {
          resetSubmitBtn();
          return;
        }
      }

      const payload = {
        employee_id: staffId,
        date,
        amount,
        note,
        salary_month: salaryMonth,
      };
      if (auth.session?.user?.id) payload.created_by = auth.session.user.id;

      let insertedPayment = null;
      let paymentErrorResult = null;

      ({ data: insertedPayment, error: paymentErrorResult } = await supabaseClient
        .from("salary_payments")
        .insert(payload)
        .select("id")
        .single());

      if (paymentErrorResult && isMissingSalaryMonthColumn(paymentErrorResult)) {
        const legacyPayload = { employee_id: staffId, date, amount, note };
        if (auth.session?.user?.id) legacyPayload.created_by = auth.session.user.id;
        ({ data: insertedPayment, error: paymentErrorResult } = await supabaseClient
          .from("salary_payments")
          .insert(legacyPayload)
          .select("id")
          .single());
      }

      if (paymentErrorResult) {
        resetSubmitBtn();
        AppError.handle(paymentErrorResult, { target: paymentError });
        return;
      }

      const desc = salaryExpenseDescription(staff, note);
      const expensePayload = {
        date,
        category: "salary",
        description: desc,
        amount,
      };
      if (insertedPayment?.id) expensePayload.salary_payment_id = insertedPayment.id;
      if (auth.session?.user?.id) expensePayload.created_by = auth.session.user.id;

      let expenseError = null;
      ({ error: expenseError } = await supabaseClient.from("expenses").insert(expensePayload));

      if (expenseError && isMissingSalaryPaymentIdColumn(expenseError)) {
        delete expensePayload.salary_payment_id;
        ({ error: expenseError } = await supabaseClient.from("expenses").insert(expensePayload));
      }

      if (expenseError) {
        if (insertedPayment?.id) {
          const { error: rollbackError } = await supabaseClient
            .from("salary_payments")
            .delete()
            .eq("id", insertedPayment.id);
          if (rollbackError) {
            AppError.report(rollbackError, {
              context: "rollbackSalaryPaymentAfterExpenseFail",
              paymentId: insertedPayment.id,
            });
          }
        }
        resetSubmitBtn();
        AppError.handle(expenseError, { target: paymentError });
        return;
      }

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
      const payments = await loadPaymentsForSalaryMonth(monthVal);
      const exclusions = await loadSalaryMonthExclusions(monthVal);
      const paidMap = paidByStaffInRange(payments);
      const headers = [
        "Name",
        "Role",
        "Net monthly (₹)",
        "Paid this month (₹)",
        "Remaining (₹)",
        "Status",
        "N/A reason",
      ];
      const rows = staffList.map((s) => {
        const paid = paidMap.get(s.id) || 0;
        const exclusion = exclusions.get(s.id) || null;
        const ctx = getStaffSalaryMonthContext(s, paid, exclusion);
        const remaining = ctx.isNa
          ? "N/A"
          : ctx.advance > 0.009
            ? `Advance ${ctx.advance}`
            : String(ctx.pending);
        return [
          String(s.name ?? "").replace(/"/g, '""'),
          String(s.role_display ?? "").replace(/"/g, '""'),
          ctx.isNa ? "N/A" : String(ctx.payable),
          String(paid),
          remaining,
          ctx.label,
          String(exclusion?.note ?? "").replace(/"/g, '""'),
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
      if (monthExclusions.has(detailStaffId)) {
        alert("This month is marked not applicable. Restore it before recording payment.");
        return;
      }
      closeDetailModal();
      prefillPayment(detailStaffId);
    }
  });

  detailMarkNaBtn?.addEventListener("click", async () => {
    if (!detailStaffId) return;
    detailMarkNaBtn.disabled = true;
    try {
      const ok = await markSalaryMonthNa(
        detailStaffId,
        getSelectedMonth(),
        detailNaNoteInput?.value || ""
      );
      if (ok) openDetailModal(detailStaffId, getSelectedMonth());
    } finally {
      detailMarkNaBtn.disabled = false;
    }
  });

  detailRestoreNaBtn?.addEventListener("click", async () => {
    if (!detailStaffId) return;
    detailRestoreNaBtn.disabled = true;
    try {
      const ok = await restoreSalaryMonth(detailStaffId, getSelectedMonth());
      if (ok) openDetailModal(detailStaffId, getSelectedMonth());
    } finally {
      detailRestoreNaBtn.disabled = false;
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
