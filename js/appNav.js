/**
 * Nested auto-collapsing sidebar (layers 1–2).
 *   layer 1 — Operations / Finance / HR / Admin
 *   layer 2 — Dashboard / Meter Reading / …
 * Layer 3 (Daily snapshot, DSR summary, …) stays in the in-page section nav.
 * Nav items: NAV_GROUPS below. Page CSS/JS: _partials/app-pages.json
 */
(function () {
  const PIN_KEY = "bpf.appSidebar.pinned";
  const SECTIONS_KEY = "bpf.appSections.open";
  document.documentElement.classList.add("has-app-sidebar");
  try {
    if (localStorage.getItem(PIN_KEY) === "1") {
      document.documentElement.classList.add("app-sidebar-pinned");
    }
  } catch {
    /* ignore */
  }

  const CHEVRON =
    '<svg class="app-sidebar-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5 15 12l-6 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const ICONS = {
    operations:
      '<path d="M4 3h10a2 2 0 0 1 2 2v8h2.2A1.8 1.8 0 0 0 20 11.2V7h2v4.2A3.8 3.8 0 0 1 18.2 15H16v6H4V3zm2.2 2.2v13.6h7.6V5.2H6.2zm1.5 2h4.6v2.2H7.7V7.2z"/>',
    finance:
      '<path d="M12 2 1 8v2h22V8L12 2zM4 12h3.5v7H4v-7zm6.25 0h3.5v7h-3.5v-7zM16.5 12H20v7h-3.5v-7zM2 21h20v2H2v-2z"/>',
    hr: '<path d="M8.5 11a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 8.5 11zm8 0A3 3 0 1 0 13.5 8a3 3 0 0 0 3 3zM8.5 13C5.4 13 2 14.6 2 17.6V21h13v-3.4C15 14.6 11.6 13 8.5 13zm8 .2c-.4 0-.8 0-1.2.1 1.8 1.1 3 2.6 3 4.3V21h6v-2.8c0-2.5-3.2-4.8-7.8-5z"/>',
    admin:
      '<path d="M3 5h12v2.2H3V5zm14.2-1.8v5.8h2.3V3.2h-2.3zM3 10.9h6.5v2.2H3v-2.2zm8.7-1.8v5.8h2.3V9.1h-2.3zM12.8 16.8H21V19h-8.2v-2.2zM8.5 15v5.8H10.8V15H8.5zM3 16.8h4.2V19H3v-2.2z"/>',
    dashboard:
      '<path d="M3 3h8.2v8.2H3V3zm9.8 0H21v5.2h-8.2V3zM3 13h8.2v8H3v-8zm9.8 3.2H21V21h-8.2v-4.8z"/>',
    meter:
      '<path d="M3 5h18v14H3V5zm2.2 2.2v9.6h13.6V7.2H5.2zm2 7.2 2.4-4.4 2.3 2.7 3.2-4.8 1.8 6.5h-2.1L13.6 10l-2.1 2.3-1.9-2.2-1.3 4.3H7.2z"/>',
    dsr: '<path d="M3 4h18v16H3V4zm2.2 2.2v3.2h7.2V6.2H5.2zm9.2 0v3.2h6.4V6.2h-6.4zM5.2 11v3.2h7.2V11H5.2zm9.2 0v3.2h6.4V11h-6.4zM5.2 15.8V18h7.2v-2.2H5.2zm9.2 0V18h6.4v-2.2h-6.4z"/>',
    flask:
      '<path d="M9 2h6v2.2h-1.2v4.8l5.3 8.6A2.2 2.2 0 0 1 17.2 21H6.8A2.2 2.2 0 0 1 5 17.6l5.3-8.6V4.2H9V2zm1.8 8.3L8.2 16.4h7.6l-2.6-6.1z"/>',
    tasks:
      '<path d="M9 2.5h6l1 2H21V21H3V4.5h5l1-2zM8.2 12.2 6.4 14l3.4 3.4 7.4-7.4-1.8-1.8-5.6 5.6z"/>',
    credit:
      '<path d="M2 6.5h20V18H2V6.5zm2.2 2v1.8h15.6V8.5H4.2zm0 4.2v3.4h7.2v-3.4H4.2z"/>',
    expenses:
      '<path d="M7 2h10l-1.2 2.1 1.2 2.1-1.2 2.1 1.2 2.1-1.2 2.1 1.2 2.1-1.2 2.1 1.2 2.2H7V2zm2.4 4.4h5.2v2H9.4v-2zm0 4.2h5.2v2H9.4v-2zm0 4.2h3.4v2H9.4v-2z"/>',
    closing:
      '<path d="M3 6h18v4.2H3V6zm0 6h18v9H3v-9zm8.2 1.8v5.4h1.6v-5.4h-1.6zM5 3.2h14v2.2H5V3.2z"/>',
    billing:
      '<path d="M5 2h11l4 4.2V22H5V2zm10.2 1.8v3.4H19l-3.8-3.4zM8 9.2h8v1.8H8V9.2zm0 3.4h8v1.8H8v-1.8zm0 3.4h5.2V18H8v-1.8z"/>',
    attendance:
      '<path d="M7 2h2.2v2h5.6V2H17v2h3v18H4V4h3V2zm13 6.2H4V20h16V8.2zM10.1 12.1 8.4 13.8l2.8 2.8 5.4-5.4-1.7-1.7-3.7 3.7z"/>',
    salary:
      '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm.9 5.1v1.1c1.7.3 2.8 1.3 2.8 2.8 0 1.8-1.5 2.7-3.7 3v2.6h-1.8v-2.5c-1.9-.2-3.4-1.3-3.7-3h2.1c.2.8 1 1.4 2.6 1.5v-3.2c-1.7-.2-2.7-1-2.7-2.3 0-1.5 1.2-2.5 3.3-2.7V5.1h1.8v1.2c1.7.2 3 1.1 3.2 2.6h-2.1c-.2-.7-.9-1.2-2.1-1.3z"/>',
    staff:
      '<path d="M8 3h8a2 2 0 0 1 2 2v16l-6-2.8L6 21V5a2 2 0 0 1 2-2zm4 3.2A2.6 2.6 0 1 0 14.6 8.8 2.6 2.6 0 0 0 12 6.2zm0 6.2c-2.3 0-4.2.9-4.2 2.1v.8L12 14l4.2 1.3v-.8c0-1.2-1.9-2.1-4.2-2.1z"/>',
    vault:
      '<path d="M6.2 8.2V6a5.8 5.8 0 0 1 11.6 0v2.2H20V22H4V8.2h2.2zm2.2 0h7.2V6a3.6 3.6 0 0 0-7.2 0v2.2zM12 12.2a2.6 2.6 0 1 0 2.6 2.6 2.6 2.6 0 0 0-2.6-2.6z"/>',
    letter:
      '<path d="M2.5 5h19v14h-19V5zm9.5 7.2L5.2 8.1 3.8 9.8 12 15.4l8.2-5.6-1.4-1.7z"/>',
    analysis:
      '<path d="M3 19.2h18V21H3v-1.8zM5.2 16.4 9.8 11l3.6 2.7L19 6.4l1.6 1.2-7.5 9.6-3.6-2.7-3.1 3.7z"/>',
    reports:
      '<path d="M6 2h9.2L20 7.4V22H6V2zm8.4 1.8v4.4H19l-4.6-4.4zM8.2 12.4h2.2v6.2H8.2v-6.2zm3.6-2.6h2.2v8.8h-2.2V9.8zm3.6 1.8h2.2v7H15.4v-7z"/>',
    settings:
      '<path d="M19.4 13a7.7 7.7 0 0 0 .1-1 7.7 7.7 0 0 0-.1-1l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 2h-6l-.3 2.9A7.4 7.4 0 0 0 7 6L4.5 5 2.5 8.5 4.6 10a7.7 7.7 0 0 0-.1 1 7.7 7.7 0 0 0 .1 1L2.5 13.6l2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L9 22h6l.3-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/>',
  };

  const FILE_GROUP_ALIASES = {
    "credit-customer.html": "credit.html",
    "credit-overdue.html": "credit.html",
    "sales-daily.html": "dsr.html",
  };

  const NAV_GROUPS = [
    {
      id: "operations",
      label: "Operations",
      icon: "operations",
      links: [
        { href: "dashboard.html", label: "Dashboard", icon: "dashboard" },
        { href: "meter-reading.html#shift-readings", file: "meter-reading.html", label: "Meter Reading", icon: "meter" },
        { href: "dsr.html", label: "DSR", icon: "dsr" },
        { href: "e20-register.html", label: "E-20 testing", icon: "flask" },
        { href: "reminders.html", label: "Tasks", icon: "tasks" },
      ],
    },
    {
      id: "finance",
      label: "Finance",
      icon: "finance",
      links: [
        { href: "credit.html", label: "Credit", icon: "credit" },
        { href: "expenses.html", label: "Expenses", icon: "expenses" },
        { href: "day-closing.html", label: "Day closing & short", icon: "closing" },
        { href: "billing.html", label: "Billing", icon: "billing" },
      ],
    },
    {
      id: "hr",
      label: "HR",
      icon: "hr",
      links: [
        { href: "attendance.html", label: "Attendance", icon: "attendance" },
        { href: "salary.html", label: "Salary", icon: "salary" },
        { href: "staff.html", label: "Staff", icon: "staff" },
        { href: "invoices.html", label: "Vault", icon: "vault" },
        { href: "letterhead.html", label: "Letter Desk", icon: "letter" },
      ],
    },
    {
      id: "admin",
      label: "Admin",
      icon: "admin",
      adminOnly: true,
      links: [
        { href: "analysis.html", label: "Analysis", icon: "analysis" },
        { href: "reports.html", label: "Reports", icon: "reports" },
        { href: "settings.html", label: "Settings", icon: "settings" },
      ],
    },
  ];

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function iconSvg(name) {
    const path = ICONS[name] || ICONS.dashboard;
    return `<svg class="app-sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${path}</svg>`;
  }

  function currentFileName() {
    const path = window.location.pathname;
    let file = path.split("/").pop() || "";
    if (!file || file === "index.html") return "dashboard.html";
    return file;
  }

  function fileFromHref(href) {
    return String(href || "").split("#")[0] || currentFileName();
  }

  function groupForFile(file) {
    const resolved = FILE_GROUP_ALIASES[file] || file;
    return (
      NAV_GROUPS.find((group) =>
        group.links.some((link) => (link.file || fileFromHref(link.href)) === resolved)
      ) || null
    );
  }

  function syncPageLayer() {
    const topbar = document.querySelector("header.topbar");
    const subtitle = topbar?.querySelector(".page-subtitle");
    if (!topbar || !subtitle) return;

    let stack = subtitle.closest(".page-title-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "page-title-stack";
      subtitle.replaceWith(stack);
      stack.appendChild(subtitle);
    }

    if (stack.parentElement !== topbar) {
      const insertBefore =
        topbar.querySelector(".nav-toggle") ??
        topbar.querySelector(".topbar-actions") ??
        topbar.querySelector(".nav-wrap");
      topbar.insertBefore(stack, insertBefore);
    }

    const group = groupForFile(currentFileName());
    let layer = stack.querySelector(".page-layer");
    if (!group) {
      layer?.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement("span");
      layer.className = "page-layer";
      stack.appendChild(layer);
    }
    layer.textContent = group.label;
  }

  function isPinned() {
    try {
      return localStorage.getItem(PIN_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setPinned(next) {
    try {
      localStorage.setItem(PIN_KEY, next ? "1" : "0");
    } catch {
      /* ignore quota */
    }
    document.documentElement.classList.toggle("app-sidebar-pinned", next);
    document.body.classList.toggle("app-sidebar-pinned", next);
    const pin = document.querySelector(".app-sidebar-pin");
    pin?.setAttribute("aria-pressed", String(next));
    pin?.classList.toggle("is-active", next);
    const label = pin?.querySelector(".app-sidebar-label");
    if (label) label.textContent = next ? "Unpin sidebar" : "Pin sidebar";
    pin?.setAttribute("title", next ? "Unpin sidebar" : "Pin sidebar open");
    markActive();
  }

  function isDesktop() {
    return window.matchMedia("(min-width: 961px)").matches;
  }

  function isSectionsOpen() {
    try {
      const stored = localStorage.getItem(SECTIONS_KEY);
      if (stored === "0") return false;
      if (stored === "1") return true;
    } catch {
      /* ignore */
    }
    return window.matchMedia("(min-width: 1280px)").matches;
  }

  function setSectionsOpen(open) {
    try {
      localStorage.setItem(SECTIONS_KEY, open ? "1" : "0");
    } catch {
      /* ignore quota */
    }
    document.documentElement.classList.toggle("app-sections-collapsed", !open);
    document.body.classList.toggle("app-sections-collapsed", !open);
    const drawer = document.getElementById("app-sections-drawer");
    drawer?.classList.toggle("is-collapsed", !open);
    const btn = drawer?.querySelector(".app-sections-toggle");
    btn?.setAttribute("aria-expanded", String(open));
    btn?.setAttribute("title", open ? "Collapse sections" : "Show sections");
    btn?.setAttribute("aria-label", open ? "Collapse sections" : "Show sections");
  }

  function initSectionDrawer() {
    if (document.getElementById("app-sections-drawer")) return;
    const navs = [
      ...document.querySelectorAll(
        "main.app-layout > .app-sections, main.app-layout > .settings-nav, main.settings-layout > .settings-nav, main.settings-layout > .settings-sidebar > .settings-nav, main.app-layout > .settings-sidebar > .settings-nav"
      ),
    ];
    if (!navs.length) return;

    const drawer = document.createElement("aside");
    drawer.id = "app-sections-drawer";
    drawer.className = "app-sections-drawer";
    drawer.innerHTML = `<div class="app-sections-head">
        <p class="app-sections-heading">Sections</p>
        <button type="button" class="app-sections-toggle" aria-expanded="true" title="Collapse sections" aria-label="Collapse sections">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
      </div>
      <div class="app-sections-body"></div>`;

    const bodyEl = drawer.querySelector(".app-sections-body");
    navs.forEach((nav) => {
      const title = nav.querySelector(".settings-nav-title");
      if (title && /^sections$/i.test((title.textContent || "").trim())) {
        title.hidden = true;
      }
      nav.querySelector('.settings-nav-item[data-section="notifications"]')?.setAttribute("hidden", "");
      bodyEl.appendChild(nav);
    });

    const topbar = document.querySelector("header.topbar");
    (topbar || document.getElementById("app-sidebar"))?.insertAdjacentElement("afterend", drawer);

    document.documentElement.classList.add("has-app-sections");
    document.body.classList.add("has-app-sections");

    drawer.querySelector(".app-sections-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setSectionsOpen(document.documentElement.classList.contains("app-sections-collapsed"));
    });
    drawer.addEventListener("click", () => {
      if (drawer.classList.contains("is-collapsed")) setSectionsOpen(true);
    });

    setSectionsOpen(isSectionsOpen());
  }

  function renderLink(link) {
    const file = link.file || fileFromHref(link.href);
    return `<a class="app-sidebar-link" href="${escapeHtml(link.href)}" data-nav-file="${escapeHtml(
      file
    )}" title="${escapeHtml(link.label)}">${iconSvg(link.icon)}<span class="app-sidebar-label">${escapeHtml(
      link.label
    )}</span></a>`;
  }

  function renderGroup(group) {
    const roleAttr = group.adminOnly ? ' data-role="admin-only"' : "";
    return `<div class="app-sidebar-group" data-group="${escapeHtml(group.id)}"${roleAttr}>
      <button type="button" class="app-sidebar-group-toggle" aria-expanded="false" title="${escapeHtml(group.label)}">
        ${iconSvg(group.icon)}
        <span class="app-sidebar-label">${escapeHtml(group.label)}</span>
        ${CHEVRON}
      </button>
      <div class="app-sidebar-group-body"><div class="app-sidebar-group-items">${group.links.map(renderLink).join("")}</div></div>
    </div>`;
  }

  function renderSidebarHtml() {
    return `<aside class="app-sidebar" id="app-sidebar" aria-label="Main navigation">
      <div class="app-sidebar-inner">
        <a class="app-sidebar-brand" href="dashboard.html">
          <span class="app-sidebar-brand-mark" aria-hidden="true"></span>
          <span class="app-sidebar-label app-sidebar-brand-text">
            <span class="app-sidebar-brand-name">Bishnupriya Fuels</span>
            <span class="app-sidebar-brand-meta">Authorized BPCL Dealer</span>
          </span>
        </a>
        <nav class="app-sidebar-nav" data-app-nav>
          ${NAV_GROUPS.map(renderGroup).join("")}
        </nav>
        <div class="app-sidebar-foot">
          <button type="button" class="app-sidebar-pin" aria-pressed="false" title="Pin sidebar open">
            <svg class="app-sidebar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 4v7.3l2 2V4h2v9.6l2.4 2.4-1.4 1.4L5.4 3.4 6.8 2l2.6 2.6H14zM5 20h14v2H5v-2z"/></svg>
            <span class="app-sidebar-label">Pin sidebar</span>
          </button>
        </div>
      </div>
    </aside>
    <div class="app-sidebar-backdrop" hidden></div>`;
  }

  function setSidebarOpen(open) {
    const toggle = document.querySelector(".topbar .nav-toggle");
    const backdrop = document.querySelector(".app-sidebar-backdrop");
    document.body.classList.toggle("app-sidebar-open", open);
    document.body.classList.toggle("topbar-nav-open", open);
    toggle?.setAttribute("aria-expanded", String(open));
    if (backdrop) backdrop.hidden = !open;
  }

  function syncBrandLogo() {
    const mark = document.querySelector(".app-sidebar-brand-mark");
    if (!mark) return;
    const logoSrc =
      (typeof window.AppConfig !== "undefined" &&
        (window.AppConfig.STATION_LOGO_LG_SRC ||
          window.AppConfig.STATION_LOGO_SRC ||
          window.AppConfig.BPCL_LOGO_SRC)) ||
      document.querySelector("header.topbar .brand-logo")?.getAttribute("src") ||
      "assets/logo-104.webp";
    let img = mark.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "Bishnupriya Fuels";
      img.className = "app-sidebar-logo";
      img.width = 80;
      img.height = 80;
      img.decoding = "async";
      mark.appendChild(img);
    }
    if (img.getAttribute("src") !== logoSrc) img.src = logoSrc;
  }

  function markActive(options = {}) {
    const sidebar = document.getElementById("app-sidebar");
    if (!sidebar) return;
    const file = currentFileName();

    sidebar.querySelectorAll(".app-sidebar-link").forEach((link) => {
      const current = link.getAttribute("data-nav-file") === file;
      link.classList.toggle("is-active", current);
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    sidebar.querySelectorAll(".app-sidebar-group").forEach((group) => {
      const current = Boolean(group.querySelector(".app-sidebar-link.is-active"));
      group.classList.toggle("is-current", current);
      if (options.deferOpen) {
        group.classList.remove("is-open");
        group.querySelector(".app-sidebar-group-toggle")?.setAttribute("aria-expanded", "false");
        return;
      }
      group.classList.toggle("is-open", current);
      group.querySelector(".app-sidebar-group-toggle")?.setAttribute("aria-expanded", String(current));
    });
  }

  function bindSidebar(sidebar) {
    sidebar.addEventListener("click", (e) => {
      const groupToggle = e.target.closest(".app-sidebar-group-toggle");
      if (groupToggle) {
        const group = groupToggle.closest(".app-sidebar-group");
        if (!group) return;
        const willOpen = !group.classList.contains("is-open");
        sidebar.querySelectorAll(".app-sidebar-group.is-open").forEach((other) => {
          if (other === group) return;
          other.classList.remove("is-open");
          other.querySelector(".app-sidebar-group-toggle")?.setAttribute("aria-expanded", "false");
        });
        group.classList.toggle("is-open", willOpen);
        groupToggle.setAttribute("aria-expanded", String(willOpen));
        return;
      }

      if (e.target.closest(".app-sidebar-link") && !isDesktop()) {
        setSidebarOpen(false);
      }
    });

    sidebar.querySelector(".app-sidebar-pin")?.addEventListener("click", () => {
      setPinned(!document.body.classList.contains("app-sidebar-pinned"));
    });
  }

  function bindShell() {
    const toggle = document.querySelector(".topbar .nav-toggle");
    const backdrop = document.querySelector(".app-sidebar-backdrop");

    toggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      setSidebarOpen(!document.body.classList.contains("app-sidebar-open"));
    });

    backdrop?.addEventListener("click", () => setSidebarOpen(false));

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("app-sidebar-open")) {
        setSidebarOpen(false);
      }
    });

    window.addEventListener("hashchange", markActive);
    window.addEventListener("resize", () => {
      if (isDesktop()) setSidebarOpen(false);
    });
  }

  function injectAppNav() {
    const topbar = document.querySelector("header.topbar");
    if (!topbar || document.getElementById("app-sidebar")) return;

    document.body.classList.add("has-app-sidebar");
    if (isPinned()) document.body.classList.add("app-sidebar-pinned");
    document.documentElement.classList.remove("app-sidebar-panel-open");
    document.body.classList.remove("app-sidebar-panel-open");

    topbar.insertAdjacentHTML("beforebegin", renderSidebarHtml());
    const sidebar = document.getElementById("app-sidebar");
    if (!sidebar) return;
    if (topbar.classList.contains("no-print")) sidebar.classList.add("no-print");

    bindSidebar(sidebar);
    bindShell();
    setPinned(isPinned());
    markActive({ deferOpen: true });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => markActive());
    });
    initSectionDrawer();
    syncPageLayer();
    syncBrandLogo();
    document.addEventListener("DOMContentLoaded", syncBrandLogo, { once: true });
    window.addEventListener("load", syncBrandLogo, { once: true });
  }

  window.AppNav = {
    markActive,
    setOpen: setSidebarOpen,
    syncBrandLogo,
    syncPageLayer,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectAppNav);
  } else {
    injectAppNav();
  }
})();
