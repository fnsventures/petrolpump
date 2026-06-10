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

function showConfigBanner() {
  if (typeof document === "undefined" || !document.body || configValid) return;

  let banner = document.getElementById("app-config-banner");
  if (banner) return;

  banner = document.createElement("div");
  banner.id = "app-config-banner";
  banner.className = "app-config-banner";
  banner.setAttribute("role", "alert");
  banner.innerHTML =
    "<span>Application configuration is missing or invalid. Copy <code>js/env.example.js</code> to <code>js/env.js</code> and add your Supabase credentials.</span>";
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
  if (window.AppCache) {
    window.AppCache.invalidateByType("dashboard_data");
    window.AppCache.invalidateByType("credit_summary");
    window.AppCache.invalidateByType("today_sales");
    window.AppCache.invalidateByType("recent_activity");
    window.AppCache.invalidateByType("dsr_summary");
    window.AppCache.invalidateByType("profit_loss");
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
  showConfigBanner();
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
  window.AppCache.clearOldEntries();
  setInterval(() => {
    window.AppCache.clearOldEntries();
  }, 10 * 60 * 1000);
}

window.supabaseClient = supabaseClient;
window.isAppConfigValid = isAppConfigValid;
window.clearAllCaches = clearAllCaches;
window.clearApiCaches = clearApiCaches;
window.getCacheStats = getCacheStats;
