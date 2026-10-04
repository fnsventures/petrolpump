/* global window.supabaseClient, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, normCustomerName, CreditCustomerDetail, initPageSections, createDateRangeFilter, readDateRangeFromControls, formatDateRangeLabel, setFilterState, PumpSettings, loadPumpSettings, AppConfig, CacheInvalidation, formatNumberPlain, initPersistedDateInput, savePersistedDate, RECORD_DATE_KEYS, PrintUtils */

(function () {
  const page = () => window.CreditPage;
  const {
    filterEntriesByRange,
    sumAmount,
    createBreakdownPager,
    sortEntriesByDateDesc,
    buildMonthActivityRows,
    buildDayActivityRows,
    openCreditLines,
  } = CreditCustomerDetail;
  const SUMMARY_LIST_PAGE = 10;
  const SUMMARY_MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const summaryListState = {
    credit: { entries: [], shown: SUMMARY_LIST_PAGE },
    payment: { entries: [], shown: SUMMARY_LIST_PAGE },
  };
  let creditPager = null;
  let paymentPager = null;
  let customerPeriodFilterApi = null;

function applyCustomerPeriodFromUrl(params) {
  const period = (params.get("period") || "").trim();
  if (!period) return false;

  const allowed = new Set(["today", "this-week", "this-month", "all-time", "custom"]);
  if (!allowed.has(period)) return false;

  const rangeSelect = document.getElementById("filter-range");
  const fromInput = document.getElementById("filter-from");
  const toInput = document.getElementById("filter-to");
  const customRange = document.getElementById("customer-custom-range");
  if (!rangeSelect) return false;

  rangeSelect.value = period;
  if (period === "custom") {
    const from = (params.get("from") || "").trim();
    const to = (params.get("to") || "").trim();
    if (!from || !to) return false;
    if (fromInput) fromInput.value = from;
    if (toInput) toInput.value = to;
  } else {
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
  }

  // Values only — createDateRangeFilter owns popover/chip visibility.
  if (customRange) {
    customRange.classList.add("hidden");
    customRange.setAttribute("aria-hidden", "true");
  }
  if (fromInput) fromInput.disabled = false;
  if (toInput) toInput.disabled = false;

  if (typeof setFilterState === "function") {
    setFilterState("credit_customer_period", {
      range: period,
      start: fromInput?.value || undefined,
      end: toInput?.value || undefined,
    });
  }

  return true;
}

async function initCustomerView() {
  PrintUtils.preloadCreditSummaryPrintCss?.();
  if (typeof loadPumpSettings === "function") {
    await loadPumpSettings();
  }

  page().setSidebarMode("customer");
  page().setCustomerToolbarVisible(true);

  ["credit-panel-overview", "credit-panel-record", "credit-panel-outstanding"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });

  const breadcrumbEl = document.getElementById("breadcrumb-customer");
  const titleEl = document.getElementById("customer-title");
  if (breadcrumbEl) breadcrumbEl.textContent = page().state.customerName;
  if (titleEl) titleEl.textContent = page().state.customerName;
  document.title = `${page().state.customerName} · Credit · Bishnupriya Fuels`;

  const settleDate = document.getElementById("settle-date");
  if (settleDate) initPersistedDateInput(settleDate, RECORD_DATE_KEYS.creditSettle);

  applyCustomerPeriodFromUrl(new URLSearchParams(window.location.search));
  initCustomerViewFilter();
  initCustomerSettlePanel();
  document.getElementById("settle-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSettle();
  });

  creditPager = createBreakdownPager(
    document.getElementById("credit-entries-body"),
    document.getElementById("credit-entries-empty"),
    document.getElementById("credit-entries-pagination"),
    document.getElementById("credit-entries-info"),
    document.getElementById("credit-entries-back"),
    document.getElementById("credit-entries-more"),
    { showAdminActions: page().isAdmin }
  );
  paymentPager = createBreakdownPager(
    document.getElementById("payment-entries-body"),
    document.getElementById("payment-entries-empty"),
    document.getElementById("payment-entries-pagination"),
    document.getElementById("payment-entries-info"),
    document.getElementById("payment-entries-back"),
    document.getElementById("payment-entries-more"),
    { showAdminActions: page().isAdmin }
  );
  const creditBody = document.getElementById("credit-entries-body");
  if (creditBody) creditBody.dataset.breakdownMode = "credit-rich";

  const creditActionsHead = document.getElementById("credit-entries-actions-head");
  const paymentActionsHead = document.getElementById("payment-entries-actions-head");
  if (creditActionsHead) creditActionsHead.hidden = !page().isAdmin;
  if (paymentActionsHead) paymentActionsHead.hidden = !page().isAdmin;

  initCreditDeleteHandlers();

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

  document.getElementById("lifetime-credit-more")?.addEventListener("click", () => {
    summaryListState.credit.shown += SUMMARY_LIST_PAGE;
    renderSummaryList("credit");
  });
  document.getElementById("lifetime-payment-more")?.addEventListener("click", () => {
    summaryListState.payment.shown += SUMMARY_LIST_PAGE;
    renderSummaryList("payment");
  });
  document.getElementById("customer-summary-print-btn")?.addEventListener("click", () => {
    void handleCreditSummaryPrintClick();
  });
  document.getElementById("customer-whatsapp-btn")?.addEventListener("click", (event) => {
    if (event.currentTarget.getAttribute("href")) return;
    event.preventDefault();
    const mobile = String(page().state.customerContact?.mobile || "").trim();
    showCreditShareNotice(
      mobile
        ? "Load the customer account first, then send on WhatsApp."
        : "Add this customer's mobile number, then send on WhatsApp."
    );
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
  // Force change sync so popover/edit UI resets even if value was already "today".
  rangeSelect?.dispatchEvent(new Event("change", { bubbles: true }));
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
    applyBtn: "customer-apply-filter",
    labelEl: "customer-filter-summary",
    trigger: "apply",
    persist: true,
    runOnInit: true,
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

function updateSettleBalanceBanner() {
  const labelEl = document.getElementById("settle-balance-label");
  const valueEl = document.getElementById("settle-balance-value");
  const fillBtn = document.getElementById("settle-fill-full");
  if (!valueEl) return;

  const label = page().getCustomerBalanceLabel(page().state.customerNetBalance, page().state.customerPrepaidBalance);
  if (labelEl) labelEl.textContent = label;
  valueEl.textContent = page().formatCustomerBalanceDisplay(page().state.customerNetBalance, page().state.customerPrepaidBalance);

  if (fillBtn) {
    fillBtn.disabled = page().state.customerNetBalance <= 0;
    fillBtn.hidden = page().state.customerNetBalance <= 0;
  }
}

function initCustomerSettlePanel() {
  updateSettleBalanceBanner();

  document.getElementById("settle-fill-full")?.addEventListener("click", () => {
    const amountInput = document.getElementById("settle-amount");
    if (!amountInput || page().state.customerNetBalance <= 0) return;
    amountInput.value = String(page().state.customerNetBalance);
    amountInput.focus();
    amountInput.select();
  });
}

function escapeIlikePattern(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function pickCustomerContact(rows) {
  const primary =
    rows.find((r) => r.id === page().state.customerId) ||
    rows.find((r) => Number(r.amount_due) > 0) ||
    rows[0];
  if (!primary) return { mobile: "", address: "" };
  return {
    mobile: String(primary.mobile ?? "").trim(),
    address: String(primary.address ?? "").trim(),
  };
}

function setHiddenEl(el, hidden) {
  if (!el) return;
  el.hidden = hidden;
  el.classList.toggle("hidden", hidden);
}

function setContactLine(el, text) {
  if (!el) return;
  el.textContent = text;
  setHiddenEl(el, !text);
}

function renderCustomerMeta(rows) {
  const vehicles = [...new Set(rows.map((r) => r.vehicle_no).filter(Boolean))];
  page().state.customerVehicleNos = vehicles;
  const mobile = String(page().state.customerContact.mobile || "").trim();
  const rest = [
    page().state.customerContact.address,
    vehicles.length ? `Vehicle: ${vehicles.join(", ")}` : "",
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" · ");
  const meta = document.getElementById("customer-meta");
  setContactLine(meta, mobile);
  if (meta) {
    const tel = creditCustomerTelHref(mobile);
    if (tel) meta.href = tel;
    else meta.removeAttribute("href");
    meta.setAttribute("aria-label", mobile ? `Call ${mobile}` : "Customer mobile");
  }
  setContactLine(document.getElementById("customer-meta-rest"), rest);
  syncCustomerContactActions();
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
      `Edit details for ${page().state.customerName || "customer"}`
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
  page().state.customerName = trimmed;
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
  if (page().state.customerIds.length === 0 && !page().state.customerId) return;

  const overlay = document.getElementById("customer-edit-overlay");
  const nameInput = document.getElementById("edit-customer-name");
  const mobileInput = document.getElementById("edit-customer-mobile");
  const addressInput = document.getElementById("edit-customer-address");
  const msg = document.getElementById("customer-info-msg");

  if (nameInput) nameInput.value = page().state.customerName;
  if (mobileInput) mobileInput.value = page().state.customerContact.mobile;
  if (addressInput) addressInput.value = page().state.customerContact.address;
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
  const { data, error } = await window.supabaseClient
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
  const ids = page().state.customerIds.length > 0 ? page().state.customerIds : page().state.customerId ? [page().state.customerId] : [];

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

  const nameChanged = normCustomerName(newName) !== normCustomerName(page().state.customerName);
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

  const { error } = await window.supabaseClient
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

  page().state.customerContact = { mobile, address };
  if (nameChanged) applyCustomerDisplayName(newName);
  page().invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();
  closeCustomerEditModal();
}

async function resolveCustomerIds() {
  const needle = (page().state.customerName || "").trim();
  if (!needle) {
    page().state.customerIds = [];
    return;
  }
  const needleNorm = normCustomerName(needle);
  const pattern = `%${escapeIlikePattern(needle)}%`;
  const { data: list, error } = await window.supabaseClient
    .from("credit_customers")
    .select("id, vehicle_no, amount_due, prepaid_balance, last_payment, customer_name, mobile, address")
    .ilike("customer_name", pattern);

  if (error) {
    AppError.report(error, { context: "resolveCustomerIds" });
    return;
  }

  const rows = (list || []).filter((r) => normCustomerName(r.customer_name) === needleNorm);
  page().state.customerIds = rows.map((r) => r.id);
  if (!page().state.customerId && rows.length > 0) {
    const primary = rows.find((r) => Number(r.amount_due) > 0) || rows[0];
    page().state.customerId = primary.id;
  } else if (page().state.customerId && !page().state.customerIds.includes(page().state.customerId)) {
    const urlIdValid = rows.some((r) => r.id === page().state.customerId);
    if (urlIdValid) page().state.customerIds.push(page().state.customerId);
    else page().state.customerId = rows[0]?.id ?? null;
  }

  page().state.customerContact = pickCustomerContact(rows);
  renderCustomerMeta(rows);
  setCustomerNameEditable(rows.length > 0);

  const totalDue = rows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
  const totalPrepaid = rows.reduce((s, r) => s + Number(r.prepaid_balance || 0), 0);
  page().updateCustomerBalanceState(totalDue, totalPrepaid);
  page().applyCustomerBalanceHero(page().state.customerNetBalance, page().state.customerPrepaidBalance);
  updateSettleBalanceBanner();
}


function formatSummaryMonth(ym) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
  if (!match) return "—";
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return "—";
  return `${SUMMARY_MONTHS[index]} ${match[1]}`;
}

function formatSummaryQty(value) {
  if (value == null || value === "") return "—";
  const qty = Number(value);
  if (!Number.isFinite(qty)) return "—";
  return qty.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function creditPrintMode() {
  const value = document.getElementById("customer-summary-print-mode")?.value;
  if (value === "activity" || value === "activity-days") return value;
  return "outstanding";
}

/** Derive outstanding vs advance from credit − settled (single source of truth for print). */
function resolveCreditPrintBalance(creditTaken, settlementDone) {
  const credit = Number(creditTaken) || 0;
  const settled = Number(settlementDone) || 0;
  const net = credit - settled;
  const outstanding = Math.max(0, net);
  const advancePayment = Math.max(0, -net);
  const hasAdvance = advancePayment > 0.009;
  return {
    credit,
    settled,
    outstanding,
    advancePayment,
    hasAdvance,
    cleared: !hasAdvance && outstanding <= 0.009,
    balanceLabel: hasAdvance ? "Advance payment" : "Outstanding",
    balanceValue: hasAdvance ? advancePayment : outstanding,
  };
}

function entryDateBounds(entries) {
  let first = null;
  let last = null;
  for (const e of entries || []) {
    const d = e?.entry_date;
    if (!d) continue;
    const s = String(d);
    if (!first || s < first) first = s;
    if (!last || s > last) last = s;
  }
  return { first, last };
}

function updateCreditSummaryPrintButton() {
  const canShare = Boolean(page().state.lastCustomerSummary && page().state.lastCustomerSummaryContext?.customerName);
  const printBtn = document.getElementById("customer-summary-print-btn");
  const printMode = document.getElementById("customer-summary-print-mode");
  if (printBtn) printBtn.disabled = !canShare;
  if (printMode) printMode.disabled = !canShare;
  syncCustomerContactActions();
}

/** Icons sit on the mobile line. href is set only when the link can open. */
function syncCustomerContactActions() {
  const actions = document.getElementById("customer-contact-actions");
  const callBtn = document.getElementById("customer-call-btn");
  const waBtn = document.getElementById("customer-whatsapp-btn");
  const mobile = String(page().state.customerContact?.mobile || "").trim();
  const tel = creditCustomerTelHref(mobile);
  setHiddenEl(actions, !tel);
  if (callBtn) {
    if (tel) {
      callBtn.href = tel;
      callBtn.setAttribute("aria-label", `Call ${mobile}`);
      callBtn.title = `Call ${mobile}`;
    } else {
      callBtn.removeAttribute("href");
    }
  }
  if (!waBtn) return;
  const canShare = Boolean(page().state.lastCustomerSummary && page().state.lastCustomerSummaryContext?.customerName);
  const waHref = tel && canShare ? creditCustomerWaHref(mobile, buildCreditWhatsAppText()) : "";
  if (waHref) {
    waBtn.href = waHref;
    waBtn.classList.remove("is-disabled");
    waBtn.removeAttribute("aria-disabled");
    waBtn.setAttribute("aria-label", `WhatsApp ${mobile}`);
  } else {
    waBtn.removeAttribute("href");
    waBtn.classList.add("is-disabled");
    waBtn.setAttribute("aria-disabled", "true");
    waBtn.setAttribute("aria-label", "Send statement on WhatsApp");
  }
}

/** Digits for tel: and wa.me. 10-digit Indian mobiles get 91. */
function creditCustomerPhoneDigits(mobile) {
  const digits = String(mobile || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `91${digits.slice(1)}`;
  return digits;
}

function creditCustomerTelHref(mobile) {
  const e164 = creditCustomerPhoneDigits(mobile);
  return e164 ? `tel:+${e164}` : "";
}

function creditCustomerWaHref(mobile, text) {
  const e164 = creditCustomerPhoneDigits(mobile);
  if (!e164) return "";
  const params = new URLSearchParams();
  if (text) params.set("text", text);
  const query = params.toString();
  return `https://wa.me/${e164}${query ? `?${query}` : ""}`;
}

function buildCreditWhatsAppText() {
  const station =
    (typeof PumpSettings?.getStationLegalName === "function" && PumpSettings.getStationLegalName()) ||
    "Bishnupriya Fuels";
  const asOf = formatDisplayDate(getLocalDateString());
  const net = Number(page().state.customerNetBalance) || 0;
  const prepaid = Number(page().state.customerPrepaidBalance) || 0;
  const hasAdvance = prepaid > 0 && net <= 0;
  const cleared = !hasAdvance && net <= 0.009;
  const balanceLabel = hasAdvance ? "Credit balance" : "Outstanding";
  const balanceValue = hasAdvance ? prepaid : Math.max(0, net);
  const closing = hasAdvance
    ? "Reply if you need anything else."
    : cleared
      ? "Nothing is unpaid on this account."
      : "Please clear this at the pump, or reply to this chat.";
  return [
    "Hello,",
    "",
    `This is ${station}.`,
    "",
    `As on ${asOf}`,
    `${balanceLabel}: ${formatCurrency(balanceValue)}`,
    "",
    closing,
  ].join("\n");
}

function showCreditShareNotice(message) {
  if (typeof AppError?.showGlobalBanner === "function") {
    AppError.showGlobalBanner(message);
  } else {
    alert(message);
  }
}

function inrPlain(amount) {
  return `₹ ${formatNumberPlain(amount)}`;
}

function creditSummaryPartyHtml(name, mobile, vehicleLine, address) {
  return `
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
      </dl>`;
}

function creditPrintParty(context) {
  return {
    name: context?.customerName || page().state.customerName || "Customer",
    mobile: context?.mobile?.trim() || "—",
    vehicleLine: context?.vehicles?.length > 0 ? context.vehicles.join(", ") : "—",
    address: context?.address?.trim() || "—",
  };
}

function activityFocusMonth(context) {
  return String(context?.asOfDate || getLocalDateString()).slice(0, 7);
}

function activityAmountCell(amount) {
  return amount > 0.009 ? inrPlain(amount) : "";
}

function buildDayTableHtml(rows, emptyLabel, options) {
  let creditTotal = 0;
  let settledTotal = 0;
  if (!rows.length) {
    return {
      body: `<tr><td colspan="3" class="muted" style="text-align:center">${escapeHtml(emptyLabel)}</td></tr>`,
      creditTotal: 0,
      settledTotal: 0,
    };
  }

  const groupMonths =
    Boolean(options?.groupMonths) &&
    rows.length > 1 &&
    rows[0].date.slice(0, 7) !== rows[rows.length - 1].date.slice(0, 7);
  const parts = [];
  let month = "";
  let monthCredit = 0;
  let monthSettled = 0;

  const flushMonth = () => {
    if (!groupMonths || !month) return;
    parts.push(
      `<tr class="credit-summary-month-total"><td>${escapeHtml(formatSummaryMonth(month))}</td><td class="num">${inrPlain(monthCredit)}</td><td class="num">${inrPlain(monthSettled)}</td></tr>`
    );
  };

  for (const row of rows) {
    creditTotal += row.credit;
    settledTotal += row.settled;
    const key = row.date.slice(0, 7);
    if (groupMonths && key !== month) {
      flushMonth();
      month = key;
      monthCredit = 0;
      monthSettled = 0;
      parts.push(
        `<tr class="credit-summary-month-row"><td colspan="3">${escapeHtml(formatSummaryMonth(key))}</td></tr>`
      );
    }
    monthCredit += row.credit;
    monthSettled += row.settled;
    parts.push(
      `<tr><td>${escapeHtml(formatDisplayDate(row.date))}</td><td class="num">${activityAmountCell(row.credit)}</td><td class="num">${activityAmountCell(row.settled)}</td></tr>`
    );
  }
  flushMonth();
  return { body: parts.join(""), creditTotal, settledTotal };
}

function dayActivityTableHtml(body, totals) {
  const foot = totals
    ? `<tfoot><tr class="report-total-row"><td>Total</td><td class="num">${inrPlain(totals.credit)}</td><td class="num">${inrPlain(totals.settled)}</td></tr></tfoot>`
    : "";
  return `<table class="report-table report-table-compact credit-summary-table--days">
        <thead>
          <tr>
            <th>Date</th>
            <th class="num">Credit (₹)</th>
            <th class="num">Settled (₹)</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        ${foot}
      </table>`;
}

function buildActivitySectionsHtml(summary, context) {
  const credits = summary?.credit_entries || [];
  const payments = summary?.payment_entries || [];
  if (context?.printMode === "activity-days") {
    const dayTable = buildDayTableHtml(buildDayActivityRows(credits, payments, ""), "No credit or settlement in this period.", {
      groupMonths: true,
    });
    return `
    <section class="credit-summary-block credit-summary-block--flow">
      ${dayActivityTableHtml(dayTable.body, { credit: dayTable.creditTotal, settled: dayTable.settledTotal })}
    </section>`;
  }

  const focusMonth = activityFocusMonth(context);
  const monthRows = buildMonthActivityRows(credits, payments, focusMonth);
  const dayRows = buildDayActivityRows(credits, payments, monthRows.length ? focusMonth : "");
  const focusLabel = formatSummaryMonth(focusMonth);
  const periodActivity = context?.periodActivity || "";

  let monthSection = "";
  if (monthRows.length) {
    let creditTotal = 0;
    let settledTotal = 0;
    const body = monthRows
      .map((row) => {
        creditTotal += row.credit;
        settledTotal += row.settled;
        return `
          <tr>
            <td>${escapeHtml(formatSummaryMonth(row.month))}</td>
            <td class="num">${inrPlain(row.credit)}</td>
            <td class="num">${inrPlain(row.settled)}</td>
          </tr>`;
      })
      .join("");
    monthSection = `
      <section class="credit-summary-block credit-summary-block--flow">
        <h3 class="credit-summary-block-title">Earlier months</h3>
        <table class="report-table credit-summary-table--months">
          <thead>
            <tr>
              <th>Month</th>
              <th class="num">Credit (₹)</th>
              <th class="num">Settled (₹)</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td>Total</td>
              <td class="num">${inrPlain(creditTotal)}</td>
              <td class="num">${inrPlain(settledTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </section>`;
  }

  const dayTable = buildDayTableHtml(
    dayRows,
    monthRows.length ? `No credit or settlement in ${focusLabel}.` : "No credit or settlement in this period."
  );
  const dayTitle = monthRows.length ? focusLabel : periodActivity || "By day";

  return `
    ${monthSection}
    <section class="credit-summary-block credit-summary-block--flow">
      <h3 class="credit-summary-block-title">${escapeHtml(dayTitle)}</h3>
      ${dayActivityTableHtml(
        dayTable.body,
        monthRows.length ? { credit: dayTable.creditTotal, settled: dayTable.settledTotal } : null
      )}
    </section>`;
}

function buildOutstandingLinesHtml(summary) {
  const lines = openCreditLines(summary?.credit_entries);
  if (!lines.length) {
    return {
      rows: `<tr><td colspan="4" class="muted" style="text-align:center">No unpaid bills.</td></tr>`,
      openTotal: 0,
      count: 0,
    };
  }
  let openTotal = 0;
  const rows = lines
    .map((line) => {
      openTotal += line.open;
      const fuel = String(line.fuel_type || "").trim();
      return `
        <tr>
          <td>${escapeHtml(formatDisplayDate(line.entry_date))}</td>
          <td>${fuel ? escapeHtml(fuel) : "—"}</td>
          <td class="num">${escapeHtml(formatSummaryQty(line.quantity))}</td>
          <td class="num">${inrPlain(line.open)}</td>
        </tr>`;
    })
    .join("");
  return { rows, openTotal, count: lines.length };
}

function creditSummaryReportHeader(title, subtitleLines) {
  const gstin = PumpSettings.getStationGstin();
  const subtitles = (subtitleLines || [])
    .filter(Boolean)
    .map((line) => `<p class="report-subtitle">${line}</p>`)
    .join("");
  return `
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
          ${gstin ? `<p class="report-gstin">GSTIN: ${escapeHtml(gstin)}</p>` : ""}
          <p class="report-title">${escapeHtml(title)}</p>
          ${subtitles}
        </div>
      </div>
    </header>`;
}

function buildCreditSummaryPrintHtml(summary, context) {
  if (context?.printMode === "activity" || context?.printMode === "activity-days") {
    return buildActivityStatementHtml(summary, context);
  }
  return buildOutstandingStatementHtml(summary, context);
}

function buildOutstandingStatementHtml(summary, context) {
  const balance = resolveCreditPrintBalance(summary?.credit_taken, summary?.settlement_done);
  const { outstanding, hasAdvance, cleared, balanceLabel, balanceValue } = balance;
  const party = creditPrintParty(context);
  const asOfLabel = context?.asOfDate ? formatDisplayDate(context.asOfDate) : formatDisplayDate(getLocalDateString());
  const openLines = buildOutstandingLinesHtml(summary);
  const openGap = Math.abs(openLines.openTotal - (hasAdvance ? 0 : outstanding));
  const gapNote = !hasAdvance && !cleared && openGap > 0.05 ? ` Account balance is ${inrPlain(outstanding)}.` : "";

  return `
    <article class="credit-summary-sheet report-print-sheet">
      ${creditSummaryReportHeader("Unpaid credit", [`As on ${escapeHtml(asOfLabel)}`])}

      ${creditSummaryPartyHtml(party.name, party.mobile, party.vehicleLine, party.address)}

      <div class="credit-summary-due${cleared ? " is-cleared" : ""}${hasAdvance ? " is-advance" : ""}">
        <span class="credit-summary-due-label">${balanceLabel}</span>
        <span class="credit-summary-due-value">${inrPlain(balanceValue)}</span>
      </div>

      <section class="credit-summary-block credit-summary-block--flow">
        <table class="report-table credit-summary-table--open">
          <thead>
            <tr>
              <th>Date</th>
              <th>Fuel</th>
              <th class="num">Qty (L)</th>
              <th class="num">Open (₹)</th>
            </tr>
          </thead>
          <tbody>${openLines.rows}</tbody>
        </table>
      </section>

      <p class="credit-summary-note">Settled bills are not listed.${gapNote}</p>

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>Outstanding · ${escapeHtml(party.name)} · ${escapeHtml(asOfLabel)}</span>
      </footer>
    </article>`;
}

function buildActivityStatementHtml(summary, context) {
  const creditTaken = Number(summary?.credit_taken) || 0;
  const settlementDone = Number(summary?.settlement_done) || 0;
  const party = creditPrintParty(context);
  const asOfLabel = context?.asOfDate ? formatDisplayDate(context.asOfDate) : "—";
  const periodActivity = context?.periodActivity || "";

  return `
    <article class="credit-summary-sheet report-print-sheet">
      ${creditSummaryReportHeader("Credit activity", [
        periodActivity ? escapeHtml(periodActivity) : `Through ${escapeHtml(asOfLabel)}`,
      ])}

      ${creditSummaryPartyHtml(party.name, party.mobile, party.vehicleLine, party.address)}

      <div class="credit-summary-kpis credit-summary-kpis--two">
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Credit taken</span>
          <span class="credit-summary-kpi-value">${inrPlain(creditTaken)}</span>
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Settled</span>
          <span class="credit-summary-kpi-value">${inrPlain(settlementDone)}</span>
        </div>
      </div>

      ${buildActivitySectionsHtml(summary, context)}

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>Activity · ${escapeHtml(party.name)} · ${escapeHtml(asOfLabel)}</span>
      </footer>
    </article>`;
}

async function summaryForOutstandingPrint() {
  const today = getLocalDateString();
  const loadedAsOf = page().state.lastCustomerSummaryContext?.asOfDate || "";
  const loaded = page().state.lastCustomerSummaryFull;
  if (loaded && loadedAsOf >= today) return loaded;

  const { data, error } = await window.supabaseClient.rpc("get_customer_credit_detail_as_of", {
    p_customer_name: page().state.customerName,
    p_date: today,
  });
  if (error) throw error;
  const summary = Array.isArray(data) && data.length > 0 ? data[0] : loaded;
  if (summary) page().state.lastCustomerSummaryFull = summary;
  return summary;
}

async function runCreditSummaryPrint() {
  if (!page().state.lastCustomerSummary || !page().state.lastCustomerSummaryContext?.customerName) {
    const msg = "Load the customer account first, then print.";
    if (typeof AppError?.showGlobalBanner === "function") {
      AppError.showGlobalBanner(msg);
    } else {
      alert(msg);
    }
    return;
  }

  const mode = creditPrintMode();
  const ctx = page().state.lastCustomerSummaryContext;
  const summary =
    mode === "outstanding" ? await summaryForOutstandingPrint() : page().state.lastCustomerSummary;
  const printContext =
    mode === "outstanding"
      ? { ...ctx, asOfDate: getLocalDateString(), printMode: "outstanding" }
      : { ...ctx, printMode: mode };
  const sheetHtml = buildCreditSummaryPrintHtml(summary, printContext);
  const title = PrintUtils.buildPrintFilename(
    mode === "outstanding" ? "credit-outstanding" : mode === "activity-days" ? "credit-activity-days" : "credit-activity",
    ctx.customerName,
    printContext.asOfDate
  );
  const cssText = await PrintUtils.getCreditSummaryPrintCssText();

  await PrintUtils.printInIframe({
    title,
    bodyHtml: sheetHtml,
    cssText,
    bodyClass: "report-print-body",
    containerClass: "report-print-container",
    iframeTitle: "Credit summary print",
    imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
  });
}

async function handleCreditSummaryPrintClick() {
  if (page().state.creditSummaryPrintBusy) return;
  const btn = document.getElementById("customer-summary-print-btn");
  const prevLabel = btn?.textContent || "Print summary";

  page().state.creditSummaryPrintBusy = true;
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
    page().state.creditSummaryPrintBusy = false;
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
  // Keep signed net so advance/overpayment (settled > credit) is not clamped to zero.
  const remaining = periodCredit - periodSettled;
  const creditBounds = entryDateBounds(credit_entries);
  const paymentBounds = entryDateBounds(payment_entries);

  return {
    ...summary,
    credit_entries,
    payment_entries,
    credit_taken: periodCredit,
    settlement_done: periodSettled,
    remaining,
    first_sale_date: creditBounds.first,
    last_credit_date: creditBounds.last,
    last_payment_date: paymentBounds.last,
  };
}

function renderSummaryList(kind) {
  const isCredit = kind === "credit";
  const state = summaryListState[kind];
  const body = document.getElementById(isCredit ? "lifetime-credit-body" : "lifetime-payment-body");
  const empty = document.getElementById(isCredit ? "lifetime-credit-empty" : "lifetime-payment-empty");
  const pager = document.getElementById(isCredit ? "lifetime-credit-pagination" : "lifetime-payment-pagination");
  const info = document.getElementById(isCredit ? "lifetime-credit-info" : "lifetime-payment-info");
  const more = document.getElementById(isCredit ? "lifetime-credit-more" : "lifetime-payment-more");
  const entries = state?.entries || [];
  if (!body) return;

  if (!entries.length) {
    body.innerHTML = "";
    empty?.classList.remove("hidden");
    pager?.classList.add("hidden");
    return;
  }

  const shown = Math.min(state.shown, entries.length);
  body.innerHTML = entries
    .slice(0, shown)
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(formatDisplayDate(entry.entry_date))}</td><td>${formatCurrency(entry.amount)}</td></tr>`
    )
    .join("");
  empty?.classList.add("hidden");

  if (!pager || !info || !more) return;
  const hasMore = shown < entries.length;
  pager.classList.toggle("hidden", entries.length <= SUMMARY_LIST_PAGE && !hasMore);
  info.textContent = `${shown} of ${entries.length}`;
  more.hidden = !hasMore;
  more.disabled = !hasMore;
}

function renderLifetimeBreakdowns(summary) {
  summaryListState.credit.entries = sortEntriesByDateDesc(summary?.credit_entries);
  summaryListState.credit.shown = SUMMARY_LIST_PAGE;
  summaryListState.payment.entries = sortEntriesByDateDesc(summary?.payment_entries);
  summaryListState.payment.shown = SUMMARY_LIST_PAGE;
  renderSummaryList("credit");
  renderSummaryList("payment");
}

function applyLifetimeSummary(_row, options = {}) {
  page().updateCustomerBalanceState(
    options.heroAmountDue ?? page().state.customerOutstandingDue,
    options.heroPrepaidBalance ?? page().state.customerPrepaidBalance
  );
  page().applyCustomerBalanceHero(page().state.customerNetBalance, page().state.customerPrepaidBalance);
}

async function loadCustomerDetail() {
  const errorEl = document.getElementById("detail-error");
  if (errorEl) {
    errorEl.classList.add("hidden");
    errorEl.classList.remove("success");
  }

  const { asOfDate, from, to, selection } = getCustomerViewFilter();
  updateCustomerFilterSummary();
  await resolveCustomerIds();

  try {
    const { data: summaryData, error: summaryErr } = await window.supabaseClient.rpc(
      "get_customer_credit_detail_as_of",
      { p_customer_name: page().state.customerName, p_date: asOfDate }
    );
    if (summaryErr) throw summaryErr;

    const summary = Array.isArray(summaryData) && summaryData.length > 0 ? summaryData[0] : null;
    page().state.lastCustomerSummaryFull = summary;
    const resolvedName = summary?.customer_name != null ? String(summary.customer_name).trim() : "";
    if (!resolvedName) {
      page().state.lastCustomerSummary = null;
      page().state.lastCustomerSummaryFull = null;
      page().state.lastCustomerSummaryContext = null;
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
    applyLifetimeSummary(periodSummary, {
      heroAmountDue: page().state.customerOutstandingDue,
      heroPrepaidBalance: page().state.customerPrepaidBalance,
    });
    renderLifetimeBreakdowns(periodSummary);

    const creditEntries = (periodSummary.credit_entries || []).map((e) => ({
      id: e.id ?? null,
      transaction_date: e.entry_date,
      amount: e.amount,
      fuel_type: e.fuel_type ?? null,
      quantity: e.quantity ?? null,
      amount_settled: e.amount_settled ?? 0,
    }));
    const paymentEntries = (periodSummary.payment_entries || []).map((e) => ({
      id: e.id ?? null,
      date: e.entry_date,
      amount: e.amount,
      payment_mode: e.payment_mode ?? null,
      note: e.note ?? null,
      same_day_settlement: Boolean(e.same_day_settlement),
    }));

    const periodCredit = Number(periodSummary.credit_taken) || 0;
    const periodSettled = Number(periodSummary.settlement_done) || 0;

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("stat-period-credit", formatCurrency(periodCredit));
    set("stat-period-settled", formatCurrency(periodSettled));

    page().state.lastCustomerSummary = periodSummary;
    page().state.lastCustomerSummaryContext = {
      customerName: resolvedName,
      asOfDate,
      selection,
      periodActivity,
      periodCredit,
      periodSettled,
      mobile: page().state.customerContact.mobile,
      address: page().state.customerContact.address,
      vehicles: [...page().state.customerVehicleNos],
    };

    creditPager?.setEntries(creditEntries);
    paymentPager?.setEntries(paymentEntries);
    updateCreditSummaryPrintButton();
  } catch (err) {
    page().state.lastCustomerSummary = null;
    page().state.lastCustomerSummaryFull = null;
    page().state.lastCustomerSummaryContext = null;
    updateCreditSummaryPrintButton();
    if (errorEl) {
      errorEl.textContent = AppError.getUserMessage(err);
      errorEl.classList.add("error");
      errorEl.classList.remove("success", "hidden");
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

  const settleIds = page().state.customerIds.length > 0 ? [...page().state.customerIds] : page().state.customerId ? [page().state.customerId] : [];
  if (settleIds.length === 0) {
    if (msg) msg.textContent = "No customer record to settle.";
    return;
  }

  const amount = Number(document.getElementById("settle-amount")?.value || 0);
  const settlementDate =
    document.getElementById("settle-date")?.value?.trim() || getLocalDateString();
  const paymentMode = document.getElementById("settle-mode")?.value || "Cash";
  const sameDaySettlement = Boolean(document.getElementById("settle-same-day")?.checked);
  const todayStr = getLocalDateString();

  if (!amount || amount <= 0) {
    if (msg) msg.textContent = "Enter a valid amount.";
    return;
  }
  if (settlementDate > todayStr) {
    if (msg) msg.textContent = "Settlement date cannot be in the future.";
    return;
  }

  const btn = document.getElementById("settle-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  const finishSettleSubmit = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Record payment";
    }
  };

  if (settleIds.length === 1) {
    const { error } = await window.supabaseClient.rpc("record_credit_payment", {
      p_credit_customer_id: settleIds[0],
      p_date: settlementDate,
      p_amount: amount,
      p_note: null,
      p_payment_mode: paymentMode,
      p_same_day_settlement: sameDaySettlement,
    });

    if (btn) finishSettleSubmit();

    if (error) {
      if (msg) msg.textContent = AppError.getUserMessage(error);
      AppError.report(error, { context: "creditCustomerSettle", customerId: settleIds[0] });
      page().invalidateCreditCaches();
      await resolveCustomerIds();
      await loadCustomerDetail();
      return;
    }
  } else {
    const primaryId = page().state.customerId || settleIds[0];
    const { error } = await window.supabaseClient.rpc("batch_record_credit_settlements", {
      p_customer_ids: settleIds,
      p_primary_customer_id: primaryId,
      p_date: settlementDate,
      p_total_amount: amount,
      p_note: null,
      p_payment_mode: paymentMode,
      p_same_day_settlement: sameDaySettlement,
    });

    finishSettleSubmit();

    if (error) {
      if (msg) msg.textContent = AppError.getUserMessage(error);
      AppError.report(error, { context: "creditCustomerSettleBatch", customerIds: settleIds });
      page().invalidateCreditCaches();
      await resolveCustomerIds();
      await loadCustomerDetail();
      return;
    }
  }

  const settleAmountInput = document.getElementById("settle-amount");
  if (settleAmountInput) settleAmountInput.value = "";
  const sameDayInput = document.getElementById("settle-same-day");
  if (sameDayInput) sameDayInput.checked = false;
  savePersistedDate(RECORD_DATE_KEYS.creditSettle, settlementDate);
  page().invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();
  document.getElementById("settle-amount")?.focus();

  if (msg) {
    msg.classList.add("success");
    if (page().state.customerPrepaidBalance > 0 && page().state.customerNetBalance <= 0) {
      msg.textContent = `Payment recorded · credit balance +${formatCurrency(page().state.customerPrepaidBalance)}`;
    } else if (page().state.customerNetBalance === 0) {
      msg.textContent = "Fully settled.";
    } else {
      msg.textContent = `Settled · remaining ${formatCurrency(page().state.customerNetBalance)}`;
    }
  }
}

function initCreditDeleteHandlers() {
  if (!page().isAdmin || document.body.dataset.creditDeleteBound) return;
  document.body.dataset.creditDeleteBound = "1";

  document.addEventListener("click", async (e) => {
    if (!e.target.closest?.("#credit-entries-body, #payment-entries-body")) return;

    const entryBtn = e.target.closest?.(".credit-delete-entry");
    const paymentBtn = e.target.closest?.(".credit-delete-payment");
    const btn = entryBtn || paymentBtn;
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const entryId = btn.getAttribute("data-entry-id");
    const paymentId = btn.getAttribute("data-payment-id");

    if (entryBtn) {
      if (!entryId) return;
      await deleteCreditEntry(entryId, btn);
    } else {
      if (!paymentId) return;
      await deleteCreditPayment(paymentId, btn);
    }
  });
}

function showCustomerDetailMessage(msg, isError = false) {
  const errorEl = document.getElementById("detail-error");
  if (!errorEl) return;
  errorEl.textContent = msg || "";
  errorEl.classList.toggle("hidden", !msg);
  errorEl.classList.toggle("error", Boolean(isError && msg));
  errorEl.classList.toggle("success", Boolean(!isError && msg));
}

async function deleteCreditEntry(entryId, btn) {
  const amount = Number(btn?.dataset?.amount || 0);
  const dateStr = btn?.dataset?.date || "";
  const dateLabel = dateStr ? formatDisplayDate(dateStr) : "this date";
  const confirmed = confirm(
    `Delete credit entry of ${formatCurrency(amount)} on ${dateLabel}?\n\nOutstanding balance will be recalculated. This cannot be undone.`
  );
  if (!confirmed) return;

  if (btn) btn.disabled = true;
  showCustomerDetailMessage("");
  const { error } = await window.supabaseClient.rpc("delete_credit_entry", { p_entry_id: entryId });

  if (error) {
    if (btn) btn.disabled = false;
    showCustomerDetailMessage(AppError.getUserMessage(error), true);
    AppError.report(error, { context: "deleteCreditEntry", entryId });
    return;
  }

  page().invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();
  showCustomerDetailMessage(`Credit entry of ${formatCurrency(amount)} deleted.`);
  page().refreshCreditPortfolioViews();
}

async function deleteCreditPayment(paymentId, btn) {
  const amount = Number(btn?.dataset?.amount || 0);
  const dateStr = btn?.dataset?.date || "";
  const dateLabel = dateStr ? formatDisplayDate(dateStr) : "this date";
  const confirmed = confirm(
    `Delete settlement of ${formatCurrency(amount)} on ${dateLabel}?\n\nOutstanding balance will be recalculated. This cannot be undone.`
  );
  if (!confirmed) return;

  if (btn) btn.disabled = true;
  showCustomerDetailMessage("");
  const { error } = await window.supabaseClient.rpc("delete_credit_payment", { p_payment_id: paymentId });

  if (error) {
    if (btn) btn.disabled = false;
    showCustomerDetailMessage(AppError.getUserMessage(error), true);
    AppError.report(error, { context: "deleteCreditPayment", paymentId });
    return;
  }

  page().invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();
  showCustomerDetailMessage(`Settlement of ${formatCurrency(amount)} deleted.`);
  page().refreshCreditPortfolioViews();
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

  async function init() {
    await initCustomerView();
  }

  window.CreditCustomer = { init, refresh: loadCustomerDetail };
})();
