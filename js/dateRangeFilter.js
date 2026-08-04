/**
 * Period filter with optional custom-date popover. Layout stays stable when Custom is selected.
 * Depends on utils.js: resolveDateRange, get/setFilterState, formatDateInput, formatDisplayDate, getMonthRange.
 */

const EDIT_ICON_SVG =
  '<svg class="date-range-edit-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M5 1a1 1 0 0 1 1 1v1h4V2a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h1V2a1 1 0 0 1 1-1zm8 6H3v6h10V7z"/>' +
  "</svg>";

/** @type {Set<{ root: HTMLElement, close: () => void }>} */
const openPopovers = new Set();
/** @type {WeakMap<HTMLElement, { getRange: Function, refresh: Function, save: Function }>} */
const wiredFilters = new WeakMap();
let docListenersBound = false;

function filterEl(ref) {
  if (!ref) return null;
  return typeof ref === "string" ? document.getElementById(ref) : ref;
}

function readDateRangeFromControls(rangeSelect, startInput, endInput) {
  return rangeSelect ? resolveDateRange(rangeSelect.value, { startInput, endInput }) : null;
}

function formatDateRangeLabel(range, modeInfo, opts = {}) {
  const mode = modeInfo?.mode;
  const startLabel = formatDisplayDate(range.start);
  const endLabel = formatDisplayDate(range.end);
  const compact = opts.style === "compact";
  const span = startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;

  switch (mode) {
    case "today":
      return `Today · ${startLabel}`;
    case "yesterday":
      return `Yesterday · ${startLabel}`;
    case "this-month": {
      const monthLabel = new Date(`${range.start}T00:00:00`).toLocaleDateString("en-IN", {
        month: "long",
        year: "numeric",
      });
      return `This month · ${monthLabel}`;
    }
    case "this-year":
      return `This year · ${String(range.start).slice(0, 4)}`;
    case "last-year":
      return `Last year · ${String(range.start).slice(0, 4)}`;
    case "this-week":
      return compact ? span : `This week · ${span}`;
    case "last-3-months":
      return `Last 3 months · ${span}`;
    case "last-30-days":
      return `Last 30 days · ${span}`;
    case "all-time":
      return "All time";
    default:
      if (compact) return span;
      return startLabel === endLabel ? `Date: ${startLabel}` : `Custom range: ${span}`;
  }
}

/** Compact label for the closed select, e.g. "1 Jun – 4 Aug 2026". */
function formatCustomRangeLabel(start, end) {
  if (!start && !end) return "Pick dates";
  if (!start || !end || start === end) return formatDisplayDate(start || end);

  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
  }

  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  return `${startDate.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  })} – ${endDate.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

function ensureDocListeners() {
  if (docListenersBound) return;
  docListenersBound = true;

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!openPopovers.size) return;
      const target = event.target;
      if (!(target instanceof Node)) return;

      const active = document.activeElement;
      // Copy before close() mutates the set.
      for (const pop of [...openPopovers]) {
        if (pop.root.contains(target)) continue;
        // Native <input type="date"> pickers often render outside the input.
        if (
          active instanceof HTMLInputElement &&
          active.type === "date" &&
          pop.root.contains(active)
        ) {
          continue;
        }
        pop.close();
      }
    },
    true
  );

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openPopovers.size) return;
    event.preventDefault();
    for (const pop of [...openPopovers]) pop.close();
  });
}

function ensureCustomDefaults(rangeSelect, startInput, endInput, customDefaults) {
  if (rangeSelect.value !== "custom" || !startInput || !endInput) return;
  if (startInput.value && endInput.value) return;
  const today = formatDateInput(new Date());
  if (!startInput.value) {
    startInput.value =
      customDefaults === "month-start"
        ? getMonthRange(new Date().getFullYear(), new Date().getMonth()).start
        : today;
  }
  if (!endInput.value) endInput.value = today;
}

function setupCustomRangePopover(customRange, rangeSelect, startInput, endInput) {
  let control = rangeSelect.closest(".date-range-control");
  if (!control) {
    control = document.createElement("div");
    control.className = "date-range-control";
    rangeSelect.before(control);
    control.append(rangeSelect);
  }
  if (customRange.parentElement !== control) control.append(customRange);

  let editBtn = control.querySelector(".date-range-edit");
  if (!editBtn) {
    editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "date-range-edit hidden";
    editBtn.setAttribute("aria-haspopup", "dialog");
    editBtn.setAttribute("aria-expanded", "false");
    editBtn.innerHTML = EDIT_ICON_SVG;
    customRange.before(editBtn);
  }

  let heading = customRange.querySelector(".custom-range-heading");
  if (!heading) {
    heading = document.createElement("p");
    heading.className = "custom-range-heading";
    customRange.prepend(heading);
  }

  let doneBtn = customRange.querySelector(".custom-range-done");
  if (!doneBtn) {
    const actions = document.createElement("div");
    actions.className = "custom-range-actions";
    doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "custom-range-done";
    doneBtn.textContent = "Done";
    actions.append(doneBtn);
    customRange.append(actions);
  }

  const customOption = rangeSelect.querySelector('option[value="custom"]');
  // Persist the original label once so re-inits / date text never pollute the default.
  if (customOption && !customOption.dataset.defaultLabel) {
    const raw = customOption.textContent?.trim() || "";
    customOption.dataset.defaultLabel =
      raw && !/^\d/.test(raw) ? raw : "Custom dates";
  }
  const defaultCustomLabel = customOption?.dataset.defaultLabel || "Custom dates";

  let open = false;
  ensureDocListeners();

  const handle = {
    root: control,
    close: () => setOpen(false),
  };

  const updateSummary = () => {
    const isCustom = rangeSelect.value === "custom";
    editBtn.classList.toggle("hidden", !isCustom);

    const label = formatCustomRangeLabel(startInput?.value || "", endInput?.value || "");
    const showRange = isCustom && label !== "Pick dates";

    if (customOption) customOption.textContent = showRange ? label : defaultCustomLabel;
    editBtn.title = showRange ? `Edit dates · ${label}` : "Edit custom dates";
    editBtn.setAttribute(
      "aria-label",
      showRange ? `Edit custom dates (${label})` : "Edit custom dates"
    );
    heading.textContent = showRange ? label : "Custom date range";
  };

  const setOpen = (nextOpen) => {
    const isCustom = rangeSelect.value === "custom";
    open = Boolean(nextOpen) && isCustom;
    customRange.classList.toggle("hidden", !open);
    customRange.setAttribute("aria-hidden", String(!open));
    editBtn.setAttribute("aria-expanded", String(open));
    if (open) openPopovers.add(handle);
    else openPopovers.delete(handle);
    updateSummary();
    if (open) {
      try {
        startInput?.focus?.();
      } catch (_) {
        /* ignore */
      }
    }
  };

  if (!editBtn.dataset.bound) {
    editBtn.dataset.bound = "1";
    editBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (rangeSelect.value === "custom") setOpen(!open);
    });
  }
  if (!doneBtn.dataset.bound) {
    doneBtn.dataset.bound = "1";
    doneBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    });
  }

  return { setOpen, updateSummary };
}

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

  // Prevent double-binding when a page re-inits the same select.
  if (wiredFilters.has(rangeSelect)) return wiredFilters.get(rangeSelect);

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

  let popover = null;
  if (customRange) {
    try {
      popover = setupCustomRangePopover(customRange, rangeSelect, startInput, endInput);
    } catch (err) {
      console.error("dateRangeFilter popover setup failed", err);
    }
  }

  let previousRange = rangeSelect.value;

  const syncCustomVisibility = ({ openPopover } = {}) => {
    const isCustom = rangeSelect.value === "custom";
    ensureCustomDefaults(rangeSelect, startInput, endInput, customDefaults);

    if (popover) {
      const shouldOpen =
        typeof openPopover === "boolean" ? openPopover : isCustom && previousRange !== "custom";
      popover.setOpen(isCustom && shouldOpen);
    } else if (customRange) {
      customRange.classList.toggle("hidden", !isCustom);
      customRange.setAttribute("aria-hidden", String(!isCustom));
    }
    previousRange = rangeSelect.value;
  };

  syncCustomVisibility({ openPopover: false });

  const save = () => {
    if (!persist || typeof setFilterState !== "function") return;
    setFilterState(storageKey, {
      range: rangeSelect.value,
      start: startInput?.value || undefined,
      end: endInput?.value || undefined,
    });
  };

  const getRange = () => {
    if (rangeSelect.value === "custom") {
      ensureCustomDefaults(rangeSelect, startInput, endInput, customDefaults);
    }
    return readDateRangeFromControls(rangeSelect, startInput, endInput);
  };

  const setLabel = (range) => {
    if (!labelEl || !range) return;
    labelEl.textContent = formatLabel
      ? formatLabel(range)
      : formatDateRangeLabel(range, range.modeInfo, { style: labelStyle });
  };

  const applyRange = async () => {
    const range = getRange();
    if (!range) {
      if (rangeSelect.value === "custom") {
        alert("Please select a valid start and end date.");
      }
      return;
    }
    setLabel(range);
    save();
    popover?.updateSummary();
    await onApply(range);
  };

  const validateCustom = () => {
    if (rangeSelect.value !== "custom") return true;
    ensureCustomDefaults(rangeSelect, startInput, endInput, customDefaults);
    const s = startInput?.value;
    const e = endInput?.value;
    if (!s || !e) {
      alert("Please select a start and end date.");
      popover?.setOpen(true);
      return false;
    }
    if (s > e) {
      alert("Start date cannot be after end date. Please select valid dates.");
      popover?.setOpen(true);
      return false;
    }
    return true;
  };

  const runApply = async (event) => {
    event?.preventDefault?.();
    if (!validateCustom()) return;
    popover?.setOpen(false);
    await applyRange();
  };

  const autoApplyOnPreset = trigger === "auto" || trigger === "form";

  rangeSelect.addEventListener("change", () => {
    syncCustomVisibility();
    if (autoApplyOnPreset && rangeSelect.value !== "custom" && validateCustom()) {
      applyRange();
    }
  });

  applyBtn?.addEventListener("click", runApply);
  form?.addEventListener("submit", runApply);

  if (startInput && endInput) {
    const onCustomInput = () => {
      if (rangeSelect.value !== "custom") return;
      popover?.updateSummary();
      if (trigger === "auto" && reloadOnCustomInput && validateCustom()) applyRange();
    };
    startInput.addEventListener("change", onCustomInput);
    endInput.addEventListener("change", onCustomInput);
  }

  if (runOnInit) {
    const initial = getRange();
    if (initial) {
      setLabel(initial);
      popover?.updateSummary();
      Promise.resolve(onApply(initial)).catch(() => {});
    }
  }

  const api = { getRange, refresh: applyRange, save };
  wiredFilters.set(rangeSelect, api);
  return api;
}

const DATE_RANGE_PRESETS = {
  dashboard: [
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
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
    { value: "today", label: "Today" },
    { value: "this-week", label: "This week" },
    { value: "this-month", label: "This month" },
    { value: "all-time", label: "All time" },
    { value: "custom", label: "Custom dates" },
  ],
  vault: [
    { value: "this-year", label: "This year" },
    { value: "last-year", label: "Last year" },
    { value: "all-time", label: "All time" },
  ],
};

window.DATE_RANGE_PRESETS = DATE_RANGE_PRESETS;
window.filterEl = filterEl;
window.readDateRangeFromControls = readDateRangeFromControls;
window.formatDateRangeLabel = formatDateRangeLabel;
window.createDateRangeFilter = createDateRangeFilter;
