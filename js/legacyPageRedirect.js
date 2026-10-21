/**
 * Old bookmarks: credit-customer, credit-overdue, sales-daily.
 * External script so the page CSP can stay free of inline scripts.
 * Keeps the query string and hash. A meta refresh to the bare page would drop them.
 */
(function () {
  const page = (window.location.pathname || "").split("/").pop() || "";
  const params = new URLSearchParams(window.location.search);
  let hash = (window.location.hash || "").replace(/^#/, "");

  if (page === "sales-daily.html") {
    const url = "dsr.html" + (window.location.search || "") + (window.location.hash || "");
    window.location.replace(url);
    return;
  }

  let target = "";
  if (page === "credit-overdue.html") {
    if (!hash || hash === "overdue-list") hash = "outstanding";
    else if (hash === "overdue-summary") hash = "overview";
    target = "credit.html";
  } else if (page === "credit-customer.html") {
    target = "credit.html";
  } else {
    return;
  }

  const qs = params.toString();
  let url = target;
  if (qs) url += "?" + qs;
  if (hash) url += "#" + hash;
  document.querySelectorAll("a[href]").forEach((link) => {
    link.href = url;
  });
  window.location.replace(url);
})();
