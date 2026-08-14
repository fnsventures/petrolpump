/**
 * Shared helpers for station Tasks (credit collection + todos).
 * Used by reminders.js and dashboard.js.
 */
(function (global) {
  const CREDIT_TYPES = new Set(["credit_followup", "payment", "call"]);
  const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

  function isCreditTask(row) {
    if (!row) return false;
    return CREDIT_TYPES.has(row.reminder_type) || Boolean(row.credit_customer_id);
  }

  function creditTitle(name) {
    const n = String(name || "").trim();
    return n ? `Call ${n}` : "Call customer";
  }

  function customerHref(customerName) {
    return customerName
      ? `credit.html?${new URLSearchParams({ name: customerName }).toString()}`
      : "reminders.html";
  }

  function customerNameOf(row) {
    return (
      row?.credit_customers?.customer_name ||
      row?.customer_name ||
      ""
    ).trim();
  }

  /** Digits for tel:/wa.me — prefers +91 for 10-digit Indian mobiles. */
  function phoneE164(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 10) return `91${digits}`;
    if (digits.startsWith("0") && digits.length === 11) return `91${digits.slice(1)}`;
    return digits;
  }

  function telHref(mobile) {
    const e164 = phoneE164(mobile);
    return e164 ? `tel:+${e164}` : "";
  }

  function waHref(mobile, text) {
    const e164 = phoneE164(mobile);
    if (!e164) return "";
    const params = new URLSearchParams();
    if (text) params.set("text", text);
    const q = params.toString();
    return `https://wa.me/${e164}${q ? `?${q}` : ""}`;
  }

  function amountDueOf(row) {
    const raw = row?.credit_customers?.amount_due ?? row?.amount_due;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function urgencyRank(row, today) {
    if (row.due_date && row.due_date < today) return 0;
    if (row.due_date === today) return 1;
    if (!row.due_date && row.priority === "high") return 2;
    if (row.due_date && row.due_date > today) return 3;
    return 4;
  }

  function sortTasks(rows, today) {
    return [...rows].sort((a, b) => {
      const ur = urgencyRank(a, today) - urgencyRank(b, today);
      if (ur) return ur;
      // Credit calls first within same urgency
      const ac = isCreditTask(a) ? 0 : 1;
      const bc = isCreditTask(b) ? 0 : 1;
      if (ac !== bc) return ac - bc;
      const aDate = a.due_date || "9999-12-31";
      const bDate = b.due_date || "9999-12-31";
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
      return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    });
  }

  function splitCreditTodo(rows) {
    const credit = [];
    const todo = [];
    for (const row of rows || []) {
      (isCreditTask(row) ? credit : todo).push(row);
    }
    return { credit, todo };
  }

  function notifyTasksUpdated() {
    try {
      localStorage.setItem("reminders-updated", String(Date.now()));
    } catch (_) {
      /* ignore */
    }
    if (typeof global.CacheInvalidation !== "undefined") {
      global.CacheInvalidation.invalidate("operational");
    }
  }

  /** Prefer utils.addDaysToDateString; keep a local fallback for stale caches. */
  function addDaysYmd(yyyyMmDd, days) {
    if (typeof global.addDaysToDateString === "function") {
      return global.addDaysToDateString(yyyyMmDd, days);
    }
    const base = String(yyyyMmDd || "").slice(0, 10);
    const [y, m, d] = base.split("-").map(Number);
    if (!y || !m || !d) return base;
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + (Number(days) || 0));
    if (typeof global.toLocalDateString === "function") return global.toLocalDateString(dt);
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /** Prefer utils.appendDatedNote; keep a local fallback for stale caches. */
  function appendFollowUpNote(existingNotes, noteText, dateLabel) {
    if (typeof global.appendDatedNote === "function") {
      return global.appendDatedNote(existingNotes, noteText, dateLabel);
    }
    const note = String(noteText || "").trim();
    if (!note) return null;
    const stamp = String(dateLabel || "").trim();
    const line = stamp ? `[${stamp}] ${note}` : note;
    const prev = String(existingNotes || "").trim();
    let next = prev ? `${prev}\n${line}` : line;
    if (next.length > 2000) next = next.slice(next.length - 2000);
    return next;
  }

  /**
   * Push an open task's due date (and optional follow-up note).
   * @returns {Promise<{ error: Error|null }>}
   */
  async function rescheduleOpenTask(client, { id, dueDate, note, dateLabel } = {}) {
    if (!client || !id || !dueDate) {
      return { error: new Error("Missing reschedule fields") };
    }

    const patch = {
      due_date: dueDate,
      updated_at: new Date().toISOString(),
    };

    const noteTrim = String(note || "").trim();
    if (noteTrim) {
      const { data: current, error: readError } = await client
        .from("reminders")
        .select("notes")
        .eq("id", id)
        .eq("status", "open")
        .maybeSingle();
      if (readError) return { error: readError };
      const notesPayload = appendFollowUpNote(current?.notes, noteTrim, dateLabel);
      if (notesPayload != null) patch.notes = notesPayload;
    }

    // Prefer returning the row — PostgREST can report no error when 0 rows update (RLS/status).
    const { data, error } = await client
      .from("reminders")
      .update(patch)
      .eq("id", id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (error) return { error };
    if (!data?.id) {
      return { error: new Error("Could not update task — it may already be done.") };
    }
    return { error: null };
  }

  function wrapMoreCollapse(previewHtml, moreHtml, moreCount, { escapeHtml, allHref = "reminders.html" } = {}) {
    if (!moreHtml || moreCount <= 0) return previewHtml;
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s);
    const label = moreCount === 1 ? "1 more task" : `${moreCount} more tasks`;
    return `${previewHtml}
<details class="tasks-more-expand">
  <summary>
    <span class="tasks-more-expand-closed">Show ${esc(label)}</span>
    <span class="tasks-more-expand-open">Show less</span>
  </summary>
  <div class="tasks-more-list">${moreHtml}</div>
  <p class="tasks-more-footer muted">
    <a href="${esc(allHref)}">Open all tasks</a>
  </p>
</details>`;
  }

  function waMessageForCustomer(customerName) {
    return customerName
      ? `Hello ${customerName}, this is Bishnupriya Fuels regarding your credit balance.`
      : "Hello, this is Bishnupriya Fuels regarding your credit balance.";
  }

  /**
   * Compact follow-up choices for More… panel.
   * Credit: No answer / +3 / +7. Todo: Tomorrow / +3 / +7.
   */
  function laterChoicesHtml(id, { credit = false, escapeHtml, forRemindersPage = false } = {}) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s ?? "");
    const safeId = esc(id);
    const btnClass = forRemindersPage
      ? "button-secondary reminder-later-choice"
      : "button-secondary task-later-choice reminder-later-btn";
    const btn = (days, title, sub, note) => {
      const attrs = forRemindersPage
        ? `data-reminder-action="reschedule" data-id="${safeId}" data-days="${days}"${
            note ? ` data-note="${esc(note)}"` : ""
          }`
        : `data-reminder-later="reschedule" data-reminder-id="${safeId}" data-days="${days}"${
            note ? ` data-note="${esc(note)}"` : ""
          }`;
      return `<button type="button" class="${btnClass}" ${attrs}>
        <span class="${forRemindersPage ? "reminder-later-choice-title" : "task-later-choice-title"}">${esc(title)}</span>${
          sub
            ? `<span class="${forRemindersPage ? "reminder-later-choice-sub" : "task-later-choice-sub"}">${esc(sub)}</span>`
            : ""
        }
      </button>`;
    };
    const first = credit
      ? btn(1, "No answer", "Tomorrow", "No answer")
      : btn(1, "Tomorrow", "", "");
    const gridClass = forRemindersPage ? "reminder-later-grid" : "task-later-grid";
    return `<div class="${gridClass}" role="group" aria-label="Follow up">
      ${first}
      ${btn(3, "+3 days", "", "")}
      ${btn(7, "+7 days", "", "")}
    </div>`;
  }

  /** Custom date row under the quick choices (date + Set). */
  function laterCustomPickHtml(id, { escapeHtml, forRemindersPage = false, today = "" } = {}) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s ?? "");
    const safeId = esc(id);
    const min = esc(today || "");
    const inputId = forRemindersPage ? `reminder-later-date-${safeId}` : `later-date-${safeId}`;
    const pickClass = forRemindersPage ? "reminder-later-pick" : "task-later-pick";
    const labelClass = forRemindersPage ? "reminder-later-custom-label" : "task-later-custom-label";
    const wrapClass = forRemindersPage ? "reminder-later-custom" : "task-later-custom";
    const dateClass = forRemindersPage ? "" : ' class="task-later-date"';
    const setAttrs = forRemindersPage
      ? `data-reminder-action="reschedule-pick" data-id="${safeId}"`
      : `data-reminder-later="reschedule-pick" data-reminder-id="${safeId}"`;
    const setClass = forRemindersPage
      ? "button-secondary button-small"
      : "button-secondary button-small reminder-later-btn";
    return `<div class="${wrapClass}">
      <label class="${labelClass}" for="${inputId}">Or pick a date</label>
      <div class="${pickClass}">
        <input id="${inputId}" type="date"${dateClass} data-later-date${min ? ` min="${min}"` : ""} />
        <button type="button" class="${setClass}" ${setAttrs}>Set</button>
      </div>
    </div>`;
  }

  /** Full More… panel markup (choices + custom date + cancel). */
  function laterPanelHtml(id, { credit = false, escapeHtml, forRemindersPage = false, today = "" } = {}) {
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s ?? "");
    const safeId = esc(id);
    const heading = credit ? "Follow up" : "Push follow-up";
    const choices = laterChoicesHtml(id, { credit, escapeHtml, forRemindersPage });
    const customPick = laterCustomPickHtml(id, { escapeHtml, forRemindersPage, today });
    if (forRemindersPage) {
      return `<div class="reminder-later-panel" data-later-for="${safeId}" hidden>
        <p class="reminder-later-heading">${heading}</p>
        ${choices}
        ${customPick}
        <p class="reminder-later-error" data-later-error hidden></p>
        <div class="reminder-later-footer">
          <button type="button" class="button-secondary button-small" data-reminder-action="later-cancel" data-id="${safeId}">Cancel</button>
        </div>
      </div>`;
    }
    return `<div class="task-later-panel" data-later-for="${safeId}" hidden>
      <p class="task-later-heading">${heading}</p>
      ${choices}
      ${customPick}
      <p class="task-later-error" data-later-error hidden></p>
      <div class="task-later-footer">
        <button type="button" class="button-secondary button-small reminder-later-btn" data-reminder-later="cancel" data-reminder-id="${safeId}">Cancel</button>
      </div>
    </div>`;
  }

  /** Brief non-blocking status (works across Tasks + Dashboard). */
  function showTaskToast(message) {
    if (typeof document === "undefined" || !document.body) return;
    const text = String(message || "").trim();
    if (!text) return;
    let el = document.getElementById("task-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "task-toast";
      el.className = "task-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("is-visible");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.classList.remove("is-visible");
    }, 2800);
  }

  global.TaskUtils = {
    isCreditTask,
    creditTitle,
    customerHref,
    customerNameOf,
    phoneE164,
    telHref,
    waHref,
    waMessageForCustomer,
    amountDueOf,
    urgencyRank,
    sortTasks,
    splitCreditTodo,
    notifyTasksUpdated,
    addDaysYmd,
    appendFollowUpNote,
    rescheduleOpenTask,
    laterChoicesHtml,
    laterCustomPickHtml,
    laterPanelHtml,
    wrapMoreCollapse,
    showTaskToast,
    CREDIT_TYPES,
  };
})(typeof window !== "undefined" ? window : globalThis);
