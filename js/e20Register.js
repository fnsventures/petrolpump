/* global requireAuth, applyRoleVisibility, supabaseClient, AppError, escapeHtml, formatDisplayDate, getLocalDateString, initPersistedDateInput, savePersistedDate, RECORD_DATE_KEYS, PumpSettings, loadPumpSettings, PrintUtils, AppConfig */

(function () {
  const QUALITY_SLOTS = [
    { no: 1, time: "06:00" },
    { no: 2, time: "08:00" },
    { no: 3, time: "10:00" },
    { no: 4, time: "12:00" },
    { no: 5, time: "14:00" },
    { no: 6, time: "16:00" },
    { no: 7, time: "18:00" },
    { no: 8, time: "20:00" },
    { no: 9, time: "22:00" },
    { no: 10, time: "00:00" },
    { no: 11, time: "02:00" },
    { no: 12, time: "04:00" },
  ];

  const DEFAULT_TANKS = ["MS Tank-1", "MS Tank-2"];
  const PRINT_CSS = "css/e20-register-print.css?v=1";
  const REGISTER_SELECT = `
    id, register_date, retail_outlet_name, cc_code, certified, certified_at, dealer_sign_name, remarks,
    e20_water_checks (
      check_time, tank_no, opening_dip_mm, water_finding_mm, water_present,
      corrective_action, tested_by, manager_signed, sort_order
    ),
    e20_quality_checks (
      slot_no, check_time, visual_appearance, water_separation, action_taken, tested_by, tester_signed
    )
  `.replace(/\s+/g, " ").trim();

  const EMPTY_WATER_ROW =
    "<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>";

  let currentAuth = null;
  let currentRegisterId = null;
  let printCssCache = null;
  let printCssInflight = null;
  let loadSeq = 0;
  let historyRows = [];

  const dom = {};

  document.addEventListener("DOMContentLoaded", async () => {
    const auth = await requireAuth({
      allowedRoles: ["admin", "supervisor"],
      onDenied: "dashboard.html",
      pageName: "e20-register",
    });
    if (!auth) return;
    currentAuth = auth;
    applyRoleVisibility(auth.role);

    cacheDom();
    bindEvents();

    const today = getLocalDateString();
    const dateStr = initPersistedDateInput(dom.dateInput, RECORD_DATE_KEYS.e20Register, {
      urlParam: "date",
      fallback: today,
      onChange: (value) => void loadRegister(value),
    });

    renderBlankForm();
    await loadPumpSettings();
    prefillStationMeta(true);
    await Promise.all([
      loadStaffNames(),
      loadRegister(dateStr),
      loadHistory(),
      getPrintCssText().catch(() => null),
    ]);
  });

  function cacheDom() {
    dom.form = document.getElementById("e20-form");
    dom.dateInput = document.getElementById("e20-date");
    dom.outlet = document.getElementById("e20-outlet");
    dom.cc = document.getElementById("e20-cc");
    dom.waterBody = document.getElementById("e20-water-body");
    dom.qualityBody = document.getElementById("e20-quality-body");
    dom.certified = document.getElementById("e20-certified");
    dom.certifiedAt = document.getElementById("e20-certified-at");
    dom.dealer = document.getElementById("e20-dealer");
    dom.remarks = document.getElementById("e20-remarks");
    dom.status = document.getElementById("e20-status");
    dom.success = document.getElementById("e20-success");
    dom.error = document.getElementById("e20-error");
    dom.saveBtn = document.getElementById("e20-save-btn");
    dom.deleteBtn = document.getElementById("e20-delete-btn");
    dom.printBtn = document.getElementById("e20-print-btn");
    dom.addTankBtn = document.getElementById("e20-add-tank");
    dom.staffList = document.getElementById("e20-staff-list");
    dom.history = document.getElementById("e20-history");
  }

  function stationDefaults() {
    return {
      outlet:
        PumpSettings.getStationField?.("retailOutletName") ||
        AppConfig?.DEFAULT_STATION?.retailOutletName ||
        PumpSettings.getStationDisplayName?.() ||
        "",
      cc:
        PumpSettings.getStationField?.("ccCode") ||
        AppConfig?.DEFAULT_STATION?.ccCode ||
        "",
    };
  }

  function prefillStationMeta(force = false) {
    const { outlet, cc } = stationDefaults();
    if (dom.outlet && (force || !dom.outlet.value)) dom.outlet.value = outlet;
    if (dom.cc && (force || !dom.cc.value)) dom.cc.value = cc;
  }

  function bindEvents() {
    dom.form?.addEventListener("submit", onSave);
    dom.addTankBtn?.addEventListener("click", () => {
      appendWaterRow({ tank_no: "", check_time: "06:10" });
    });
    dom.waterBody?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-water]");
      if (!btn) return;
      btn.closest("tr")?.remove();
    });
    dom.printBtn?.addEventListener("click", () => void printRegister());
    dom.deleteBtn?.addEventListener("click", () => void deleteRegister());
    dom.certified?.addEventListener("change", () => {
      if (dom.certified.checked && dom.certifiedAt && !dom.certifiedAt.value) {
        dom.certifiedAt.value = toDatetimeLocalValue(new Date());
      }
    });
    dom.history?.addEventListener("click", (e) => {
      const link = e.target.closest("a[data-date]");
      if (!link) return;
      e.preventDefault();
      const date = link.getAttribute("data-date");
      if (!date || !dom.dateInput) return;
      dom.dateInput.value = date;
      savePersistedDate(RECORD_DATE_KEYS.e20Register, date);
      const url = new URL(window.location.href);
      url.searchParams.set("date", date);
      window.history.replaceState({}, "", url);
      void loadRegister(date);
    });
  }

  async function loadStaffNames() {
    try {
      const { data, error } = await supabaseClient.rpc("list_employees_roster");
      if (error) throw error;
      if (!dom.staffList) return;
      dom.staffList.innerHTML = (data || [])
        .map((r) => r.name)
        .filter(Boolean)
        .map((name) => `<option value="${escapeHtml(name)}"></option>`)
        .join("");
    } catch (err) {
      AppError.report(err, { context: "e20LoadStaff" });
    }
  }

  function yesNoValue(value) {
    if (value === true || value === "yes" || value === "true") return "yes";
    if (value === false || value === "no" || value === "false") return "no";
    return "";
  }

  function yesNoSelect(name, value) {
    const v = yesNoValue(value);
    return `<select name="${name}" aria-label="${escapeHtml(name)}">
      <option value="">—</option>
      <option value="yes"${v === "yes" ? " selected" : ""}>Yes</option>
      <option value="no"${v === "no" ? " selected" : ""}>No</option>
    </select>`;
  }

  function appearanceSelect(value) {
    const v = value === "hazy" ? "hazy" : value === "clear_bright" ? "clear_bright" : "";
    return `<select name="visual_appearance" aria-label="Visual appearance">
      <option value="">—</option>
      <option value="clear_bright"${v === "clear_bright" ? " selected" : ""}>Clear &amp; Bright</option>
      <option value="hazy"${v === "hazy" ? " selected" : ""}>Hazy</option>
    </select>`;
  }

  function timeInputValue(t) {
    if (!t) return "";
    const s = String(t);
    return s.length >= 5 ? s.slice(0, 5) : s;
  }

  function escapeAttrNum(v) {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : "";
  }

  function waterRowHtml(row = {}) {
    return `<tr>
      <td><input type="time" name="check_time" value="${escapeHtml(timeInputValue(row.check_time) || "06:10")}" /></td>
      <td><input type="text" name="tank_no" maxlength="64" value="${escapeHtml(row.tank_no || "")}" placeholder="MS Tank-1" /></td>
      <td><input type="number" name="opening_dip_mm" inputmode="decimal" step="0.1" min="0" value="${escapeAttrNum(row.opening_dip_mm)}" /></td>
      <td><input type="number" name="water_finding_mm" inputmode="decimal" step="0.1" min="0" value="${escapeAttrNum(row.water_finding_mm)}" /></td>
      <td>${yesNoSelect("water_present", row.water_present)}</td>
      <td><input type="text" name="corrective_action" maxlength="500" value="${escapeHtml(row.corrective_action || "")}" /></td>
      <td><input type="text" name="tested_by" maxlength="120" list="e20-staff-list" value="${escapeHtml(row.tested_by || "")}" /></td>
      <td class="e20-cell-check"><input type="checkbox" name="manager_signed" ${row.manager_signed ? "checked" : ""} aria-label="Manager signed" /></td>
      <td class="e20-col-actions"><button type="button" class="e20-row-remove" data-remove-water title="Remove row" aria-label="Remove row">×</button></td>
    </tr>`;
  }

  function defaultWaterRows() {
    return DEFAULT_TANKS.map((tank) => ({ tank_no: tank, check_time: "06:10" }));
  }

  function renderWaterRows(rows) {
    if (!dom.waterBody) return;
    const list = rows?.length ? rows : defaultWaterRows();
    dom.waterBody.innerHTML = list.map(waterRowHtml).join("");
  }

  function appendWaterRow(row = {}) {
    if (!dom.waterBody) return;
    dom.waterBody.insertAdjacentHTML("beforeend", waterRowHtml(row));
  }

  function renderQualityRows(savedRows) {
    if (!dom.qualityBody) return;
    const bySlot = new Map((savedRows || []).map((r) => [Number(r.slot_no), r]));
    dom.qualityBody.innerHTML = QUALITY_SLOTS.map((slot) => {
      const row = bySlot.get(slot.no) || {};
      return `<tr data-slot="${slot.no}">
        <td class="e20-slot-no">${slot.no}</td>
        <td class="e20-slot-time">${slot.time}<input type="hidden" name="check_time" value="${slot.time}" /></td>
        <td>${appearanceSelect(row.visual_appearance)}</td>
        <td>${yesNoSelect("water_separation", row.water_separation)}</td>
        <td><input type="text" name="action_taken" maxlength="500" value="${escapeHtml(row.action_taken || "")}" /></td>
        <td><input type="text" name="tested_by" maxlength="120" list="e20-staff-list" value="${escapeHtml(row.tested_by || "")}" /></td>
        <td class="e20-cell-check"><input type="checkbox" name="tester_signed" ${row.tester_signed ? "checked" : ""} aria-label="Signed" /></td>
      </tr>`;
    }).join("");
  }

  function renderBlankForm() {
    renderWaterRows(defaultWaterRows());
    renderQualityRows([]);
    if (dom.certified) dom.certified.checked = false;
    if (dom.certifiedAt) dom.certifiedAt.value = "";
    if (dom.dealer) dom.dealer.value = "";
    if (dom.remarks) dom.remarks.value = "";
  }

  function setFeedback(ok, message) {
    if (dom.success) {
      dom.success.textContent = ok ? message : "";
      dom.success.classList.toggle("hidden", !ok || !message);
    }
    if (dom.error) {
      dom.error.textContent = ok ? "" : message;
      dom.error.classList.toggle("hidden", ok || !message);
    }
  }

  function setStatus(text) {
    if (dom.status) dom.status.textContent = text || "";
  }

  function fieldValue(tr, name) {
    return tr.querySelector(`[name="${name}"]`);
  }

  function collectWaterChecks() {
    return Array.from(dom.waterBody?.querySelectorAll("tr") || []).map((tr, idx) => {
      const g = (name) => fieldValue(tr, name);
      return {
        check_time: g("check_time")?.value || null,
        tank_no: g("tank_no")?.value?.trim() || "",
        opening_dip_mm: g("opening_dip_mm")?.value || "",
        water_finding_mm: g("water_finding_mm")?.value || "",
        water_present: yesNoValue(g("water_present")?.value),
        corrective_action: g("corrective_action")?.value?.trim() || "",
        tested_by: g("tested_by")?.value?.trim() || "",
        manager_signed: !!g("manager_signed")?.checked,
        sort_order: idx,
      };
    });
  }

  function isQualityFilled(row) {
    return !!(
      row.visual_appearance ||
      row.water_separation ||
      row.tested_by ||
      row.action_taken ||
      row.tester_signed
    );
  }

  function collectQualityChecks({ filledOnly = false } = {}) {
    const rows = Array.from(dom.qualityBody?.querySelectorAll("tr") || []).map((tr) => {
      const g = (name) => fieldValue(tr, name);
      return {
        slot_no: Number(tr.getAttribute("data-slot")),
        check_time: g("check_time")?.value || "",
        visual_appearance: g("visual_appearance")?.value || "",
        water_separation: yesNoValue(g("water_separation")?.value),
        action_taken: g("action_taken")?.value?.trim() || "",
        tested_by: g("tested_by")?.value?.trim() || "",
        tester_signed: !!g("tester_signed")?.checked,
      };
    });
    return filledOnly ? rows.filter(isQualityFilled) : rows;
  }

  function toDatetimeLocalValue(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function certifiedAtIso() {
    const raw = dom.certifiedAt?.value?.trim();
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function sortWater(rows) {
    return [...(rows || [])].sort(
      (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    );
  }

  function sortQuality(rows) {
    return [...(rows || [])].sort((a, b) => (Number(a.slot_no) || 0) - (Number(b.slot_no) || 0));
  }

  function applyHeader(header) {
    const defaults = stationDefaults();
    if (dom.outlet) dom.outlet.value = header.retail_outlet_name || defaults.outlet;
    if (dom.cc) dom.cc.value = header.cc_code || defaults.cc;
    if (dom.certified) dom.certified.checked = !!header.certified;
    if (dom.certifiedAt) {
      dom.certifiedAt.value = header.certified_at ? toDatetimeLocalValue(header.certified_at) : "";
    }
    if (dom.dealer) dom.dealer.value = header.dealer_sign_name || "";
    if (dom.remarks) dom.remarks.value = header.remarks || "";
  }

  async function loadRegister(dateStr) {
    const seq = ++loadSeq;
    setFeedback(true, "");
    setStatus("Loading…");
    currentRegisterId = null;
    if (dom.deleteBtn) dom.deleteBtn.classList.add("hidden");

    try {
      const { data: header, error } = await supabaseClient
        .from("e20_testing_registers")
        .select(REGISTER_SELECT)
        .eq("register_date", dateStr)
        .maybeSingle();
      if (error) throw error;
      if (seq !== loadSeq) return;

      if (!header) {
        renderBlankForm();
        prefillStationMeta(true);
        setStatus("No register for this date yet — fill and save.");
        return;
      }

      currentRegisterId = header.id;
      applyHeader(header);
      const water = sortWater(header.e20_water_checks);
      renderWaterRows(water.length ? water : defaultWaterRows());
      renderQualityRows(sortQuality(header.e20_quality_checks));

      if (dom.deleteBtn && currentAuth?.role === "admin") {
        dom.deleteBtn.classList.remove("hidden");
        dom.deleteBtn.disabled = false;
      }
      setStatus(
        `Saved register · ${formatDisplayDate(header.register_date)}${
          header.certified ? " · Certified" : ""
        }`
      );
    } catch (err) {
      if (seq !== loadSeq) return;
      AppError.handle(err, { target: dom.error });
      setStatus("Could not load register.");
    }
  }

  async function onSave(e) {
    e.preventDefault();
    setFeedback(true, "");
    const dateStr = dom.dateInput?.value?.trim();
    if (!dateStr) {
      setFeedback(false, "Pick a date.");
      return;
    }

    const water = collectWaterChecks().filter((r) => r.tank_no);
    if (!water.length) {
      setFeedback(false, "Add at least one tank row in Part A.");
      return;
    }

    const certified = !!dom.certified?.checked;
    if (dom.saveBtn) {
      dom.saveBtn.disabled = true;
      dom.saveBtn.textContent = "Saving…";
    }

    try {
      const { data, error } = await supabaseClient.rpc("save_e20_testing_register", {
        p_date: dateStr,
        p_outlet_name: dom.outlet?.value?.trim() || "",
        p_cc_code: dom.cc?.value?.trim() || "",
        p_water_checks: water,
        p_quality_checks: collectQualityChecks({ filledOnly: true }),
        p_certified: certified,
        p_certified_at: certified ? certifiedAtIso() : null,
        p_dealer_sign_name: dom.dealer?.value?.trim() || null,
        p_remarks: dom.remarks?.value?.trim() || null,
      });
      if (error) throw error;
      currentRegisterId = data;
      setFeedback(true, "Register saved.");
      setStatus(`Saved · ${formatDisplayDate(dateStr)}${certified ? " · Certified" : ""}`);
      if (dom.deleteBtn && currentAuth?.role === "admin") {
        dom.deleteBtn.classList.remove("hidden");
      }
      upsertHistoryLocal({
        register_date: dateStr,
        certified,
        cc_code: dom.cc?.value?.trim() || "",
      });
      renderHistory();
    } catch (err) {
      AppError.handle(err, { target: dom.error });
    } finally {
      if (dom.saveBtn) {
        dom.saveBtn.disabled = false;
        dom.saveBtn.textContent = "Save register";
      }
    }
  }

  async function deleteRegister() {
    if (!currentRegisterId || currentAuth?.role !== "admin") return;
    const dateStr = dom.dateInput?.value?.trim() || "";
    const ok = window.confirm(
      `Delete the E-20 register for ${formatDisplayDate(dateStr) || dateStr}? This cannot be undone.`
    );
    if (!ok) return;

    const deleteId = currentRegisterId;
    if (dom.deleteBtn) dom.deleteBtn.disabled = true;
    try {
      const { error } = await supabaseClient
        .from("e20_testing_registers")
        .delete()
        .eq("id", deleteId);
      if (error) throw error;
      if (currentRegisterId === deleteId) currentRegisterId = null;
      setFeedback(true, "Register deleted.");
      historyRows = historyRows.filter((r) => r.register_date !== dateStr);
      renderHistory();
      await loadRegister(dateStr);
    } catch (err) {
      AppError.handle(err, { target: dom.error });
      if (dom.deleteBtn && currentRegisterId) dom.deleteBtn.disabled = false;
    }
  }

  function upsertHistoryLocal(row) {
    const next = historyRows.filter((r) => r.register_date !== row.register_date);
    next.unshift(row);
    next.sort((a, b) => (a.register_date < b.register_date ? 1 : -1));
    historyRows = next.slice(0, 30);
  }

  function renderHistory() {
    if (!dom.history) return;
    if (!historyRows.length) {
      dom.history.innerHTML = `<p class="muted">No registers saved yet.</p>`;
      return;
    }
    dom.history.innerHTML = historyRows
      .map((row) => {
        const badge = row.certified
          ? `<span class="e20-badge e20-badge--ok">Certified</span>`
          : `<span class="e20-badge">Draft</span>`;
        return `<a class="e20-history-row" href="e20-register.html?date=${encodeURIComponent(row.register_date)}" data-date="${escapeHtml(row.register_date)}">
          <div class="e20-history-meta">
            <strong>${escapeHtml(formatDisplayDate(row.register_date))}</strong>
            <span class="muted">${escapeHtml(row.cc_code || "")}</span>
          </div>
          ${badge}
        </a>`;
      })
      .join("");
  }

  async function loadHistory() {
    if (!dom.history) return;
    try {
      const { data, error } = await supabaseClient
        .from("e20_testing_registers")
        .select("register_date, certified, cc_code")
        .order("register_date", { ascending: false })
        .limit(30);
      if (error) throw error;
      historyRows = data || [];
      renderHistory();
    } catch (err) {
      AppError.report(err, { context: "e20History" });
      dom.history.innerHTML = `<p class="muted">Could not load history.</p>`;
    }
  }

  function formatYesNo(v) {
    const n = yesNoValue(v);
    if (n === "yes") return "Yes";
    if (n === "no") return "No";
    return "";
  }

  function formatAppearance(v) {
    if (v === "clear_bright") return "Clear & Bright";
    if (v === "hazy") return "Hazy";
    return "";
  }

  function formatNum(v) {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : "";
  }

  function formatDisplayDateTimeLocal(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    try {
      return d.toLocaleString(undefined, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return value;
    }
  }

  function buildPrintHtml() {
    const dateStr = dom.dateInput?.value?.trim() || "";
    const outlet = dom.outlet?.value?.trim() || "";
    const cc = dom.cc?.value?.trim() || "";
    const water = collectWaterChecks().filter((r) => r.tank_no);
    const qualityBySlot = new Map(
      collectQualityChecks().map((q) => [q.slot_no, q])
    );
    const certified = !!dom.certified?.checked;
    const dealer = dom.dealer?.value?.trim() || "";
    const certifiedAt = dom.certifiedAt?.value
      ? formatDisplayDateTimeLocal(dom.certifiedAt.value)
      : "";

    const waterRows = (water.length ? water : [{ tank_no: "" }]).map(
      (r) => `<tr>
        <td class="ctr">${escapeHtml(timeInputValue(r.check_time))}</td>
        <td>${escapeHtml(r.tank_no)}</td>
        <td class="num">${escapeHtml(formatNum(r.opening_dip_mm))}</td>
        <td class="num">${escapeHtml(formatNum(r.water_finding_mm))}</td>
        <td class="ctr">${escapeHtml(formatYesNo(r.water_present))}</td>
        <td>${escapeHtml(r.corrective_action || "")}</td>
        <td>${escapeHtml(r.tested_by || "")}</td>
        <td class="ctr">${r.manager_signed ? "✓" : ""}</td>
      </tr>`
    );
    while (waterRows.length < 2) waterRows.push(EMPTY_WATER_ROW);

    const qualityRows = QUALITY_SLOTS.map((slot) => {
      const r = qualityBySlot.get(slot.no) || {};
      return `<tr>
        <td class="ctr">${slot.no}</td>
        <td class="ctr">${slot.time}</td>
        <td>${escapeHtml(formatAppearance(r.visual_appearance))}</td>
        <td class="ctr">${escapeHtml(formatYesNo(r.water_separation))}</td>
        <td>${escapeHtml(r.action_taken || "")}</td>
        <td>${escapeHtml(r.tested_by || "")}</td>
        <td class="ctr">${r.tester_signed ? "✓" : ""}</td>
      </tr>`;
    });

    return `
      <div class="e20-sheet">
        <h1 class="e20-sheet-title">Daily E-20 Testing Register</h1>
        <div class="e20-sheet-meta">
          <div>
            <span class="e20-meta-label">Retail outlet name</span>
            <strong>${escapeHtml(outlet)}</strong>
          </div>
          <div>
            <span class="e20-meta-label">CC code</span>
            <strong>${escapeHtml(cc)}</strong>
          </div>
          <div>
            <span class="e20-meta-label">Date</span>
            <strong>${escapeHtml(formatDisplayDate(dateStr) || dateStr)}</strong>
          </div>
        </div>

        <h2 class="e20-part-heading">Part A: Morning Water Check Through Tank Dip</h2>
        <table class="e20-print-table">
          <thead>
            <tr>
              <th style="width:9%">Time</th>
              <th style="width:14%">Product Tank No.</th>
              <th style="width:12%">Opening Dip (mm)</th>
              <th style="width:12%">Water Finding (mm)</th>
              <th style="width:10%">Water Present</th>
              <th style="width:18%">Corrective Action</th>
              <th style="width:13%">Tested By</th>
              <th style="width:12%">Manager Signature</th>
            </tr>
          </thead>
          <tbody>${waterRows.join("")}</tbody>
        </table>

        <h2 class="e20-part-heading">Part B: E-20 Petrol Quality Monitoring (Every 2 Hours)</h2>
        <table class="e20-print-table">
          <thead>
            <tr>
              <th style="width:6%">Sl. No.</th>
              <th style="width:8%">Time</th>
              <th style="width:20%">Visual Appearance</th>
              <th style="width:14%">Water Separation</th>
              <th style="width:22%">Action Taken if Abnormal</th>
              <th style="width:16%">Tested By</th>
              <th style="width:14%">Signature</th>
            </tr>
          </thead>
          <tbody>${qualityRows.join("")}</tbody>
        </table>

        <div class="e20-cert-block">
          <h2 class="e20-cert-heading">Daily Certification</h2>
          <p class="e20-cert-statement">
            I certify that all mandatory E-20 quality checks were carried out as per prescribed guidelines
            and no abnormality was observed, except those recorded above.
          </p>
          <div class="e20-cert-sign">
            <div>
              <div class="line">${escapeHtml(certifiedAt)}${certified && !certifiedAt ? "Certified" : ""}</div>
              <div class="cap">Date &amp; Time</div>
            </div>
            <div>
              <div class="line">${escapeHtml(dealer)}${certified && !dealer ? " ✓" : ""}</div>
              <div class="cap">RO Dealer Signature</div>
            </div>
          </div>
        </div>
        <p class="e20-print-note">Printed from Bishnupriya Fuels station register.</p>
      </div>
    `;
  }

  async function getPrintCssText() {
    if (printCssCache) return printCssCache;
    if (printCssInflight) return printCssInflight;
    printCssInflight = (async () => {
      const res = await fetch(new URL(PRINT_CSS, window.location.href).href);
      if (!res.ok) throw new Error("Could not load E-20 print styles.");
      printCssCache = await res.text();
      return printCssCache;
    })();
    try {
      return await printCssInflight;
    } finally {
      printCssInflight = null;
    }
  }

  async function printRegister() {
    try {
      const cssText = await getPrintCssText();
      const dateStr = dom.dateInput?.value?.trim() || "register";
      await PrintUtils.printInIframe({
        title: PrintUtils.buildPrintFilename("e20-testing-register", dateStr),
        bodyHtml: buildPrintHtml(),
        cssText,
        bodyClass: "e20-print-body",
        containerClass: "e20-print-container",
        iframeTitle: "E-20 testing register print",
      });
    } catch (err) {
      AppError.handle(err, { target: dom.error });
    }
  }
})();
