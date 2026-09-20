/**
 * Header notification inbox — same live feed as Dashboard, on every app page.
 */
(function (global) {
  const DAY_CLOSING_LOOKBACK_DAYS = 7;
  const TASKS_PREVIEW_COUNT = 3;
  const TASKS_FETCH_LIMIT = 24;
  const DSR_RATE_FIELD = { petrol: "petrol_rate", diesel: "diesel_rate" };
  const PANEL_HTML = `<section class="notifications-panel" aria-label="Notifications and alerts">
          <div class="notifications-panel-head">
            <h2 class="dashboard-section-title">Notifications</h2>
            <span id="notifications-count-badge" class="notifications-count-badge hidden" aria-live="polite">0 open</span>
          </div>
          <p class="notifications-panel-lead muted">Your reminders, day closing, night cash, readings, credit aging, payroll, attendance, expenses, and invoice alerts.</p>
          <div id="notifications-empty" class="notifications-empty">
            <p class="notifications-empty-title">All clear</p>
            <p class="notifications-empty-copy muted">No pending reminders, day closings, night cash, or alerts right now.</p>
          </div>
          <div id="notifications-feed" class="notifications-feed hidden" aria-live="polite">
            <div id="reminders-block" class="notif-group hidden">
              <div class="notif-group-head">
                <h3 class="notif-group-title">Tasks</h3>
                <a href="reminders.html" class="notif-group-link">Manage</a>
              </div>
              <div id="reminders-banners" class="notif-group-list"></div>
            </div>
            <div id="day-closing-block" class="notif-group hidden">
              <h3 class="notif-group-title">Day closing</h3>
              <div id="day-closing-banners" class="notif-group-list"></div>
            </div>
            <div class="dashboard-alerts dashboard-alerts-empty notif-group no-print" id="dashboard-alerts">
              <h3 class="notif-group-title">Alerts</h3>
              <div class="notif-group-list">
                <article id="low-stock-alert" class="notif-item notif-item--danger hidden" role="alert">
                  <div class="notif-item-body">
                    <span class="notif-item-label">Low stock</span>
                    <p class="notif-item-message" id="low-stock-message"></p>
                  </div>
                  <a href="meter-reading.html" id="low-stock-cta" class="button-secondary notif-item-cta">Meter reading</a>
                </article>
                <div id="smart-alerts-panel" class="smart-alerts-panel hidden" role="region" aria-label="Alerts and reminders"></div>
              </div>
            </div>
            <div id="pl-todo-banner" class="notif-item notif-item--info pl-todo-banner hidden" data-role="admin-only" aria-live="polite">
              <div class="notif-item-body">
                <span class="notif-item-label">Purchase cost</span>
                <p class="notif-item-message" id="pl-todo-text">
                  <span id="pl-todo-count">0</span> receipt day(s) still need a buying price. Enter pre-VAT ₹/KL to unlock accurate profit.
                </p>
              </div>
              <a href="meter-reading.html#purchase-cost" id="pl-todo-goto" class="button-secondary notif-item-cta pl-todo-goto">Enter cost</a>
            </div>
          </div>
        </section>`;

  let mounted = false;
  let loadPromise = null;
  let lastRefreshAt = 0;
  const STALE_MS = 45 * 1000;
  let remindersLoadGen = 0;
  let creditTotalRupees = null;
  let petrolVariation = null;
  let dieselVariation = null;
  let userId = null;

  function esc(value) {
    return typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "");
  }

  function isAdmin() {
    return (
      document.documentElement.classList.contains("role-admin") ||
      document.body.classList.contains("role-admin") ||
      (typeof global.readCachedUserRole === "function" && global.readCachedUserRole() === "admin")
    );
  }

  function creditCustomerDetailHref(customerName) {
    return `credit.html?${new URLSearchParams({ name: customerName || "" }).toString()}`;
  }

  function renderNotifItem({ type, label, message, meta, cta, href, role = "alert", dataNotif, expandHtml }) {
    const metaHtml = meta ? `<span class="notif-item-meta">${esc(meta)}</span>` : "";
    const ctaHtml =
      cta && href ? `<a href="${esc(href)}" class="button-secondary notif-item-cta">${esc(cta)}</a>` : "";
    const dataAttr = dataNotif ? ` data-notif="${esc(dataNotif)}"` : "";
    return `<article class="notif-item notif-item--${esc(type)}" role="${esc(role)}"${dataAttr}>
    <div class="notif-item-body">
      <span class="notif-item-label">${esc(label)}</span>
      <p class="notif-item-message">${esc(message)}</p>
      ${metaHtml}
      ${expandHtml || ""}
    </div>
    ${ctaHtml}
  </article>`;
  }

  function renderNotifCustomerExpand(rows, summaryLabel) {
    if (!rows?.length) return "";
    const items = rows
      .map(
        (r) => `<li class="notif-customer-row">
          <a class="notif-customer-link" href="${esc(r.href)}">${esc(r.name)}</a>
          <span class="notif-customer-detail">${esc(r.detail)}</span>
        </li>`
      )
      .join("");
    return `<details class="notif-customer-expand">
    <summary>${esc(summaryLabel)}</summary>
    <ul class="notif-customer-list">${items}</ul>
  </details>`;
  }

  function getAlertThresholds() {
    const t = PumpSettings.getAlertThresholds();
    return {
      petrol: t.petrol,
      diesel: t.diesel,
      highCredit: t.highCredit > 0 ? t.highCredit : 0,
      individualHighCredit: t.individualHighCredit > 0 ? t.individualHighCredit : 0,
      highVariation: t.highVariation > 0 ? t.highVariation : 0,
      dayClosingReminder: t.dayClosingReminder,
      dayClosingShortage: t.dayClosingShortage,
      shortageAlert: t.shortageAlert,
      surplusAlert: t.surplusAlert,
      nightCashAlert: t.nightCashAlert,
      nightCashMinAmount: t.nightCashMinAmount,
      missingMeterAlert: t.missingMeterAlert,
      missingRateAlert: t.missingRateAlert,
      missingDipAlert: t.missingDipAlert,
      staleCreditAlert: t.staleCreditAlert,
      staleCreditDays: t.staleCreditDays,
      unpaidSalaryAlert: t.unpaidSalaryAlert,
      attendanceAlert: t.attendanceAlert,
      expenseRatioAlert: t.expenseRatioAlert,
      expenseRatioPct: t.expenseRatioPct,
      missingInvoiceAlert: t.missingInvoiceAlert,
      missingInvoiceLookbackDays: t.missingInvoiceLookbackDays,
    };
  }

  function daysBetweenDateStrings(fromStr, toStr) {
    if (!fromStr || !toStr) return null;
    const from = new Date(`${fromStr}T00:00:00`);
    const to = new Date(`${toStr}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    return Math.floor((to.getTime() - from.getTime()) / 86400000);
  }

  function isPastLocalHm(hhmm) {
    const parts = String(hhmm || "22:00").split(":");
    const h = Number(parts[0]);
    const m = Number(parts[1] || 0);
    if (!Number.isFinite(h)) return false;
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() >= h * 60 + (Number.isFinite(m) ? m : 0);
  }

  function currentSalaryMonthValue(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function approxNetMonthlySalary(emp) {
    const gross = Math.max(0, Number(emp?.monthly_salary ?? 0));
    const pf = Math.max(0, Number(emp?.pf_contribution ?? 0));
    return Math.max(0, gross - Math.min(pf, gross));
  }

  function rateFromDsrRows(rows, product) {
    const field = DSR_RATE_FIELD[product];
    const entry = (rows ?? []).find((row) => normalizeProduct(row.product) === product);
    const num = Number(entry?.[field] ?? 0);
    if (!Number.isFinite(num) || num <= 0) return null;
    return { rate: num, date: entry.date ?? null };
  }

  async function fetchLastDsrRate(product) {
    const rateField = DSR_RATE_FIELD[product];
    if (!rateField) return null;
    const { data, error } = await global.supabaseClient
      .from("dsr")
      .select(`date, ${rateField}`)
      .eq("product", product)
      .not(rateField, "is", null)
      .order("date", { ascending: false })
      .limit(30);
    if (error) {
      AppError.report(error, { context: "notifications.fetchLastDsrRate", product });
      return null;
    }
    for (const row of data ?? []) {
      const num = Number(row[rateField]);
      if (Number.isFinite(num) && num > 0) return { rate: num, date: row.date ?? null };
    }
    return null;
  }

  async function resolveRatesForDate(selectedDate, rows) {
    const petrolOnDate = rateFromDsrRows(rows, "petrol");
    const dieselOnDate = rateFromDsrRows(rows, "diesel");
    let petrolRate = petrolOnDate?.rate ?? null;
    let dieselRate = dieselOnDate?.rate ?? null;
    const [lastPetrol, lastDiesel] = await Promise.all([
      !petrolRate ? fetchLastDsrRate("petrol") : Promise.resolve(null),
      !dieselRate ? fetchLastDsrRate("diesel") : Promise.resolve(null),
    ]);
    if (!petrolRate && lastPetrol) petrolRate = lastPetrol.rate;
    if (!dieselRate && lastDiesel) dieselRate = lastDiesel.rate;
    return { petrolRate, dieselRate };
  }

  function dipStockOnDate(stockData, dsrData, product, dateStr) {
    const prod = normalizeProduct(product);
    const stockRows = (stockData ?? []).filter(
      (row) => row.date === dateStr && normalizeProduct(row.product) === prod
    );
    const hasDipRow = stockRows.some((row) => row.dip_stock != null && Number.isFinite(Number(row.dip_stock)));
    if (!hasDipRow) return null;
    return {
      stock: sumByProduct(stockRows, prod, (row) => Number(row.dip_stock ?? 0)),
    };
  }

  function countVisibleNotificationItems() {
    let count = 0;
    const reminders = document.getElementById("reminders-banners");
    if (reminders) count += reminders.querySelectorAll(".notif-item").length;
    const dayClosing = document.getElementById("day-closing-banners");
    if (dayClosing) count += dayClosing.querySelectorAll(".notif-item:not(.notif-item--success)").length;
    const alerts = document.getElementById("dashboard-alerts");
    if (alerts && !alerts.classList.contains("dashboard-alerts-empty")) {
      const lowStock = document.getElementById("low-stock-alert");
      if (lowStock && !lowStock.classList.contains("hidden")) count += 1;
      const smartPanel = document.getElementById("smart-alerts-panel");
      if (smartPanel && !smartPanel.classList.contains("hidden")) {
        count += smartPanel.querySelectorAll(".notif-item").length;
      }
    }
    const plTodo = document.getElementById("pl-todo-banner");
    if (plTodo && !plTodo.classList.contains("hidden")) count += 1;
    return count;
  }

  function updateBadge() {
    const feed = document.getElementById("notifications-feed");
    const empty = document.getElementById("notifications-empty");
    const countBadge = document.getElementById("notifications-count-badge");
    const navBadge = document.getElementById("notifications-nav-badge");
    const remindersHasItems = document.getElementById("reminders-block") &&
      !document.getElementById("reminders-block").classList.contains("hidden");
    const dayHasItems = document.getElementById("day-closing-block") &&
      !document.getElementById("day-closing-block").classList.contains("hidden");
    const alerts = document.getElementById("dashboard-alerts");
    const alertsVisible = alerts && !alerts.classList.contains("dashboard-alerts-empty");
    const plTodo = document.getElementById("pl-todo-banner");
    const plVisible = plTodo && !plTodo.classList.contains("hidden");
    const hasAny = Boolean(remindersHasItems || dayHasItems || alertsVisible || plVisible);
    feed?.classList.toggle("hidden", !hasAny);
    empty?.classList.toggle("hidden", hasAny);
    const openCount = countVisibleNotificationItems();
    if (countBadge) {
      if (openCount > 0) {
        countBadge.textContent = openCount === 1 ? "1 open" : `${openCount} open`;
        countBadge.classList.remove("hidden");
      } else {
        countBadge.classList.add("hidden");
      }
    }
    if (navBadge) {
      if (openCount > 0) {
        navBadge.textContent = String(openCount);
        navBadge.classList.remove("hidden");
        navBadge.setAttribute("aria-label", `${openCount} open notification${openCount === 1 ? "" : "s"}`);
      } else {
        navBadge.classList.add("hidden");
        navBadge.removeAttribute("aria-label");
      }
    }
  }

  function updateAlertsVisibility() {
    const container = document.getElementById("dashboard-alerts");
    if (!container) return;
    const lowStock = document.getElementById("low-stock-alert");
    const smartPanel = document.getElementById("smart-alerts-panel");
    const hasVisible =
      (lowStock && !lowStock.classList.contains("hidden")) ||
      (smartPanel && !smartPanel.classList.contains("hidden") && smartPanel.children.length > 0);
    container.classList.toggle("dashboard-alerts-empty", !hasVisible);
    updateBadge();
  }

  function updateLowStock(petrolStock, dieselStock) {
    const wrap = document.getElementById("low-stock-alert");
    const msg = document.getElementById("low-stock-message");
    if (!wrap || !msg) return;
    const th = getAlertThresholds();
    const parts = [];
    if (Number.isFinite(petrolStock) && petrolStock < th.petrol) {
      parts.push(`Petrol ${formatQuantity(petrolStock)} L (below ${formatQuantity(th.petrol)} L)`);
    }
    if (Number.isFinite(dieselStock) && dieselStock < th.diesel) {
      parts.push(`Diesel ${formatQuantity(dieselStock)} L (below ${formatQuantity(th.diesel)} L)`);
    }
    wrap.classList.toggle("hidden", parts.length === 0);
    if (parts.length) msg.textContent = parts.join(" · ");
    updateAlertsVisibility();
  }

  function emitReminders(rows, todayStr) {
    document.dispatchEvent(
      new CustomEvent("app-notifications:reminders", { detail: { rows: rows || [], todayStr } })
    );
  }

  function taskAddDays(yyyyMmDd, days) {
    if (typeof addDaysToDateString === "function") return addDaysToDateString(yyyyMmDd, days);
    if (typeof TaskUtils?.addDaysYmd === "function") return TaskUtils.addDaysYmd(yyyyMmDd, days);
    const [y, m, d] = String(yyyyMmDd || "").slice(0, 10).split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + (Number(days) || 0));
    return typeof toLocalDateString === "function" ? toLocalDateString(dt) : dt.toISOString().slice(0, 10);
  }

  function taskOutstandingLabel(row) {
    if (!TaskUtils?.isCreditTask(row)) return "";
    const amountDue = TaskUtils.amountDueOf(row);
    if (amountDue == null || amountDue <= 0) return "";
    return `Outstanding ${formatCurrency(amountDue)}`;
  }

  function taskContactHtml(row) {
    if (!TaskUtils?.isCreditTask(row)) return "";
    const mobile = row.credit_customers?.mobile || "";
    const customerName = TaskUtils.customerNameOf(row);
    const tel = TaskUtils.telHref(mobile);
    const waText =
      typeof TaskUtils.waMessageForCustomer === "function" ? TaskUtils.waMessageForCustomer(customerName) : "";
    const wa = TaskUtils.waHref(mobile, waText);
    if (!tel && !wa) return "";
    return `<div class="task-dash-contact">
    ${tel ? `<a class="button-secondary button-small" href="${esc(tel)}">Call</a>` : ""}
    ${wa ? `<a class="button-secondary button-small" href="${esc(wa)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ""}
  </div>`;
  }

  function laterPanel(id, credit) {
    if (typeof TaskUtils?.laterPanelHtml === "function") {
      return TaskUtils.laterPanelHtml(id, { credit, escapeHtml, today: getLocalDateString() });
    }
    return "";
  }

  function buildTaskHtml(row, todayStr) {
    const undated = !row.due_date;
    const overdue = !undated && row.due_date < todayStr;
    const isHigh = row.priority === "high";
    const isCredit = TaskUtils.isCreditTask(row);
    const type = overdue || isHigh ? "danger" : "warning";
    const label = overdue
      ? isCredit
        ? "Credit call overdue"
        : "Overdue"
      : undated
        ? "Urgent todo"
        : isCredit
          ? "Credit collection"
          : isHigh
            ? "High priority"
            : "Due today";
    const customerName = TaskUtils.customerNameOf(row);
    const outstanding = taskOutstandingLabel(row);
    const when = undated ? "No date" : overdue ? `Overdue · ${formatDisplayDate(row.due_date)}` : "Due today";
    const href = TaskUtils.customerHref(customerName);
    const accountLink = customerName
      ? `<a class="task-dash-account" href="${esc(href)}">Account</a>`
      : `<a class="task-dash-account" href="reminders.html">Open</a>`;
    return `<article class="notif-item notif-item--task notif-item--${type}" role="alert" data-reminder-id="${esc(row.id)}">
    <div class="notif-item-body">
      <span class="notif-item-label">${esc(label)}</span>
      <p class="notif-item-message">${esc(row.title)}</p>
      ${outstanding ? `<p class="notif-item-amount">${esc(outstanding)}</p>` : ""}
      <span class="notif-item-meta">${esc(when)}${customerName ? ` · ${esc(customerName)}` : ""} · ${accountLink}</span>
      ${taskContactHtml(row)}
    </div>
    <div class="notif-item-actions task-action-bar">
      <button type="button" class="button-secondary button-small reminder-done-btn" data-reminder-id="${esc(row.id)}">Done</button>
      <button type="button" class="button-secondary button-small reminder-later-btn" data-reminder-later="reschedule" data-reminder-id="${esc(row.id)}" data-days="3" title="Follow up in 3 days">+3 days</button>
      <button type="button" class="button-secondary button-small reminder-later-toggle" data-reminder-id="${esc(row.id)}" aria-expanded="false">More…</button>
    </div>
    ${laterPanel(row.id, isCredit)}
  </article>`;
  }

  function renderTaskGroupHtml(rows, todayStr) {
    if (!rows.length) return "";
    const preview = rows.slice(0, TASKS_PREVIEW_COUNT);
    const more = rows.slice(TASKS_PREVIEW_COUNT);
    return TaskUtils.wrapMoreCollapse(
      preview.map((r) => buildTaskHtml(r, todayStr)).join(""),
      more.map((r) => buildTaskHtml(r, todayStr)).join(""),
      more.length,
      { escapeHtml }
    );
  }

  function renderReminders(rows, todayStr = getLocalDateString()) {
    const block = document.getElementById("reminders-block");
    const container = document.getElementById("reminders-banners");
    if (!block || !container) return;
    if (!rows.length || typeof TaskUtils?.splitCreditTodo !== "function") {
      block.classList.add("hidden");
      container.innerHTML = "";
      return;
    }
    const { credit, todo } = TaskUtils.splitCreditTodo(rows);
    const parts = [];
    if (credit.length) {
      parts.push(
        `<div class="tasks-dash-group"><h4 class="tasks-dash-group-title">Credit collection</h4>${renderTaskGroupHtml(credit, todayStr)}</div>`
      );
    }
    if (todo.length) {
      parts.push(
        `<div class="tasks-dash-group"><h4 class="tasks-dash-group-title">Todo</h4>${renderTaskGroupHtml(todo, todayStr)}</div>`
      );
    }
    container.innerHTML = parts.join("");
    block.classList.remove("hidden");
    bindReminderActions(container);
  }

  async function refreshReminders() {
    if (typeof TaskUtils?.sortTasks !== "function") {
      renderReminders([]);
      updateBadge();
      return [];
    }
    const todayStr = getLocalDateString();
    const loadGen = ++remindersLoadGen;
    const { data, error } = await global.supabaseClient
      .from("reminders")
      .select(
        "id, title, notes, due_date, priority, reminder_type, credit_customer_id, credit_customers(customer_name, mobile, amount_due)"
      )
      .eq("status", "open")
      .or(`due_date.lte.${todayStr},and(due_date.is.null,priority.eq.high)`)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(TASKS_FETCH_LIMIT);
    if (loadGen !== remindersLoadGen) return [];
    if (error) {
      if (error.code !== "42P01" && error.code !== "PGRST205") {
        AppError.report(error, { context: "notifications.refreshReminders" });
      }
      renderReminders([]);
      emitReminders([], todayStr);
      updateBadge();
      return [];
    }
    const rows = TaskUtils.sortTasks(data || [], todayStr);
    renderReminders(rows, todayStr);
    emitReminders(rows, todayStr);
    updateBadge();
    return rows;
  }

  function bindReminderActions(container) {
    if (!container || container.dataset.reminderDoneBound) return;
    container.dataset.reminderDoneBound = "1";
    const inFlight = new Set();
    const taskCardEl = (fromEl) => fromEl?.closest?.("article[data-reminder-id]") || null;
    const laterPanelFor = (card, id) => card?.querySelector(`[data-later-for="${CSS.escape(id)}"]`);
    const setDisabled = (panel, disabled) => {
      panel?.querySelectorAll("button, input").forEach((el) => {
        el.disabled = disabled;
      });
    };

    container.addEventListener("click", async (e) => {
      const laterToggle = e.target.closest?.(".reminder-later-toggle");
      if (laterToggle) {
        e.preventDefault();
        const id = laterToggle.getAttribute("data-reminder-id");
        const card = taskCardEl(laterToggle);
        const panel = laterPanelFor(card, id);
        if (!id || !panel) return;
        const willOpen = panel.hidden;
        container.querySelectorAll(".task-later-panel").forEach((p) => {
          p.hidden = true;
        });
        container.querySelectorAll(".reminder-later-toggle").forEach((b) => b.setAttribute("aria-expanded", "false"));
        if (!willOpen) return;
        panel.hidden = false;
        laterToggle.setAttribute("aria-expanded", "true");
        const today = getLocalDateString();
        const dateInput = panel.querySelector("[data-later-date]");
        if (dateInput) {
          dateInput.min = today;
          if (!dateInput.value || dateInput.value < today) dateInput.value = taskAddDays(today, 3);
        }
        return;
      }

      const laterBtn = e.target.closest?.(".reminder-later-btn");
      if (laterBtn) {
        e.preventDefault();
        const id = laterBtn.getAttribute("data-reminder-id");
        const action = laterBtn.getAttribute("data-reminder-later");
        if (!id || !action || inFlight.has(id)) return;
        const card = taskCardEl(laterBtn);
        const panel = laterPanelFor(card, id);
        const errEl = panel?.querySelector?.("[data-later-error]");
        if (action === "cancel") {
          if (panel) panel.hidden = true;
          return;
        }
        let dueDate = "";
        const note = laterBtn.getAttribute("data-note") || "";
        if (action === "reschedule") {
          const days = Number(laterBtn.getAttribute("data-days"));
          if (!Number.isFinite(days) || days < 1) return;
          dueDate = taskAddDays(getLocalDateString(), days);
        } else if (action === "reschedule-pick") {
          dueDate = panel?.querySelector?.("[data-later-date]")?.value || "";
          if (!dueDate) {
            if (errEl) {
              errEl.textContent = "Pick a follow-up date.";
              errEl.hidden = false;
            }
            return;
          }
        } else return;
        const today = getLocalDateString();
        if (dueDate < today) {
          if (errEl) {
            errEl.textContent = "Follow-up date cannot be in the past.";
            errEl.hidden = false;
          }
          return;
        }
        inFlight.add(id);
        laterBtn.disabled = true;
        setDisabled(panel, true);
        const { error } =
          typeof TaskUtils?.rescheduleOpenTask === "function"
            ? await TaskUtils.rescheduleOpenTask(global.supabaseClient, {
                id,
                dueDate,
                note,
                dateLabel: formatDisplayDate(today),
              })
            : { error: new Error("Reschedule helper unavailable") };
        if (error) {
          inFlight.delete(id);
          laterBtn.disabled = false;
          setDisabled(panel, false);
          AppError.handle(error, { context: { source: "notificationsReschedule" } });
          return;
        }
        TaskUtils.notifyTasksUpdated?.();
        await refreshReminders();
        inFlight.delete(id);
        return;
      }

      const btn = e.target.closest?.(".reminder-done-btn");
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute("data-reminder-id");
      if (!id || inFlight.has(id)) return;
      inFlight.add(id);
      btn.disabled = true;
      const { data: doneRow, error } = await global.supabaseClient
        .from("reminders")
        .update({
          status: "done",
          completed_at: new Date().toISOString(),
          completed_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "open")
        .select("id")
        .maybeSingle();
      if (error || !doneRow?.id) {
        inFlight.delete(id);
        btn.disabled = false;
        AppError.handle(error || new Error("Could not mark done — task may already be closed."), {
          context: { source: "notificationsCompleteReminder" },
        });
        return;
      }
      TaskUtils.showTaskToast?.("Marked done");
      TaskUtils.notifyTasksUpdated?.();
      await refreshReminders();
      inFlight.delete(id);
    });
  }

  async function fetchDayClosingWindow() {
    const today = new Date();
    const todayStr = formatDateInput(today);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - DAY_CLOSING_LOOKBACK_DAYS);
    const startStr = formatDateInput(startDate);
    const th = getAlertThresholds();
    if (!th.dayClosingReminder && !th.shortageAlert && !th.surplusAlert) {
      return { data: [], error: null, todayStr, startStr };
    }
    const { data, error } = await global.supabaseClient
      .from("day_closing")
      .select("date, short_today, certified")
      .gte("date", startStr)
      .lte("date", todayStr);
    return { data: data ?? [], error, todayStr, startStr };
  }

  async function refreshDayClosing(prefetched = null) {
    const block = document.getElementById("day-closing-block");
    const container = document.getElementById("day-closing-banners");
    if (!block || !container) return;
    const th = getAlertThresholds();
    if (!th.dayClosingReminder) {
      block.classList.add("hidden");
      container.innerHTML = "";
      updateBadge();
      return;
    }
    const windowResult = prefetched || (await fetchDayClosingWindow());
    if (windowResult.error) {
      AppError.report(windowResult.error, { context: "notifications.refreshDayClosing" });
      block.classList.add("hidden");
      container.innerHTML = "";
      updateBadge();
      return;
    }
    const closedByDate = new Map((windowResult.data ?? []).map((r) => [r.date, r]));
    const todayStr = windowResult.todayStr || getLocalDateString();
    const datesToShow = [];
    const today = new Date();
    for (let i = 0; i <= DAY_CLOSING_LOOKBACK_DAYS; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      datesToShow.push(formatDateInput(d));
    }
    function bannerForDate(dateStr, showDone) {
      const row = closedByDate.get(dateStr);
      const done = !!row;
      const certified = !!row?.certified;
      if (!showDone && done && certified) return null;
      const label = formatDisplayDate(dateStr);
      const isToday = dateStr === todayStr;
      const dayLabel = isToday ? "Today" : label;
      const adminUser = isAdmin();
      if (done && !certified) {
        return renderNotifItem({
          type: "warning",
          label: dayLabel,
          message: "Day closing awaiting acknowledgment",
          meta: adminUser
            ? isToday
              ? "Saved — acknowledge tonight's statement on Day closing."
              : "Saved but not yet certified. Open Day closing to acknowledge."
            : isToday
              ? "Saved — waiting for admin acknowledgment."
              : "Saved but not yet certified. Waiting for admin acknowledgment.",
          cta: adminUser ? "Acknowledge" : "View",
          href: `day-closing.html?date=${encodeURIComponent(dateStr)}`,
        });
      }
      if (done) {
        return renderNotifItem({
          type: "success",
          label: "Done",
          message: `Day closing complete for ${isToday ? "today" : label}`,
          role: "status",
        });
      }
      return renderNotifItem({
        type: isToday ? "warning" : "danger",
        label: dayLabel,
        message: "Day closing not done",
        meta: isToday
          ? "Finish tonight's cash, PhonePe, and short before you leave."
          : "Past day still open — fill it to keep DSR and cash aligned.",
        cta: "Fill day closing",
        href: `day-closing.html?date=${encodeURIComponent(dateStr)}`,
      });
    }
    const parts = [bannerForDate(datesToShow[0], true)];
    datesToShow.slice(1).forEach((dateStr) => {
      const html = bannerForDate(dateStr, false);
      if (html) parts.push(html);
    });
    const visible = parts.filter(Boolean);
    container.innerHTML = visible.join("");
    block.classList.toggle("hidden", visible.length === 0);
    updateBadge();
  }

  function syncCreditTotal(total) {
    creditTotalRupees = Number.isFinite(Number(total)) ? Number(total) : null;
    const panel = document.getElementById("smart-alerts-panel");
    if (!panel) return;
    const th = getAlertThresholds();
    const existing = panel.querySelector('[data-notif="credit"]');
    const shouldShow =
      th.highCredit > 0 && Number.isFinite(creditTotalRupees) && creditTotalRupees > th.highCredit;
    if (!shouldShow) {
      existing?.remove();
      if (!panel.querySelector(".notif-item")) {
        panel.classList.add("hidden");
        panel.innerHTML = "";
      }
      updateAlertsVisibility();
      return;
    }
    const html = renderNotifItem({
      type: "warning",
      label: "Total high credit",
      message: `${formatCurrency(creditTotalRupees)} is above your portfolio limit (${formatCurrency(th.highCredit)}).`,
      cta: "Open credit",
      href: "credit.html#outstanding",
      dataNotif: "credit",
    });
    if (existing) existing.outerHTML = html;
    else {
      panel.insertAdjacentHTML("afterbegin", html);
      panel.classList.remove("hidden");
    }
    updateAlertsVisibility();
  }

  async function refreshSmartAlerts(options = {}) {
    const panel = document.getElementById("smart-alerts-panel");
    if (!panel) return;
    const alerts = [];
    const th = getAlertThresholds();
    const todayStr = options.todayStr || getLocalDateString();
    const driveEnabled = PumpSettings.getCachedSync()?.integrations?.googleDrive?.enabled === true;
    const adminUser = isAdmin();

    if (th.highCredit > 0 && Number.isFinite(creditTotalRupees) && creditTotalRupees > th.highCredit) {
      alerts.push({
        type: "warning",
        label: "Total high credit",
        message: `${formatCurrency(creditTotalRupees)} is above your portfolio limit (${formatCurrency(th.highCredit)}).`,
        cta: "Open credit",
        href: "credit.html#outstanding",
        dataNotif: "credit",
      });
    }

    const needClosingFetch = (th.shortageAlert || th.surplusAlert) && !Array.isArray(options.closingRows);
    const needDsrToday = th.missingMeterAlert || th.missingRateAlert || th.missingDipAlert;
    const needStockToday = th.missingDipAlert || th.highVariation > 0 || th.petrol > 0 || th.diesel > 0;
    const needCreditList = th.staleCreditAlert || th.individualHighCredit > 0;
    const salaryMonth = currentSalaryMonthValue();
    const monthRange = getMonthRange(new Date().getFullYear(), new Date().getMonth());
    const invoiceStart = (() => {
      const d = new Date(`${todayStr}T00:00:00`);
      d.setDate(d.getDate() - (Number(th.missingInvoiceLookbackDays) || 30));
      return formatDateInput(d);
    })();

    const [
      closingRes,
      nightRes,
      dsrRes,
      stockRes,
      creditListRes,
      rosterRes,
      attendanceRes,
      salaryEmpRes,
      salaryPayRes,
      mtdDsrRes,
      mtdExpenseRes,
      missingInvoiceRes,
      creditTotalRes,
    ] = await Promise.all([
      needClosingFetch
        ? global.supabaseClient.from("day_closing").select("short_today").eq("date", todayStr).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      th.nightCashAlert
        ? global.supabaseClient.rpc("get_night_cash_available")
        : Promise.resolve({ data: null, error: null }),
      needDsrToday
        ? global.supabaseClient
            .from("dsr")
            .select("date, product, petrol_rate, diesel_rate, stock, dip_reading")
            .eq("date", todayStr)
        : Promise.resolve({ data: [], error: null }),
      needStockToday
        ? global.supabaseClient.rpc("get_dsr_stock_range", { p_start: todayStr, p_end: todayStr })
        : Promise.resolve({ data: [], error: null }),
      needCreditList
        ? global.supabaseClient.rpc("get_outstanding_credit_list_as_of", { p_date: todayStr })
        : Promise.resolve({ data: [], error: null }),
      th.attendanceAlert
        ? global.supabaseClient.rpc("list_employees_roster")
        : Promise.resolve({ data: [], error: null }),
      th.attendanceAlert
        ? global.supabaseClient.from("employee_attendance").select("id, employee_id").eq("date", todayStr)
        : Promise.resolve({ data: [], error: null }),
      th.unpaidSalaryAlert && adminUser
        ? global.supabaseClient.rpc("list_employees_salary")
        : Promise.resolve({ data: [], error: null }),
      th.unpaidSalaryAlert && adminUser
        ? global.supabaseClient.from("salary_payments").select("employee_id, amount").eq("salary_month", salaryMonth)
        : Promise.resolve({ data: [], error: null }),
      th.expenseRatioAlert
        ? global.supabaseClient
            .from("dsr")
            .select("product, total_sales, testing, petrol_rate, diesel_rate")
            .gte("date", monthRange.start)
            .lte("date", monthRange.end)
        : Promise.resolve({ data: [], error: null }),
      th.expenseRatioAlert
        ? global.supabaseClient.from("expenses").select("amount").gte("date", monthRange.start).lte("date", monthRange.end)
        : Promise.resolve({ data: [], error: null }),
      th.missingInvoiceAlert && driveEnabled
        ? global.supabaseClient
            .from("dsr")
            .select("date, product, receipts, invoice_document_id")
            .gt("receipts", 0)
            .is("invoice_document_id", null)
            .gte("date", invoiceStart)
            .lte("date", todayStr)
        : Promise.resolve({ data: [], error: null }),
      creditTotalRupees == null
        ? global.supabaseClient.rpc("get_open_credit_as_of", { p_date: todayStr })
        : Promise.resolve({ data: creditTotalRupees, error: null }),
    ]);

    if (!Number.isFinite(creditTotalRupees) && !creditTotalRes.error) {
      const value = Number(creditTotalRes.data);
      if (Number.isFinite(value)) creditTotalRupees = value;
    }
    if (th.highCredit > 0 && Number.isFinite(creditTotalRupees) && creditTotalRupees > th.highCredit) {
      if (!alerts.some((a) => a.dataNotif === "credit")) {
        alerts.unshift({
          type: "warning",
          label: "Total high credit",
          message: `${formatCurrency(creditTotalRupees)} is above your portfolio limit (${formatCurrency(th.highCredit)}).`,
          cta: "Open credit",
          href: "credit.html#outstanding",
          dataNotif: "credit",
        });
      }
    }

    const dsrToday = dsrRes.error ? [] : dsrRes.data ?? [];
    const stockToday = stockRes.error ? [] : stockRes.data ?? [];
    if (petrolVariation == null && stockToday.length) {
      petrolVariation = sumByProduct(stockToday, "petrol", (row) => row.variation);
      dieselVariation = sumByProduct(stockToday, "diesel", (row) => row.variation);
    }
    const petrolStock = dipStockOnDate(stockToday, dsrToday, "petrol", todayStr)?.stock;
    const dieselStock = dipStockOnDate(stockToday, dsrToday, "diesel", todayStr)?.stock;
    updateLowStock(petrolStock, dieselStock);

    if (th.highVariation > 0) {
      const petrolVar = Math.abs(Number(petrolVariation));
      const dieselVar = Math.abs(Number(dieselVariation));
      const petrolOver = Number.isFinite(petrolVar) && petrolVar > th.highVariation;
      const dieselOver = Number.isFinite(dieselVar) && dieselVar > th.highVariation;
      if (petrolOver || dieselOver) {
        const parts = [];
        if (petrolOver) parts.push(`Petrol ${formatQuantity(petrolVar)} L`);
        if (dieselOver) parts.push(`Diesel ${formatQuantity(dieselVar)} L`);
        alerts.push({
          type: "warning",
          label: "Stock variation",
          message: `Above ${formatQuantity(th.highVariation)} L: ${parts.join(", ")}. Verify meter readings.`,
          cta: "View DSR",
          href: "dsr.html",
        });
      }
    }

    let shortAmount = null;
    if (th.shortageAlert || th.surplusAlert) {
      if (Array.isArray(options.closingRows)) {
        const row = options.closingRows.find((r) => r.date === todayStr);
        if (row?.short_today != null) shortAmount = Number(row.short_today);
      } else if (!closingRes.error && closingRes.data?.short_today != null) {
        shortAmount = Number(closingRes.data.short_today);
      }
    }
    if (shortAmount != null) {
      const thresholdLabel =
        th.dayClosingShortage > 0 ? `your threshold (${formatCurrency(th.dayClosingShortage)})` : "zero";
      if (th.shortageAlert && PumpSettings.isDayClosingShortage(shortAmount)) {
        alerts.push({
          type: "warning",
          label: "Cash shortage",
          message: `Today's short is ${formatCurrency(shortAmount)} (above ${thresholdLabel}). Review night cash and PhonePe.`,
          cta: "Day closing",
          href: `day-closing.html?date=${encodeURIComponent(todayStr)}`,
        });
      } else if (th.surplusAlert && PumpSettings.isDayClosingSurplus(shortAmount)) {
        alerts.push({
          type: "warning",
          label: "Cash surplus",
          message: `Today's closing is over by ${formatCurrency(Math.abs(shortAmount))} (beyond ${thresholdLabel}). Check PhonePe and night cash.`,
          cta: "Day closing",
          href: `day-closing.html?date=${encodeURIComponent(todayStr)}`,
        });
      }
    }

    if (th.nightCashAlert && !nightRes.error && nightRes.data) {
      const nightTotal = Number(nightRes.data.total_available ?? 0);
      const nightDays = Number(nightRes.data.day_count ?? 0);
      const minAmount = Number(th.nightCashMinAmount) || 0;
      if (nightDays > 0 && nightTotal > 0 && nightTotal >= minAmount) {
        const rangeHint =
          nightRes.data.from_date && nightRes.data.to_date
            ? nightRes.data.from_date === nightRes.data.to_date
              ? formatDisplayDate(nightRes.data.from_date)
              : `${formatDisplayDate(nightRes.data.from_date)} – ${formatDisplayDate(nightRes.data.to_date)}`
            : "";
        alerts.push({
          type: "warning",
          label: "Night cash at pump",
          message: `${formatCurrency(nightTotal)} across ${nightDays} day${nightDays === 1 ? "" : "s"} still uncollected${rangeHint ? ` (${rangeHint})` : ""}.`,
          cta: "Collect",
          href: "day-closing.html#register",
        });
      }
    }

    const hasPetrolMeter = dsrToday.some((row) => normalizeProduct(row.product) === "petrol");
    const hasDieselMeter = dsrToday.some((row) => normalizeProduct(row.product) === "diesel");
    const missingMeter = [];
    if (th.missingMeterAlert) {
      if (!hasPetrolMeter) missingMeter.push("Petrol");
      if (!hasDieselMeter) missingMeter.push("Diesel");
      if (missingMeter.length) {
        alerts.push({
          type: "danger",
          label: "Meter reading",
          message: `No reading for today (${missingMeter.join(" · ")}). Enter nozzle totals before day closing.`,
          cta: "Enter reading",
          href: `meter-reading.html?date=${encodeURIComponent(todayStr)}`,
        });
      }
    }
    if (th.missingRateAlert) {
      const rates = await resolveRatesForDate(todayStr, dsrToday);
      const missingRate = [];
      if (!(Number.isFinite(rates.petrolRate) && rates.petrolRate > 0)) missingRate.push("Petrol");
      if (!(Number.isFinite(rates.dieselRate) && rates.dieselRate > 0)) missingRate.push("Diesel");
      if (missingRate.length) {
        alerts.push({
          type: "warning",
          label: "Selling rate",
          message: `No selling rate for ${missingRate.join(" · ")}. Enter today's rate so sale value is correct.`,
          cta: "Enter rate",
          href: `meter-reading.html?date=${encodeURIComponent(todayStr)}`,
        });
      }
    }
    if (th.missingDipAlert) {
      const meterMissingPetrol = th.missingMeterAlert ? missingMeter.includes("Petrol") : !hasPetrolMeter;
      const meterMissingDiesel = th.missingMeterAlert ? missingMeter.includes("Diesel") : !hasDieselMeter;
      const missingDip = [];
      if (!meterMissingPetrol && !dipStockOnDate(stockToday, dsrToday, "petrol", todayStr)) missingDip.push("Petrol");
      if (!meterMissingDiesel && !dipStockOnDate(stockToday, dsrToday, "diesel", todayStr)) missingDip.push("Diesel");
      if (missingDip.length) {
        alerts.push({
          type: "warning",
          label: "Dip stock",
          message: `No dip for today (${missingDip.join(" · ")}). Tank levels and variation need a current reading.`,
          cta: "Enter dip",
          href: `meter-reading.html?date=${encodeURIComponent(todayStr)}`,
        });
      }
    }

    if (th.staleCreditAlert || th.individualHighCredit > 0) {
      if (!creditListRes.error) {
        const creditRows = creditListRes.data ?? [];
        if (th.individualHighCredit > 0) {
          const overLimit = creditRows
            .filter((row) => Number(row.amount_due_as_of ?? 0) > th.individualHighCredit)
            .sort((a, b) => Number(b.amount_due_as_of ?? 0) - Number(a.amount_due_as_of ?? 0));
          if (overLimit.length) {
            alerts.push({
              type: "warning",
              label: "Individual high credit",
              message: `${overLimit.length} customer${overLimit.length === 1 ? "" : "s"} above ${formatCurrency(th.individualHighCredit)} (${formatCurrency(overLimit.reduce((s, r) => s + Number(r.amount_due_as_of ?? 0), 0))} total).`,
              cta: "Outstanding",
              href: "credit.html#outstanding",
              dataNotif: "credit-individual",
              expandHtml: renderNotifCustomerExpand(
                overLimit.map((row) => ({
                  name: row.customer_name || "Customer",
                  href: creditCustomerDetailHref(row.customer_name),
                  detail: `${formatCurrency(Number(row.amount_due_as_of ?? 0))} · over by ${formatCurrency(Number(row.amount_due_as_of ?? 0) - th.individualHighCredit)}`,
                })),
                `Show ${overLimit.length} customer${overLimit.length === 1 ? "" : "s"}`
              ),
            });
          }
        }
        if (th.staleCreditAlert) {
          const staleDays = Number(th.staleCreditDays) || 30;
          const stale = creditRows
            .filter((row) => {
              const due = Number(row.amount_due_as_of ?? 0);
              if (!(due > 0)) return false;
              const age = daysBetweenDateStrings(row.last_payment_date || row.sale_date, todayStr);
              return age != null && age >= staleDays;
            })
            .sort((a, b) => Number(b.amount_due_as_of ?? 0) - Number(a.amount_due_as_of ?? 0));
          if (stale.length) {
            alerts.push({
              type: "warning",
              label: "Stale credit",
              message: `${stale.length} customer${stale.length === 1 ? "" : "s"} unpaid ${staleDays}+ days (${formatCurrency(stale.reduce((s, r) => s + Number(r.amount_due_as_of ?? 0), 0))}).`,
              cta: "Outstanding",
              href: "credit.html#outstanding",
              dataNotif: "credit-stale",
              expandHtml: renderNotifCustomerExpand(
                stale.map((row) => {
                  const age = daysBetweenDateStrings(row.last_payment_date || row.sale_date, todayStr);
                  return {
                    name: row.customer_name || "Customer",
                    href: creditCustomerDetailHref(row.customer_name),
                    detail: `${formatCurrency(Number(row.amount_due_as_of ?? 0))} · ${age != null ? `${age} day${age === 1 ? "" : "s"}` : "—"}`,
                  };
                }),
                `Show ${stale.length} customer${stale.length === 1 ? "" : "s"}`
              ),
            });
          }
        }
      }
    }

    if (th.unpaidSalaryAlert && adminUser && !salaryEmpRes.error && !salaryPayRes.error) {
      const paidMap = new Map();
      for (const p of salaryPayRes.data ?? []) {
        paidMap.set(p.employee_id, (paidMap.get(p.employee_id) || 0) + Number(p.amount ?? 0));
      }
      let unpaidCount = 0;
      let pendingTotal = 0;
      for (const emp of salaryEmpRes.data ?? []) {
        const payable = approxNetMonthlySalary(emp);
        if (payable <= 0) continue;
        const pending = Math.max(0, payable - (paidMap.get(emp.id) || 0));
        if (pending > 0.009) {
          unpaidCount += 1;
          pendingTotal += pending;
        }
      }
      if (unpaidCount > 0) {
        alerts.push({
          type: "info",
          label: "Unpaid salary",
          message: `${unpaidCount} staff with ${formatCurrency(pendingTotal)} pending for ${salaryMonth}.`,
          cta: "Open salary",
          href: "salary.html",
        });
      }
    }

    if (th.attendanceAlert) {
      const shifts = PumpSettings.getShiftConfig();
      if (isPastLocalHm(shifts.afternoonEnd) && !rosterRes.error && !attendanceRes.error) {
        const rosterCount = (rosterRes.data ?? []).length;
        const markedCount = (attendanceRes.data ?? []).length;
        if (rosterCount > 0 && markedCount === 0) {
          alerts.push({
            type: "warning",
            label: "Attendance",
            message: `No attendance marked for today after ${shifts.afternoonEnd} (${rosterCount} on roster).`,
            cta: "Mark attendance",
            href: `attendance.html?date=${encodeURIComponent(todayStr)}`,
          });
        }
      }
    }

    if (th.expenseRatioAlert && !mtdDsrRes.error && !mtdExpenseRes.error) {
      const sales = calculateDsrSaleRupees(mtdDsrRes.data ?? [], { includeTesting: true });
      const expenses = (mtdExpenseRes.data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
      if (sales > 0) {
        const ratioPct = (expenses / sales) * 100;
        if (ratioPct > th.expenseRatioPct) {
          alerts.push({
            type: "warning",
            label: "Expense ratio",
            message: `MTD expenses are ${ratioPct.toFixed(1)}% of fuel sales (threshold ${th.expenseRatioPct}%).`,
            cta: "Open analysis",
            href: "analysis.html",
          });
        }
      }
    }

    if (th.missingInvoiceAlert && driveEnabled && !missingInvoiceRes.error) {
      const rows = missingInvoiceRes.data ?? [];
      if (rows.length) {
        const uniqueDays = new Set(rows.map((r) => r.date)).size;
        alerts.push({
          type: "info",
          label: "Invoice upload",
          message: `${rows.length} receipt row${rows.length === 1 ? "" : "s"} across ${uniqueDays} day${uniqueDays === 1 ? "" : "s"} missing a linked invoice PDF.`,
          cta: "Open vault",
          href: "invoices.html",
        });
      }
    }

    if (!alerts.length) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
      updateAlertsVisibility();
      return;
    }
    panel.innerHTML = alerts.map((a) => renderNotifItem(a)).join("");
    panel.classList.remove("hidden");
    updateAlertsVisibility();
  }

  async function refreshBuyingPrice() {
    const bannerEl = document.getElementById("pl-todo-banner");
    const countEl = document.getElementById("pl-todo-count");
    if (!isAdmin()) {
      bannerEl?.classList.add("hidden");
      updateBadge();
      return [];
    }
    if (typeof DsrQueries?.fetchMissingBuyingPriceRows !== "function") {
      bannerEl?.classList.add("hidden");
      updateBadge();
      return [];
    }
    const { data, error } = await DsrQueries.fetchMissingBuyingPriceRows();
    if (error) {
      AppError.report(error, { context: "notifications.refreshBuyingPrice" });
      bannerEl?.classList.add("hidden");
      updateBadge();
      return [];
    }
    const rows = data ?? [];
    if (bannerEl && countEl) {
      countEl.textContent = String(rows.length);
      bannerEl.classList.toggle("hidden", rows.length === 0);
    }
    updateBadge();
    return rows;
  }

  async function refresh() {
    if (!document.getElementById("notifications-feed")) return;
    if (typeof loadPumpSettings === "function") await loadPumpSettings();
    const closingWindow = await fetchDayClosingWindow();
    await Promise.all([
      refreshSmartAlerts({ closingRows: closingWindow.data, todayStr: closingWindow.todayStr }),
      refreshDayClosing(closingWindow),
      refreshReminders(),
      refreshBuyingPrice(),
    ]);
    updateAlertsVisibility();
    lastRefreshAt = Date.now();
  }

  function showFallbackError(message) {
    const body = document.getElementById("topbar-notifications-body");
    if (!body) return;
    body.innerHTML = `<div class="topbar-notifications-fallback" id="topbar-notifications-fallback">
      <p class="topbar-notifications-fallback-title">Couldn't load alerts</p>
      <p class="topbar-notifications-fallback-copy muted">${esc(message || "Refresh the page and try again.")}</p>
    </div>`;
  }

  async function mount(options = {}) {
    const body = document.getElementById("topbar-notifications-body");
    if (!body) return null;
    const stale = mounted && Date.now() - lastRefreshAt > STALE_MS;
    if (mounted && !options.force && !stale) return loadPromise;
    if (mounted) {
      loadPromise = refresh();
      return loadPromise;
    }
    const existing = document.querySelector(".notifications-panel");
    document.getElementById("topbar-notifications-fallback")?.remove();
    document.querySelector(".topbar-notifications-head")?.setAttribute("hidden", "");
    if (existing) {
      existing.hidden = false;
      existing.classList.add("is-visible");
      existing.removeAttribute("data-panel");
      if (existing.parentElement !== body) body.appendChild(existing);
    } else {
      body.insertAdjacentHTML("afterbegin", PANEL_HTML);
    }
    mounted = true;
    try {
      const {
        data: { session },
      } = await global.supabaseClient.auth.getSession();
      userId = session?.user?.id || null;
      loadPromise = refresh();
      await loadPromise;
    } catch (error) {
      mounted = false;
      AppError.report(error, { context: "notifications.mount" });
      showFallbackError(error?.message);
    }
    return loadPromise;
  }

  global.AppNotifications = {
    mount,
    refresh,
    refreshReminders,
    refreshDayClosing,
    refreshSmartAlerts,
    refreshBuyingPrice,
    updateLowStock,
    syncCreditTotal,
    updateBadge,
  };

  window.addEventListener("storage", (e) => {
    if (e.key === "reminders-updated" || e.key === "credit-updated") void refresh();
  });
})(typeof window !== "undefined" ? window : globalThis);
