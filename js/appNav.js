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
      '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 10.6 3.4 2-1 1.7-4.4-2.6V6h2z"/>',
    finance:
      '<path d="M4 6h16v2H4V6zm0 5h16v9H4v-9zm3 2v5h2v-5H7zm4 0v5h2v-5h-2zm4 0v5h2v-5h-2z"/>',
    hr: '<path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/>',
    admin:
      '<path d="M19.4 13a7.7 7.7 0 0 0 .1-1 7.7 7.7 0 0 0-.1-1l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 2h-6l-.3 2.9A7.4 7.4 0 0 0 7 6L4.5 5 2.5 8.5 4.6 10a7.7 7.7 0 0 0-.1 1 7.7 7.7 0 0 0 .1 1L2.5 13.6l2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L9 22h6l.3-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/>',
    dashboard:
      '<path d="M3 3h8v8H3V3zm10 0h8v5h-8V3zM3 13h8v8H3v-8zm10 7h8v-9h-8v9z"/>',
    meter: '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 11.2 4 2.3-.9 1.6L11 14V6h2z"/>',
    dsr: '<path d="M7 2h8l5 5v15H7V2zm8 1.5V8h4.5L15 3.5zM9 12h8v2H9v-2zm0 4h8v2H9v-2z"/>',
    flask:
      '<path d="M9 2h6v2h-1v5.6l5 8.4A2 2 0 0 1 17.2 21H6.8A2 2 0 0 1 5 18l5-8.4V4H9V2z"/>',
    tasks:
      '<path d="M9 3h6l1 2h4v16H4V5h4l1-2zm1.5 10.5-2-2 1.4-1.4 1.3 1.3 3.6-3.6 1.4 1.4-5 5.3z"/>',
    credit:
      '<path d="M3 6h18v12H3V6zm2 2v2h14V8H5zm0 4v4h6v-4H5z"/>',
    expenses:
      '<path d="M6 2h9l5 5v15H6V2zm9 1.8V8h4.2L15 3.8zM8 12h8v2H8v-2zm0 4h5v2H8v-2z"/>',
    closing:
      '<path d="M7 2h2v2h6V2h2v2h3v18H4V4h3V2zm13 6H4v12h16V8zM8 11h3v3H8v-3z"/>',
    billing:
      '<path d="M4 4h16v16H4V4zm3 3v2h10V7H7zm0 4v2h10v-2H7zm0 4v2h6v-2H7z"/>',
    attendance:
      '<path d="M12 1a10 10 0 1 0 10 10A10 10 0 0 0 12 1zm1 10.6 3.8 2.2-.9 1.6L11 13V5h2z"/>',
    salary:
      '<path d="M12 2C7 2 3 5.6 3 10s4 8 9 8 9-3.6 9-8-4-8-9-8zm0 3.2c2.8 0 5 1.8 5 4s-2.2 4-5 4-5-1.8-5-4 2.2-4 5-4zM7 19h10v3H7v-3z"/>',
    staff: '<path d="M9 11a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 9 11zm6.5 0A3 3 0 1 0 12.5 8a3 3 0 0 0 3 3zM9 13c-3 0-7 1.5-7 4.5V21h14v-3.5C16 14.5 12 13 9 13zm6.5 0c-.4 0-.9 0-1.4.1 1.7 1 2.9 2.4 2.9 4.4V21h7v-3c0-2.8-3.5-4.9-8.5-4.9z"/>',
    vault:
      '<path d="M4 4h16v16H4V4zm3 3v10h10V7H7zm3.5 2A3.5 3.5 0 1 1 7 12.5 3.5 3.5 0 0 1 10.5 9z"/>',
    letter:
      '<path d="M3 5h18v14H3V5zm9 7.5L5.6 8.2 4.4 9.8 12 15l7.6-5.2-1.2-1.6z"/>',
    analysis:
      '<path d="M4 19h16v2H4v-2zm1-7h3v6H5v-6zm5-4h3v10h-3V8zm5-4h3v14h-3V4z"/>',
    reports:
      '<path d="M6 2h9l5 5v15H6V2zm9 2v4h4l-4-4zM8 11h8v2H8v-2zm0 4h8v2H8v-2z"/>',
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
