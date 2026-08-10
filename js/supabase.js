/* global supabase */

const runtimeConfig = window.__APP_CONFIG__ || {};
const runtimeEnv = runtimeConfig.APP_ENV || "staging";

const PROD_HOSTS = ["bishnupriyafuels.fnsventures.in"];
const hostname = window.location.hostname;
const isProdHost = PROD_HOSTS.includes(hostname);

const SUPABASE_URL = runtimeConfig.SUPABASE_URL;
const SUPABASE_ANON_KEY = runtimeConfig.SUPABASE_ANON_KEY;

function isAppConfigValid() {
  return Boolean(
    SUPABASE_URL &&
      SUPABASE_ANON_KEY &&
      !String(SUPABASE_URL).includes("YOUR-PROJECT-ID")
  );
}

const configValid = isAppConfigValid();

// Validate configuration
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Supabase configuration missing. Please ensure js/env.js exists with valid credentials. " +
      "See js/env.example.js for setup instructions."
  );
}

if (runtimeEnv === "prod" && !isProdHost) {
  console.warn("APP_ENV is set to 'prod' but running on a non-production host.");
}

if (!configValid) {
  console.warn("Supabase config is invalid. Check js/env.js and environment secrets.");
}

if (typeof supabase === "undefined") {
  throw new Error(
    "Supabase library failed to load. Refresh the page or clear your browser cache."
  );
}

const supabaseClient = supabase.createClient(
  SUPABASE_URL || "https://invalid.local",
  SUPABASE_ANON_KEY || "invalid"
);

function injectAppMeta() {
  if (typeof document === "undefined" || !document.head) return;

  if (!document.querySelector('link[rel="manifest"]')) {
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = new URL("manifest.json", window.location.href).href;
    document.head.appendChild(manifest);
  }

  if (!document.querySelector('meta[name="theme-color"]')) {
    const theme = document.createElement("meta");
    theme.name = "theme-color";
    theme.content = "#0070c0";
    document.head.appendChild(theme);
  }

  if (!document.querySelector('meta[name="application-name"]')) {
    const appName = document.createElement("meta");
    appName.name = "application-name";
    appName.content = "Bishnupriya Fuels";
    document.head.appendChild(appName);
  }
}

/**
 * Distinguish DNS/network failure from a truly missing/invalid env.js.
 * @returns {Promise<"ok"|"unreachable"|"invalid"|"not-applied">}
 */
async function probeEnvJsStatus() {
  if (configValid) return "ok";
  const envUrl = new URL("js/env.js", window.location.href).href;
  try {
    const res = await fetch(envUrl, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return "unreachable";
    const text = await res.text();
    if (
      !/SUPABASE_URL\s*:\s*["'][^"']+["']/.test(text) ||
      text.includes("YOUR-PROJECT-ID")
    ) {
      return "invalid";
    }
    return "not-applied";
  } catch {
    return "unreachable";
  }
}

function configBannerHtml(status) {
  switch (status) {
    case "unreachable":
      return (
        "<span>Cannot reach <code>js/env.js</code> (network or DNS). Confirm this hostname still CNAMEs to " +
        "<code>fnsventures.github.io</code>, wait for DNS, then hard-refresh. " +
        "Ops: <code>./scripts/check-dns-siblings.sh --fix</code></span>"
      );
    case "not-applied":
      return (
        "<span>Configuration file is present but did not load in this tab. " +
        "Hard-refresh (or unregister the service worker) and try again.</span>"
      );
    default:
      return (
        "<span>Application configuration is missing or invalid. Copy <code>js/env.example.js</code> " +
        "to <code>js/env.js</code> and add your Supabase credentials — or redeploy prod so CI regenerates " +
        "<code>env.js</code>.</span>"
      );
  }
}

function configErrorText(status) {
  switch (status) {
    case "unreachable":
      return (
        "Cannot reach server configuration (network or DNS). " +
        "Confirm this hostname still points at fnsventures.github.io, then hard-refresh."
      );
    case "not-applied":
      return "Configuration did not load in this tab. Hard-refresh and try again.";
    default:
      return (
        "Server configuration is missing or invalid. Set up js/env.js " +
        "(see js/env.example.js) or redeploy prod before signing in."
      );
  }
}

async function getAppConfigErrorMessage() {
  if (configValid) return null;
  return configErrorText(await probeEnvJsStatus());
}

async function showConfigBanner() {
  if (typeof document === "undefined" || !document.body || configValid) return;

  let banner = document.getElementById("app-config-banner");
  if (banner) return;

  const status = await probeEnvJsStatus();
  banner = document.createElement("div");
  banner.id = "app-config-banner";
  banner.className = "app-config-banner";
  banner.setAttribute("role", "alert");
  banner.dataset.configStatus = status;
  banner.innerHTML = configBannerHtml(status);
  document.body.insertBefore(banner, document.body.firstChild);
}

function showAppUpdateBanner(onReload) {
  if (typeof document === "undefined" || !document.body) return;

  let banner = document.getElementById("app-update-banner");
  if (banner) return;

  banner = document.createElement("div");
  banner.id = "app-update-banner";
  banner.className = "app-update-banner";
  banner.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = "A new version is available.";

  const reloadBtn = document.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.className = "app-update-banner-action";
  reloadBtn.textContent = "Reload";
  reloadBtn.addEventListener("click", () => {
    if (typeof onReload === "function") onReload();
  });

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "app-update-banner-close";
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.textContent = "×";
  dismissBtn.addEventListener("click", () => banner.remove());

  banner.append(text, reloadBtn, dismissBtn);
  document.body.insertBefore(banner, document.body.firstChild);
}

function initNetworkStatus() {
  if (typeof document === "undefined" || !document.body) return;

  let status = document.getElementById("app-network-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "app-network-status";
    status.className = "app-network-status hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.body.appendChild(status);
  }

  const update = () => {
    if (!navigator.onLine) {
      status.textContent = "You are offline. Data may be outdated until connection returns.";
      status.classList.remove("hidden");
    } else {
      status.classList.add("hidden");
    }
  };

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

/**
 * Register Service Worker for offline capability and caching
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      const swUrl = new URL("sw.js", window.location.href);
      const registration = await navigator.serviceWorker.register(swUrl.href);
      console.log("[App] Service Worker registered:", registration.scope);

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            console.log("[App] New Service Worker available");
            showAppUpdateBanner(() => {
              newWorker.postMessage({ type: "SKIP_WAITING" });
              window.location.reload();
            });
          }
        });
      });
    } catch (error) {
      console.warn("[App] Service Worker registration failed:", error);
    }
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    console.log("[App] Service Worker controller changed");
  });
}

/**
 * Send message to Service Worker
 */
function sendToServiceWorker(type, payload = {}) {
  return new Promise((resolve) => {
    if (!navigator.serviceWorker?.controller) {
      resolve(null);
      return;
    }

    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = (event) => {
      resolve(event.data);
    };

    navigator.serviceWorker.controller.postMessage({ type, payload }, [messageChannel.port2]);

    setTimeout(() => resolve(null), 3000);
  });
}

/**
 * Clear all caches (localStorage + Service Worker)
 */
async function clearAllCaches() {
  if (window.AppCache) {
    window.AppCache.clearAll();
  }

  await sendToServiceWorker("CLEAR_CACHE");

  console.log("[App] All caches cleared");
}

/**
 * Clear API-related caches
 */
async function clearApiCaches() {
  if (typeof CacheInvalidation !== "undefined") {
    CacheInvalidation.invalidate("all_api");
  }

  await sendToServiceWorker("CLEAR_API_CACHE");

  console.log("[App] API caches cleared");
}

/**
 * Get combined cache statistics
 */
async function getCacheStats() {
  const localStats = window.AppCache ? window.AppCache.getStats() : null;
  const swStats = await sendToServiceWorker("GET_CACHE_STATS");

  return {
    localStorage: localStats,
    serviceWorker: swStats,
  };
}

function initAppShell() {
  injectAppMeta();
  void showConfigBanner();
  initNetworkStatus();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAppShell);
  } else {
    initAppShell();
  }
}

registerServiceWorker();

if (window.AppCache) {
  const runCacheCleanup = () => {
    try {
      window.AppCache.clearOldEntries();
    } catch {
      // Ignore cleanup errors
    }
  };
  // Defer full localStorage scan off the critical path of every page load
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runCacheCleanup, { timeout: 5000 });
  } else {
    setTimeout(runCacheCleanup, 3000);
  }
  setInterval(runCacheCleanup, 30 * 60 * 1000);
}

window.supabaseClient = supabaseClient;
window.isAppConfigValid = isAppConfigValid;
window.getAppConfigErrorMessage = getAppConfigErrorMessage;
window.clearAllCaches = clearAllCaches;
window.clearApiCaches = clearApiCaches;
window.getCacheStats = getCacheStats;
