/* global supabaseClient, requireAuth, applyRoleVisibility, AppError, escapeHtml, initPageSections, formatDisplayDate, formatCurrency, getLocalDateString, toLocalDateString, AdminDelete, TaskUtils, debounce, addDaysToDateString, appendDatedNote */

(function () {
  const PAGE_SIZE = 30;
  const OPEN_SELECT =
    "id, title, notes, due_date, priority, reminder_type, status, credit_customer_id, created_at, credit_customers(customer_name, mobile, amount_due)";
  const DONE_SELECT =
    "id, title, notes, due_date, priority, reminder_type, status, credit_customer_id, completed_at, created_at, credit_customers(customer_name, mobile, amount_due)";

  let currentAuth = null;
  let customersById = new Map();
  let customerIndex = [];
  let customersLoaded = false;
  let customersLoading = null;
  let doneLoadedOnce = false;
  let donePagination = { offset: 0, hasMore: true, totalCount: 0, isLoading: false };
  let customerComboboxMatches = [];
  let customerComboboxActiveIndex = -1;

  document.addEventListener("DOMContentLoaded", async () => {
    const auth = await requireAuth({
      allowedRoles: ["admin", "supervisor"],
      onDenied: "dashboard.html",
      pageName: "reminders",
    });
    if (!auth) return;
    currentAuth = auth;
    applyRoleVisibility(auth.role);

    if (typeof initPageSections === "function") {
      initPageSections({
        defaultSection: "credit",
        validSections: ["credit", "todo", "add", "done"],
        hashAliases: { due: "credit", backlog: "todo", upcoming: "todo" },
        onSectionChange: (section) => {
          if (section === "add" && getTaskKind() === "credit") void ensureCustomers();
          if (section === "done") void loadDoneTasks(true);
        },
      });
    }

    bindForm();
    bindDueShortcuts();
    bindKindToggle();
    bindListActions();
    bindDonePagination();
    bindAddLinks();

    const prefillNeedsCustomers = applyUrlPrefillNeedsCustomers();
    if (prefillNeedsCustomers || getTaskKind() === "credit") await ensureCustomers();
    applyUrlPrefill();
    syncFormKindUi();
    await loadOpenBoard();
  });

  function getTaskKind() {
    return document.querySelector('input[name="task_kind"]:checked')?.value === "credit"
      ? "credit"
      : "todo";
  }

  function setTaskKind(kind) {
    const value = kind === "credit" ? "credit" : "todo";
    const radio = document.querySelector(`input[name="task_kind"][value="${value}"]`);
    if (radio) radio.checked = true;
    syncFormKindUi();
    if (value === "credit") void ensureCustomers();
  }

  function creditTitleForCustomer(customerId) {
    return TaskUtils.creditTitle(customersById.get(customerId)?.customer_name);
  }

  function updateCreditPreview() {
    const preview = document.getElementById("reminder-credit-preview");
    if (!preview) return;
    const customerId = document.getElementById("reminder-customer")?.value || "";
    const customer = customersById.get(customerId);
    if (!customerId || !customer) {
      preview.innerHTML = "Saved as <strong>Call …</strong>";
      return;
    }
    const due = Number(customer.amount_due) || 0;
    const dueBit =
      due > 0
        ? ` · outstanding <strong>${escapeHtml(formatCurrency(due))}</strong>`
        : "";
    preview.innerHTML = `Saved as <strong>${escapeHtml(creditTitleForCustomer(customerId))}</strong>${dueBit}`;
  }

  function syncFormKindUi() {
    const isCredit = getTaskKind() === "credit";
    const titleWrap = document.getElementById("reminder-title-wrap");
    const customerWrap = document.getElementById("reminder-customer-wrap");
    const titleInput = document.getElementById("reminder-title");
    const priorityWrap = document.getElementById("reminder-priority-wrap");
    const dueOptional = document.getElementById("reminder-due-optional");
    const dueNone = document.getElementById("reminder-due-none");
    const submitBtn = document.getElementById("reminder-submit");
    const dueEl = document.getElementById("reminder-due-date");
    const priorityEl = document.getElementById("reminder-priority");
    const formLead = document.getElementById("reminder-form-lead");

    if (titleWrap) titleWrap.hidden = isCredit;
    if (customerWrap) customerWrap.hidden = !isCredit;
    if (priorityWrap) priorityWrap.hidden = isCredit;

    if (titleInput) {
      titleInput.required = !isCredit;
      if (isCredit) titleInput.value = "";
    }
    if (dueOptional) dueOptional.hidden = isCredit;
    if (dueNone) dueNone.hidden = isCredit;
    if (submitBtn) submitBtn.textContent = isCredit ? "Schedule call" : "Save todo";
    if (formLead) {
      formLead.innerHTML = isCredit
        ? "Schedule a collection call. Search and pick a customer; due date defaults to today."
        : "Add a general station todo. High priority or due items appear on the dashboard.";
    }

    if (isCredit) {
      if (dueEl && !dueEl.value) dueEl.value = getLocalDateString();
      if (priorityEl) priorityEl.value = "high";
      updateCreditPreview();
    } else {
      clearCustomerSelection({ keepSearch: false });
      setCustomerComboboxOpen(false);
    }
    syncDueShortcutActive();
  }

  function normalizeSearch(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function filterCustomerMatches(query) {
    const q = normalizeSearch(query);
    if (!q) return customerIndex.slice(0, 40);
    const digits = q.replace(/\D/g, "");
    return customerIndex
      .filter((item) => item.search.includes(q) || (digits && item.mobileDigits.includes(digits)))
      .slice(0, 40);
  }

  function setCustomerComboboxOpen(open) {
    const input = document.getElementById("reminder-customer-search");
    const list = document.getElementById("reminder-customer-suggestions");
    if (!input || !list) return;
    input.setAttribute("aria-expanded", open ? "true" : "false");
    list.classList.toggle("hidden", !open);
    list.hidden = !open;
    if (!open) {
      customerComboboxActiveIndex = -1;
      input.removeAttribute("aria-activedescendant");
    }
  }

  function clearCustomerSelection({ keepSearch = true } = {}) {
    const hidden = document.getElementById("reminder-customer");
    const search = document.getElementById("reminder-customer-search");
    if (hidden) hidden.value = "";
    if (search && !keepSearch) search.value = "";
    updateCreditPreview();
  }

  function selectCustomerMatch(item) {
    if (!item) return;
    const hidden = document.getElementById("reminder-customer");
    const search = document.getElementById("reminder-customer-search");
    if (hidden) hidden.value = item.id;
    if (search) search.value = item.name;
    setCustomerComboboxOpen(false);
    updateCreditPreview();
  }

  function renderCustomerSuggestions(query) {
    const list = document.getElementById("reminder-customer-suggestions");
    const input = document.getElementById("reminder-customer-search");
    if (!list || !input) return;

    const matches = filterCustomerMatches(query);
    customerComboboxMatches = matches;
    customerComboboxActiveIndex = -1;

    if (!customersLoaded) {
      list.innerHTML = `<li class="combobox-empty" role="presentation">Loading customers…</li>`;
      setCustomerComboboxOpen(true);
      return;
    }

    if (matches.length === 0) {
      list.innerHTML = `<li class="combobox-empty" role="presentation">No matching customers</li>`;
      setCustomerComboboxOpen(Boolean(String(query || "").trim()));
      return;
    }

    list.innerHTML = matches
      .map((item, index) => {
        const due =
          item.amountDue > 0
            ? ` · due ${typeof formatCurrency === "function" ? formatCurrency(item.amountDue) : "₹" + item.amountDue}`
            : "";
        const mobile = item.mobile ? ` · ${escapeHtml(item.mobile)}` : "";
        return `<li class="combobox-option" role="option" id="reminder-customer-opt-${index}" data-index="${index}">
          <span class="reminders-customer-opt-name">${escapeHtml(item.name)}</span><span class="reminders-customer-opt-meta muted">${mobile}${escapeHtml(due)}</span>
        </li>`;
      })
      .join("");

    list.querySelectorAll(".combobox-option").forEach((el) => {
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectCustomerMatch(matches[Number(el.getAttribute("data-index"))]);
      });
    });

    setCustomerComboboxOpen(true);
  }

  function highlightCustomerOption(index) {
    const list = document.getElementById("reminder-customer-suggestions");
    const input = document.getElementById("reminder-customer-search");
    if (!list) return;
    const options = list.querySelectorAll(".combobox-option");
    options.forEach((el, i) => el.classList.toggle("is-active", i === index));
    customerComboboxActiveIndex = index;
    const active = options[index];
    if (active) {
      active.scrollIntoView({ block: "nearest" });
      input?.setAttribute("aria-activedescendant", active.id);
    }
  }

  function initCustomerCombobox() {
    const input = document.getElementById("reminder-customer-search");
    const list = document.getElementById("reminder-customer-suggestions");
    if (!input || !list || input.dataset.bound) return;
    input.dataset.bound = "1";

    const runSearch = () => {
      const hidden = document.getElementById("reminder-customer");
      const selected = hidden?.value ? customersById.get(hidden.value) : null;
      if (selected && normalizeSearch(input.value) !== normalizeSearch(selected.customer_name)) {
        if (hidden) hidden.value = "";
        updateCreditPreview();
      }
      renderCustomerSuggestions(input.value);
    };

    const onInput = typeof debounce === "function" ? debounce(runSearch, 100) : runSearch;
    input.addEventListener("input", onInput);
    input.addEventListener("focus", () => {
      void ensureCustomers().then(() => renderCustomerSuggestions(input.value));
    });

    input.addEventListener("keydown", (event) => {
      const options = list.querySelectorAll(".combobox-option");
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (list.hidden) renderCustomerSuggestions(input.value);
        if (!options.length) return;
        const next = customerComboboxActiveIndex < options.length - 1 ? customerComboboxActiveIndex + 1 : 0;
        highlightCustomerOption(next);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!options.length) return;
        const prev = customerComboboxActiveIndex > 0 ? customerComboboxActiveIndex - 1 : options.length - 1;
        highlightCustomerOption(prev);
        return;
      }
      if (event.key === "Enter" && customerComboboxActiveIndex >= 0 && !list.hidden) {
        event.preventDefault();
        selectCustomerMatch(customerComboboxMatches[customerComboboxActiveIndex]);
        return;
      }
      if (event.key === "Escape") setCustomerComboboxOpen(false);
    });

    input.addEventListener("blur", () => {
      setTimeout(() => setCustomerComboboxOpen(false), 120);
    });

    document.addEventListener("click", (e) => {
      const box = document.getElementById("reminder-customer-combobox");
      if (box && !box.contains(e.target)) setCustomerComboboxOpen(false);
    });
  }

  function bindKindToggle() {
    document.querySelectorAll('input[name="task_kind"]').forEach((el) => {
      el.addEventListener("change", () => {
        syncFormKindUi();
        if (getTaskKind() === "credit") void ensureCustomers();
      });
    });
    initCustomerCombobox();
  }

  function bindAddLinks() {
    document.querySelectorAll("[data-add-kind]").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        setTaskKind(link.getAttribute("data-add-kind") === "credit" ? "credit" : "todo");
        location.hash = "add";
      });
    });
  }

  function addDaysLocal(yyyyMmDd, days) {
    if (typeof addDaysToDateString === "function") return addDaysToDateString(yyyyMmDd, days);
    if (typeof TaskUtils?.addDaysYmd === "function") return TaskUtils.addDaysYmd(yyyyMmDd, days);
    const base = String(yyyyMmDd || "").slice(0, 10);
    const [y, m, d] = base.split("-").map(Number);
    if (!y || !m || !d) return base;
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + (Number(days) || 0));
    return typeof toLocalDateString === "function" ? toLocalDateString(dt) : dt.toISOString().slice(0, 10);
  }

  function syncDueShortcutActive() {
    const dueEl = document.getElementById("reminder-due-date");
    const due = dueEl?.value || "";
    const today = getLocalDateString();
    const tomorrow = addDaysLocal(today, 1);
    document.querySelectorAll("[data-due-shortcut]").forEach((btn) => {
      const kind = btn.getAttribute("data-due-shortcut");
      const active =
        (kind === "today" && due === today) ||
        (kind === "tomorrow" && due === tomorrow) ||
        (kind === "none" && !due);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function bindDueShortcuts() {
    document.querySelector(".reminders-due-shortcuts")?.addEventListener("click", (e) => {
      const btn = e.target.closest?.("[data-due-shortcut]");
      if (!btn) return;
      const dueEl = document.getElementById("reminder-due-date");
      if (!dueEl) return;
      const kind = btn.getAttribute("data-due-shortcut");
      const today = getLocalDateString();
      if (kind === "today") dueEl.value = today;
      else if (kind === "tomorrow") dueEl.value = addDaysLocal(today, 1);
      else dueEl.value = "";
      syncDueShortcutActive();
    });
    document.getElementById("reminder-due-date")?.addEventListener("change", syncDueShortcutActive);
  }

  function bindForm() {
    const form = document.getElementById("reminder-form");
    const successEl = document.getElementById("reminder-success");
    const errorEl = document.getElementById("reminder-error");

    document.getElementById("reminder-form-reset")?.addEventListener("click", () => {
      form?.reset();
      clearCustomerSelection({ keepSearch: false });
      setCustomerComboboxOpen(false);
      setTaskKind("credit");
      successEl?.classList.add("hidden");
      errorEl?.classList.add("hidden");
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      const kind = getTaskKind();
      const doneLabel = kind === "credit" ? "Schedule call" : "Save todo";

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = kind === "credit" ? "Scheduling…" : "Saving…";
      }
      successEl?.classList.add("hidden");
      errorEl?.classList.add("hidden");

      const formData = new FormData(form);
      const dueDate = String(formData.get("due_date") || "").trim() || null;
      const notesRaw = String(formData.get("notes") || "").trim();
      let title = String(formData.get("title") || "").trim();
      let customerId = String(formData.get("credit_customer_id") || "").trim() || null;
      let priority = String(formData.get("priority") || "normal");
      let reminderType = "todo";
      const customerName = customerId
        ? customersById.get(customerId)?.customer_name || ""
        : "";

      if (kind === "credit") {
        if (!customerId) {
          failForm(errorEl, submitBtn, doneLabel, "Select a credit customer.", "reminder-customer-search");
          return;
        }
        if (!dueDate) {
          failForm(errorEl, submitBtn, doneLabel, "Due date is required for credit collection.", "reminder-due-date");
          return;
        }

        const { data: existingOpen, error: existingError } = await supabaseClient
          .from("reminders")
          .select("id, due_date, title")
          .eq("status", "open")
          .eq("credit_customer_id", customerId)
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (existingError) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = doneLabel;
          }
          AppError.handle(existingError, { target: errorEl });
          return;
        }
        if (existingOpen) {
          const dueLabelText = existingOpen.due_date
            ? formatDisplayDate(existingOpen.due_date)
            : "no date";
          failForm(
            errorEl,
            submitBtn,
            doneLabel,
            `Open call already exists (due ${dueLabelText}). Open Credit collection and use +3 days / More… on that task instead of creating another.`,
            "reminder-customer-search"
          );
          return;
        }

        title = creditTitleForCustomer(customerId);
        reminderType = "credit_followup";
        priority = "high";
      } else {
        customerId = null;
        if (!title) {
          failForm(errorEl, submitBtn, doneLabel, "Please enter what needs doing.", "reminder-title");
          return;
        }
      }

      const { error } = await supabaseClient.from("reminders").insert({
        title,
        due_date: dueDate,
        priority,
        reminder_type: reminderType,
        credit_customer_id: customerId,
        notes: notesRaw || null,
        status: "open",
        created_by: currentAuth.session?.user?.id || null,
        updated_at: new Date().toISOString(),
      });

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = doneLabel;
      }

      if (error) {
        AppError.handle(error, { target: errorEl });
        return;
      }

      form.reset();
      clearCustomerSelection({ keepSearch: false });
      setCustomerComboboxOpen(false);
      setTaskKind(kind);
      if (kind === "credit") {
        const dueEl = document.getElementById("reminder-due-date");
        if (dueEl) dueEl.value = getLocalDateString();
      }
      if (successEl) {
        if (kind === "credit") {
          const who = escapeHtml(customerName || "customer");
          successEl.innerHTML = `Call scheduled for <strong>${who}</strong>. Pick another customer, or <a href="#credit">view list</a>.`;
        } else {
          successEl.textContent = "Todo saved.";
        }
        successEl.classList.remove("hidden");
      }
      TaskUtils.notifyTasksUpdated();
      doneLoadedOnce = false;
      await loadOpenBoard();
      // Keep credit form open for back-to-back collection scheduling
      if (kind === "credit") {
        location.hash = "add";
        document.getElementById("reminder-customer-search")?.focus();
      } else {
        location.hash = "todo";
      }
    });
  }

  function failForm(errorEl, submitBtn, label, message, focusId) {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = label;
    }
    document.getElementById(focusId)?.focus();
  }

  async function ensureCustomers() {
    if (customersLoaded) return;
    if (customersLoading) return customersLoading;
    customersLoading = loadCustomerOptions().finally(() => {
      customersLoading = null;
    });
    return customersLoading;
  }

  async function loadCustomerOptions() {
    const { data, error } = await supabaseClient
      .from("credit_customers")
      .select("id, customer_name, mobile, amount_due")
      .order("customer_name", { ascending: true })
      .limit(500);

    if (error) {
      AppError.report(error, { context: "tasksLoadCustomers" });
      return;
    }

    customersById = new Map();
    const rows = data || [];
    rows.sort((a, b) => {
      const ad = Number(a.amount_due) > 0 ? 0 : 1;
      const bd = Number(b.amount_due) > 0 ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return String(a.customer_name || "").localeCompare(String(b.customer_name || ""), "en");
    });

    customerIndex = rows.map((row) => {
      customersById.set(row.id, row);
      const name = String(row.customer_name || "").trim();
      const mobile = String(row.mobile || "").trim();
      return {
        id: row.id,
        name,
        mobile,
        amountDue: Number(row.amount_due) || 0,
        search: normalizeSearch(`${name} ${mobile}`),
        mobileDigits: mobile.replace(/\D/g, ""),
      };
    });

    customersLoaded = true;
    const search = document.getElementById("reminder-customer-search");
    if (search && document.activeElement === search) {
      renderCustomerSuggestions(search.value);
    }
  }

  function applyUrlPrefillNeedsCustomers() {
    const params = new URLSearchParams(window.location.search);
    return Boolean(
      params.get("customer") ||
        params.get("customer_id") ||
        params.get("name") ||
        params.get("kind") === "credit" ||
        ["credit_followup", "payment", "call"].includes(params.get("type") || "")
    );
  }

  function applyUrlPrefill() {
    const params = new URLSearchParams(window.location.search);
    const customerId = params.get("customer") || params.get("customer_id") || "";
    const name = (params.get("name") || "").trim();
    const type = params.get("type") || "";
    const title = (params.get("title") || "").trim();
    const due = params.get("due") || "";
    const kindParam = params.get("kind") || "";

    const wantsCredit =
      kindParam === "credit" ||
      TaskUtils.CREDIT_TYPES.has(type) ||
      Boolean(customerId || name);

    if (!(wantsCredit || title || due || kindParam === "todo")) return;

    if (location.hash.replace(/^#/, "") !== "add") location.hash = "add";
    setTaskKind(wantsCredit ? "credit" : "todo");

    const dueEl = document.getElementById("reminder-due-date");
    if (dueEl) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(due)) dueEl.value = due;
      else if (wantsCredit) dueEl.value = getLocalDateString();
    }

    if (customersLoaded) {
      let match = null;
      if (customerId && customersById.has(customerId)) match = customerIndex.find((c) => c.id === customerId);
      else if (name) {
        const needle = normalizeSearch(name);
        match = customerIndex.find((c) => normalizeSearch(c.name) === needle);
      }
      if (match) selectCustomerMatch(match);
    }

    if (!wantsCredit) {
      const titleEl = document.getElementById("reminder-title");
      if (titleEl && title) {
        titleEl.value = title;
        titleEl.focus();
      }
    } else {
      updateCreditPreview();
      document.getElementById("reminder-customer-search")?.focus();
    }
  }

  function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    if (count > 0) {
      el.textContent = String(count);
      el.classList.remove("hidden");
      el.setAttribute("aria-hidden", "false");
    } else {
      el.classList.add("hidden");
      el.setAttribute("aria-hidden", "true");
    }
  }

  function fillList(el, rows, { today, emptyTitle, emptyCopy, group = false }) {
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = emptyState(emptyTitle, emptyCopy);
      return;
    }
    if (!group) {
      el.innerHTML = rows.map((r) => renderTaskCard(r, { today, mode: "open" })).join("");
      return;
    }
    el.innerHTML = renderGroupedOpenList(rows, today);
  }

  function renderGroupedOpenList(rows, today) {
    const buckets = [
      { key: "overdue", title: "Overdue", test: (r) => r.due_date && r.due_date < today },
      { key: "today", title: "Due today", test: (r) => r.due_date === today },
      {
        key: "upcoming",
        title: "Upcoming",
        test: (r) => r.due_date && r.due_date > today,
      },
      { key: "undated", title: "No date", test: (r) => !r.due_date },
    ];
    return buckets
      .map((bucket) => {
        const items = rows.filter(bucket.test);
        if (!items.length) return "";
        return `<div class="reminders-open-group" data-group="${bucket.key}">
          <h3 class="reminders-group-title">${escapeHtml(bucket.title)}
            <span class="reminders-group-count">${items.length}</span>
          </h3>
          <div class="reminders-list reminders-list--nested">
            ${items.map((r) => renderTaskCard(r, { today, mode: "open" })).join("")}
          </div>
        </div>`;
      })
      .filter(Boolean)
      .join("");
  }

  async function loadOpenBoard() {
    const today = getLocalDateString();
    const creditList = document.getElementById("reminders-credit-list");
    const todoList = document.getElementById("reminders-todo-list");

    const { data, error } = await supabaseClient
      .from("reminders")
      .select(OPEN_SELECT)
      .eq("status", "open")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(200);

    if (error) {
      AppError.report(error, { context: "tasksLoadOpen" });
      const msg = `<p class="error">Could not load tasks.</p>`;
      if (creditList) creditList.innerHTML = msg;
      if (todoList) todoList.innerHTML = msg;
      return;
    }

    const rows = TaskUtils.sortTasks(data || [], today);
    const { credit, todo } = TaskUtils.splitCreditTodo(rows);

    setBadge("reminders-credit-nav-badge", credit.length);
    setBadge("reminders-todo-nav-badge", todo.length);

    fillList(creditList, credit, {
      today,
      group: true,
      emptyTitle: "No credit collection calls",
      emptyCopy: 'Use <a href="#add">Schedule call</a> or open a customer in Credit → Schedule call.',
    });
    fillList(todoList, todo, {
      today,
      emptyTitle: "No todos yet",
      emptyCopy: 'Add one from <a href="#add">Add task</a>.',
    });
  }

  async function loadDoneTasks(reset) {
    if (!reset && doneLoadedOnce && !donePagination.hasMore) return;
    if (donePagination.isLoading) return;
    if (reset) {
      donePagination = { offset: 0, hasMore: true, totalCount: 0, isLoading: false };
      doneLoadedOnce = false;
    }
    if (!donePagination.hasMore && !reset) return;

    donePagination.isLoading = true;
    const creditList = document.getElementById("reminders-done-credit-list");
    const todoList = document.getElementById("reminders-done-todo-list");
    const loadMoreBtn = document.getElementById("reminders-done-load-more");
    const infoEl = document.getElementById("reminders-done-pagination-info");
    if (loadMoreBtn) loadMoreBtn.disabled = true;

    const from = donePagination.offset;
    const to = from + PAGE_SIZE - 1;

    try {
      const { data, error, count } = await runAppRequest("Done reminders", () =>
        supabaseClient
          .from("reminders")
          .select(DONE_SELECT, { count: "exact" })
          .eq("status", "done")
          .order("completed_at", { ascending: false })
          .range(from, to)
      );

      if (error) {
        AppError.report(error, { context: "tasksLoadDone" });
        if (from === 0) {
          const msg = `<p class="error">Could not load completed tasks.</p>`;
          if (creditList) creditList.innerHTML = msg;
          if (todoList) todoList.innerHTML = msg;
        }
        return;
      }

      const rows = data || [];
      donePagination.totalCount = count ?? donePagination.totalCount;
      donePagination.offset = from + rows.length;
      donePagination.hasMore = donePagination.offset < (donePagination.totalCount || 0);
      doneLoadedOnce = true;

      const today = getLocalDateString();
      const { credit, todo } = TaskUtils.splitCreditTodo(rows);

      appendDoneGroup(creditList, credit, { today, reset: from === 0, empty: "No completed credit calls" });
      appendDoneGroup(todoList, todo, { today, reset: from === 0, empty: "No completed todos" });

      if (infoEl) {
        const shown = Math.min(donePagination.offset, donePagination.totalCount || 0);
        infoEl.textContent =
          donePagination.totalCount > 0 ? `Showing ${shown} of ${donePagination.totalCount}` : "";
      }
      if (loadMoreBtn) loadMoreBtn.classList.toggle("hidden", !donePagination.hasMore);
    } catch (err) {
      if (!isCancelledRequestError(err)) {
        AppError.report(err, { context: "tasksLoadDone" });
      }
    } finally {
      resetPaginationLoading(donePagination, loadMoreBtn);
    }
  }

  function appendDoneGroup(list, rows, { today, reset, empty }) {
    if (!list) return;
    if (reset) {
      list.innerHTML = rows.length
        ? rows.map((r) => renderTaskCard(r, { today, mode: "done" })).join("")
        : emptyState(empty, "Finished items will show here.");
      return;
    }
    if (!rows.length) return;
    if (list.querySelector(".reminders-empty")) list.innerHTML = "";
    list.insertAdjacentHTML(
      "beforeend",
      rows.map((r) => renderTaskCard(r, { today, mode: "done" })).join("")
    );
  }

  function bindDonePagination() {
    document.getElementById("reminders-done-load-more")?.addEventListener("click", () => {
      loadDoneTasks(false);
    });
  }

  function bindListActions() {
    const inFlight = new Set();
    const panels = document.querySelector(".settings-panels");
    panels?.addEventListener("click", async (e) => {
      const btn = e.target.closest?.("[data-reminder-action]");
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-reminder-action");
      if (!id || !action) return;
      if (inFlight.has(id) && (action === "done" || action === "reschedule" || action === "reschedule-pick" || action === "reopen" || action === "delete")) {
        return;
      }

      if (action === "done") await completeTask(id, btn, inFlight);
      else if (action === "reopen") await reopenTask(id, btn, inFlight);
      else if (action === "delete") await deleteTask(id, btn, inFlight);
      else if (action === "later-toggle") toggleLaterPanel(id, btn);
      else if (action === "later-cancel") closeLaterPanel(id, btn);
      else if (action === "reschedule") {
        const days = Number(btn.getAttribute("data-days"));
        if (!Number.isFinite(days) || days < 1) return;
        const dueDate = addDaysLocal(getLocalDateString(), days);
        const note = btn.getAttribute("data-note") || "";
        await rescheduleTask(id, dueDate, note, btn, inFlight);
      } else if (action === "reschedule-pick") {
        const dueDate = laterPanelEl(id, btn)?.querySelector("[data-later-date]")?.value || "";
        if (!dueDate) {
          showLaterError(id, btn, "Pick a follow-up date.");
          return;
        }
        await rescheduleTask(id, dueDate, "", btn, inFlight);
      }
    });

    panels?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const input = e.target.closest?.("[data-later-date]");
      if (!input || !panels.contains(input)) return;
      e.preventDefault();
      input
        .closest(".reminder-later-pick")
        ?.querySelector('[data-reminder-action="reschedule-pick"]')
        ?.click();
    });
  }

  function laterPanelEl(id, fromEl) {
    const card = fromEl?.closest?.("article[data-reminder-id]");
    if (card) {
      return card.querySelector(`[data-later-for="${CSS.escape(id)}"]`);
    }
    return document.querySelector(`[data-later-for="${CSS.escape(id)}"]`);
  }

  function showLaterError(id, fromEl, message) {
    const panel = laterPanelEl(id, fromEl);
    const err = panel?.querySelector("[data-later-error]");
    if (err) {
      err.textContent = message;
      err.hidden = false;
      return;
    }
    alert(message);
  }

  function clearLaterError(panel) {
    const err = panel?.querySelector("[data-later-error]");
    if (err) {
      err.textContent = "";
      err.hidden = true;
    }
  }

  function closeAllLaterPanels() {
    document.querySelectorAll(".reminder-later-panel").forEach((panel) => {
      panel.hidden = true;
      clearLaterError(panel);
    });
    document.querySelectorAll('[data-reminder-action="later-toggle"]').forEach((btn) => {
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function closeLaterPanel(id, fromEl) {
    const panel = laterPanelEl(id, fromEl);
    if (panel) {
      panel.hidden = true;
      clearLaterError(panel);
    }
    const card = fromEl?.closest?.("article[data-reminder-id]") || panel?.closest?.("article[data-reminder-id]");
    card
      ?.querySelector(`[data-reminder-action="later-toggle"][data-id="${CSS.escape(id)}"]`)
      ?.setAttribute("aria-expanded", "false");
  }

  function toggleLaterPanel(id, btn) {
    const panel = laterPanelEl(id, btn);
    if (!panel) return;
    const willOpen = panel.hasAttribute("hidden") || panel.hidden;
    closeAllLaterPanels();
    if (!willOpen) return;
    panel.hidden = false;
    panel.removeAttribute("hidden");
    btn.setAttribute("aria-expanded", "true");
    clearLaterError(panel);
    const today = getLocalDateString();
    const dateInput = panel.querySelector("[data-later-date]");
    if (dateInput) {
      dateInput.min = today;
      if (!dateInput.value || dateInput.value < today) {
        dateInput.value = addDaysLocal(today, 3);
      }
    }
    panel.querySelector(".reminder-later-choice")?.focus?.();
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function removeCard(id) {
    document.querySelectorAll(`article[data-reminder-id="${CSS.escape(id)}"]`).forEach((el) => {
      const group = el.closest(".reminders-open-group");
      el.remove();
      if (group && !group.querySelector("article[data-reminder-id]")) group.remove();
    });
  }

  function setLaterControlsDisabled(panel, disabled) {
    panel?.querySelectorAll("button, input").forEach((el) => {
      el.disabled = disabled;
    });
  }

  function toast(message) {
    if (typeof TaskUtils?.showTaskToast === "function") TaskUtils.showTaskToast(message);
  }

  async function rescheduleTask(id, dueDate, noteRaw, btn, inFlight) {
    if (!dueDate) return;
    const today = getLocalDateString();
    if (dueDate < today) {
      showLaterError(id, btn, "Follow-up date cannot be in the past.");
      return;
    }

    const panel = laterPanelEl(id, btn);
    inFlight?.add(id);
    if (btn) btn.disabled = true;
    setLaterControlsDisabled(panel, true);
    clearLaterError(panel);

    const { error } =
      typeof TaskUtils?.rescheduleOpenTask === "function"
        ? await TaskUtils.rescheduleOpenTask(supabaseClient, {
            id,
            dueDate,
            note: noteRaw,
            dateLabel: formatDisplayDate(today),
          })
        : { error: new Error("Reschedule helper unavailable") };

    if (error) {
      inFlight?.delete(id);
      if (btn) btn.disabled = false;
      setLaterControlsDisabled(panel, false);
      AppError.handle(error, { context: { source: "rescheduleTask" } });
      return;
    }

    toast(`Follow-up set for ${formatDisplayDate(dueDate)}`);
    removeCard(id);
    TaskUtils.notifyTasksUpdated();
    await loadOpenBoard();
    inFlight?.delete(id);
  }

  async function completeTask(id, btn, inFlight) {
    inFlight?.add(id);
    btn.disabled = true;
    const { data: doneRow, error } = await supabaseClient
      .from("reminders")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        completed_by: currentAuth.session?.user?.id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();

    if (error || !doneRow?.id) {
      inFlight?.delete(id);
      btn.disabled = false;
      AppError.handle(error || new Error("Could not mark done — task may already be closed."), {
        context: { source: "completeTask" },
      });
      return;
    }

    removeCard(id);
    toast("Marked done");
    TaskUtils.notifyTasksUpdated();
    doneLoadedOnce = false;
    await loadOpenBoard();
    inFlight?.delete(id);
  }

  async function reopenTask(id, btn, inFlight) {
    inFlight?.add(id);
    btn.disabled = true;
    const { data: openRow, error } = await supabaseClient
      .from("reminders")
      .update({
        status: "open",
        completed_at: null,
        completed_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "done")
      .select("id")
      .maybeSingle();

    if (error || !openRow?.id) {
      inFlight?.delete(id);
      btn.disabled = false;
      AppError.handle(error || new Error("Could not reopen task."), {
        context: { source: "reopenTask" },
      });
      return;
    }

    removeCard(id);
    TaskUtils.notifyTasksUpdated();
    await loadOpenBoard();
    inFlight?.delete(id);
  }

  async function deleteTask(id, btn, inFlight) {
    inFlight?.add(id);
    await AdminDelete.execute({
      btn,
      auth: currentAuth,
      actionLabel: "delete tasks",
      confirmMessage: "Delete this task permanently?",
      deleteFn: () => supabaseClient.from("reminders").delete().eq("id", id),
      cacheScope: "operational",
      onSuccess: async () => {
        removeCard(id);
        TaskUtils.notifyTasksUpdated();
        doneLoadedOnce = false;
        await loadOpenBoard();
      },
      errorContext: { source: "deleteTask", id },
    });
    inFlight?.delete(id);
  }

  function renderTaskCard(row, { today, mode }) {
    const undated = !row.due_date;
    const isOverdue = mode === "open" && !undated && row.due_date < today;
    const isToday = mode === "open" && row.due_date === today;
    const isUrgent = mode === "open" && undated && row.priority === "high";
    const credit = TaskUtils.isCreditTask(row);

    const cardClass = [
      "reminder-card",
      credit ? "reminder-card--credit" : "",
      mode === "done" ? "reminder-card--done" : "",
      isOverdue ? "reminder-card--overdue" : "",
      isToday || isUrgent ? "reminder-card--today" : "",
      row.priority === "high" ? "reminder-card--high" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const dueLabel = undated
      ? isUrgent
        ? "Urgent"
        : "No date"
      : isOverdue
        ? `Overdue · ${formatDisplayDate(row.due_date)}`
        : isToday
          ? "Due today"
          : formatDisplayDate(row.due_date);

    const dueChipClass = isOverdue
      ? "reminder-chip reminder-chip--due-overdue"
      : isToday || isUrgent
        ? "reminder-chip reminder-chip--due-today"
        : "reminder-chip";

    const customerName =
      TaskUtils.customerNameOf(row) || customersById.get(row.credit_customer_id)?.customer_name || "";
    const mobile =
      row.credit_customers?.mobile || customersById.get(row.credit_customer_id)?.mobile || "";
    const amountDue =
      TaskUtils.amountDueOf(row) ??
      (customersById.get(row.credit_customer_id)
        ? Number(customersById.get(row.credit_customer_id).amount_due)
        : null);

    const notesHtml = row.notes
      ? `<p class="reminder-card-notes">${escapeHtml(row.notes)}</p>`
      : "";

    const amountChip =
      credit && amountDue != null && amountDue > 0
        ? `<span class="reminder-chip reminder-chip--amount">${escapeHtml(formatCurrency(amountDue))}</span>`
        : "";

    const customerHtml =
      credit && customerName
        ? `<a class="reminder-card-link" href="${escapeHtml(TaskUtils.customerHref(customerName))}">${escapeHtml(customerName)}${
            mobile ? ` · ${escapeHtml(mobile)}` : ""
          }</a>`
        : "";

    const tel = TaskUtils.telHref(mobile);
    const waText =
      typeof TaskUtils.waMessageForCustomer === "function"
        ? TaskUtils.waMessageForCustomer(customerName)
        : "";
    const wa = TaskUtils.waHref(mobile, waText);
    const contactHtml =
      credit && mode === "open" && (tel || wa)
        ? `<div class="reminder-card-contact">
            ${tel ? `<a class="button-secondary button-small" href="${escapeHtml(tel)}">Call</a>` : ""}
            ${wa ? `<a class="button-secondary button-small" href="${escapeHtml(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}
          </div>`
        : "";

    const metaBits = [
      `<span class="${dueChipClass}">${escapeHtml(dueLabel)}</span>`,
      amountChip,
      row.priority === "high"
        ? `<span class="reminder-chip reminder-chip--priority-high">High</span>`
        : row.priority === "low"
          ? `<span class="reminder-chip reminder-chip--priority-low">Low</span>`
          : "",
      mode === "done" && row.completed_at
        ? `<span class="reminder-chip">Done ${escapeHtml(formatDisplayDate(row.completed_at.slice(0, 10)))}</span>`
        : "",
    ].filter(Boolean);

    const deleteBtn =
      currentAuth?.role === "admin"
        ? `<button type="button" class="button-delete button-small" data-reminder-action="delete" data-id="${escapeHtml(row.id)}" title="Delete (admin)">Delete</button>`
        : "";

    const laterPanel =
      mode === "open" && typeof TaskUtils?.laterPanelHtml === "function"
        ? TaskUtils.laterPanelHtml(row.id, {
            credit,
            escapeHtml,
            forRemindersPage: true,
            today,
          })
        : "";

    const actions =
      mode === "open"
        ? `<button type="button" class="button-small" data-reminder-action="done" data-id="${escapeHtml(row.id)}">Done</button>
        <button type="button" class="button-secondary button-small" data-reminder-action="reschedule" data-id="${escapeHtml(row.id)}" data-days="3" title="Follow up in 3 days">+3 days</button>
        <button type="button" class="button-secondary button-small" data-reminder-action="later-toggle" data-id="${escapeHtml(row.id)}" aria-expanded="false">More…</button>${deleteBtn}`
        : `<button type="button" class="button-secondary button-small" data-reminder-action="reopen" data-id="${escapeHtml(row.id)}">Reopen</button>${deleteBtn}`;

    return `<article class="${cardClass}" data-reminder-id="${escapeHtml(row.id)}">
      <div class="reminder-card-main">
        <h3 class="reminder-card-title">${escapeHtml(row.title)}</h3>
        <div class="reminder-card-meta">${metaBits.join("")}</div>
        ${notesHtml}
        ${customerHtml}
        ${contactHtml}
      </div>
      <div class="reminder-card-actions">${actions}</div>
      ${laterPanel}
    </article>`;
  }

  function emptyState(title, copyHtml) {
    return `<div class="reminders-empty">
      <p class="reminders-empty-title">${escapeHtml(title)}</p>
      <p class="reminders-empty-copy muted">${copyHtml}</p>
    </div>`;
  }

  bindAppResume(
    () => {
      resetPaginationLoading(donePagination, document.getElementById("reminders-done-load-more"));
      if (isSettingsPanelActive("done")) void loadDoneTasks(true);
    },
    { match: () => document.body.classList.contains("reminders-page") }
  );
})();
