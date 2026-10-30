/* global formatCurrency, formatRecordedBalance, formatMoneyInput, formatMonthLabel, formatDisplayDate, getLocalDateString, AppCache, AppError, AppDialog, escapeHtml, escapeIlikePattern, formatFuelBadge, normCustomerName, CreditCustomerDetail, initPageSections, createDateRangeFilter, readDateRangeFromControls, formatDateRangeLabel, setFilterState, PumpSettings, loadPumpSettings, AppConfig, CacheInvalidation, formatNumberPlain, initPersistedDateInput, savePersistedDate, RECORD_DATE_KEYS, PrintUtils, formRequestId, clearFormRequestId, pickCreditCustomerContact, fetchCreditCustomerById, confirmCreditOverpayment, bindUnsavedDraft, captureDomDraftFields, omitDraftFields, fetchAllRows, TaskUtils, ActionProgress */

(function () {
  const page = () => window.CreditPage;
  const {
    filterEntriesByRange,
    sumAmount,
    createBreakdownPager,
    buildMonthActivityRows,
    buildDayActivityRows,
    openCreditLines,
  } = CreditCustomerDetail;
  const ACTIVITY_VIEWS = new Set(["outstanding", "activity", "activity-days"]);
  const ACTIVITY_VIEW_STORAGE_KEY = "credit_customer_statement_view";
  let creditPager = null;
  let paymentPager = null;
  let customerPeriodFilterApi = null;
  let customerDetailReady = false;
  let detailLoadSeq = 0;
  let settleInFlight = false;
  let settleDraft = null;
  const deleteInFlight = new Set();

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
  // Only the print sheet reads pump settings; load them alongside the account instead of before it.
  if (typeof loadPumpSettings === "function") void Promise.resolve(loadPumpSettings()).catch(() => {});

  page().setSidebarMode("customer");
  page().setCustomerToolbarVisible(true);

  ["credit-panel-overview", "credit-panel-record", "credit-panel-outstanding"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("is-visible");
    el.classList.add("hidden");
    el.hidden = true;
  });

  if (page().state.customerName) applyCustomerDisplayName(page().state.customerName);

  const settleDate = document.getElementById("settle-date");
  if (settleDate) initPersistedDateInput(settleDate, RECORD_DATE_KEYS.creditSettle);

  applyCustomerPeriodFromUrl(new URLSearchParams(window.location.search));
  restoreCustomerActivityView();
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

  document.querySelectorAll(".customer-activity-view").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyCustomerActivityView(btn.dataset.activityView, { render: true, navigate: true });
    });
  });
  document.getElementById("customer-summary-print-btn")?.addEventListener("click", () => {
    void handleCreditSummaryPrintClick();
  });
  document.getElementById("customer-statement-link-btn")?.addEventListener("click", () => {
    void shareCreditStatementLink();
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

  customerDetailReady = true;
  await loadCustomerDetail();
  bindSettleDraft();
}

/** One draft per customer; the payment date is remembered separately. */
function bindSettleDraft() {
  const form = document.getElementById("settle-form");
  if (!form || settleDraft || typeof bindUnsavedDraft !== "function") return;
  settleDraft = bindUnsavedDraft({
    key: () => {
      const who = page().state.customerId || normCustomerName(page().state.customerName);
      return who ? `credit.settle.${who}` : null;
    },
    root: form,
    capture: () => omitDraftFields(captureDomDraftFields(form), ["settle-date"]),
    skipTarget: (target) => target?.id === "settle-date",
  });
  settleDraft.adoptServerState();
  if (settleDraft.restore()) {
    AppError.showToast("Restored an unsaved payment from this device.", "info");
  }
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

function activityViewMeta(mode) {
  if (mode === "activity-days") return { mode: "activity-days", short: "By day", heading: "Activity by day" };
  if (mode === "outstanding") return { mode: "outstanding", short: "Unpaid", heading: "Unpaid bills" };
  return { mode: "activity", short: "Activity", heading: "Activity" };
}

function creditPrintMode() {
  const active = document.querySelector(".customer-activity-view.is-active")?.dataset.activityView;
  return ACTIVITY_VIEWS.has(active) ? active : "outstanding";
}

function customerActivitySummaryText(range) {
  const view = activityViewMeta(creditPrintMode()).short;
  if (!range) return view;
  const activity = formatDateRangeLabel(range, range.modeInfo, { style: "dashboard" });
  return `${activity} · ${view}`;
}

function updateCustomerFilterSummary() {
  const el = document.getElementById("customer-filter-summary");
  if (!el) return;
  const range =
    customerPeriodFilterApi?.getRange?.() ||
    readDateRangeFromControls(
      document.getElementById("filter-range"),
      document.getElementById("filter-from"),
      document.getElementById("filter-to")
    );
  el.textContent = customerActivitySummaryText(range);
}

function applyCustomerActivityView(mode, options = {}) {
  const next = ACTIVITY_VIEWS.has(mode) ? mode : "outstanding";
  document.querySelectorAll(".customer-activity-view").forEach((btn) => {
    const on = btn.dataset.activityView === next;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  try {
    sessionStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, next);
  } catch (_) {
    /* private browsing */
  }
  const printBtn = document.getElementById("customer-summary-print-btn");
  if (printBtn && !page().state.creditSummaryPrintBusy) {
    printBtn.title = `Print ${activityViewMeta(next).heading.toLowerCase()}`;
  }
  updateCustomerFilterSummary();
  syncUnpaidFigureVisibility(next);
  if (options.render) renderCustomerActivity();
  if (options.navigate) {
    const hash = (location.hash || "").replace(/^#/, "");
    if (hash && hash !== "summary") location.hash = "summary";
  }
}

function restoreCustomerActivityView() {
  let stored = "";
  try {
    stored = sessionStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY) || "";
  } catch (_) {
    stored = "";
  }
  applyCustomerActivityView(stored, { render: false, navigate: false });
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
    trigger: "auto",
    persist: true,
    runOnInit: true,
    customDefaults: "month-start",
    labelStyle: "dashboard",
    formatLabel: (range) => customerActivitySummaryText(range),
    onApply: () => {
      // Init calls load once the pagers exist. An earlier fetch would finish
      // with nowhere to render, then race the real load.
      if (!customerDetailReady) return;
      void loadCustomerDetail();
    },
  });
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
    amountInput.value = formatMoneyInput(page().state.customerNetBalance);
    amountInput.dispatchEvent(new Event("input", { bubbles: true }));
    amountInput.focus();
    amountInput.select();
  });
}

function pickCustomerContact(rows) {
  const contact = pickCreditCustomerContact(rows, page().state.customerId);
  return { mobile: contact.mobile, address: contact.address };
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
  if (page().state.customerId) params.set("id", page().state.customerId);
  else params.set("name", trimmed);
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
  const limitInput = document.getElementById("edit-customer-limit");
  const limitField = limitInput?.closest(".form-field");
  if (limitField) limitField.hidden = !window.CreditPage?.isAdmin;
  if (limitInput) limitInput.value = page().state.creditLimit ? String(page().state.creditLimit) : "";
  msg?.classList.add("hidden");
  msg?.classList.remove("success", "error");

  if (overlay) {
    AppDialog.show(overlay, { focus: nameInput, onDismiss: closeCustomerEditModal });
  }
}

function closeCustomerEditModal() {
  const overlay = document.getElementById("customer-edit-overlay");
  if (!overlay || overlay.getAttribute("aria-hidden") === "true") return;
  AppDialog.hide(overlay);
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
}

async function isCustomerNameTakenByOther(newName, ids) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  const targetNorm = normCustomerName(trimmed);
  const pattern = `%${escapeIlikePattern(trimmed)}%`;
  const { data, error } = await fetchAllRows(() =>
    window.supabaseClient
      .from("credit_customers")
      .select("id, customer_name, mobile")
      .ilike("customer_name", pattern)
      .order("customer_name", { ascending: true })
      .order("id", { ascending: true })
  );
  if (error) {
    AppError.report(error, { context: "isCustomerNameTakenByOther" });
    return false;
  }
  const mobileKey = (document.getElementById("edit-customer-mobile")?.value || "").replace(/\D/g, "");
  return (data || []).some((r) => {
    if (ids.includes(r.id) || normCustomerName(r.customer_name) !== targetNorm) return false;
    const other = String(r.mobile || "").replace(/\D/g, "");
    return Boolean(mobileKey) && mobileKey === other;
  });
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
  const limitRaw = document.getElementById("edit-customer-limit")?.value;
  const creditLimit = limitRaw === "" || limitRaw == null ? null : Number(limitRaw);

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

  const patch = {
    customer_name: newName,
    mobile: mobile || null,
    address: address || null,
  };
  if (window.CreditPage?.isAdmin) {
    patch.credit_limit = Number.isFinite(creditLimit) ? creditLimit : null;
  }
  const { error } = await window.supabaseClient.from("credit_customers").update(patch).in("id", ids);

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
  page().state.creditLimit = Number.isFinite(creditLimit) ? creditLimit : null;
  if (nameChanged) applyCustomerDisplayName(newName);
  page().invalidateCreditCaches();
  await loadCustomerDetail();
  closeCustomerEditModal();
}

async function resolveCustomerIds(isCurrent) {
  if (!page().state.customerName && page().state.customerId) {
    const row = await fetchCreditCustomerById(page().state.customerId);
    if (typeof isCurrent === "function" && !isCurrent()) return;
    if (row?.customer_name) applyCustomerDisplayName(String(row.customer_name).trim());
  }
  const needle = (page().state.customerName || "").trim();
  if (!needle) {
    page().state.customerIds = [];
    return;
  }
  const needleNorm = normCustomerName(needle);
  const pattern = `%${escapeIlikePattern(needle)}%`;
  const { data: list, error } = await fetchAllRows(() =>
    window.supabaseClient
      .from("credit_customers")
      .select("id, vehicle_no, amount_due, prepaid_balance, credit_limit, last_payment, customer_name, mobile, address")
      .ilike("customer_name", pattern)
      .order("customer_name", { ascending: true })
      .order("id", { ascending: true })
  );

  if (typeof isCurrent === "function" && !isCurrent()) return;
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
  page().state.creditLimit =
    rows.map((row) => Number(row.credit_limit)).find((value) => Number.isFinite(value) && value > 0) || null;
  renderCustomerMeta(rows);
  setCustomerNameEditable(rows.length > 0);

  const totalDue = rows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
  const totalPrepaid = rows.reduce((s, r) => s + Number(r.prepaid_balance || 0), 0);
  page().updateCustomerBalanceState(totalDue, totalPrepaid);
  page().applyCustomerBalanceHero(page().state.customerNetBalance, page().state.customerPrepaidBalance);
  updateSettleBalanceBanner();
  syncCustomerContactActions();
}


function formatSummaryQty(value) {
  if (value == null || value === "") return "—";
  const qty = Number(value);
  if (!Number.isFinite(qty)) return "—";
  return qty.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

/** Derive outstanding vs advance from credit − settled (single source of truth for the period). */
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
  const linkBtn = document.getElementById("customer-statement-link-btn");
  if (linkBtn && !page().state.statementLinkBusy) linkBtn.disabled = !page().state.customerId;
  const printBtn = document.getElementById("customer-summary-print-btn");
  if (printBtn) {
    printBtn.disabled = !canShare;
    if (!page().state.creditSummaryPrintBusy) {
      printBtn.title = `Print ${activityViewMeta(creditPrintMode()).heading.toLowerCase()}`;
    }
  }
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
  // The message needs only the balance, known once the customer rows load. Waiting for the
  // period summary left the icon disabled whenever that slower request was late or failed.
  const canShare = page().state.customerIds.length > 0;
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
    waBtn.setAttribute("aria-label", "Send the outstanding reminder on WhatsApp");
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
  const net = Number(page().state.customerNetBalance);
  const unpaid = Number.isFinite(net) ? Math.max(0, net) : 0;
  const name = page().state.lastCustomerSummaryContext?.customerName || page().state.customerName || "";
  if (typeof TaskUtils?.waMessageForCustomer === "function") {
    return TaskUtils.waMessageForCustomer(name, unpaid);
  }
  return formatCurrency(unpaid);
}

const STATEMENT_LINK_DAYS = 30;

/** New 30-day read-only link; WhatsApp when the customer has a mobile, else share sheet or clipboard. */
async function shareCreditStatementLink() {
  const btn = document.getElementById("customer-statement-link-btn");
  const customerId = page().state.customerId;
  if (!customerId || page().state.statementLinkBusy) return;
  page().state.statementLinkBusy = true;
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await window.supabaseClient.rpc("create_credit_statement_link", {
      p_customer_id: customerId,
      p_valid_days: STATEMENT_LINK_DAYS,
    });
    if (error) throw error;
    const url = new URL(`statement.html#t=${data.token}`, window.location.href).href;
    const name = page().state.customerName || "";
    const text = `${buildCreditWhatsAppText()}\n\nYour statement (valid ${STATEMENT_LINK_DAYS} days): ${url}`;
    const waHref = creditCustomerWaHref(String(page().state.customerContact?.mobile || "").trim(), text);
    if (waHref) {
      window.open(waHref, "_blank", "noopener");
    } else if (navigator.share) {
      await navigator.share({ title: `Statement · ${name}`, text, url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url);
      AppDialog.toast("Statement link copied.", "success");
    }
  } catch (err) {
    AppError.report(err, { context: "shareCreditStatementLink" });
  } finally {
    page().state.statementLinkBusy = false;
    if (btn) btn.disabled = !page().state.customerId;
  }
}

function showCreditShareNotice(message) {
  if (typeof AppError?.showGlobalBanner === "function") {
    AppError.showGlobalBanner(message);
  } else {
    void AppDialog.alert(message);
  }
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
        <div class="credit-summary-party-wide">
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

function activityAmountCell(amount) {
  return amount > 0.009 ? formatCurrency(amount) : "";
}

/** Same day rows for the screen and the printout. */
function collectDayActivityDisplay(rows, options) {
  const groupMonths =
    Boolean(options?.groupMonths) &&
    rows.length > 1 &&
    rows[0].date.slice(0, 7) !== rows[rows.length - 1].date.slice(0, 7);
  const lines = [];
  let creditTotal = 0;
  let settledTotal = 0;
  let month = "";
  let monthCredit = 0;
  let monthSettled = 0;

  const flushMonth = () => {
    if (!groupMonths || !month) return;
    lines.push({
      kind: "month-total",
      label: formatMonthLabel(month),
      credit: monthCredit,
      settled: monthSettled,
    });
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
      lines.push({ kind: "month", label: formatMonthLabel(key) });
    }
    monthCredit += row.credit;
    monthSettled += row.settled;
    lines.push({ kind: "day", date: row.date, credit: row.credit, settled: row.settled });
  }
  flushMonth();
  return { lines, creditTotal, settledTotal };
}

function buildDayTableHtml(rows, emptyLabel, options) {
  if (!rows.length) {
    return {
      body: `<tr><td colspan="3" class="muted report-empty-cell">${escapeHtml(emptyLabel)}</td></tr>`,
      creditTotal: 0,
      settledTotal: 0,
    };
  }

  const display = collectDayActivityDisplay(rows, options);
  const body = display.lines
    .map((line) => {
      if (line.kind === "month-total") {
        return `<tr class="credit-summary-month-total"><td>${escapeHtml(line.label)}</td><td class="num">${formatCurrency(line.credit)}</td><td class="num">${formatCurrency(line.settled)}</td></tr>`;
      }
      if (line.kind === "month") {
        return `<tr class="credit-summary-month-row"><td colspan="3">${escapeHtml(line.label)}</td></tr>`;
      }
      return `<tr><td>${escapeHtml(formatDisplayDate(line.date))}</td><td class="num">${activityAmountCell(line.credit)}</td><td class="num">${activityAmountCell(line.settled)}</td></tr>`;
    })
    .join("");
  return { body, creditTotal: display.creditTotal, settledTotal: display.settledTotal };
}

function dayActivityTableHtml(body, totals) {
  const foot = totals
    ? `<tfoot><tr class="report-total-row"><td>Total</td><td class="num">${formatCurrency(totals.credit)}</td><td class="num">${formatCurrency(totals.settled)}</td></tr></tfoot>`
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

  const monthRows = buildMonthActivityRows(credits, payments, "");
  if (!monthRows.length) {
    return `
    <section class="credit-summary-block credit-summary-block--flow">
      <table class="report-table credit-summary-table--months">
        <tbody><tr><td class="muted report-empty-cell">No credit or settlement in this period.</td></tr></tbody>
      </table>
    </section>`;
  }

  let creditTotal = 0;
  let settledTotal = 0;
  const body = monthRows
    .map((row) => {
      creditTotal += row.credit;
      settledTotal += row.settled;
      return `
          <tr>
            <td>${escapeHtml(formatMonthLabel(row.month))}</td>
            <td class="num">${formatCurrency(row.credit)}</td>
            <td class="num">${formatCurrency(row.settled)}</td>
          </tr>`;
    })
    .join("");

  return `
    <section class="credit-summary-block credit-summary-block--flow">
      <h3 class="credit-summary-block-title">By month</h3>
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
            <td class="num">${formatCurrency(creditTotal)}</td>
            <td class="num">${formatCurrency(settledTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </section>`;
}

/** Credit sales dated inside the selected period. Unpaid uses the same window as Activity. */
function periodCreditEntries() {
  const entries = page().state.lastCustomerSummary?.credit_entries;
  return Array.isArray(entries) ? entries : [];
}

function buildOutstandingLinesHtml() {
  const lines = openCreditLines(periodCreditEntries());
  if (!lines.length) {
    return {
      rows: `<tr><td colspan="4" class="muted report-empty-cell">No unpaid bills.</td></tr>`,
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
          <td class="num">${formatCurrency(line.open)}</td>
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

function creditStatementPeriodLabel(context) {
  if (context?.periodActivity) return escapeHtml(context.periodActivity);
  const asOfLabel = context?.asOfDate ? formatDisplayDate(context.asOfDate) : formatDisplayDate(getLocalDateString());
  return `As on ${escapeHtml(asOfLabel)}`;
}

function creditStatementFiguresHtml(balance, options = {}) {
  const dueClass = `credit-summary-due${balance.cleared ? " is-cleared" : ""}${balance.hasAdvance ? " is-advance" : ""}`;
  const due = `
    <div class="${dueClass}">
      <span class="credit-summary-due-label">${escapeHtml(balance.balanceLabel)}</span>
      <span class="credit-summary-due-value">${formatCurrency(balance.balanceValue)}</span>
    </div>`;
  if (options.outstandingOnly) return due;
  return `
    <div class="credit-summary-kpis credit-summary-kpis--two">
      <div class="credit-summary-kpi">
        <span class="credit-summary-kpi-label">Credit taken</span>
        <span class="credit-summary-kpi-value">${formatCurrency(balance.credit)}</span>
      </div>
      <div class="credit-summary-kpi">
        <span class="credit-summary-kpi-label">Settled</span>
        <span class="credit-summary-kpi-value">${formatCurrency(balance.settled)}</span>
      </div>
    </div>
    ${due}`;
}

function unpaidActivityNote(openTotal, context) {
  const notes = [];
  if ((Number(openTotal) || 0) > 0.009) {
    notes.push("Settled bills are not listed.");
  }
  const asOf = String(context?.asOfDate || "");
  if (asOf && asOf < getLocalDateString()) {
    notes.push("A payment made after this period is already deducted from these open amounts.");
  }
  return notes.join(" ");
}

/** Unpaid outstanding is the open total of the bills on the statement, so the figure matches the list. */
function balanceFromOpenTotal(openTotal) {
  const open = Math.max(0, Number(openTotal) || 0);
  return {
    credit: 0,
    settled: 0,
    outstanding: open,
    advancePayment: 0,
    hasAdvance: false,
    cleared: open <= 0.009,
    balanceLabel: "Outstanding",
    balanceValue: open,
  };
}

function buildOutstandingStatementHtml(summary, context) {
  const party = creditPrintParty(context);
  const asOfLabel = context?.asOfDate ? formatDisplayDate(context.asOfDate) : formatDisplayDate(getLocalDateString());
  const openLines = buildOutstandingLinesHtml();
  const balance = balanceFromOpenTotal(openLines.openTotal);
  const note = unpaidActivityNote(openLines.openTotal, context);
  const foot = openLines.count
    ? `<tfoot><tr class="report-total-row"><td colspan="3">Open total</td><td class="num">${formatCurrency(openLines.openTotal)}</td></tr></tfoot>`
    : "";

  return `
    <article class="credit-summary-sheet report-print-sheet">
      ${creditSummaryReportHeader("Unpaid credit", [creditStatementPeriodLabel(context)])}

      ${creditSummaryPartyHtml(party.name, party.mobile, party.vehicleLine, party.address)}

      ${creditStatementFiguresHtml(balance, { outstandingOnly: true })}

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
          ${foot}
        </table>
      </section>

      ${note ? `<p class="credit-summary-note">${escapeHtml(note)}</p>` : ""}

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>Unpaid bills · ${escapeHtml(party.name)} · ${escapeHtml(asOfLabel)}</span>
      </footer>
    </article>`;
}

function buildActivityStatementHtml(summary, context) {
  const balance = resolveCreditPrintBalance(summary?.credit_taken, summary?.settlement_done);
  const party = creditPrintParty(context);
  const asOfLabel = context?.asOfDate ? formatDisplayDate(context.asOfDate) : "—";
  const viewLabel = context?.printMode === "activity-days" ? "Activity by day" : "Activity";

  return `
    <article class="credit-summary-sheet report-print-sheet">
      ${creditSummaryReportHeader(viewLabel, [creditStatementPeriodLabel(context)])}

      ${creditSummaryPartyHtml(party.name, party.mobile, party.vehicleLine, party.address)}

      ${creditStatementFiguresHtml(balance)}

      ${buildActivitySectionsHtml(summary, context)}

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>${escapeHtml(viewLabel)} · ${escapeHtml(party.name)} · ${escapeHtml(asOfLabel)}</span>
      </footer>
    </article>`;
}

async function runCreditSummaryPrint() {
  if (!page().state.lastCustomerSummary || !page().state.lastCustomerSummaryContext?.customerName) {
    const msg = "Load the customer account first, then print.";
    if (typeof AppError?.showGlobalBanner === "function") {
      AppError.showGlobalBanner(msg);
    } else {
      void AppDialog.alert(msg);
    }
    return;
  }

  if (typeof loadPumpSettings === "function") await loadPumpSettings();
  const mode = creditPrintMode();
  const ctx = page().state.lastCustomerSummaryContext;
  // Period-scoped summary already on screen, so the sheet matches the selected view.
  const summary = page().state.lastCustomerSummary;
  const printContext = { ...ctx, printMode: mode };
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
      void AppDialog.alert(msg);
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

function activityScreenTableHtml(headers, body, footRow) {
  const head = headers
    .map((header) => `<th${header.num ? ' class="num"' : ""}>${escapeHtml(header.label)}</th>`)
    .join("");
  const foot = footRow ? `<tfoot><tr>${footRow}</tr></tfoot>` : "";
  return `<div class="table-wrap"><table class="customer-activity-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
}

function activityEmptyHtml(message) {
  return `<p class="customer-activity-empty">${escapeHtml(message)}</p>`;
}

function dayActivityScreenHtml(rows, emptyLabel, options) {
  const title = options?.title
    ? `<h3 class="customer-activity-block-title">${escapeHtml(options.title)}</h3>`
    : "";
  if (!rows.length) {
    return `<section class="customer-activity-block">${title}${activityEmptyHtml(emptyLabel)}</section>`;
  }
  const display = collectDayActivityDisplay(rows, options);
  const body = display.lines
    .map((line) => {
      if (line.kind === "month") {
        return `<tr class="is-month"><td colspan="3">${escapeHtml(line.label)}</td></tr>`;
      }
      if (line.kind === "month-total") {
        return `<tr class="is-month-total"><td>${escapeHtml(line.label)}</td><td class="num">${formatCurrency(line.credit)}</td><td class="num">${formatCurrency(line.settled)}</td></tr>`;
      }
      return `<tr><td>${escapeHtml(formatDisplayDate(line.date))}</td><td class="num">${activityAmountCell(line.credit)}</td><td class="num">${activityAmountCell(line.settled)}</td></tr>`;
    })
    .join("");
  const foot = options?.showTotal
    ? `<td>Total</td><td class="num">${formatCurrency(display.creditTotal)}</td><td class="num">${formatCurrency(display.settledTotal)}</td>`
    : "";
  return `<section class="customer-activity-block">${title}${activityScreenTableHtml(
    [
      { label: "Date" },
      { label: "Credit (₹)", num: true },
      { label: "Settled (₹)", num: true },
    ],
    body,
    foot
  )}</section>`;
}

function monthActivityScreenHtml(monthRows) {
  let creditTotal = 0;
  let settledTotal = 0;
  const body = monthRows
    .map((row) => {
      creditTotal += row.credit;
      settledTotal += row.settled;
      return `<tr><td>${escapeHtml(formatMonthLabel(row.month))}</td><td class="num">${formatCurrency(row.credit)}</td><td class="num">${formatCurrency(row.settled)}</td></tr>`;
    })
    .join("");
  return `<section class="customer-activity-block"><h3 class="customer-activity-block-title">By month</h3>${activityScreenTableHtml(
    [
      { label: "Month" },
      { label: "Credit (₹)", num: true },
      { label: "Settled (₹)", num: true },
    ],
    body,
    `<td>Total</td><td class="num">${formatCurrency(creditTotal)}</td><td class="num">${formatCurrency(settledTotal)}</td>`
  )}</section>`;
}

function unpaidActivityScreenHtml(summary, context) {
  const lines = openCreditLines(periodCreditEntries());
  const noteFor = (openTotal) => {
    const note = unpaidActivityNote(openTotal, context);
    return note ? `<p class="customer-activity-note">${escapeHtml(note)}</p>` : "";
  };
  if (!lines.length) return `${activityEmptyHtml("No unpaid bills.")}${noteFor(0)}`;

  let openTotal = 0;
  const body = lines
    .map((line) => {
      openTotal += line.open;
      const fuel = String(line.fuel_type || "").trim();
      const fuelCell =
        fuel && typeof formatFuelBadge === "function" ? formatFuelBadge(line.fuel_type) : escapeHtml(fuel || "—");
      return `<tr><td>${escapeHtml(formatDisplayDate(line.entry_date))}</td><td>${fuelCell}</td><td class="num">${escapeHtml(formatSummaryQty(line.quantity))}</td><td class="num is-open">${formatCurrency(line.open)}</td></tr>`;
    })
    .join("");
  return `<section class="customer-activity-block">${activityScreenTableHtml(
    [
      { label: "Date" },
      { label: "Fuel" },
      { label: "Qty (L)", num: true },
      { label: "Open (₹)", num: true },
    ],
    body,
    `<td colspan="3">Open total</td><td class="num">${formatCurrency(openTotal)}</td>`
  )}${noteFor(openTotal)}</section>`;
}

function activitySectionsScreenHtml(summary, context, mode) {
  const credits = summary?.credit_entries || [];
  const payments = summary?.payment_entries || [];
  if (mode === "outstanding") return unpaidActivityScreenHtml(summary, context);
  if (mode === "activity-days") {
    return dayActivityScreenHtml(buildDayActivityRows(credits, payments, ""), "No credit or settlement in this period.", {
      groupMonths: true,
      showTotal: true,
    });
  }
  const monthRows = buildMonthActivityRows(credits, payments, "");
  if (!monthRows.length) return activityEmptyHtml("No credit or settlement in this period.");
  return monthActivityScreenHtml(monthRows);
}

function activityLeadText(mode, summary, context) {
  const credits = summary?.credit_entries || [];
  const payments = summary?.payment_entries || [];
  if (mode === "outstanding") {
    const count = openCreditLines(periodCreditEntries()).length;
    const scope = context?.selection === "all-time" ? "" : " in this period";
    if (!count) return `No unpaid bills${scope}.`;
    return `${count} unpaid ${count === 1 ? "bill" : "bills"}${scope}.`;
  }
  if (mode === "activity-days") {
    const days = buildDayActivityRows(credits, payments, "").length;
    if (!days) return "No credit or settlement in this period.";
    return `${days} ${days === 1 ? "day" : "days"} with credit or a settlement.`;
  }
  const months = buildMonthActivityRows(credits, payments, "").length;
  if (!months) return "No credit or settlement in this period.";
  return months === 1 ? "1 month with credit or a settlement." : `${months} months with credit or a settlement.`;
}

function syncUnpaidCount(summary) {
  const el = document.getElementById("customer-activity-unpaid-count");
  if (!el) return;
  const count = summary ? openCreditLines(periodCreditEntries()).length : 0;
  el.textContent = count ? String(count) : "";
  el.hidden = !count;
}

function syncUnpaidFigureVisibility(mode) {
  const unpaid = (mode || creditPrintMode()) === "outstanding";
  document.getElementById("customer-period-toolbar")?.classList.toggle("is-unpaid-view", unpaid);
}

function renderCustomerActivity() {
  const summary = page().state.lastCustomerSummary;
  const context = page().state.lastCustomerSummaryContext;
  const mode = creditPrintMode();
  const meta = activityViewMeta(mode);
  const heading = document.getElementById("customer-activity-heading");
  const lead = document.getElementById("customer-activity-lead");
  const root = document.getElementById("customer-activity-body");
  if (heading) heading.textContent = meta.heading;
  if (lead) lead.textContent = summary ? activityLeadText(mode, summary, context) : "";
  syncUnpaidCount(summary);
  syncUnpaidFigureVisibility(mode);
  if (summary) applyPeriodBalanceKpis(summary.credit_taken, summary.settlement_done);
  if (root) root.innerHTML = summary ? activitySectionsScreenHtml(summary, context, mode) : "";
}

function applyPeriodBalanceKpis(credit, settled) {
  const period = resolveCreditPrintBalance(credit, settled);
  const openTotal = openCreditLines(periodCreditEntries()).reduce((sum, line) => sum + line.open, 0);
  const balance = creditPrintMode() === "outstanding" ? balanceFromOpenTotal(openTotal) : period;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("stat-period-credit", formatCurrency(period.credit));
  set("stat-period-settled", formatCurrency(period.settled));
  set("stat-period-outstanding", formatCurrency(balance.balanceValue));
  set("stat-period-outstanding-label", balance.balanceLabel);
  const card = document.getElementById("stat-period-outstanding-card");
  if (card) {
    card.classList.toggle("is-advance", balance.hasAdvance);
    card.classList.toggle("is-cleared", balance.cleared);
    card.classList.toggle("is-due", !balance.hasAdvance && !balance.cleared);
  }
  const equation = document.getElementById("customer-activity-equation");
  if (equation) {
    equation.textContent = period.hasAdvance
      ? "Settlements in this period are higher than credit taken, so this is an advance."
      : "Outstanding is credit taken minus settlements in this period.";
  }
}

function clearPeriodActivityUi() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("stat-period-credit", "—");
  set("stat-period-settled", "—");
  set("stat-period-outstanding", "—");
  set("stat-period-outstanding-label", "Outstanding");
  document.getElementById("stat-period-outstanding-card")?.classList.remove("is-advance", "is-cleared", "is-due");
  const equation = document.getElementById("customer-activity-equation");
  if (equation) equation.textContent = "Outstanding is credit taken minus settlements in this period.";
  const root = document.getElementById("customer-activity-body");
  if (root) root.innerHTML = "";
  const lead = document.getElementById("customer-activity-lead");
  if (lead) lead.textContent = "";
  const heading = document.getElementById("customer-activity-heading");
  if (heading) heading.textContent = activityViewMeta(creditPrintMode()).heading;
  syncUnpaidCount(null);
  syncUnpaidFigureVisibility();
}

function applyLifetimeSummary(_row, options = {}) {
  page().updateCustomerBalanceState(
    options.heroAmountDue ?? page().state.customerOutstandingDue,
    options.heroPrepaidBalance ?? page().state.customerPrepaidBalance
  );
  page().applyCustomerBalanceHero(page().state.customerNetBalance, page().state.customerPrepaidBalance);
}

async function loadCustomerDetail() {
  const seq = ++detailLoadSeq;
  const errorEl = document.getElementById("detail-error");
  if (errorEl) {
    errorEl.classList.add("hidden");
    errorEl.classList.remove("success");
  }

  const { asOfDate, from, to, selection } = getCustomerViewFilter();
  const range =
    customerPeriodFilterApi?.getRange?.() ||
    readDateRangeFromControls(
      document.getElementById("filter-range"),
      document.getElementById("filter-from"),
      document.getElementById("filter-to")
    );
  const periodActivity = range ? formatDateRangeLabel(range, range.modeInfo, { style: "dashboard" }) : "";
  updateCustomerFilterSummary();

  const stillCurrent = () => seq === detailLoadSeq;

  try {
    // Opened by id only: the name has to come first, since both requests below key on it.
    if (!page().state.customerName && page().state.customerId) {
      const row = await fetchCreditCustomerById(page().state.customerId);
      if (!stillCurrent()) return;
      if (row?.customer_name) applyCustomerDisplayName(String(row.customer_name).trim());
    }

    const detailArgs = { p_customer_name: page().state.customerName, p_date: asOfDate };
    if (from) detailArgs.p_from = from;
    const [, { data: summaryData, error: summaryErr }] = await Promise.all([
      resolveCustomerIds(stillCurrent),
      window.supabaseClient.rpc("get_customer_credit_detail_as_of", detailArgs),
    ]);
    if (!stillCurrent()) return;
    if (summaryErr) throw summaryErr;

    const summary = Array.isArray(summaryData) && summaryData.length > 0 ? summaryData[0] : null;
    const resolvedName = summary?.customer_name != null ? String(summary.customer_name).trim() : "";
    if (!resolvedName) {
      page().state.lastCustomerSummary = null;
      page().state.lastCustomerSummaryFull = null;
      page().state.lastCustomerSummaryContext = null;
      updateCreditSummaryPrintButton();
      applyLifetimeSummary(null);
      clearPeriodActivityUi();
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

    page().state.lastCustomerSummaryFull = summary;
    const periodSummary =
      summary.opening_balance != null && summary.opening_balance !== undefined
        ? summary
        : buildPeriodScopedSummary(summary, from, to);
    applyLifetimeSummary(periodSummary, {
      heroAmountDue: page().state.customerOutstandingDue,
      heroPrepaidBalance: page().state.customerPrepaidBalance,
    });

    const creditEntries = (periodSummary.credit_entries || []).map((e) => ({
      id: e.id ?? null,
      transaction_date: e.entry_date,
      entry_date: e.entry_date,
      amount: e.amount,
      fuel_type: e.fuel_type ?? null,
      quantity: e.quantity ?? null,
      amount_settled: e.amount_settled ?? 0,
      status: e.status || "posted",
      entry_kind: e.entry_kind || "sale",
      created_by_name: e.created_by_name || "",
    }));
    const paymentEntries = (periodSummary.payment_entries || []).map((e) => ({
      id: e.id ?? null,
      date: e.entry_date,
      entry_date: e.entry_date,
      amount: e.amount,
      payment_mode: e.payment_mode ?? null,
      note: e.note ?? null,
      same_day_settlement: Boolean(e.same_day_settlement),
      status: e.status || "posted",
      created_by_name: e.created_by_name || "",
    }));

    periodSummary.credit_entries = creditEntries;
    periodSummary.payment_entries = paymentEntries;

    const periodCredit = Number(periodSummary.credit_taken) || 0;
    const periodSettled = Number(periodSummary.settlement_done) || 0;
    applyPeriodBalanceKpis(periodCredit, periodSettled);

    page().state.lastCustomerSummary = periodSummary;
    page().state.lastCustomerSummaryContext = {
      customerName: resolvedName,
      asOfDate,
      selection,
      periodActivity,
      periodCredit,
      periodSettled,
      openingBalance: Number(periodSummary.opening_balance) || 0,
      closingBalance:
        periodSummary.closing_balance != null ? Number(periodSummary.closing_balance) : null,
      mobile: page().state.customerContact.mobile,
      address: page().state.customerContact.address,
      vehicles: [...page().state.customerVehicleNos],
    };
    renderCustomerActivity();

    creditPager?.setEntries(creditEntries);
    paymentPager?.setEntries(paymentEntries);
    updateCreditSummaryPrintButton();
  } catch (err) {
    if (!stillCurrent()) return;
    page().state.lastCustomerSummary = null;
    page().state.lastCustomerSummaryFull = null;
    page().state.lastCustomerSummaryContext = null;
    clearPeriodActivityUi();
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
  if (settleInFlight) return;

  const msg = document.getElementById("settle-msg");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("success");
  }

  const settleIds = page().state.customerIds.length > 0 ? [...page().state.customerIds] : page().state.customerId ? [page().state.customerId] : [];
  if (settleIds.length === 0) {
    if (msg) {
      msg.textContent = "No customer record to settle.";
      msg.classList.remove("hidden");
    }
    return;
  }

  const amount = Number(document.getElementById("settle-amount")?.value || 0);
  const settlementDate =
    document.getElementById("settle-date")?.value?.trim() || getLocalDateString();
  const paymentMode = document.getElementById("settle-mode")?.value || "Cash";
  const sameDaySettlement = Boolean(document.getElementById("settle-same-day")?.checked);
  const todayStr = getLocalDateString();

  if (!amount || amount <= 0) {
    AppError.showSaveError("Enter a valid amount.", {
      target: msg,
      field: document.getElementById("settle-amount"),
    });
    return;
  }
  if (!(await confirmCreditOverpayment(amount, page().state.customerNetBalance))) return;

  if (amount >= 10000 && Math.round(amount * 100) <= Math.round(Math.max(0, page().state.customerNetBalance) * 100)) {
    const ok = await AppDialog.confirm(`Record a payment of ${formatCurrency(amount)}?`, {
      title: "Confirm payment",
      confirmLabel: "Record payment",
    });
    if (!ok) return;
  }
  if (settlementDate > todayStr) {
    AppError.showSaveError("Settlement date cannot be in the future.", {
      target: msg,
      field: document.getElementById("settle-date"),
    });
    return;
  }

  settleInFlight = true;

  const btn = document.getElementById("settle-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  const finishSettleSubmit = () => {
    settleInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Record payment";
    }
  };

  try {
    // Same id while the form is unchanged, so a retry cannot record the payment twice.
    const settleForm = document.getElementById("settle-form");
    const requestId = formRequestId(settleForm, [
      settleIds,
      settlementDate,
      amount,
      paymentMode,
      sameDaySettlement,
    ]);

    if (settleIds.length === 1) {
      const { error } = await window.supabaseClient.rpc("record_credit_payment", {
        p_credit_customer_id: settleIds[0],
        p_date: settlementDate,
        p_amount: amount,
        p_note: null,
        p_payment_mode: paymentMode,
        p_same_day_settlement: sameDaySettlement,
        p_request_id: requestId,
      });

      if (error) {
        AppError.showSaveError(AppError.getUserMessage(error), { target: msg, form: settleForm });
        AppError.report(error, { context: "creditCustomerSettle", customerId: settleIds[0] });
        page().invalidateCreditCaches();
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
        p_request_id: requestId,
      });

      if (error) {
        AppError.showSaveError(AppError.getUserMessage(error), { target: msg, form: settleForm });
        AppError.report(error, { context: "creditCustomerSettleBatch", customerIds: settleIds });
        page().invalidateCreditCaches();
        await loadCustomerDetail();
        return;
      }
    }

    clearFormRequestId(settleForm);

    const settleAmountInput = document.getElementById("settle-amount");
    if (settleAmountInput) settleAmountInput.value = "";
    const sameDayInput = document.getElementById("settle-same-day");
    if (sameDayInput) sameDayInput.checked = false;
    savePersistedDate(RECORD_DATE_KEYS.creditSettle, settlementDate);
    settleDraft?.markClean();
    page().invalidateCreditCaches();
    await loadCustomerDetail();
    document.getElementById("settle-amount")?.focus();

    if (msg) {
      msg.classList.add("success");
      msg.classList.remove("hidden");
      msg.textContent = formatRecordedBalance({
        amount,
        person: page().state.customerName,
        remaining: page().state.customerNetBalance,
        direction: "from",
      });
    }
    AppError.showToast(msg?.textContent || "", "success");
  } catch (err) {
    AppError.showSaveError(AppError.getUserMessage(err), {
      target: msg,
      form: document.getElementById("settle-form"),
    });
    AppError.report(err, { context: "creditCustomerSettle" });
  } finally {
    finishSettleSubmit();
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
  if (deleteInFlight.has(entryId)) return;
  deleteInFlight.add(entryId);
  const amount = Number(btn?.dataset?.amount || 0);
  const dateStr = btn?.dataset?.date || "";
  const dateLabel = dateStr ? formatDisplayDate(dateStr) : "this date";
  try {
    const confirmed = await AppDialog.confirm(
      `Delete the credit entry of ${formatCurrency(amount)} on ${dateLabel}?\n\nIt will be removed from the statement, and the balance is recalculated. This cannot be undone.`,
      { title: "Delete credit entry", confirmLabel: "Delete entry", danger: true }
    );
    if (!confirmed) return;

    if (btn) btn.disabled = true;
    showCustomerDetailMessage("");
    await ActionProgress.track(
      { title: "Deleting", status: "Removing this credit entry…", doneStatus: "Deleted" },
      async () => {
        const { error } = await window.supabaseClient.rpc("delete_credit_entry", { p_entry_id: entryId });
        if (error) throw error;
        page().invalidateCreditCaches();
        await loadCustomerDetail();
        showCustomerDetailMessage(`Credit entry of ${formatCurrency(amount)} deleted.`);
        page().refreshCreditPortfolioViews();
      }
    );
  } catch (error) {
    if (btn) btn.disabled = false;
    showCustomerDetailMessage(AppError.getUserMessage(error), true);
    AppError.report(error, { context: "deleteCreditEntry", entryId });
  } finally {
    deleteInFlight.delete(entryId);
  }
}

async function deleteCreditPayment(paymentId, btn) {
  if (deleteInFlight.has(paymentId)) return;
  deleteInFlight.add(paymentId);
  const amount = Number(btn?.dataset?.amount || 0);
  const dateStr = btn?.dataset?.date || "";
  const dateLabel = dateStr ? formatDisplayDate(dateStr) : "this date";
  try {
    const confirmed = await AppDialog.confirm(
      `Delete the settlement of ${formatCurrency(amount)} on ${dateLabel}?\n\nIt will be removed from the statement, and the balance is recalculated. This cannot be undone.`,
      { title: "Delete settlement", confirmLabel: "Delete settlement", danger: true }
    );
    if (!confirmed) return;

    if (btn) btn.disabled = true;
    showCustomerDetailMessage("");
    await ActionProgress.track(
      { title: "Deleting", status: "Removing this settlement…", doneStatus: "Deleted" },
      async () => {
        const { error } = await window.supabaseClient.rpc("delete_credit_payment", { p_payment_id: paymentId });
        if (error) throw error;
        page().invalidateCreditCaches();
        await loadCustomerDetail();
        showCustomerDetailMessage(`Settlement of ${formatCurrency(amount)} deleted.`);
        page().refreshCreditPortfolioViews();
      }
    );
  } catch (error) {
    if (btn) btn.disabled = false;
    showCustomerDetailMessage(AppError.getUserMessage(error), true);
    AppError.report(error, { context: "deleteCreditPayment", paymentId });
  } finally {
    deleteInFlight.delete(paymentId);
  }
}

  async function init() {
    await initCustomerView();
  }

  window.CreditCustomer = { init, refresh: loadCustomerDetail };
})();
