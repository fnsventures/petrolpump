/**
 * Fill empty app topbar nav slots when HTML is served without build:html.
 * Production deploy runs build:html first, so nav is pre-rendered and this no-ops.
 */
(function () {
  const NAV_GROUPS = [
    {
      label: "Operations",
      links: [
        { href: "dashboard.html", label: "Dashboard" },
        { href: "meter-reading.html", label: "Meter Reading" },
        { href: "dsr.html", label: "DSR" },
      ],
    },
    {
      label: "Finance",
      links: [
        { href: "credit.html", label: "Credit" },
        { href: "expenses.html", label: "Expenses" },
        { href: "day-closing.html", label: "Day closing & short" },
        { href: "billing.html", label: "Billing" },
        { href: "invoices.html", label: "Invoices" },
      ],
    },
    {
      label: "HR",
      links: [
        { href: "attendance.html", label: "Attendance" },
        { href: "salary.html", label: "Salary" },
        { href: "staff.html", label: "Staff" },
      ],
    },
    {
      label: "Admin",
      adminOnly: true,
      links: [
        { href: "analysis.html", label: "Analysis" },
        { href: "reports.html", label: "Reports" },
        { href: "settings.html", label: "Settings" },
      ],
    },
  ];

  function renderNavHtml() {
    const blocks = NAV_GROUPS.map((group) => {
      const roleAttr = group.adminOnly ? ' data-role="admin-only"' : "";
      const links = group.links.map((link) => `<a href="${link.href}">${link.label}</a>`).join("\n            ");
      return `        <div class="nav-group-block"${roleAttr}>
          <span class="nav-group-label" tabindex="0" aria-haspopup="true" aria-expanded="false">${group.label}<span class="nav-chevron" aria-hidden="true"></span></span>
          <div class="nav-group" role="menu">
            ${links}
          </div>
        </div>`;
    }).join("\n");

    return `${blocks}
        <button id="logout-button" class="link nav-logout">Logout</button>`;
  }

  function injectAppNav() {
    const nav = document.querySelector("header.topbar [data-app-nav]");
    if (!nav || nav.querySelector(".nav-group-block")) return;
    nav.innerHTML = renderNavHtml();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectAppNav);
  } else {
    injectAppNav();
  }
})();
