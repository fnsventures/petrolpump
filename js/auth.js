/* global supabaseClient, AppCache, AppError, AppConfig */

const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginButton = document.getElementById("login-button");

const LANDING_BY_ROLE = {
  admin: "dashboard.html",
  supervisor: "dashboard.html",
};

const AVATAR_BUCKET = "user-avatars";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Generate cache key for user role
 */
function getRoleCacheKey(email) {
  return `staff_role_${email?.toLowerCase() ?? "unknown"}`;
}

/** Role from JWT metadata only — never used for authorization (DB is source of truth). */
function extractRoleFromJwt(source) {
  if (!source) return null;
  if (source.user_metadata?.role) return source.user_metadata.role;
  return source.user?.user_metadata?.role ?? null;
}

function resolveLanding(role) {
  if (!role) return "login.html?error=unprovisioned";
  return LANDING_BY_ROLE[role] ?? "dashboard.html";
}

function centerTopbarSubtitle() {
  if (typeof window.AppNav?.syncPageLayer === "function") {
    window.AppNav.syncPageLayer();
    return;
  }

  const topbar = document.querySelector("header.topbar");
  if (!topbar) return;

  const title = topbar.querySelector(".page-title-stack") || topbar.querySelector(".page-subtitle");
  if (!title || title.parentElement === topbar) return;

  const insertBefore =
    topbar.querySelector(".nav-toggle") ??
    topbar.querySelector(".topbar-actions") ??
    topbar.querySelector(".nav-wrap");
  topbar.insertBefore(title, insertBefore);
}

function enhanceTopbarBrand() {
  const topbar = document.querySelector("header.topbar");
  const brand = topbar?.querySelector(".brand");
  if (!brand || brand.querySelector(".brand-mark")) return;

  const link = brand.querySelector("a");
  const logoSrc =
    AppConfig.STATION_LOGO_LG_SRC || AppConfig.STATION_LOGO_SRC || AppConfig.BPCL_LOGO_SRC;
  if (!link || typeof AppConfig === "undefined" || !logoSrc) return;

  topbar?.classList.add("topbar--bpcl");

  const mark = document.createElement("span");
  mark.className = "brand-mark";
  const img = document.createElement("img");
  img.src = logoSrc;
  img.alt = "Bishnupriya Fuels";
  img.className = "brand-logo station-logo station-logo--sm";
  img.width = 44;
  img.height = 44;
  img.decoding = "async";
  mark.appendChild(img);

  const textWrap = document.createElement("div");
  textWrap.className = "brand-text";
  textWrap.appendChild(link);

  if (!brand.querySelector(".brand-dealer")) {
    const dealer = document.createElement("span");
    dealer.className = "brand-dealer";
    dealer.textContent = "Authorized BPCL Dealer";
    textWrap.appendChild(dealer);
  }

  brand.textContent = "";
  brand.appendChild(mark);
  brand.appendChild(textWrap);
  window.AppNav?.syncBrandLogo?.();
}

/** Normalize section panels to the day-closing #close header pattern. */
function normalizePanelHeaders() {
  const body = document.body;
  if (!body || body.dataset.panelHeadersNormalized) return;
  if (body.classList.contains("login-page") || body.classList.contains("landing-page")) {
    return;
  }
  if (!document.querySelector("header.topbar")) return;

  body.dataset.panelHeadersNormalized = "1";
  body.classList.add("app-page");

  document.querySelectorAll(".settings-panel.card").forEach((panel) => {
    if (panel.classList.contains("analysis-hero")) return;

    panel.classList.add("dashboard-card");

    const existingHead = panel.querySelector(
      ":scope > .panel-head, :scope > .dc-close-head, :scope > .card-head.snapshot-head, :scope > .reports-generate-intro"
    );
    if (existingHead) {
      existingHead.classList.add("panel-head");
      existingHead.querySelector("h2")?.classList.add("dashboard-section-title");
      existingHead.querySelectorAll("p.muted").forEach((p) => p.classList.add("panel-lead"));
      return;
    }

    const h2 = panel.querySelector(":scope > h2");
    if (!h2) return;

    const head = document.createElement("div");
    head.className = "panel-head";
    const copyWrap = document.createElement("div");

    h2.classList.add("dashboard-section-title");
    copyWrap.appendChild(h2);

    const muted = panel.querySelector(":scope > p.muted");
    if (muted) {
      muted.classList.add("panel-lead");
      copyWrap.appendChild(muted);
    }

    head.appendChild(copyWrap);
    panel.insertBefore(head, panel.firstChild);
  });

  document.querySelectorAll(".dsr-card .dsr-card-head").forEach((head) => {
    head.classList.add("panel-head");
    head.querySelector("h2")?.classList.add("dashboard-section-title");
    head.querySelectorAll("p.muted").forEach((p) => p.classList.add("panel-lead"));
  });
}

function navLinkMatchesCurrentPage(href) {
  const path = window.location.pathname;
  let currentFile = path.split("/").pop() || "";
  if (!currentFile || currentFile === "index.html") {
    currentFile = "dashboard.html";
  }

  const [linkFile, linkHashPart] = String(href || "").split("#");
  const linkHash = linkHashPart ? `#${linkHashPart}` : "";
  const currentHash = window.location.hash || "";

  if (!linkHash) {
    return linkFile === currentFile;
  }
  if (linkFile !== currentFile) return false;
  return linkHash === currentHash;
}

function markCurrentNavLink() {
  if (typeof window.AppNav?.markActive === "function") {
    window.AppNav.markActive();
  }

  document.querySelectorAll("header.topbar nav a").forEach((link) => {
    link.classList.remove("nav-active");
    link.removeAttribute("aria-current");
  });
  document.querySelectorAll(".nav-group-block.has-active").forEach((block) => {
    block.classList.remove("has-active");
  });

  document.querySelectorAll("header.topbar nav a[href]").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("//")) return;
    if (!navLinkMatchesCurrentPage(href)) return;
    link.classList.add("nav-active");
    link.setAttribute("aria-current", "page");
    link.closest(".nav-group-block")?.classList.add("has-active");
  });
}

function closeTopbarNavMenus() {
  if (typeof window.AppNav?.setOpen === "function") {
    window.AppNav.setOpen(false);
  }

  const nav = document.querySelector(".topbar .nav-wrap.collapsible");
  const toggle = document.querySelector(".topbar .nav-toggle");
  nav?.classList.remove("is-open");
  toggle?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("topbar-nav-open");

  document.querySelectorAll(".topbar .nav-group-block.is-open").forEach((block) => {
    block.classList.remove("is-open");
    block.querySelector(".nav-group-label")?.setAttribute("aria-expanded", "false");
  });

  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".topbar .nav-wrap, .app-sidebar")) {
    active.blur();
  }
}

/**
 * Normalize email for staff/role lookups (staff table stores lowercase).
 */
function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}

/**
 * Fetch role from users table with caching.
 * Uses stale-while-revalidate pattern for fast role lookup.
 */
const roleFetchGuard = typeof createRequestGuard === "function" ? createRequestGuard() : null;

async function fetchRoleFromStaff(email) {
  const loadId = roleFetchGuard ? roleFetchGuard.next() : 0;
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const cacheKey = getRoleCacheKey(email);

  const fetchFn = async () => {
    const { data, error } = await supabaseClient
      .from("users")
      .select("role, display_name, avatar_url")
      .eq("email", normalized)
      .maybeSingle();
    if (error) {
      AppError.report(error, { context: "fetchRoleFromUsers" });
      return null;
    }
    return data
      ? {
          role: data.role ?? null,
          display_name: data.display_name?.trim() || null,
          avatar_url: data.avatar_url?.trim() || null,
        }
      : null;
  };

  // Use caching if available
  if (typeof AppCache !== "undefined" && AppCache) {
    const result = await AppCache.getWithSWR(cacheKey, fetchFn, "user_role");
    if (roleFetchGuard && !roleFetchGuard.isCurrent(loadId)) return null;
    return result;
  }

  const result = await fetchFn();
  if (roleFetchGuard && !roleFetchGuard.isCurrent(loadId)) return null;
  return result;
}

async function resolveAuthForSession(session) {
  if (!session) return { role: null, display_name: null, avatar_url: null };
  const email = session.user?.email;
  const cached = await fetchRoleFromStaff(email);
  if (cached?.role) {
    return {
      role: cached.role,
      display_name: cached.display_name,
      avatar_url: cached.avatar_url ?? null,
    };
  }
  return {
    role: null,
    display_name: cached?.display_name ?? null,
    avatar_url: cached?.avatar_url ?? null,
  };
}

async function resolveRoleForSession(session) {
  const auth = await resolveAuthForSession(session);
  return auth.role;
}

/**
 * Clear cached role for a user (call after role changes)
 */
function invalidateUserRoleCache(email) {
  if (typeof AppCache !== "undefined" && AppCache && email) {
    AppCache.remove(getRoleCacheKey(email));
  }
}

function unwrapLegacyNavUser(topbar) {
  const navUser = topbar.querySelector(".nav-user");
  if (!navUser) return;
  navUser.remove();
}

/** Restore flat topbar structure (undo prior inner/actions wrappers). */
function restoreTopbarStructure(topbar) {
  unwrapLegacyNavUser(topbar);

  const inner = topbar.querySelector(".topbar-inner");
  if (inner) {
    [...inner.children].forEach((node) => topbar.insertBefore(node, inner));
    inner.remove();
  }

  const actions = topbar.querySelector(".topbar-actions");
  if (actions && !actions.querySelector(".topbar-icon-btn")) {
    [...actions.children].forEach((node) => topbar.insertBefore(node, actions));
    actions.remove();
  }
  topbar.querySelectorAll(".topbar-account").forEach((el) => el.remove());

  const legacyLogout = topbar.querySelector("#logout-button:not(.topbar-user-menu-item)");
  if (legacyLogout) legacyLogout.remove();
}

let topbarUserMenuBound = false;

function closeTopbarUserMenu() {
  const dropdown = document.getElementById("topbar-user-dropdown");
  const toggle = document.getElementById("topbar-user-menu-toggle");
  dropdown?.classList.add("hidden");
  toggle?.setAttribute("aria-expanded", "false");
  closeTopbarProfilePanel();
}

function closeTopbarNotifications() {
  const popup = document.getElementById("topbar-notifications-popup");
  const toggle = document.getElementById("topbar-notifications");
  popup?.classList.add("hidden");
  toggle?.setAttribute("aria-expanded", "false");
  toggle?.classList.remove("is-active");
}

function openTopbarNotifications() {
  closeTopbarUserMenu();
  closeTopbarHelp();
  const popup = document.getElementById("topbar-notifications-popup");
  const toggle = document.getElementById("topbar-notifications");
  if (!popup || !toggle) return;
  popup.classList.remove("hidden");
  toggle.setAttribute("aria-expanded", "true");
  toggle.classList.add("is-active");
  window.AppNotifications?.mount?.();
}

function openNotificationsIfRequested() {
  const hash = String(location.hash || "").replace(/^#/, "").split("?")[0];
  if (hash !== "notifications") return;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  openTopbarNotifications();
}

function toggleTopbarNotifications() {
  const popup = document.getElementById("topbar-notifications-popup");
  if (!popup || popup.classList.contains("hidden")) openTopbarNotifications();
  else closeTopbarNotifications();
}

window.TopbarNotifications = {
  open: openTopbarNotifications,
  close: closeTopbarNotifications,
  toggle: toggleTopbarNotifications,
};

const PAGE_HELP = {
  "dashboard.html": {
    title: "Dashboard",
    why: "Start here each shift. It shows whether yesterday’s sales, stock, and alerts are in a healthy state before you enter new work.",
    contains: [
      "Daily snapshot of sales, dips, and outstanding work",
      "DSR summary and, for admins, net profit",
      "Header notifications for overdue closings, stock, payroll, and tasks",
    ],
    how: [
      "Pick the snapshot date, then scan sales and fuel cards first.",
      "Open Notifications in the header if the badge is greater than zero.",
      "Use the sections rail to switch Snapshot, DSR summary, or Net profit.",
    ],
  },
  "meter-reading.html": {
    title: "Meter Reading",
    why: "Meter readings are the source of truth for litres sold. Accurate shift and purchase entries keep DSR, stock, and profit correct.",
    contains: [
      "Shift opening and closing meter readings by pump",
      "Purchase / buying-price entries",
      "Testing, density, and related fuel movement",
    ],
    how: [
      "Enter shift readings in order: opening, then closing.",
      "Save each nozzle before moving on so litres post to DSR.",
      "Add buying price on receipt days so profit calculations can run.",
    ],
  },
  "dsr.html": {
    title: "Daily Sales Report",
    why: "DSR is the official daily sales picture for the outlet. Use it to verify volume, value, and product mix before day closing.",
    contains: ["Petrol and diesel sales by pump", "Totals for the selected date", "Printable DSR layout"],
    how: [
      "Select the date and review each product block.",
      "Compare litres with meter reading if a figure looks off.",
      "Print only after the day’s readings are complete.",
    ],
  },
  "e20-register.html": {
    title: "E-20 testing",
    why: "BPCL requires ethanol-blend checks. This register is the station’s compliance log for E-20 testing.",
    contains: ["Test entries by date", "Observed results and remarks", "Printable register"],
    how: [
      "Log each test as soon as it is done on the forecourt.",
      "Keep density and temperature fields complete.",
      "Print the register when the oil company or inspector asks.",
    ],
  },
  "reminders.html": {
    title: "Tasks",
    why: "Tasks catch work that is not a daily meter entry: follow-ups, statutory jobs, and station to-dos.",
    contains: ["Open and completed tasks", "Due dates and owners", "Links from dashboard notifications"],
    how: [
      "Add a task with a due date whenever work must not be forgotten.",
      "Mark complete only after the action is actually done.",
      "Check this list at the start of the shift if the header badge is up.",
    ],
  },
  "credit.html": {
    title: "Credit",
    why: "Credit sales and collections drive cash and overdue risk. This is the ledger for customers who lift fuel on account.",
    contains: ["Credit customers and balances", "New credit sales and receipts", "Ageing / overdue view"],
    how: [
      "Record a credit sale against the correct customer and vehicle if asked.",
      "Post collections the same day cash or UPI is received.",
      "Open a customer to see history before increasing their limit.",
    ],
  },
  "credit-customer.html": {
    title: "Credit customer",
    why: "One customer’s statement: what they lifted, what they paid, and what is still due.",
    contains: ["Customer profile", "Invoice and receipt history", "Running balance"],
    how: [
      "Confirm identity and outstanding before recording a new lift.",
      "Use the statement when the customer asks for a balance.",
      "Return to Credit to switch customers.",
    ],
  },
  "credit-overdue.html": {
    title: "Credit overdue",
    why: "Overdue ageing shows who is slipping past agreed credit days so collections can be chased.",
    contains: ["Customers past due", "Age buckets", "Amounts outstanding"],
    how: [
      "Start with the oldest bucket.",
      "Call or visit, then record any collection in Credit.",
      "Re-check this list after receipts post.",
    ],
  },
  "expenses.html": {
    title: "Expenses",
    why: "Station expenses (power, wages extras, stores, repairs) must be logged so day closing and profit stay honest.",
    contains: ["Expense entries by date and category", "Notes and amounts", "Totals for the selected range"],
    how: [
      "Add an expense the day it is paid, with a clear category.",
      "Attach a remark for unusual amounts.",
      "Review the range total before certifying day closing.",
    ],
  },
  "day-closing.html": {
    title: "Day closing & short",
    why: "Day closing certifies the day’s cash, short/excess, and whether the books can be locked. Treat it as the daily sign-off.",
    contains: ["Cash, card, UPI, and credit split", "Short / excess against expected cash", "Certification / lock status"],
    how: [
      "Complete meter reading, DSR, expenses, and credit first.",
      "Count cash and enter the actual tendered amounts.",
      "Certify only when short/excess is explained.",
    ],
  },
  "billing.html": {
    title: "Billing",
    why: "Billing produces customer invoices for credit or bulk lifts that need a GST-ready document.",
    contains: ["Invoice drafts and issued bills", "Customer and product lines", "Print / share views"],
    how: [
      "Select the customer and add fuel or other lines.",
      "Check rate, quantity, and tax before issuing.",
      "Print or send only after the invoice is saved.",
    ],
  },
  "attendance.html": {
    title: "Attendance",
    why: "Attendance feeds salary and shift staffing. Missing marks create payroll disputes later.",
    contains: ["Daily presence by employee", "Leave / off marks", "Month view"],
    how: [
      "Mark the roster at the start or end of each shift.",
      "Correct a day the same day if someone was marked wrongly.",
      "Use Staff if an employee is missing from the list.",
    ],
  },
  "salary.html": {
    title: "Salary",
    why: "Salary turns attendance and pay rules into slips. Admins use it to process the month without spreadsheet drift.",
    contains: ["Monthly payroll", "Earnings and deductions", "Printable salary slips"],
    how: [
      "Confirm attendance is complete for the month first.",
      "Review each employee’s slip before payout.",
      "Print slips after the run is saved.",
    ],
  },
  "staff.html": {
    title: "Staff",
    why: "The employee master: who can log in, their role, and ID details used by attendance and salary.",
    contains: ["Staff roster", "Role and contact details", "ID card print"],
    how: [
      "Add a person before they need attendance or a login.",
      "Keep role accurate (admin vs supervisor vs operator).",
      "Print ID cards from this page when hiring.",
    ],
  },
  "invoices.html": {
    title: "Vault",
    why: "Vault stores official documents (invoices, letters, scans) so the station is not hunting paper during audits.",
    contains: ["Uploaded files", "Folders / tags", "Download access"],
    how: [
      "Upload a copy the day a document arrives.",
      "Name files with date and vendor so search works.",
      "Do not delete originals until the digital copy is verified.",
    ],
  },
  "letterhead.html": {
    title: "Letter Desk",
    why: "Official station letters on BPCL letterhead: notices, certificates, and correspondence.",
    contains: ["Compose on letterhead", "Saved history", "Print layout"],
    how: [
      "Pick a template or blank letter, then fill the body.",
      "Preview before print so margins and logo sit correctly.",
      "Save a copy to history for the record.",
    ],
  },
  "analysis.html": {
    title: "Analysis",
    why: "Admin-only trends: volume, margin, and exceptions over a range, not just one day.",
    contains: ["Charts and comparisons", "Product and period filters", "Profit / purchase checks"],
    how: [
      "Set the date range before reading any chart.",
      "Drill into a dip by opening DSR or Meter Reading for that day.",
      "Fix missing buying prices if profit looks empty.",
    ],
  },
  "reports.html": {
    title: "Reports",
    why: "Printable statutory and management reports for a chosen period.",
    contains: ["Report catalog", "Date filters", "Print / export views"],
    how: [
      "Choose the report, then the from–to dates.",
      "Generate and scan totals before printing.",
      "Use print only on a complete date range.",
    ],
  },
  "settings.html": {
    title: "Settings",
    why: "Station configuration: users, pumps, rates, and rules. Wrong settings corrupt every other page.",
    contains: ["Users and roles", "Pump and product setup", "Operating preferences"],
    how: [
      "Change one section at a time and save.",
      "Add users only after you know their role.",
      "Do not edit historical rates unless you intend to restated figures.",
    ],
  },
  "sales-daily.html": {
    title: "Daily sales",
    why: "A focused daily sales view when you need litres and value without the full dashboard.",
    contains: ["Sales by product for a date", "Links back to DSR / meters"],
    how: [
      "Select the date.",
      "If a number is wrong, correct it in Meter Reading, not here.",
      "Return to Dashboard for alerts and snapshot context.",
    ],
  },
};

function currentHelpPage() {
  const file = (window.location.pathname.split("/").pop() || "").split("?")[0];
  if (!file || file === "index.html") return "dashboard.html";
  return file;
}

function renderHelpHtml(entry) {
  const why = `<section class="topbar-help-section"><h3>Why this page</h3><p>${entry.why}</p></section>`;
  const contains = `<section class="topbar-help-section"><h3>What it contains</h3><ul>${entry.contains
    .map((item) => `<li>${item}</li>`)
    .join("")}</ul></section>`;
  const how = `<section class="topbar-help-section"><h3>How to use it</h3><ul>${entry.how
    .map((item) => `<li>${item}</li>`)
    .join("")}</ul></section>`;
  return why + contains + how;
}

function fillTopbarHelp() {
  const entry = PAGE_HELP[currentHelpPage()] || {
    title: "This page",
    why: "Use the menus on the left to move between Operations, Finance, HR, and Admin. Each screen is built for one station job.",
    contains: ["The live record for this task", "Filters and dates where needed", "Print views when the page supports them"],
    how: ["Read the on-screen labels before saving.", "Complete earlier steps (for example meter reading) before day closing.", "Open Help again after you switch pages — the guide follows the screen."],
  };
  const title = document.getElementById("topbar-help-title");
  const body = document.getElementById("topbar-help-body");
  if (title) title.textContent = entry.title;
  if (body) body.innerHTML = renderHelpHtml(entry);
}

function closeTopbarHelp() {
  const popup = document.getElementById("topbar-help-popup");
  const toggle = document.getElementById("topbar-help");
  popup?.classList.add("hidden");
  toggle?.setAttribute("aria-expanded", "false");
  toggle?.classList.remove("is-active");
}

function openTopbarHelp() {
  closeTopbarUserMenu();
  closeTopbarNotifications();
  fillTopbarHelp();
  const popup = document.getElementById("topbar-help-popup");
  const toggle = document.getElementById("topbar-help");
  if (!popup || !toggle) return;
  popup.classList.remove("hidden");
  toggle.setAttribute("aria-expanded", "true");
  toggle.classList.add("is-active");
}

function toggleTopbarHelp() {
  const popup = document.getElementById("topbar-help-popup");
  if (!popup || popup.classList.contains("hidden")) openTopbarHelp();
  else closeTopbarHelp();
}

function closeTopbarProfilePanel() {
  document.getElementById("topbar-profile-panel")?.setAttribute("hidden", "");
}

function avatarStorageFolder(email) {
  return normalizeEmail(email).replace(/[^a-z0-9._-]/g, "_");
}

function avatarExtensionFromFile(file) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function applyTopbarAvatarDisplay(avatarUrl, labelSource) {
  const toggle = document.getElementById("topbar-user-menu-toggle");
  let photo = document.getElementById("topbar-user-photo");
  const initials = document.getElementById("topbar-user-initials");
  const removeBtn = document.getElementById("topbar-avatar-remove");
  if (!initials || !toggle) return;

  const initial =
    typeof getAvatarInitial === "function"
      ? getAvatarInitial(labelSource)
      : String(labelSource ?? "?").charAt(0).toUpperCase();

  if (avatarUrl) {
    if (!photo) {
      photo = document.createElement("img");
      photo.id = "topbar-user-photo";
      photo.className = "topbar-user-photo";
      photo.alt = "";
      (initials.parentElement || toggle).insertBefore(photo, initials);
    }
    photo.src = avatarUrl;
    photo.classList.remove("hidden");
    initials.classList.add("hidden");
    removeBtn?.classList.remove("hidden");
  } else {
    if (photo) {
      photo.classList.add("hidden");
      photo.removeAttribute("src");
    }
    initials.textContent = initial || "?";
    initials.classList.remove("hidden");
    removeBtn?.classList.add("hidden");
  }
}

function setProfilePanelStatus(message, type = "") {
  const status = document.getElementById("topbar-avatar-status");
  if (!status) return;
  if (!message) {
    status.textContent = "";
    status.className = "topbar-profile-status hidden";
    return;
  }
  status.textContent = message;
  status.className = `topbar-profile-status${type ? ` is-${type}` : ""}`;
  status.classList.remove("hidden");
}

async function uploadUserAvatar(file, session) {
  if (!session?.user?.email) throw new Error("Not signed in");
  if (!AVATAR_MIME_TYPES.has(file.type)) {
    throw new Error("Use a JPG, PNG, or WebP image.");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("Image must be 2 MB or smaller.");
  }

  const folder = avatarStorageFolder(session.user.email);
  const ext = avatarExtensionFromFile(file);
  const path = `${folder}/avatar.${ext}`;

  const { error: uploadError } = await supabaseClient.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type, cacheControl: "3600" });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabaseClient.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const publicUrl = `${urlData.publicUrl}?v=${Date.now()}`;

  const { error: rpcError } = await supabaseClient.rpc("update_my_avatar", {
    p_avatar_url: publicUrl,
  });
  if (rpcError) throw rpcError;

  invalidateUserRoleCache(session.user.email);
  return publicUrl;
}

async function removeUserAvatar(session) {
  if (!session?.user?.email) throw new Error("Not signed in");

  const folder = avatarStorageFolder(session.user.email);
  await supabaseClient.storage.from(AVATAR_BUCKET).remove([
    `${folder}/avatar.jpg`,
    `${folder}/avatar.png`,
    `${folder}/avatar.webp`,
  ]);

  const { error: rpcError } = await supabaseClient.rpc("update_my_avatar", {
    p_avatar_url: null,
  });
  if (rpcError) throw rpcError;

  invalidateUserRoleCache(session.user.email);
}

function initTopbarUserMenuHandlers() {
  if (topbarUserMenuBound) return;
  topbarUserMenuBound = true;

  document.addEventListener("click", (e) => {
    if (e.target.closest("#topbar-help")) {
      e.preventDefault();
      toggleTopbarHelp();
      return;
    }

    if (!e.target.closest("#topbar-help-wrap")) {
      closeTopbarHelp();
    }

    if (e.target.closest("#topbar-notifications")) {
      e.preventDefault();
      toggleTopbarNotifications();
      return;
    }

    if (!e.target.closest("#topbar-notifications-wrap")) {
      closeTopbarNotifications();
    }

    const menu = document.getElementById("topbar-user-menu");
    if (!menu) return;

    if (e.target.closest("[data-action='logout'], #logout-button")) {
      e.preventDefault();
      closeTopbarUserMenu();
      handleLogout();
      return;
    }

    if (e.target.closest("[data-action='profile-toggle']")) {
      e.preventDefault();
      const panel = document.getElementById("topbar-profile-panel");
      if (!panel) return;
      const isHidden = panel.hasAttribute("hidden");
      if (isHidden) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      return;
    }

    if (e.target.closest("#topbar-user-menu-toggle")) {
      e.preventDefault();
      const dropdown = document.getElementById("topbar-user-dropdown");
      const toggle = document.getElementById("topbar-user-menu-toggle");
      if (!dropdown || !toggle) return;
      const isHidden = dropdown.classList.toggle("hidden");
      toggle.setAttribute("aria-expanded", String(!isHidden));
      if (!isHidden) {
        closeTopbarNavMenus();
        closeTopbarNotifications();
        closeTopbarHelp();
      }
      return;
    }

    if (!menu.contains(e.target)) {
      closeTopbarUserMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTopbarUserMenu();
      closeTopbarNotifications();
      closeTopbarHelp();
    }
  });

  document.getElementById("topbar-avatar-input")?.addEventListener("change", async (e) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    setProfilePanelStatus("Uploading…");
    try {
      const {
        data: { session },
      } = await supabaseClient.auth.getSession();
      const url = await uploadUserAvatar(file, session);
      await updateTopbarUserProfile(session);
      setProfilePanelStatus("Photo updated.", "success");
    } catch (err) {
      AppError.report(err, { context: "uploadUserAvatar" });
      setProfilePanelStatus(err.message || "Upload failed.", "error");
    }
  });

  document.getElementById("topbar-avatar-remove")?.addEventListener("click", async () => {
    setProfilePanelStatus("Removing…");
    try {
      const {
        data: { session },
      } = await supabaseClient.auth.getSession();
      await removeUserAvatar(session);
      await updateTopbarUserProfile(session);
      setProfilePanelStatus("Photo removed.", "success");
    } catch (err) {
      AppError.report(err, { context: "removeUserAvatar" });
      setProfilePanelStatus(err.message || "Could not remove photo.", "error");
    }
  });
}

function placeTopbarUserMenu(topbar, menu) {
  const actions = topbar.querySelector(".topbar-actions");
  if (actions) {
    if (menu.parentElement !== actions) actions.appendChild(menu);
    return;
  }
  const nav = topbar.querySelector(".nav-wrap");
  /* Keep avatar outside .nav-wrap so it stays visible when the hamburger menu is collapsed */
  if (nav?.parentElement === topbar) {
    if (menu.parentElement !== topbar || menu.previousElementSibling !== nav) {
      topbar.insertBefore(menu, nav.nextSibling);
    }
  } else if (menu.parentElement !== topbar) {
    topbar.appendChild(menu);
  }
}

function ensureTopbarUserIdentity(toggle) {
  let avatar = toggle.querySelector(".topbar-user-avatar");
  if (!avatar) {
    avatar = document.createElement("span");
    avatar.className = "topbar-user-avatar";
    const photo = toggle.querySelector("#topbar-user-photo");
    const initials = toggle.querySelector("#topbar-user-initials");
    if (photo) avatar.appendChild(photo);
    if (initials) avatar.appendChild(initials);
    toggle.insertBefore(avatar, toggle.firstChild);
  }

  if (toggle.querySelector(".topbar-user-identity")) return;
  const identity = document.createElement("span");
  identity.className = "topbar-user-identity";
  identity.innerHTML =
    '<span class="topbar-user-identity-name" id="topbar-user-identity-name"></span>' +
    '<span class="topbar-user-identity-role" id="topbar-user-identity-role"></span>';
  toggle.appendChild(identity);
}

function ensureTopbarActions(topbar) {
  let actions = topbar.querySelector(".topbar-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "topbar-actions";
  }

  if (!document.getElementById("topbar-help-wrap")) {
    const wrap = document.createElement("div");
    wrap.className = "topbar-help";
    wrap.id = "topbar-help-wrap";
    wrap.innerHTML = `
      <button type="button" class="topbar-icon-btn" id="topbar-help" aria-expanded="false" aria-haspopup="dialog" aria-controls="topbar-help-popup" title="Help" aria-label="Help for this page">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M9.6 9.4a2.5 2.5 0 0 1 4.8.8c0 1.5-2.4 2-2.4 3.4"/><circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none"/></svg>
      </button>
      <div class="topbar-help-popup hidden" id="topbar-help-popup" role="dialog" aria-labelledby="topbar-help-title">
        <div class="topbar-help-head">
          <p class="topbar-help-kicker">Page guide</p>
          <p class="topbar-help-title" id="topbar-help-title">Help</p>
        </div>
        <div class="topbar-help-body" id="topbar-help-body"></div>
      </div>`;
    actions.appendChild(wrap);
    fillTopbarHelp();
  }

  if (!document.getElementById("topbar-notifications-wrap")) {
    const wrap = document.createElement("div");
    wrap.className = "topbar-notifications";
    wrap.id = "topbar-notifications-wrap";
    wrap.innerHTML = `
      <button type="button" class="topbar-icon-btn" id="topbar-notifications" aria-expanded="false" aria-haspopup="dialog" aria-controls="topbar-notifications-popup" title="Notifications" aria-label="Notifications">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 9.2a5.8 5.8 0 0 1 11.6 0c0 3.6 1.5 5.4 2.2 6.3H4c.7-.9 2.2-2.7 2.2-6.3Z"/><path stroke-linecap="round" d="M10 18.6a2 2 0 0 0 4 0"/></svg>
        <span id="notifications-nav-badge" class="notifications-nav-badge hidden" aria-hidden="true">0</span>
      </button>
      <div class="topbar-notifications-popup hidden" id="topbar-notifications-popup" role="dialog" aria-label="Notifications">
        <div class="topbar-notifications-head">
          <p class="topbar-notifications-title">Notifications</p>
        </div>
        <div class="topbar-notifications-body" id="topbar-notifications-body">
          <div class="topbar-notifications-fallback" id="topbar-notifications-fallback">
            <p class="topbar-notifications-fallback-title">Loading alerts…</p>
            <p class="topbar-notifications-fallback-copy muted">Fetching reminders, day closing, stock, payroll, and invoice alerts.</p>
          </div>
        </div>
      </div>`;
    actions.appendChild(wrap);
  }

  const menu = topbar.querySelector(".topbar-user-menu");
  if (menu && menu.parentElement !== actions) actions.appendChild(menu);
  if (actions.parentElement !== topbar) topbar.appendChild(actions);
}

function ensureTopbarUserMenu() {
  const topbar = document.querySelector("header.topbar");
  if (!topbar) return null;

  restoreTopbarStructure(topbar);

  let menu = topbar.querySelector(".topbar-user-menu");
  if (menu) {
    const toggle = menu.querySelector("#topbar-user-menu-toggle");
    if (toggle) ensureTopbarUserIdentity(toggle);
    ensureTopbarActions(topbar);
    placeTopbarUserMenu(topbar, menu);
    initTopbarUserMenuHandlers();
    return menu;
  }

  menu = document.createElement("div");
  menu.className = "topbar-user-menu";
  menu.id = "topbar-user-menu";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "topbar-user-menu-toggle";
  toggle.id = "topbar-user-menu-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-label", "Account menu");
  const photoEl = document.createElement("img");
  photoEl.className = "topbar-user-photo hidden";
  photoEl.id = "topbar-user-photo";
  photoEl.alt = "";

  const initialsEl = document.createElement("span");
  initialsEl.className = "topbar-user-initials";
  initialsEl.id = "topbar-user-initials";
  initialsEl.textContent = "?";
  toggle.append(photoEl, initialsEl);
  ensureTopbarUserIdentity(toggle);

  const dropdown = document.createElement("div");
  dropdown.className = "topbar-user-dropdown hidden";
  dropdown.id = "topbar-user-dropdown";
  dropdown.setAttribute("role", "menu");

  const head = document.createElement("div");
  head.className = "topbar-user-dropdown-head";
  const nameEl = document.createElement("span");
  nameEl.className = "topbar-user-dropdown-name";
  nameEl.id = "topbar-user-name";
  nameEl.textContent = "Operator";
  const emailEl = document.createElement("span");
  emailEl.className = "topbar-user-dropdown-email";
  emailEl.id = "topbar-user-email";
  const roleEl = document.createElement("span");
  roleEl.className = "topbar-user-dropdown-role";
  roleEl.id = "topbar-user-role";
  head.append(nameEl, emailEl, roleEl);

  const profileBtn = document.createElement("button");
  profileBtn.type = "button";
  profileBtn.className = "topbar-user-menu-item";
  profileBtn.id = "topbar-profile-link";
  profileBtn.setAttribute("data-action", "profile-toggle");
  profileBtn.setAttribute("role", "menuitem");
  profileBtn.textContent = "Profile";

  const profilePanel = document.createElement("div");
  profilePanel.className = "topbar-profile-panel";
  profilePanel.id = "topbar-profile-panel";
  profilePanel.hidden = true;
  profilePanel.innerHTML = `
    <p class="topbar-profile-hint">Upload a profile photo (JPG, PNG or WebP, max 2 MB).</p>
    <label class="topbar-profile-upload">
      <input type="file" id="topbar-avatar-input" accept="image/jpeg,image/png,image/webp" hidden />
      Choose photo
    </label>
    <button type="button" class="topbar-profile-remove hidden" id="topbar-avatar-remove">Remove photo</button>
    <p class="topbar-profile-status hidden" id="topbar-avatar-status"></p>
  `;

  const logoutBtn = document.createElement("button");
  logoutBtn.type = "button";
  logoutBtn.className = "topbar-user-menu-item topbar-user-menu-item--logout";
  logoutBtn.id = "logout-button";
  logoutBtn.setAttribute("data-action", "logout");
  logoutBtn.setAttribute("role", "menuitem");
  logoutBtn.textContent = "Logout";

  dropdown.append(head, profileBtn, profilePanel, logoutBtn);
  menu.append(toggle, dropdown);
  ensureTopbarActions(topbar);
  placeTopbarUserMenu(topbar, menu);

  initTopbarUserMenuHandlers();
  return menu;
}

async function handleLogout() {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  const email = session?.user?.email;

  await supabaseClient.auth.signOut();

  if (email) {
    invalidateUserRoleCache(email);
  }
  if (typeof clearApiCaches === "function") {
    await clearApiCaches();
  }

  window.location.href = "index.html";
}

function resolveOperatorDisplayName(email, displayName) {
  const trimmed = displayName?.trim();
  if (trimmed) return trimmed;
  if (typeof formatEmailLocalLabel === "function") {
    const fromEmail = formatEmailLocalLabel(email);
    if (fromEmail) return fromEmail;
  }
  const local = String(email ?? "").split("@")[0] ?? "";
  return local || "Operator";
}

/**
 * Update compact topbar avatar and account dropdown labels.
 * @param {import('@supabase/supabase-js').Session|null} session
 * @param {{ role?: string, display_name?: string|null }|null} [auth]
 */
async function updateTopbarUserProfile(session, auth = null) {
  if (!document.querySelector("header.topbar")) return;

  ensureTopbarUserMenu();

  const initialsEl = document.getElementById("topbar-user-initials");
  const nameEl = document.getElementById("topbar-user-name");
  const emailEl = document.getElementById("topbar-user-email");
  const roleEl = document.getElementById("topbar-user-role");
  const identityName = document.getElementById("topbar-user-identity-name");
  const identityRole = document.getElementById("topbar-user-identity-role");
  const toggle = document.getElementById("topbar-user-menu-toggle");
  if (!initialsEl || !nameEl || !emailEl || !roleEl) return;

  if (!session?.user) {
    applyTopbarAvatarDisplay(null, "?");
    nameEl.textContent = "Operator";
    emailEl.textContent = "";
    roleEl.textContent = "";
    if (identityName) identityName.textContent = "Operator";
    if (identityRole) identityRole.textContent = "";
    toggle?.setAttribute("title", "Account");
    return;
  }

  const email = session.user.email ?? "";
  const resolved = auth ?? (await resolveAuthForSession(session));
  const role = resolved.role;
  const displayName = resolveOperatorDisplayName(email, resolved.display_name);
  const labelSource = resolved.display_name?.trim() || email;

  applyTopbarAvatarDisplay(resolved.avatar_url, labelSource);
  nameEl.textContent = displayName;
  emailEl.textContent = email;
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : "";
  roleEl.textContent = roleLabel;
  if (identityName) identityName.textContent = displayName;
  if (identityRole) identityRole.textContent = roleLabel;
  toggle?.setAttribute("title", `${displayName}${roleLabel ? ` · ${roleLabel}` : ""}`);
}

async function initTopbarUserProfile() {
  if (!document.querySelector("header.topbar")) return;
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  await updateTopbarUserProfile(session);
}

document.addEventListener("DOMContentLoaded", async () => {
  if (window.configPromise) await window.configPromise;
  const path = window.location.pathname || "";
  if (path.includes("login")) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "unprovisioned" && loginError) {
      loginError.textContent =
        "Your account is not set up yet. Ask an administrator to add you in Settings → Users & roles.";
      loginError.classList.remove("hidden");
    }
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (session) {
      const role = await resolveRoleForSession(session);
      if (role) {
        window.location.href = resolveLanding(role);
        return;
      }
      await window.supabaseClient.auth.signOut();
    }
  }
  ensureTopbarUserMenu();
  centerTopbarSubtitle();
  enhanceTopbarBrand();
  normalizePanelHeaders();
  markCurrentNavLink();
  window.addEventListener("hashchange", markCurrentNavLink);
  initNavToggle();
  const cachedRole =
    typeof window.readCachedUserRole === "function" ? window.readCachedUserRole() : null;
  if (cachedRole) {
    applyRoleVisibility(cachedRole);
  }
  await initTopbarUserProfile();
  if (typeof window.AppNotifications?.mount === "function") {
    void window.AppNotifications.mount();
  } else {
    const fallbackTitle = document.querySelector("#topbar-notifications-fallback .topbar-notifications-fallback-title");
    const fallbackCopy = document.querySelector("#topbar-notifications-fallback .topbar-notifications-fallback-copy");
    if (fallbackTitle) fallbackTitle.textContent = "Alerts unavailable";
    if (fallbackCopy) fallbackCopy.textContent = "Refresh the page, then open Notifications again.";
  }
  openNotificationsIfRequested();
  window.addEventListener("hashchange", openNotificationsIfRequested);
});

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError?.classList.add("hidden");

    if (window.configPromise) await window.configPromise;

    if (typeof window.isAppConfigValid === "function" && !window.isAppConfigValid()) {
      if (loginError) {
        loginError.textContent =
          (typeof window.getAppConfigErrorMessage === "function"
            ? await window.getAppConfigErrorMessage()
            : null) ||
          "Server configuration is missing. Set up js/env.js (see js/env.example.js) before signing in.";
        loginError.classList.remove("hidden");
      }
      return;
    }

    if (loginButton) {
      loginButton.disabled = true;
      loginButton.textContent = "Signing in…";
    }

    const formData = new FormData(loginForm);
    const email = formData.get("email");
    const password = formData.get("password");

    const { data, error } = await window.supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (loginButton) {
      loginButton.disabled = false;
      loginButton.textContent = "Sign in";
    }

    if (error) {
      AppError.handle(error, { target: loginError });
      return;
    }

    const role = await resolveRoleForSession(data?.session);
    window.location.href = resolveLanding(role);
  });
}

const forgotPasswordLink = document.getElementById("forgot-password-link");
if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener("click", async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById("email");
    const email = emailInput?.value?.trim();
    if (!email) {
      if (loginError) {
        loginError.textContent = "Enter your email above, then click Forgot password.";
        loginError.classList.remove("hidden");
      }
      return;
    }
    forgotPasswordLink.textContent = "Sending…";
    if (window.configPromise) await window.configPromise;
    const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/login.html",
    });
    if (loginError) loginError.classList.add("hidden");
    if (error) {
      if (loginError) {
        loginError.textContent = error.message || "Failed to send reset email.";
        loginError.classList.remove("hidden");
      }
      forgotPasswordLink.textContent = "Forgot password?";
      return;
    }
    forgotPasswordLink.textContent = "Check your email for reset link.";
    setTimeout(() => {
      forgotPasswordLink.textContent = "Forgot password?";
    }, 5000);
  });
}

function setTopbarNavOpen(open) {
  const toggle = document.querySelector(".topbar .nav-toggle");
  const nav = document.querySelector(".topbar .nav-wrap.collapsible");
  if (!nav) return;
  nav.classList.toggle("is-open", open);
  toggle?.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("topbar-nav-open", open);
  if (!open) {
    document.querySelectorAll(".topbar .nav-group-block.is-open").forEach((block) => {
      block.classList.remove("is-open");
      block.querySelector(".nav-group-label")?.setAttribute("aria-expanded", "false");
    });
  }
}

let topbarNavToggleBound = false;

function initNavToggle() {
  if (document.getElementById("app-sidebar")) return;
  const toggle = document.querySelector(".topbar .nav-toggle");
  const nav = document.querySelector(".topbar .nav-wrap.collapsible");
  if (!toggle || !nav || topbarNavToggleBound) return;
  topbarNavToggleBound = true;

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !nav.classList.contains("is-open");
    setTopbarNavOpen(open);
    if (open) closeTopbarUserMenu();
  });

  /* Mobile: tap group label to expand/collapse that group (accordion) */
  nav.addEventListener("click", (e) => {
    if (window.matchMedia("(min-width: 769px)").matches) return;
    const label = e.target.closest(".nav-group-label");
    if (!label || !nav.contains(label)) return;
    e.preventDefault();
    e.stopPropagation();

    const block = label.closest(".nav-group-block");
    if (!block) return;
    const willOpen = !block.classList.contains("is-open");
    nav.querySelectorAll(".nav-group-block.is-open").forEach((other) => {
      if (other === block) return;
      other.classList.remove("is-open");
      other.querySelector(".nav-group-label")?.setAttribute("aria-expanded", "false");
    });
    block.classList.toggle("is-open", willOpen);
    label.setAttribute("aria-expanded", String(willOpen));
  });

  nav.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (window.matchMedia("(min-width: 769px)").matches) return;
    const label = e.target.closest(".nav-group-label");
    if (!label || !nav.contains(label)) return;
    e.preventDefault();
    label.click();
  });

  nav.querySelectorAll(".nav-group a[href]").forEach((link) => {
    link.addEventListener("click", () => {
      closeTopbarNavMenus();
    });
  });

  document.addEventListener("click", (e) => {
    if (!nav.classList.contains("is-open")) return;
    if (e.target.closest(".topbar .nav-wrap") || e.target.closest(".topbar .nav-toggle")) return;
    closeTopbarNavMenus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("is-open")) {
      closeTopbarNavMenus();
      toggle.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 769px)").matches) {
      closeTopbarNavMenus();
    }
  });
}

/**
 * Verifies page access via server-side database function.
 * This provides defense-in-depth beyond RLS policies.
 *
 * @param {string} pageName - The page identifier (e.g., 'settings', 'analysis')
 * @returns {Promise<{allowed: boolean, role: string}|null>}
 */
async function verifyPageAccess(pageName) {
  try {
    const { data, error } = await supabaseClient.rpc("check_page_access", {
      p_page: pageName,
    });
    if (error) {
      AppError.report(error, { context: "verifyPageAccess", pageName });
      return null;
    }
    return data;
  } catch (err) {
    AppError.report(err, { context: "verifyPageAccess", pageName });
    return null;
  }
}

/**
 * Redirects to the login page if there is no active Supabase session.
 * Supports optional role-based gating with server-side verification.
 *
 * SECURITY NOTE: Client-side checks are for UX only. All data operations
 * are protected by Row Level Security (RLS) policies in the database.
 * Users can bypass UI restrictions but cannot bypass RLS.
 *
 * @param {Object} options
 * @param {string[]} [options.allowedRoles]
 * @param {string} [options.redirectTo] - Where to send unauthenticated users.
 * @param {string} [options.onDenied] - Where to send authenticated users without the required role.
 * @param {string} [options.pageName] - Page identifier for server-side access verification.
 */
async function requireAuth(options = {}) {
  const {
    allowedRoles = null,
    redirectTo = "login.html",
    onDenied = "dashboard.html",
    pageName = null,
  } = options;

  if (window.configPromise) await window.configPromise;

  if (typeof window.isAppConfigValid === "function" && !window.isAppConfigValid()) {
    window.location.href = redirectTo;
    return null;
  }

  const {
    data: { session },
  } = await window.supabaseClient.auth.getSession();

  if (!session) {
    window.location.href = redirectTo;
    return null;
  }

  const auth = await resolveAuthForSession(session);
  const role = auth.role;
  const display_name = auth.display_name;
  const avatar_url = auth.avatar_url;

  if (!role) {
    window.location.href = `${redirectTo}${redirectTo.includes("?") ? "&" : "?"}error=unprovisioned`;
    return null;
  }

  // Server-side verification (if pageName provided)
  if (pageName) {
    const accessCheck = await verifyPageAccess(pageName);
    if (accessCheck === null) {
      AppError.report(new Error("Page access check unavailable"), {
        context: "requireAuth",
        pageName,
      });
      window.location.href = onDenied;
      return null;
    } else if (!accessCheck.allowed) {
      console.warn(`Access denied to ${pageName} for role: ${accessCheck.role ?? role}`);
      window.location.href = onDenied;
      return null;
    } else if (accessCheck.role) {
      await updateTopbarUserProfile(session, {
        role: accessCheck.role,
        display_name,
        avatar_url,
      });
      return { session, role: accessCheck.role, display_name, avatar_url };
    }
  }

  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    if (!allowedRoles.includes(role)) {
      window.location.href = onDenied;
      return null;
    }
  }

  await updateTopbarUserProfile(session, { role, display_name, avatar_url });

  return { session, role, display_name, avatar_url };
}

/**
 * Applies role-based visibility to UI elements.
 *
 * SECURITY NOTE: This is for UX only, NOT security enforcement.
 * Users can bypass this via browser dev tools, but they CANNOT bypass:
 * - Row Level Security (RLS) policies on database tables
 * - Server-side functions (upsert_staff, delete_staff, check_page_access)
 *
 * All sensitive operations are protected at the database level.
 *
 * @param {string} role - The user's role ('admin' or 'supervisor')
 */
function applyRoleVisibility(role) {
  const isAdmin = role === "admin";

  if (typeof window.applyRoleClass === "function") {
    window.applyRoleClass(isAdmin);
  } else {
    document.documentElement.classList.toggle("role-admin", isAdmin);
    document.body?.classList.toggle("role-admin", isAdmin);
  }

  if (!isAdmin) {
    document
      .querySelectorAll("[data-role='admin-only']")
      .forEach((el) => el.remove());
  }

  document
    .querySelectorAll("[data-role='supervisor-only']")
    .forEach((el) => isAdmin && el.remove());

  document.querySelectorAll(".nav-group-block, .app-sidebar-group").forEach((block) => {
    const links = block.querySelectorAll("a[href]");
    if (!links.length) block.remove();
  });
}

window.requireAuth = requireAuth;
window.resolveLandingByRole = resolveLanding;
window.applyRoleVisibility = applyRoleVisibility;
window.resolveRoleForSession = resolveRoleForSession;
window.verifyPageAccess = verifyPageAccess;
window.invalidateUserRoleCache = invalidateUserRoleCache;
window.updateTopbarUserProfile = updateTopbarUserProfile;