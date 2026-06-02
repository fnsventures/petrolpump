/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, CreditCustomerDetail, initPageSections, toLocalDateString, debounce, createDateRangeFilter, readDateRangeFromControls, formatDateRangeLabel, setFilterState */

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
    ranges: ["today", "this-week", "this-month", "custom"],
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
    onApply: () => loadCustomerDetail(),
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
  if (settleNav) settleNav.classList.toggle("hidden", totalDue <= 0);
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

function applyLifetimeSummary(row) {
  const outstanding = row ? Number(row.remaining) : 0;
  customerOutstandingDue = outstanding;
  const creditTaken = row ? Number(row.credit_taken) : 0;
  const settlementDone = row ? Number(row.settlement_done) : 0;

  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  set("stat-outstanding", formatCurrency(outstanding));
  set("stat-lifetime-credit", formatCurrency(creditTaken));
  set("stat-lifetime-settled", formatCurrency(settlementDone));

  const outstandingEl = document.getElementById("stat-outstanding");
  const heroAmount = outstandingEl?.closest(".customer-balance-hero-amount");
  if (heroAmount) {
    heroAmount.classList.toggle("is-cleared", outstanding <= 0);
  }

  const payCta = document.getElementById("customer-record-payment-cta");
  if (payCta) payCta.classList.toggle("hidden", outstanding <= 0);

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
  if (settleNav) settleNav.classList.toggle("hidden", outstanding <= 0);
}

async function loadCustomerDetail() {
  const errorEl = document.getElementById("detail-error");
  errorEl?.classList.add("hidden");

  const { asOfDate, from, to } = getCustomerViewFilter();
  updateCustomerFilterSummary();

  if (customerIds.length === 0) await resolveCustomerIds();

  try {
    const { data: summaryData, error: summaryErr } = await supabaseClient.rpc(
      "get_customer_credit_detail_as_of",
      { p_customer_name: customerName, p_date: asOfDate }
    );
    if (summaryErr) throw summaryErr;

    const summary = Array.isArray(summaryData) && summaryData.length > 0 ? summaryData[0] : null;
    const resolvedName = summary?.customer_name != null ? String(summary.customer_name).trim() : "";
    if (!resolvedName) {
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

    applyLifetimeSummary(summary);
    renderLifetimeBreakdowns(summary);

    const creditEntries = filterEntriesByRange(
      (summary.credit_entries || []).map((e) => ({
        transaction_date: e.entry_date,
        amount: e.amount,
        fuel_type: e.fuel_type ?? null,
        quantity: e.quantity ?? null,
        amount_settled: e.amount_settled ?? 0,
      })),
      from,
      to
    );
    const paymentEntries = filterEntriesByRange(
      (summary.payment_entries || []).map((e) => ({
        date: e.entry_date,
        amount: e.amount,
        payment_mode: e.payment_mode ?? null,
        note: e.note ?? null,
      })),
      from,
      to
    );

    const periodCredit = sumAmount(creditEntries);
    const periodSettled = sumAmount(paymentEntries);

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("stat-period-credit", formatCurrency(periodCredit));
    set("stat-period-settled", formatCurrency(periodSettled));

    creditPager?.setEntries(creditEntries);
    paymentPager?.setEntries(paymentEntries);
  } catch (err) {
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
