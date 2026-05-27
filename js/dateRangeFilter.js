/**
 * Generic date-range filter: range select, optional custom dates, persistence, and callbacks.
 * Depends on utils.js (resolveDateRange, setCustomRangeVisibility, get/setFilterState, formatDateInput).
 */

/**
 * Resolve element from id string or HTMLElement.
 * @param {string|HTMLElement|null|undefined} ref
 * @returns {HTMLElement|null}
 */
function filterEl(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return document.getElementById(ref);
  return ref;
}

/**
 * Read current { start, end, modeInfo } from filter controls.
 * @param {HTMLSelectElement|null} rangeSelect
 * @param {HTMLInputElement|null} startInput
 * @param {HTMLInputElement|null} endInput
 * @returns {{ start: string, end: string, modeInfo?: { mode: string } }|null}
 */
function readDateRangeFromControls(rangeSelect, startInput, endInput) {
  if (!rangeSelect) return null;
  return resolveDateRange(rangeSelect.value, { startInput, endInput });
}

/**
 * Human-readable label for a resolved date range.
 * @param {{ start: string, end: string }} range
 * @param {{ mode?: string }|undefined} modeInfo
 * @param {{ style?: 'dashboard'|'compact' }} [opts]
 * @returns {string}
 */
function formatDateRangeLabel(range, modeInfo, opts = {}) {
  const mode = modeInfo?.mode;
  const startLabel = formatDisplayDate(range.start);
  const endLabel = formatDisplayDate(range.end);
  const style = opts.style || "dashboard";

  if (mode === "today") return `Today · ${startLabel}`;

  if (mode === "this-month") {
    const monthDate = new Date(`${range.start}T00:00:00`);
    const monthLabel = monthDate.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
    return `This month · ${monthLabel}`;
  }

  if (mode === "this-week") {
    if (style === "compact") {
      return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
    }
    return `This week · ${startLabel} – ${endLabel}`;
  }

  if (mode === "last-3-months") {
    return `Last 3 months · ${startLabel} – ${endLabel}`;
  }

  if (mode === "last-30-days") return `Last 30 days · ${startLabel} – ${endLabel}`;
  if (mode === "all-time") return "All time";

  if (startLabel === endLabel) return `Date: ${startLabel}`;
  if (style === "compact") return `${startLabel} – ${endLabel}`;
  return `Custom range: ${startLabel} – ${endLabel}`;
}

/**
 * Wire a standard period filter (select + optional custom from/to).
 *
 * @param {Object} config
 * @param {string} config.storageKey - localStorage key (without prefix)
 * @param {string[]} config.ranges - allowed range option values
 * @param {string} config.defaultRange
 * @param {string|HTMLElement} config.rangeSelect
 * @param {string|HTMLElement} [config.startInput]
 * @param {string|HTMLElement} [config.endInput]
 * @param {string|HTMLElement} [config.customRange]
 * @param {string|HTMLElement} [config.form]
 * @param {string|HTMLElement} [config.applyBtn]
 * @param {string|HTMLElement} [config.labelEl]
 * @param {'auto'|'apply'|'form'} [config.trigger='auto'] - when onApply runs
 * @param {boolean} [config.persist=true]
 * @param {boolean} [config.runOnInit=true]
 * @param {boolean} [config.reloadOnCustomInput=true] - auto mode: reload when custom dates change
 * @param {'dashboard'|'compact'} [config.labelStyle='dashboard']
 * @param {'today'|'month-start'} [config.customDefaults='today'] - preset when custom range is empty
 * @param {(range: { start: string, end: string, modeInfo?: object }) => void|Promise<void>} config.onApply
 * @param {(range: { start: string, end: string, modeInfo?: object }) => string} [config.formatLabel]
 * @returns {{ getRange: () => object|null, refresh: () => Promise<void>, save: () => void }|null}
 */
function createDateRangeFilter(config) {
  const {
    storageKey,
    ranges,
    defaultRange,
    rangeSelect: rangeRef,
    startInput: startRef,
    endInput: endRef,
    customRange: customRef,
    form: formRef,
    applyBtn: applyRef,
    labelEl: labelRef,
    trigger = "auto",
    persist = true,
    runOnInit = true,
    reloadOnCustomInput = true,
    labelStyle = "dashboard",
    customDefaults = "today",
    onApply,
    formatLabel,
  } = config;

  const rangeSelect = filterEl(rangeRef);
  const startInput = filterEl(startRef);
  const endInput = filterEl(endRef);
  const customRange = filterEl(customRef);
  const form = filterEl(formRef);
  const applyBtn = filterEl(applyRef);
  const labelEl = filterEl(labelRef);

  if (!rangeSelect || !onApply) return null;

  const allowedRanges = new Set(ranges);
  const stored =
    persist && typeof getValidFilterState === "function"
      ? getValidFilterState(storageKey, allowedRanges)
      : null;

  if (stored) {
    rangeSelect.value = stored.range;
    if (stored.range === "custom" && stored.start && stored.end) {
      if (startInput) startInput.value = stored.start;
      if (endInput) endInput.value = stored.end;
    }
  } else if (!allowedRanges.has(rangeSelect.value)) {
    rangeSelect.value = defaultRange;
  }

  const syncCustomVisibility = () => {
    const isCustom = rangeSelect.value === "custom";
    setCustomRangeVisibility(customRange, startInput, endInput, isCustom);
    if (customRange) customRange.setAttribute("aria-hidden", isCustom ? "false" : "true");
    if (isCustom && startInput && endInput && (!startInput.value || !endInput.value)) {
      const today = formatDateInput(new Date());
      const defaultStart =
        customDefaults === "month-start"
          ? getMonthRange(new Date().getFullYear(), new Date().getMonth()).start
          : today;
      if (!startInput.value) startInput.value = defaultStart;
      if (!endInput.value) endInput.value = today;
    }
  };

  syncCustomVisibility();

  const save = () => {
    if (!persist || typeof setFilterState !== "function") return;
    setFilterState(storageKey, {
      range: rangeSelect.value,
      start: startInput?.value || undefined,
      end: endInput?.value || undefined,
    });
  };

  const updateLabel = (range) => {
    if (!labelEl || !range) return;
    const text = formatLabel
      ? formatLabel(range)
      : formatDateRangeLabel(range, range.modeInfo, { style: labelStyle });
    labelEl.textContent = text;
  };

  const getRange = () => readDateRangeFromControls(rangeSelect, startInput, endInput);

  const applyRange = async () => {
    const range = getRange();
    if (!range) return;
    updateLabel(range);
    save();
    await onApply(range);
  };

  const validateCustom = () => {
    if (rangeSelect.value !== "custom") return true;
    const s = startInput?.value;
    const e = endInput?.value;
    if (s && e && s > e) {
      alert("Start date cannot be after end date. Please select valid dates.");
      return false;
    }
    return true;
  };

  if (trigger === "auto") {
    rangeSelect.addEventListener("change", async () => {
      syncCustomVisibility();
      if (rangeSelect.value === "custom") return;
      if (!validateCustom()) return;
      await applyRange();
    });

    if (reloadOnCustomInput && startInput && endInput) {
      const onCustomChange = async () => {
        if (rangeSelect.value !== "custom") return;
        if (!validateCustom()) return;
        await applyRange();
      };
      startInput.addEventListener("change", onCustomChange);
      endInput.addEventListener("change", onCustomChange);
    }

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!validateCustom()) return;
      await applyRange();
    });
  } else if (trigger === "apply") {
    rangeSelect.addEventListener("change", syncCustomVisibility);
    applyBtn?.addEventListener("click", async () => {
      if (!validateCustom()) return;
      await applyRange();
    });
  } else if (trigger === "form") {
    rangeSelect.addEventListener("change", () => {
      syncCustomVisibility();
      if (rangeSelect.value !== "custom") applyRange();
    });
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!validateCustom()) return;
      await applyRange();
    });
  }

  const refresh = applyRange;

  if (runOnInit) {
    const initial = getRange();
    if (initial) {
      updateLabel(initial);
      Promise.resolve(onApply(initial)).catch(() => {});
    }
  }

  return { getRange, refresh, save };
}

/** Standard period presets for range &lt;select&gt; options. */
const DATE_RANGE_PRESETS = {
  dashboard: [
    { value: "today", label: "Today" },
    { value: "this-week", label: "This week" },
    { value: "this-month", label: "This month" },
    { value: "custom", label: "Custom dates" },
  ],
  analysis: [
    { value: "this-week", label: "This week" },
    { value: "this-month", label: "This month" },
    { value: "last-3-months", label: "Last 3 months" },
    { value: "custom", label: "Custom dates" },
  ],
  expenses: [
    { value: "this-month", label: "This month" },
    { value: "this-week", label: "This week" },
    { value: "custom", label: "Custom dates" },
  ],
  billing: [
    { value: "today", label: "Today" },
    { value: "this-week", label: "This week" },
    { value: "this-month", label: "This month" },
    { value: "custom", label: "Custom range" },
  ],
  creditCustomer: [
    { value: "this-month", label: "This month" },
    { value: "last-30-days", label: "Last 30 days" },
    { value: "all-time", label: "All time" },
    { value: "custom", label: "Custom dates" },
  ],
};

window.DATE_RANGE_PRESETS = DATE_RANGE_PRESETS;

window.filterEl = filterEl;
window.readDateRangeFromControls = readDateRangeFromControls;
window.formatDateRangeLabel = formatDateRangeLabel;
window.createDateRangeFilter = createDateRangeFilter;
