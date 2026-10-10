/**
 * Old bookmarks: credit-customer, credit-overdue, sales-daily.
 * External script so the page CSP can stay free of inline scripts.
 */
(function () {
  const page = (window.location.pathname || "").split("/").pop() || "";
  const params = new URLSearchParams(window.location.search);
  let hash = (window.location.hash || "").replace(/^#/, "");

  if (page === "sales-daily.html") {
    window.location.replace("dsr.html" + (window.location.search || ""));
    return;
  }

  let target = "";
  if (page === "credit-overdue.html") {
    if (hash === "overdue-list") hash = "outstanding";
    if (hash === "overdue-summary") hash = "overview";
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
  window.location.replace(url);
})();
