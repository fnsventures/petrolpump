/**
 * Service Worker — Bishnupriya Fuels (standard PWA patterns)
 *
 * Strategies (performance-first for a financial ops MPA):
 * - App shell: precache on install (lean; no full-site dump)
 * - Static JS/CSS/fonts/images: cache-first + runtime LRU trim
 * - HTML navigations: network-first with timeout → cache → offline.html
 * - Supabase REST/Functions: network-only for sensitive tables; network-first+TTL otherwise
 * - Updates: waiting worker until client sends SKIP_WAITING (no mid-session swap)
 */

const CACHE_VERSION = "v174";
const STATIC_CACHE = `bpf-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `bpf-dynamic-${CACHE_VERSION}`;
const API_CACHE = `bpf-api-${CACHE_VERSION}`;

/** Max entries for runtime caches (prevents unbounded growth on desktop). */
const CACHE_LIMITS = {
  dynamic: 40,
  staticRuntime: 80,
  api: 30,
};

/** Abort slow navigations so flaky networks fall back to cache instead of hanging. */
const NAV_TIMEOUT_MS = 3500;
const API_TIMEOUT_MS = 8000;

/**
 * True app shell only. Page modules are runtime-cached on first visit.
 * env.js is never cached (see fetch handler).
 */
const STATIC_ASSET_PATHS = [
  "offline.html",
  "index.html",
  "login.html",
  "dashboard.html",
  "404.html",
  "manifest.json",
  "css/base.css",
  "css/fonts.css",
  "css/landing.css",
  "css/login.css",
  "css/app-core.css",
  "css/app-dashboard.css",
  "assets/favicon-32.png",
  "assets/apple-touch-icon.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/logo-44.webp",
  "assets/logo-104.webp",
  "fonts/dm-sans-latin.woff2",
  "fonts/source-serif-4-latin.woff2",
  "js/vendor/supabase-login.min.js",
  "js/vendor/supabase.min.js",
  "js/roleBootstrap.js",
  "js/appNav.js",
  "js/errorHandler.js",
  "js/pwa.js",
  "js/cache.js",
  "js/appConfig.js",
  "js/utils.js",
  "js/pumpSettings.js",
  "js/supabase.js",
  "js/auth.js",
  "js/pageSections.js",
];

const CACHE_MATCH_OPTS = { ignoreSearch: true };

const API_PATTERNS = [/\/rest\/v1\//, /\/functions\/v1\//];

const CACHE_TTL = {
  api: 2 * 60 * 1000,
};

function getScopeBase() {
  const scope = self.registration?.scope || new URL("./", self.location.href).href;
  return scope.endsWith("/") ? scope : `${scope}/`;
}

function resolveScopedUrl(path) {
  if (!path || path.startsWith("http")) return path;
  const clean = String(path).replace(/^\//, "");
  return new URL(clean, getScopeBase()).href;
}

async function trimCache(cacheName, maxEntries) {
  if (!maxEntries || maxEntries < 1) return;
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const excess = keys.length - maxEntries;
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  } catch {
    /* ignore */
  }
}

async function putAndTrim(cacheName, request, response, maxEntries) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  await trimCache(cacheName, maxEntries);
}

function fetchWithTimeout(request, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
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
      // First install: activate immediately. Updates: wait for SKIP_WAITING from the page.
      if (!self.registration.active) {
        await self.skipWaiting();
      }
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
              name !== DYNAMIC_CACHE &&
              name !== API_CACHE
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
    event.respondWith(fetch(request));
    return;
  }

  if (isApiRequest(url)) {
    if (isNoCacheApiRequest(url)) {
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(networkFirstApi(request));
    return;
  }

  if (!isSameOrigin) {
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }

  if (isHtmlPage(url)) {
    if (request.mode === "navigate") {
      event.respondWith(networkFirstNavigate(event));
    } else {
      event.respondWith(cacheFirstStatic(request, DYNAMIC_CACHE, CACHE_LIMITS.dynamic));
    }
    return;
  }

  event.respondWith(networkWithCacheFallback(request));
});

function isApiRequest(url) {
  return API_PATTERNS.some((pattern) => pattern.test(url.pathname));
}

function isNoCacheApiRequest(url) {
  const path = url.pathname;
  const table = url.searchParams?.get("table") ?? "";
  const noCacheTables = [
    "credit_customers",
    "credit_entries",
    "credit_payments",
    "employees",
    "users",
    "employee_attendance",
    "salary_payments",
    "dsr",
    "dsr_petrol",
    "dsr_diesel",
    "expenses",
    "day_closing",
    "night_cash_collections",
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

function isStaticAsset(url) {
  return [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".woff", ".woff2"].some(
    (ext) => url.pathname.endsWith(ext)
  );
}

function isHtmlPage(url) {
  return url.pathname.endsWith(".html") || url.pathname === "/" || !url.pathname.includes(".");
}

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
  await trimCache(API_CACHE, CACHE_LIMITS.api);
}

async function networkFirstApi(request) {
  try {
    const networkResponse = await fetchWithTimeout(request, API_TIMEOUT_MS);
    if (networkResponse.ok) {
      const cache = await caches.open(API_CACHE);
      await putApiCacheEntry(cache, request, networkResponse);
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);
    if (cachedResponse && isApiCacheFresh(cachedResponse)) {
      return cachedResponse;
    }
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

  try {
    const networkResponse = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
    if (networkResponse.ok) {
      void putAndTrim(DYNAMIC_CACHE, request, networkResponse.clone(), CACHE_LIMITS.dynamic);
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);
    if (cachedResponse) return cachedResponse;

    const offline = await caches.match(resolveScopedUrl("offline.html"), CACHE_MATCH_OPTS);
    if (offline) return offline;

    return getOfflineFallback();
  }
}

async function cacheFirstStatic(request, cacheName = STATIC_CACHE, maxEntries = CACHE_LIMITS.staticRuntime) {
  const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);
  if (cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      void putAndTrim(cacheName, request, networkResponse.clone(), maxEntries);
    }
    return networkResponse;
  } catch {
    return new Response("Resource not available offline", { status: 503 });
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
    const cachedResponse = await caches.match(request, CACHE_MATCH_OPTS);
    if (cachedResponse) return cachedResponse;
    return getOfflineFallback();
  }
}

async function getOfflineFallback() {
  const offline = await caches.match(resolveScopedUrl("offline.html"), CACHE_MATCH_OPTS);
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
    dynamic: { entries: 0 },
    api: { entries: 0 },
  };

  try {
    const staticCache = await caches.open(STATIC_CACHE);
    stats.static.entries = (await staticCache.keys()).length;
    const dynamicCache = await caches.open(DYNAMIC_CACHE);
    stats.dynamic.entries = (await dynamicCache.keys()).length;
    const apiCache = await caches.open(API_CACHE);
    stats.api.entries = (await apiCache.keys()).length;
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
