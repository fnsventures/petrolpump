/**
 * Data caching utility for Petrol Pump application.
 * Provides localStorage caching with TTL, stale-while-revalidate pattern,
 * and cache invalidation utilities.
 */

/** Live ops data types — shared by AppCache and CacheInvalidation. */
const BPF_OPERATIONAL_CACHE_TYPES = [
  "dashboard_data",
  "credit_summary",
  "credit_overview",
  "today_sales",
  "recent_activity",
  "dsr_summary",
  "profit_loss",
  "reports_data",
  "missing_buying_price",
];

const AppCache = (function () {
  const CACHE_PREFIX = "bpf_cache_";
  const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes default TTL
  const STALE_TTL = 30 * 60 * 1000; // 30 minutes stale window

  // Cache TTL configurations for different data types
  const CACHE_CONFIG = {
    // Static reference data - long TTL
    staff_role: { ttl: 60 * 60 * 1000, staleTtl: 24 * 60 * 60 * 1000 }, // 1 hour, 24h stale
    staff_list: { ttl: 10 * 60 * 1000, staleTtl: 60 * 60 * 1000 }, // 10 min, 1h stale

    // Ops data — very short TTL; tight stale window to avoid showing old shift data
    dashboard_data: { ttl: 30 * 1000, staleTtl: 60 * 1000 },
    credit_summary: { ttl: 30 * 1000, staleTtl: 60 * 1000 },
    credit_overview: { ttl: 30 * 1000, staleTtl: 60 * 1000 },
    today_sales: { ttl: 15 * 1000, staleTtl: 45 * 1000 },
    recent_activity: { ttl: 15 * 1000, staleTtl: 45 * 1000 },
    missing_buying_price: { ttl: 30 * 1000, staleTtl: 60 * 1000 },

    dsr_summary: { ttl: 30 * 1000, staleTtl: 60 * 1000 },
    profit_loss: { ttl: 30 * 1000, staleTtl: 60 * 1000 },

    // Settings & auth — longer TTL, revalidated on save
    pump_settings: { ttl: 10 * 60 * 1000, staleTtl: 60 * 60 * 1000 },
    user_role: { ttl: 30 * 60 * 1000, staleTtl: 2 * 60 * 60 * 1000 },

    reports_data: { ttl: 30 * 1000, staleTtl: 60 * 1000 },
  };

  /** In-flight fetch deduplication — prevents parallel SWR storms for the same key. */
  const inflightFetches = new Map();

  const CACHE_SYNC_KEY = "bpf_cache_sync";
  let cacheBroadcast = null;

  function getCacheBroadcast() {
    if (cacheBroadcast === null && typeof BroadcastChannel !== "undefined") {
      cacheBroadcast = new BroadcastChannel("bpf_cache_invalidate");
    }
    return cacheBroadcast;
  }

  /** Operational cache types cleared on reconnect / resume. */
  const OPERATIONAL_TYPES = BPF_OPERATIONAL_CACHE_TYPES;

  /** Memoized — probing localStorage on every get/set was a hot-path cost. */
  let storageAvailable = null;

  /**
   * Check if localStorage is available
   */
  function isStorageAvailable() {
    if (storageAvailable !== null) return storageAvailable;
    try {
      const test = "__storage_test__";
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      storageAvailable = true;
    } catch (e) {
      storageAvailable = false;
    }
    return storageAvailable;
  }

  /**
   * Get cache key with prefix
   */
  function getCacheKey(key) {
    return CACHE_PREFIX + key;
  }

  /**
   * Get TTL configuration for a cache type
   */
  function getConfig(cacheType) {
    return CACHE_CONFIG[cacheType] || { ttl: DEFAULT_TTL, staleTtl: STALE_TTL };
  }

  /**
   * Store data in cache with metadata
   */
  function set(key, data, cacheType = null) {
    if (!isStorageAvailable()) return false;

    const config = cacheType ? getConfig(cacheType) : { ttl: DEFAULT_TTL, staleTtl: STALE_TTL };
    const now = Date.now();
    const cacheEntry = {
      data: data,
      timestamp: now,
      expiresAt: now + config.ttl,
      staleAt: now + config.staleTtl,
      cacheType: cacheType,
    };

    try {
      localStorage.setItem(getCacheKey(key), JSON.stringify(cacheEntry));
      return true;
    } catch (e) {
      // Handle quota exceeded - clear old entries
      if (e.name === "QuotaExceededError") {
        clearOldEntries();
        try {
          localStorage.setItem(getCacheKey(key), JSON.stringify(cacheEntry));
          return true;
        } catch {
          console.warn("Cache storage failed after cleanup:", key);
          return false;
        }
      }
      console.warn("Cache storage failed:", key, e);
      return false;
    }
  }

  /**
   * Get data from cache
   * @returns {Object} { data, isStale, isExpired, isMiss }
   */
  function get(key) {
    if (!isStorageAvailable()) {
      return { data: null, isStale: false, isExpired: true, isMiss: true };
    }

    try {
      const raw = localStorage.getItem(getCacheKey(key));
      if (!raw) {
        return { data: null, isStale: false, isExpired: true, isMiss: true };
      }

      const entry = JSON.parse(raw);
      const now = Date.now();

      // Beyond stale window — treat as miss so callers never keep showing dead data
      if (now > entry.staleAt) {
        localStorage.removeItem(getCacheKey(key));
        return { data: null, isStale: false, isExpired: true, isMiss: true };
      }

      // Expired but within stale window (SWR may return this while revalidating)
      if (now > entry.expiresAt) {
        return { data: entry.data, isStale: true, isExpired: true, isMiss: false };
      }

      // Fresh data
      return { data: entry.data, isStale: false, isExpired: false, isMiss: false };
    } catch (e) {
      console.warn("Cache read failed:", key, e);
      return { data: null, isStale: false, isExpired: true, isMiss: true };
    }
  }

  /**
   * Remove a specific cache entry
   */
  function remove(key) {
    if (!isStorageAvailable()) return;
    try {
      localStorage.removeItem(getCacheKey(key));
    } catch {
      // Ignore
    }
  }

  /**
   * Clear all cache entries with our prefix
   */
  function clearAll() {
    if (!isStorageAvailable()) return;
    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (key.startsWith(CACHE_PREFIX)) {
          localStorage.removeItem(key);
        }
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Clear old/expired cache entries
   */
  function clearOldEntries() {
    if (!isStorageAvailable()) return;
    const now = Date.now();
    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (!key.startsWith(CACHE_PREFIX)) return;
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return;
          const entry = JSON.parse(raw);
          // Remove if beyond stale window
          if (now > entry.staleAt) {
            localStorage.removeItem(key);
          }
        } catch {
          // Remove corrupted entries
          localStorage.removeItem(key);
        }
      });
    } catch {
      // Ignore
    }
  }

  /**
   * Invalidate cache entries by type (single type or many in one localStorage pass)
   */
  function invalidateByType(cacheType) {
    invalidateByTypes([cacheType]);
  }

  function invalidateByTypes(cacheTypes) {
    if (!isStorageAvailable() || !cacheTypes?.length) return;
    const typeSet = new Set(cacheTypes);
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(CACHE_PREFIX)) continue;
        try {
          const entry = JSON.parse(localStorage.getItem(key));
          if (typeSet.has(entry.cacheType)) localStorage.removeItem(key);
        } catch {
          localStorage.removeItem(key);
        }
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  function invalidateByPattern(pattern) {
    if (!isStorageAvailable()) return;
    try {
      const keys = Object.keys(localStorage);
      const regex = new RegExp(pattern);
      keys.forEach((key) => {
        if (key.startsWith(CACHE_PREFIX) && regex.test(key)) {
          localStorage.removeItem(key);
        }
      });
    } catch {
      // Ignore
    }
  }

  function clearInflight(key) {
    if (key) inflightFetches.delete(key);
    else inflightFetches.clear();
  }

  function runDedupedFetch(key, fetchFn, cacheType, onUpdate) {
    if (inflightFetches.has(key)) {
      return inflightFetches.get(key);
    }

    const generation =
      typeof window.getAppLoadGeneration === "function" ? window.getAppLoadGeneration() : 0;

    const promise = Promise.resolve()
      .then(() => fetchFn())
      .then((freshData) => {
        if (freshData !== null && freshData !== undefined) {
          set(key, freshData, cacheType);
          if (onUpdate && typeof onUpdate === "function") {
            const currentGen =
              typeof window.getAppLoadGeneration === "function"
                ? window.getAppLoadGeneration()
                : generation;
            if (currentGen === generation) {
              onUpdate(freshData);
            }
          }
        }
        return freshData;
      })
      .finally(() => {
        if (inflightFetches.get(key) === promise) {
          inflightFetches.delete(key);
        }
      });

    inflightFetches.set(key, promise);
    return promise;
  }

  /**
   * Stale-while-revalidate pattern implementation
   * Returns cached data immediately while fetching fresh data in background
   *
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch fresh data
   * @param {string} cacheType - Cache type for TTL configuration
   * @param {Function} onUpdate - Optional callback when fresh data arrives
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<any>} - Returns cached data or fresh data
   */
  async function getWithSWR(key, fetchFn, cacheType = null, onUpdate = null, options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const revalidate = Boolean(options.revalidate);
    const cached = forceRefresh ? { data: null, isStale: true, isExpired: true, isMiss: true } : get(key);

    // If we have cached data (even stale), return it
    if (!cached.isMiss && cached.data !== null) {
      // Revalidate when stale/expired or caller requests background refresh (e.g. after resume)
      if (cached.isStale || cached.isExpired || revalidate) {
        runDedupedFetch(key, fetchFn, cacheType, onUpdate).catch((err) => {
          console.warn("Background revalidation failed:", key, err);
        });
      }
      return cached.data;
    }

    // No cached data — fetch fresh (deduped)
    try {
      return await runDedupedFetch(key, fetchFn, cacheType, onUpdate);
    } catch (err) {
      if (typeof window.AppError !== "undefined" && window.AppError.report) {
        window.AppError.report(err, { context: "AppCache.getWithSWR", key });
      } else {
        console.error("Fetch failed with no cached fallback:", key, err);
      }
      throw err;
    }
  }

  /**
   * Invalidate all operational (live) data caches — call on reconnect or resume.
   * @param {{ broadcast?: boolean }} [options]
   */
  function invalidateOperational(options = {}) {
    invalidateByTypes(OPERATIONAL_TYPES);
    clearInflight();
    if (options.broadcast !== false) {
      broadcastInvalidation(OPERATIONAL_TYPES);
    }
  }

  function broadcastInvalidation(types) {
    if (!types?.length) return;
    const payload = { types: [...types], at: Date.now() };
    try {
      getCacheBroadcast()?.postMessage(payload);
      localStorage.setItem(CACHE_SYNC_KEY, JSON.stringify(payload));
    } catch {
      /* private mode / quota */
    }
  }

  function applyRemoteInvalidation(payload) {
    if (!payload?.types?.length) return;
    invalidateByTypes(payload.types);
    clearInflight();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bpf:cache-invalidate", { detail: payload }));
    }
  }

  function initCrossTabSync() {
    if (typeof window === "undefined") return;

    getCacheBroadcast()?.addEventListener("message", (event) => {
      applyRemoteInvalidation(event.data);
    });

    window.addEventListener("storage", (event) => {
      if (event.key !== CACHE_SYNC_KEY || !event.newValue) return;
      try {
        applyRemoteInvalidation(JSON.parse(event.newValue));
      } catch {
        /* ignore corrupt payload */
      }
    });
  }

  /**
   * Get cache statistics
   */
  function getStats() {
    if (!isStorageAvailable()) {
      return { entries: 0, size: 0, expired: 0, stale: 0 };
    }

    const now = Date.now();
    let entries = 0;
    let size = 0;
    let expired = 0;
    let stale = 0;

    try {
      const keys = Object.keys(localStorage);
      keys.forEach((key) => {
        if (!key.startsWith(CACHE_PREFIX)) return;
        const raw = localStorage.getItem(key);
        if (!raw) return;

        entries++;
        size += raw.length * 2; // Approximate bytes (2 bytes per char)

        try {
          const entry = JSON.parse(raw);
          if (now > entry.staleAt) {
            expired++;
            stale++;
          } else if (now > entry.expiresAt) {
            stale++;
          }
        } catch {
          expired++;
        }
      });
    } catch {
      // Ignore
    }

    return { entries, size, expired, stale };
  }

  initCrossTabSync();

  // Public API
  return {
    set,
    get,
    remove,
    clearAll,
    clearOldEntries,
    invalidateByType,
    invalidateByTypes,
    invalidateByPattern,
    invalidateOperational,
    broadcastInvalidation,
    getWithSWR,
    getStats,
    clearInflight,
    isStorageAvailable,
    CACHE_CONFIG,
    OPERATIONAL_TYPES,
  };
})();

// Export for use in other modules
window.AppCache = AppCache;

/**
 * Centralized cache invalidation scopes for mutations.
 * Use instead of scattering invalidateByType calls across page modules.
 */
const CacheInvalidation = (function () {
  const SCOPES = {
    operational: ["dashboard_data", "recent_activity"],
    dsr: ["dashboard_data", "today_sales", "dsr_summary", "profit_loss", "reports_data", "missing_buying_price"],
    credit: ["credit_summary", "credit_overview", "dashboard_data", "recent_activity"],
    reports: ["reports_data", "profit_loss", "dashboard_data"],
    staff: ["staff_list"],
    pump_settings: ["pump_settings", "reports_data", "profit_loss", "dashboard_data"],
    all_api: BPF_OPERATIONAL_CACHE_TYPES,
  };

  function notifyLocalInvalidation(types) {
    if (typeof window === "undefined" || !types?.length) return;
    window.dispatchEvent(
      new CustomEvent("bpf:cache-invalidate", { detail: { types: [...types], at: Date.now(), local: true } })
    );
  }

  function invalidate(scope, options = {}) {
    if (typeof AppCache === "undefined" || !AppCache) return;
    const types = SCOPES[scope] || (Array.isArray(scope) ? scope : [scope]);
    const unique = [...new Set(types)];
    if (AppCache.invalidateByTypes) {
      AppCache.invalidateByTypes(unique);
    } else {
      unique.forEach((t) => AppCache.invalidateByType(t));
    }
    if (AppCache.clearInflight) AppCache.clearInflight();
    notifyLocalInvalidation(unique);
    if (options.broadcast !== false && AppCache.broadcastInvalidation) {
      AppCache.broadcastInvalidation(unique);
    }
  }

  function invalidateMultiple(scopes, options = {}) {
    const seen = new Set();
    scopes.forEach((scope) => {
      (SCOPES[scope] || (Array.isArray(scope) ? scope : [scope])).forEach((t) => seen.add(t));
    });
    const unique = [...seen];
    if (AppCache.invalidateByTypes) {
      AppCache.invalidateByTypes(unique);
    } else {
      unique.forEach((t) => AppCache.invalidateByType(t));
    }
    if (AppCache.clearInflight) AppCache.clearInflight();
    notifyLocalInvalidation(unique);
    if (options.broadcast !== false && AppCache.broadcastInvalidation) {
      AppCache.broadcastInvalidation(unique);
    }
  }

  return { invalidate, invalidateMultiple, SCOPES };
})();

window.CacheInvalidation = CacheInvalidation;

// Prune expired entries on load — keeps localStorage fast on mobile.
if (typeof AppCache !== "undefined" && AppCache.clearOldEntries) {
  try {
    AppCache.clearOldEntries();
  } catch {
    /* ignore */
  }
}
