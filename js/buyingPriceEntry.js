/* global supabaseClient, AppError, AppCache, CacheInvalidation, PumpSettings, AppConfig, escapeHtml, normalizeProduct, validateBuyingRateKlInput, buyingRatePerLitreForDb, getPlBuyingPriceFieldLabel, getPlBuyingPricePlaceholder, DsrQueries */

/**
 * Shared admin UI for entering pre-VAT fuel buying price on receipt days.
 * Used from Meter Reading → Purchase cost (ops home for this input).
 */
(function (global) {
  /**
   * Match a vault purchase PDF by invoice title (and optional receipt date).
   * @returns {Promise<string|null>} invoice_documents.id
   */
  async function findVaultDocumentIdForInvoice(invoiceNo, receiptDate) {
    const title = String(invoiceNo || "").trim();
    if (!title) return null;

    const exactQuery = (withDate) => {
      let q = supabaseClient
        .from("invoice_documents")
        .select("id")
        .eq("category", "purchase")
        .eq("title", title)
        .order("invoice_date", { ascending: false })
        .limit(1);
      if (withDate && receiptDate) q = q.eq("invoice_date", receiptDate);
      return q;
    };

    let { data, error } = await exactQuery(true);
    if (!error && data?.[0]?.id) return data[0].id;
    if (receiptDate) {
      ({ data, error } = await exactQuery(false));
      if (!error && data?.[0]?.id) return data[0].id;
    }

    const safePattern = `%${title.replace(/[%_\\]/g, "\\$&")}%`;
    let fuzzy = supabaseClient
      .from("invoice_documents")
      .select("id, title")
      .eq("category", "purchase")
      .ilike("title", safePattern)
      .order("invoice_date", { ascending: false })
      .limit(10);
    if (receiptDate) fuzzy = fuzzy.eq("invoice_date", receiptDate);
    const fuzzyResult = await fuzzy;
    if (fuzzyResult.error || !fuzzyResult.data?.length) {
      if (receiptDate) return findVaultDocumentIdForInvoice(title, null);
      return null;
    }
    const needle = title.toLowerCase();
    const exact = fuzzyResult.data.find(
      (d) => String(d.title || "").trim().toLowerCase() === needle
    );
    if (exact) return exact.id;
    const partial = fuzzyResult.data.find((d) =>
      String(d.title || "")
        .toLowerCase()
        .includes(needle)
    );
    return partial?.id ?? null;
  }

  function showError(errorEl, message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }

  function hideError(errorEl) {
    errorEl?.classList.add("hidden");
  }

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.listEl
   * @param {HTMLElement} [opts.alertEl]
   * @param {HTMLElement} [opts.emptyEl]
   * @param {HTMLElement} [opts.errorEl]
   * @param {() => void|Promise<void>} [opts.onSaved]
   */
  function renderMissingBuyingList(rows, opts) {
    const { listEl, alertEl, emptyEl, errorEl, onSaved } = opts;
    if (!listEl) return;

    hideError(errorEl);

    if (!rows?.length) {
      alertEl?.classList.add("hidden");
      listEl.innerHTML = "";
      emptyEl?.classList.remove("hidden");
      return;
    }

    emptyEl?.classList.add("hidden");
    alertEl?.classList.remove("hidden");

    const defaultGstin =
      PumpSettings.getCachedSync().reports?.fuelSupplierGstin ||
      AppConfig.DEFAULT_REPORTS.fuelSupplierGstin ||
      "";

    listEl.innerHTML = rows
      .map((row) => {
        const productLabel = normalizeProduct(row.product) === "petrol" ? "Petrol" : "Diesel";
        const rowId = row.id;
        const invVal = escapeHtml(row.supplier_invoice_no || "");
        const gstinVal = escapeHtml(row.supplier_gstin || defaultGstin || "");
        return `
        <li class="pl-missing-item" data-dsr-id="${escapeHtml(rowId)}" data-product="${escapeHtml(normalizeProduct(row.product))}" data-date="${escapeHtml(row.date)}">
          <span class="pl-missing-label">${escapeHtml(row.date)} · ${productLabel}</span>
          <label for="pl-buying-${rowId}" class="sr-only">${escapeHtml(getPlBuyingPriceFieldLabel())}</label>
          <input id="pl-buying-${rowId}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="${escapeHtml(getPlBuyingPricePlaceholder())}" class="pl-buying-input" data-dsr-id="${escapeHtml(rowId)}" />
          <label for="pl-inv-${rowId}" class="sr-only">Supplier invoice no</label>
          <input id="pl-inv-${rowId}" type="text" maxlength="40" placeholder="BPCL invoice no" class="pl-inv-input" value="${invVal}" data-dsr-id="${escapeHtml(rowId)}" />
          <label for="pl-gstin-${rowId}" class="sr-only">Supplier GSTIN</label>
          <input id="pl-gstin-${rowId}" type="text" maxlength="15" placeholder="Supplier GSTIN" class="pl-gstin-input" value="${gstinVal}" data-dsr-id="${escapeHtml(rowId)}" />
          <button type="button" class="button-secondary pl-buying-save" data-dsr-id="${escapeHtml(rowId)}" data-product="${escapeHtml(normalizeProduct(row.product))}">Save</button>
        </li>`;
      })
      .join("");

    listEl.querySelectorAll(".pl-buying-save").forEach((btn) => {
      btn.addEventListener("click", () =>
        handleSaveBuyingPrice(btn.dataset.dsrId, opts)
      );
    });
  }

  async function handleSaveBuyingPrice(dsrId, opts) {
    const { listEl, errorEl, onSaved } = opts;
    const input = document.getElementById(`pl-buying-${dsrId}`);
    const invInput = document.getElementById(`pl-inv-${dsrId}`);
    const gstinInput = document.getElementById(`pl-gstin-${dsrId}`);
    const saveBtn = listEl?.querySelector(`.pl-buying-save[data-dsr-id="${dsrId}"]`);
    const itemEl = listEl?.querySelector(`.pl-missing-item[data-dsr-id="${dsrId}"]`);
    const product = saveBtn?.dataset?.product || itemEl?.dataset?.product;
    const receiptDate = itemEl?.dataset?.date || null;
    const valueKl = Number.parseFloat((input?.value ?? "").trim());
    const parsed = validateBuyingRateKlInput(valueKl);
    if (!parsed.ok) {
      showError(
        errorEl,
        parsed.message || `Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`
      );
      return;
    }
    const value = buyingRatePerLitreForDb(parsed.valuePerLitre, product);
    if (value == null) {
      showError(errorEl, `Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`);
      return;
    }
    const supplierInvoiceNo = (invInput?.value ?? "").trim();
    let supplierGstin = (gstinInput?.value ?? "").trim().toUpperCase();
    if (!supplierGstin) {
      supplierGstin = (
        PumpSettings.getCachedSync().reports?.fuelSupplierGstin ||
        AppConfig.DEFAULT_REPORTS.fuelSupplierGstin ||
        ""
      )
        .toString()
        .trim()
        .toUpperCase();
    }
    if (supplierGstin && !/^[0-9A-Z]{15}$/.test(supplierGstin)) {
      showError(errorEl, "Supplier GSTIN must be 15 characters (or leave blank).");
      return;
    }
    hideError(errorEl);
    const btn = saveBtn;
    const resetBtn = () => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Save";
        btn.classList.remove("pl-save-success");
      }
    };
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving…";
    }

    let vaultDocId = null;
    try {
      if (supplierInvoiceNo) {
        vaultDocId = await findVaultDocumentIdForInvoice(
          supplierInvoiceNo,
          receiptDate || null
        );
      }
    } catch (_) {
      vaultDocId = null;
    }

    const rpc = await supabaseClient.rpc("update_dsr_buying_price", {
      p_dsr_id: dsrId,
      p_value: value,
      p_supplier_invoice_no: supplierInvoiceNo || null,
      p_supplier_gstin: supplierGstin || null,
      p_invoice_document_id: vaultDocId,
    });
    if (rpc.error) {
      AppError.report(rpc.error, { context: "handleSaveBuyingPrice", type: "dsr" });
      showError(
        errorEl,
        rpc.error.message || "Could not save. Ensure you are logged in as admin."
      );
      resetBtn();
      return;
    }
    if (btn) {
      btn.textContent = "Saved";
      btn.classList.add("pl-save-success");
    }
    if (typeof AppCache !== "undefined" && AppCache) {
      CacheInvalidation.invalidate("dsr");
    }
    if (typeof onSaved === "function") await onSaved();
    else await refresh({ ...opts, force: true });
    resetBtn();
  }

  /**
   * Fetch missing rows and render the entry list.
   * @param {object} opts
   * @param {boolean} [opts.force] - bypass in-flight dedupe (use after saves)
   * @returns {Promise<object[]>}
   */
  async function refresh(opts = {}) {
    const { force = false, listEl, alertEl, emptyEl, errorEl, onSaved } = opts;
    const { data, error } = await DsrQueries.fetchMissingBuyingPriceRows({ force });
    if (error) {
      AppError.report(error, { context: "BuyingPriceEntry.refresh" });
      if (listEl) listEl.innerHTML = "";
      alertEl?.classList.add("hidden");
      emptyEl?.classList.add("hidden");
      showError(errorEl, error.message || "Could not load receipt days needing a buying price.");
      return [];
    }
    const rows = data ?? [];
    renderMissingBuyingList(rows, { listEl, alertEl, emptyEl, errorEl, onSaved });
    return rows;
  }

  function focusFirstInput() {
    document.querySelector(".pl-buying-input")?.focus({ preventScroll: true });
  }

  global.BuyingPriceEntry = {
    findVaultDocumentIdForInvoice,
    renderMissingBuyingList,
    refresh,
    focusFirstInput,
  };
})(typeof window !== "undefined" ? window : globalThis);
