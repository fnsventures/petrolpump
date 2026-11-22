/**
 * Colour theme. Runs in <head> before CSS paints so there is no light flash.
 * Saved choice ("light" | "dark" | "system", default system) lives in localStorage.
 * Dark tokens are in css/tokens.css under :root[data-theme="dark"].
 */
(function () {
  var KEY = "bpf.theme";
  var THEME_COLORS = { light: "#0070c0", dark: "#111a27" };
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function readChoice() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch (err) {
      return "system";
    }
  }

  function resolve(choice) {
    if (choice === "light" || choice === "dark") return choice;
    return media && media.matches ? "dark" : "light";
  }

  /**
   * Status bar colour. Pages ship two theme-color metas, media="(prefers-color-scheme: light|dark)",
   * so the system setting picks the right one before any script runs. "system" restores each
   * meta to its own colour; an explicit light or dark choice gives both metas that colour, so
   * the status bar follows the app even when it differs from the phone's setting.
   */
  function syncThemeColor(choice, theme) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var meta = metas[i];
      var mediaAttr = meta.getAttribute("media") || "";
      var own = /dark/.test(mediaAttr) ? "dark" : /light/.test(mediaAttr) ? "light" : theme;
      meta.setAttribute("content", THEME_COLORS[choice === "system" ? own : theme]);
    }
  }

  function apply() {
    var choice = readChoice();
    var theme = resolve(choice);
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-theme-choice", choice);
    syncThemeColor(choice, theme);
    document.dispatchEvent(new CustomEvent("bpf:themechange", { detail: { theme: theme, choice: choice } }));
  }

  function set(choice) {
    try {
      if (choice === "light" || choice === "dark") localStorage.setItem(KEY, choice);
      else localStorage.removeItem(KEY);
    } catch (err) {
      /* private mode: applies for this page only */
    }
    apply();
  }

  if (media) {
    var onSystemChange = function () {
      if (readChoice() === "system") apply();
    };
    if (media.addEventListener) media.addEventListener("change", onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  // Another tab changed the choice.
  window.addEventListener("storage", function (event) {
    if (event.key === KEY) apply();
  });

  window.AppTheme = {
    get: function () {
      return { theme: resolve(readChoice()), choice: readChoice() };
    },
    set: set,
  };

  apply();
})();
