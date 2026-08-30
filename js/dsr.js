/* global requireAuth, applyRoleVisibility, loadPumpSettings, initPageSections, PrintUtils, AppError, escapeHtml, formatDisplayDate, formatQuantity */

const DS = window.DsrSections;
const DSR_SUMMARY_SECTIONS = DS?.SUMMARY ?? new Set(["filters", "dsr-petrol", "dsr-diesel"]);
let currentDsrSection = "filters";
let lastBreakdownSection = "by-salesman";
let dsrPrintBusy = false;

window.DsrPage = {
  getCurrentSection: () => currentDsrSection,
};

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "dsr",
  });
  if (!auth) return;

  await loadPumpSettings();
  applyRoleVisibility(auth.role);
  window.DsrFuelNav?.applyFuelNavMeta?.();

  initDsrSummaryPage({
    dateFromDashboard: DS?.consumeDashboardDateDeepLink?.() ?? null,
    urlDateParam: DS?.getUrlDateParam?.() ?? null,
  });

  bindLiveRefresh(() => {
    void window.DsrSummary?.refreshIfNeeded?.(true);
  }, { match: () => document.body.classList.contains("dsr-page") });
});

function initDsrSummaryPage({ dateFromDashboard, urlDateParam } = {}) {
  const layoutEls = {
    registerView: document.getElementById("dsr-register-view"),
    breakdownView: document.getElementById("dsr-breakdown-view"),
    petrolBlock: document.querySelector(".dsr-daily-block--petrol"),
    dieselBlock: document.querySelector(".dsr-daily-block--diesel"),
    petrolStat: document.querySelector('[data-dsr-stat="petrol"]'),
    dieselStat: document.querySelector('[data-dsr-stat="diesel"]'),
    statsEl: document.getElementById("dsr-period-stats"),
    titleEl: document.querySelector('[data-panel="filters"] .dashboard-section-title'),
    leadEl: document.querySelector('[data-panel="filters"] .panel-lead'),
    reportLink: document.getElementById("dsr-panel-report-link"),
    printBtn: document.getElementById("dsr-print-btn"),
  };

  function reportTabForSection(section) {
    if (section === "by-pump") return "pump-sales";
    if (section === "by-shift") return "shift-sales";
    if (section === "by-salesman") return "salesman-sales";
    return "dsr";
  }

  function syncBreakdownView(section) {
    const sel = document.getElementById("dsr-filter-view");
    if (sel && DS?.isBreakdownSection?.(section)) sel.value = section;
  }

  function applySummaryLayout(section) {
    const isBreakdown = DS?.isBreakdownSection?.(section) || false;
    const showPetrol = !isBreakdown && (section === "filters" || section === "dsr-petrol");
    const showDiesel = !isBreakdown && (section === "filters" || section === "dsr-diesel");
    const singleFuel = section === "dsr-petrol" || section === "dsr-diesel";

    layoutEls.registerView?.toggleAttribute("hidden", isBreakdown);
    layoutEls.breakdownView?.toggleAttribute("hidden", !isBreakdown);
    document.querySelector(".dsr-panel-links")?.toggleAttribute("hidden", isBreakdown);

    layoutEls.petrolBlock?.toggleAttribute("hidden", !showPetrol);
    layoutEls.dieselBlock?.toggleAttribute("hidden", !showDiesel);
    layoutEls.petrolStat?.toggleAttribute("hidden", !showPetrol);
    layoutEls.dieselStat?.toggleAttribute("hidden", !showDiesel);
    layoutEls.statsEl?.classList.toggle("dsr-period-stats--single-fuel", singleFuel);

    const copy = DS?.getSummaryCopy(section);
    if (copy && layoutEls.titleEl) layoutEls.titleEl.textContent = copy.title;
    if (copy && layoutEls.leadEl) layoutEls.leadEl.textContent = copy.lead;

    if (isBreakdown) syncBreakdownView(section);

    if (layoutEls.reportLink) {
      const start = document.getElementById("dsr-daily-start-date")?.value || "";
      const end = document.getElementById("dsr-daily-end-date")?.value || "";
      const tab = reportTabForSection(section);
      const qs =
        start && end
          ? `?tab=${tab}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
          : `?tab=${tab}`;
      layoutEls.reportLink.href = `reports.html${qs}`;
      layoutEls.reportLink.textContent =
        tab === "dsr" ? "Tank-wise report →" : "Full report →";
    }
  }

  function onSectionChange(section) {
    if (DS?.isBreakdownSection?.(section)) lastBreakdownSection = section;
    currentDsrSection = section;
    applySummaryLayout(section);
    window.DsrSummary?.refreshIfNeeded?.();
  }

  const defaultSection = "filters";
  const hashAliases = {
    total: "filters",
    petrol: "dsr-petrol",
    diesel: "dsr-diesel",
    sales: "sales-detail",
    detail: "sales-detail",
    pump: "by-pump",
    shift: "by-shift",
    salesman: "by-salesman",
    staff: "by-salesman",
  };

  initPageSections({
    navItemSelector: "#dsr-sidebar-nav .settings-nav-item",
    panelSelector: ".settings-panels .settings-panel",
    defaultSection,
    validSections: [...DSR_SUMMARY_SECTIONS],
    hashAliases,
    resolvePanelId: () => "filters",
    navSectionFor: (section) =>
      section === "sales-detail" || DS?.isBreakdownSection?.(section) ? "sales-detail" : section,
    normalizeSection: (section) => {
      if (section === "sales-detail") return lastBreakdownSection || "by-salesman";
      return section;
    },
    onSectionChange,
  });

  document.getElementById("dsr-filter-view")?.addEventListener("change", (e) => {
    const next = e.target.value;
    if (!DS?.isBreakdownSection?.(next)) return;
    lastBreakdownSection = next;
    if (location.hash !== "#" + next) {
      location.hash = next;
    } else {
      onSectionChange(next);
    }
  });

  layoutEls.printBtn?.addEventListener("click", () => void printCurrentDsrView());

  window.DsrSummary?.initFilters?.(dateFromDashboard, urlDateParam);
  void window.DsrSummary?.refreshIfNeeded?.(true);
  PrintUtils.preloadReportPrintCss?.();
}

function periodLabelFromInputs() {
  const start = document.getElementById("dsr-daily-start-date")?.value || "";
  const end = document.getElementById("dsr-daily-end-date")?.value || "";
  if (!start || !end) return "";
  const fmt = (d) => (typeof formatDisplayDate === "function" ? formatDisplayDate(d) : d);
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

function cloneTableForPrint(tableEl) {
  if (!tableEl) return "";
  const clone = tableEl.cloneNode(true);
  clone.className = "report-table report-table-compact";
  clone.removeAttribute("style");
  return clone.outerHTML;
}

function buildRegisterPrintBody(section) {
  const parts = [];
  const stats = window.DsrSummary?.getPeriodStatsSnapshot?.(section);
  if (stats) {
    const lines = [];
    if (section === "filters" || section === "dsr-petrol") {
      lines.push(`MS net sale: <strong>${escapeHtml(formatQuantity(stats.petrolNet))} L</strong>`);
    }
    if (section === "filters" || section === "dsr-diesel") {
      lines.push(`HSD net sale: <strong>${escapeHtml(formatQuantity(stats.dieselNet))} L</strong>`);
    }
    lines.push(`Receipts: <strong>${escapeHtml(formatQuantity(stats.receipts))} L</strong>`);
    lines.push(`Variation: <strong>${escapeHtml(formatQuantity(stats.variation))} L</strong>`);
    parts.push(`<p class="report-summary-line">${lines.join(" · ")}</p>`);
  }

  const showPetrol = section === "filters" || section === "dsr-petrol";
  const showDiesel = section === "filters" || section === "dsr-diesel";
  if (showPetrol) {
    const table = document.querySelector(".dsr-daily-block--petrol .dsr-table");
    if (table) {
      parts.push(`<h3 class="report-section-title">Petrol (MS)</h3>`);
      parts.push(cloneTableForPrint(table));
    }
  }
  if (showDiesel) {
    const table = document.querySelector(".dsr-daily-block--diesel .dsr-table");
    if (table) {
      parts.push(`<h3 class="report-section-title">Diesel (HSD)</h3>`);
      parts.push(cloneTableForPrint(table));
    }
  }
  if (!parts.length) {
    throw new Error("Nothing to print. Load a date range first.");
  }
  return parts.join("\n");
}

function buildBreakdownPrintBody(section) {
  const table = document.querySelector("#dsr-breakdown-body .dsr-breakdown-table");
  if (!table) {
    throw new Error("Nothing to print. Load sales detail for this period first.");
  }
  const note = document.querySelector(
    "#dsr-breakdown-body .dsr-breakdown-note, #dsr-breakdown-body > p.muted"
  );
  return `${cloneTableForPrint(table)}${
    note ? `<p class="report-note muted">${escapeHtml(note.textContent || "")}</p>` : ""
  }`;
}

async function printCurrentDsrView() {
  const btn = document.getElementById("dsr-print-btn");
  if (dsrPrintBusy) return;
  const section = currentDsrSection;
  const period = periodLabelFromInputs();
  if (!period) {
    AppError?.handle?.(new Error("Select a From / To date range first."));
    return;
  }

  dsrPrintBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Preparing…";
  }

  try {
    await loadPumpSettings();
    const isBreakdown = DS?.isBreakdownSection?.(section);
    const copy = DS?.getSummaryCopy(section) || { title: "DSR" };
    const title = isBreakdown
      ? copy.title.replace(/^Sales detail · /, "DSR · ")
      : `DSR · ${copy.title}`;
    const bodyHtml = isBreakdown ? buildBreakdownPrintBody(section) : buildRegisterPrintBody(section);
    const sheet = PrintUtils.wrapReportPrintSheet(title, [escapeHtml(period)], bodyHtml, period);
    const cssText = await PrintUtils.getReportPrintCssText();
    const slug = isBreakdown
      ? section.replace(/^by-/, "dsr-")
      : section === "filters"
        ? "dsr-total"
        : section === "dsr-petrol"
          ? "dsr-ms"
          : section === "dsr-diesel"
            ? "dsr-hsd"
            : "dsr";
    await PrintUtils.printInIframe({
      title: PrintUtils.buildPrintFilename(slug, period),
      bodyHtml: sheet,
      cssText,
      bodyClass: "report-print-body",
      containerClass: "report-print-container",
      iframeTitle: "DSR print",
      imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
    });
  } catch (err) {
    const msg = AppError.handle(err, { context: { source: "dsrPrint" } });
    window.alert(msg || err?.message || "Could not print.");
  } finally {
    dsrPrintBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Print";
    }
  }
}
