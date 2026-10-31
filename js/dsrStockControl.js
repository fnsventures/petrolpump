/* global AppError, AppDialog, escapeHtml, formatQuantity, formatCurrency, formatDisplayDate, getLocalDateString, addDaysToDateString, PumpSettings, supabaseClient */

/**
 * DSR → Stock control sections (loaded by dsr.html after dsr.js wires the nav):
 *   #stock-variance  get_stock_variance(from, to)             — dip vs book per tank and day
 *   #decantation     tanker_decantations (table, RLS)          — dip before/after, short delivery
 */
(function () {
  const SECTIONS = new Set(["stock-variance", "decantation"]);
  const PRODUCT_LABEL = { petrol: "MS", diesel: "HSD" };

  let isAdmin = false;
  const loaded = { "stock-variance": false, decantation: false };
  let editingDecantId = null;
  let decantRows = [];

  const el = (id) => document.getElementById(id);
  const num = (v) => {
    const s = String(v ?? "").trim().replace(/,/g, "");
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const signed = (v, fmt) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v)}`);

  function monthStart() {
    const today = getLocalDateString();
    return today.slice(0, 8) + "01";
  }

  function initRange(startId, endId, onChange, start = monthStart()) {
    const s = el(startId);
    const e = el(endId);
    if (!s || !e) return;
    if (!s.value) s.value = start;
    if (!e.value) e.value = getLocalDateString();
    const fire = () => {
      if (s.value && e.value && s.value <= e.value) onChange();
    };
    s.addEventListener("change", fire);
    e.addEventListener("change", fire);
  }

  function showError(id, err) {
    const box = el(id);
    if (!box) return;
    if (!err) {
      box.classList.add("hidden");
      box.textContent = "";
      return;
    }
    box.textContent = AppError.getUserMessage(err);
    box.classList.remove("hidden");
  }

  // ─── Stock variance ──────────────────────────────────────────────────────

  let svRows = [];
  let svTolerance = null;

  async function loadStockVariance() {
    const body = el("sv-body");
    const start = el("sv-start")?.value;
    const end = el("sv-end")?.value;
    if (!body || !start || !end) return;
    body.innerHTML = '<tr><td colspan="11" class="muted">Loading…</td></tr>';
    showError("sv-error", null);
    const { data, error } = await supabaseClient.rpc("get_stock_variance", { p_start: start, p_end: end });
    if (error) {
      AppError.report(error, { context: "stockVarianceLoad" });
      showError("sv-error", error);
      body.innerHTML = '<tr><td colspan="11" class="muted">Could not load.</td></tr>';
      el("sv-stats")?.classList.add("hidden");
      return;
    }
    svRows = data ?? [];
    loaded["stock-variance"] = true;
    svTolerance = svRows[0]?.tolerance_pct ?? PumpSettings.getAlertThresholds().stockVarianceTolerancePct;
    const tolLabel = el("sv-tolerance-label");
    if (tolLabel) tolLabel.textContent = formatQuantity(svTolerance);
    renderStockVariance();
  }

  function sumRows(rows, key) {
    return rows.filter((r) => r[key] != null).reduce((a, r) => a + Number(r[key]), 0);
  }

  function renderVarianceRow(r) {
    const cls = r.over_tolerance ? ' class="sv-row--over"' : "";
    return `<tr${cls}>
          <td>${escapeHtml(formatDisplayDate(r.date))}</td>
          <td>${PRODUCT_LABEL[r.product] || escapeHtml(r.product)}</td>
          <td>${formatQuantity(r.opening_dip)}</td>
          <td>${formatQuantity(r.receipts)}${r.decanted_invoice_litres != null ? ' <small class="muted">inv.</small>' : ""}</td>
          <td>${formatQuantity(r.meter_sales)}</td>
          <td>${formatQuantity(r.book_stock)}</td>
          <td>${r.closing_dip == null ? '<span class="muted">No dip</span>' : formatQuantity(r.closing_dip)}</td>
          <td class="sv-variance">${signed(r.variance_litres, formatQuantity)}</td>
          <td>${r.variance_pct == null ? "—" : signed(r.variance_pct, formatQuantity) + "%"}</td>
          <td>${signed(r.variance_value, formatCurrency)}</td>
          <td>${r.delivery_variance_litres == null ? "—" : signed(r.delivery_variance_litres, formatQuantity)}</td>
        </tr>`;
  }

  /** Per-tank subtotal. Variance % uses only days with a closing dip, as the per-day rows do. */
  function renderVarianceSubtotal(product, rows) {
    const dipped = rows.filter((r) => r.closing_dip != null);
    const varL = sumRows(dipped, "variance_litres");
    const saleL = sumRows(dipped, "meter_sales");
    const pct = saleL > 0 ? (varL / saleL) * 100 : null;
    const delivery = rows.some((r) => r.delivery_variance_litres != null) ? sumRows(rows, "delivery_variance_litres") : null;
    return `<tr class="sv-subtotal">
          <td colspan="2">${PRODUCT_LABEL[product] || escapeHtml(product)} total</td>
          <td>—</td>
          <td>${formatQuantity(sumRows(rows, "receipts"))}</td>
          <td>${formatQuantity(sumRows(rows, "meter_sales"))}</td>
          <td>—</td>
          <td>—</td>
          <td class="sv-variance">${signed(varL, formatQuantity)}</td>
          <td>${pct == null ? "—" : signed(pct, formatQuantity) + "%"}</td>
          <td>${signed(sumRows(rows, "variance_value"), formatCurrency)}</td>
          <td>${delivery == null ? "—" : signed(delivery, formatQuantity)}</td>
        </tr>`;
  }

  function renderStockVariance() {
    const body = el("sv-body");
    if (!body) return;
    const filter = /** @type {HTMLSelectElement} */ (el("sv-product"))?.value || "";
    const products = (filter ? [filter] : ["petrol", "diesel"]).filter((p) => svRows.some((r) => r.product === p));
    const rows = svRows.filter((r) => products.includes(r.product));
    const tol = svTolerance;

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="11" class="muted">No meter readings in this range.</td></tr>';
      el("sv-stats")?.classList.add("hidden");
      return;
    }
    // One block per tank (MS, then HSD), each closed by its subtotal.
    body.innerHTML = products
      .map((p) => {
        const pRows = rows.filter((r) => r.product === p);
        return pRows.map(renderVarianceRow).join("") + renderVarianceSubtotal(p, pRows);
      })
      .join("");

    const byProduct = (product) => rows.filter((r) => r.product === product);
    const setText = (id, text) => {
      const node = el(id);
      if (node) node.textContent = text;
    };
    const tone = (id, v) => {
      const node = el(id);
      node?.classList.toggle("stat-negative", v < 0);
      node?.classList.toggle("stat-positive", v > 0);
    };
    const pL = sumRows(byProduct("petrol"), "variance_litres");
    const dL = sumRows(byProduct("diesel"), "variance_litres");
    const total = sumRows(rows, "variance_value");
    setText("sv-petrol-l", `${signed(pL, formatQuantity)} L`);
    setText("sv-diesel-l", `${signed(dL, formatQuantity)} L`);
    setText("sv-petrol-rs", signed(sumRows(byProduct("petrol"), "variance_value"), formatCurrency));
    setText("sv-diesel-rs", signed(sumRows(byProduct("diesel"), "variance_value"), formatCurrency));
    setText("sv-total-rs", signed(total, formatCurrency));
    el("sv-card-petrol")?.classList.toggle("hidden", filter === "diesel");
    el("sv-card-diesel")?.classList.toggle("hidden", filter === "petrol");
    const over = rows.filter((r) => r.over_tolerance).length;
    setText("sv-over-count", over ? `${over} tank-day(s) over ${formatQuantity(tol)}%` : `All within ${formatQuantity(tol)}%`);
    const shortDel = rows
      .filter((r) => r.delivery_variance_litres != null && Number(r.delivery_variance_litres) < 0)
      .reduce((a, r) => a + Number(r.delivery_variance_litres), 0);
    setText("sv-short-delivery", `${formatQuantity(shortDel)} L`);
    tone("sv-petrol-l", pL);
    tone("sv-diesel-l", dL);
    tone("sv-total-rs", total);
    el("sv-stats")?.classList.remove("hidden");
  }

  // ─── Tanker decantation ──────────────────────────────────────────────────

  const DECANT_FIELDS = {
    "decant-date": "decant_date",
    "decant-product": "product",
    "decant-invoice-no": "invoice_no",
    "decant-invoice-doc": "invoice_document_id",
    "decant-truck": "truck_no",
    "decant-invoice-qty": "invoice_qty_litres",
    "decant-dip-before": "dip_before_cm",
    "decant-stock-before": "stock_before_litres",
    "decant-dip-after": "dip_after_cm",
    "decant-stock-after": "stock_after_litres",
    "decant-density": "density_kg_m3",
    "decant-invoice-density": "invoice_density_kg_m3",
    "decant-temp": "temperature_c",
    "decant-remarks": "remarks",
  };
  const TEXT_FIELDS = new Set(["decant_date", "product", "invoice_no", "invoice_document_id", "truck_no", "remarks"]);
  const REQUIRED = { invoice_qty_litres: "Invoice qty", stock_before_litres: "Stock before", stock_after_litres: "Stock after" };

  function readDecantForm() {
    const row = {};
    for (const [id, col] of Object.entries(DECANT_FIELDS)) {
      const raw = /** @type {HTMLInputElement} */ (el(id))?.value ?? "";
      if (TEXT_FIELDS.has(col)) {
        row[col] = raw.trim() || null;
      } else {
        const n = num(raw);
        if (Number.isNaN(n)) throw new Error(`${el(id)?.labels?.[0]?.textContent || col} must be a number.`);
        row[col] = n;
      }
    }
    if (!row.decant_date) throw new Error("Date is required.");
    for (const [col, label] of Object.entries(REQUIRED)) {
      if (row[col] == null) throw new Error(`${label} is required.`);
    }
    if (row.invoice_qty_litres <= 0) throw new Error("Invoice qty must be more than 0.");
    if (row.stock_after_litres < row.stock_before_litres) throw new Error("Stock after must be at least stock before.");
    return row;
  }

  function updateDecantPreview() {
    const out = el("decant-preview");
    if (!out) return;
    const before = num(el("decant-stock-before")?.value);
    const after = num(el("decant-stock-after")?.value);
    const inv = num(el("decant-invoice-qty")?.value);
    if ([before, after, inv].some((v) => v == null || Number.isNaN(v))) {
      out.textContent = "";
      out.classList.remove("stat-negative", "stat-positive");
      return;
    }
    const received = after - before;
    const diff = received - inv;
    out.textContent = `Received ${formatQuantity(received)} L · ${
      diff < 0 ? "Short delivery" : diff > 0 ? "Excess" : "Exact"
    } ${formatQuantity(Math.abs(diff))} L`;
    out.classList.toggle("stat-negative", diff < 0);
    out.classList.toggle("stat-positive", diff > 0);
  }

  function resetDecantForm() {
    editingDecantId = null;
    const form = /** @type {HTMLFormElement} */ (el("decant-form"));
    const date = /** @type {HTMLInputElement} */ (el("decant-date"));
    const keepDate = date?.value || getLocalDateString();
    form?.reset();
    if (date) date.value = keepDate;
    el("decant-cancel")?.classList.add("hidden");
    const save = el("decant-save");
    if (save) save.textContent = "Save decantation";
    updateDecantPreview();
  }

  function fillDecantForm(row) {
    editingDecantId = row.id;
    for (const [id, col] of Object.entries(DECANT_FIELDS)) {
      const input = /** @type {HTMLInputElement} */ (el(id));
      if (input) input.value = row[col] == null ? "" : String(row[col]);
    }
    el("decant-cancel")?.classList.remove("hidden");
    const save = el("decant-save");
    if (save) save.textContent = "Update decantation";
    updateDecantPreview();
    el("decant-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadInvoiceOptions() {
    const select = el("decant-invoice-doc");
    if (!select) return;
    const since = addDaysToDateString(getLocalDateString(), -90);
    const { data, error } = await supabaseClient
      .from("invoice_documents")
      .select("id, invoice_date, title, vendor, amount")
      .eq("category", "purchase")
      .gte("invoice_date", since)
      .order("invoice_date", { ascending: false })
      .limit(200);
    if (error) {
      AppError.report(error, { context: "decantInvoiceOptions" });
      return;
    }
    const current = /** @type {HTMLSelectElement} */ (select).value;
    select.innerHTML =
      '<option value="">Not linked</option>' +
      (data ?? [])
        .map(
          (d) =>
            `<option value="${escapeHtml(d.id)}">${escapeHtml(formatDisplayDate(d.invoice_date))} · ${escapeHtml(
              d.title || d.vendor || "Invoice"
            )}${d.amount ? " · " + escapeHtml(formatCurrency(d.amount)) : ""}</option>`
        )
        .join("");
    /** @type {HTMLSelectElement} */ (select).value = current;
  }

  async function loadDecantations() {
    const body = el("decant-body");
    const start = el("decant-list-start")?.value;
    const end = el("decant-list-end")?.value;
    if (!body || !start || !end) return;
    body.innerHTML = '<tr><td colspan="11" class="muted">Loading…</td></tr>';
    const { data, error } = await supabaseClient
      .from("tanker_decantations")
      .select("*")
      .gte("decant_date", start)
      .lte("decant_date", end)
      .order("decant_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      AppError.report(error, { context: "decantLoad" });
      body.innerHTML = `<tr><td colspan="11" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      return;
    }
    loaded.decantation = true;
    decantRows = data ?? [];
    if (!decantRows.length) {
      body.innerHTML = '<tr><td colspan="11" class="muted">No decantations in this range.</td></tr>';
      return;
    }
    body.innerHTML = decantRows
      .map((r) => {
        const diff = Number(r.delivery_variance_litres);
        const cls = diff < 0 ? "stat-negative" : diff > 0 ? "stat-positive" : "";
        const density =
          r.density_kg_m3 != null || r.invoice_density_kg_m3 != null
            ? `${formatQuantity(r.density_kg_m3)} / ${formatQuantity(r.invoice_density_kg_m3)}`
            : "—";
        return `<tr>
          <td>${escapeHtml(formatDisplayDate(r.decant_date))}</td>
          <td>${PRODUCT_LABEL[r.product] || escapeHtml(r.product)}</td>
          <td>${escapeHtml(r.invoice_no || "—")}${r.invoice_document_id ? ' <small class="muted">vault</small>' : ""}</td>
          <td>${formatQuantity(r.invoice_qty_litres)}</td>
          <td>${formatQuantity(r.stock_before_litres)}</td>
          <td>${formatQuantity(r.stock_after_litres)}</td>
          <td>${formatQuantity(r.received_litres)}</td>
          <td class="${cls}">${signed(diff, formatQuantity)}</td>
          <td>${density}</td>
          <td>${r.temperature_c == null ? "—" : escapeHtml(formatQuantity(r.temperature_c)) + " °C"}</td>
          <td class="table-actions">
            <button type="button" class="button-secondary button-sm" data-decant-edit="${escapeHtml(r.id)}">Edit</button>
            ${isAdmin ? `<button type="button" class="button-delete button-sm" data-decant-delete="${escapeHtml(r.id)}">Delete</button>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  async function saveDecantation(e) {
    e.preventDefault();
    showError("decant-error", null);
    let row;
    try {
      row = readDecantForm();
    } catch (err) {
      showError("decant-error", err);
      return;
    }
    const btn = /** @type {HTMLButtonElement} */ (el("decant-save"));
    if (btn) btn.disabled = true;
    try {
      const { data: auth } = await supabaseClient.auth.getUser();
      const { error } = editingDecantId
        ? await supabaseClient.from("tanker_decantations").update(row).eq("id", editingDecantId)
        : await supabaseClient.from("tanker_decantations").insert({ ...row, created_by: auth?.user?.id });
      if (error) throw error;
      AppError.showToast(editingDecantId ? "Decantation updated." : "Decantation saved.", "success");
      resetDecantForm();
      loaded["stock-variance"] = false;
      await loadDecantations();
    } catch (err) {
      AppError.report(err, { context: "decantSave" });
      showError("decant-error", err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onDecantTableClick(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    const editId = target.closest("[data-decant-edit]")?.getAttribute("data-decant-edit");
    if (editId) {
      const row = decantRows.find((r) => r.id === editId);
      if (row) fillDecantForm(row);
      return;
    }
    const delId = target.closest("[data-decant-delete]")?.getAttribute("data-decant-delete");
    if (!delId) return;
    if (!(await AppDialog.confirm("Delete this decantation record?", { title: "Delete", confirmLabel: "Delete" }))) return;
    const { error } = await supabaseClient.from("tanker_decantations").delete().eq("id", delId);
    if (error) {
      AppError.report(error, { context: "decantDelete" });
      AppError.showToast(AppError.getUserMessage(error), "error");
      return;
    }
    if (editingDecantId === delId) resetDecantForm();
    loaded["stock-variance"] = false;
    await loadDecantations();
  }

  function initDecantation() {
    const date = /** @type {HTMLInputElement} */ (el("decant-date"));
    if (date) {
      date.value = getLocalDateString();
      date.max = getLocalDateString();
    }
    el("decant-form")?.addEventListener("submit", saveDecantation);
    el("decant-cancel")?.addEventListener("click", resetDecantForm);
    ["decant-stock-before", "decant-stock-after", "decant-invoice-qty"].forEach((id) =>
      el(id)?.addEventListener("input", updateDecantPreview)
    );
    el("decant-body")?.addEventListener("click", (e) => void onDecantTableClick(e));
    initRange("decant-list-start", "decant-list-end", () => void loadDecantations());
  }

  // ─── Wiring ──────────────────────────────────────────────────────────────

  let initialised = false;
  function init(opts) {
    if (initialised) return;
    initialised = true;
    isAdmin = Boolean(opts?.isAdmin);
    initRange("sv-start", "sv-end", () => void loadStockVariance());
    el("sv-product")?.addEventListener("change", renderStockVariance);
    initDecantation();
  }

  /** Called by dsr.js on every section change. */
  function onSection(section) {
    if (!SECTIONS.has(section)) return;
    if (section === "stock-variance" && !loaded["stock-variance"]) void loadStockVariance();
    if (section === "decantation" && !loaded.decantation) {
      void loadDecantations();
      void loadInvoiceOptions();
    }
  }

  function refresh() {
    loaded["stock-variance"] = false;
    loaded.decantation = false;
  }

  window.DsrStockControl = { SECTIONS, init, onSection, refresh };
})();
