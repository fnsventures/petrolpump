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

  global.TaskUtils = {
    isCreditTask,
    creditTitle,
    customerHref,
    customerNameOf,
    phoneE164,
    telHref,
    waHref,
    amountDueOf,
    urgencyRank,
    sortTasks,
    splitCreditTodo,
    notifyTasksUpdated,
    wrapMoreCollapse,
    CREDIT_TYPES,
  };
})(typeof window !== "undefined" ? window : globalThis);
