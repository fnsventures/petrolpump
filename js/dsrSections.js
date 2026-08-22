/**
 * DSR summary section ids and copy — used by dsr.html and dsrSummary.js.
 */
(function () {
  const REGISTER = new Set(["filters", "dsr-petrol", "dsr-diesel"]);
  const BREAKDOWN = new Set(["by-pump", "by-shift", "by-salesman"]);
  const SUMMARY = new Set([...REGISTER, "sales-detail", ...BREAKDOWN]);
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
    "sales-detail": {
      title: "Sales detail",
      lead: "Staff, shift, or pump for the selected dates.",
    },
    "by-pump": {
      title: "Pump sales",
      lead: "Sale litres by pump for the selected dates.",
    },
    "by-shift": {
      title: "Shift sales",
      lead: "Morning and afternoon totals for the selected dates.",
    },
    "by-salesman": {
      title: "Staff sales",
      lead: "Staff litres, cash collected, and short for the selected dates.",
    },
  };

  function getSummaryCopy(section) {
    return SUMMARY_COPY[section] || SUMMARY_COPY.filters;
  }

  function isRegisterSection(section) {
    return REGISTER.has(section);
  }

  function isBreakdownSection(section) {
    return BREAKDOWN.has(section);
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
    REGISTER,
    BREAKDOWN,
    YYYYMMDD,
    SUMMARY_COPY,
    getSummaryCopy,
    isRegisterSection,
    isBreakdownSection,
    consumeDashboardDateDeepLink,
    getUrlDateParam,
  };
})();
