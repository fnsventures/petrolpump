/**
 * Apply DSR section visibility before deferred scripts run (prevents meter-reading flash on #dsr-* links).
 */
(function () {
  const DS = window.DsrSections;
  if (!DS) return;

  function hasDateDeepLink() {
    try {
      const p = new URLSearchParams(window.location.search);
      const d = p.get("date");
      if (d && DS.YYYYMMDD.test(d)) return true;
      const stored = sessionStorage.getItem("petrolpump_sales_daily_from_dashboard");
      return !!(stored && DS.YYYYMMDD.test(stored));
    } catch (_) {}
    return false;
  }

  function resolveInitialSection() {
    const fromHash = DS.resolveFromHash(location.hash);
    if (DS.ALL.includes(fromHash)) return fromHash;
    return hasDateDeepLink() ? "filters" : "petrol";
  }

  function injectDsrViewStyles(section) {
    if (document.getElementById("dsr-section-bootstrap")) return;

    const showPetrol = section === "filters" || section === "dsr-petrol";
    const showDiesel = section === "filters" || section === "dsr-diesel";
    const singleFuel = section === "dsr-petrol" || section === "dsr-diesel";
    const rules = [
      "#dsr-page-main .settings-panel[data-panel='petrol'],",
      "#dsr-page-main .settings-panel[data-panel='diesel'] { display: none !important; }",
      "#dsr-page-main .settings-panel[data-panel='filters'] { display: block !important; }",
      "#dsr-sidebar-nav .settings-nav-item[data-dsr-sidebar-group='meter'] { display: none !important; }",
      "#dsr-sidebar-nav .settings-nav-item[data-dsr-sidebar-group='dsr'] { display: flex !important; }",
      "#dsr-page-subtitle { visibility: hidden; }",
    ];
    if (!showPetrol) {
      rules.push(
        ".dsr-daily-block--petrol, [data-dsr-stat='petrol'] { display: none !important; }"
      );
    }
    if (!showDiesel) {
      rules.push(
        ".dsr-daily-block--diesel, [data-dsr-stat='diesel'] { display: none !important; }"
      );
    }
    if (singleFuel) {
      rules.push(
        "#dsr-period-stats { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }"
      );
    }

    const style = document.createElement("style");
    style.id = "dsr-section-bootstrap";
    style.textContent = rules.join("\n");
    document.head.appendChild(style);
    document.documentElement.classList.add("dsr-boot-dsr-view");
  }

  function applyDomState(section) {
    const isDsrView = DS.isSummary(section);
    const main = document.getElementById("dsr-page-main");
    const subtitle = document.getElementById("dsr-page-subtitle");
    const navItems = document.querySelectorAll("#dsr-sidebar-nav .settings-nav-item");
    const panels = document.querySelectorAll("#dsr-page-main .settings-panel");

    main?.classList.toggle("dsr-page-layout--dsr-view", isDsrView);
    if (subtitle) subtitle.textContent = isDsrView ? "DSR" : "Meter Reading";

    navItems.forEach((btn) => {
      const group = btn.dataset.dsrSidebarGroup;
      btn.hidden = isDsrView ? group === "meter" : group === "dsr";
      btn.classList.toggle("is-active", btn.dataset.section === section);
    });

    panels.forEach((panel) => {
      const active = isDsrView ? panel.dataset.panel === "filters" : panel.dataset.panel === section;
      panel.classList.toggle("is-visible", active);
      panel.hidden = !active;
    });
  }

  const initialSection = resolveInitialSection();
  if (DS.isSummary(initialSection)) {
    injectDsrViewStyles(initialSection);
  }

  function onReady() {
    applyDomState(initialSection);
    const subtitle = document.getElementById("dsr-page-subtitle");
    if (subtitle) subtitle.style.visibility = "";
    document.getElementById("dsr-section-bootstrap")?.remove();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
