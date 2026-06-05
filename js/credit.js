/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, CreditCustomerDetail, initPageSections, toLocalDateString, debounce, createDateRangeFilter, readDateRangeFromControls, formatDateRangeLabel, setFilterState, PumpSettings, loadPumpSettings, AppConfig */

const { filterEntriesByRange, sumAmount, createBreakdownPager } = CreditCustomerDetail;

const PAGE_SIZE = 25;

let customerPeriodFilterApi = null;

let creditPagination = {
  offset: 0,
  hasMore: true,
  totalCount: 0,
  isLoading: false,
  ledgerData: [],
  searchQuery: "",
};

let customerName = "";
let customerId = null;
let customerIds = [];
let customerOutstandingDue = 0;
let customerContact = { mobile: "", address: "" };
let customerVehicleNos = [];
let lastCustomerSummary = null;
let lastCustomerSummaryContext = null;
let creditSummaryPrintBusy = false;
const CREDIT_SUMMARY_PRINT_CSS = "css/credit-summary-print.css?v=1";

let creditPager = null;
let paymentPager = null;
let customerSuggestions = [];
let customerComboboxActiveIndex = -1;
let customerComboboxMatches = [];

function isCustomerView() {
  return Boolean(customerName);
}

function customerDetailUrl(row) {
  const name = row.customer_name || row || "";
  return `credit.html?${new URLSearchParams({ name: name || "" }).toString()}`;
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    pageName: "credit",
  });
  if (!auth) return;

  applyRoleVisibility(auth.role);

  const params = new URLSearchParams(window.location.search);
  customerName = (params.get("name") || "").trim();
  customerId = params.get("id") || null;

  if (isCustomerView()) {
    await initCustomerView();
    return;
  }

  initListView();
});

function setSidebarMode(mode) {
  const isCustomer = mode === "customer";
  document.body.classList.toggle("credit-customer-view", isCustomer);
  document.body.classList.toggle("credit-list-view", !isCustomer);

  const listNav = document.getElementById("credit-list-nav");
  const customerNav = document.getElementById("credit-customer-nav");
  if (listNav) {
    listNav.classList.toggle("hidden", isCustomer);
    listNav.hidden = isCustomer;
  }
  if (customerNav) {
    customerNav.classList.toggle("hidden", !isCustomer);
    customerNav.hidden = !isCustomer;
  }
}

function initListView() {
  setSidebarMode("list");
  setCustomerToolbarVisible(false);
  hideCustomerPanels();

  const form = document.getElementById("credit-form");
  if (form) {
    form.addEventListener("submit", (event) => handleCreditSubmit(event));
  }

  const transactionDateInput = document.getElementById("credit-date");
  if (transactionDateInput && typeof getLocalDateString === "function") {
    transactionDateInput.value = getLocalDateString();
  }

  const onCreditSearch = debounce((value) => {
    creditPagination.searchQuery = value;
    creditPagination.offset = 0;
    renderLedgerPage(true);
  }, 150);
  document.getElementById("credit-search")?.addEventListener("input", (e) => {
    onCreditSearch((e.target.value || "").trim().toLowerCase());
  });

  if (typeof initPageSections === "function") {
    initPageSections({
      navItemSelector: "#credit-list-nav .settings-nav-item",
      panelSelector: "#credit-panel-overview, #credit-panel-record, #credit-panel-outstanding",
      defaultSection: "overview",
      validSections: ["overview", "record", "outstanding"],
    });
  }

  initPaginationControls();
  initCustomerCombobox();
  loadCustomerNames();
  loadCreditLedger(true);
}

function hideCustomerPanels() {
  const ids = [
    "customer-balance-hero",
    "customer-period-toolbar",
    "customer-panel-summary",
    "settle-section",
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });
  document.querySelectorAll("section[data-panel='credit'], section[data-panel='payments']").forEach((el) => {
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });
}

function setCustomerToolbarVisible(visible) {
  ["customer-balance-hero", "customer-period-toolbar"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("hidden", !visible);
    el.hidden = !visible;
  });
}

async function initCustomerView() {
  if (typeof loadPumpSettings === "function") {
    await loadPumpSettings();
  }

  setSidebarMode("customer");
  setCustomerToolbarVisible(true);

  ["credit-panel-overview", "credit-panel-record", "credit-panel-outstanding"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });

  const breadcrumbEl = document.getElementById("breadcrumb-customer");
  const titleEl = document.getElementById("customer-title");
  if (breadcrumbEl) breadcrumbEl.textContent = customerName;
  if (titleEl) titleEl.textContent = customerName;
  document.title = `${customerName} · Credit · Bishnupriya Fuels`;

  const today = getLocalDateString();
  const settleDate = document.getElementById("settle-date");
  if (settleDate) settleDate.value = today;

  initCustomerViewFilter();
  document.getElementById("settle-btn")?.addEventListener("click", () => handleSettle());

  creditPager = createBreakdownPager(
    document.getElementById("credit-entries-body"),
    document.getElementById("credit-entries-empty"),
    document.getElementById("credit-entries-pagination"),
    document.getElementById("credit-entries-info"),
    document.getElementById("credit-entries-back"),
    document.getElementById("credit-entries-more")
  );
  paymentPager = createBreakdownPager(
    document.getElementById("payment-entries-body"),
    document.getElementById("payment-entries-empty"),
    document.getElementById("payment-entries-pagination"),
    document.getElementById("payment-entries-info"),
    document.getElementById("payment-entries-back"),
    document.getElementById("payment-entries-more")
  );
  const creditBody = document.getElementById("credit-entries-body");
  if (creditBody) creditBody.dataset.breakdownMode = "credit-rich";

  await resolveCustomerIds();
  initCustomerInfoEdit();

  if (typeof initPageSections === "function") {
    initPageSections({
      navItemSelector: "#credit-customer-nav .settings-nav-item",
      panelSelector:
        "#customer-panel-summary, #settle-section, section[data-panel='credit'], section[data-panel='payments']",
      defaultSection: "summary",
      validSections: ["summary", "settle", "credit", "payments"],
    });
  }

  document.getElementById("customer-summary-print-btn")?.addEventListener("click", () => {
    void handleCreditSummaryPrintClick();
  });

  await loadCustomerDetail();
}

function getCustomerViewFilter() {
  const range =
    customerPeriodFilterApi?.getRange?.() ||
    readDateRangeFromControls(
      document.getElementById("filter-range"),
      document.getElementById("filter-from"),
      document.getElementById("filter-to")
    );
  if (!range) {
    const today = getLocalDateString();
    return { asOfDate: today, from: today, to: today, selection: "today" };
  }
  return {
    asOfDate: range.end,
    from: range.start || "",
    to: range.end,
    selection: range.modeInfo?.mode || "custom",
  };
}

function updateCustomerFilterSummary() {
  const el = document.getElementById("customer-filter-summary");
  const range =
    customerPeriodFilterApi?.getRange?.() ||
    readDateRangeFromControls(
      document.getElementById("filter-range"),
      document.getElementById("filter-from"),
      document.getElementById("filter-to")
    );
  if (!el || !range) return;
  const activity = formatDateRangeLabel(range, range.modeInfo, { style: "dashboard" });
  el.textContent = `Showing ${activity} on Summary, Credit taken, and Settlements.`;
}

function resetCustomerPeriodFilter() {
  const rangeSelect = document.getElementById("filter-range");
  const fromInput = document.getElementById("filter-from");
  const toInput = document.getElementById("filter-to");
  if (rangeSelect) rangeSelect.value = "today";
  if (fromInput) fromInput.value = "";
  if (toInput) toInput.value = "";
  if (typeof setFilterState === "function") {
    setFilterState("credit_customer_period", { range: "today" });
  }
  customerPeriodFilterApi?.refresh?.();
}

function initCustomerViewFilter() {
  customerPeriodFilterApi = createDateRangeFilter({
    storageKey: "credit_customer_period",
    ranges: ["today", "this-week", "this-month", "all-time", "custom"],
    defaultRange: "this-month",
    rangeSelect: "filter-range",
    startInput: "filter-from",
    endInput: "filter-to",
    customRange: "customer-custom-range",
    form: "customer-view-filter",
    trigger: "auto",
    persist: true,
    runOnInit: false,
    customDefaults: "month-start",
    labelStyle: "dashboard",
    formatLabel: (range) => {
      const activity = formatDateRangeLabel(range, range.modeInfo, { style: "dashboard" });
      return `Showing ${activity} on Summary, Credit taken, and Settlements.`;
    },
    onApply: () => {
      void loadCustomerDetail();
    },
  });

  document.getElementById("reset-period-filter")?.addEventListener("click", resetCustomerPeriodFilter);
}

function normCustomerName(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function escapeIlikePattern(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function pickCustomerContact(rows) {
  const primary =
    rows.find((r) => r.id === customerId) ||
    rows.find((r) => Number(r.amount_due) > 0) ||
    rows[0];
  if (!primary) return { mobile: "", address: "" };
  return {
    mobile: String(primary.mobile ?? "").trim(),
    address: String(primary.address ?? "").trim(),
  };
}

function renderCustomerMeta(rows) {
  const vehicles = [...new Set(rows.map((r) => r.vehicle_no).filter(Boolean))];
  customerVehicleNos = vehicles;
  const meta = document.getElementById("customer-meta");
  if (!meta) return;
  const parts = [];
  if (customerContact.mobile) parts.push(`Mobile: ${customerContact.mobile}`);
  if (customerContact.address) parts.push(customerContact.address);
  if (vehicles.length) parts.push(`Vehicle: ${vehicles.join(", ")}`);
  const text = parts.join(" · ");
  meta.textContent = text;
  meta.classList.toggle("hidden", !text);
  meta.hidden = !text;
}

function setCustomerNameEditable(editable) {
  const row = document.getElementById("customer-name-row");
  if (!row) return;
  row.classList.toggle("is-editable", editable);
  if (editable) {
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute(
      "aria-label",
      `Edit details for ${customerName || "customer"}`
    );
  } else {
    row.removeAttribute("role");
    row.tabIndex = -1;
    row.removeAttribute("aria-label");
  }
}

function applyCustomerDisplayName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return;
  customerName = trimmed;
  const breadcrumbEl = document.getElementById("breadcrumb-customer");
  const titleEl = document.getElementById("customer-title");
  if (breadcrumbEl) breadcrumbEl.textContent = trimmed;
  if (titleEl) titleEl.textContent = trimmed;
  document.title = `${trimmed} · Credit · Bishnupriya Fuels`;
  const params = new URLSearchParams(window.location.search);
  params.set("name", trimmed);
  const hash = window.location.hash || "";
  const url = `${window.location.pathname}?${params.toString()}${hash}`;
  history.replaceState(null, "", url);
}

function openCustomerEditModal() {
  if (customerIds.length === 0 && !customerId) return;

  const overlay = document.getElementById("customer-edit-overlay");
  const nameInput = document.getElementById("edit-customer-name");
  const mobileInput = document.getElementById("edit-customer-mobile");
  const addressInput = document.getElementById("edit-customer-address");
  const msg = document.getElementById("customer-info-msg");

  if (nameInput) nameInput.value = customerName;
  if (mobileInput) mobileInput.value = customerContact.mobile;
  if (addressInput) addressInput.value = customerContact.address;
  msg?.classList.add("hidden");
  msg?.classList.remove("success", "error");

  if (overlay) {
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }
  nameInput?.focus();
}

function closeCustomerEditModal() {
  const overlay = document.getElementById("customer-edit-overlay");
  if (overlay) {
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }
  document.getElementById("customer-name-row")?.focus();
}

function initCustomerInfoEdit() {
  const row = document.getElementById("customer-name-row");
  row?.addEventListener("click", () => {
    if (!row.classList.contains("is-editable")) return;
    openCustomerEditModal();
  });
  row?.addEventListener("keydown", (e) => {
    if (!row.classList.contains("is-editable")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openCustomerEditModal();
    }
  });

  document.getElementById("customer-edit-close")?.addEventListener("click", closeCustomerEditModal);
  document.getElementById("customer-edit-backdrop")?.addEventListener("click", closeCustomerEditModal);
  document.getElementById("customer-info-cancel-btn")?.addEventListener("click", closeCustomerEditModal);
  document.getElementById("customer-info-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    void saveCustomerContact();
  });

  document.addEventListener("keydown", (e) => {
    const overlay = document.getElementById("customer-edit-overlay");
    if (e.key === "Escape" && overlay?.getAttribute("aria-hidden") === "false") {
      closeCustomerEditModal();
    }
  });
}

async function isCustomerNameTakenByOther(newName, ids) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const targetNorm = normCustomerName(trimmed);
  const pattern = `%${escapeIlikePattern(trimmed)}%`;
  const { data, error } = await supabaseClient
    .from("credit_customers")
    .select("id, customer_name")
    .ilike("customer_name", pattern);
  if (error) {
    AppError.report(error, { context: "isCustomerNameTakenByOther" });
    return false;
  }
  return (data || []).some(
    (r) => normCustomerName(r.customer_name) === targetNorm && !ids.includes(r.id)
  );
}

async function saveCustomerContact() {
  const msg = document.getElementById("customer-info-msg");
  const submitBtn = document.querySelector("#customer-info-form button[type='submit']");
  const ids = customerIds.length > 0 ? customerIds : customerId ? [customerId] : [];

  if (ids.length === 0) {
    if (msg) {
      msg.textContent = "No customer record found.";
      msg.classList.remove("hidden", "success");
      msg.classList.add("error");
    }
    return;
  }

  const newName = (document.getElementById("edit-customer-name")?.value || "").trim();
  const mobile = (document.getElementById("edit-customer-mobile")?.value || "").trim();
  const address = (document.getElementById("edit-customer-address")?.value || "").trim();

  if (!newName) {
    if (msg) {
      msg.textContent = "Customer name is required.";
      msg.classList.remove("hidden", "success");
      msg.classList.add("error");
    }
    return;
  }

  const nameChanged = normCustomerName(newName) !== normCustomerName(customerName);
  if (nameChanged && (await isCustomerNameTakenByOther(newName, ids))) {
    if (msg) {
      msg.textContent = "Another credit customer already uses this name.";
      msg.classList.remove("hidden", "success");
      msg.classList.add("error");
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (msg) msg.classList.add("hidden");

  const { error } = await supabaseClient
    .from("credit_customers")
    .update({
      customer_name: newName,
      mobile: mobile || null,
      address: address || null,
    })
    .in("id", ids);

  if (submitBtn) submitBtn.disabled = false;

  if (error) {
    if (msg) {
      msg.textContent = AppError.getUserMessage(error);
      msg.classList.remove("hidden", "success");
      msg.classList.add("error");
    }
    AppError.report(error, { context: "saveCustomerContact" });
    return;
  }

  customerContact = { mobile, address };
  if (nameChanged) applyCustomerDisplayName(newName);
  invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();
  closeCustomerEditModal();
}

async function resolveCustomerIds() {
  const needle = (customerName || "").trim();
  if (!needle) {
    customerIds = [];
    return;
  }
  const needleNorm = normCustomerName(needle);
  const pattern = `%${escapeIlikePattern(needle)}%`;
  const { data: list, error } = await supabaseClient
    .from("credit_customers")
    .select("id, vehicle_no, amount_due, last_payment, customer_name, mobile, address")
    .ilike("customer_name", pattern);

  if (error) {
    AppError.report(error, { context: "resolveCustomerIds" });
    return;
  }

  const rows = (list || []).filter((r) => normCustomerName(r.customer_name) === needleNorm);
  customerIds = rows.map((r) => r.id);
  if (!customerId && rows.length > 0) {
    const primary = rows.find((r) => Number(r.amount_due) > 0) || rows[0];
    customerId = primary.id;
  } else if (customerId && !customerIds.includes(customerId)) {
    const urlIdValid = rows.some((r) => r.id === customerId);
    if (urlIdValid) customerIds.push(customerId);
    else customerId = rows[0]?.id ?? null;
  }

  customerContact = pickCustomerContact(rows);
  renderCustomerMeta(rows);
  setCustomerNameEditable(rows.length > 0);

  const totalDue = rows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
  customerOutstandingDue = totalDue;
  const settleNav = document.querySelector("#credit-customer-nav .settings-nav-item[data-section='settle']");
  if (settleNav) {
    const hide = totalDue <= 0;
    settleNav.classList.toggle("hidden", hide);
    settleNav.hidden = hide;
  }
}

function creditSummaryAssetUrl(path) {
  return new URL(path, window.location.href).href;
}

function getCreditPrintStation() {
  return PumpSettings?.getCachedSync?.().station || AppConfig.DEFAULT_STATION;
}

function getCreditPrintStationLegalName() {
  const s = getCreditPrintStation();
  return s.legalName || AppConfig.DEFAULT_STATION.legalName;
}

function getCreditPrintStationTagline() {
  return getCreditPrintStation().tagline || AppConfig.DEFAULT_STATION.tagline;
}

function getCreditPrintStationGstin() {
  return getCreditPrintStation().gstin || AppConfig.DEFAULT_STATION.gstin;
}

function formatSummaryAmountPlain(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function sortSummaryEntriesByDate(entries) {
  return [...(entries || [])].sort((a, b) =>
    String(a.entry_date || "").localeCompare(String(b.entry_date || ""))
  );
}

function updateCreditSummaryPrintButton() {
  const btn = document.getElementById("customer-summary-print-btn");
  if (!btn) return;
  const canPrint = Boolean(lastCustomerSummary && lastCustomerSummaryContext?.customerName);
  btn.disabled = !canPrint;
}

function buildCreditSummaryLedgerRows(entries, emptyLabel) {
  const sorted = sortSummaryEntriesByDate(entries);
  if (!sorted.length) {
    return `<tr><td colspan="3" class="muted" style="text-align:center">${escapeHtml(emptyLabel)}</td></tr>`;
  }
  return sorted
    .map(
      (e, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(formatDisplayDate(e.entry_date))}</td>
          <td class="num">₹ ${formatSummaryAmountPlain(e.amount)}</td>
        </tr>`
    )
    .join("");
}

function creditSummaryReportHeader(title, subtitleLines) {
  const gstin = getCreditPrintStationGstin();
  const subtitles = (subtitleLines || [])
    .filter(Boolean)
    .map((line) => `<p class="report-subtitle">${line}</p>`)
    .join("");
  return `
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${creditSummaryAssetUrl(AppConfig.BPCL_LOGO_SRC)}" alt="Bharat Petroleum" class="report-bpcl-logo" width="56" height="68" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(getCreditPrintStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(getCreditPrintStationTagline())}</p>
          ${gstin ? `<p class="report-gstin">GSTIN: ${escapeHtml(gstin)}</p>` : ""}
          <p class="report-title">${escapeHtml(title)}</p>
          ${subtitles}
        </div>
      </div>
    </header>`;
}

function buildCreditSummaryPrintHtml(summary, context) {
  const outstanding = summary ? Number(summary.remaining) : 0;
  const creditTaken = summary ? Number(summary.credit_taken) : 0;
  const settlementDone = summary ? Number(summary.settlement_done) : 0;
  const periodCredit = context?.periodCredit ?? 0;
  const periodSettled = context?.periodSettled ?? 0;
  const name = context?.customerName || customerName || "Customer";
  const asOfLabel = context?.asOfDate ? formatDisplayDate(context.asOfDate) : "—";
  const generatedOn = formatDisplayDate(getLocalDateString());
  const periodActivity = context?.periodActivity || "";
  const periodScopedOutstanding = Boolean(periodActivity);
  const cleared = outstanding <= 0;

  let creditMeta = "";
  if (summary) {
    const first = summary.first_sale_date ? formatDisplayDate(summary.first_sale_date) : null;
    const last = summary.last_credit_date ? formatDisplayDate(summary.last_credit_date) : null;
    if (first && last) creditMeta = `First credit: ${first} · Last credit: ${last}`;
    else if (first) creditMeta = `First credit: ${first}`;
    else if (last) creditMeta = `Last credit: ${last}`;
  }

  let settlementMeta = "";
  if (summary?.last_payment_date) {
    settlementMeta = `Last settlement: ${formatDisplayDate(summary.last_payment_date)}`;
  }

  const vehicleLine =
    context?.vehicles?.length > 0 ? context.vehicles.join(", ") : "—";
  const mobile = context?.mobile?.trim() || "—";
  const address = context?.address?.trim() || "—";

  const creditRows = buildCreditSummaryLedgerRows(
    summary?.credit_entries,
    "No credit entries through this date"
  );
  const paymentRows = buildCreditSummaryLedgerRows(
    summary?.payment_entries,
    "No settlements through this date"
  );

  const creditTotal = sortSummaryEntriesByDate(summary?.credit_entries).reduce(
    (s, e) => s + Number(e.amount || 0),
    0
  );
  const paymentTotal = sortSummaryEntriesByDate(summary?.payment_entries).reduce(
    (s, e) => s + Number(e.amount || 0),
    0
  );

  return `
    <article class="credit-summary-sheet report-print-sheet">
      ${creditSummaryReportHeader("Credit customer — account summary", [
        `Customer: <strong>${escapeHtml(name)}</strong>`,
        `Totals through: ${escapeHtml(asOfLabel)} · Generated: ${escapeHtml(generatedOn)}`,
      ])}

      <div class="credit-summary-title-band">
        <h2 class="credit-summary-doc-title">Account statement</h2>
        <p class="credit-summary-doc-meta">
          ${
            periodActivity
              ? `Activity period: ${escapeHtml(periodActivity)}. Credit ₹ ${formatSummaryAmountPlain(periodCredit)}, settled ₹ ${formatSummaryAmountPlain(periodSettled)}, outstanding ₹ ${formatSummaryAmountPlain(outstanding)} (net for this period).`
              : `Figures below are cumulative through ${escapeHtml(asOfLabel)}.`
          }
        </p>
      </div>

      <dl class="credit-summary-party">
        <dt>Customer</dt>
        <dd class="credit-summary-party-name">${escapeHtml(name)}</dd>
        <div>
          <dt>Mobile</dt>
          <dd>${escapeHtml(mobile)}</dd>
        </div>
        <div>
          <dt>Vehicle no.</dt>
          <dd>${escapeHtml(vehicleLine)}</dd>
        </div>
        <div style="grid-column:1/-1">
          <dt>Address</dt>
          <dd>${escapeHtml(address)}</dd>
        </div>
      </dl>

      <div class="credit-summary-kpis">
        <div class="credit-summary-kpi credit-summary-kpi--outstanding${cleared ? " is-cleared" : ""}">
          <span class="credit-summary-kpi-label">Outstanding</span>
          <span class="credit-summary-kpi-value">₹ ${formatSummaryAmountPlain(outstanding)}</span>
          <span class="credit-summary-kpi-meta">${
            cleared
              ? periodScopedOutstanding
                ? "No net balance in period"
                : "Account cleared"
              : periodScopedOutstanding
                ? "Net credit minus settlements in period"
                : "Amount still owed"
          }</span>
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Credit taken</span>
          <span class="credit-summary-kpi-value">₹ ${formatSummaryAmountPlain(creditTaken)}</span>
          ${creditMeta ? `<span class="credit-summary-kpi-meta">${escapeHtml(creditMeta)}</span>` : ""}
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Settlement done</span>
          <span class="credit-summary-kpi-value">₹ ${formatSummaryAmountPlain(settlementDone)}</span>
          ${settlementMeta ? `<span class="credit-summary-kpi-meta">${escapeHtml(settlementMeta)}</span>` : ""}
        </div>
      </div>

      ${
        periodActivity
          ? `<div class="credit-summary-period-box">
        <strong>Selected period:</strong> ${escapeHtml(periodActivity)}
        <div class="credit-summary-period-stats">
          <span>Credit in period: <strong>₹ ${formatSummaryAmountPlain(periodCredit)}</strong></span>
          <span>Settled in period: <strong>₹ ${formatSummaryAmountPlain(periodSettled)}</strong></span>
        </div>
      </div>`
          : ""
      }

      <section class="credit-summary-block">
        <h3 class="credit-summary-block-title">${
          periodActivity
            ? `Credit taken (${escapeHtml(periodActivity)})`
            : `All credit taken (through ${escapeHtml(asOfLabel)})`
        }</h3>
        <p class="credit-summary-block-lead">${
          periodActivity
            ? "Credit sales in the selected activity period."
            : "Every credit sale recorded up to the through date."
        }</p>
        <table class="report-table credit-summary-table--ledger">
          <thead>
            <tr>
              <th style="width:6%">#</th>
              <th style="width:28%">Date</th>
              <th class="num">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>${creditRows}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td colspan="2">Total credit</td>
              <td class="num">₹ ${formatSummaryAmountPlain(creditTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <section class="credit-summary-block">
        <h3 class="credit-summary-block-title">${
          periodActivity
            ? `Settlements (${escapeHtml(periodActivity)})`
            : `All settlements (through ${escapeHtml(asOfLabel)})`
        }</h3>
        <p class="credit-summary-block-lead">${
          periodActivity
            ? "Payments received in the selected activity period."
            : "Every payment received up to the through date."
        }</p>
        <table class="report-table credit-summary-table--ledger">
          <thead>
            <tr>
              <th style="width:6%">#</th>
              <th style="width:28%">Date</th>
              <th class="num">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>${paymentRows}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td colspan="2">Total settled</td>
              <td class="num">₹ ${formatSummaryAmountPlain(paymentTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <p class="credit-summary-note">
        Computer-generated credit account summary.
        ${
          periodScopedOutstanding
            ? "Outstanding shown is net credit minus settlements for the selected period only (not the customer&rsquo;s full account balance)."
            : "Outstanding = credit taken minus settlements (FIFO allocation on payments)."
        }
        Hand this copy to the customer or keep for your records.
      </p>

      <footer class="report-print-foot">
        <span>${escapeHtml(getCreditPrintStationLegalName())}</span>
        <span>Credit summary · ${escapeHtml(name)} · ${escapeHtml(asOfLabel)}</span>
      </footer>
    </article>`;
}

async function waitForCreditSummaryPrintAssets(doc) {
  const logo = doc.querySelector(".report-bpcl-logo");
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

async function runCreditSummaryPrint() {
  if (!lastCustomerSummary || !lastCustomerSummaryContext?.customerName) {
    const msg = "Load the customer account first, then print.";
    if (typeof AppError?.showGlobalBanner === "function") {
      AppError.showGlobalBanner(msg);
    } else {
      alert(msg);
    }
    return;
  }

  const sheetHtml = buildCreditSummaryPrintHtml(lastCustomerSummary, lastCustomerSummaryContext);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Credit summary print");
  iframe.style.cssText =
    "position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    throw new Error("Print frame unavailable");
  }

  const title = `${lastCustomerSummaryContext.customerName} · Credit summary`;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${creditSummaryAssetUrl(CREDIT_SUMMARY_PRINT_CSS)}" />
</head>
<body class="report-print-body">
  <div class="report-print-container">${sheetHtml}</div>
</body>
</html>`);
  doc.close();

  try {
    await waitForCreditSummaryPrintAssets(doc);
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

async function handleCreditSummaryPrintClick() {
  if (creditSummaryPrintBusy) return;
  const btn = document.getElementById("customer-summary-print-btn");
  const prevLabel = btn?.textContent || "Print summary";

  creditSummaryPrintBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Preparing…";
  }

  try {
    await runCreditSummaryPrint();
  } catch (err) {
    AppError?.report?.(err, { context: "runCreditSummaryPrint" });
    const msg = AppError?.getUserMessage?.(err) || "Could not open the print dialog.";
    if (typeof AppError?.showGlobalBanner === "function") {
      AppError.showGlobalBanner(msg);
    } else {
      alert(msg);
    }
  } finally {
    creditSummaryPrintBusy = false;
    if (btn) btn.textContent = prevLabel;
    updateCreditSummaryPrintButton();
  }
}

/** Summary rows and totals scoped to the active period filter (from/to). */
function buildPeriodScopedSummary(summary, from, to) {
  if (!summary) return null;

  const credit_entries = filterEntriesByRange(summary.credit_entries || [], from, to);
  const payment_entries = filterEntriesByRange(summary.payment_entries || [], from, to);
  const periodCredit = sumAmount(credit_entries);
  const periodSettled = sumAmount(payment_entries);
  const periodNet = Math.max(0, periodCredit - periodSettled);
  const remaining = from
    ? periodNet
    : Math.max(0, Number(summary.remaining) || periodNet);

  const creditDates = credit_entries
    .map((e) => e.entry_date)
    .filter(Boolean)
    .sort();
  const paymentDates = payment_entries
    .map((e) => e.entry_date)
    .filter(Boolean)
    .sort();

  return {
    ...summary,
    credit_entries,
    payment_entries,
    credit_taken: periodCredit,
    settlement_done: periodSettled,
    remaining,
    first_sale_date: creditDates[0] || null,
    last_credit_date: creditDates[creditDates.length - 1] || null,
    last_payment_date: paymentDates[paymentDates.length - 1] || null,
  };
}

function renderLifetimeBreakdowns(summary) {
  const creditRaw = Array.isArray(summary?.credit_entries) ? summary.credit_entries : [];
  const payRaw = Array.isArray(summary?.payment_entries) ? summary.payment_entries : [];
  const byDateAsc = (a, b) => String(a.entry_date || "").localeCompare(String(b.entry_date || ""));
  const credits = [...creditRaw].sort(byDateAsc);
  const pays = [...payRaw].sort(byDateAsc);

  const creditBody = document.getElementById("lifetime-credit-body");
  const payBody = document.getElementById("lifetime-payment-body");
  const creditEmpty = document.getElementById("lifetime-credit-empty");
  const payEmpty = document.getElementById("lifetime-payment-empty");

  if (creditBody) {
    creditBody.innerHTML = credits
      .map(
        (e) =>
          `<tr><td>${escapeHtml(formatDisplayDate(e.entry_date))}</td><td>${formatCurrency(e.amount)}</td></tr>`
      )
      .join("");
  }
  creditEmpty?.classList.toggle("hidden", credits.length > 0);

  if (payBody) {
    payBody.innerHTML = pays
      .map(
        (e) =>
          `<tr><td>${escapeHtml(formatDisplayDate(e.entry_date))}</td><td>${formatCurrency(e.amount)}</td></tr>`
      )
      .join("");
  }
  payEmpty?.classList.toggle("hidden", pays.length > 0);
}

function applyLifetimeSummary(row, options = {}) {
  const summaryOutstanding = row ? Number(row.remaining) : 0;
  const heroOutstanding =
    options.heroOutstanding != null ? Number(options.heroOutstanding) : summaryOutstanding;

  customerOutstandingDue = heroOutstanding;
  const creditTaken = row ? Number(row.credit_taken) : 0;
  const settlementDone = row ? Number(row.settlement_done) : 0;

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  set("stat-outstanding", formatCurrency(heroOutstanding));
  set("stat-lifetime-credit", formatCurrency(creditTaken));
  set("stat-lifetime-settled", formatCurrency(settlementDone));

  const outstandingEl = document.getElementById("stat-outstanding");
  const heroAmount = outstandingEl?.closest(".customer-balance-hero-amount");
  if (heroAmount) {
    heroAmount.classList.toggle("is-cleared", heroOutstanding <= 0);
  }

  const payCta = document.getElementById("customer-record-payment-cta");
  if (payCta) payCta.classList.toggle("hidden", heroOutstanding <= 0);

  const creditWhen = document.getElementById("customer-credit-when");
  if (creditWhen) {
    if (row) {
      const first = row.first_sale_date ? formatDisplayDate(row.first_sale_date) : null;
      const last = row.last_credit_date ? formatDisplayDate(row.last_credit_date) : null;
      if (first && last) creditWhen.textContent = `First credit: ${first} · Last credit: ${last}`;
      else if (first) creditWhen.textContent = `First credit: ${first}`;
      else if (last) creditWhen.textContent = `Last credit: ${last}`;
      else creditWhen.textContent = "";
    } else {
      creditWhen.textContent = "";
    }
  }

  const settlementWhen = document.getElementById("customer-settlement-when");
  if (settlementWhen) {
    if (row && row.last_payment_date) {
      settlementWhen.textContent = `Last settlement: ${formatDisplayDate(row.last_payment_date)}`;
    } else {
      settlementWhen.textContent = "";
    }
  }

  const settleNav = document.querySelector("#credit-customer-nav .settings-nav-item[data-section='settle']");
  if (settleNav) {
    const hide = heroOutstanding <= 0;
    settleNav.classList.toggle("hidden", hide);
    settleNav.hidden = hide;
  }
}

async function loadCustomerDetail() {
  const errorEl = document.getElementById("detail-error");
  errorEl?.classList.add("hidden");

  const { asOfDate, from, to } = getCustomerViewFilter();
  updateCustomerFilterSummary();
  await resolveCustomerIds();

  try {
    const { data: summaryData, error: summaryErr } = await supabaseClient.rpc(
      "get_customer_credit_detail_as_of",
      { p_customer_name: customerName, p_date: asOfDate }
    );
    if (summaryErr) throw summaryErr;

    const summary = Array.isArray(summaryData) && summaryData.length > 0 ? summaryData[0] : null;
    const resolvedName = summary?.customer_name != null ? String(summary.customer_name).trim() : "";
    if (!resolvedName) {
      lastCustomerSummary = null;
      lastCustomerSummaryContext = null;
      updateCreditSummaryPrintButton();
      applyLifetimeSummary(null);
      renderLifetimeBreakdowns(null);
      const clearStat = (id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "—";
      };
      clearStat("stat-period-credit");
      clearStat("stat-period-settled");
      const filterSummary = document.getElementById("customer-filter-summary");
      if (filterSummary) filterSummary.textContent = "";
      creditPager?.setEntries([]);
      paymentPager?.setEntries([]);
      if (errorEl) {
        errorEl.textContent =
          "No credit customer matched this name. Open the customer from the Outstanding list or check spelling.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const range =
      customerPeriodFilterApi?.getRange?.() ||
      readDateRangeFromControls(
        document.getElementById("filter-range"),
        document.getElementById("filter-from"),
        document.getElementById("filter-to")
      );
    const periodActivity = range
      ? formatDateRangeLabel(range, range.modeInfo, { style: "dashboard" })
      : "";

    const periodSummary = buildPeriodScopedSummary(summary, from, to);
    applyLifetimeSummary(periodSummary, { heroOutstanding: customerOutstandingDue });
    renderLifetimeBreakdowns(periodSummary);

    const creditEntries = (periodSummary.credit_entries || []).map((e) => ({
      transaction_date: e.entry_date,
      amount: e.amount,
      fuel_type: e.fuel_type ?? null,
      quantity: e.quantity ?? null,
      amount_settled: e.amount_settled ?? 0,
    }));
    const paymentEntries = (periodSummary.payment_entries || []).map((e) => ({
      date: e.entry_date,
      amount: e.amount,
      payment_mode: e.payment_mode ?? null,
      note: e.note ?? null,
    }));

    const periodCredit = Number(periodSummary.credit_taken) || 0;
    const periodSettled = Number(periodSummary.settlement_done) || 0;

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("stat-period-credit", formatCurrency(periodCredit));
    set("stat-period-settled", formatCurrency(periodSettled));

    lastCustomerSummary = periodSummary;
    lastCustomerSummaryContext = {
      customerName: resolvedName,
      asOfDate,
      periodActivity,
      periodCredit,
      periodSettled,
      mobile: customerContact.mobile,
      address: customerContact.address,
      vehicles: [...customerVehicleNos],
    };

    creditPager?.setEntries(creditEntries);
    paymentPager?.setEntries(paymentEntries);
    updateCreditSummaryPrintButton();
  } catch (err) {
    lastCustomerSummary = null;
    lastCustomerSummaryContext = null;
    updateCreditSummaryPrintButton();
    if (errorEl) {
      errorEl.textContent = AppError.getUserMessage(err);
      errorEl.classList.remove("hidden");
    }
    AppError.report(err, { context: "loadCustomerDetail" });
  }
}

async function handleSettle() {
  const msg = document.getElementById("settle-msg");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("success");
  }

  const settleIds = customerIds.length > 0 ? [...customerIds] : customerId ? [customerId] : [];
  if (settleIds.length === 0) {
    if (msg) msg.textContent = "No customer record to settle.";
    return;
  }

  const amount = Number(document.getElementById("settle-amount")?.value || 0);
  const settlementDate =
    document.getElementById("settle-date")?.value?.trim() || getLocalDateString();
  const paymentMode = document.getElementById("settle-mode")?.value || "Cash";
  const todayStr = getLocalDateString();

  if (!amount || amount <= 0) {
    if (msg) msg.textContent = "Enter a valid amount.";
    return;
  }
  if (customerOutstandingDue > 0 && amount > customerOutstandingDue) {
    if (msg) {
      msg.textContent = `Amount cannot exceed outstanding balance (${formatCurrency(customerOutstandingDue)}).`;
    }
    return;
  }
  if (settlementDate > todayStr) {
    if (msg) msg.textContent = "Settlement date cannot be in the future.";
    return;
  }

  const btn = document.getElementById("settle-btn");
  if (btn) btn.disabled = true;

  let remainingPay = amount;

  for (const id of settleIds) {
    if (remainingPay <= 0) break;

    const { data: customerRow, error: fetchErr } = await supabaseClient
      .from("credit_customers")
      .select("amount_due")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) {
      if (btn) btn.disabled = false;
      if (msg) msg.textContent = AppError.getUserMessage(fetchErr);
      AppError.report(fetchErr, { context: "creditCustomerSettleFetch" });
      return;
    }

    const due = Number(customerRow?.amount_due ?? 0);
    if (due <= 0) continue;

    const payAmount = Math.min(remainingPay, due);
    const { data, error } = await supabaseClient.rpc("record_credit_payment", {
      p_credit_customer_id: id,
      p_date: settlementDate,
      p_amount: payAmount,
      p_note: null,
      p_payment_mode: paymentMode,
    });

    if (error) {
      if (btn) btn.disabled = false;
      if (msg) msg.textContent = AppError.getUserMessage(error);
      AppError.report(error, { context: "creditCustomerSettle", customerId: id });
      invalidateCreditCaches();
      await resolveCustomerIds();
      await loadCustomerDetail();
      return;
    }

    remainingPay -= payAmount;
  }

  if (btn) btn.disabled = false;

  if (remainingPay >= amount) {
    if (msg) msg.textContent = "No outstanding balance to apply payment to.";
    return;
  }

  const settleAmountInput = document.getElementById("settle-amount");
  if (settleAmountInput) settleAmountInput.value = "";
  invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();

  if (msg) {
    msg.classList.add("success");
    msg.textContent =
      customerOutstandingDue === 0
        ? "Fully settled."
        : `Settled · remaining ${formatCurrency(customerOutstandingDue)}`;
  }
}

function invalidateCreditCaches() {
  if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("credit_summary");
    AppCache.invalidateByType("recent_activity");
  }
  try {
    localStorage.setItem("credit-updated", String(Date.now()));
  } catch (e) {
    /* ignore */
  }
}

function pickContactFromRows(rows) {
  const primary = rows.find((r) => Number(r.amount_due) > 0) || rows[0];
  if (!primary) return { mobile: "", address: "", vehicleNo: "" };
  return {
    mobile: String(primary.mobile ?? "").trim(),
    address: String(primary.address ?? "").trim(),
    vehicleNo: String(primary.vehicle_no ?? "").trim(),
  };
}

function buildCustomerSuggestions(rows) {
  const byName = new Map();
  for (const row of rows || []) {
    const displayName = String(row.customer_name ?? "").trim();
    const key = normCustomerName(displayName);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }

  const suggestions = [...byName.entries()].map(([key, groupRows]) => {
    const sorted = [...groupRows].sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );
    const contact = pickContactFromRows(sorted);
    return {
      name: sorted[0].customer_name.trim(),
      nameNorm: key,
      vehicleNo: contact.vehicleNo,
      mobile: contact.mobile,
      address: contact.address,
    };
  });

  suggestions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return suggestions;
}

function filterCustomerSuggestions(query) {
  const needle = normCustomerName(query);
  if (!needle) return customerSuggestions.slice(0, 50);
  return customerSuggestions.filter((item) => item.nameNorm.includes(needle)).slice(0, 50);
}

function setComboboxOpen(open) {
  const input = document.getElementById("customer");
  const list = document.getElementById("customer-suggestions");
  if (!input || !list) return;
  input.setAttribute("aria-expanded", open ? "true" : "false");
  list.classList.toggle("hidden", !open);
  list.hidden = !open;
  if (!open) customerComboboxActiveIndex = -1;
}

function renderCustomerSuggestions(query) {
  const list = document.getElementById("customer-suggestions");
  const input = document.getElementById("customer");
  if (!list || !input) return;

  const matches = filterCustomerSuggestions(query);
  customerComboboxActiveIndex = -1;
  customerComboboxMatches = matches;

  if (matches.length === 0) {
    list.innerHTML = `<li class="combobox-empty" role="presentation">No matching customers</li>`;
    setComboboxOpen(Boolean(query.trim()));
    return;
  }

  list.innerHTML = matches
    .map(
      (item, index) =>
        `<li class="combobox-option" role="option" data-index="${index}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</li>`
    )
    .join("");

  list.querySelectorAll(".combobox-option").forEach((el, index) => {
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectCustomerSuggestion(matches[index]);
    });
  });

  setComboboxOpen(true);
}

function highlightComboboxOption(index) {
  const list = document.getElementById("customer-suggestions");
  if (!list) return;
  const options = list.querySelectorAll(".combobox-option");
  options.forEach((el, i) => el.classList.toggle("is-active", i === index));
  customerComboboxActiveIndex = index;
  options[index]?.scrollIntoView({ block: "nearest" });
}

function selectCustomerSuggestion(item) {
  if (!item) return;
  const input = document.getElementById("customer");
  const vehicleInput = document.getElementById("vehicle");
  const mobileInput = document.getElementById("credit-customer-mobile");
  const addressInput = document.getElementById("credit-customer-address");

  if (input) input.value = item.name;
  if (vehicleInput) vehicleInput.value = item.vehicleNo || "";
  if (mobileInput) mobileInput.value = item.mobile || "";
  if (addressInput) addressInput.value = item.address || "";

  setComboboxOpen(false);
  vehicleInput?.focus();
}

function initCustomerCombobox() {
  const input = document.getElementById("customer");
  const list = document.getElementById("customer-suggestions");
  const combobox = document.getElementById("customer-combobox");
  if (!input || !list) return;

  const onInput = debounce(() => {
    renderCustomerSuggestions(input.value);
  }, 120);

  input.addEventListener("input", onInput);

  input.addEventListener("focus", () => {
    renderCustomerSuggestions(input.value);
  });

  input.addEventListener("keydown", (event) => {
    const options = list.querySelectorAll(".combobox-option");
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (list.hidden) renderCustomerSuggestions(input.value);
      if (options.length === 0) return;
      const next = customerComboboxActiveIndex < options.length - 1 ? customerComboboxActiveIndex + 1 : 0;
      highlightComboboxOption(next);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const prev = customerComboboxActiveIndex > 0 ? customerComboboxActiveIndex - 1 : options.length - 1;
      highlightComboboxOption(prev);
      return;
    }
    if (event.key === "Enter" && customerComboboxActiveIndex >= 0 && !list.hidden) {
      event.preventDefault();
      selectCustomerSuggestion(customerComboboxMatches[customerComboboxActiveIndex]);
      return;
    }
    if (event.key === "Escape") {
      setComboboxOpen(false);
    }
  });

  document.addEventListener("click", (event) => {
    if (!combobox?.contains(event.target)) setComboboxOpen(false);
  });
}

async function loadCustomerNames() {
  try {
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("customer_name, vehicle_no, mobile, address, amount_due, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      AppError.report(error, { context: "loadCustomerNames" });
      return;
    }
    customerSuggestions = buildCustomerSuggestions(data || []);
  } catch (e) {
    AppError.report(e, { context: "loadCustomerNames" });
  }
}

async function handleCreditSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
  }
  const successEl = document.getElementById("credit-success");
  const errorEl = document.getElementById("credit-error");
  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");

  const formData = new FormData(form);
  const transactionDate =
    formData.get("credit_date")?.trim() ||
    (typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10));
  const customerNameInput = (formData.get("customer_name") || "").trim();
  const fuelType = (formData.get("fuel_type") || "").trim() || null;
  const quantityRaw = Number(formData.get("quantity") || 0);
  const quantity = quantityRaw > 0 ? quantityRaw : null;
  const amount = Number(formData.get("amount_due") || 0);
  const notes = (formData.get("notes") || "").trim() || null;
  const vehicleNo = (formData.get("vehicle_no") || "").trim() || null;
  const mobile = (formData.get("mobile") || "").trim() || null;
  const address = (formData.get("address") || "").trim() || null;

  if (!customerNameInput || amount <= 0) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save credit entry";
    }
    AppError.handle(new Error("Customer and amount are required."), { target: errorEl });
    return;
  }

  const todayStr = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  if (transactionDate > todayStr) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save credit entry";
    }
    AppError.handle(new Error("Credit date cannot be in the future."), { target: errorEl });
    return;
  }

  const { error } = await supabaseClient.rpc("add_credit_entry", {
    p_customer_name: customerNameInput,
    p_transaction_date: transactionDate,
    p_amount: amount,
    p_vehicle_no: vehicleNo,
    p_fuel_type: fuelType || undefined,
    p_quantity: quantity ?? undefined,
    p_notes: notes,
    p_mobile: mobile,
    p_address: address,
  });

  if (error) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save credit entry";
    }
    AppError.handle(error, { target: errorEl });
    return;
  }

  form.reset();
  setComboboxOpen(false);
  const transactionDateInput = form.querySelector("#credit-date");
  if (transactionDateInput) {
    transactionDateInput.value =
      typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  }
  const fuelTypeSelect = form.querySelector("#fuel-type");
  if (fuelTypeSelect) fuelTypeSelect.value = "";
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save credit entry";
  }
  successEl?.classList.remove("hidden");
  loadCreditLedger(true);
  loadCustomerNames();
  invalidateCreditCaches();
}

function initPaginationControls() {
  const tableSection = document.querySelector("#credit-panel-outstanding");
  if (!tableSection || tableSection.querySelector(".pagination-controls")) return;

  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="credit-pagination-info" class="muted"></span>
    </div>
    <button id="credit-load-more" class="button-secondary hidden">Load more</button>
  `;
  tableSection.appendChild(paginationDiv);
  document.getElementById("credit-load-more")?.addEventListener("click", () => {
    const filtered = getFilteredLedger();
    creditPagination.offset = Math.min(
      creditPagination.offset + PAGE_SIZE,
      filtered.length
    );
    renderLedgerPage(false);
  });
}

function getFilteredLedger() {
  const q = creditPagination.searchQuery;
  const outstanding = creditPagination.ledgerData.filter((row) => Number(row.amount_due) > 0);
  if (!q) return outstanding;
  return outstanding.filter((row) => {
    const name = (row.customer_name || "").toLowerCase();
    const vehicle = (row.vehicle_no || "").toLowerCase();
    return name.includes(q) || vehicle.includes(q);
  });
}

function updateSummaryStats(filtered) {
  const total = filtered.reduce((s, r) => s + Number(r.amount_due || 0), 0);
  const totalEl = document.getElementById("credit-total-outstanding");
  const countEl = document.getElementById("credit-customer-count");
  if (totalEl) totalEl.textContent = formatCurrency(total);
  if (countEl) countEl.textContent = String(filtered.length);
}

function renderLedgerPage(resetTable) {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody) return;

  const filtered = getFilteredLedger();
  creditPagination.totalCount = filtered.length;
  updateSummaryStats(filtered);

  if (filtered.length === 0) {
    const msg = creditPagination.searchQuery
      ? "No matching customers with outstanding balance."
      : "No outstanding balances — all customers are cleared.";
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>${escapeHtml(msg)}</p>${
      creditPagination.searchQuery
        ? ""
        : '<p class="empty-cta"><a href="#record">Record credit sale</a>.</p>'
    }</div></td></tr>`;
    creditPagination.hasMore = false;
    updatePaginationUI();
    return;
  }

  if (resetTable) {
    tbody.innerHTML = "";
    creditPagination.offset = 0;
  }

  const sliceStart = creditPagination.offset;
  const sliceEnd = sliceStart + PAGE_SIZE;
  const rowsToShow = filtered.slice(sliceStart, sliceEnd);

  rowsToShow.forEach((row) => {
    const tr = document.createElement("tr");
    const detailHref = customerDetailUrl(row);
    tr.innerHTML = `
      <td><a class="customer-link" href="${detailHref}">${escapeHtml(row.customer_name)}</a></td>
      <td>${escapeHtml(row.vehicle_no ?? "—")}</td>
      <td data-amount="${row.amount_due}">${formatCurrency(row.amount_due)}</td>
      <td>${formatDisplayDate(row.last_payment)}</td>
      <td class="table-actions"><a class="button-secondary button-small" href="${detailHref}">View details</a></td>
    `;
    tbody.appendChild(tr);
  });

  creditPagination.hasMore = sliceEnd < filtered.length;
  updatePaginationUI();
}

async function loadCreditLedger(reset = false) {
  const tbody = document.getElementById("credit-table-body");
  if (!tbody || creditPagination.isLoading) return;
  creditPagination.isLoading = true;

  if (reset) {
    creditPagination.offset = 0;
    creditPagination.ledgerData = [];
    tbody.innerHTML = "<tr><td colspan='5' class='muted'>Fetching credit ledger…</td></tr>";
  }

  const loadMoreBtn = document.getElementById("credit-load-more");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    if (reset || creditPagination.ledgerData.length === 0) {
      const { data: ledgerData, error } = await supabaseClient.rpc("get_credit_ledger_aggregated");
      if (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
        AppError.report(error, { context: "loadCreditLedger" });
        return;
      }
      creditPagination.ledgerData = ledgerData ?? [];
    }

    creditPagination.offset = reset ? 0 : creditPagination.offset;
    renderLedgerPage(true);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    AppError.report(err, { context: "loadCreditLedger" });
  } finally {
    creditPagination.isLoading = false;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Load more";
    }
  }
}

function updatePaginationUI() {
  const loadMoreBtn = document.getElementById("credit-load-more");
  const paginationInfo = document.getElementById("credit-pagination-info");
  const summaryEl = document.getElementById("credit-ledger-summary");

  const filtered = getFilteredLedger();
  const showing = Math.min(creditPagination.offset + PAGE_SIZE, filtered.length);

  const infoText =
    filtered.length > 0 ? `Showing ${Math.min(showing, filtered.length)} of ${filtered.length} customers` : "";

  if (paginationInfo) paginationInfo.textContent = infoText;
  if (summaryEl) summaryEl.textContent = infoText;

  if (loadMoreBtn) {
    if (creditPagination.hasMore && creditPagination.offset + PAGE_SIZE < filtered.length) {
      loadMoreBtn.classList.remove("hidden");
    } else {
      loadMoreBtn.classList.add("hidden");
    }
  }
}
