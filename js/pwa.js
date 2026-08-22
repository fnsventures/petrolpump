/**
 * PWA shell: manifest meta, service worker, install prompt, offline/update banners.
 */
(function () {
  const INSTALL_DISMISS_KEY = "bpf-pwa-install-dismissed";
  const THEME_COLOR = "#0070c0";
  const APP_NAME = "Bishnupriya Fuels";
  const SHORT_NAME = "BPFuels";

  let deferredInstallPrompt = null;

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.navigator.standalone === true
    );
  }

  function isPublicLandingPage() {
    const file = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
    return file === "index.html" || file === "about.html";
  }

  function ensureViewportMeta() {
    const desired = "width=device-width, initial-scale=1, viewport-fit=cover";
    let viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement("meta");
      viewport.name = "viewport";
      viewport.content = desired;
      document.head.insertBefore(viewport, document.head.firstChild);
      return;
    }
    if (!/viewport-fit\s*=\s*cover/i.test(viewport.content)) {
      const base = viewport.content.trim().replace(/,?\s*$/, "");
      viewport.content = base ? `${base}, viewport-fit=cover` : desired;
    }
  }

  function injectAppMeta() {
    if (typeof document === "undefined" || !document.head) return;

    ensureViewportMeta();

    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement("link");
      manifest.rel = "manifest";
      manifest.href = new URL("manifest.json", window.location.href).href;
      document.head.appendChild(manifest);
    }

    if (!document.querySelector('meta[name="theme-color"]')) {
      const theme = document.createElement("meta");
      theme.name = "theme-color";
      theme.content = THEME_COLOR;
      document.head.appendChild(theme);
    }

    if (!document.querySelector('meta[name="application-name"]')) {
      const appName = document.createElement("meta");
      appName.name = "application-name";
      appName.content = APP_NAME;
      document.head.appendChild(appName);
    }

    if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
      const capable = document.createElement("meta");
      capable.name = "apple-mobile-web-app-capable";
      capable.content = "yes";
      document.head.appendChild(capable);
    }

    if (!document.querySelector('meta[name="apple-mobile-web-app-title"]')) {
      const title = document.createElement("meta");
      title.name = "apple-mobile-web-app-title";
      title.content = SHORT_NAME;
      document.head.appendChild(title);
    }

    if (!document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')) {
      const statusBar = document.createElement("meta");
      statusBar.name = "apple-mobile-web-app-status-bar-style";
      statusBar.content = "default";
      document.head.appendChild(statusBar);
    }

    if (!document.querySelector('meta[name="format-detection"]')) {
      const formatDetection = document.createElement("meta");
      formatDetection.name = "format-detection";
      formatDetection.content = "telephone=no";
      document.head.appendChild(formatDetection);
    }
  }

  function showAppUpdateBanner(onReload) {
    if (typeof document === "undefined" || !document.body) return;

    let banner = document.getElementById("app-update-banner");
    if (banner) return;

    banner = document.createElement("div");
    banner.id = "app-update-banner";
    banner.className = "app-update-banner";
    banner.setAttribute("role", "status");

    const text = document.createElement("span");
    text.textContent = "A new version is available.";

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "app-update-banner-action";
    reloadBtn.textContent = "Reload";
    reloadBtn.addEventListener("click", () => {
      if (typeof onReload === "function") onReload();
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "app-update-banner-close";
    dismissBtn.setAttribute("aria-label", "Dismiss");
    dismissBtn.textContent = "×";
    dismissBtn.addEventListener("click", () => banner.remove());

    banner.append(text, reloadBtn, dismissBtn);
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function showInstallBanner() {
    if (typeof document === "undefined" || !document.body) return;
    if (isStandalone() || isPublicLandingPage()) return;
    if (readStorage(INSTALL_DISMISS_KEY)) return;

    let banner = document.getElementById("app-install-banner");
    if (banner) return;

    banner = document.createElement("div");
    banner.id = "app-install-banner";
    banner.className = "app-install-banner";
    banner.setAttribute("role", "status");

    const text = document.createElement("span");
    text.textContent = "Install BPFuels for quick access from your home screen.";

    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "app-install-banner-action";
    installBtn.textContent = "Install";
    installBtn.addEventListener("click", () => {
      void promptInstall();
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "app-install-banner-close";
    dismissBtn.setAttribute("aria-label", "Dismiss");
    dismissBtn.textContent = "×";
    dismissBtn.addEventListener("click", () => {
      writeStorage(INSTALL_DISMISS_KEY, String(Date.now()));
      banner.remove();
    });

    banner.append(text, installBtn, dismissBtn);
    document.body.insertBefore(banner, document.body.firstChild);
  }

  async function promptInstall() {
    if (!deferredInstallPrompt) return false;

    try {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;

      if (outcome === "accepted") {
        document.getElementById("app-install-banner")?.remove();
        return true;
      }
    } catch (error) {
      console.warn("[PWA] Install prompt failed:", error);
      deferredInstallPrompt = null;
    }

    return false;
  }

  function initInstallPrompt() {
    if (isStandalone() || isPublicLandingPage()) return;

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      showInstallBanner();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      document.getElementById("app-install-banner")?.remove();
    });
  }

  function initNetworkStatus() {
    if (typeof document === "undefined" || !document.body) return;

    let status = document.getElementById("app-network-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "app-network-status";
      status.className = "app-network-status hidden";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      document.body.appendChild(status);
    }

    const update = () => {
      if (!navigator.onLine) {
        status.textContent = "You are offline. Data may be outdated until connection returns.";
        status.classList.remove("hidden");
      } else {
        status.classList.add("hidden");
      }
    };

    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", async () => {
      try {
        const swUrl = new URL("sw.js", window.location.href);
        const registration = await navigator.serviceWorker.register(swUrl.href);
        console.log("[PWA] Service Worker registered:", registration.scope);

        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              console.log("[PWA] New Service Worker available");
              showAppUpdateBanner(() => {
                newWorker.postMessage({ type: "SKIP_WAITING" });
                window.location.reload();
              });
            }
          });
        });
      } catch (error) {
        console.warn("[PWA] Service Worker registration failed:", error);
      }
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      console.log("[PWA] Service Worker controller changed");
    });
  }

  function sendToServiceWorker(type, payload = {}) {
    return new Promise((resolve) => {
      if (!navigator.serviceWorker?.controller) {
        resolve(null);
        return;
      }

      const messageChannel = new MessageChannel();
      messageChannel.port1.onmessage = (event) => {
        resolve(event.data);
      };

      navigator.serviceWorker.controller.postMessage({ type, payload }, [messageChannel.port2]);

      setTimeout(() => resolve(null), 3000);
    });
  }

  function initAppResumeBroadcast() {
    if (isPublicLandingPage()) return;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (window.supabaseClient?.auth) {
          void window.supabaseClient.auth.getSession().catch(() => {});
        }
        window.dispatchEvent(new CustomEvent("bpf:app-resume", { detail: { reason: "visible" } }));
      }
    });

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        if (window.supabaseClient?.auth) {
          void window.supabaseClient.auth.getSession().catch(() => {});
        }
        window.dispatchEvent(new CustomEvent("bpf:app-resume", { detail: { reason: "bfcache" } }));
      }
    });
  }

  function init() {
    try {
      injectAppMeta();
      initNetworkStatus();
      registerServiceWorker();
      initInstallPrompt();
      initAppResumeBroadcast();
    } catch (error) {
      console.warn("[PWA] Init failed:", error);
    }
  }

  window.PWA = {
    promptInstall,
    isStandalone,
    canInstall: () => Boolean(deferredInstallPrompt),
    sendToServiceWorker,
    showAppUpdateBanner,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
