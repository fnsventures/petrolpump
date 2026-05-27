/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, formatDisplayDate, getLocalDateString, AppCache, AppError, escapeHtml, CreditCustomerDetail, initPageSections, toLocalDateString */

const { getMonthStart, filterEntriesByRange, sumAmount, createBreakdownPager } = CreditCustomerDetail;

const PAGE_SIZE = 25;

let listState = {
  currentPage: 0,
  totalCount: 0,
  isLoading: false,
  currentDate: null,
  filteredData: [],
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

function customerUrl(name) {
  return `credit-overdue.html?${new URLSearchParams({ name: name || "" }).toString()}`;
}

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "credit-overdue",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  const params = new URLSearchParams(window.location.search);
  customerName = (params.get("name") || "").trim();
  customerId = params.get("id") || null;

  if (isCustomerView()) {
    initCustomerView();
  } else {
    initListView();
  }
});

function setCustomerToolbarVisible(visible) {
  const toolbar = document.getElementById("customer-period-toolbar");
  if (!toolbar) return;
  toolbar.classList.toggle("hidden", !visible);
  toolbar.hidden = !visible;
}

function initListView() {
  document.body.classList.add("credit-list-view");
  document.body.classList.remove("credit-customer-view");
  setCustomerToolbarVisible(false);

  const listNav = document.getElementById("list-view-root");
  const customerNav = document.getElementById("customer-view-root");
  if (listNav) {
    listNav.classList.remove("hidden");
    listNav.hidden = false;
  }
  if (customerNav) {
    customerNav.classList.add("hidden");
    customerNav.hidden = true;
  }

  if (typeof initPageSections === "function") {
    initPageSections({
      navItemSelector: "#list-view-root .settings-nav-item",
      panelSelector: "#list-panel-summary, #list-panel-list",
      defaultSection: "overdue-summary",
      validSections: ["overdue-summary", "overdue-list"],
    });
  }

  const dateInput = document.getElementById("credit-overdue-date");
  const todayStr = getLocalDateString();
  if (dateInput) {
    dateInput.value = todayStr;
    dateInput.addEventListener("change", () => {
      loadOpenCredit(dateInput.value || todayStr, true);
    });
  }

  initOverduePaginationControls();
  loadOpenCredit(todayStr, true);
}

async function initCustomerView() {
  document.body.classList.add("credit-customer-view");
  document.body.classList.remove("credit-list-view");
  setCustomerToolbarVisible(true);

  const listNav = document.getElementById("list-view-root");
  const customerNav = document.getElementById("customer-view-root");
  if (listNav) {
    listNav.classList.add("hidden");
    listNav.hidden = true;
  }
  if (customerNav) {
    customerNav.classList.remove("hidden");
    customerNav.hidden = false;
  }

  const listSum = document.getElementById("list-panel-summary");
  const listTbl = document.getElementById("list-panel-list");
  [listSum, listTbl].forEach((el) => {
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
      navItemSelector: "#customer-view-root .settings-nav-item",
      panelSelector:
        "#customer-panel-summary, #settle-section, section[data-panel='credit'], section[data-panel='payments']",
      defaultSection: "summary",
      validSections: ["summary", "settle", "credit", "payments"],
    });
  }

  await loadCustomerDetail();
}

/** Single customer date filter: period preset + through date (balances & lists). */
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

function initOverduePaginationControls() {
  const tableSection = document.querySelector("#list-panel-list");
  if (!tableSection || tableSection.querySelector(".pagination-controls")) return;

  const paginationDiv = document.createElement("div");
  paginationDiv.className = "pagination-controls";
  paginationDiv.innerHTML = `
    <div class="pagination-info">
      <span id="overdue-pagination-info" class="muted"></span>
    </div>
    <div class="pagination-buttons">
      <button type="button" id="overdue-pagination-back" class="button-secondary hidden">Back</button>
      <button type="button" id="overdue-load-more" class="button-secondary hidden">Show more</button>
    </div>
  `;
  tableSection.appendChild(paginationDiv);

  document.getElementById("overdue-pagination-back")?.addEventListener("click", () => {
    if (listState.currentPage > 0) {
      listState.currentPage--;
      renderOverduePage();
      updateOverduePaginationUI();
    }
  });
  document.getElementById("overdue-load-more")?.addEventListener("click", () => {
    const totalPages = Math.ceil(listState.totalCount / PAGE_SIZE);
    if (listState.currentPage < totalPages - 1) {
      listState.currentPage++;
      renderOverduePage();
      updateOverduePaginationUI();
    }
  });
}

function updateOverdueSummaryStats(totalDue, customerCount) {
  const totalEl = document.getElementById("overdue-total-outstanding");
  const countEl = document.getElementById("overdue-customer-count");
  if (totalEl) totalEl.textContent = formatCurrency(totalDue);
  if (countEl) countEl.textContent = String(customerCount);
}

async function loadOpenCredit(dateStr, reset = false) {
  const tbody = document.getElementById("credit-overdue-body");
  const loadMoreBtn = document.getElementById("overdue-load-more");

  if (!tbody || listState.isLoading) return;
  listState.isLoading = true;

  if (reset || listState.currentDate !== dateStr) {
    listState.currentPage = 0;
    listState.totalCount = 0;
    listState.currentDate = dateStr;
    listState.filteredData = [];
    tbody.innerHTML = "<tr><td colspan='6' class='muted'>Loading…</td></tr>";
  }

  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading…";
  }

  try {
    if (reset || listState.currentDate !== dateStr || listState.filteredData.length === 0) {
      const { data: listData, error } = await supabaseClient.rpc("get_outstanding_credit_list_as_of", {
        p_date: dateStr,
      });

      if (error) {
        tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
        updateOverdueSummaryStats(0, 0);
        AppError.report(error, { context: "loadOpenCredit" });
        return;
      }

      listState.filteredData = listData ?? [];
      listState.totalCount = listState.filteredData.length;
      if (reset) listState.currentPage = 0;
    }

    const asOfEl = document.getElementById("credit-overdue-as-of");
    if (asOfEl) asOfEl.textContent = `As of ${formatDisplayDate(dateStr)}`;

    if (listState.filteredData.length === 0) {
      tbody.innerHTML = `<tr><td colspan='6'><div class='empty-state'><p>No outstanding credits for this date.</p><p class='empty-cta'><a href='credit.html'>Record credit sale</a></p></div></td></tr>`;
      updateOverdueSummaryStats(0, 0);
      return;
    }

    const totalDue = listState.filteredData.reduce(
      (sum, row) => sum + Number(row.amount_due_as_of ?? 0),
      0
    );
    updateOverdueSummaryStats(totalDue, listState.totalCount);

    renderOverduePage();
  } catch (err) {
    if (reset) {
      tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
      updateOverdueSummaryStats(0, 0);
    }
    AppError.report(err, { context: "loadOpenCredit" });
  } finally {
    listState.isLoading = false;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Show more";
    }
    updateOverduePaginationUI();
  }
}

function renderOverduePage() {
  const tbody = document.getElementById("credit-overdue-body");
  if (!tbody || !listState.filteredData.length) return;

  const sliceStart = listState.currentPage * PAGE_SIZE;
  const sliceEnd = Math.min(sliceStart + PAGE_SIZE, listState.totalCount);
  const rowsToShow = listState.filteredData.slice(sliceStart, sliceEnd);

  tbody.innerHTML = rowsToShow
    .map((row) => {
      const href = customerUrl(row.customer_name || "");
      return (
        `<tr>` +
        `<td><a class="customer-link" href="${href}">${escapeHtml(row.customer_name || "—")}</a></td>` +
        `<td>${escapeHtml(row.vehicle_no ?? "—")}</td>` +
        `<td>${formatCurrency(row.amount_due_as_of)}</td>` +
        `<td>${formatDisplayDate(row.last_payment_date)}</td>` +
        `<td>${formatDisplayDate(row.sale_date)}</td>` +
        `<td class="table-actions"><a class="button-secondary button-small" href="${href}">View details</a></td>` +
        `</tr>`
      );
    })
    .join("");
}

function updateOverduePaginationUI() {
  const backBtn = document.getElementById("overdue-pagination-back");
  const loadMoreBtn = document.getElementById("overdue-load-more");
  const paginationInfo = document.getElementById("overdue-pagination-info");

  if (paginationInfo) {
    if (listState.totalCount > 0) {
      const from = listState.currentPage * PAGE_SIZE + 1;
      const to = Math.min((listState.currentPage + 1) * PAGE_SIZE, listState.totalCount);
      const totalPages = Math.ceil(listState.totalCount / PAGE_SIZE);
      paginationInfo.textContent =
        totalPages <= 1
          ? `Showing all ${listState.totalCount} entries`
          : `Showing ${from}–${to} of ${listState.totalCount}`;
    } else {
      paginationInfo.textContent = "";
    }
  }

  const totalPages = Math.ceil(listState.totalCount / PAGE_SIZE);
  const hasMultiplePages = totalPages > 1;
  if (backBtn) {
    backBtn.disabled = listState.currentPage <= 0;
    backBtn.classList.toggle("hidden", !hasMultiplePages);
  }
  if (loadMoreBtn) {
    loadMoreBtn.disabled = listState.currentPage >= totalPages - 1;
    loadMoreBtn.classList.toggle("hidden", !hasMultiplePages);
  }
}

function normCustomerName(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/** Escape % and _ for SQL ILIKE patterns (Postgres). */
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
  const settleNav = document.querySelector("#customer-view-root .settings-nav-item[data-section='settle']");
  if (settleNav) settleNav.classList.toggle("hidden", totalDue <= 0);

  const settleSection = document.getElementById("settle-section");
  if (settleSection) settleSection.hidden = totalDue <= 0;
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

function applyLifetimeSummary(row, asOfDate) {
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
      applyLifetimeSummary(null, asOfDate);
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
          "No credit customer matched this name. Open the customer from the Overdue list or Credit page, or check spelling.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    applyLifetimeSummary(summary, asOfDate);
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
