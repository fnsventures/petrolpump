/**
 * Fuel sidebar labels (MS/HSD + tank capacity) from pump settings.
 */
(function (global) {
  function fuelNavMeta(product, pumps) {
    const cfg = pumps?.[product] || {};
    const label = product === "petrol" ? "Petrol" : "Diesel";
    const cap = String(cfg.tankCapacity || (product === "petrol" ? "15 KL" : "20 KL")).trim();
    return `${label} · ${cap}`;
  }

  function applyFuelNavMeta(root) {
    const nav = root || document;
    const pumps = global.PumpSettings?.getCachedSync?.()?.pumps;
    if (!pumps) return;

    nav.querySelectorAll(".settings-nav-item--petrol .settings-nav-item-meta").forEach((el) => {
      el.textContent = fuelNavMeta("petrol", pumps);
    });
    nav.querySelectorAll(".settings-nav-item--diesel .settings-nav-item-meta").forEach((el) => {
      el.textContent = fuelNavMeta("diesel", pumps);
    });
  }

  global.DsrFuelNav = { applyFuelNavMeta };
})(typeof window !== "undefined" ? window : globalThis);
