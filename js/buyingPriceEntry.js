/* global AppError, AppCache, CacheInvalidation, PumpSettings, AppConfig, escapeHtml, html, setHtml, trustedHtml, applyInputUnits, formatDisplayDate, formatCurrency, formatQuantity, normalizeProduct, validateBuyingRateKlInput, buyingRatePerLitreForDb, getPlBuyingPriceFieldLabel, getPurchaseLfrGstPct, ratePerKlFromTotalAndQty, lfrPerKlInclGstFromTaxable, litresToKl, landedBuyingRatePerLitre, DsrQueries */

/**
 * Admin UI: enter pre-VAT rate + invoice delivery/LFR totals on receipt days.
 * Meter reading → Purchase cost.
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

  function clearFieldErrors(root) {
    root?.querySelectorAll(".pl-field-invalid").forEach((el) => el.classList.remove("pl-field-invalid"));
    root?.querySelectorAll(".pl-block-error").forEach((el) => {
      el.textContent = "";
      el.classList.add("hidden");
    });
  }

  function markInvalid(input) {
    input?.classList.add("pl-field-invalid");
  }

  /** Show error on the product card (near Save) and optionally the panel alert. */
  function showSaveError(opts, block, message, focusEl) {
    const { errorEl } = opts || {};
    showError(errorEl, message);
    const local = block?.querySelector(".pl-block-error");
    if (local) {
      local.textContent = message;
      local.classList.remove("hidden");
    }
    if (focusEl && typeof focusEl.focus === "function") {
      const details = focusEl.closest?.("details");
      if (details) details.open = true;
      try {
        focusEl.focus({ preventScroll: false });
      } catch (_) {
        focusEl.focus();
      }
      focusEl.scrollIntoView?.({ block: "center", behavior: "smooth" });
    } else {
      (local || errorEl)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }

  function captureDrafts(listEl, excludeDsrId) {
    const drafts = { products: {}, lfrByDate: {} };
    listEl?.querySelectorAll(".pl-day-card").forEach((dayEl) => {
      const date = dayEl.dataset.date;
      if (date) {
        drafts.lfrByDate[date] = {
          total: dayEl.querySelector(".pl-lfr-total")?.value ?? "",
          qty: dayEl.querySelector(".pl-lfr-qty")?.value ?? "",
        };
      }
      dayEl.querySelectorAll(".pl-product-block").forEach((block) => {
        const id = block.dataset.dsrId;
        if (!id || id === excludeDsrId) return;
        drafts.products[id] = {
          rate: block.querySelector(".pl-buying-input")?.value ?? "",
          delTotal: block.querySelector(".pl-del-total")?.value ?? "",
          delQty: block.querySelector(".pl-del-qty")?.value ?? "",
          inv: block.querySelector(".pl-inv-input")?.value ?? "",
          gstin: block.querySelector(".pl-gstin-input")?.value ?? "",
        };
      });
    });
    return drafts;
  }

  function restoreDrafts(listEl, drafts) {
    if (!listEl || !drafts) return;
    Object.entries(drafts.lfrByDate || {}).forEach(([date, vals]) => {
      const dayEl = listEl.querySelector(`.pl-day-card[data-date="${CSS.escape?.(date) ?? date}"]`);
      if (!dayEl) return;
      const t = dayEl.querySelector(".pl-lfr-total");
      const q = dayEl.querySelector(".pl-lfr-qty");
      if (t && vals.total != null) t.value = vals.total;
      if (q && vals.qty != null) q.value = vals.qty;
    });
    Object.entries(drafts.products || {}).forEach(([id, vals]) => {
      const sel = CSS.escape ? CSS.escape(id) : id;
      const block = listEl.querySelector(`.pl-product-block[data-dsr-id="${sel}"]`);
      if (!block) return;
      const apply = (selector, value) => {
        const el = block.querySelector(selector);
        if (el && value != null) el.value = value;
      };
      apply(".pl-buying-input", vals.rate);
      apply(".pl-del-total", vals.delTotal);
      apply(".pl-del-qty", vals.delQty);
      apply(".pl-inv-input", vals.inv);
      apply(".pl-gstin-input", vals.gstin);
    });
    listEl.querySelectorAll(".pl-day-card").forEach((dayEl) => updateDayComputed(dayEl));
  }

  /** Pending-days badge in the panel header. */
  function updateCount(opts) {
    const { listEl, countEl } = opts || {};
    if (!countEl) return;
    const days = listEl?.querySelectorAll(".pl-day-card").length ?? 0;
    countEl.textContent = days === 1 ? "1 day pending" : `${days} days pending`;
    countEl.classList.toggle("hidden", days === 0);
  }

  function syncEmptyState(opts) {
    const { listEl, alertEl, emptyEl } = opts || {};
    const hasCards = Boolean(listEl?.querySelector(".pl-day-card"));
    if (hasCards) {
      emptyEl?.classList.add("hidden");
      alertEl?.classList.remove("hidden");
    } else {
      setHtml(listEl, "");
      alertEl?.classList.add("hidden");
      emptyEl?.classList.remove("hidden");
    }
    updateCount(opts);
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
      lfrOut.textContent = lfrPerKl != null ? `${formatCurrency(lfrPerKl)}/KL` : "—";
    }

    dayEl.querySelectorAll(".pl-product-block").forEach((block) => {
      const product = block.dataset.product;
      const rateKl = readNum(block.querySelector(".pl-buying-input"));
      const delTotal = readNum(block.querySelector(".pl-del-total"));
      const delQty = readNum(block.querySelector(".pl-del-qty"));
      const delPerKl = ratePerKlFromTotalAndQty(delTotal, delQty);
      const delOut = block.querySelector(".pl-del-per-kl");
      if (delOut) {
        delOut.textContent = delPerKl != null ? `${formatCurrency(delPerKl)}/KL` : "—";
      }
      const valueEl = block.querySelector(".pl-landed-value");
      const subEl = block.querySelector(".pl-landed-sub");
      const landedWrap = block.querySelector(".pl-landed");
      const parsed = validateBuyingRateKlInput(rateKl);
      const landed =
        parsed.ok && delPerKl != null && lfrPerKl != null
          ? landedBuyingRatePerLitre(parsed.valuePerLitre, product, date, {
              deliveryPerKl: delPerKl,
              lfrPerKl,
            })
          : null;
      landedWrap?.classList.toggle("is-ready", landed != null);
      if (valueEl) valueEl.textContent = landed != null ? `${formatCurrency(landed)}/L` : "—";
      if (subEl) {
        subEl.textContent =
          landed != null
            ? `${formatCurrency(landed * 1000)}/KL incl. VAT, delivery & LFR`
            : "Fill rate, delivery and LFR to preview";
      }
    });
  }

  function bindDayComputed(dayEl) {
    dayEl.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        input.classList.remove("pl-field-invalid");
        const blockErr = input.closest(".pl-product-block")?.querySelector(".pl-block-error");
        if (blockErr) {
          blockErr.textContent = "";
          blockErr.classList.add("hidden");
        }
        updateDayComputed(dayEl);
      });
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

  const PRODUCT_META = {
    petrol: { label: "Petrol (MS)", code: "MS", badge: "badge--petrol" },
    diesel: { label: "Diesel (HSD)", code: "HSD", badge: "badge--diesel" },
  };

  /** Input value for a stored number: blank when missing. */
  function numValue(n) {
    return n === "" || n == null ? "" : String(n);
  }

  /**
   * One labelled input in the app's .form-field pattern. `unit` becomes an input-unit badge
   * (applyInputUnits in js/utils.js wraps it).
   */
  function field({ id, label, cls, value, placeholder, unit, required = true, hint, inputmode = "decimal", maxlength }) {
    return html`
      <div class="form-field pl-field">
        <label for="${id}">${label}${required ? html` <abbr title="required">*</abbr>` : ""}</label>
        <input
          id="${id}"
          type="text"
          inputmode="${inputmode}"
          class="${cls}"
          value="${value}"
          placeholder="${placeholder}"
          autocomplete="off"
          ${trustedHtml(unit ? `data-unit="${escapeHtml(unit)}"` : "")}
          ${trustedHtml(maxlength ? `maxlength="${Number(maxlength)}"` : "")}
          ${trustedHtml(required ? 'required aria-required="true"' : "")}
        />
        ${hint ? html`<span class="pl-field-hint">${hint}</span>` : ""}
      </div>`;
  }

  function computedField(label, cls, note) {
    return html`
      <div class="pl-computed" aria-live="polite">
        <span class="pl-computed-label">${label}</span>
        <strong class="pl-computed-value ${cls}">—</strong>
        ${note ? html`<span class="pl-field-hint">${note}</span>` : ""}
      </div>`;
  }

  function productBlock(row, defaultGstin) {
    const product = normalizeProduct(row.product);
    const meta = PRODUCT_META[product] || PRODUCT_META.diesel;
    const rowId = String(row.id);
    const delTotal = Number(row.purchase_delivery_total) > 0 ? row.purchase_delivery_total : "";
    const receiptsL = Number(row.receipts) || 0;
    const existingRateL = Number(row.buying_price_per_litre);
    const existingRateKl =
      Number.isFinite(existingRateL) && existingRateL > 0 ? Math.round(existingRateL * 1000 * 100) / 100 : "";
    return html`
      <section class="pl-product-block pl-product-block--${product}" data-dsr-id="${rowId}" data-product="${product}">
        <div class="pl-block-head">
          <span class="badge badge--square ${meta.badge}" aria-hidden="true">${meta.code}</span>
          <div class="pl-block-titles">
            <h4 class="pl-block-title">${meta.label}</h4>
            <p class="pl-block-sub">Fuel tax invoice</p>
          </div>
          <span class="badge badge--neutral pl-receipt-badge">${formatQuantity(receiptsL)} L received</span>
        </div>
        <div class="pl-field-grid">
          ${field({
            id: `pl-buying-${rowId}`,
            label: "Rate per Unit",
            cls: "pl-buying-input",
            value: numValue(existingRateKl),
            placeholder: "81416.47",
            unit: "₹",
            hint: "Pre-VAT, per KL",
          })}
          ${field({
            id: `pl-del-total-${rowId}`,
            label: "DLY/TAXABLE CHARGE",
            cls: "pl-del-total",
            value: numValue(delTotal),
            placeholder: "2435.80",
            unit: "₹",
          })}
          ${field({
            id: `pl-del-qty-${rowId}`,
            label: "Quantity",
            cls: "pl-del-qty",
            value: numValue(defaultDeliveryQtyKl(row)),
            placeholder: "4",
            unit: "KL",
          })}
          ${computedField("Delivery", "pl-del-per-kl", "Charge per KL")}
        </div>
        <details class="pl-optional" ${trustedHtml(row.supplier_invoice_no ? "open" : "")}>
          <summary>Invoice reference <span class="muted">(optional)</span></summary>
          <div class="pl-field-grid pl-field-grid--2">
            ${field({
              id: `pl-inv-${rowId}`,
              label: "Invoice No.",
              cls: "pl-inv-input",
              value: row.supplier_invoice_no || "",
              placeholder: "1202801092",
              required: false,
              inputmode: "text",
              maxlength: 40,
              hint: "Links the purchase invoice from the vault",
            })}
            ${field({
              id: `pl-gstin-${rowId}`,
              label: "Supplier GSTIN",
              cls: "pl-gstin-input",
              value: row.supplier_gstin || defaultGstin || "",
              placeholder: "15-character GSTIN",
              required: false,
              inputmode: "text",
              maxlength: 15,
            })}
          </div>
        </details>
        <div class="pl-block-foot">
          <div class="pl-landed">
            <span class="pl-computed-label">Landed buying price</span>
            <strong class="pl-landed-value">—</strong>
            <span class="pl-landed-sub">Fill rate, delivery and LFR to preview</span>
          </div>
          <button type="button" class="button-primary pl-buying-save" data-dsr-id="${rowId}" data-product="${product}">
            Save ${meta.label}
          </button>
        </div>
        <p class="pl-block-error error hidden" role="alert"></p>
      </section>`;
  }

  function dayCard(date, dayRows, defaultGstin, lfrGst) {
    const products = dayRows.map((r) => normalizeProduct(r.product));
    return html`
      <li class="pl-day-card" data-date="${date}">
        <div class="pl-day-head">
          <div>
            <p class="pl-day-eyebrow">Receipt day</p>
            <h3 class="pl-day-title">${formatDisplayDate(date)}</h3>
          </div>
          <div class="pl-day-badges">
            ${products.map((p) => {
              const meta = PRODUCT_META[p] || PRODUCT_META.diesel;
              return html`<span class="badge ${meta.badge}">${meta.code}</span>`;
            })}
            <span class="badge badge--warning">Cost pending</span>
          </div>
        </div>
        <section class="pl-lfr-block">
          <div class="pl-block-head">
            <span class="badge badge--square badge--neutral" aria-hidden="true">LFR</span>
            <div class="pl-block-titles">
              <h4 class="pl-block-title">LFR for DC · MS + HSD</h4>
              <p class="pl-block-sub">LFR tax invoice · shared by both products · CGST+SGST ${String(lfrGst)}% added</p>
            </div>
          </div>
          <div class="pl-field-grid">
            ${field({
              id: `pl-lfr-total-${date}`,
              label: "TAXABLE AMT",
              cls: "pl-lfr-total",
              value: numValue(defaultLfrTotal(dayRows)),
              placeholder: "2133.00",
              unit: "₹",
            })}
            ${field({
              id: `pl-lfr-qty-${date}`,
              label: "Total quantity",
              cls: "pl-lfr-qty",
              value: numValue(defaultLfrQtyKl(dayRows)),
              placeholder: "12",
              unit: "KL",
              hint: "Whole load, MS + HSD",
            })}
            ${computedField("LFR incl. GST", "pl-lfr-per-kl", "Applied to both products")}
          </div>
        </section>
        ${dayRows.map((row) => productBlock(row, defaultGstin))}
      </li>`;
  }

  /** Placeholder cards while the list loads (first load only). */
  function renderLoading(opts) {
    const { listEl, alertEl, emptyEl } = opts || {};
    // Only on a cold load: never over existing cards or the "all caught up" state.
    if (!listEl || listEl.children.length || (emptyEl && !emptyEl.classList.contains("hidden"))) return;
    emptyEl?.classList.add("hidden");
    alertEl?.classList.remove("hidden");
    setHtml(
      listEl,
      html`<li class="pl-loading" aria-busy="true">
        <span class="sr-only">Loading receipt days…</span>
        <span class="skeleton-row" aria-hidden="true"></span>
        <span class="skeleton-row" aria-hidden="true"></span>
      </li>`
    );
  }

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.listEl
   * @param {HTMLElement} [opts.alertEl]
   * @param {HTMLElement} [opts.emptyEl]
   * @param {HTMLElement} [opts.errorEl]
   * @param {HTMLElement} [opts.countEl]
   * @param {() => void|Promise<void>} [opts.onSaved]
   */
  function renderMissingBuyingList(rows, opts) {
    const { listEl, errorEl } = opts;
    if (!listEl) return;

    hideError(errorEl);

    const defaultGstin =
      PumpSettings.getCachedSync().reports?.fuelSupplierGstin ||
      AppConfig.DEFAULT_REPORTS.fuelSupplierGstin ||
      "";
    const lfrGst = getPurchaseLfrGstPct();
    const groups = groupRowsByDate(rows);

    setHtml(listEl, html`${groups.map(([date, dayRows]) => dayCard(date, dayRows, defaultGstin, lfrGst))}`);
    applyInputUnits(listEl);
    syncEmptyState(opts);

    listEl.querySelectorAll(".pl-day-card").forEach((dayEl) => bindDayComputed(dayEl));
    listEl.querySelectorAll(".pl-buying-save").forEach((btn) => {
      btn.addEventListener("click", () => handleSaveBuyingPrice(btn.dataset.dsrId, opts));
    });
  }

  async function handleSaveBuyingPrice(dsrId, opts) {
    const { listEl, errorEl, onSaved } = opts;
    const block = listEl?.querySelector(`.pl-product-block[data-dsr-id="${CSS.escape ? CSS.escape(dsrId) : dsrId}"]`);
    const dayEl = block?.closest(".pl-day-card");
    const input = document.getElementById(`pl-buying-${dsrId}`);
    const invInput = document.getElementById(`pl-inv-${dsrId}`);
    const gstinInput = document.getElementById(`pl-gstin-${dsrId}`);
    const delTotalInput = block?.querySelector(".pl-del-total");
    const delQtyInput = block?.querySelector(".pl-del-qty");
    const lfrTotalInput = dayEl?.querySelector(".pl-lfr-total");
    const lfrQtyInput = dayEl?.querySelector(".pl-lfr-qty");
    const saveBtn = listEl?.querySelector(`.pl-buying-save[data-dsr-id="${CSS.escape ? CSS.escape(dsrId) : dsrId}"]`);
    const product = saveBtn?.dataset?.product || block?.dataset?.product;
    const receiptDate = dayEl?.dataset?.date || null;

    clearFieldErrors(dayEl);
    hideError(errorEl);

    const valueKl = readNum(input);
    const parsed = validateBuyingRateKlInput(valueKl);
    if (!parsed.ok) {
      markInvalid(input);
      showSaveError(
        opts,
        block,
        parsed.message || `Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`,
        input
      );
      return;
    }
    const value = buyingRatePerLitreForDb(parsed.valuePerLitre, product);
    if (value == null) {
      markInvalid(input);
      showSaveError(
        opts,
        block,
        `Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`,
        input
      );
      return;
    }

    const delTotal = readNum(delTotalInput);
    const delQty = readNum(delQtyInput);
    const delPerKl = ratePerKlFromTotalAndQty(delTotal, delQty);
    if (delPerKl == null) {
      if (!Number.isFinite(delTotal) || delTotal < 0) markInvalid(delTotalInput);
      if (!Number.isFinite(delQty) || delQty <= 0) markInvalid(delQtyInput);
      showSaveError(
        opts,
        block,
        "Enter DLY/TAXABLE CHARGE (₹) and Quantity (KL) from the fuel invoice — required to save.",
        !Number.isFinite(delTotal) || delTotal < 0 ? delTotalInput : delQtyInput
      );
      return;
    }

    const lfrTotal = readNum(lfrTotalInput);
    const lfrQty = readNum(lfrQtyInput);
    const lfrPerKl = lfrPerKlInclGstFromTaxable(lfrTotal, lfrQty, getPurchaseLfrGstPct());
    if (lfrPerKl == null) {
      if (!Number.isFinite(lfrTotal) || lfrTotal < 0) markInvalid(lfrTotalInput);
      if (!Number.isFinite(lfrQty) || lfrQty <= 0) markInvalid(lfrQtyInput);
      showSaveError(
        opts,
        block,
        "Enter LFR TAXABLE AMT (₹) and total KL from the LFR invoice (covers MS + HSD) — required to save.",
        !Number.isFinite(lfrTotal) || lfrTotal < 0 ? lfrTotalInput : lfrQtyInput
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
      markInvalid(gstinInput);
      showSaveError(
        opts,
        block,
        "Supplier GSTIN must be 15 characters (or leave blank).",
        gstinInput
      );
      return;
    }

    const btn = saveBtn;
    const resetBtn = () => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = `Save ${(PRODUCT_META[btn.dataset.product] || PRODUCT_META.diesel).label}`;
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

    if (!window.supabaseClient?.rpc) {
      showSaveError(opts, block, "Not connected. Refresh the page and try again.");
      resetBtn();
      return;
    }

    const drafts = captureDrafts(listEl, dsrId);

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
      showSaveError(
        opts,
        block,
        rpc.error.message || "Could not save. Ensure you are logged in as admin."
      );
      resetBtn();
      return;
    }

    // Remove this product from the UI immediately; day card goes away when both are saved.
    block?.remove();
    if (dayEl && !dayEl.querySelector(".pl-product-block")) {
      dayEl.remove();
    }
    syncEmptyState(opts);
    hideError(errorEl);
    AppError.showToast?.(
      `${(PRODUCT_META[product] || PRODUCT_META.diesel).label} cost saved for ${formatDisplayDate(receiptDate)}.`,
      "success"
    );

    if (typeof AppCache !== "undefined" && AppCache) {
      CacheInvalidation.invalidate("dsr");
    }

    try {
      if (typeof onSaved === "function") await onSaved();
      else await refresh({ ...opts, force: true });
      restoreDrafts(listEl, drafts);
    } catch (err) {
      AppError.report(err, { context: "handleSaveBuyingPrice.onSaved", type: "dsr" });
      restoreDrafts(listEl, drafts);
    }
  }

  async function refresh(opts = {}) {
    const { force = false, listEl, alertEl, emptyEl, errorEl, countEl, onSaved } = opts;
    // Soft reloads (section revisit, live refresh, landing race) must not wipe typed values.
    if (!force && hasUnsavedEdits(listEl)) {
      return null;
    }
    renderLoading(opts);
    const { data, error } = await DsrQueries.fetchMissingBuyingPriceRows({ force });
    if (error) {
      AppError.report(error, { context: "BuyingPriceEntry.refresh" });
      setHtml(listEl, "");
      alertEl?.classList.add("hidden");
      emptyEl?.classList.add("hidden");
      countEl?.classList.add("hidden");
      showError(errorEl, error.message || "Could not load receipt days needing a buying price.");
      return [];
    }
    // Re-check after await: user may have started typing while the fetch was in flight.
    if (!force && hasUnsavedEdits(listEl)) {
      return null;
    }
    const rows = data ?? [];
    renderMissingBuyingList(rows, { listEl, alertEl, emptyEl, errorEl, countEl, onSaved });
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
