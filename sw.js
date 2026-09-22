/**
 * Service Worker — Bishnupriya Fuels (standard PWA patterns)
 *
 * Strategies (performance-first for a financial ops MPA):
 * - App shell: precache on install (app HTML + shared/page CSS/JS + fonts)
 * - Precache is never LRU-trimmed; other static files use a runtime cache
 * - Static JS/CSS/fonts/images: stale-while-revalidate (fast + fresh)
 * - HTML navigations: network-first (no timeout fallback to stale HTML)
 * - env.js: network-first with last-known cache fallback (generated at deploy)
 * - Supabase REST/Functions: always network-only (ops data must never be stale)
 * - Updates: client sends SKIP_WAITING when safe (see js/pwa.js)
 */

const CACHE_VERSION = "v202";
const STATIC_CACHE = `bpf-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `bpf-runtime-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `bpf-dynamic-${CACHE_VERSION}`;

/** Max entries for runtime caches (precache is never trimmed). */
const CACHE_LIMITS = {
  dynamic: 80,
  runtime: 120,
};

/** Min gap between background revalidations for the same URL (reduces network churn). */
const REVALIDATE_MS = 30 * 1000;
const revalidateAt = new Map();

/**
 * True app shell. Page modules listed here install with the PWA; env.js is never precached.
 */
const STATIC_ASSET_PATHS = [
  "404.html",
  "about.html",
  "analysis.html",
  "attendance.html",
  "billing.html",
  "credit-customer.html",
  "credit-overdue.html",
  "credit.html",
  "dashboard.html",
  "day-closing.html",
  "dsr.html",
  "e20-register.html",
  "expenses.html",
  "index.html",
  "invoices.html",
  "letterhead.html",
  "login.html",
  "meter-reading.html",
  "offline.html",
  "reminders.html",
  "reports.html",
  "salary.html",
  "sales-daily.html",
  "settings.html",
  "staff.html",
  "manifest.json",
  "css/landing.css",
  "css/login.css",
  "css/staff-id-print.css",
  "css/app-core.css",
  "css/app-staff.css",
  "css/reports-print.css",
  "css/report-watermark.css",
  "js/landing.js",
  "js/vendor/supabase-login.min.js",
  "js/vendor/supabase.min.js",
  "js/dsrFuelNav.js",
  "js/dsrLegacyRedirect.js",
  "js/dsrSections.js",
  "js/expenses.js",
  "js/billing.js",
  "js/invoices.js",
  "js/settings.js",
  "js/creditOverview.js",
  "js/creditRecord.js",
  "js/creditCustomerDetail.js",
  "js/creditCustomer.js",
  "css/fonts.css",
  "css/app-sidebar.css",
  "css/app-notifications.css",
  "assets/favicon-32.png",
  "assets/apple-touch-icon.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/logo-44.webp",
  "assets/logo-80.webp",
  "assets/logo-80.png",
  "assets/logo-104.webp",
  "assets/logo-104.png",
  "assets/logo-print.webp",
  "fonts/caveat-latin-ext.woff2",
  "fonts/caveat-latin.woff2",
  "fonts/dm-sans-italic-latin-ext.woff2",
  "fonts/dm-sans-italic-latin.woff2",
  "fonts/dm-sans-latin-ext.woff2",
  "fonts/dm-sans-latin.woff2",
  "fonts/source-serif-4-latin-ext.woff2",
  "fonts/source-serif-4-latin.woff2",
  "js/roleBootstrap.js?v=26",
  "js/appNav.js?v=26",
  "js/utils.js?v=26",
  "js/pwa.js?v=26",
  "js/cache.js?v=26",
  "js/auth.js?v=26",
  "js/supabase.js?v=26",
  "js/errorHandler.js?v=26",
  "js/appConfig.js?v=26",
  "js/pumpSettings.js?v=26",
  "js/pageSections.js?v=26",
  "js/taskUtils.js?v=26",
  "js/dsrQueries.js?v=26",
  "js/notifications.js?v=26",
  "css/base.css?v=26",
  "css/app-core.css?v=26",
  "css/app-layout.css?v=26",
  "css/app-dashboard.css?v=31",
  "js/purchaseTaxUtils.js?v=7",
  "js/dateRangeFilter.js?v=10",
  "js/dashboard.js?v=23",
  "css/app-dsr.css?v=19",
  "css/app-meter-reading.css?v=48",
  "js/buyingPriceEntry.js?v=6",
  "js/staffEmployees.js?v=5",
  "js/shiftStaffLedger.js?v=5",
  "js/meterShiftReading.js?v=43",
  "js/meterReading.js?v=33",
  "js/printUtils.js?v=20",
  "js/dsrSummary.js?v=3",
  "js/dsrSalesBreakdown.js?v=10",
  "js/dsr.js?v=7",
  "css/app-e20-register.css?v=9",
  "css/report-watermark.css?v=7",
  "js/e20Register.js?v=14",
  "css/app-reminders.css?v=13",
  "js/reminders.js?v=17",
  "css/app-credit.css?v=14",
  "js/credit.js?v=11",
  "css/app-day-closing.css?v=12",
  "js/day-closing.js?v=25",
  "css/app-billing.css?v=11",
  "js/driveFiles.js?v=5",
  "js/billing.js?v=5",
  "css/app-attendance.css?v=12",
  "js/attendance.js?v=12",
  "css/app-salary.css?v=13",
  "js/salary.js?v=19",
  "css/app-staff.css?v=16",
  "js/staff.js?v=19",
  "css/app-letterhead.css?v=7",
  "js/letterhead.js?v=16",
  "css/app-analysis.css?v=9",
  "js/analysis.js?v=9",
  "css/app-reports.css?v=15",
  "js/reports.js?v=20",
  "css/reports-print.css?v=16",
  "css/credit-summary-print.css?v=7",
  "css/e20-register-print.css?v=5",
  "css/letterhead-print.css?v=4",
  "css/invoice-print.css?v=3",
  "css/salary-slip-print.css?v=2",
];

/** Only for offline.html / shell fallbacks — never for versioned JS/CSS or API. */
const OFFLINE_MATCH_OPTS = { ignoreSearch: true };

const API_PATTERNS = [/\/rest\/v1\//, /\/functions\/v1\//];

function getScopeBase() {
  const scope = self.registration?.scope || new URL("./", self.location.href).href;
  return scope.endsWith("/") ? scope : `${scope}/`;
}

function resolveScopedUrl(path) {
  if (!path || path.startsWith("http")) return path;
  const clean = String(path).replace(/^\//, "");
  return new URL(clean, getScopeBase()).href;
}

async function trimCache(cacheName, maxEntries, cacheInstance) {
  if (!maxEntries || maxEntries < 1) return;
  try {
    const cache = cacheInstance || (await caches.open(cacheName));
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const excess = keys.length - maxEntries;
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  } catch {
    /* ignore */
  }
}

async function putAndTrim(cacheName, request, response, maxEntries, cacheInstance) {
  const cache = cacheInstance || (await caches.open(cacheName));
  await cache.put(request, response);
  await trimCache(cacheName, maxEntries, cache);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const CONCURRENCY = 6;
      for (let i = 0; i < STATIC_ASSET_PATHS.length; i += CONCURRENCY) {
        const slice = STATIC_ASSET_PATHS.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          slice.map((path) =>
            cache.add(resolveScopedUrl(path)).catch((err) => {
              console.warn(`[SW] Failed to cache: ${path}`, err);
            })
          )
        );
      }
      // Wait for client SKIP_WAITING so active tabs are not force-reloaded mid-session.
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("bpf-") &&
              name !== STATIC_CACHE &&
              name !== RUNTIME_CACHE &&
              name !== DYNAMIC_CACHE
          )
          .map((name) => caches.delete(name))
      );

      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          /* unsupported / denied */
        }
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (!url.protocol.startsWith("http")) return;

  // Same-origin only for HTML/static strategies; APIs are cross-origin by design.
  const isSameOrigin = url.origin === self.location.origin;

  if (url.pathname.endsWith("/js/env.js")) {
    event.respondWith(networkFirstRuntime(request));
    return;
  }

  // Supabase REST / Edge Functions: always network-only.
  // Caching API responses (esp. with ignoreSearch) caused stale shift/date data.
  if (isApiRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (!isSameOrigin) {
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidateAsset(request));
    return;
  }

  if (isHtmlPage(url)) {
    if (request.mode === "navigate") {
      event.respondWith(networkFirstNavigate(event));
    } else {
      event.respondWith(staleWhileRevalidateStatic(request, DYNAMIC_CACHE, CACHE_LIMITS.dynamic));
    }
    return;
  }

  event.respondWith(networkWithCacheFallback(request));
});

function isApiRequest(url) {
  return API_PATTERNS.some((pattern) => pattern.test(url.pathname));
}

function isStaticAsset(url) {
  return [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".woff", ".woff2"].some(
    (ext) => url.pathname.endsWith(ext)
  );
}

function isHtmlPage(url) {
  return url.pathname.endsWith(".html") || url.pathname === "/" || !url.pathname.includes(".");
}

async function networkFirstNavigate(event) {
  const request = event.request;

  try {
    const preload = await event.preloadResponse;
    if (preload && preload.ok) {
      void putAndTrim(DYNAMIC_CACHE, request, preload.clone(), CACHE_LIMITS.dynamic);
      return preload;
    }
  } catch {
    /* preload unavailable */
  }

  // Network-only while online — no timeout fallback to stale HTML (that caused old UI).
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      void putAndTrim(DYNAMIC_CACHE, request, networkResponse.clone(), CACHE_LIMITS.dynamic);
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    // start_url / shortcuts use ?source=pwa — fall back to the precached HTML shell.
    const shell = await caches.match(request, OFFLINE_MATCH_OPTS);
    if (shell) return shell;

    return getOfflineFallback();
  }
}

async function revalidateRequest(cache, request, cacheName, maxEntries) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
      if (maxEntries) void trimCache(cacheName, maxEntries, cache);
    }
    return networkResponse;
  } catch {
    return null;
  }
}

/**
 * Stale-while-revalidate: serve cache immediately for speed, refresh in background.
 * Exact URL match so ?v= query busting works. Precache is never LRU-trimmed.
 */
async function staleWhileRevalidateAsset(request) {
  const staticCache = await caches.open(STATIC_CACHE);
  const precached = await staticCache.match(request);
  if (precached) {
    const now = Date.now();
    if (now - (revalidateAt.get(request.url) || 0) >= REVALIDATE_MS) {
      revalidateAt.set(request.url, now);
      void revalidateRequest(staticCache, request);
    }
    return precached;
  }

  return staleWhileRevalidateStatic(request, RUNTIME_CACHE, CACHE_LIMITS.runtime);
}

async function staleWhileRevalidateStatic(
  request,
  cacheName = RUNTIME_CACHE,
  maxEntries = CACHE_LIMITS.runtime
) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  const now = Date.now();
  const lastAt = revalidateAt.get(request.url) || 0;
  const shouldRevalidate = !cachedResponse || now - lastAt >= REVALIDATE_MS;

  if (!shouldRevalidate) {
    return cachedResponse || fetch(request);
  }

  revalidateAt.set(request.url, now);

  const networkPromise = revalidateRequest(cache, request, cacheName, maxEntries);

  if (cachedResponse) {
    void networkPromise;
    return cachedResponse;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;

  return new Response("Resource not available offline", { status: 503 });
}

async function networkFirstRuntime(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;
    return new Response("/* unavailable offline */", {
      status: 503,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }
}

async function networkWithCacheFallback(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      void putAndTrim(DYNAMIC_CACHE, request, networkResponse.clone(), CACHE_LIMITS.dynamic);
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;
    return getOfflineFallback();
  }
}

async function getOfflineFallback() {
  const offline = await caches.match(resolveScopedUrl("offline.html"), OFFLINE_MATCH_OPTS);
  if (offline) return offline;

  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title></head><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>You are offline</h1><p>Reconnect and try again.</p><button onclick="location.reload()">Try again</button></body></html>`,
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}

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

    case "GET_CACHE_STATS":
      getCacheStats().then((stats) => {
        event.ports[0]?.postMessage(stats);
      });
      break;

    case "GET_VERSION":
      event.ports[0]?.postMessage({ version: CACHE_VERSION });
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

async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames.filter((name) => name.startsWith("bpf-")).map((name) => caches.delete(name))
  );
}

async function getCacheStats() {
  const stats = {
    version: CACHE_VERSION,
    static: { entries: 0 },
    runtime: { entries: 0 },
    dynamic: { entries: 0 },
  };

  try {
    const staticCache = await caches.open(STATIC_CACHE);
    stats.static.entries = (await staticCache.keys()).length;
    const runtimeCache = await caches.open(RUNTIME_CACHE);
    stats.runtime.entries = (await runtimeCache.keys()).length;
    const dynamicCache = await caches.open(DYNAMIC_CACHE);
    stats.dynamic.entries = (await dynamicCache.keys()).length;
  } catch {
    /* ignore */
  }

  return stats;
}

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
