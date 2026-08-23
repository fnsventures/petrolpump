/**
 * Shift staff ledger: add credit customers & expenses from Staff collections.
 * Persists real credit_entries / expenses rows (day closing picks them up).
 */
/* global supabaseClient, AppError, escapeHtml, formatCurrency, formatDisplayDate, normCustomerName */

(function (global) {
  const SALARY_CATEGORY = "salary";

  let overlay = null;
  let bodyEl = null;
  let titleEl = null;
  let subtitleEl = null;
  let focusReturn = null;
  let context = null; // { date, shift, employeeId, employeeName, readonly, onChange }
  let creditRows = [];
  let expenseRows = [];
  let categories = [];
  let customerSuggestions = [];
  let comboboxMatches = [];
  let comboboxActive = -1;
  let currentUserId = null;
  let isAdmin = false;
  let activeTab = "credit";

  function el(id) {
    return document.getElementById(id);
  }

  function ensureDom() {
    overlay = el("shift-ledger-overlay");
    bodyEl = el("shift-ledger-body");
    titleEl = el("shift-ledger-title");
    subtitleEl = el("shift-ledger-subtitle");
    return Boolean(overlay && bodyEl);
  }

  async function loadCategories() {
    const { data, error } = await supabaseClient
      .from("expense_categories")
      .select("name, label, sort_order")
      .order("sort_order", { ascending: true })
      .order("label", { ascending: true });
    if (error) throw error;
    categories = (data || []).filter((c) => c.name !== SALARY_CATEGORY);
  }

  async function loadCustomerSuggestions() {
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("id, customer_name, vehicle_no, mobile, address, amount_due, prepaid_balance")
      .order("customer_name", { ascending: true })
      .limit(500);
    if (error) throw error;
    const byName = new Map();
    (data || []).forEach((row) => {
      const name = (row.customer_name || "").trim();
      if (!name) return;
      const key = typeof normCustomerName === "function" ? normCustomerName(name) : name.toLowerCase();
      const due = Number(row.amount_due) || 0;
      const prepaid = Number(row.prepaid_balance) || 0;
      const net = due - prepaid;
      const cur = byName.get(key);
      if (!cur) {
        byName.set(key, {
          name,
          nameNorm: key,
          vehicleNo: row.vehicle_no || "",
          mobile: row.mobile || "",
          address: row.address || "",
          primaryId: row.id,
          netBalance: net,
        });
      } else {
        cur.netBalance += net;
      }
    });
    customerSuggestions = Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  async function loadLedgerForContext() {
    if (!context) return;
    const { data, error } = await supabaseClient.rpc("get_shift_staff_ledger", {
      p_date: context.date,
      p_shift: context.shift,
    });
    if (error) throw error;
    const empId = context.employeeId;
    creditRows = (data?.credit || []).filter((r) => r.employee_id === empId);
    expenseRows = (data?.expenses || []).filter((r) => r.employee_id === empId);
  }

  function categoryLabel(name) {
    const hit = categories.find((c) => c.name === name);
    return hit?.label || name || "—";
  }

  function creditTotal() {
    return creditRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  }

  function expenseTotal() {
    return expenseRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  }

  function notifyChange() {
    if (typeof context?.onChange === "function") {
      context.onChange({
        employeeId: context.employeeId,
        credit: creditTotal(),
        expense: expenseTotal(),
        creditRows: creditRows.slice(),
        expenseRows: expenseRows.slice(),
      });
    }
  }

  function setMsg(text, isError) {
    const msg = el("shift-ledger-msg");
    if (!msg) return;
    if (!text) {
      msg.textContent = "";
      msg.classList.add("hidden");
      msg.classList.remove("error", "success");
      return;
    }
    msg.textContent = text;
    msg.classList.remove("hidden", "error", "success");
    msg.classList.add(isError ? "error" : "success");
  }

  function filterCustomers(query) {
    const needle =
      typeof normCustomerName === "function" ? normCustomerName(query) : String(query || "").toLowerCase();
    if (!needle) return customerSuggestions.slice(0, 40);
    return customerSuggestions.filter((c) => c.nameNorm.includes(needle)).slice(0, 40);
  }

  function setComboboxOpen(open) {
    const input = el("shift-ledger-customer");
    const list = el("shift-ledger-customer-list");
    if (!input || !list) return;
    input.setAttribute("aria-expanded", open ? "true" : "false");
    list.classList.toggle("hidden", !open);
    list.hidden = !open;
    if (!open) comboboxActive = -1;
  }

  function renderCombobox(query) {
    const list = el("shift-ledger-customer-list");
    if (!list) return;
    comboboxMatches = filterCustomers(query);
    comboboxActive = -1;
    if (!comboboxMatches.length) {
      list.innerHTML = '<li class="combobox-empty" role="presentation">No matching customers — new name will be created</li>';
      setComboboxOpen(Boolean(String(query || "").trim()));
      return;
    }
    list.innerHTML = comboboxMatches
      .map(
        (item, index) =>
          `<li class="combobox-option" role="option" data-index="${index}">${escapeHtml(item.name)}</li>`
      )
      .join("");
    list.querySelectorAll(".combobox-option").forEach((node, index) => {
      node.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        pickCustomer(comboboxMatches[index]);
      });
    });
    setComboboxOpen(true);
  }

  function pickCustomer(item) {
    const input = el("shift-ledger-customer");
    if (input && item) input.value = item.name;
    setComboboxOpen(false);
    el("shift-ledger-credit-amount")?.focus();
  }

  function canDeleteCredit(row) {
    if (context?.readonly) return false;
    if (Number(row.amount_settled) > 0) return false;
    return isAdmin || (row.created_by && row.created_by === currentUserId);
  }

  function canDeleteExpense(row) {
    if (context?.readonly) return false;
    return isAdmin || (row.created_by && row.created_by === currentUserId);
  }

  function renderBody() {
    if (!bodyEl || !context) return;
    const readonly = !!context.readonly;
    const catOptions = categories
      .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.label)}</option>`)
      .join("");
    const tab = activeTab === "expense" ? "expense" : "credit";

    const creditList = creditRows.length
      ? `<ul class="shift-ledger-list">${creditRows
          .map((r) => {
            const del = canDeleteCredit(r)
              ? `<button type="button" class="shift-ledger-remove shift-ledger-del-credit" data-id="${escapeHtml(r.id)}" aria-label="Remove">×</button>`
              : "";
            return `<li>
              <div class="shift-ledger-item-main">
                <strong>${escapeHtml(r.customer_name || "Customer")}</strong>
                <span class="muted">${escapeHtml(r.fuel_type || "HSD")}</span>
              </div>
              <div class="shift-ledger-row-amt">
                <strong>${formatCurrency(r.amount)}</strong>
                ${del}
              </div>
            </li>`;
          })
          .join("")}</ul>`
      : '<p class="muted shift-ledger-empty">No credit added yet.</p>';

    const expenseList = expenseRows.length
      ? `<ul class="shift-ledger-list">${expenseRows
          .map((r) => {
            const del = canDeleteExpense(r)
              ? `<button type="button" class="shift-ledger-remove shift-ledger-del-expense" data-id="${escapeHtml(r.id)}" aria-label="Remove">×</button>`
              : "";
            return `<li>
              <div class="shift-ledger-item-main">
                <strong>${escapeHtml(categoryLabel(r.category))}</strong>
                ${r.description ? `<span class="muted">${escapeHtml(r.description)}</span>` : ""}
              </div>
              <div class="shift-ledger-row-amt">
                <strong>${formatCurrency(r.amount)}</strong>
                ${del}
              </div>
            </li>`;
          })
          .join("")}</ul>`
      : '<p class="muted shift-ledger-empty">No expenses added yet.</p>';

    const creditForm = readonly
      ? ""
      : `<form id="shift-ledger-credit-form" class="shift-ledger-form">
          <div class="shift-ledger-form-grid">
            <div class="shift-ledger-field shift-ledger-field--grow">
              <label for="shift-ledger-customer">Customer</label>
              <div class="combobox">
                <input id="shift-ledger-customer" name="customer_name" type="text" autocomplete="off"
                  aria-autocomplete="list" aria-expanded="false" aria-controls="shift-ledger-customer-list"
                  placeholder="Name" required />
                <ul id="shift-ledger-customer-list" class="combobox-list hidden" role="listbox" hidden></ul>
              </div>
            </div>
            <div class="shift-ledger-field">
              <label for="shift-ledger-fuel">Fuel</label>
              <select id="shift-ledger-fuel" name="fuel_type">
                <option value="HSD">HSD</option>
                <option value="MS">MS</option>
              </select>
            </div>
            <div class="shift-ledger-field">
              <label for="shift-ledger-credit-amount">Amount</label>
              <input id="shift-ledger-credit-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" required />
            </div>
            <div class="shift-ledger-field shift-ledger-field--action">
              <label class="sr-only" for="shift-ledger-credit-submit">Save</label>
              <button id="shift-ledger-credit-submit" type="submit">Add</button>
            </div>
          </div>
        </form>`;

    const expenseForm = readonly
      ? ""
      : `<form id="shift-ledger-expense-form" class="shift-ledger-form">
          <div class="shift-ledger-form-grid">
            <div class="shift-ledger-field shift-ledger-field--grow">
              <label for="shift-ledger-expense-cat">Category</label>
              <select id="shift-ledger-expense-cat" name="category" required>
                <option value="">Select…</option>
                ${catOptions}
              </select>
            </div>
            <div class="shift-ledger-field">
              <label for="shift-ledger-expense-amount">Amount</label>
              <input id="shift-ledger-expense-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" required />
            </div>
            <div class="shift-ledger-field shift-ledger-field--action">
              <label class="sr-only" for="shift-ledger-expense-submit">Save</label>
              <button id="shift-ledger-expense-submit" type="submit">Add</button>
            </div>
          </div>
        </form>`;

    bodyEl.innerHTML = `
      <div class="shift-ledger-summary" aria-live="polite">
        <div class="shift-ledger-summary-item">
          <span class="muted">Credit</span>
          <strong>${formatCurrency(creditTotal())}</strong>
        </div>
        <div class="shift-ledger-summary-item">
          <span class="muted">Expenses</span>
          <strong>${formatCurrency(expenseTotal())}</strong>
        </div>
      </div>
      <div class="shift-ledger-tabs" role="tablist">
        <button type="button" class="shift-ledger-tab${tab === "credit" ? " is-active" : ""}" data-tab="credit" role="tab" aria-selected="${tab === "credit"}">Credit</button>
        <button type="button" class="shift-ledger-tab${tab === "expense" ? " is-active" : ""}" data-tab="expense" role="tab" aria-selected="${tab === "expense"}">Expenses</button>
      </div>
      <p id="shift-ledger-msg" class="hidden" role="status"></p>
      <div class="shift-ledger-panel" data-panel="credit" ${tab === "credit" ? "" : "hidden"}>
        ${creditForm}
        ${creditList}
      </div>
      <div class="shift-ledger-panel" data-panel="expense" ${tab === "expense" ? "" : "hidden"}>
        ${expenseForm}
        ${expenseList}
      </div>`;

    bodyEl.querySelectorAll(".shift-ledger-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab === "expense" ? "expense" : "credit";
        renderBody();
        if (activeTab === "credit") el("shift-ledger-customer")?.focus();
        else el("shift-ledger-expense-cat")?.focus();
      });
    });

    if (!readonly) {
      bindForms();
      if (tab === "credit") bindCombobox();
    }
    bindDeletes();
  }

  function bindCombobox() {
    const input = el("shift-ledger-customer");
    if (!input) return;
    input.addEventListener("input", () => renderCombobox(input.value));
    input.addEventListener("focus", () => renderCombobox(input.value));
    input.addEventListener("blur", () => setTimeout(() => setComboboxOpen(false), 150));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" && comboboxMatches.length) {
        ev.preventDefault();
        comboboxActive = Math.min(comboboxActive + 1, comboboxMatches.length - 1);
        highlightOption();
      } else if (ev.key === "ArrowUp" && comboboxMatches.length) {
        ev.preventDefault();
        comboboxActive = Math.max(comboboxActive - 1, 0);
        highlightOption();
      } else if (ev.key === "Enter" && comboboxActive >= 0) {
        ev.preventDefault();
        pickCustomer(comboboxMatches[comboboxActive]);
      } else if (ev.key === "Escape") {
        setComboboxOpen(false);
      }
    });
  }

  function highlightOption() {
    const list = el("shift-ledger-customer-list");
    list?.querySelectorAll(".combobox-option").forEach((node, i) => {
      node.classList.toggle("is-active", i === comboboxActive);
    });
  }

  function bindForms() {
    el("shift-ledger-credit-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void submitCredit(ev.currentTarget);
    });
    el("shift-ledger-expense-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void submitExpense(ev.currentTarget);
    });
  }

  function bindDeletes() {
    bodyEl?.querySelectorAll(".shift-ledger-del-credit").forEach((btn) => {
      btn.addEventListener("click", () => void deleteCredit(btn.dataset.id));
    });
    bodyEl?.querySelectorAll(".shift-ledger-del-expense").forEach((btn) => {
      btn.addEventListener("click", () => void deleteExpense(btn.dataset.id));
    });
  }

  async function submitCredit(form) {
    setMsg("");
    const fd = new FormData(form);
    const customer = String(fd.get("customer_name") || "").trim();
    const amount = Number(fd.get("amount") || 0);
    const fuel = String(fd.get("fuel_type") || "HSD").trim() || "HSD";
    if (!customer || amount <= 0) {
      setMsg("Customer and amount are required.", true);
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    try {
      const { error } = await supabaseClient.rpc("add_credit_entry", {
        p_customer_name: customer,
        p_transaction_date: context.date,
        p_amount: amount,
        p_fuel_type: fuel,
        p_employee_id: context.employeeId,
        p_shift: context.shift,
      });
      if (error) throw error;
      form.reset();
      const fuelSel = el("shift-ledger-fuel");
      if (fuelSel) fuelSel.value = "HSD";
      await loadLedgerForContext();
      renderBody();
      notifyChange();
      setMsg("Credit added.");
      el("shift-ledger-customer")?.focus();
    } catch (err) {
      AppError.report(err, { context: "ShiftStaffLedger.submitCredit" });
      setMsg(err?.message || "Could not save credit.", true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Add";
      }
    }
  }

  async function submitExpense(form) {
    setMsg("");
    const fd = new FormData(form);
    const category = String(fd.get("category") || "").trim();
    const amount = Number(fd.get("amount") || 0);
    if (!category || amount <= 0) {
      setMsg("Category and amount are required.", true);
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    try {
      const { error } = await supabaseClient.rpc("add_shift_expense", {
        p_date: context.date,
        p_shift: context.shift,
        p_employee_id: context.employeeId,
        p_category: category,
        p_amount: amount,
      });
      if (error) throw error;
      form.reset();
      await loadLedgerForContext();
      renderBody();
      notifyChange();
      setMsg("Expense added.");
      el("shift-ledger-expense-cat")?.focus();
    } catch (err) {
      AppError.report(err, { context: "ShiftStaffLedger.submitExpense" });
      setMsg(err?.message || "Could not save expense.", true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Add";
      }
    }
  }

  async function deleteCredit(id) {
    if (!id || !confirm("Remove this credit sale from the shift?")) return;
    setMsg("");
    try {
      const { error } = await supabaseClient.rpc("delete_shift_credit_entry", { p_entry_id: id });
      if (error) throw error;
      await loadLedgerForContext();
      renderBody();
      notifyChange();
      setMsg("Credit sale removed.");
    } catch (err) {
      AppError.report(err, { context: "ShiftStaffLedger.deleteCredit" });
      setMsg(err?.message || "Could not remove credit sale.", true);
    }
  }

  async function deleteExpense(id) {
    if (!id || !confirm("Remove this expense from the shift?")) return;
    setMsg("");
    try {
      const { error } = await supabaseClient.rpc("delete_shift_expense", { p_expense_id: id });
      if (error) throw error;
      await loadLedgerForContext();
      renderBody();
      notifyChange();
      setMsg("Expense removed.");
    } catch (err) {
      AppError.report(err, { context: "ShiftStaffLedger.deleteExpense" });
      setMsg(err?.message || "Could not remove expense.", true);
    }
  }

  function close() {
    if (!overlay || overlay.getAttribute("aria-hidden") === "true") return;
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    context = null;
    if (focusReturn && typeof focusReturn.focus === "function") {
      try {
        focusReturn.focus();
      } catch (_) {
        /* ignore */
      }
    }
    focusReturn = null;
  }

  async function open(opts) {
    if (!ensureDom()) return;
    focusReturn = document.activeElement;
    context = {
      date: opts.date,
      shift: opts.shift,
      employeeId: opts.employeeId,
      employeeName: opts.employeeName || "Staff",
      readonly: !!opts.readonly,
      onChange: opts.onChange,
    };
    activeTab = opts.focusTab === "expense" ? "expense" : "credit";
    currentUserId = opts.userId || null;
    isAdmin = !!opts.isAdmin;

    if (titleEl) titleEl.textContent = context.employeeName;
    if (subtitleEl) {
      const shiftName = context.shift === "afternoon" ? "Afternoon" : "Morning";
      subtitleEl.textContent = `${formatDisplayDate?.(context.date) || context.date} · ${shiftName} · Credit & expenses`;
    }
    bodyEl.innerHTML = '<p class="muted">Loading…</p>';
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    try {
      await Promise.all([loadCategories(), loadCustomerSuggestions(), loadLedgerForContext()]);
      renderBody();
      notifyChange();
      if (activeTab === "credit") el("shift-ledger-customer")?.focus();
      else el("shift-ledger-expense-cat")?.focus();
    } catch (err) {
      AppError.report(err, { context: "ShiftStaffLedger.open" });
      bodyEl.innerHTML = `<p class="error">${escapeHtml(err?.message || "Could not load.")}</p>`;
    }
  }

  function init() {
    if (!ensureDom()) return;
    el("shift-ledger-close")?.addEventListener("click", close);
    el("shift-ledger-dismiss")?.addEventListener("click", close);
    el("shift-ledger-backdrop")?.addEventListener("click", close);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && overlay?.getAttribute("aria-hidden") === "false") {
        close();
      }
    });
  }

  /** Fetch ledger totals keyed by employee_id for a shift. */
  async function fetchTotalsByEmployee(date, shift) {
    const { data, error } = await supabaseClient.rpc("get_shift_staff_ledger", {
      p_date: date,
      p_shift: shift,
    });
    if (error) throw error;
    const map = new Map();
    function bump(empId, field, amount) {
      if (!empId) return;
      let cur = map.get(empId);
      if (!cur) {
        cur = { credit: 0, expense: 0 };
        map.set(empId, cur);
      }
      cur[field] += Number(amount) || 0;
    }
    (data?.credit || []).forEach((r) => bump(r.employee_id, "credit", r.amount));
    (data?.expenses || []).forEach((r) => bump(r.employee_id, "expense", r.amount));
    return map;
  }

  global.ShiftStaffLedger = {
    init,
    open,
    close,
    fetchTotalsByEmployee,
  };
})(typeof window !== "undefined" ? window : globalThis);
