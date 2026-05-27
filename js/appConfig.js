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

  const DEFAULT_REPORT_TANKS = [
    { key: "hsd1", label: "HSD 1", product: "diesel", capacity: "20 Kl" },
    { key: "hsd2", label: "HSD 2", product: "diesel", capacity: "20 Kl" },
    { key: "ms", label: "MS", product: "petrol", capacity: "15 Kl" },
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
    supportEmail: "official@fnsventures.in",
    supportWhatsapp: "+91 96689 13299",
  };

  const DEFAULT_BILLING = {
    invoicePrefix: "CRI/",
    defaultPartyName: "Cash A/c",
    defaultFuelGstPct: 18,
    receiptHistoryStart: "2000-01-01",
  };

  const DEFAULT_ALERTS = {
    lowStockPetrol: 5000,
    lowStockDiesel: 5000,
    highCredit: 0,
    highVariation: 0,
    dayClosingReminder: true,
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
    /** false = rate is pre-tax (BPCL invoice); true = rate includes tax. */
    purchaseTaxInclusive: false,
    fuelSupplierLabel: "BPCL / Fuel supplier",
  };

  /** Full default settings object (DB seed + client fallback). */
  const DEFAULT_PUMP_SETTINGS = {
    station: DEFAULT_STATION,
    billing: DEFAULT_BILLING,
    pumps: DEFAULT_PUMP_CONFIG,
    reports: DEFAULT_REPORTS,
    alerts: DEFAULT_ALERTS,
    shifts: DEFAULT_SHIFTS,
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

  const BPCL_LOGO_SRC = "assets/bpcl-logo.png";

  const AppConfig = {
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
    STORAGE_KEYS,
    RECEIPT_HISTORY_START: DEFAULT_BILLING.receiptHistoryStart,
  };

  global.AppConfig = AppConfig;
  global.GST_SLABS = GST_SLABS;
})(typeof window !== "undefined" ? window : globalThis);
