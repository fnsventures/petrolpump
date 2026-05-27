/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppCache, AppError, showProgress, hideProgress, escapeHtml, PumpSettings, loadPumpSettings, readDateRangeFromControls, createDateRangeFilter, getMonthRange */

let productsCache = [];
let currentAuth = null;
let printAfterSave = false;

const PAGE_SIZE = 20;
let invoicesPagination = { offset: 0, hasMore: true, totalCount: 0, isLoading: false };

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "billing",
  });
  if (!auth) return;
  currentAuth = auth;
  applyRoleVisibility(auth.role);

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "create", validSections: ["create", "history"] });
  }

  await loadPumpSettings();
  applyStationLetterhead();

  const dateInput = document.getElementById("invoice-date");
  if (dateInput) dateInput.value = getLocalDateString();

  const partyInput = document.getElementById("party-name");
  const billing = PumpSettings.getCachedSync().billing || {};
  if (partyInput && !partyInput.value) partyInput.placeholder = billing.defaultPartyName || "Cash A/c";

  await loadProducts();
  addItemRow();
  initFormHandlers();
  initFilterHandlers();
  loadInvoices(true);
});

// ─── Products ────────────────────────────────────────────────────────────────

async function loadProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .eq("is_active", true)
    .order("name");

  if (error) {
    AppError.report(error, { context: "loadProducts" });
    return;
  }
  productsCache = data || [];
  populatePartyDatalist();
}

function applyStationLetterhead() {
  const s = PumpSettings.getCachedSync().station || {};
  const brandEl = document.getElementById("print-station-brand");
  if (brandEl) {
    const short = s.brandShort || "Bishnu Priya";
    const accent = s.brandAccent || "Fuels";
    brandEl.innerHTML = `${escapeHtml(short)} <span>${escapeHtml(accent)}</span>`;
  }
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el && val) el.textContent = val;
  };
  setText("print-station-tagline", s.tagline);
  setText("print-station-address", s.address);
  setText("print-station-email", s.email);
  setText("print-station-mobile", s.mobile);
  setText("print-station-gstin", s.gstin);
  setText("print-station-license", s.license);

  const signFor = document.getElementById("print-sign-for");
  if (signFor) {
    const legal = (s.legalName || "").trim();
    const short = (s.brandShort || "Bishnu Priya").trim();
    const accent = (s.brandAccent || "Fuels").trim();
    const name = (legal || `${short} ${accent}`).toUpperCase();
    signFor.textContent = `FOR ${name}`;
  }
}

/** Fix common fuel product typos on printed invoices. */
function normalizeInvoiceItemName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return raw;
  const key = raw.toLowerCase();
  const fixes = {
    disel: "Diesel",
    disal: "Diesel",
    deisel: "Diesel",
    diesal: "Diesel",
    pertol: "Petrol",
    petorl: "Petrol",
  };
  return fixes[key] || raw;
}

function runInvoicePrint(invoiceNumber) {
  const prevTitle = document.title;
  document.title = invoiceNumber ? String(invoiceNumber) : "Tax Invoice";
  const restore = () => {
    document.title = prevTitle;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
}

async function populatePartyDatalist() {
  const datalist = document.getElementById("party-list");
  if (!datalist) return;

  const { data } = await supabaseClient
    .from("invoices")
    .select("party_name")
    .order("created_at", { ascending: false })
    .limit(500);

  const uniqueNames = [...new Set((data || []).map((r) => r.party_name).filter(Boolean))].slice(0, 100);
  datalist.innerHTML = uniqueNames.map(n => `<option value="${escapeHtml(n)}">`).join("");
}

// ─── Line Items ──────────────────────────────────────────────────────────────

let itemCounter = 0;

function buildGstSelectOptions(selectedPct) {
  const slabs = AppConfig?.GST_SLABS || [];
  const hasSelection = selectedPct !== undefined && selectedPct !== null;
  return slabs
    .map((slab) => {
      const pct = slab.pct;
      let label;
      if (pct < 0) label = "Non-GST";
      else if (pct === 0) label = "NIL";
      else label = `${pct}%`;
      const isSelected = hasSelection ? Number(selectedPct) === pct : pct === 18;
      return `<option value="${pct}" ${isSelected ? "selected" : ""}>${label}</option>`;
    })
    .join("");
}

function addItemRow(productId) {
  const tbody = document.getElementById("items-body");
  if (!tbody) return;
  itemCounter++;

  const row = document.createElement("tr");
  row.dataset.itemIdx = itemCounter;

  const product = productId ? productsCache.find(p => p.id === productId) : null;

  const productOptions = productsCache.map(p =>
    `<option value="${p.id}" ${p.id === productId ? "selected" : ""}>${escapeHtml(p.name)}</option>`
  ).join("");

  row.innerHTML = `
    <td class="col-sl">${tbody.children.length + 1}</td>
    <td class="col-item">
      <select class="item-product-select" data-field="product_id">
        <option value="">— Custom —</option>
        ${productOptions}
      </select>
      <input type="text" class="item-name-input" data-field="item_name"
             value="${escapeHtml(product?.name || "")}"
             placeholder="Item name" required />
    </td>
    <td class="col-qty"><input type="number" data-field="quantity" step="0.001" min="0.001" value="1" class="input-sm" /></td>
    <td class="col-unit">
      <select data-field="unit">
        <option value="Pcs" ${product?.unit === "Pcs" ? "selected" : ""}>Pcs</option>
        <option value="Ltr" ${product?.unit === "Ltr" ? "selected" : ""}>Ltr</option>
        <option value="Kg" ${product?.unit === "Kg" ? "selected" : ""}>Kg</option>
        <option value="Box" ${product?.unit === "Box" ? "selected" : ""}>Box</option>
        <option value="Set" ${product?.unit === "Set" ? "selected" : ""}>Set</option>
        <option value="Nos" ${product?.unit === "Nos" ? "selected" : ""}>Nos</option>
      </select>
    </td>
    <td class="col-rate"><input type="number" data-field="rate" step="0.01" min="0" value="${product?.default_rate || 0}" class="input-sm" /></td>
    <td class="col-gst">
      <select data-field="gst_percent">
        ${buildGstSelectOptions(product?.gst_percent)}
      </select>
    </td>
    <td class="col-amount"><span class="item-amount">₹0.00</span></td>
    <td class="col-action"><button type="button" class="link danger remove-item-btn" title="Remove">&times;</button></td>
  `;

  tbody.appendChild(row);

  const productSelect = row.querySelector(".item-product-select");
  productSelect.addEventListener("change", () => onProductSelected(row, productSelect.value));

  const debouncedRecalc = debounce(() => recalcRow(row), 120);
  row.querySelectorAll("[data-field='quantity'], [data-field='rate'], [data-field='gst_percent']").forEach((input) => {
    input.addEventListener("input", debouncedRecalc);
  });

  row.querySelector(".remove-item-btn").addEventListener("click", () => {
    row.remove();
    renumberItems();
    recalcTotals();
  });

  recalcRow(row);
}

function onProductSelected(row, productId) {
  const product = productsCache.find(p => p.id === productId);
  const nameInput = row.querySelector("[data-field='item_name']");
  const rateInput = row.querySelector("[data-field='rate']");
  const unitSelect = row.querySelector("[data-field='unit']");
  const gstSelect = row.querySelector("[data-field='gst_percent']");

  if (product) {
    nameInput.value = normalizeInvoiceItemName(product.name);
    rateInput.value = product.default_rate;
    unitSelect.value = product.unit;
    gstSelect.value = product.gst_percent;
    nameInput.readOnly = true;
  } else {
    nameInput.value = "";
    nameInput.readOnly = false;
  }
  recalcRow(row);
}

function recalcRow(row) {
  const qty = parseFloat(row.querySelector("[data-field='quantity']")?.value) || 0;
  const rate = parseFloat(row.querySelector("[data-field='rate']")?.value) || 0;
  const amount = Math.round(qty * rate * 100) / 100;
  row.querySelector(".item-amount").textContent = formatCurrency(amount);
  recalcTotals();
}

function renumberItems() {
  const rows = document.querySelectorAll("#items-body tr");
  rows.forEach((row, i) => {
    row.querySelector(".col-sl").textContent = i + 1;
  });
}

function getItemsData() {
  const rows = document.querySelectorAll("#items-body tr");
  return Array.from(rows).map((row, i) => {
    const qty = parseFloat(row.querySelector("[data-field='quantity']")?.value) || 1;
    const rate = parseFloat(row.querySelector("[data-field='rate']")?.value) || 0;
    const gst = parseFloat(row.querySelector("[data-field='gst_percent']")?.value) ?? 18;
    return {
      sl_no: i + 1,
      product_id: row.querySelector("[data-field='product_id']")?.value || null,
      item_name: normalizeInvoiceItemName(row.querySelector("[data-field='item_name']")?.value || "Item"),
      quantity: qty,
      unit: row.querySelector("[data-field='unit']")?.value || "Pcs",
      rate: rate,
      gst_percent: gst,
      amount: Math.round(qty * rate * 100) / 100,
    };
  });
}

function recalcTotals() {
  const items = getItemsData();
  let subtotal = 0, cgst = 0, sgst = 0, nonGst = 0, nilRate = 0;

  items.forEach(item => {
    subtotal += item.amount;
    if (item.gst_percent > 0) {
      const taxable = item.amount / (1 + item.gst_percent / 100);
      const gstAmt = item.amount - taxable;
      const halfGst = Math.round(gstAmt / 2 * 100) / 100;
      cgst += halfGst;
      sgst += gstAmt - halfGst;
    } else if (item.gst_percent === 0) {
      nilRate += item.amount;
    } else {
      nonGst += item.amount;
    }
  });

  const discount = parseFloat(document.getElementById("discount")?.value) || 0;
  const gross = subtotal - discount;
  const roundOff = Math.round(gross) - gross;
  const total = Math.round(gross);

  document.getElementById("subtotal-display").textContent = formatCurrency(subtotal);
  document.getElementById("summary-subtotal").textContent = formatCurrency(subtotal);
  document.getElementById("summary-discount").textContent = formatCurrency(discount);
  document.getElementById("summary-roundoff").textContent = (roundOff >= 0 ? "+" : "") + roundOff.toFixed(2);
  document.getElementById("summary-total").textContent = formatCurrency(total);
  document.getElementById("summary-cgst").textContent = formatCurrency(cgst);
  document.getElementById("summary-sgst").textContent = formatCurrency(sgst);

  const nonGstRow = document.getElementById("row-non-gst");
  const nilRateRow = document.getElementById("row-nil-rate");
  if (nonGstRow) nonGstRow.style.display = nonGst > 0 ? "" : "none";
  if (nilRateRow) nilRateRow.style.display = nilRate > 0 ? "" : "none";
  document.getElementById("summary-nongst").textContent = formatCurrency(nonGst);
  document.getElementById("summary-nilrate").textContent = formatCurrency(nilRate);
}

// ─── Form Handlers ───────────────────────────────────────────────────────────

function initFormHandlers() {
  const form = document.getElementById("invoice-form");
  const addBtn = document.getElementById("add-item-btn");
  const discountInput = document.getElementById("discount");
  const saveOnlyBtn = document.getElementById("save-only-btn");

  addBtn?.addEventListener("click", () => addItemRow());

  discountInput?.addEventListener("input", debounce(() => recalcTotals(), 120));

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    printAfterSave = true;
    await saveInvoice();
  });

  saveOnlyBtn?.addEventListener("click", async () => {
    printAfterSave = false;
    await saveInvoice();
  });
}

async function saveInvoice() {
  const successEl = document.getElementById("invoice-success");
  const errorEl = document.getElementById("invoice-error");
  const saveBtn = document.getElementById("save-invoice-btn");
  const saveOnlyBtn = document.getElementById("save-only-btn");
  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  if (saveOnlyBtn) saveOnlyBtn.disabled = true;

  const items = getItemsData();
  if (!items.length) {
    if (errorEl) { errorEl.textContent = "Add at least one item."; errorEl.classList.remove("hidden"); }
    resetSaveButtons();
    return;
  }

  const invalidItem = items.find(it => !it.item_name || it.rate <= 0);
  if (invalidItem) {
    if (errorEl) { errorEl.textContent = "Each item needs a name and a rate > 0."; errorEl.classList.remove("hidden"); }
    resetSaveButtons();
    return;
  }

  const invoiceDate = document.getElementById("invoice-date")?.value;
  const partyName = document.getElementById("party-name")?.value?.trim() || "Cash A/c";

  if (!invoiceDate) {
    if (errorEl) { errorEl.textContent = "Date is required."; errorEl.classList.remove("hidden"); }
    resetSaveButtons();
    return;
  }

  showProgress();

  try {
    const { data, error } = await supabaseClient.rpc("save_invoice", {
      p_invoice_date: invoiceDate,
      p_invoice_type: document.getElementById("invoice-type")?.value || "CASH",
      p_party_name: partyName,
      p_party_address: document.getElementById("party-address")?.value?.trim() || null,
      p_party_gstin: document.getElementById("party-gstin")?.value?.trim() || null,
      p_vehicle_no: document.getElementById("vehicle-no")?.value?.trim() || null,
      p_mobile: document.getElementById("mobile")?.value?.trim() || null,
      p_km_reading: document.getElementById("km-reading")?.value?.trim() || null,
      p_discount: parseFloat(document.getElementById("discount")?.value) || 0,
      p_notes: document.getElementById("notes")?.value?.trim() || null,
      p_items: items,
    });

    if (error) {
      AppError.handle(error, { target: errorEl });
      resetSaveButtons();
      hideProgress();
      return;
    }

    if (successEl) {
      successEl.textContent = `Invoice ${data.invoice_number} saved. Total: ${formatCurrency(data.total_amount)}`;
      successEl.classList.remove("hidden");
    }

    if (printAfterSave) {
      await showPrintInvoice(data.id);
    }

    resetForm();
    loadInvoices(true);

    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.invalidateByType("dashboard_data");
    }
  } catch (err) {
    AppError.handle(err, { target: errorEl });
  } finally {
    resetSaveButtons();
    hideProgress();
  }
}

function resetSaveButtons() {
  const saveBtn = document.getElementById("save-invoice-btn");
  const saveOnlyBtn = document.getElementById("save-only-btn");
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save & Print Invoice"; }
  if (saveOnlyBtn) saveOnlyBtn.disabled = false;
}

function resetForm() {
  const form = document.getElementById("invoice-form");
  form?.reset();
  const dateInput = document.getElementById("invoice-date");
  if (dateInput) dateInput.value = getLocalDateString();
  const tbody = document.getElementById("items-body");
  if (tbody) tbody.innerHTML = "";
  itemCounter = 0;
  addItemRow();
  recalcTotals();
}

// ─── Print Invoice ───────────────────────────────────────────────────────────

async function showPrintInvoice(invoiceId) {
  const { data: invoice, error } = await supabaseClient
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();

  if (error || !invoice) {
    alert("Could not load invoice for printing.");
    return;
  }

  const { data: items } = await supabaseClient
    .from("invoice_items")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("sl_no");

  populatePrintInvoice(invoice, items || []);
  runInvoicePrint(invoice.invoice_number);
}

function printField(value) {
  const v = value != null ? String(value).trim() : "";
  return v || "\u00a0";
}

function populatePrintInvoice(invoice, items) {
  document.getElementById("print-invoice-type").textContent =
    invoice.invoice_type === "CREDIT" ? "Credit Invoice" : "Cash Memo";

  document.getElementById("print-party-name").textContent = printField(invoice.party_name);
  document.getElementById("print-party-address").textContent = printField(invoice.party_address);
  document.getElementById("print-party-gstin").textContent = printField(invoice.party_gstin);
  document.getElementById("print-vehicle-no").textContent = printField(invoice.vehicle_no);
  document.getElementById("print-invoice-number").textContent = invoice.invoice_number;
  document.getElementById("print-invoice-date").textContent = formatDate(invoice.invoice_date);
  document.getElementById("print-mobile").textContent = printField(invoice.mobile);
  document.getElementById("print-km").textContent = printField(invoice.km_reading);

  const tbody = document.getElementById("print-items-body");
  let totalQty = 0;

  tbody.innerHTML = items.map(item => {
    totalQty += Number(item.quantity);
    return `
      <tr>
        <td>${item.sl_no}</td>
        <td>${escapeHtml(normalizeInvoiceItemName(item.item_name))}</td>
        <td>${item.quantity}</td>
        <td>${item.unit}</td>
        <td>${Number(item.rate).toFixed(2)}</td>
        <td>${formatGstLabel(item.gst_percent)}</td>
        <td>${Number(item.amount).toFixed(2)}</td>
      </tr>
    `;
  }).join("");

  document.getElementById("print-total-qty").textContent = totalQty;

  // Tax breakdown by GST slab
  const gstSlabs = {};
  let totalNonGst = 0, totalNilRate = 0;

  items.forEach(item => {
    const pct = Number(item.gst_percent);
    const amt = Number(item.amount);
    if (pct < 0) {
      totalNonGst += amt;
    } else if (pct === 0) {
      totalNilRate += amt;
    } else {
      if (!gstSlabs[pct]) gstSlabs[pct] = { goods: 0, tax: 0 };
      const taxable = amt / (1 + pct / 100);
      gstSlabs[pct].goods += taxable;
      gstSlabs[pct].tax += amt - taxable;
    }
  });

  const nongstText = totalNonGst > 0 ? totalNonGst.toFixed(2) : "—";
  const nilText = totalNilRate > 0 ? totalNilRate.toFixed(2) : "—";
  document.getElementById("print-nongst-goods").textContent = nongstText;
  document.getElementById("print-nil-goods").textContent = nilText;
  togglePrintTaxRow("print-nongst-row", totalNonGst > 0);
  togglePrintTaxRow("print-nil-row", totalNilRate > 0);

  (AppConfig?.GST_SLABS || [])
    .map((s) => s.pct)
    .filter((pct) => pct > 0)
    .forEach((pct) => {
    const goodsEl = document.getElementById(`print-gst${pct}-goods`);
    const taxEl = document.getElementById(`print-gst${pct}-tax`);
    if (gstSlabs[pct]) {
      if (goodsEl) goodsEl.textContent = gstSlabs[pct].goods.toFixed(2);
      if (taxEl) taxEl.textContent = gstSlabs[pct].tax.toFixed(2);
      togglePrintTaxRow(`print-gst${pct}-row`, true);
    } else {
      togglePrintTaxRow(`print-gst${pct}-row`, false);
    }
  });

  document.getElementById("print-subtotal").textContent = Number(invoice.subtotal).toFixed(2);
  const discount = Number(invoice.discount) || 0;
  document.getElementById("print-discount").textContent = discount.toFixed(2);
  togglePrintTaxRow("print-discount-row", discount > 0);
  document.getElementById("print-gross").textContent = Number(invoice.total_amount).toFixed(2);
  const roundOff = Number(invoice.round_off) || 0;
  document.getElementById("print-roundoff").textContent = roundOff.toFixed(2);
  togglePrintTaxRow("print-roundoff-row", Math.abs(roundOff) >= 0.01);
}

function togglePrintTaxRow(rowId, show) {
  const row = document.getElementById(rowId);
  if (row) row.classList.toggle("invoice-tax-hidden", !show);
}

// ─── Invoice History ─────────────────────────────────────────────────────────

function getInvoiceDateRange() {
  const range = readDateRangeFromControls(
    document.getElementById("invoice-range"),
    document.getElementById("invoice-start"),
    document.getElementById("invoice-end")
  );
  if (range) return { start: range.start, end: range.end };
  const today = new Date();
  return getMonthRange(today.getFullYear(), today.getMonth());
}

function initFilterHandlers() {
  createDateRangeFilter({
    storageKey: "billing_invoices",
    ranges: ["today", "this-week", "this-month", "custom"],
    defaultRange: "this-month",
    rangeSelect: "invoice-range",
    startInput: "invoice-start",
    endInput: "invoice-end",
    customRange: "invoice-custom-range",
    applyBtn: "invoice-apply-filter",
    trigger: "apply",
    persist: false,
    runOnInit: false,
    onApply: () => loadInvoices(true),
  });
}

async function loadInvoices(reset = false) {
  const tbody = document.getElementById("invoices-table-body");
  const loadMoreBtn = document.getElementById("invoices-load-more");
  const paginationInfo = document.getElementById("invoices-pagination-info");
  if (!tbody) return;
  if (invoicesPagination.isLoading) return;
  invoicesPagination.isLoading = true;

  const { start, end } = getInvoiceDateRange();

  if (reset) {
    invoicesPagination.offset = 0;
    invoicesPagination.hasMore = true;
    invoicesPagination.totalCount = 0;
    tbody.innerHTML = "<tr><td colspan='7' class='muted'>Loading…</td></tr>";
  }

  if (loadMoreBtn) { loadMoreBtn.disabled = true; loadMoreBtn.textContent = "Loading…"; }

  try {
    if (reset) {
      const { count } = await supabaseClient
        .from("invoices")
        .select("*", { count: "exact", head: true })
        .gte("invoice_date", start)
        .lte("invoice_date", end);
      invoicesPagination.totalCount = count || 0;
    }

    const { data, error } = await supabaseClient
      .from("invoices")
      .select("id, invoice_number, invoice_date, party_name, vehicle_no, total_amount, invoice_type")
      .gte("invoice_date", start)
      .lte("invoice_date", end)
      .order("created_at", { ascending: false })
      .range(invoicesPagination.offset, invoicesPagination.offset + PAGE_SIZE - 1);

    if (error) {
      if (reset) tbody.innerHTML = `<tr><td colspan='7' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      AppError.report(error, { context: "loadInvoices" });
      invoicesPagination.isLoading = false;
      updateInvoicesPaginationUI();
      return;
    }

    const fetchedCount = data?.length || 0;
    invoicesPagination.offset += fetchedCount;
    invoicesPagination.hasMore = fetchedCount === PAGE_SIZE;

    if (reset && !fetchedCount) {
      tbody.innerHTML = "<tr><td colspan='7' class='muted'>No invoices for this period.</td></tr>";
      invoicesPagination.isLoading = false;
      updateInvoicesPaginationUI();
      return;
    }

    if (reset) tbody.innerHTML = "";

    // Load item counts
    const invoiceIds = data.map(d => d.id);
    const { data: itemCounts } = await supabaseClient
      .from("invoice_items")
      .select("invoice_id")
      .in("invoice_id", invoiceIds);

    const countMap = {};
    (itemCounts || []).forEach(ic => {
      countMap[ic.invoice_id] = (countMap[ic.invoice_id] || 0) + 1;
    });

    data.forEach(inv => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(inv.invoice_number)}</strong></td>
        <td>${formatDate(inv.invoice_date)}</td>
        <td>${escapeHtml(inv.party_name)}</td>
        <td>${escapeHtml(inv.vehicle_no || "—")}</td>
        <td>${countMap[inv.id] || 0}</td>
        <td>${formatCurrency(inv.total_amount)}</td>
        <td>
          <button class="link" data-print-invoice="${inv.id}" title="Print">Print</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-print-invoice]").forEach(btn => {
      btn.addEventListener("click", () => showPrintInvoice(btn.dataset.printInvoice));
    });

  } catch (err) {
    if (reset) tbody.innerHTML = `<tr><td colspan='7' class='error'>${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
    AppError.report(err, { context: "loadInvoices" });
  } finally {
    invoicesPagination.isLoading = false;
    updateInvoicesPaginationUI();
  }
}

function updateInvoicesPaginationUI() {
  const loadMoreBtn = document.getElementById("invoices-load-more");
  const paginationInfo = document.getElementById("invoices-pagination-info");

  if (paginationInfo) {
    if (invoicesPagination.totalCount > 0) {
      const showing = Math.min(invoicesPagination.offset, invoicesPagination.totalCount);
      paginationInfo.textContent = `Showing ${showing} of ${invoicesPagination.totalCount} invoices`;
    } else {
      paginationInfo.textContent = "";
    }
  }

  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
    loadMoreBtn.classList.toggle("hidden", !invoicesPagination.hasMore || invoicesPagination.offset === 0);
    loadMoreBtn.onclick = () => loadInvoices(false);
  }
}
