/**
 * The app is light only. A saved dark choice from an older version is cleared.
 */
(function () {
  var KEY = "bpf.theme";
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    /* private mode */
  }
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.style.colorScheme = "light";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", "#0070c0");
})();
