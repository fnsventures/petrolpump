/**
 * Central pump/station settings: DB-backed with in-memory cache and localStorage migration.
 */
(function (global) {
  const SETTINGS_ROW_ID = 1;
  const CACHE_KEY = "pump_settings_v1";

  let cached = null;
  let loadPromise = null;

  function deepMerge(base, patch) {
    if (!patch || typeof patch !== "object") return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    Object.keys(patch).forEach((key) => {
      const pv = patch[key];
      if (pv && typeof pv === "object" && !Array.isArray(pv) && base[key] && typeof base[key] === "object") {
        out[key] = deepMerge(base[key], pv);
      } else if (pv !== undefined) {
        out[key] = pv;
      }
    });
    return out;
  }

  function getDefaults() {
    return AppConfig.DEFAULT_PUMP_SETTINGS;
  }

  function readLegacyLocalStorage() {
    const k = AppConfig.STORAGE_KEYS;
    const patch = {};
    try {
      const alerts = {};
      const lp = localStorage.getItem(k.lowStockPetrol);
      const ld = localStorage.getItem(k.lowStockDiesel);
      if (lp != null && lp !== "") alerts.lowStockPetrol = Number(lp);
      if (ld != null && ld !== "") alerts.lowStockDiesel = Number(ld);
      const hc = localStorage.getItem(k.alertHighCredit);
      const hv = localStorage.getItem(k.alertHighVariation);
      const dc = localStorage.getItem(k.alertDayClosing);
      if (hc != null && hc !== "") alerts.highCredit = Number(hc);
      if (hv != null && hv !== "") alerts.highVariation = Number(hv);
      if (dc != null) alerts.dayClosingReminder = dc !== "false";
      if (Object.keys(alerts).length) patch.alerts = alerts;

      const shifts = {};
      const mn = localStorage.getItem(k.shiftMorningName);
      const ms = localStorage.getItem(k.shiftMorningStart);
      const me = localStorage.getItem(k.shiftMorningEnd);
      const an = localStorage.getItem(k.shiftAfternoonName);
      const as = localStorage.getItem(k.shiftAfternoonStart);
      const ae = localStorage.getItem(k.shiftAfternoonEnd);
      if (mn || ms || me) {
        shifts.morning = {
          name: mn || undefined,
          start: ms || undefined,
          end: me || undefined,
        };
      }
      if (an || as || ae) {
        shifts.afternoon = {
          name: an || undefined,
          start: as || undefined,
          end: ae || undefined,
        };
      }
      if (Object.keys(shifts).length) patch.shifts = shifts;
    } catch (_) {}
    return patch;
  }

  function syncLegacyLocalStorage(settings) {
    const k = AppConfig.STORAGE_KEYS;
    try {
      const a = settings.alerts || {};
      if (a.lowStockPetrol != null) localStorage.setItem(k.lowStockPetrol, String(a.lowStockPetrol));
      if (a.lowStockDiesel != null) localStorage.setItem(k.lowStockDiesel, String(a.lowStockDiesel));
      if (a.highCredit > 0) localStorage.setItem(k.alertHighCredit, String(a.highCredit));
      else localStorage.removeItem(k.alertHighCredit);
      if (a.highVariation > 0) localStorage.setItem(k.alertHighVariation, String(a.highVariation));
      else localStorage.removeItem(k.alertHighVariation);
      localStorage.setItem(k.alertDayClosing, a.dayClosingReminder !== false ? "true" : "false");

      const m = settings.shifts?.morning || {};
      const af = settings.shifts?.afternoon || {};
      if (m.name) localStorage.setItem(k.shiftMorningName, m.name);
      if (m.start) localStorage.setItem(k.shiftMorningStart, m.start);
      if (m.end) localStorage.setItem(k.shiftMorningEnd, m.end);
      if (af.name) localStorage.setItem(k.shiftAfternoonName, af.name);
      if (af.start) localStorage.setItem(k.shiftAfternoonStart, af.start);
      if (af.end) localStorage.setItem(k.shiftAfternoonEnd, af.end);
    } catch (_) {}
  }

  function normalize(settings) {
    return deepMerge(getDefaults(), settings || {});
  }

  function cacheInMemory(settings) {
    cached = normalize(settings);
    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.set(CACHE_KEY, cached, "pump_settings");
    }
    syncLegacyLocalStorage(cached);
    return cached;
  }

  function getCachedSync() {
    if (cached) return cached;
    if (typeof AppCache !== "undefined" && AppCache) {
      const hit = AppCache.get(CACHE_KEY);
      if (!hit.isMiss && hit.data) {
        cached = normalize(hit.data);
        return cached;
      }
    }
    const legacy = readLegacyLocalStorage();
    cached = normalize(legacy);
    return cached;
  }

  async function loadPumpSettings(force) {
    if (cached && !force) return cached;
    if (loadPromise && !force) return loadPromise;

    loadPromise = (async () => {
      if (typeof supabaseClient !== "undefined" && supabaseClient) {
        const { data, error } = await supabaseClient
          .from("pump_settings")
          .select("config")
          .eq("id", SETTINGS_ROW_ID)
          .maybeSingle();

        if (!error && data?.config) {
          const merged = normalize(deepMerge(readLegacyLocalStorage(), data.config));
          return cacheInMemory(merged);
        }
      }
      return cacheInMemory(readLegacyLocalStorage());
    })();

    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  async function savePumpSettings(partial, userId) {
    const current = getCachedSync();
    const next = normalize(deepMerge(current, partial));

    if (typeof supabaseClient !== "undefined" && supabaseClient) {
      const payload = {
        id: SETTINGS_ROW_ID,
        config: next,
        updated_at: new Date().toISOString(),
      };
      if (userId) payload.updated_by = userId;

      const { error } = await supabaseClient.from("pump_settings").upsert(payload, { onConflict: "id" });
      if (error) throw error;
    }

    cacheInMemory(next);
    if (typeof CacheInvalidation !== "undefined") {
      CacheInvalidation.invalidate("pump_settings");
    }
    return next;
  }

  function invalidatePumpSettingsCache() {
    cached = null;
    loadPromise = null;
    if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.remove(CACHE_KEY);
      if (typeof CacheInvalidation !== "undefined") {
        CacheInvalidation.invalidate("pump_settings");
      } else {
        AppCache.invalidateByType("pump_settings");
      }
    }
  }

  function getStationDisplayName() {
    return getCachedSync().station?.displayName || AppConfig.DEFAULT_STATION.displayName;
  }

  function getStation() {
    return getCachedSync().station || AppConfig.DEFAULT_STATION;
  }

  function getStationField(field) {
    const s = getStation();
    const def = AppConfig.DEFAULT_STATION;
    return s[field] ?? def[field];
  }

  function getStationLegalName() {
    return getStationField("legalName");
  }

  function getStationTagline() {
    return getStationField("tagline");
  }

  function getStationGstin() {
    return getStationField("gstin");
  }

  function getStationAddress() {
    return getStationField("address");
  }

  function getStationContactLine() {
    const s = getStation();
    const parts = [];
    if (s.email) parts.push(s.email);
    if (s.mobile) parts.push(s.mobile);
    return parts.join(" · ");
  }

  function getPumpConfig() {
    return getCachedSync().pumps || AppConfig.DEFAULT_PUMP_CONFIG;
  }

  function getAlertThresholds() {
    const a = getCachedSync().alerts || {};
    return {
      petrol: Number(a.lowStockPetrol) >= 0 ? Number(a.lowStockPetrol) : AppConfig.DEFAULT_ALERTS.lowStockPetrol,
      diesel: Number(a.lowStockDiesel) >= 0 ? Number(a.lowStockDiesel) : AppConfig.DEFAULT_ALERTS.lowStockDiesel,
      highCredit: Number(a.highCredit) || 0,
      highVariation: Number(a.highVariation) || 0,
      dayClosingReminder: a.dayClosingReminder !== false,
    };
  }

  function getShiftConfig() {
    const s = getCachedSync().shifts || AppConfig.DEFAULT_SHIFTS;
    return {
      morningName: s.morning?.name || AppConfig.DEFAULT_SHIFTS.morning.name,
      afternoonName: s.afternoon?.name || AppConfig.DEFAULT_SHIFTS.afternoon.name,
      morningStart: s.morning?.start || AppConfig.DEFAULT_SHIFTS.morning.start,
      morningEnd: s.morning?.end || AppConfig.DEFAULT_SHIFTS.morning.end,
      afternoonStart: s.afternoon?.start || AppConfig.DEFAULT_SHIFTS.afternoon.start,
      afternoonEnd: s.afternoon?.end || AppConfig.DEFAULT_SHIFTS.afternoon.end,
    };
  }

  function getReceiptHistoryStart() {
    return getCachedSync().billing?.receiptHistoryStart || AppConfig.RECEIPT_HISTORY_START;
  }

  const PumpSettings = {
    loadPumpSettings,
    savePumpSettings,
    getCachedSync,
    invalidatePumpSettingsCache,
    getStationDisplayName,
    getStation,
    getStationField,
    getStationLegalName,
    getStationTagline,
    getStationGstin,
    getStationAddress,
    getStationContactLine,
    getPumpConfig,
    getAlertThresholds,
    getShiftConfig,
    getReceiptHistoryStart,
    normalize,
  };

  global.PumpSettings = PumpSettings;
  global.loadPumpSettings = loadPumpSettings;
})(typeof window !== "undefined" ? window : globalThis);
