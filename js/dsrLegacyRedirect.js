/**
 * Legacy hash routes from the combined dsr.html page → split pages.
 */
(function () {
  const path = (window.location.pathname || "").split("/").pop() || "";
  if (path !== "dsr.html") return;

  const hash = (window.location.hash || "").replace(/^#/, "");
  if (hash === "meter" || hash === "petrol" || hash === "diesel") {
    window.location.replace("meter-reading.html" + window.location.search + window.location.hash);
  }
})();
