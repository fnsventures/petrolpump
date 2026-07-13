/* global requireAuth, applyRoleVisibility, loadPumpSettings, initPageSections */

const DS = window.DsrSections;
const DSR_SUMMARY_SECTIONS = DS?.SUMMARY ?? new Set(["filters", "dsr-petrol", "dsr-diesel"]);
let currentDsrSection = "filters";

window.DsrPage = {
  getCurrentSection: () => currentDsrSection,
};

document.addEventListener("DOMContentLoaded", async () => {
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
});

function initDsrSummaryPage({ dateFromDashboard, urlDateParam } = {}) {
  const layoutEls = {
    petrolBlock: document.querySelector(".dsr-daily-block--petrol"),
    dieselBlock: document.querySelector(".dsr-daily-block--diesel"),
    petrolStat: document.querySelector('[data-dsr-stat="petrol"]'),
    dieselStat: document.querySelector('[data-dsr-stat="diesel"]'),
    statsEl: document.getElementById("dsr-period-stats"),
    titleEl: document.querySelector('[data-panel="filters"] .dashboard-section-title'),
    leadEl: document.querySelector('[data-panel="filters"] .panel-lead'),
  };

  function applySummaryLayout(section) {
    const showPetrol = section === "filters" || section === "dsr-petrol";
    const showDiesel = section === "filters" || section === "dsr-diesel";
    const singleFuel = section === "dsr-petrol" || section === "dsr-diesel";

    layoutEls.petrolBlock?.toggleAttribute("hidden", !showPetrol);
    layoutEls.dieselBlock?.toggleAttribute("hidden", !showDiesel);
    layoutEls.petrolStat?.toggleAttribute("hidden", !showPetrol);
    layoutEls.dieselStat?.toggleAttribute("hidden", !showDiesel);
    layoutEls.statsEl?.classList.toggle("dsr-period-stats--single-fuel", singleFuel);

    const copy = DS?.getSummaryCopy(section);
    if (copy && layoutEls.titleEl) layoutEls.titleEl.textContent = copy.title;
    if (copy && layoutEls.leadEl) layoutEls.leadEl.textContent = copy.lead;
  }

  function onSectionChange(section) {
    currentDsrSection = section;
    applySummaryLayout(section);
    window.DsrSummary?.refreshIfNeeded?.();
  }

  const defaultSection = "filters";

  initPageSections({
    navItemSelector: "#dsr-sidebar-nav .settings-nav-item",
    panelSelector: ".settings-panels .settings-panel",
    defaultSection,
    validSections: [...DSR_SUMMARY_SECTIONS],
    resolvePanelId: () => "filters",
    onSectionChange,
  });

  window.DsrSummary?.initFilters?.(dateFromDashboard, urlDateParam);
  void window.DsrSummary?.refreshIfNeeded?.(true);
}
