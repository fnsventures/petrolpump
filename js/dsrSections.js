/**
 * DSR summary section ids and copy — used by dsr.html and dsrSummary.js.
 */
(function () {
  const SUMMARY = new Set(["filters", "dsr-petrol", "dsr-diesel"]);
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

  function getSummaryCopy(section) {
    return SUMMARY_COPY[section] || SUMMARY_COPY.filters;
  }

  function consumeDashboardDateDeepLink() {
    try {
      const d =
        typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem("petrolpump_sales_daily_from_dashboard")
          : null;
      if (d && YYYYMMDD.test(d)) {
        sessionStorage.removeItem("petrolpump_sales_daily_from_dashboard");
        return d;
      }
    } catch (_) {}
    return null;
  }

  function getUrlDateParam() {
    const d = new URLSearchParams(window.location.search).get("date");
    return d && YYYYMMDD.test(d) ? d : null;
  }

  window.DsrSections = {
    SUMMARY,
    YYYYMMDD,
    SUMMARY_COPY,
    getSummaryCopy,
    consumeDashboardDateDeepLink,
    getUrlDateParam,
  };
})();
