/* global supabaseClient, AppError, escapeHtml, normCustomerName, formatCurrency, formatDisplayDate, getLocalDateString, initPersistedDateInput, finishRecordFormSave, savePersistedDate, RECORD_DATE_KEYS, syncFuelSelectStyle */

(function () {
  const page = () => window.CreditPage;
  let ready = false;
  let customerSuggestions = [];
  let customerComboboxActiveIndex = -1;
  let customerComboboxMatches = [];
  let quickPaymentCustomerId = null;
  let quickPaymentNetBalance = 0;

function initRecordSalePanel() {
  initPersistedDateInput("quick-settle-date", RECORD_DATE_KEYS.creditQuickSettle);

  document.getElementById("credit-quick-payment-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleQuickPayment();
  });

  document.getElementById("quick-settle-fill-full")?.addEventListener("click", () => {
    const amountInput = document.getElementById("quick-settle-amount");
    if (!amountInput || quickPaymentNetBalance <= 0) return;
    amountInput.value = String(quickPaymentNetBalance);
    amountInput.focus();
    amountInput.select();
  });

  const focusRecordForm = () => {
    if ((location.hash || "").replace(/^#/, "") !== "record") return;
    window.setTimeout(() => document.getElementById("customer")?.focus(), 50);
  };
  focusRecordForm();
  window.addEventListener("hashchange", focusRecordForm);

  document.getElementById("customer")?.addEventListener("input", () => {
    syncQuickPaymentPanel(document.getElementById("customer")?.value || "");
  });
  document.getElementById("customer")?.addEventListener("change", () => {
    syncQuickPaymentPanel(document.getElementById("customer")?.value || "");
  });
}

function findCustomerSuggestionByName(name) {
  const key = normCustomerName(name);
  if (!key) return null;
  return customerSuggestions.find((item) => item.nameNorm === key) || null;
}

function syncQuickPaymentPanel(nameInput) {
  const panel = document.getElementById("credit-quick-payment");
  const customerEl = document.getElementById("credit-quick-payment-customer");
  const balanceEl = document.getElementById("credit-quick-payment-balance");
  const linkEl = document.getElementById("credit-quick-payment-link");
  const msgEl = document.getElementById("credit-quick-payment-msg");
  if (!panel) return;

  msgEl?.classList.add("hidden");
  const trimmed = (nameInput || "").trim();
  const suggestion = findCustomerSuggestionByName(trimmed);

  if (!suggestion || suggestion.netBalance <= 0) {
    panel.classList.add("hidden");
    panel.hidden = true;
    quickPaymentCustomerId = null;
    quickPaymentNetBalance = 0;
    return;
  }

  quickPaymentCustomerId = suggestion.primaryId;
  quickPaymentNetBalance = suggestion.netBalance;

  if (customerEl) customerEl.textContent = suggestion.name;
  if (balanceEl) balanceEl.textContent = formatCurrency(suggestion.netBalance);
  if (linkEl) {
    linkEl.href = `${page().customerDetailUrl(suggestion.name)}#settle`;
    linkEl.textContent = "Open customer page";
  }

  panel.classList.remove("hidden");
  panel.hidden = false;
}

async function handleQuickPayment() {
  const msg = document.getElementById("credit-quick-payment-msg");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("success", "error");
    msg.classList.add("hidden");
  }

  if (!quickPaymentCustomerId) {
    if (msg) {
      msg.textContent = "Select an existing customer with outstanding balance.";
      msg.classList.remove("hidden");
    }
    return;
  }

  const amount = Number(document.getElementById("quick-settle-amount")?.value || 0);
  const settlementDate =
    document.getElementById("quick-settle-date")?.value?.trim() || getLocalDateString();
  const paymentMode = document.getElementById("quick-settle-mode")?.value || "Cash";
  const todayStr = getLocalDateString();
  const submitBtn = document.querySelector("#credit-quick-payment-form button[type='submit']");

  if (!amount || amount <= 0) {
    if (msg) {
      msg.textContent = "Enter a valid amount.";
      msg.classList.remove("hidden");
    }
    return;
  }
  if (settlementDate > todayStr) {
    if (msg) {
      msg.textContent = "Settlement date cannot be in the future.";
      msg.classList.remove("hidden");
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  const { error } = await supabaseClient.rpc("record_credit_payment", {
    p_credit_customer_id: quickPaymentCustomerId,
    p_date: settlementDate,
    p_amount: amount,
    p_note: null,
    p_payment_mode: paymentMode,
  });

  if (submitBtn) submitBtn.disabled = false;

  if (error) {
    if (msg) {
      msg.textContent = AppError.getUserMessage(error);
      msg.classList.remove("hidden");
      msg.classList.add("error");
    }
    AppError.report(error, { context: "handleQuickPayment", customerId: quickPaymentCustomerId });
    page().invalidateCreditCaches();
    await loadCustomerNames();
    syncQuickPaymentPanel(document.getElementById("customer")?.value || "");
    return;
  }

  const amountInput = document.getElementById("quick-settle-amount");
  if (amountInput) amountInput.value = "";
  savePersistedDate(RECORD_DATE_KEYS.creditQuickSettle, settlementDate);
  await loadCustomerNames();
  page().invalidateAndRefreshCreditPortfolio();
  syncQuickPaymentPanel(document.getElementById("customer")?.value || "");

  if (msg) {
    msg.classList.remove("hidden");
    msg.classList.add("success");
    msg.textContent = "Payment recorded.";
  }
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
    const totalDue = groupRows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
    const totalPrepaid = groupRows.reduce((s, r) => s + Number(r.prepaid_balance || 0), 0);
    const netBalance = totalDue - totalPrepaid;
    const primary =
      sorted.find((r) => Number(r.amount_due) > 0) || sorted[0];
    return {
      name: sorted[0].customer_name.trim(),
      nameNorm: key,
      vehicleNo: contact.vehicleNo,
      mobile: contact.mobile,
      address: contact.address,
      netBalance: Math.max(0, netBalance),
      primaryId: primary?.id || null,
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
  syncQuickPaymentPanel(item.name);
  document.getElementById("amount")?.focus();
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
      .select("id, customer_name, vehicle_no, mobile, address, amount_due, prepaid_balance, created_at")
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
  const savedFuel = (form.querySelector("#fuel-type")?.value || "").trim();
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
      submitBtn.textContent = "Save sale";
    }
    AppError.handle(new Error("Customer and amount are required."), { target: errorEl });
    return;
  }

  const todayStr = typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10);
  if (transactionDate > todayStr) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save sale";
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
      submitBtn.textContent = "Save sale";
    }
    AppError.handle(error, { target: errorEl });
    return;
  }

  finishRecordFormSave(form, { credit_date: transactionDate }, {
    credit_date: RECORD_DATE_KEYS.creditTransaction,
  });
  setComboboxOpen(false);
  const fuelTypeSelect = form.querySelector("#fuel-type");
  if (fuelTypeSelect) fuelTypeSelect.value = savedFuel || "HSD";

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save sale";
  }
  successEl?.classList.remove("hidden");
  page().invalidateAndRefreshCreditPortfolio();
  loadCustomerNames().then(() => {
    syncQuickPaymentPanel(form.querySelector("#customer")?.value || "");
  });

  form.querySelector("#customer")?.focus();
}

  function init() {
    if (ready) return;
    const form = document.getElementById("credit-form");
    if (form) form.addEventListener("submit", (e) => handleCreditSubmit(e));
    const transactionDateInput = document.getElementById("credit-date");
    if (transactionDateInput) initPersistedDateInput(transactionDateInput, RECORD_DATE_KEYS.creditTransaction);
    initRecordSalePanel();
    initCustomerCombobox();
    void loadCustomerNames();
    ready = true;
  }

  window.CreditRecord = { init, isReady: () => ready };
})();
