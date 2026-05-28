/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, CreditCustomerDetail, initPageSections, toLocalDateString */

const { getMonthStart, filterEntriesByRange, sumAmount, createBreakdownPager } = CreditCustomerDetail;

const PAGE_SIZE = 25;

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
let creditPager = null;
let paymentPager = null;

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

  document.getElementById("credit-search")?.addEventListener("input", (e) => {
    creditPagination.searchQuery = (e.target.value || "").trim().toLowerCase();
    creditPagination.offset = 0;
    renderLedgerPage(true);
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
  loadCustomerNames();
  loadCreditLedger(true);
}

function hideCustomerPanels() {
  const ids = [
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
  const toolbar = document.getElementById("customer-period-toolbar");
  if (!toolbar) return;
  toolbar.classList.toggle("hidden", !visible);
  toolbar.hidden = !visible;
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

  document.getElementById("breadcrumb-customer").textContent = customerName;
  document.getElementById("customer-title").textContent = customerName;
  document.title = `${customerName} · Credit · Bishnupriya Fuels`;

  const today = getLocalDateString();
  const throughInput = document.getElementById("filter-through");
  const settleDate = document.getElementById("settle-date");

  if (throughInput) throughInput.value = today;
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
  const rangeSelect = document.getElementById("filter-range");
  const throughInput = document.getElementById("filter-through");
  const fromInput = document.getElementById("filter-from");
  const selection = rangeSelect?.value || "this-month";
  const asOfDate = throughInput?.value || getLocalDateString();

  if (selection === "this-month") {
    return { asOfDate, from: getMonthStart(asOfDate), to: asOfDate, selection };
  }
  if (selection === "last-30-days") {
    const d = new Date(asOfDate + "T00:00:00");
    d.setDate(d.getDate() - 30);
    return { asOfDate, from: toLocalDateString(d), to: asOfDate, selection };
  }
  if (selection === "all-time") {
    return { asOfDate, from: "", to: asOfDate, selection };
  }

  let from = fromInput?.value || getMonthStart(asOfDate);
  let to = asOfDate;
  if (from > to) [from, to] = [to, from];
  return { asOfDate, from, to, selection: "custom" };
}

function describeActivityRange(from, to, selection) {
  const toLabel = formatDisplayDate(to);
  if (selection === "this-month") {
    const monthDate = new Date(`${from}T00:00:00`);
    const monthName = monthDate.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    return `${monthName} (through ${toLabel})`;
  }
  if (selection === "last-30-days") {
    return `${formatDisplayDate(from)} – ${toLabel} (30 days)`;
  }
  if (selection === "all-time") {
    return `All history through ${toLabel}`;
  }
  const fromLabel = from ? formatDisplayDate(from) : "the beginning";
  return `${fromLabel} – ${toLabel}`;
}

function syncCustomerFilterInputs() {
  const throughInput = document.getElementById("filter-through");
  const fromInput = document.getElementById("filter-from");
  const cap = throughInput?.value || getLocalDateString();
  if (fromInput) fromInput.max = cap;
}

function updateCustomerFilterSummary(asOfDate, from, to, selection) {
  const el = document.getElementById("customer-filter-summary");
  if (!el) return;
  const activity = describeActivityRange(from, to, selection);
  el.innerHTML = `<p>Showing <strong>${escapeHtml(activity)}</strong> (through <strong>${formatDisplayDate(asOfDate)}</strong>) on Summary, Credit taken, and Settlements.</p>`;
}

function resetCustomerPeriodFilter() {
  const today = getLocalDateString();
  const throughInput = document.getElementById("filter-through");
  const rangeSelect = document.getElementById("filter-range");
  const fromInput = document.getElementById("filter-from");
  const customRange = document.getElementById("customer-custom-range");
  if (throughInput) throughInput.value = today;
  if (rangeSelect) rangeSelect.value = "this-month";
  if (fromInput) fromInput.value = "";
  if (customRange) {
    customRange.classList.add("hidden");
    customRange.setAttribute("aria-hidden", "true");
  }
  syncCustomerFilterInputs();
  loadCustomerDetail();
}

function initCustomerViewFilter() {
  const rangeSelect = document.getElementById("filter-range");
  const throughInput = document.getElementById("filter-through");
  const fromInput = document.getElementById("filter-from");
  const customRange = document.getElementById("customer-custom-range");

  const syncCustomVisibility = () => {
    const isCustom = rangeSelect?.value === "custom";
    if (customRange) {
      customRange.classList.toggle("hidden", !isCustom);
      customRange.setAttribute("aria-hidden", isCustom ? "false" : "true");
    }
    if (isCustom && fromInput && throughInput && !fromInput.value) {
      fromInput.value = getMonthStart(throughInput.value || getLocalDateString());
    }
    syncCustomerFilterInputs();
  };

  const apply = () => loadCustomerDetail();

  rangeSelect?.addEventListener("change", () => {
    syncCustomVisibility();
    if (rangeSelect.value !== "custom") apply();
  });

  throughInput?.addEventListener("change", apply);
  fromInput?.addEventListener("change", () => {
    if (rangeSelect?.value === "custom") apply();
  });

  syncCustomVisibility();
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
    .select("id, vehicle_no, amount_due, last_payment, customer_name")
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
    customerIds.push(customerId);
  }

  const vehicles = [...new Set(rows.map((r) => r.vehicle_no).filter(Boolean))];
  const meta = document.getElementById("customer-meta");
  if (meta) {
    const parts = [];
    if (vehicles.length) parts.push(`Vehicle: ${vehicles.join(", ")}`);
    meta.textContent = parts.join(" · ") || "Credit customer";
  }

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

  const { asOfDate, from, to, selection } = getCustomerViewFilter();
  updateCustomerFilterSummary(asOfDate, from, to, selection);

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
      if (filterSummary) filterSummary.innerHTML = "";
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
  if (msg) msg.textContent = "";
  if (!customerId) {
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

  const { data, error } = await supabaseClient.rpc("record_credit_payment", {
    p_credit_customer_id: customerId,
    p_date: settlementDate,
    p_amount: amount,
    p_note: null,
    p_payment_mode: paymentMode,
  });

  if (btn) btn.disabled = false;

  if (error) {
    if (msg) msg.textContent = AppError.getUserMessage(error);
    AppError.report(error, { context: "creditCustomerSettle" });
    return;
  }

  document.getElementById("settle-amount").value = "";
  const remaining = Number(data?.new_due ?? 0);
  if (msg) {
    msg.classList.add("success");
    msg.textContent =
      remaining === 0 ? "Fully settled." : `Settled · remaining ${formatCurrency(remaining)}`;
  }

  invalidateCreditCaches();
  await resolveCustomerIds();
  await loadCustomerDetail();
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

async function loadCustomerNames() {
  const datalist = document.getElementById("customer-list");
  if (!datalist) return;
  try {
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("customer_name")
      .order("created_at", { ascending: false });
    if (error) {
      AppError.report(error, { context: "loadCustomerNames" });
      return;
    }
    const names = [...new Set((data || []).map((r) => (r.customer_name || "").trim()).filter(Boolean))];
    datalist.innerHTML = '<option value="Temp">';
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      datalist.appendChild(opt);
    });
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

  if (!customerNameInput || amount <= 0) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save credit entry";
    }
    AppError.handle(new Error("Customer and amount are required."), { target: errorEl });
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
    if (creditPagination.searchQuery) creditPagination.offset = 0;
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
