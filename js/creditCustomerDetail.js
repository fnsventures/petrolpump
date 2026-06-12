/* global formatCurrency, formatDisplayDate, getLocalDateString, AppError, escapeHtml, AdminDelete */

/**
 * Shared credit customer detail helpers (detail page + overdue modal).
 */
(function (global) {
  const BREAKDOWN_PAGE_SIZE = 5;

  function getMonthStart(dateStr) {
    const d = dateStr || getLocalDateString();
    return d.slice(0, 8) + "01";
  }

  function filterEntriesByRange(entries, from, to) {
    if (!entries?.length) return [];
    return entries.filter((e) => {
      const d = (e.entry_date || e.transaction_date || e.date || "").toString();
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  function sumAmount(entries) {
    return (entries || []).reduce((s, e) => s + Number(e.amount || 0), 0);
  }

  function sortEntriesByDateDesc(entries) {
    if (!entries?.length) return [];
    return [...entries].sort((a, b) => {
      const dA = (a.entry_date || a.transaction_date || a.date || "").toString();
      const dB = (b.entry_date || b.transaction_date || b.date || "").toString();
      return dB.localeCompare(dA);
    });
  }

  function adminDeleteButtonHtml(entry, extraClass, options) {
    if (!entry?.id) return "";
    const amount = entry.amount != null ? String(entry.amount) : "";
    const date = (entry.transaction_date || entry.entry_date || entry.date || "").toString();
    const idKey = options?.idKey || "entryId";
    return AdminDelete.buttonHtml({
      selector: extraClass || "credit-delete-btn",
      data: { [idKey]: entry.id, amount, date },
      title: "Delete (admin)",
    });
  }

  function renderBreakdownRows(entries, columns, options) {
    const showAdminActions = Boolean(options?.showAdminActions);
    if (!entries?.length) return "";
    if (columns === "credit-rich") {
      return entries
        .map((e) => {
          const fuel = e.fuel_type ? escapeHtml(e.fuel_type) : "—";
          const qty = e.quantity != null ? Number(e.quantity).toFixed(3) : "—";
          const settled = Number(e.amount_settled || 0);
          const open = Number(e.amount || 0) - settled;
          const canDelete = showAdminActions && e.id && settled === 0;
          const actions = canDelete
            ? `<td class="table-actions">${adminDeleteButtonHtml(e, "credit-delete-entry")}</td>`
            : showAdminActions
              ? settled > 0
                ? `<td class="table-actions"><span class="muted" title="Delete settlements first">${open > 0 ? "Partial" : "Settled"}</span></td>`
                : `<td class="table-actions muted">—</td>`
              : "";
          return `<tr>
            <td>${escapeHtml(formatDisplayDate(e.transaction_date || e.entry_date))}</td>
            <td>${fuel}</td>
            <td>${qty}</td>
            <td>${formatCurrency(e.amount)}</td>
            <td>${formatCurrency(open)}</td>
            ${actions}
          </tr>`;
        })
        .join("");
    }
    if (columns === "payment-rich") {
      return entries
        .map((e) => {
          const actions = showAdminActions
            ? e.id
              ? `<td class="table-actions">${adminDeleteButtonHtml(e, "credit-delete-payment", { idKey: "paymentId" })}</td>`
              : `<td class="table-actions muted">—</td>`
            : "";
          return `<tr>
              <td>${escapeHtml(formatDisplayDate(e.date || e.entry_date))}</td>
              <td>${formatCurrency(e.amount)}</td>
              <td>${escapeHtml(e.payment_mode || "—")}</td>
              <td>${escapeHtml(e.note || "—")}</td>
              ${actions}
            </tr>`;
        })
        .join("");
    }
    return entries
      .map(
        (e) =>
          `<tr><td>${escapeHtml(formatDisplayDate(e.entry_date || e.date))}</td><td>${formatCurrency(e.amount)}</td></tr>`
      )
      .join("");
  }

  /**
   * Paginated breakdown controller for a table section.
   */
  function createBreakdownPager(tbody, emptyEl, paginationEl, infoEl, backBtn, moreBtn, options) {
    const state = { entries: [], page: 0, showAdminActions: Boolean(options?.showAdminActions) };

    function setAdminActions(show) {
      state.showAdminActions = Boolean(show);
      render();
    }

    function render() {
      const total = state.entries.length;
      const totalPages = Math.max(1, Math.ceil(total / BREAKDOWN_PAGE_SIZE));
      const page = Math.min(state.page, totalPages - 1);
      state.page = page;

      if (total === 0) {
        if (tbody) tbody.innerHTML = "";
        if (emptyEl) emptyEl.classList.remove("hidden");
        if (paginationEl) paginationEl.classList.add("hidden");
        return;
      }

      const start = page * BREAKDOWN_PAGE_SIZE;
      const end = Math.min(start + BREAKDOWN_PAGE_SIZE, total);
      const slice = state.entries.slice(start, end);
      const mode = tbody?.dataset?.breakdownMode || "simple";

      if (tbody) {
        tbody.innerHTML = renderBreakdownRows(slice, mode, { showAdminActions: state.showAdminActions });
      }
      if (emptyEl) emptyEl.classList.add("hidden");

      if (paginationEl && infoEl && backBtn && moreBtn) {
        paginationEl.classList.remove("hidden");
        infoEl.textContent = `Showing ${start + 1}–${end} of ${total}`;
        backBtn.disabled = page <= 0;
        backBtn.classList.toggle("hidden", totalPages <= 1);
        moreBtn.disabled = page >= totalPages - 1;
        moreBtn.classList.toggle("hidden", totalPages <= 1);
      }
    }

    function setEntries(entries) {
      state.entries = sortEntriesByDateDesc(entries);
      state.page = 0;
      render();
    }

    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (state.page > 0) {
          state.page--;
          render();
        }
      });
    }
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        const totalPages = Math.ceil(state.entries.length / BREAKDOWN_PAGE_SIZE);
        if (state.page < totalPages - 1) {
          state.page++;
          render();
        }
      });
    }

    return { setEntries, render, setAdminActions };
  }

  global.CreditCustomerDetail = {
    BREAKDOWN_PAGE_SIZE,
    getMonthStart,
    filterEntriesByRange,
    sumAmount,
    sortEntriesByDateDesc,
    renderBreakdownRows,
    createBreakdownPager,
  };
})(typeof window !== "undefined" ? window : globalThis);
