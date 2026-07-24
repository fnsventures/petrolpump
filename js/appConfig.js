/**
 * Shared application constants. Loaded before feature scripts on pages that need them.
 */
(function (global) {
  const GST_SLABS = [
    { key: "non_gst", label: "NON GST", pct: -1 },
    { key: "nil", label: "NIL RATE", pct: 0 },
    { key: "r5", label: "5%", pct: 5 },
    { key: "r12", label: "12%", pct: 12 },
    { key: "r18", label: "18%", pct: 18 },
    { key: "r24", label: "24%", pct: 24 },
    { key: "r28", label: "28%", pct: 28 },
  ];

  const PRODUCT_UNITS = ["Pcs", "Ltr", "Kg", "Box", "Set", "Nos"];

  const DEFAULT_PUMP_CONFIG = {
    petrol: { pumps: 2, nozzlesPerPump: 2, tankLabel: "MS (Petrol)", tankCapacity: "15KL" },
    diesel: { pumps: 2, nozzlesPerPump: 2, tankLabel: "HSD", tankCapacity: "20KL" },
  };

  /** One physical tank per product (this station: 1× HSD + 1× MS). */
  const DEFAULT_REPORT_TANKS = [
    { key: "hsd", label: "HSD", product: "diesel", capacity: "20KL" },
    { key: "ms", label: "MS", product: "petrol", capacity: "15KL" },
  ];

  const DEFAULT_STATION = {
    displayName: "Bishnupriya Fuels",
    legalName: "BISHNU PRIYA FUELS",
    brandShort: "Bishnu Priya",
    brandAccent: "Fuels",
    tagline: "Authorized Dealer — Bharat Petroleum Corporation Ltd.",
    address:
      "Plot No. 1541, Khata No. 445/94, Mouza Padmanavpur, Taluka Balichandrapur",
    email: "cmbfillingstation@gmail.com",
    mobile: "+91 96689 13299",
    gstin: "21BBNPR7397L3ZR",
    license: "P/EC/OR/14/2557 (P459205)",
    /** EPFO establishment / employer PF registration (shown on salary slips). */
    pfEstablishmentCode: "",
    /** Statutory PF rates (% of monthly salary used as PF wage). */
    pfEmployeeRate: 12,
    pfEmployerRate: 12,
    supportEmail: "official@fnsventures.in",
    supportWhatsapp: "+91 96689 13299",
  };

  const DEFAULT_BILLING = {
    invoicePrefix: "CRI/",
    defaultPartyName: "Cash A/c",
    defaultFuelGstPct: 18,
    receiptHistoryStart: "2000-01-01",
    /** When true, lube/billing invoices appear in GST sales summary & detail reports. */
    includeInGstReports: true,
  };

  const DEFAULT_ALERTS = {
    lowStockPetrol: 5000,
    lowStockDiesel: 5000,
    highCredit: 0,
    highVariation: 0,
    dayClosingReminder: true,
    /** Treat day closing short above this amount (₹) as a shortage. 0 = any positive short. */
    dayClosingShortage: 0,
    /** Show dashboard alert when today's saved short exceeds dayClosingShortage. */
    shortageAlert: true,
  };

  const DEFAULT_SHIFTS = {
    morning: { name: "Morning shift", start: "06:00", end: "14:00" },
    afternoon: { name: "Afternoon shift", start: "14:00", end: "22:00" },
  };

  const DEFAULT_REPORTS = {
    tanks: DEFAULT_REPORT_TANKS,
    fuelGstPct: 18,
    /** BPCL-style VAT/LST on fuel purchases (MS / HSD). */
    petrolPurchaseVatPct: 28,
    dieselPurchaseVatPct: 24,
    /** Transport / delivery on inward fuel (₹ per kilolitre). */
    purchaseDeliveryPerKl: 600,
    /** false = rate is pre-tax (BPCL invoice); true = rate includes tax. */
    purchaseTaxInclusive: false,
    fuelSupplierLabel: "BPCL / Fuel supplier",
    /** Default supplier GSTIN shown on purchase GST detail when receipt row has none. */
    fuelSupplierGstin: "",
    /** @deprecated use billing.includeInGstReports */
    includeBillingInGst: true,
  };

  const DEFAULT_INTEGRATIONS = {
    googleDrive: {
      enabled: false,
      rootFolderId: "",
    },
  };

  /** Full default settings object (DB seed + client fallback). */
  const DEFAULT_PUMP_SETTINGS = {
    station: DEFAULT_STATION,
    billing: DEFAULT_BILLING,
    pumps: DEFAULT_PUMP_CONFIG,
    reports: DEFAULT_REPORTS,
    alerts: DEFAULT_ALERTS,
    shifts: DEFAULT_SHIFTS,
    integrations: DEFAULT_INTEGRATIONS,
  };

  /** Legacy localStorage keys (migrated to pump_settings on load). */
  const STORAGE_KEYS = {
    lowStockPetrol: "petrolpump_low_stock_threshold_petrol",
    lowStockDiesel: "petrolpump_low_stock_threshold_diesel",
    alertHighCredit: "petrolpump_alert_high_credit",
    alertHighVariation: "petrolpump_alert_high_variation",
    alertDayClosing: "petrolpump_alert_day_closing_reminder",
    shiftMorningName: "petrolpump_shift_morning_name",
    shiftMorningStart: "petrolpump_shift_morning_start",
    shiftMorningEnd: "petrolpump_shift_morning_end",
    shiftAfternoonName: "petrolpump_shift_afternoon_name",
    shiftAfternoonStart: "petrolpump_shift_afternoon_start",
    shiftAfternoonEnd: "petrolpump_shift_afternoon_end",
  };

  /** Topbar / compact logo (44×44). */
  const STATION_LOGO_SRC = "assets/logo-44.webp";
  /** Invoice, staff ID, and other large logo slots (80×80). */
  const STATION_LOGO_LG_SRC = "assets/logo-80.webp";
  /** Print / PDF letterhead (192×192 WebP — sharp at ~28 mm on A4 stationery). */
  const STATION_LOGO_PRINT_SRC = "assets/logo-print.webp";
  /** @deprecated Use STATION_LOGO_SRC — kept for backward compatibility. */
  const BPCL_LOGO_SRC = STATION_LOGO_SRC;

  function getStationLogoPrintSrc() {
    return STATION_LOGO_PRINT_SRC || STATION_LOGO_LG_SRC || STATION_LOGO_SRC;
  }

  const AppConfig = {
    STATION_LOGO_SRC,
    STATION_LOGO_LG_SRC,
    STATION_LOGO_PRINT_SRC,
    getStationLogoPrintSrc,
    BPCL_LOGO_SRC,
    GST_SLABS,
    PRODUCT_UNITS,
    DEFAULT_PUMP_CONFIG,
    DEFAULT_PUMP_SETTINGS,
    DEFAULT_STATION,
    DEFAULT_BILLING,
    DEFAULT_ALERTS,
    DEFAULT_SHIFTS,
    DEFAULT_REPORTS,
    DEFAULT_REPORT_TANKS,
    DEFAULT_INTEGRATIONS,
    STORAGE_KEYS,
    RECEIPT_HISTORY_START: DEFAULT_BILLING.receiptHistoryStart,
  };

  global.AppConfig = AppConfig;
  global.GST_SLABS = GST_SLABS;
})(typeof window !== "undefined" ? window : globalThis);
