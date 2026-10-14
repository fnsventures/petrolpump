/**
 * Set light or dark before the first paint.
 * With no saved choice, stay on the light theme. The account menu can pin light or dark.
 */
(function () {
  var KEY = "bpf.theme";

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : "";
    } catch (err) {
      return "";
    }
  }

  function resolve(preference) {
    return preference === "dark" ? "dark" : "light";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#0070c0");
  }

  apply(resolve(stored()));

  window.bpfTheme = {
    preference: function preference() {
      return stored() || "light";
    },
    resolved: function resolved() {
      return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    },
    set: function set(next) {
      if (next !== "light" && next !== "dark") return;
      try {
        localStorage.setItem(KEY, next);
      } catch (err) {
        /* private mode */
      }
      apply(resolve(next));
      document.dispatchEvent(new CustomEvent("bpf:theme-change"));
    },
  };
})();
