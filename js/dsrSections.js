/**
 * Shared DSR section ids and hash routing — sync-loaded before dsrBootstrap.js and dsr.js.
 */
(function () {
  const SUMMARY = new Set(["filters", "dsr-petrol", "dsr-diesel"]);
  const METER = new Set(["petrol", "diesel"]);
  const ALL = [...SUMMARY, ...METER];
  const HASH_ALIASES = { meter: "petrol" };
  const PUBLIC_HASH = { petrol: "meter" };
  const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

  const SUMMARY_COPY = {
    filters: {
      title: "Total",
      lead: "Combined MS and HSD readings, sales, stock, and variation for the selected period.",
    },
    "dsr-petrol": {
      title: "MS (Petrol)",
      lead: "Petrol meter readings, sales, stock, and variation for the selected period.",
    },
    "dsr-diesel": {
      title: "HSD (Diesel)",
      lead: "Diesel meter readings, sales, stock, and variation for the selected period.",
    },
  };

  function resolveFromHash(rawHash) {
    const hash = String(rawHash || "").replace(/^#/, "");
    return HASH_ALIASES[hash] || hash;
  }

  function getPublicHash(section) {
    return PUBLIC_HASH[section] || section;
  }

  function getSummaryCopy(section) {
    return SUMMARY_COPY[section] || SUMMARY_COPY.filters;
  }

  window.DsrSections = {
    SUMMARY,
    METER,
    ALL,
    HASH_ALIASES,
    PUBLIC_HASH,
    YYYYMMDD,
    SUMMARY_COPY,
    resolveFromHash,
    getPublicHash,
    isSummary: (section) => SUMMARY.has(section),
    getSummaryCopy,
  };
})();
