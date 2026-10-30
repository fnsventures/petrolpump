/* global AppError, AppDialog, escapeHtml, formatQuantity, formatCurrency, formatDisplayDate, getLocalDateString, addDaysToDateString, PumpSettings, StatementCsv, supabaseClient */

/**
 * DSR → Stock control sections (loaded by dsr.html after dsr.js wires the nav):
 *   #stock-variance  get_stock_variance(from, to)             — dip vs book per tank and day
 *   #decantation     tanker_decantations (table, RLS)          — dip before/after, short delivery
 *   #settlement      import_settlement_lines / get_settlement_match (admin) — statement CSV match
 */
(function () {
  const SECTIONS = new Set(["stock-variance", "decantation", "settlement"]);
  const PRODUCT_LABEL = { petrol: "MS", diesel: "HSD" };
  const STATUS_LABEL = {
    matched: ["Matched", "badge--success"],
    short: ["Bank short", "badge--danger"],
    excess: ["Bank excess", "badge--warning"],
    missing_bank: ["Not in bank", "badge--danger"],
    bank_only: ["Bank only", "badge--warning"],
  };

  let isAdmin = false;
  const loaded = { "stock-variance": false, decantation: false, settlement: false };
  let editingDecantId = null;
  let decantRows = [];
  let parsedStatement = null;

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
    const rows = data ?? [];
    loaded["stock-variance"] = true;
    const tol = rows[0]?.tolerance_pct ?? PumpSettings.getAlertThresholds().stockVarianceTolerancePct;
    const tolLabel = el("sv-tolerance-label");
    if (tolLabel) tolLabel.textContent = formatQuantity(tol);

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="11" class="muted">No meter readings in this range.</td></tr>';
      el("sv-stats")?.classList.add("hidden");
      return;
    }
    body.innerHTML = rows
      .map((r) => {
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
      })
      .join("");

    const sum = (product, key) =>
      rows.filter((r) => (!product || r.product === product) && r[key] != null).reduce((a, r) => a + Number(r[key]), 0);
    const setText = (id, text) => {
      const node = el(id);
      if (node) node.textContent = text;
    };
    const tone = (id, v) => {
      const node = el(id);
      node?.classList.toggle("stat-negative", v < 0);
      node?.classList.toggle("stat-positive", v > 0);
    };
    const pL = sum("petrol", "variance_litres");
    const dL = sum("diesel", "variance_litres");
    const total = sum(null, "variance_value");
    setText("sv-petrol-l", `${signed(pL, formatQuantity)} L`);
    setText("sv-diesel-l", `${signed(dL, formatQuantity)} L`);
    setText("sv-petrol-rs", signed(sum("petrol", "variance_value"), formatCurrency));
    setText("sv-diesel-rs", signed(sum("diesel", "variance_value"), formatCurrency));
    setText("sv-total-rs", signed(total, formatCurrency));
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

  // ─── Settlement ──────────────────────────────────────────────────────────

  function fillColumnSelect(id, header, selected, optional) {
    const select = /** @type {HTMLSelectElement} */ (el(id));
    if (!select) return;
    select.innerHTML =
      (optional ? '<option value="-1">— None —</option>' : "") +
      header.map((h, i) => `<option value="${i}">${escapeHtml(h || `Column ${i + 1}`)}</option>`).join("");
    select.value = String(selected >= 0 ? selected : optional ? -1 : 0);
  }

  function currentMap() {
    const v = (id) => Number(/** @type {HTMLSelectElement} */ (el(id))?.value ?? -1);
    return {
      date: v("stl-col-date"),
      amount: v("stl-col-amount"),
      reference: v("stl-col-reference"),
      description: v("stl-col-description"),
      dateOrder: /** @type {HTMLSelectElement} */ (el("stl-date-order"))?.value || "dmy",
    };
  }

  function refreshStatementPreview() {
    const out = el("stl-preview");
    const btn = /** @type {HTMLButtonElement} */ (el("stl-import"));
    if (!parsedStatement || !out) return;
    const { lines, skipped } = StatementCsv.mapStatementRows(parsedStatement.rows, currentMap());
    parsedStatement.lines = lines;
    const total = lines.reduce((a, l) => a + l.amount, 0);
    const dates = lines.map((l) => l.date).sort();
    out.textContent = lines.length
      ? `${lines.length} credit line(s), ${formatCurrency(total)}, ${formatDisplayDate(dates[0])} – ${formatDisplayDate(
          dates[dates.length - 1]
        )}. ${skipped} row(s) skipped (debits, blanks or unreadable).`
      : `No credit lines found with this mapping (${skipped} row(s) skipped). Check the amount and date columns.`;
    if (btn) btn.disabled = lines.length === 0;
  }

  async function onStatementFile() {
    const input = /** @type {HTMLInputElement} */ (el("stl-file"));
    const file = input?.files?.[0];
    showError("stl-upload-error", null);
    parsedStatement = null;
    el("stl-mapping")?.classList.add("hidden");
    const btn = /** @type {HTMLButtonElement} */ (el("stl-import"));
    if (btn) btn.disabled = true;
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showError("stl-upload-error", new Error("File is larger than 5 MB."));
      return;
    }
    const rows = StatementCsv.parseCsv(await file.text());
    if (rows.length < 2) {
      showError("stl-upload-error", new Error("The file has no data rows."));
      return;
    }
    const headerIdx = StatementCsv.findHeaderRow(rows);
    const header = rows[headerIdx];
    const guess = StatementCsv.guessColumns(header);
    parsedStatement = { fileName: file.name, header, rows: rows.slice(headerIdx + 1), lines: [] };
    fillColumnSelect("stl-col-date", header, guess.date, false);
    fillColumnSelect("stl-col-amount", header, guess.amount, false);
    fillColumnSelect("stl-col-reference", header, guess.reference, true);
    fillColumnSelect("stl-col-description", header, guess.description, true);
    el("stl-mapping")?.classList.remove("hidden");
    refreshStatementPreview();
  }

  async function importStatement(e) {
    e.preventDefault();
    showError("stl-upload-error", null);
    const source = /** @type {HTMLInputElement} */ (el("stl-source"))?.value.trim();
    if (!source) {
      showError("stl-upload-error", new Error("Name the statement source first."));
      return;
    }
    if (!parsedStatement?.lines?.length) return;
    const btn = /** @type {HTMLButtonElement} */ (el("stl-import"));
    if (btn) btn.disabled = true;
    const map = currentMap();
    const { data, error } = await supabaseClient.rpc("import_settlement_lines", {
      p_source: source,
      p_file_name: parsedStatement.fileName,
      p_column_map: {
        date: parsedStatement.header[map.date] ?? null,
        amount: parsedStatement.header[map.amount] ?? null,
        reference: parsedStatement.header[map.reference] ?? null,
        description: parsedStatement.header[map.description] ?? null,
        dateOrder: map.dateOrder,
      },
      p_lines: parsedStatement.lines,
    });
    if (btn) btn.disabled = false;
    if (error) {
      AppError.report(error, { context: "settlementImport" });
      showError("stl-upload-error", error);
      return;
    }
    AppError.showToast(`Imported ${data?.inserted ?? 0} line(s); ${data?.skipped ?? 0} skipped as duplicates.`, "success");
    /** @type {HTMLFormElement} */ (el("stl-upload-form"))?.reset();
    el("stl-mapping")?.classList.add("hidden");
    const preview = el("stl-preview");
    if (preview) preview.textContent = "";
    parsedStatement = null;
    await Promise.all([loadSettlementMatch(), loadImports()]);
  }

  async function loadSettlementMatch() {
    const body = el("stl-body");
    const start = el("stl-start")?.value;
    const end = el("stl-end")?.value;
    if (!body || !start || !end) return;
    body.innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
    showError("stl-error", null);
    const { data, error } = await supabaseClient.rpc("get_settlement_match", {
      p_start: start,
      p_end: end,
      p_lag_days: Number(/** @type {HTMLSelectElement} */ (el("stl-lag"))?.value || 0),
    });
    if (error) {
      AppError.report(error, { context: "settlementMatch" });
      showError("stl-error", error);
      body.innerHTML = '<tr><td colspan="8" class="muted">Could not load.</td></tr>';
      return;
    }
    loaded.settlement = true;
    const all = data ?? [];
    const onlyUnmatched = /** @type {HTMLSelectElement} */ (el("stl-filter"))?.value !== "all";
    const rows = onlyUnmatched ? all.filter((r) => r.status !== "matched") : all;
    const unmatched = all.filter((r) => r.status !== "matched");
    const summary = el("stl-summary");
    if (summary) {
      const missing = unmatched.reduce((a, r) => a + Math.min(Number(r.difference) || 0, 0), 0);
      summary.textContent = all.length
        ? `${all.length - unmatched.length} of ${all.length} day(s) matched. ${
            unmatched.length ? `${unmatched.length} unmatched; ${formatCurrency(Math.abs(missing))} missing from the bank.` : ""
          }`
        : "No UPI recorded and no statement lines in this range.";
    }
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="muted">${all.length ? "Every day matched." : "Nothing to show."}</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map((r) => {
        const [label, badge] = STATUS_LABEL[r.status] || [r.status, "badge--neutral"];
        const diff = Number(r.difference);
        return `<tr>
          <td>${escapeHtml(formatDisplayDate(r.business_date))}</td>
          <td>${escapeHtml(formatDisplayDate(r.bank_date))}</td>
          <td>${formatCurrency(r.app_digital)}</td>
          <td class="muted">${r.app_source === "day_closing" ? "Day closing" : r.app_source ? "Shift + credit" : "—"}</td>
          <td>${formatCurrency(r.bank_amount)}</td>
          <td>${escapeHtml(String(r.bank_lines))}</td>
          <td class="${diff < 0 ? "stat-negative" : diff > 0 ? "stat-positive" : ""}">${signed(diff, formatCurrency)}</td>
          <td><span class="badge badge--sm ${badge}">${escapeHtml(label)}</span></td>
        </tr>`;
      })
      .join("");
  }

  async function loadImports() {
    const body = el("stl-imports-body");
    if (!body) return;
    const { data, error } = await supabaseClient
      .from("settlement_imports")
      .select("id, source, file_name, line_count, skipped_count, first_date, last_date, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      AppError.report(error, { context: "settlementImports" });
      body.innerHTML = `<tr><td colspan="7" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      return;
    }
    body.innerHTML = (data ?? []).length
      ? data
          .map(
            (r) => `<tr>
          <td>${escapeHtml(formatDisplayDate(String(r.created_at).slice(0, 10)))}</td>
          <td>${escapeHtml(r.source)}</td>
          <td>${escapeHtml(r.file_name || "—")}</td>
          <td>${escapeHtml(formatDisplayDate(r.first_date))} – ${escapeHtml(formatDisplayDate(r.last_date))}</td>
          <td>${escapeHtml(String(r.line_count))}</td>
          <td>${escapeHtml(String(r.skipped_count))}</td>
          <td class="table-actions"><button type="button" class="button-delete button-sm" data-import-delete="${escapeHtml(r.id)}">Remove</button></td>
        </tr>`
          )
          .join("")
      : '<tr><td colspan="7" class="muted">No statements imported yet.</td></tr>';
  }

  async function onImportsClick(e) {
    const id = /** @type {HTMLElement} */ (e.target).closest("[data-import-delete]")?.getAttribute("data-import-delete");
    if (!id) return;
    if (!(await AppDialog.confirm("Remove this statement and all its lines?", { title: "Remove statement", confirmLabel: "Remove" }))) {
      return;
    }
    const { error } = await supabaseClient.from("settlement_imports").delete().eq("id", id);
    if (error) {
      AppError.report(error, { context: "settlementImportDelete" });
      AppError.showToast(AppError.getUserMessage(error), "error");
      return;
    }
    await Promise.all([loadImports(), loadSettlementMatch()]);
  }

  function initSettlement() {
    el("stl-file")?.addEventListener("change", () => void onStatementFile());
    ["stl-col-date", "stl-col-amount", "stl-col-reference", "stl-col-description", "stl-date-order"].forEach((id) =>
      el(id)?.addEventListener("change", refreshStatementPreview)
    );
    el("stl-upload-form")?.addEventListener("submit", (e) => void importStatement(e));
    el("stl-imports-body")?.addEventListener("click", (e) => void onImportsClick(e));
    ["stl-lag", "stl-filter"].forEach((id) => el(id)?.addEventListener("change", () => void loadSettlementMatch()));
    initRange("stl-start", "stl-end", () => void loadSettlementMatch());
  }

  // ─── Wiring ──────────────────────────────────────────────────────────────

  let initialised = false;
  function init(opts) {
    if (initialised) return;
    initialised = true;
    isAdmin = Boolean(opts?.isAdmin);
    initRange("sv-start", "sv-end", () => void loadStockVariance());
    initDecantation();
    if (isAdmin) initSettlement();
  }

  /** Called by dsr.js on every section change. */
  function onSection(section) {
    if (!SECTIONS.has(section)) return;
    if (section === "stock-variance" && !loaded["stock-variance"]) void loadStockVariance();
    if (section === "decantation" && !loaded.decantation) {
      void loadDecantations();
      void loadInvoiceOptions();
    }
    if (section === "settlement" && isAdmin && !loaded.settlement) {
      void loadSettlementMatch();
      void loadImports();
    }
  }

  function refresh() {
    loaded["stock-variance"] = false;
    loaded.decantation = false;
    loaded.settlement = false;
  }

  window.DsrStockControl = { SECTIONS, init, onSection, refresh };
})();
