/**
 * Service Worker for Bishnupriya Fuels Petrol Pump Application
 * Provides offline capability, network caching, and background sync
 */

const CACHE_VERSION = "v111";
const STATIC_CACHE = `bpf-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `bpf-dynamic-${CACHE_VERSION}`;
const API_CACHE = `bpf-api-${CACHE_VERSION}`;

/**
 * App shell + every page script/CSS precached on install for offline navigation.
 * env.js is generated per deploy and is never cached (see fetch handler).
 */
const STATIC_ASSET_PATHS = [
  // HTML pages
  "index.html",
  "about.html",
  "login.html",
  "dashboard.html",
  "dsr.html",
  "meter-reading.html",
  "expenses.html",
  "credit.html",
  "billing.html",
  "reports.html",
  "analysis.html",
  "day-closing.html",
  "attendance.html",
  "salary.html",
  "staff.html",
  "settings.html",
  "invoices.html",
  "sales-daily.html",
  "credit-customer.html",
  "credit-overdue.html",
  "404.html",
  "manifest.json",
  // CSS
  "css/base.css",
  "css/fonts.css",
  "css/landing.css",
  "css/login.css",
  "css/app-core.css",
  "css/app-dashboard.css",
  "css/app-analysis.css",
  "css/app-dsr.css",
  "css/app-meter-reading.css",
  "css/app-day-closing.css",
  "css/app-credit.css",
  "css/app-billing.css",
  "css/app-reports.css",
  "css/app-attendance.css",
  "css/app-salary.css",
  "css/app-staff.css",
  "css/invoice-print.css",
  "css/reports-print.css",
  "css/salary-slip-print.css",
  "css/credit-summary-print.css",
  "css/staff-id-print.css",
  "assets/favicon-32.png",
  "assets/apple-touch-icon.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/logo-44.webp",
  "assets/logo-104.webp",
  "assets/logo-print.webp",
  "assets/landing-01.webp",
  "assets/landing-01-800.webp",
  "assets/landing-02.webp",
  "assets/landing-02-800.webp",
  "assets/landing-03.webp",
  "assets/landing-03-800.webp",
  "assets/landing-04.webp",
  "assets/landing-04-800.webp",
  // Self-hosted fonts
  "fonts/dm-sans-latin.woff2",
  "fonts/dm-sans-latin-ext.woff2",
  "fonts/dm-sans-italic-latin.woff2",
  "fonts/dm-sans-italic-latin-ext.woff2",
  "fonts/source-serif-4-latin.woff2",
  "fonts/source-serif-4-latin-ext.woff2",
  "fonts/caveat-latin.woff2",
  "fonts/caveat-latin-ext.woff2",
  // Shared JS
  "js/vendor/supabase-login.min.js",
  "js/vendor/supabase.min.js",
  "js/roleBootstrap.js",
  "js/appNav.js",
  "js/dsrSections.js",
  "js/dsrLegacyRedirect.js",
  "js/dsrFuelNav.js",
  "js/errorHandler.js",
  "js/cache.js",
  "js/appConfig.js",
  "js/utils.js",
  "js/printUtils.js",
  "js/pumpSettings.js",
  "js/supabase.js",
  "js/auth.js",
  "js/pageSections.js",
  "js/dateRangeFilter.js",
  "js/dsrQueries.js",
  "js/purchaseTaxUtils.js",
  "js/staffEmployees.js",
  "js/creditCustomerDetail.js",
  "js/creditOverview.js",
  "js/creditRecord.js",
  "js/creditCustomer.js",
  "js/dsrSummary.js",
  "js/landing.js",
  // Page-specific JS
  "js/dashboard.js",
  "js/dsr.js",
  "js/meterReading.js",
  "js/expenses.js",
  "js/credit.js",
  "js/billing.js",
  "js/reports.js",
  "js/analysis.js",
  "js/day-closing.js",
  "js/attendance.js",
  "js/salary.js",
  "js/staff.js",
  "js/settings.js",
  "js/invoices.js",
];

const CACHE_MATCH_OPTS = { ignoreSearch: true };

function getScopeBase() {
  const scope = self.registration?.scope || new URL("./", self.location.href).href;
  return scope.endsWith("/") ? scope : `${scope}/`;
}

function resolveScopedUrl(path) {
  if (!path || path.startsWith("http")) return path;
  const clean = String(path).replace(/^\//, "");
  return new URL(clean, getScopeBase()).href;
}

// API endpoints to cache with network-first strategy
const API_PATTERNS = [
  /\/rest\/v1\//,
  /\/functions\/v1\//,
];

// SW API cache TTL — only used for offline fallback on cacheable reference data.
// Operational/financial tables are excluded (see isNoCacheApiRequest); AppCache owns those TTLs.
const CACHE_TTL = {
  api: 2 * 60 * 1000,
  static: 24 * 60 * 60 * 1000,
};

/**
 * Install event - cache static assets
 */
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");

  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => {
        console.log("[SW] Caching static assets...");
        // Cache what we can, don't fail on individual asset failures
        return Promise.allSettled(
          STATIC_ASSET_PATHS.map((path) =>
            cache.add(resolveScopedUrl(path)).catch((err) => {
              console.warn(`[SW] Failed to cache: ${path}`, err);
            })
          )
        );
      })
      .then(() => {
        console.log("[SW] Static assets cached");
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error("[SW] Install failed:", err);
      })
  );
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker...");

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              return (
                name.startsWith("bpf-") &&
                name !== STATIC_CACHE &&
                name !== DYNAMIC_CACHE &&
                name !== API_CACHE
              );
            })
            .map((name) => {
              console.log("[SW] Deleting old cache:", name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log("[SW] Service worker activated");
        return self.clients.claim();
      })
  );
});

/**
 * Fetch event - handle network requests with caching strategies
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") {
    return;
  }

  // Skip chrome-extension and other non-http(s) requests
  if (!url.protocol.startsWith("http")) {
    return;
  }

  // Runtime config is gitignored locally and generated per deploy — never cache
  if (url.pathname.endsWith("/js/env.js")) {
    event.respondWith(fetch(request));
    return;
  }

  // Sensitive / financial data must always be fresh — never cache
  if (isApiRequest(url) && isNoCacheApiRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // Handle other API requests with network-first strategy
  if (isApiRequest(url)) {
    event.respondWith(networkFirstStrategy(request, API_CACHE));
    return;
  }

  // Handle static assets with cache-first strategy
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstStrategy(request, STATIC_CACHE));
    return;
  }

  // Handle HTML pages with stale-while-revalidate
  if (isHtmlPage(url)) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  // Default: network with cache fallback
  event.respondWith(networkWithCacheFallback(request, DYNAMIC_CACHE));
});

/**
 * Check if request is an API call
 */
function isApiRequest(url) {
  return API_PATTERNS.some((pattern) => pattern.test(url.pathname));
}

/**
 * API paths that must never be cached in the SW layer.
 * AppCache (localStorage) owns aggregated dashboard/reports TTLs; SW caching the same
 * underlying REST/edge responses would serve overlapping stale DSR/expense data.
 */
function isNoCacheApiRequest(url) {
  const path = url.pathname;
  const table = url.searchParams?.get("table") ?? "";
  const noCacheTables = [
    // Credit & staff (PII / financial)
    "credit_customers",
    "credit_entries",
    "credit_payments",
    "employees",
    "users",
    "employee_attendance",
    "salary_payments",
    "salary_month_exclusions",
    // DSR, expenses, day closing — AppCache or live pages own freshness
    "dsr",
    "dsr_petrol",
    "dsr_diesel",
    "expenses",
    "day_closing",
    "night_cash_collections",
    // Billing & settings cached in AppCache
    "invoices",
    "invoice_items",
    "invoice_documents",
    "pump_settings",
  ];
  if (noCacheTables.some((t) => path.includes(t) || table === t)) return true;
  if (path.includes("/rpc/")) return true;
  if (path.includes("/functions/v1/")) return true;
  return false;
}

/**
 * Check if request is for a static asset
 */
function isStaticAsset(url) {
  const staticExtensions = [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2"];
  return staticExtensions.some((ext) => url.pathname.endsWith(ext));
}

/**
 * Check if request is for an HTML page
 */
function isHtmlPage(url) {
  return url.pathname.endsWith(".html") || url.pathname === "/" || !url.pathname.includes(".");
}

/**
 * Network-first strategy - try network, fall back to cache
 * Best for API requests where fresh data is preferred
 */
function isApiCacheFresh(response) {
  const cachedAt = response.headers.get("sw-cached-at");
  if (!cachedAt) return true;
  const age = Date.now() - Number(cachedAt);
  return Number.isFinite(age) && age < CACHE_TTL.api;
}

async function putApiCacheEntry(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set("sw-cached-at", String(Date.now()));
  const body = await response.clone().blob();
  const stamped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  await cache.put(request, stamped);
}

async function networkFirstStrategy(request, cacheName) {
  try {
    const networkResponse = await fetch(request);

    // Only cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      await putApiCacheEntry(cache, request, networkResponse);
    }

    return networkResponse;
  } catch (error) {
    console.log("[SW] Network failed, trying cache:", request.url);
    const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);

    if (cachedResponse && isApiCacheFresh(cachedResponse)) {
      return cachedResponse;
    }

    // Return offline fallback for API requests
    return new Response(
      JSON.stringify({
        error: "offline",
        message: "You are offline. Please check your connection.",
      }),
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Cache-first strategy - try cache, fall back to network
 * Best for static assets that rarely change
 */
async function cacheFirstStrategy(request, cacheName) {
  const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);

  if (cachedResponse) {
    // Optionally refresh cache in background
    refreshCacheInBackground(request, cacheName);
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    console.error("[SW] Cache-first failed:", request.url, error);
    return new Response("Resource not available offline", { status: 503 });
  }
}

/**
 * Stale-while-revalidate strategy
 * Returns cached version immediately, updates cache in background
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request, CACHE_MATCH_OPTS);

  // Fetch from network in background
  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse.ok) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch((error) => {
      console.warn("[SW] Background fetch failed:", request.url, error);
      return null;
    });

  // Return cached response immediately, or wait for network
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetchPromise;
  if (networkResponse) {
    return networkResponse;
  }

  // Return offline page as last resort
  return getOfflineFallback();
}

/**
 * Network with cache fallback
 */
async function networkWithCacheFallback(request, cacheName) {
  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);

    if (cachedResponse) {
      return cachedResponse;
    }

    return getOfflineFallback();
  }
}

/**
 * Refresh cache in background without blocking
 */
function refreshCacheInBackground(request, cacheName) {
  fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(cacheName);
        cache.put(request, response);
      }
    })
    .catch(() => {
      // Silent fail for background refresh
    });
}

/**
 * Get offline fallback response
 */
async function getOfflineFallback() {
  const cachedIndex = await caches.match(resolveScopedUrl("index.html"), CACHE_MATCH_OPTS);
  if (cachedIndex) {
    return cachedIndex;
  }

  // Return basic offline message
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Offline - Bishnupriya Fuels</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    .offline-container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    .offline-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    p {
      color: #666;
      margin-bottom: 1.5rem;
    }
    button {
      background: #0070c0;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }
    button:hover {
      background: #005a9c;
    }
  </style>
</head>
<body>
  <div class="offline-container">
    <div class="offline-icon">📡</div>
    <h1>You're Offline</h1>
    <p>Please check your internet connection and try again.</p>
    <button onclick="window.location.reload()">Try Again</button>
  </div>
</body>
</html>`,
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/html" },
    }
  );
}

/**
 * Message handler for cache management from main thread
 */
self.addEventListener("message", (event) => {
  const { type, payload } = event.data || {};

  switch (type) {
    case "SKIP_WAITING":
      self.skipWaiting();
      break;

    case "CLEAR_CACHE":
      clearAllCaches().then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case "CLEAR_API_CACHE":
      caches.delete(API_CACHE).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case "GET_CACHE_STATS":
      getCacheStats().then((stats) => {
        event.ports[0]?.postMessage(stats);
      });
      break;

    case "INVALIDATE_PATTERN":
      if (payload?.pattern) {
        invalidateCacheByPattern(payload.pattern).then(() => {
          event.ports[0]?.postMessage({ success: true });
        });
      }
      break;
  }
});

/**
 * Clear all application caches
 */
async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith("bpf-"))
      .map((name) => caches.delete(name))
  );
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
  const stats = {
    static: { entries: 0 },
    dynamic: { entries: 0 },
    api: { entries: 0 },
  };

  try {
    const staticCache = await caches.open(STATIC_CACHE);
    const staticKeys = await staticCache.keys();
    stats.static.entries = staticKeys.length;

    const dynamicCache = await caches.open(DYNAMIC_CACHE);
    const dynamicKeys = await dynamicCache.keys();
    stats.dynamic.entries = dynamicKeys.length;

    const apiCache = await caches.open(API_CACHE);
    const apiKeys = await apiCache.keys();
    stats.api.entries = apiKeys.length;
  } catch {
    // Ignore errors
  }

  return stats;
}

/**
 * Invalidate cache entries matching a pattern
 */
async function invalidateCacheByPattern(pattern) {
  const regex = new RegExp(pattern);
  const cacheNames = await caches.keys();

  for (const cacheName of cacheNames) {
    if (!cacheName.startsWith("bpf-")) continue;

    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    for (const request of keys) {
      if (regex.test(request.url)) {
        await cache.delete(request);
      }
    }
  }
}

console.log("[SW] Service worker script loaded");
