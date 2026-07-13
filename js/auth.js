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
  const topbar = document.querySelector("header.topbar");
  if (!topbar) return;

  const subtitle = topbar.querySelector(".page-subtitle");
  if (!subtitle || subtitle.parentElement === topbar) return;

  const insertBefore = topbar.querySelector(".nav-toggle") ?? topbar.querySelector(".nav-wrap");
  topbar.insertBefore(subtitle, insertBefore);
}

function enhanceTopbarBrand() {
  const topbar = document.querySelector("header.topbar");
  const brand = topbar?.querySelector(".brand");
  if (!brand || brand.querySelector(".brand-mark")) return;

  const link = brand.querySelector("a");
  const logoSrc = AppConfig.STATION_LOGO_SRC || AppConfig.BPCL_LOGO_SRC;
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
  const nav = document.querySelector(".topbar .nav-wrap.collapsible");
  const toggle = document.querySelector(".topbar .nav-toggle");
  nav?.classList.remove("is-open");
  toggle?.setAttribute("aria-expanded", "false");

  document.querySelectorAll(".topbar .nav-group-block.is-open").forEach((block) => {
    block.classList.remove("is-open");
    block.querySelector(".nav-group-label")?.setAttribute("aria-expanded", "false");
  });

  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".topbar .nav-wrap")) {
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
async function fetchRoleFromStaff(email) {
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
    return AppCache.getWithSWR(cacheKey, fetchFn, "user_role");
  }

  return fetchFn();
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

  topbar.querySelector(".topbar-actions")?.remove();
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
      toggle.insertBefore(photo, initials);
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
      return;
    }

    if (!menu.contains(e.target)) {
      closeTopbarUserMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTopbarUserMenu();
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

function ensureTopbarUserMenu() {
  const topbar = document.querySelector("header.topbar");
  if (!topbar) return null;

  restoreTopbarStructure(topbar);

  let menu = topbar.querySelector(".topbar-user-menu");
  if (menu) return menu;

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

  const nav = topbar.querySelector(".nav-wrap");
  if (nav) nav.appendChild(menu);
  else topbar.appendChild(menu);

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
  const toggle = document.getElementById("topbar-user-menu-toggle");
  if (!initialsEl || !nameEl || !emailEl || !roleEl) return;

  if (!session?.user) {
    applyTopbarAvatarDisplay(null, "?");
    nameEl.textContent = "Operator";
    emailEl.textContent = "";
    roleEl.textContent = "";
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
  roleEl.textContent = role ? role.charAt(0).toUpperCase() + role.slice(1) : "";
  toggle?.setAttribute("title", `${displayName}${role ? ` · ${role}` : ""}`);
}

async function initTopbarUserProfile() {
  if (!document.querySelector("header.topbar")) return;
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  await updateTopbarUserProfile(session);
}

document.addEventListener("DOMContentLoaded", async () => {
  const path = window.location.pathname || "";
  if (path.includes("login")) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "unprovisioned" && loginError) {
      loginError.textContent =
        "Your account is not set up yet. Ask an administrator to add you in Settings → Users & roles.";
      loginError.classList.remove("hidden");
    }
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      const role = await resolveRoleForSession(session);
      if (role) {
        window.location.href = resolveLanding(role);
        return;
      }
      await supabaseClient.auth.signOut();
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
});

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError?.classList.add("hidden");

    if (typeof window.isAppConfigValid === "function" && !window.isAppConfigValid()) {
      if (loginError) {
        loginError.textContent =
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

    const { data, error } = await supabaseClient.auth.signInWithPassword({
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
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
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

function initNavToggle() {
  const toggle = document.querySelector(".topbar .nav-toggle");
  const nav = document.querySelector(".topbar .nav-wrap.collapsible");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  /* Mobile: tap group label to expand/collapse that group (accordion) */
  nav.querySelectorAll(".nav-group-label").forEach((label) => {
    label.addEventListener("click", () => {
      const block = label.closest(".nav-group-block");
      if (!block) return;
      const isOpen = block.classList.toggle("is-open");
      label.setAttribute("aria-expanded", String(isOpen));
    });
    label.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const block = label.closest(".nav-group-block");
      if (!block) return;
      const isOpen = block.classList.toggle("is-open");
      label.setAttribute("aria-expanded", String(isOpen));
    });
  });

  nav.querySelectorAll(".nav-group a[href]").forEach((link) => {
    link.addEventListener("click", () => {
      closeTopbarNavMenus();
    });
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

  if (typeof window.isAppConfigValid === "function" && !window.isAppConfigValid()) {
    window.location.href = redirectTo;
    return null;
  }

  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

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

  document.querySelectorAll(".nav-group-block").forEach((block) => {
    const links = block.querySelectorAll(".nav-group a[href]");
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