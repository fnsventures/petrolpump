/* global AppCache, AppError, AppDialog, escapeHtml, normCustomerName, formatCurrency, formatRecordedBalance, formatMoneyInput, formatDisplayDate, getLocalDateString, initPersistedDateInput, finishRecordFormSave, savePersistedDate, RECORD_DATE_KEYS, syncFuelSelectStyle, formRequestId, clearFormRequestId, pickCreditCustomerContact, confirmCreditOverpayment, bindUnsavedDraft, captureDomDraftFields, omitDraftFields, CREDIT_CUSTOMER_SUGGEST_LIMIT, debounce, searchCreditCustomers */

(function () {
  const page = () => window.CreditPage;
  let ready = false;
  let customerSuggestions = [];
  let customerComboboxActiveIndex = -1;
  let customerComboboxMatches = [];
  let quickPaymentCustomerId = null;
  let quickPaymentCustomerIds = [];
  let quickPaymentNetBalance = 0;
  let quickPaymentSignedBalance = 0;
  /** Sale form and quick payment share one draft: both sit in the Record panel. */
  let recordDraft = null;

function initRecordSalePanel() {
  initPersistedDateInput("quick-settle-date", RECORD_DATE_KEYS.creditQuickSettle);

  document.getElementById("credit-quick-payment-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleQuickPayment();
  });

  document.getElementById("quick-settle-fill-full")?.addEventListener("click", () => {
    const amountInput = document.getElementById("quick-settle-amount");
    if (!amountInput || quickPaymentNetBalance <= 0) return;
    amountInput.value = formatMoneyInput(quickPaymentNetBalance);
    amountInput.dispatchEvent(new Event("input", { bubbles: true }));
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
    quickPaymentCustomerIds = [];
    quickPaymentNetBalance = 0;
    quickPaymentSignedBalance = 0;
    return;
  }

  quickPaymentCustomerId = suggestion.primaryId;
  quickPaymentCustomerIds = (suggestion.customerIds || []).filter(Boolean);
  quickPaymentNetBalance = suggestion.netBalance;
  quickPaymentSignedBalance = Number.isFinite(suggestion.signedBalance)
    ? suggestion.signedBalance
    : suggestion.netBalance;

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

  const settleIds = quickPaymentCustomerIds.length
    ? [...quickPaymentCustomerIds]
    : quickPaymentCustomerId
      ? [quickPaymentCustomerId]
      : [];
  if (settleIds.length === 0) {
    AppError.showSaveError("Select an existing customer with outstanding balance.", {
      target: msg,
      field: document.getElementById("customer"),
    });
    return;
  }

  const amount = Number(document.getElementById("quick-settle-amount")?.value || 0);
  const settlementDate =
    document.getElementById("quick-settle-date")?.value?.trim() || getLocalDateString();
  const paymentMode = document.getElementById("quick-settle-mode")?.value || "Cash";
  const sameDaySettlement = Boolean(document.getElementById("quick-settle-same-day")?.checked);
  const todayStr = getLocalDateString();
  const submitBtn = document.querySelector("#credit-quick-payment-form button[type='submit']");

  if (!amount || amount <= 0) {
    AppError.showSaveError("Enter a valid amount.", {
      target: msg,
      field: document.getElementById("quick-settle-amount"),
    });
    return;
  }
  if (settlementDate > todayStr) {
    AppError.showSaveError("Settlement date cannot be in the future.", {
      target: msg,
      field: document.getElementById("quick-settle-date"),
    });
    return;
  }

  if (!(await confirmCreditOverpayment(amount, quickPaymentNetBalance))) return;

  if (amount >= 10000 && Math.round(amount * 100) <= Math.round(Math.max(0, quickPaymentNetBalance) * 100)) {
    const ok = await AppDialog.confirm(`Record a payment of ${formatCurrency(amount)}?`, {
      title: "Confirm payment",
      confirmLabel: "Record payment",
    });
    if (!ok) return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
  }

  const mutationKey = `credit_payment:${settleIds.slice().sort().join(",")}:${amount}:${settlementDate}`;

  const restoreSubmit = () => {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Record payment";
    }
  };

  try {
    const runMutation =
      typeof AppCache !== "undefined" && AppCache?.runDedupedMutation
        ? (key, fn) => AppCache.runDedupedMutation(key, fn)
        : (_key, fn) => fn();

    const quickPaymentForm = document.getElementById("credit-quick-payment-form");
    const primaryId = quickPaymentCustomerId || settleIds[0];
    const paymentParams =
      settleIds.length === 1
        ? {
            p_credit_customer_id: settleIds[0],
            p_date: settlementDate,
            p_amount: amount,
            p_note: null,
            p_payment_mode: paymentMode,
            p_same_day_settlement: sameDaySettlement,
          }
        : {
            p_customer_ids: settleIds,
            p_primary_customer_id: primaryId,
            p_date: settlementDate,
            p_total_amount: amount,
            p_note: null,
            p_payment_mode: paymentMode,
            p_same_day_settlement: sameDaySettlement,
          };
    const rpcName = settleIds.length === 1 ? "record_credit_payment" : "batch_record_credit_settlements";
    paymentParams.p_request_id = formRequestId(quickPaymentForm, paymentParams);

    await runMutation(mutationKey, async () => {
      const { error } = await window.supabaseClient.rpc(rpcName, paymentParams);
      if (error) throw error;
    });
    clearFormRequestId(quickPaymentForm);

    restoreSubmit();

    const person = document.getElementById("credit-quick-payment-customer")?.textContent?.trim() || "customer";
    const recorded = formatRecordedBalance({
      amount,
      person,
      remaining: quickPaymentSignedBalance - amount,
      direction: "from",
    });

    const amountInput = document.getElementById("quick-settle-amount");
    if (amountInput) amountInput.value = "";
    const sameDayInput = document.getElementById("quick-settle-same-day");
    if (sameDayInput) sameDayInput.checked = false;
    savePersistedDate(RECORD_DATE_KEYS.creditQuickSettle, settlementDate);
    recordDraft?.markClean();
    await loadCustomerNames();
    page().invalidateAndRefreshCreditPortfolio();
    syncQuickPaymentPanel(document.getElementById("customer")?.value || "");

    if (msg) {
      msg.classList.remove("hidden", "error");
      msg.classList.add("success");
      msg.textContent = recorded;
    }
    AppError.showToast(recorded, "success");
  } catch (err) {
    restoreSubmit();
    if (err?.name === "DuplicateMutationError") return;

    const message = AppError.getUserMessage(err);
    const onField = AppError.showSaveError(message, {
      target: msg,
      form: document.getElementById("credit-quick-payment-form"),
    });
    if (msg) {
      msg.classList.remove("success");
      msg.classList.add("error");
    }
    AppError.report(err, { context: "handleQuickPayment", customerId: quickPaymentCustomerId });
    page().invalidateCreditCaches();
    await loadCustomerNames();
    syncQuickPaymentPanel(document.getElementById("customer")?.value || "");
    if (!onField && msg && message) {
      msg.textContent = message;
      msg.classList.remove("hidden", "success");
      msg.classList.add("error");
    }
  }
}

function pickContactFromRows(rows) {
  return pickCreditCustomerContact(rows);
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
    const signedBalance = totalDue - totalPrepaid;
    const primary =
      sorted.find((r) => Number(r.amount_due) > 0) || sorted[0];
    return {
      name: sorted[0].customer_name.trim(),
      nameNorm: key,
      vehicleNo: contact.vehicleNo,
      mobile: contact.mobile,
      address: contact.address,
      netBalance: Math.max(0, signedBalance),
      signedBalance,
      creditLimit: groupRows.map((row) => Number(row.credit_limit)).find((value) => Number.isFinite(value) && value > 0) || null,
      primaryId: primary?.id || null,
      customerIds: groupRows.map((row) => row.id).filter(Boolean),
      mobiles: [
        ...new Set(groupRows.map((row) => String(row.mobile ?? "").trim()).filter(Boolean)),
      ],
    };
  });

  suggestions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return suggestions;
}

let customerSearchSeq = 0;

function mobileMatchesNeedle(mobile, needle) {
  const text = String(mobile || "").trim().toLowerCase();
  if (!text || !needle) return false;
  if (text.includes(needle)) return true;
  const digits = needle.replace(/\D/g, "");
  return Boolean(digits) && text.replace(/\D/g, "").includes(digits);
}

function suggestionMobiles(item) {
  return item.mobiles?.length ? item.mobiles : [item.mobile];
}

function suggestionMatchesQuery(item, needle) {
  if (!needle) return true;
  if (item.nameNorm.includes(needle)) return true;
  if (String(item.vehicleNo || "").trim().toLowerCase().includes(needle)) return true;
  return suggestionMobiles(item).some((mobile) => mobileMatchesNeedle(mobile, needle));
}

const CREDIT_LARGE_AMOUNT = 10000;

function withNewCustomerOption(matches, query) {
  const trimmed = String(query || "").trim();
  const needle = normCustomerName(trimmed);
  if (!needle) return matches;
  if (matches.some((item) => item.nameNorm === needle)) return matches;
  return matches.concat([
    {
      name: trimmed,
      nameNorm: needle,
      isNew: true,
      vehicleNo: "",
      mobile: "",
      mobiles: [],
      netBalance: 0,
      customerIds: [],
      primaryId: null,
    },
  ]);
}

function matchingSuggestions(query) {
  const needle = normCustomerName(query);
  if (!needle) return customerSuggestions.slice(0, CREDIT_CUSTOMER_SUGGEST_LIMIT);
  return customerSuggestions.filter((item) => suggestionMatchesQuery(item, needle)).slice(0, CREDIT_CUSTOMER_SUGGEST_LIMIT);
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

  const matches = withNewCustomerOption(matchingSuggestions(query), query);
  customerComboboxActiveIndex = -1;
  customerComboboxMatches = matches;

  if (matches.length === 0) {
    list.innerHTML = `<li class="combobox-empty" role="presentation">No matching customers</li>`;
    setComboboxOpen(Boolean(query.trim()));
    return;
  }

  const needle = normCustomerName(query);
  list.innerHTML = matches
    .map((item, index) => {
      const label = item.isNew ? `New customer “${item.name}”` : item.name;
      const nameHit = item.isNew || !needle || item.nameNorm.includes(needle);
      const mobile = nameHit
        ? ""
        : suggestionMobiles(item).find((value) => mobileMatchesNeedle(value, needle)) || "";
      const mobileHtml = mobile ? ` <span class="muted">${escapeHtml(mobile)}</span>` : "";
      const vehicleHtml =
        !item.isNew && needle && String(item.vehicleNo || "").toLowerCase().includes(needle) && !item.nameNorm.includes(needle)
          ? ` <span class="muted">${escapeHtml(item.vehicleNo)}</span>`
          : "";
      return `<li class="combobox-option" role="option" data-index="${index}" data-name="${escapeHtml(item.name)}">${escapeHtml(label)}${mobileHtml}${vehicleHtml}</li>`;
    })
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

const CREDIT_FUEL_MEMORY_KEY = "bpf.credit.fuelByCustomer";

function readFuelMemory() {
  try {
    const raw = JSON.parse(localStorage.getItem(CREDIT_FUEL_MEMORY_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch (_) {
    return {};
  }
}

function fuelMemoryKeys(name, id) {
  const keys = [];
  if (id) keys.push(`id:${id}`);
  const norm = typeof normCustomerName === "function" ? normCustomerName(name) : String(name || "").trim().toLowerCase();
  if (norm) keys.push(`name:${norm}`);
  return keys;
}

function rememberedFuel(name, id) {
  const map = readFuelMemory();
  for (const key of fuelMemoryKeys(name, id)) {
    if (map[key] === "MS" || map[key] === "HSD") return map[key];
  }
  return "";
}

function rememberCustomerFuel(name, id, fuel) {
  if (fuel !== "MS" && fuel !== "HSD") return;
  const keys = fuelMemoryKeys(name, id);
  if (!keys.length) return;
  const map = readFuelMemory();
  keys.forEach((key) => {
    map[key] = fuel;
  });
  try {
    localStorage.setItem(CREDIT_FUEL_MEMORY_KEY, JSON.stringify(map));
  } catch (_) {
    /* private mode */
  }
}

function applyRememberedFuel(name, id) {
  const select = document.getElementById("fuel-type");
  if (!select) return;
  const fuel = rememberedFuel(name, id);
  select.value = fuel === "MS" || fuel === "HSD" ? fuel : "HSD";
  if (typeof syncFuelSelectStyle === "function") syncFuelSelectStyle(select);
}

function selectCustomerSuggestion(item) {
  if (!item) return;
  const input = document.getElementById("customer");
  const vehicleInput = document.getElementById("vehicle");
  const mobileInput = document.getElementById("credit-customer-mobile");
  const addressInput = document.getElementById("credit-customer-address");

  if (input) input.value = item.name;
  if (!item.isNew) {
    if (vehicleInput) vehicleInput.value = item.vehicleNo || "";
    if (mobileInput) mobileInput.value = item.mobile || "";
    if (addressInput) addressInput.value = item.address || "";
  }

  setComboboxOpen(false);
  applyRememberedFuel(item.name, item.primaryId);
  syncQuickPaymentPanel(item.name);
  document.getElementById("amount")?.focus();
}

function initCustomerCombobox() {
  const input = document.getElementById("customer");
  const list = document.getElementById("customer-suggestions");
  const combobox = document.getElementById("customer-combobox");
  if (!input || !list) return;

  const onInput = debounce(() => {
    void loadCustomerNames(input.value);
  }, 180);

  input.addEventListener("input", onInput);

  input.addEventListener("focus", () => {
    void loadCustomerNames(input.value);
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

async function loadCustomerNames(query) {
  const input = document.getElementById("customer");
  const q = query != null ? query : input?.value || "";
  const seq = ++customerSearchSeq;
  try {
    const rows = await searchCreditCustomers(q);
    if (seq !== customerSearchSeq) return;
    customerSuggestions = buildCustomerSuggestions(rows);
    if (input && (document.activeElement === input || query == null)) {
      renderCustomerSuggestions(input.value);
    }
    if (input) syncQuickPaymentPanel(input.value || "");
  } catch (e) {
    if (seq !== customerSearchSeq) return;
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
  const transactionDate = formData.get("credit_date")?.trim() || getLocalDateString();
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
    AppError.showSaveError("Customer and amount are required.", {
      target: errorEl,
      field: !customerNameInput ? form.querySelector("#customer") : form.querySelector("#amount"),
    });
    return;
  }

  const todayStr = getLocalDateString();
  if (transactionDate > todayStr) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save sale";
    }
    AppError.showSaveError("Credit date cannot be in the future.", {
      target: errorEl,
      field: form.querySelector("#credit-date"),
    });
    return;
  }

  const existing = findCustomerSuggestionByName(customerNameInput);
  const overLimit =
    existing?.creditLimit && existing.netBalance + amount > existing.creditLimit;
  let confirmText = "";
  let confirmTitle = "Confirm sale";
  if (!existing) {
    confirmTitle = "New customer";
    confirmText = `Create a new customer “${customerNameInput}” and record ${formatCurrency(amount)}?`;
  } else if (overLimit) {
    confirmTitle = "Over credit limit";
    confirmText = `${customerNameInput} has a credit limit of ${formatCurrency(existing.creditLimit)}. This sale goes over it. Save ${formatCurrency(amount)} anyway?`;
  } else if (amount >= CREDIT_LARGE_AMOUNT) {
    confirmText = `Record ${formatCurrency(amount)} for ${customerNameInput}?`;
  }
  if (confirmText) {
    const ok = await AppDialog.confirm(confirmText, { title: confirmTitle, confirmLabel: "Save sale" });
    if (!ok) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save sale";
      }
      return;
    }
  }

  const mutationKey = `credit_entry:${customerNameInput}:${amount}:${transactionDate}`;

  const restoreSubmit = () => {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save sale";
    }
  };

  try {
    const runMutation =
      typeof AppCache !== "undefined" && AppCache?.runDedupedMutation
        ? (key, fn) => AppCache.runDedupedMutation(key, fn)
        : (_key, fn) => fn();

    const entryParams = {
      p_customer_name: customerNameInput,
      p_transaction_date: transactionDate,
      p_amount: amount,
      p_vehicle_no: vehicleNo,
      p_fuel_type: fuelType || undefined,
      p_quantity: quantity ?? undefined,
      p_notes: notes,
      p_mobile: mobile,
      p_address: address,
    };
    entryParams.p_request_id = formRequestId(form, entryParams);

    await runMutation(mutationKey, async () => {
      const { error } = await window.supabaseClient.rpc("add_credit_entry", entryParams);
      if (error) throw error;
    });
    clearFormRequestId(form);

    restoreSubmit();

    rememberCustomerFuel(customerNameInput, existing?.primaryId, savedFuel || fuelType);
    finishRecordFormSave(form, { credit_date: transactionDate }, {
      credit_date: RECORD_DATE_KEYS.creditTransaction,
    });
    setComboboxOpen(false);
    const fuelTypeSelect = form.querySelector("#fuel-type");
    if (fuelTypeSelect) {
      fuelTypeSelect.value = savedFuel || "HSD";
      if (typeof syncFuelSelectStyle === "function") syncFuelSelectStyle(fuelTypeSelect);
    }
    recordDraft?.markClean();

    const recorded = formatRecordedBalance({
      amount,
      person: customerNameInput,
      remaining: (existing?.signedBalance || 0) + amount,
      direction: "for",
    });
    if (successEl) {
      successEl.textContent = recorded;
      successEl.classList.remove("hidden");
    }
    page().invalidateAndRefreshCreditPortfolio();
    loadCustomerNames().then(() => {
      syncQuickPaymentPanel(form.querySelector("#customer")?.value || "");
    });

    form.querySelector("#customer")?.focus();
    AppError.showToast(recorded, "success");
  } catch (err) {
    restoreSubmit();
    if (err?.name === "DuplicateMutationError") return;

    AppError.handle(err, { target: errorEl, form });
  }
}

  function init() {
    if (ready) return;
    const form = document.getElementById("credit-form");
    if (form) form.addEventListener("submit", (e) => handleCreditSubmit(e));
    const fuelTypeSelect = document.getElementById("fuel-type");
    fuelTypeSelect?.addEventListener("change", () => {
      if (typeof syncFuelSelectStyle === "function") syncFuelSelectStyle(fuelTypeSelect);
      const name = document.getElementById("customer")?.value || "";
      if (!name.trim()) return;
      const match = findCustomerSuggestionByName(name);
      rememberCustomerFuel(name, match?.primaryId, fuelTypeSelect.value);
    });
    const transactionDateInput = document.getElementById("credit-date");
    if (transactionDateInput) initPersistedDateInput(transactionDateInput, RECORD_DATE_KEYS.creditTransaction);
    initRecordSalePanel();
    initCustomerCombobox();
    bindRecordDraft();
    void loadCustomerNames();
    ready = true;
  }

  function bindRecordDraft() {
    const panel = document.getElementById("credit-panel-record");
    if (!panel || recordDraft || typeof bindUnsavedDraft !== "function") return;
    // Dates are remembered separately; an old draft must not bring back yesterday.
    const dateFields = ["credit_date", "credit-date", "quick-settle-date"];
    recordDraft = bindUnsavedDraft({
      key: "credit.record",
      root: panel,
      capture: () => omitDraftFields(captureDomDraftFields(panel), dateFields),
      skipTarget: (target) => dateFields.includes(target?.name) || dateFields.includes(target?.id),
    });
    recordDraft.adoptServerState();
    if (recordDraft.restore()) {
      const fuelTypeSelect = document.getElementById("fuel-type");
      if (fuelTypeSelect && typeof syncFuelSelectStyle === "function") syncFuelSelectStyle(fuelTypeSelect);
      syncQuickPaymentPanel(document.getElementById("customer")?.value || "");
      AppError.showToast("Restored an unsaved credit entry from this device.", "info");
    }
  }

  window.CreditRecord = { init, isReady: () => ready };
})();
