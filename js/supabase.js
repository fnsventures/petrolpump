/* global supabase */

const PROD_HOSTS = ["bishnupriyafuels.fnsventures.in"];
const hostname = window.location.hostname;
const isProdHost = PROD_HOSTS.includes(hostname);

let supabaseClient = null;
let configPromise = null;
let configResolved = false;
let configValid = false;
let runtimeConfig = {};
let runtimeEnv = "staging";

function getClient() {
  return supabaseClient;
}

function setClient(client) {
  supabaseClient = client;
  window.supabaseClient = client;
}

function isAppConfigValid() {
  return Boolean(
    runtimeConfig.SUPABASE_URL &&
    runtimeConfig.SUPABASE_ANON_KEY &&
    !String(runtimeConfig.SUPABASE_URL).includes("YOUR-PROJECT-ID")
  );
}

async function loadAppConfig() {
  if (configResolved) return configValid;

  // env.js normally runs before this file (defer order). Wait briefly if it is late.
  if (!window.__APP_CONFIG__) {
    const maxWaitMs = 2000;
    const startTime = Date.now();
    while (!window.__APP_CONFIG__ && Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  runtimeConfig = window.__APP_CONFIG__ || {};
  runtimeEnv = runtimeConfig.APP_ENV || "staging";
  configValid = isAppConfigValid();
  configResolved = true;

  if (!runtimeConfig.SUPABASE_URL || !runtimeConfig.SUPABASE_ANON_KEY) {
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

  const client = supabase.createClient(
    runtimeConfig.SUPABASE_URL || "https://invalid.local",
    runtimeConfig.SUPABASE_ANON_KEY || "invalid"
  );

  setClient(client);
  window.isAppConfigValid = isAppConfigValid;

  return configValid;
}

configPromise = loadAppConfig();

function getSupabaseClient() {
  const client = getClient();
  if (!client) {
    throw new Error("Supabase client not initialized. Call await configPromise first.");
  }
  return client;
}

window.getSupabaseClient = getSupabaseClient;
window.configPromise = configPromise;

/**
 * Distinguish missing/invalid env.js from a network failure.
 * @returns {Promise<"ok"|"unreachable"|"missing"|"invalid"|"not-applied">}
 */
async function probeEnvJsStatus() {
  if (configValid) return "ok";

  // Config may have landed after this module started waiting.
  if (window.__APP_CONFIG__) {
    runtimeConfig = window.__APP_CONFIG__;
    runtimeEnv = runtimeConfig.APP_ENV || runtimeEnv;
    configValid = isAppConfigValid();
    if (configValid) return "ok";
  }

  const envUrl = new URL("js/env.js", window.location.href).href;
  try {
    const res = await fetch(envUrl, { cache: "no-store", credentials: "same-origin" });
    if (res.status === 404) return "missing";
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
        "<span>Cannot reach <code>js/env.js</code> (network error). Hard-refresh and check your connection. " +
        "On a custom domain, confirm DNS still points at <code>fnsventures.github.io</code>.</span>"
      );
    case "missing":
      return (
        "<span><code>js/env.js</code> was not found on this host. For local use, copy " +
        "<code>js/env.example.js</code> → <code>js/env.js</code>. For deployed sites, redeploy so CI regenerates it.</span>"
      );
    case "not-applied":
      return (
        "<span>Configuration file is present but did not load in this tab. " +
        "Hard-refresh (or unregister the service worker) and try again.</span>"
      );
    default:
      return (
        "<span>Application configuration is missing or invalid. Copy <code>js/env.example.js</code> " +
        "to <code>js/env.js</code> and add your Supabase credentials — or redeploy so CI regenerates " +
        "<code>env.js</code>.</span>"
      );
  }
}

function configErrorText(status) {
  switch (status) {
    case "unreachable":
      return "Cannot reach server configuration (network error). Hard-refresh and try again.";
    case "missing":
      return "js/env.js was not found. Copy js/env.example.js to js/env.js (local) or redeploy (hosted).";
    case "not-applied":
      return "Configuration did not load in this tab. Hard-refresh and try again.";
    default:
      return (
        "Server configuration is missing or invalid. Set up js/env.js " +
        "(see js/env.example.js) or redeploy before signing in."
      );
  }
}

async function getAppConfigErrorMessage() {
  if (configValid) return null;
  try {
    if (configPromise) await configPromise;
  } catch {
    /* ignore init failure; probe below */
  }
  if (configValid) return null;
  return configErrorText(await probeEnvJsStatus());
}

async function showConfigBanner() {
  if (typeof document === "undefined" || !document.body) return;

  try {
    if (configPromise) await configPromise;
  } catch {
    /* still show a banner if config never became valid */
  }

  if (configValid) return;

  let banner = document.getElementById("app-config-banner");
  if (banner) return;

  const status = await probeEnvJsStatus();
  if (status === "ok" || configValid) return;

  banner = document.createElement("div");
  banner.id = "app-config-banner";
  banner.className = "app-config-banner";
  banner.setAttribute("role", "alert");
  banner.dataset.configStatus = status;
  banner.innerHTML = configBannerHtml(status);
  document.body.insertBefore(banner, document.body.firstChild);
}

function sendToServiceWorker(type, payload = {}) {
  if (window.PWA?.sendToServiceWorker) {
    return window.PWA.sendToServiceWorker(type, payload);
  }

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

async function clearAllCaches() {
  if (window.AppCache) {
    window.AppCache.clearAll();
  }

  await sendToServiceWorker("CLEAR_CACHE");

  console.log("[App] All caches cleared");
}

async function clearApiCaches() {
  if (typeof CacheInvalidation !== "undefined") {
    CacheInvalidation.invalidate("all_api");
  } else if (window.AppCache?.invalidateOperational) {
    window.AppCache.invalidateOperational();
  }

  console.log("[App] API caches cleared");
}

async function getCacheStats() {
  const localStats = window.AppCache ? window.AppCache.getStats() : null;
  const swStats = await sendToServiceWorker("GET_CACHE_STATS");

  return {
    localStorage: localStats,
    serviceWorker: swStats,
  };
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void showConfigBanner());
  } else {
    void showConfigBanner();
  }
}

if (window.AppCache) {
  const runCacheCleanup = () => {
    try {
      window.AppCache.clearOldEntries();
    } catch {
      // Ignore cleanup errors
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runCacheCleanup, { timeout: 5000 });
  } else {
    setTimeout(runCacheCleanup, 3000);
  }
  setInterval(runCacheCleanup, 30 * 60 * 1000);
}

// Classic-script globals (login.html and app pages load this via <script>, not type=module)
window.supabaseClient = supabaseClient;
window.configPromise = configPromise;
window.getSupabaseClient = getSupabaseClient;
window.isAppConfigValid = isAppConfigValid;
window.getAppConfigErrorMessage = getAppConfigErrorMessage;
window.clearAllCaches = clearAllCaches;
window.clearApiCaches = clearApiCaches;
window.getCacheStats = getCacheStats;