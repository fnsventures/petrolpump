/* global requireAuth, applyRoleVisibility, supabaseClient, AppError, escapeHtml, formatDisplayDate, getLocalDateString, initPersistedDateInput, savePersistedDate, RECORD_DATE_KEYS, PumpSettings, loadPumpSettings, PrintUtils, AppConfig, initPageSections, createDateRangeFilter, readDateRangeFromControls, getMonthRange */

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
  const PRINT_CSS = "css/e20-register-print.css?v=2";
  const HISTORY_PAGE_SIZE = 25;

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

  /** Lightweight select for new-day autofill only. */
  const TEMPLATE_SELECT = `
    register_date, retail_outlet_name, cc_code, certified, dealer_sign_name,
    e20_water_checks (check_time, tank_no, tested_by, sort_order)
  `.replace(/\s+/g, " ").trim();

  const EMPTY_WATER_ROW =
    "<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>";

  let currentAuth = null;
  let currentRegisterId = null;
  /** @type {ReturnType<typeof snapshotFromHeader> | null} */
  let currentSnapshot = null;
  let formLocked = false;
  let adminUnlocked = false;
  /** Certified sheet opened from History → View (stays on history panel). */
  let historyReportSnap = null;
  let printCssCache = null;
  let printCssInflight = null;
  let loadSeq = 0;
  let templateRegister = null;
  let historyRows = [];
  let historyOffset = 0;
  let historyHasMore = false;
  let historyLoading = false;
  let historyFilterKey = "";
  let historySeq = 0;
  let reportSeq = 0;

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
    initPageSections({
      defaultSection: "record",
      validSections: ["record", "history"],
      onSectionChange: (section) => {
        if (section !== "history") closeHistoryReport();
        if (section === "history") void loadHistory(true);
      },
    });
    initHistoryFilter();

    const today = getLocalDateString();
    const dateStr = initPersistedDateInput(dom.dateInput, RECORD_DATE_KEYS.e20Register, {
      urlParam: "date",
      fallback: today,
      onChange: (value) => void loadRegister(value),
    });

    await loadPumpSettings();
    await Promise.all([
      loadStaffNames(),
      loadTemplateRegister(),
      getPrintCssText().catch(() => null),
    ]);
    await loadRegister(dateStr);
    if (location.hash === "#history") void loadHistory(true);
  });

  function cacheDom() {
    dom.form = document.getElementById("e20-form");
    dom.fieldset = document.getElementById("e20-fields");
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
    dom.modeBanner = document.getElementById("e20-mode-banner");
    dom.reportView = document.getElementById("e20-report-view");
    dom.sheetPreview = document.getElementById("e20-sheet-preview");
    dom.reportSubtitle = document.getElementById("e20-report-subtitle");
    dom.reportError = document.getElementById("e20-report-error");
    dom.reportPrintBtn = document.getElementById("e20-report-print-btn");
    dom.reportUnlockBtn = document.getElementById("e20-report-unlock-btn");
    dom.reportHistoryBtn = document.getElementById("e20-report-history-btn");
    dom.saveBtn = document.getElementById("e20-save-btn");
    dom.deleteBtn = document.getElementById("e20-delete-btn");
    dom.unlockBtn = document.getElementById("e20-unlock-btn");
    dom.printBtn = document.getElementById("e20-print-btn");
    dom.addTankBtn = document.getElementById("e20-add-tank");
    dom.fillSlotsBtn = document.getElementById("e20-fill-slots");
    dom.staffList = document.getElementById("e20-staff-list");
    dom.historyHead = document.getElementById("e20-history-head");
    dom.historyList = document.getElementById("e20-history-list");
    dom.historyBody = document.getElementById("e20-history-body");
    dom.historyEmpty = document.getElementById("e20-history-empty");
    dom.historySummary = document.getElementById("e20-history-summary");
    dom.historyError = document.getElementById("e20-history-error");
    dom.historyMore = document.getElementById("e20-history-more");
    dom.statusFilter = document.getElementById("e20-status-filter");
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

  function bindEvents() {
    dom.form?.addEventListener("submit", onSave);
    dom.addTankBtn?.addEventListener("click", () => {
      if (formLocked) return;
      appendWaterRow({ tank_no: "", check_time: "06:10" });
    });
    dom.fillSlotsBtn?.addEventListener("click", () => {
      if (formLocked) return;
      fillEmptyQualitySlots();
    });
    dom.waterBody?.addEventListener("click", (e) => {
      if (formLocked) return;
      const btn = e.target.closest("[data-remove-water]");
      if (!btn) return;
      btn.closest("tr")?.remove();
    });
    dom.printBtn?.addEventListener("click", () => void printRegister());
    dom.reportPrintBtn?.addEventListener("click", () => void printHistoryReport());
    dom.deleteBtn?.addEventListener("click", () => void deleteRegister());
    dom.unlockBtn?.addEventListener("click", () => unlockCertifiedForEdit());
    dom.reportUnlockBtn?.addEventListener("click", () => void unlockHistoryReportForEdit());
    dom.reportHistoryBtn?.addEventListener("click", () => closeHistoryReport());
    dom.certified?.addEventListener("change", () => {
      if (formLocked) return;
      if (dom.certified.checked && dom.certifiedAt && !dom.certifiedAt.value) {
        dom.certifiedAt.value = toDatetimeLocalValue(new Date());
      }
      if (dom.certified.checked && dom.dealer && !dom.dealer.value.trim()) {
        const fromTemplate = templateRegister?.dealer_sign_name || "";
        if (fromTemplate) dom.dealer.value = fromTemplate;
      }
    });
    dom.historyBody?.addEventListener("click", (e) => {
      const openBtn = e.target.closest("[data-open-date]");
      if (openBtn) {
        e.preventDefault();
        const date = openBtn.getAttribute("data-open-date");
        if (openBtn.getAttribute("data-open-report") === "1") {
          void openHistoryReport(date);
        } else {
          goToDate(date);
        }
        return;
      }
      const printBtn = e.target.closest("[data-print-date]");
      if (printBtn) {
        e.preventDefault();
        void printDate(printBtn.getAttribute("data-print-date"));
      }
    });
    dom.historyMore?.addEventListener("click", () => void loadHistory(false));
    dom.statusFilter?.addEventListener("change", () => {
      closeHistoryReport();
      void loadHistory(true);
    });
  }

  function initHistoryFilter() {
    createDateRangeFilter({
      storageKey: "e20-register-history",
      ranges: ["this-week", "this-month", "custom"],
      defaultRange: "this-month",
      rangeSelect: "e20-range",
      startInput: "e20-start",
      endInput: "e20-end",
      customRange: "e20-custom-range",
      applyBtn: "e20-apply-filter",
      trigger: "apply",
      runOnInit: false,
      onApply: () => {
        closeHistoryReport();
        return loadHistory(true);
      },
    });
  }

  /** Persist date, switch to Daily register, then load the form. */
  function goToDate(date, { unlock = false } = {}) {
    if (!date || !dom.dateInput) return Promise.resolve();
    closeHistoryReport();
    dom.dateInput.value = date;
    savePersistedDate(RECORD_DATE_KEYS.e20Register, date);
    const url = new URL(window.location.href);
    url.searchParams.set("date", date);
    url.hash = "record";
    window.history.replaceState({}, "", url);
    document.querySelector('.settings-nav-item[data-section="record"]')?.click();
    return loadRegister(date).then(() => {
      // Ignore if a newer date load superseded this one.
      if (dom.dateInput?.value !== date) return;
      if (unlock && currentSnapshot?.certified && currentAuth?.role === "admin") {
        adminUnlocked = true;
        refreshLockUi();
        setFeedback(true, "Unlocked. Make corrections, then save.");
      }
    });
  }

  function setHistoryListError(msg) {
    if (!dom.historyError) return;
    if (!msg) {
      dom.historyError.textContent = "";
      dom.historyError.classList.add("hidden");
      return;
    }
    dom.historyError.textContent = msg;
    dom.historyError.classList.remove("hidden");
  }

  /** Print without leaving history when the day is not already loaded. */
  async function printDate(date) {
    if (!date) return;
    setHistoryListError("");
    if (historyReportSnap?.register_date === date) {
      await printHistoryReport();
      return;
    }
    if (dom.dateInput?.value === date && currentSnapshot) {
      await printRegister();
      return;
    }
    try {
      const header = await fetchRegister(date);
      if (!header) {
        if (historyReportSnap) setHistoryReportError("No register for that date.");
        else setHistoryListError("No register for that date.");
        return;
      }
      await printSheetHtml(buildSheetHtml(snapshotFromHeader(header)), date);
    } catch (err) {
      AppError.handle(err, {
        target: historyReportSnap ? dom.reportError || dom.historyError : dom.historyError || dom.error,
      });
    }
  }

  function setHistoryReportError(msg) {
    if (!dom.reportError) return;
    if (!msg) {
      dom.reportError.textContent = "";
      dom.reportError.classList.add("hidden");
      return;
    }
    dom.reportError.textContent = msg;
    dom.reportError.classList.remove("hidden");
  }

  function closeHistoryReport() {
    reportSeq += 1;
    historyReportSnap = null;
    setHistoryReportError("");
    if (dom.reportView) {
      dom.reportView.classList.add("hidden");
      dom.reportView.setAttribute("aria-hidden", "true");
    }
    if (dom.sheetPreview) dom.sheetPreview.innerHTML = "";
    if (dom.reportSubtitle) dom.reportSubtitle.textContent = "";
    if (dom.historyList) dom.historyList.classList.remove("hidden");
    if (dom.historyHead) dom.historyHead.classList.remove("hidden");
  }

  function showHistoryReport(snap) {
    historyReportSnap = snap;
    setHistoryReportError("");
    if (dom.historyList) dom.historyList.classList.add("hidden");
    if (dom.historyHead) dom.historyHead.classList.add("hidden");
    if (dom.reportView) {
      dom.reportView.classList.remove("hidden");
      dom.reportView.setAttribute("aria-hidden", "false");
    }
    if (dom.sheetPreview) {
      dom.sheetPreview.innerHTML = `<div class="e20-preview-inner">${buildSheetHtml(snap)}</div>`;
    }
    if (dom.reportSubtitle) {
      dom.reportSubtitle.textContent = [
        formatDisplayDate(snap.register_date) || snap.register_date,
        "Certified",
        certifiedLabel(snap),
        snap.dealer_sign_name || "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    const isAdmin = currentAuth?.role === "admin";
    if (dom.reportUnlockBtn) {
      dom.reportUnlockBtn.classList.toggle("hidden", !isAdmin);
    }
  }

  async function openHistoryReport(date) {
    if (!date) return;
    const seq = ++reportSeq;
    setHistoryReportError("");
    setHistoryListError("");
    if (dom.sheetPreview) {
      dom.sheetPreview.innerHTML = `<p class="muted">Loading report…</p>`;
    }
    if (dom.historyList) dom.historyList.classList.add("hidden");
    if (dom.historyHead) dom.historyHead.classList.add("hidden");
    if (dom.reportView) {
      dom.reportView.classList.remove("hidden");
      dom.reportView.setAttribute("aria-hidden", "false");
    }
    if (dom.reportSubtitle) dom.reportSubtitle.textContent = formatDisplayDate(date) || date;
    if (dom.reportUnlockBtn) dom.reportUnlockBtn.classList.add("hidden");

    try {
      const header = await fetchRegister(date);
      if (seq !== reportSeq) return;
      if (!header) {
        setHistoryReportError("No register for that date.");
        if (dom.sheetPreview) dom.sheetPreview.innerHTML = "";
        return;
      }
      if (!header.certified) {
        closeHistoryReport();
        await goToDate(date);
        return;
      }
      showHistoryReport(snapshotFromHeader(header));
    } catch (err) {
      if (seq !== reportSeq) return;
      AppError.report(err, { context: "e20HistoryReport" });
      setHistoryReportError("Could not load this report.");
      if (dom.sheetPreview) dom.sheetPreview.innerHTML = "";
    }
  }

  async function unlockHistoryReportForEdit() {
    if (currentAuth?.role !== "admin" || !historyReportSnap?.certified) return;
    const ok = window.confirm(
      "Unlock this certified register for editing? You will open Daily register for that date."
    );
    if (!ok) return;
    const date = historyReportSnap.register_date;
    await goToDate(date, { unlock: true });
  }

  async function printHistoryReport() {
    if (!historyReportSnap) return;
    try {
      await printSheetHtml(buildSheetHtml(historyReportSnap), historyReportSnap.register_date);
    } catch (err) {
      AppError.handle(err, { target: dom.reportError || dom.error });
    }
  }

  async function fetchRegister(dateStr) {
    const { data, error } = await supabaseClient
      .from("e20_testing_registers")
      .select(REGISTER_SELECT)
      .eq("register_date", dateStr)
      .maybeSingle();
    if (error) throw error;
    return data || null;
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

  async function loadTemplateRegister() {
    try {
      const { data, error } = await supabaseClient
        .from("e20_testing_registers")
        .select(TEMPLATE_SELECT)
        .order("register_date", { ascending: false })
        .limit(12);
      if (error) throw error;
      const rows = data || [];
      templateRegister = rows[0] || null;
      if (templateRegister && !templateRegister.dealer_sign_name) {
        const withDealer = rows.find((r) => r.dealer_sign_name);
        if (withDealer) {
          templateRegister = { ...templateRegister, dealer_sign_name: withDealer.dealer_sign_name };
        }
      }
    } catch (err) {
      AppError.report(err, { context: "e20LoadTemplate" });
      templateRegister = null;
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
      <td class="e20-cell-check"><input type="checkbox" name="manager_signed" ${isSignedFlag(row.manager_signed) ? "checked" : ""} aria-label="Manager signed" /></td>
      <td class="e20-col-actions"><button type="button" class="e20-row-remove" data-remove-water title="Remove row" aria-label="Remove row">×</button></td>
    </tr>`;
  }

  function defaultWaterRowsFromTemplate() {
    const prior = sortWater(templateRegister?.e20_water_checks || []);
    if (prior.length) {
      return prior.map((r) => ({
        tank_no: r.tank_no || "",
        check_time: timeInputValue(r.check_time) || "06:10",
        tested_by: r.tested_by || "",
      }));
    }
    return DEFAULT_TANKS.map((tank) => ({ tank_no: tank, check_time: "06:10" }));
  }

  function renderWaterRows(rows) {
    if (!dom.waterBody) return;
    const list = rows?.length ? rows : defaultWaterRowsFromTemplate();
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
        <td class="e20-cell-check"><input type="checkbox" name="tester_signed" ${isSignedFlag(row.tester_signed) ? "checked" : ""} aria-label="Signed" /></td>
      </tr>`;
    }).join("");
  }

  function applyNewDayDefaults() {
    const defaults = stationDefaults();
    if (dom.outlet) {
      dom.outlet.value = templateRegister?.retail_outlet_name || defaults.outlet;
    }
    if (dom.cc) {
      dom.cc.value = templateRegister?.cc_code || defaults.cc;
    }
    if (dom.certified) dom.certified.checked = false;
    if (dom.certifiedAt) dom.certifiedAt.value = "";
    if (dom.dealer) dom.dealer.value = templateRegister?.dealer_sign_name || "";
    if (dom.remarks) dom.remarks.value = "";
    renderWaterRows(defaultWaterRowsFromTemplate());
    renderQualityRows([]);
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

  function setModeBanner(html, kind) {
    if (!dom.modeBanner) return;
    if (!html) {
      dom.modeBanner.className = "e20-mode-banner hidden";
      dom.modeBanner.innerHTML = "";
      return;
    }
    dom.modeBanner.className = `e20-mode-banner e20-mode-banner--${kind || "info"}`;
    dom.modeBanner.innerHTML = html;
  }

  function certifiedLabel(snap) {
    if (!snap?.certified) return "";
    const when = snap.certified_at ? formatDisplayDateTimeLocal(snap.certified_at) : "";
    return when ? `Signed ${when}` : "Certified";
  }

  function isCertifiedLocked() {
    if (!currentSnapshot?.certified) return false;
    if (currentAuth?.role === "admin" && adminUnlocked) return false;
    return true;
  }

  function setFormLocked(locked) {
    formLocked = !!locked;
    if (dom.form) dom.form.classList.toggle("e20-form-locked", formLocked);
    if (dom.fieldset) dom.fieldset.disabled = formLocked;

    if (dom.saveBtn) {
      dom.saveBtn.classList.toggle("hidden", formLocked);
      dom.saveBtn.disabled = formLocked;
    }
    if (dom.addTankBtn) {
      dom.addTankBtn.classList.toggle("hidden", formLocked);
      dom.addTankBtn.disabled = formLocked;
    }
    if (dom.fillSlotsBtn) {
      dom.fillSlotsBtn.classList.toggle("hidden", formLocked);
      dom.fillSlotsBtn.disabled = formLocked;
    }
  }

  function refreshLockUi() {
    const locked = isCertifiedLocked();
    setFormLocked(locked);

    const isAdmin = currentAuth?.role === "admin";
    const isCertified = !!currentSnapshot?.certified;
    const hasRegister = !!currentRegisterId;

    if (dom.deleteBtn) {
      const showDelete = isAdmin && hasRegister;
      dom.deleteBtn.classList.toggle("hidden", !showDelete);
      dom.deleteBtn.disabled = !showDelete;
    }

    if (dom.unlockBtn) {
      dom.unlockBtn.classList.toggle("hidden", !(isAdmin && locked));
    }

    const when = currentSnapshot?.certified_at
      ? formatDisplayDateTimeLocal(currentSnapshot.certified_at)
      : "";

    if (locked) {
      setModeBanner(
        `<strong>Certified &amp; locked</strong>
         <span>This day is certified${when ? ` (${escapeHtml(when)})` : ""}. Fields are read-only. Use <em>History → View</em> for the RO sheet.${
           isAdmin ? " Unlock only if a correction is required." : ""
         }</span>`,
        "locked"
      );
    } else if (isCertified && adminUnlocked) {
      setModeBanner(
        `<strong>Unlocked for edit</strong>
         <span>Save again to keep certification, or uncheck Certified to reopen as a draft.</span>`,
        "warn"
      );
    } else if (!hasRegister) {
      setModeBanner(
        `<strong>New day</strong>
         <span>Outlet, CC, tanks, and dealer are prefilled from your last register / settings. Certify once at close.</span>`,
        "info"
      );
    } else {
      setModeBanner(
        `<strong>Draft</strong>
         <span>Update Part A/B through the day. Certify once when checks are complete.</span>`,
        "draft"
      );
    }
  }

  function unlockCertifiedForEdit() {
    if (currentAuth?.role !== "admin" || !currentSnapshot?.certified) return;
    const ok = window.confirm(
      "Unlock this certified register for editing? Changes should be rare — prefer printing a corrected sheet only when needed."
    );
    if (!ok) return;
    adminUnlocked = true;
    refreshLockUi();
    setFeedback(true, "Unlocked. Make corrections, then save.");
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
        manager_signed: g("manager_signed")?.checked ? "yes" : "no",
        sort_order: idx,
      };
    });
  }

  function isSignedFlag(value) {
    return value === true || value === "yes" || value === "true" || value === "y" || value === 1 || value === "1";
  }

  function isQualityFilled(row) {
    return !!(
      row.visual_appearance ||
      row.water_separation ||
      row.tested_by ||
      row.action_taken ||
      isSignedFlag(row.tester_signed)
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
        tester_signed: g("tester_signed")?.checked ? "yes" : "no",
      };
    });
    return filledOnly ? rows.filter(isQualityFilled) : rows;
  }

  function fillEmptyQualitySlots() {
    const rows = collectQualityChecks();
    const filled = rows.filter(isQualityFilled);
    if (!filled.length) {
      setFeedback(false, "Fill at least one Part B slot first (tester / appearance), then use Fill empty slots.");
      return;
    }
    const template = filled[filled.length - 1];
    const defaults = {
      visual_appearance: template.visual_appearance || "clear_bright",
      water_separation: template.water_separation || "no",
      tested_by: template.tested_by || "",
    };

    let filledCount = 0;
    Array.from(dom.qualityBody?.querySelectorAll("tr") || []).forEach((tr) => {
      const g = (name) => fieldValue(tr, name);
      const current = {
        visual_appearance: g("visual_appearance")?.value || "",
        water_separation: yesNoValue(g("water_separation")?.value),
        tested_by: g("tested_by")?.value?.trim() || "",
        action_taken: g("action_taken")?.value?.trim() || "",
        tester_signed: !!g("tester_signed")?.checked,
      };
      if (isQualityFilled(current)) return;

      if (g("visual_appearance")) g("visual_appearance").value = defaults.visual_appearance;
      if (g("water_separation")) g("water_separation").value = defaults.water_separation;
      if (g("tested_by") && defaults.tested_by) g("tested_by").value = defaults.tested_by;
      filledCount += 1;
    });

    setFeedback(
      true,
      filledCount
        ? `Filled ${filledCount} empty slot(s) with Clear & Bright / No water${defaults.tested_by ? ` · ${defaults.tested_by}` : ""}. Review, then save.`
        : "All slots already have data."
    );
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

  function snapshotFromHeader(header) {
    return {
      id: header.id || null,
      register_date: header.register_date || "",
      retail_outlet_name: header.retail_outlet_name || "",
      cc_code: header.cc_code || "",
      certified: !!header.certified,
      certified_at: header.certified_at || null,
      dealer_sign_name: header.dealer_sign_name || "",
      remarks: header.remarks || "",
      water: sortWater(header.e20_water_checks),
      quality: sortQuality(header.e20_quality_checks),
    };
  }

  function snapshotFromForm() {
    return {
      id: currentRegisterId,
      register_date: dom.dateInput?.value?.trim() || "",
      retail_outlet_name: dom.outlet?.value?.trim() || "",
      cc_code: dom.cc?.value?.trim() || "",
      certified: !!dom.certified?.checked,
      certified_at: certifiedAtIso(),
      dealer_sign_name: dom.dealer?.value?.trim() || "",
      remarks: dom.remarks?.value?.trim() || "",
      water: collectWaterChecks().filter((r) => r.tank_no),
      quality: collectQualityChecks(),
    };
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
    currentSnapshot = null;
    adminUnlocked = false;

    try {
      const header = await fetchRegister(dateStr);
      if (seq !== loadSeq) return;

      if (!header) {
        applyNewDayDefaults();
        setStatus(`New register · ${formatDisplayDate(dateStr)} · fields auto-filled`);
        refreshLockUi();
        return;
      }

      currentRegisterId = header.id;
      currentSnapshot = snapshotFromHeader(header);
      applyHeader(header);
      const water = currentSnapshot.water;
      renderWaterRows(water.length ? water : defaultWaterRowsFromTemplate());
      renderQualityRows(currentSnapshot.quality);
      setStatus(
        `${header.certified ? "Certified" : "Draft"} · ${formatDisplayDate(header.register_date)}`
      );
      refreshLockUi();
    } catch (err) {
      if (seq !== loadSeq) return;
      AppError.handle(err, { target: dom.error });
      setStatus("Could not load register.");
      refreshLockUi();
    }
  }

  async function onSave(e) {
    e.preventDefault();
    setFeedback(true, "");

    if (formLocked) {
      setFeedback(false, "This register is certified and locked. Ask an admin to unlock if a correction is needed.");
      return;
    }

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
    if (certified && !(dom.dealer?.value?.trim())) {
      setFeedback(false, "Enter the RO dealer name before certifying.");
      dom.dealer?.focus();
      return;
    }

    if (dom.saveBtn) {
      dom.saveBtn.disabled = true;
      dom.saveBtn.textContent = certified ? "Certifying…" : "Saving…";
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
      currentSnapshot = snapshotFromForm();
      currentSnapshot.id = data;
      currentSnapshot.certified = certified;
      currentSnapshot.certified_at = certified
        ? certifiedAtIso() || new Date().toISOString()
        : null;
      adminUnlocked = false;
      historyFilterKey = "";

      setFeedback(
        true,
        certified
          ? "Register certified and locked."
          : "Draft saved. You can keep updating Part B through the day."
      );
      setStatus(`${certified ? "Certified" : "Draft"} · ${formatDisplayDate(dateStr)}`);
      refreshLockUi();

      void loadTemplateRegister();
      if (document.querySelector('.settings-nav-item[data-section="history"].is-active')) {
        void loadHistory(true);
      }
    } catch (err) {
      AppError.handle(err, { target: dom.error });
    } finally {
      if (dom.saveBtn) {
        dom.saveBtn.disabled = formLocked;
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
      currentSnapshot = null;
      adminUnlocked = false;
      historyFilterKey = "";
      setFeedback(true, "Register deleted.");
      await loadTemplateRegister();
      await loadRegister(dateStr);
      void loadHistory(true);
    } catch (err) {
      AppError.handle(err, { target: dom.error });
      if (dom.deleteBtn && currentRegisterId) dom.deleteBtn.disabled = false;
    }
  }

  function getHistoryDateRange() {
    const range = readDateRangeFromControls(
      document.getElementById("e20-range"),
      document.getElementById("e20-start"),
      document.getElementById("e20-end")
    );
    if (range) return { start: range.start, end: range.end };
    const today = new Date();
    return getMonthRange(today.getFullYear(), today.getMonth());
  }

  async function loadHistory(reset) {
    if (!dom.historyBody) return;
    // Allow filter resets to supersede an in-flight "load more".
    if (!reset && historyLoading) return;

    const { start, end } = getHistoryDateRange();
    const status = dom.statusFilter?.value || "all";
    const filterKey = `${status}|${start}|${end}`;

    if (reset && filterKey === historyFilterKey && historyRows.length) {
      renderHistory();
      return;
    }

    const seq = ++historySeq;
    historyLoading = true;
    if (reset) {
      historyOffset = 0;
      historyRows = [];
      historyHasMore = false;
      setHistoryListError("");
      dom.historyBody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
      dom.historyEmpty?.classList.add("hidden");
    }

    try {
      let query = supabaseClient
        .from("e20_testing_registers")
        .select("register_date, certified, certified_at, cc_code, dealer_sign_name")
        .gte("register_date", start)
        .lte("register_date", end)
        .order("register_date", { ascending: false })
        .range(historyOffset, historyOffset + HISTORY_PAGE_SIZE - 1);

      if (status === "certified") query = query.eq("certified", true);
      if (status === "draft") query = query.eq("certified", false);

      const { data, error } = await query;
      if (error) throw error;
      if (seq !== historySeq) return;

      const page = data || [];
      historyRows = reset ? page : historyRows.concat(page);
      historyHasMore = page.length === HISTORY_PAGE_SIZE;
      historyOffset = historyRows.length;
      historyFilterKey = filterKey;
      renderHistory();
    } catch (err) {
      if (seq !== historySeq) return;
      AppError.report(err, { context: "e20History" });
      if (reset) {
        dom.historyBody.innerHTML = `<tr><td colspan="5" class="muted">Could not load history.</td></tr>`;
        setHistoryListError("Could not load history.");
      }
    } finally {
      if (seq === historySeq) historyLoading = false;
    }
  }

  function renderHistory() {
    if (!dom.historyBody) return;
    const certifiedCount = historyRows.filter((r) => r.certified).length;
    const draftCount = historyRows.length - certifiedCount;

    if (dom.historySummary) {
      dom.historySummary.textContent = historyRows.length
        ? `${historyRows.length} register${historyRows.length === 1 ? "" : "s"} · ${certifiedCount} certified · ${draftCount} draft`
        : "";
    }

    if (!historyRows.length) {
      dom.historyBody.innerHTML = "";
      dom.historyEmpty?.classList.remove("hidden");
      dom.historyMore?.classList.add("hidden");
      return;
    }

    dom.historyEmpty?.classList.add("hidden");
    dom.historyBody.innerHTML = historyRows
      .map((row) => {
        const badge = row.certified
          ? `<span class="e20-badge e20-badge--ok">Certified</span>`
          : `<span class="e20-badge">Draft</span>`;
        const when =
          row.certified && row.certified_at
            ? `<div class="muted e20-hist-sub">${escapeHtml(formatDisplayDateTimeLocal(row.certified_at))}</div>`
            : "";
        return `<tr>
          <td>
            <strong>${escapeHtml(formatDisplayDate(row.register_date))}</strong>
            ${when}
          </td>
          <td>${badge}</td>
          <td>${escapeHtml(row.cc_code || "—")}</td>
          <td>${escapeHtml(row.dealer_sign_name || "—")}</td>
          <td class="table-actions e20-hist-actions">
            <button type="button" class="button-secondary button-sm" data-open-date="${escapeHtml(row.register_date)}"${row.certified ? ' data-open-report="1"' : ""}>${row.certified ? "View" : "Open"}</button>
            <button type="button" class="button-secondary button-sm" data-print-date="${escapeHtml(row.register_date)}">Print</button>
          </td>
        </tr>`;
      })
      .join("");

    if (dom.historyMore) {
      dom.historyMore.classList.toggle("hidden", !historyHasMore);
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
    if (Number.isNaN(d.getTime())) return String(value);
    try {
      return d.toLocaleString(undefined, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(value);
    }
  }

  /** Single sheet builder for screen preview + print. */
  function buildSheetHtml(snap) {
    const dateStr = snap.register_date || "";
    const outlet = snap.retail_outlet_name || "";
    const cc = snap.cc_code || "";
    const water = (snap.water || []).filter((r) => r.tank_no);
    const qualityBySlot = new Map((snap.quality || []).map((q) => [Number(q.slot_no), q]));
    const certified = !!snap.certified;
    const dealer = snap.dealer_sign_name || "";
    const certifiedAt = snap.certified_at ? formatDisplayDateTimeLocal(snap.certified_at) : "";

    const waterRows = (water.length ? water : [{ tank_no: "" }]).map(
      (r) => `<tr>
        <td class="ctr">${escapeHtml(timeInputValue(r.check_time))}</td>
        <td>${escapeHtml(r.tank_no)}</td>
        <td class="num">${escapeHtml(formatNum(r.opening_dip_mm))}</td>
        <td class="num">${escapeHtml(formatNum(r.water_finding_mm))}</td>
        <td class="ctr">${escapeHtml(formatYesNo(r.water_present))}</td>
        <td>${escapeHtml(r.corrective_action || "")}</td>
        <td>${escapeHtml(r.tested_by || "")}</td>
        <td class="ctr">${isSignedFlag(r.manager_signed) ? "✓" : ""}</td>
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
        <td class="ctr">${isSignedFlag(r.tester_signed) ? "✓" : ""}</td>
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
              <th style="width:8%">Time</th>
              <th style="width:14%">Product<br>Tank No.</th>
              <th style="width:12%">Opening<br>Dip (mm)</th>
              <th style="width:12%">Water<br>Finding (mm)</th>
              <th style="width:11%">Water<br>Present</th>
              <th style="width:18%">Corrective<br>Action</th>
              <th style="width:13%">Tested By</th>
              <th style="width:12%">Manager<br>Signature</th>
            </tr>
          </thead>
          <tbody>${waterRows.join("")}</tbody>
        </table>

        <h2 class="e20-part-heading">Part B: E-20 Petrol Quality Monitoring (Every 2 Hours)</h2>
        <table class="e20-print-table">
          <thead>
            <tr>
              <th style="width:7%">Sl.<br>No.</th>
              <th style="width:8%">Time</th>
              <th style="width:20%">Visual<br>Appearance</th>
              <th style="width:14%">Water<br>Separation</th>
              <th style="width:22%">Action Taken<br>if Abnormal</th>
              <th style="width:15%">Tested By</th>
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

  async function printSheetHtml(bodyHtml, dateStr) {
    const cssText = await getPrintCssText();
    await PrintUtils.printInIframe({
      title: PrintUtils.buildPrintFilename("e20-testing-register", dateStr || "register"),
      bodyHtml,
      cssText,
      bodyClass: "e20-print-body",
      containerClass: "e20-print-container",
      iframeTitle: "E-20 testing register print",
    });
  }

  async function printRegister() {
    try {
      const snap = formLocked ? currentSnapshot || snapshotFromForm() : snapshotFromForm();
      if (!snap?.register_date) {
        setFeedback(false, "Pick a date before printing.");
        return;
      }
      await printSheetHtml(buildSheetHtml(snap), snap.register_date);
    } catch (err) {
      AppError.handle(err, { target: dom.error });
    }
  }
})();
