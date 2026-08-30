/* global window.supabaseClient, AppError, AppCache, CacheInvalidation, PumpSettings, AppConfig, escapeHtml, normalizeProduct, validateBuyingRateKlInput, buyingRatePerLitreForDb, getPlBuyingPriceFieldLabel, getPurchaseLfrGstPct, ratePerKlFromTotalAndQty, lfrPerKlInclGstFromTaxable, litresToKl, landedBuyingRatePerLitre, DsrQueries */

/**
 * Admin UI: enter pre-VAT rate + invoice delivery/LFR totals on receipt days.
 * Meter Reading → Purchase cost.
 */
(function (global) {
  async function findVaultDocumentIdForInvoice(invoiceNo, receiptDate) {
    const title = String(invoiceNo || "").trim();
    if (!title) return null;

    const exactQuery = (withDate) => {
      let q = window.supabaseClient
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
    let fuzzy = window.supabaseClient
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

  function formatMoney(n) {
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function groupRowsByDate(rows) {
    const map = new Map();
    (rows ?? []).forEach((row) => {
      if (!map.has(row.date)) map.set(row.date, []);
      map.get(row.date).push(row);
    });
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }

  function defaultDeliveryQtyKl(row) {
    const fromRow = Number(row.purchase_delivery_qty_kl);
    if (Number.isFinite(fromRow) && fromRow > 0) return fromRow;
    return litresToKl(row.receipts) ?? "";
  }

  function defaultLfrQtyKl(dayRows) {
    const fromRow = dayRows.map((r) => Number(r.purchase_lfr_qty_kl)).find((n) => Number.isFinite(n) && n > 0);
    if (fromRow) return fromRow;
    const sumL = dayRows.reduce((s, r) => s + (Number(r.receipts) || 0), 0);
    return litresToKl(sumL) ?? "";
  }

  function defaultLfrTotal(dayRows) {
    const fromRow = dayRows.map((r) => Number(r.purchase_lfr_total)).find((n) => Number.isFinite(n) && n > 0);
    return fromRow ?? "";
  }

  function readNum(el) {
    if (!el) return NaN;
    const v = Number.parseFloat(String(el.value ?? "").trim());
    return v;
  }

  function updateDayComputed(dayEl) {
    if (!dayEl) return;
    const date = dayEl.dataset.date;
    const lfrTotal = readNum(dayEl.querySelector(".pl-lfr-total"));
    const lfrQty = readNum(dayEl.querySelector(".pl-lfr-qty"));
    const lfrGst = getPurchaseLfrGstPct();
    const lfrPerKl = lfrPerKlInclGstFromTaxable(lfrTotal, lfrQty, lfrGst);
    const lfrOut = dayEl.querySelector(".pl-lfr-per-kl");
    if (lfrOut) {
      lfrOut.textContent = lfrPerKl != null ? `₹${formatMoney(lfrPerKl)}/KL incl. GST` : "—";
    }

    dayEl.querySelectorAll(".pl-product-block").forEach((block) => {
      const product = block.dataset.product;
      const rateKl = readNum(block.querySelector(".pl-buying-input"));
      const delTotal = readNum(block.querySelector(".pl-del-total"));
      const delQty = readNum(block.querySelector(".pl-del-qty"));
      const delPerKl = ratePerKlFromTotalAndQty(delTotal, delQty);
      const delOut = block.querySelector(".pl-del-per-kl");
      if (delOut) {
        delOut.textContent = delPerKl != null ? `₹${formatMoney(delPerKl)}/KL` : "—";
      }
      const preview = block.querySelector(".pl-landed-preview");
      const parsed = validateBuyingRateKlInput(rateKl);
      if (!parsed.ok || delPerKl == null || lfrPerKl == null) {
        if (preview) preview.textContent = "Buying price (landed): —";
        return;
      }
      const landed = landedBuyingRatePerLitre(parsed.valuePerLitre, product, date, {
        deliveryPerKl: delPerKl,
        lfrPerKl,
      });
      if (preview) {
        preview.textContent =
          landed != null
            ? `Buying price (landed) ≈ ₹${formatMoney(landed)}/L · ₹${formatMoney(landed * 1000)}/KL`
            : "Buying price (landed): —";
      }
    });
  }

  function bindDayComputed(dayEl) {
    dayEl.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => updateDayComputed(dayEl));
    });
    updateDayComputed(dayEl);
  }

  /** True when the user has typed or focused fields — avoid wiping via re-render. */
  function hasUnsavedEdits(listEl) {
    if (!listEl?.children?.length) return false;
    if (listEl.contains(document.activeElement) && document.activeElement?.matches?.("input, textarea, select, button")) {
      return true;
    }
    return [...listEl.querySelectorAll("input")].some((input) => input.value !== input.defaultValue);
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
    const lfrGst = getPurchaseLfrGstPct();
    const groups = groupRowsByDate(rows);

    listEl.innerHTML = groups
      .map(([date, dayRows]) => {
        const lfrQtyDefault = defaultLfrQtyKl(dayRows);
        const lfrTotalDefault = defaultLfrTotal(dayRows);
        const productBlocks = dayRows
          .map((row) => {
            const product = normalizeProduct(row.product);
            const productLabel = product === "petrol" ? "Petrol (MS)" : "Diesel (HSD)";
            const rowId = row.id;
            const invVal = escapeHtml(row.supplier_invoice_no || "");
            const gstinVal = escapeHtml(row.supplier_gstin || defaultGstin || "");
            const delTotal =
              Number(row.purchase_delivery_total) > 0 ? row.purchase_delivery_total : "";
            const delQty = defaultDeliveryQtyKl(row);
            const receiptsL = Number(row.receipts) || 0;
            const existingRateL = Number(row.buying_price_per_litre);
            const existingRateKl =
              Number.isFinite(existingRateL) && existingRateL > 0
                ? Math.round(existingRateL * 1000 * 100) / 100
                : "";
            return `
            <div class="pl-product-block" data-dsr-id="${escapeHtml(rowId)}" data-product="${escapeHtml(product)}">
              <div class="pl-product-head">
                <strong>${escapeHtml(productLabel)}</strong>
                <span class="muted">${formatMoney(receiptsL)} L · from fuel invoice</span>
              </div>
              <div class="pl-field-grid">
                <label class="pl-field">
                  <span>Rate per Unit (₹/KL)</span>
                  <input id="pl-buying-${rowId}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="e.g. 81416.47" class="pl-buying-input" value="${escapeHtml(existingRateKl === "" ? "" : String(existingRateKl))}" data-dsr-id="${escapeHtml(rowId)}" />
                </label>
                <label class="pl-field">
                  <span>DLY/TAXABLE CHARGE (₹)</span>
                  <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="e.g. 2435.80" class="pl-del-total" value="${escapeHtml(delTotal === "" ? "" : String(delTotal))}" data-dsr-id="${escapeHtml(rowId)}" />
                </label>
                <label class="pl-field">
                  <span>Quantity (KL)</span>
                  <input type="number" inputmode="decimal" step="0.001" min="0" placeholder="e.g. 4" class="pl-del-qty" value="${escapeHtml(delQty === "" ? "" : String(delQty))}" data-dsr-id="${escapeHtml(rowId)}" />
                </label>
                <div class="pl-field pl-computed">
                  <span>Delivery ₹/KL</span>
                  <strong class="pl-del-per-kl">—</strong>
                </div>
                <label class="pl-field">
                  <span>Invoice No.</span>
                  <input id="pl-inv-${rowId}" type="text" maxlength="40" placeholder="e.g. 1202801092" class="pl-inv-input" value="${invVal}" data-dsr-id="${escapeHtml(rowId)}" />
                </label>
                <label class="pl-field">
                  <span>Supplier GSTIN</span>
                  <input id="pl-gstin-${rowId}" type="text" maxlength="15" placeholder="GSTIN" class="pl-gstin-input" value="${gstinVal}" data-dsr-id="${escapeHtml(rowId)}" />
                </label>
              </div>
              <p class="pl-landed-preview muted">Buying price (landed): —</p>
              <button type="button" class="button-secondary pl-buying-save" data-dsr-id="${escapeHtml(rowId)}" data-product="${escapeHtml(product)}">Save ${escapeHtml(productLabel)}</button>
            </div>`;
          })
          .join("");

        return `
        <li class="pl-day-card" data-date="${escapeHtml(date)}">
          <div class="pl-day-head">
            <h3 class="pl-day-title">${escapeHtml(date)}</h3>
            <p class="muted pl-day-sub">Copy amounts from that day’s fuel invoice and LFR tax invoice. Saved values apply from this receipt onward only.</p>
          </div>
          <div class="pl-lfr-block">
            <div class="pl-product-head">
              <strong>LFR FOR DC (MS / HSD)</strong>
              <span class="muted">LFR tax invoice · TAXABLE AMT · CGST+SGST ${escapeHtml(String(lfrGst))}%</span>
            </div>
            <div class="pl-field-grid">
              <label class="pl-field">
                <span>TAXABLE AMT (₹)</span>
                <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="e.g. 2133.00" class="pl-lfr-total" value="${escapeHtml(lfrTotalDefault === "" ? "" : String(lfrTotalDefault))}" />
              </label>
              <label class="pl-field">
                <span>Total quantity (KL)</span>
                <input type="number" inputmode="decimal" step="0.001" min="0" placeholder="e.g. 12" class="pl-lfr-qty" value="${escapeHtml(lfrQtyDefault === "" ? "" : String(lfrQtyDefault))}" />
              </label>
              <div class="pl-field pl-computed">
                <span>LFR ₹/KL (incl. GST)</span>
                <strong class="pl-lfr-per-kl">—</strong>
              </div>
            </div>
          </div>
          ${productBlocks}
        </li>`;
      })
      .join("");

    listEl.querySelectorAll(".pl-day-card").forEach((dayEl) => bindDayComputed(dayEl));
    listEl.querySelectorAll(".pl-buying-save").forEach((btn) => {
      btn.addEventListener("click", () => handleSaveBuyingPrice(btn.dataset.dsrId, opts));
    });
  }

  async function handleSaveBuyingPrice(dsrId, opts) {
    const { listEl, errorEl, onSaved } = opts;
    const block = listEl?.querySelector(`.pl-product-block[data-dsr-id="${dsrId}"]`);
    const dayEl = block?.closest(".pl-day-card");
    const input = document.getElementById(`pl-buying-${dsrId}`);
    const invInput = document.getElementById(`pl-inv-${dsrId}`);
    const gstinInput = document.getElementById(`pl-gstin-${dsrId}`);
    const saveBtn = listEl?.querySelector(`.pl-buying-save[data-dsr-id="${dsrId}"]`);
    const product = saveBtn?.dataset?.product || block?.dataset?.product;
    const receiptDate = dayEl?.dataset?.date || null;

    const valueKl = readNum(input);
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

    const delTotal = readNum(block?.querySelector(".pl-del-total"));
    const delQty = readNum(block?.querySelector(".pl-del-qty"));
    const delPerKl = ratePerKlFromTotalAndQty(delTotal, delQty);
    if (delPerKl == null) {
      showError(
        errorEl,
        "Enter DLY/TAXABLE CHARGE (₹) and Quantity (KL) from the fuel invoice product line."
      );
      return;
    }

    const lfrTotal = readNum(dayEl?.querySelector(".pl-lfr-total"));
    const lfrQty = readNum(dayEl?.querySelector(".pl-lfr-qty"));
    const lfrPerKl = lfrPerKlInclGstFromTaxable(lfrTotal, lfrQty, getPurchaseLfrGstPct());
    if (lfrPerKl == null) {
      showError(
        errorEl,
        "Enter LFR TAXABLE AMT (₹) and total KL from the LFR invoice (covers MS + HSD on this load)."
      );
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
        btn.textContent = btn.dataset.product === "petrol" ? "Save Petrol (MS)" : "Save Diesel (HSD)";
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

    const rpc = await window.supabaseClient.rpc("update_dsr_buying_price", {
      p_dsr_id: dsrId,
      p_value: value,
      p_supplier_invoice_no: supplierInvoiceNo || null,
      p_supplier_gstin: supplierGstin || null,
      p_invoice_document_id: vaultDocId,
      p_purchase_delivery_per_kl: delPerKl,
      p_purchase_lfr_per_kl: lfrPerKl,
      p_purchase_delivery_total: delTotal,
      p_purchase_delivery_qty_kl: delQty,
      p_purchase_lfr_total: lfrTotal,
      p_purchase_lfr_qty_kl: lfrQty,
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
  }

  async function refresh(opts = {}) {
    const { force = false, listEl, alertEl, emptyEl, errorEl, onSaved } = opts;
    // Soft reloads (section revisit, live refresh, landing race) must not wipe typed values.
    if (!force && hasUnsavedEdits(listEl)) {
      return null;
    }
    const { data, error } = await DsrQueries.fetchMissingBuyingPriceRows({ force });
    if (error) {
      AppError.report(error, { context: "BuyingPriceEntry.refresh" });
      if (listEl) listEl.innerHTML = "";
      alertEl?.classList.add("hidden");
      emptyEl?.classList.add("hidden");
      showError(errorEl, error.message || "Could not load receipt days needing a buying price.");
      return [];
    }
    // Re-check after await: user may have started typing while the fetch was in flight.
    if (!force && hasUnsavedEdits(listEl)) {
      return null;
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
    hasUnsavedEdits,
  };
})(typeof window !== "undefined" ? window : globalThis);
