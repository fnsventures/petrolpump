/**
 * In-page section navigation (layer 3 of the app shell).
 * Prefer: app-layout, app-sections, app-section-item, app-panels, app-panel
 * Legacy aliases: settings-layout, settings-nav, settings-nav-item, settings-panels, settings-panel
 */
(function (global) {
  /**
   * @param {Object} config
   * @param {string} [config.navItemSelector]
   * @param {string} [config.panelSelector]
   * @param {string} [config.defaultSection]
   * @param {string[]} [config.validSections]
   * @param {(section: string) => string} [config.resolvePanelId]
   * @param {(section: string) => string} [config.navSectionFor] Map logical section → nav button data-section
   * @param {(section: string) => string} [config.normalizeSection] Collapse alias sections (e.g. sales-detail → by-pump)
   * @param {(section: string) => void} [config.onSectionChange]
   */
  function initPageSections(config = {}) {
    const navItemSelector = config.navItemSelector || ".settings-nav-item, .app-section-item";
    const panelSelector = config.panelSelector || ".settings-panel, .app-panel";
    const navItems = document.querySelectorAll(navItemSelector);
    const panels = document.querySelectorAll(panelSelector);
    if (!navItems.length || !panels.length) return;

    const valid =
      config.validSections ||
      [...navItems].map((btn) => btn.dataset.section).filter(Boolean);
    const defaultSection = config.defaultSection || valid[0] || "";

    function normalizeSectionId(raw) {
      const hashAliases = config.hashAliases || {};
      const h = String(raw || "")
        .replace(/^#/, "")
        .split("?")[0]
        .split("&")[0];
      return hashAliases[h] || h;
    }

    function panelIdForSection(section) {
      return typeof config.resolvePanelId === "function" ? config.resolvePanelId(section) : section;
    }

    function navIdForSection(section) {
      return typeof config.navSectionFor === "function" ? config.navSectionFor(section) : section;
    }

    function resolveSection(id) {
      let section = valid.includes(id) ? id : defaultSection;
      if (typeof config.normalizeSection === "function") {
        const next = config.normalizeSection(section);
        if (next && valid.includes(next)) section = next;
      }
      return section;
    }

    function showSection(id) {
      const section = resolveSection(id);
      const panelId = panelIdForSection(section);
      const navId = navIdForSection(section);
      navItems.forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.section === navId);
      });
      panels.forEach((panel) => {
        if (panel.closest("#topbar-notifications-popup")) return;
        if (!panel.dataset.panel) return;
        const active = panel.dataset.panel === panelId;
        panel.classList.toggle("is-visible", active);
        panel.hidden = !active;
      });
      if (section && location.hash !== "#" + section) {
        history.replaceState(null, "", "#" + section);
      }
      if (typeof config.onSectionChange === "function") {
        config.onSectionChange(section);
      }
    }

    navItems.forEach((btn) => {
      btn.addEventListener("click", () => showSection(btn.dataset.section || defaultSection));
    });

    const hash = normalizeSectionId(location.hash);
    showSection(valid.includes(hash) ? hash : defaultSection);

    window.addEventListener("hashchange", () => {
      const h = normalizeSectionId(location.hash);
      if (valid.includes(h)) showSection(h);
    });
  }

  global.initPageSections = initPageSections;
})(typeof window !== "undefined" ? window : globalThis);
