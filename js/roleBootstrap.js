/**
 * Apply cached user role before deferred scripts run (prevents admin nav flash for supervisors).
 * Reads Supabase session + AppCache role entry from localStorage — no network calls.
 */
(function () {
  const CACHE_PREFIX = "bpf_cache_";

  function normalizeEmail(email) {
    return (email || "").toLowerCase().trim();
  }

  let cachedAuthEmail;

  function getSupabaseAuthEmail() {
    if (cachedAuthEmail !== undefined) return cachedAuthEmail;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const user = parsed?.user ?? parsed?.currentSession?.user;
        const email = user?.email;
        if (email) {
          cachedAuthEmail = normalizeEmail(email);
          return cachedAuthEmail;
        }
      }
    } catch {
      /* ignore parse errors */
    }
    cachedAuthEmail = null;
    return cachedAuthEmail;
  }

  function readCachedRole(email) {
    if (!email) return null;
    try {
      const raw = localStorage.getItem(`${CACHE_PREFIX}staff_role_${email}`);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      return entry?.data?.role ?? null;
    } catch {
      return null;
    }
  }

  function applyRoleClass(isAdmin) {
    document.documentElement.classList.toggle("role-admin", isAdmin);
    document.body?.classList.toggle("role-admin", isAdmin);
  }

  function bootstrapRoleFromCache() {
    const email = getSupabaseAuthEmail();
    const role = readCachedRole(email);
    applyRoleClass(role === "admin");
    return role;
  }

  bootstrapRoleFromCache();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      // Body is not available when this script runs in <head>; sync class once.
      document.body?.classList.toggle(
        "role-admin",
        document.documentElement.classList.contains("role-admin")
      );
    });
  }

  window.applyRoleClass = applyRoleClass;
  window.bootstrapRoleFromCache = bootstrapRoleFromCache;
  window.readCachedUserRole = function readCachedUserRole() {
    return readCachedRole(getSupabaseAuthEmail());
  };
})();
