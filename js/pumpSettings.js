/**
 * Central pump/station settings: DB-backed with in-memory cache and localStorage migration.
 */
(function (global) {
  const SETTINGS_ROW_ID = 1;
  const CACHE_KEY = "pump_settings_v1";

  let cached = null;
  let loadPromise = null;

  function deepMerge(base, patch) {
    if (patch == null || typeof patch !== "object" || Array.isArray(patch)) return base;
    const out = Array.isArray(base) ? [...(base || [])] : { ...(base || {}) };
    Object.keys(patch).forEach((key) => {
      const pv = patch[key];
      const bv = out[key];
      // Use == null / typeof checks so boolean false and 0 are preserved as values.
      if (
        pv !== null &&
        typeof pv === "object" &&
        !Array.isArray(pv) &&
        bv !== null &&
        typeof bv === "object" &&
        !Array.isArray(bv)
      ) {
        out[key] = deepMerge(bv, pv);
      } else if (pv !== undefined) {
        out[key] = pv;
      }
    });
    return out;
  }

  function cloneDefaults() {
    try {
      return JSON.parse(JSON.stringify(AppConfig.DEFAULT_PUMP_SETTINGS));
    } catch (_) {
      return deepMerge({}, AppConfig.DEFAULT_PUMP_SETTINGS);
    }
  }

  function getDefaults() {
    return cloneDefaults();
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

  /**
   * Collapse legacy multi-section tanks (HSD 1 / HSD 2) to one row per product,
   * using physical pump tank label/capacity when available.
   */
  function normalizeReportTanks(tanks, pumps) {
    const list = Array.isArray(tanks) ? tanks : [];
    const dieselCfg = list.find((t) => t && t.product === "diesel") || {};
    const petrolCfg = list.find((t) => t && t.product === "petrol") || {};
    const dieselPump = pumps?.diesel || {};
    const petrolPump = pumps?.petrol || {};
    return [
      {
        key: "hsd",
        label: dieselPump.tankLabel || dieselCfg.label || "HSD",
        product: "diesel",
        capacity: dieselPump.tankCapacity || dieselCfg.capacity || "20KL",
      },
      {
        key: "ms",
        label: petrolPump.tankLabel || petrolCfg.label || "MS",
        product: "petrol",
        capacity: petrolPump.tankCapacity || petrolCfg.capacity || "15KL",
      },
    ];
  }

  function normalize(settings) {
    const merged = deepMerge(getDefaults(), settings || {});
    if (!merged.reports) merged.reports = {};
    merged.reports.tanks = normalizeReportTanks(merged.reports.tanks, merged.pumps);
    return merged;
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
          // defaults ← legacy ← DB (DB wins, including explicit false toggles)
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

    // Invalidate stale entries first, then write the saved config back into cache so
    // subsequent reads (and form re-bind) keep the values just persisted — including `false`.
    if (typeof CacheInvalidation !== "undefined") {
      CacheInvalidation.invalidate("pump_settings");
    } else if (typeof AppCache !== "undefined" && AppCache) {
      AppCache.remove(CACHE_KEY);
      AppCache.invalidateByType("pump_settings");
    }
    cacheInMemory(next);
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
    const d = AppConfig.DEFAULT_ALERTS;
    const shortage =
      Number(a.dayClosingShortage) >= 0
        ? Number(a.dayClosingShortage)
        : d.dayClosingShortage;
    const nightCashMin =
      Number(a.nightCashMinAmount) >= 0
        ? Number(a.nightCashMinAmount)
        : d.nightCashMinAmount;
    const staleDays =
      Number(a.staleCreditDays) > 0 ? Number(a.staleCreditDays) : d.staleCreditDays;
    const expensePct =
      Number(a.expenseRatioPct) > 0 ? Number(a.expenseRatioPct) : d.expenseRatioPct;
    const invoiceLookback =
      Number(a.missingInvoiceLookbackDays) > 0
        ? Number(a.missingInvoiceLookbackDays)
        : d.missingInvoiceLookbackDays;
    return {
      petrol: Number(a.lowStockPetrol) >= 0 ? Number(a.lowStockPetrol) : d.lowStockPetrol,
      diesel: Number(a.lowStockDiesel) >= 0 ? Number(a.lowStockDiesel) : d.lowStockDiesel,
      highCredit: Number(a.highCredit) || 0,
      individualHighCredit: Number(a.individualHighCredit) || 0,
      highVariation: Number(a.highVariation) || 0,
      dayClosingReminder: a.dayClosingReminder !== false,
      dayClosingShortage: shortage,
      shortageAlert: a.shortageAlert !== false,
      surplusAlert: a.surplusAlert !== false,
      nightCashAlert: a.nightCashAlert !== false,
      nightCashMinAmount: nightCashMin,
      missingMeterAlert: a.missingMeterAlert !== false,
      missingRateAlert: a.missingRateAlert !== false,
      missingDipAlert: a.missingDipAlert !== false,
      staleCreditAlert: a.staleCreditAlert !== false,
      staleCreditDays: staleDays,
      unpaidSalaryAlert: a.unpaidSalaryAlert !== false,
      attendanceAlert: a.attendanceAlert !== false,
      expenseRatioAlert: a.expenseRatioAlert === true,
      expenseRatioPct: expensePct,
      missingInvoiceAlert: a.missingInvoiceAlert !== false,
      missingInvoiceLookbackDays: invoiceLookback,
    };
  }

  const SHORTAGE_EPSILON = 0.005;

  function isDayClosingShortage(amount) {
    const t = getAlertThresholds().dayClosingShortage;
    return Number(amount) > t + SHORTAGE_EPSILON;
  }

  function isDayClosingSurplus(amount) {
    const t = getAlertThresholds().dayClosingShortage;
    return Number(amount) < -(t + SHORTAGE_EPSILON);
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
    isDayClosingShortage,
    isDayClosingSurplus,
    getShiftConfig,
    getReceiptHistoryStart,
    normalize,
  };

  global.PumpSettings = PumpSettings;
  global.loadPumpSettings = loadPumpSettings;
})(typeof window !== "undefined" ? window : globalThis);
