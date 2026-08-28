/**
 * Standard PWA client lifecycle for BPFuels.
 * - Install prompt (beforeinstallprompt)
 * - Controlled SW updates (banner → safe apply → reload)
 * - Offline / online status with cache invalidation on reconnect
 * - Throttled app-resume for ops pages (desktop focus thrash safe)
 */
(function () {
  const INSTALL_DISMISS_KEY = "bpf-pwa-install-dismissed";
  const THEME_COLOR = "#0070c0";
  const APP_NAME = "Bishnupriya Fuels";
  const SHORT_NAME = "BPFuels";
  const UPDATE_CHECK_MIN_MS = 15 * 60 * 1000;
  const SAFE_UPDATE_HIDDEN_MS = 5000;
  const MIN_RESUME_GAP_MS = 5000;
  const MIN_HIDDEN_FOR_RESUME_MS = 2000;

  let deferredInstallPrompt = null;
  let registrationRef = null;
  let waitingWorkerRef = null;
  let refreshing = false;
  let lastUpdateCheckAt = 0;
  let hiddenSince = 0;
  let safeUpdateTimer = null;

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
    return file === "index.html" || file === "about.html" || file === "offline.html";
  }

  function isUserActivelyEditing() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable === true;
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

    if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
      const mobileCapable = document.createElement("meta");
      mobileCapable.name = "mobile-web-app-capable";
      mobileCapable.content = "yes";
      document.head.appendChild(mobileCapable);
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

  function applyWaitingWorker(worker) {
    if (!worker) return;
    worker.postMessage({ type: "SKIP_WAITING" });
  }

  function trySafeAutoUpdate() {
    if (!waitingWorkerRef) return;
    if (document.visibilityState !== "hidden") return;
    if (!hiddenSince) return;
    if (Date.now() - hiddenSince < SAFE_UPDATE_HIDDEN_MS) return;
    if (isUserActivelyEditing()) return;
    applyWaitingWorker(waitingWorkerRef);
  }

  function scheduleSafeAutoUpdate() {
    clearTimeout(safeUpdateTimer);
    safeUpdateTimer = setTimeout(trySafeAutoUpdate, SAFE_UPDATE_HIDDEN_MS + 100);
  }

  function promptWaitingWorker(worker) {
    if (!worker) return;
    waitingWorkerRef = worker;
    showAppUpdateBanner(() => applyWaitingWorker(worker));
    scheduleSafeAutoUpdate();
  }

  function handleInstalledWorker(worker) {
    if (!worker || worker.state !== "installed") return;
    // First visit — no controller yet; activate immediately so SW takes effect.
    if (!navigator.serviceWorker.controller) {
      applyWaitingWorker(worker);
      return;
    }
    promptWaitingWorker(worker);
  }

  function trackInstallingWorker(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      handleInstalledWorker(worker);
    });
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

  function dispatchAppResume(detail) {
    window.dispatchEvent(new CustomEvent("bpf:app-resume", { detail }));
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

    const update = (online) => {
      if (!online) {
        status.textContent = "You are offline. Data may be outdated until connection returns.";
        status.classList.remove("hidden");
        return;
      }
      status.classList.add("hidden");
      void checkForUpdates(true);
      dispatchAppResume({ reason: "online" });
    };

    window.addEventListener("online", () => update(true));
    window.addEventListener("offline", () => update(false));
    update(navigator.onLine);
  }

  async function checkForUpdates(force = false) {
    if (!registrationRef) return;
    const now = Date.now();
    if (!force && now - lastUpdateCheckAt < UPDATE_CHECK_MIN_MS) return;
    lastUpdateCheckAt = now;
    try {
      await registrationRef.update();
    } catch {
      /* offline or blocked */
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    const start = async () => {
      try {
        const swUrl = new URL("sw.js", window.location.href);
        const registration = await navigator.serviceWorker.register(swUrl.href, {
          updateViaCache: "none",
        });
        registrationRef = registration;

        if (registration.waiting) {
          handleInstalledWorker(registration.waiting);
        }

        registration.addEventListener("updatefound", () => {
          trackInstallingWorker(registration.installing);
        });

        void checkForUpdates(true);
      } catch (error) {
        console.warn("[PWA] Service Worker registration failed:", error);
      }
    };

    const deferStart = () => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => void start(), { timeout: 2500 });
      } else {
        setTimeout(() => void start(), 0);
      }
    };

    if (document.readyState === "complete") {
      deferStart();
    } else {
      window.addEventListener("load", deferStart, { once: true });
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      waitingWorkerRef = null;
      document.getElementById("app-update-banner")?.remove();
      window.location.reload();
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

    let lastResumeAt = 0;
    let hiddenAt = 0;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        hiddenSince = hiddenAt;
        scheduleSafeAutoUpdate();
        return;
      }
      hiddenSince = 0;
      clearTimeout(safeUpdateTimer);
      if (document.visibilityState !== "visible") return;

      void checkForUpdates(false);

      const now = Date.now();
      const hiddenFor = hiddenAt ? now - hiddenAt : 0;
      if (hiddenFor < MIN_HIDDEN_FOR_RESUME_MS || now - lastResumeAt < MIN_RESUME_GAP_MS) return;
      lastResumeAt = now;

      if (hiddenFor >= 30000 && window.supabaseClient?.auth) {
        void window.supabaseClient.auth.getSession().catch(() => {});
      }
      dispatchAppResume({ reason: "visible", hiddenForMs: hiddenFor });
    });

    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      lastResumeAt = Date.now();
      if (window.supabaseClient?.auth) {
        void window.supabaseClient.auth.getSession().catch(() => {});
      }
      dispatchAppResume({ reason: "bfcache", hiddenForMs: MIN_RESUME_GAP_MS });
    });
  }

  function init() {
    try {
      injectAppMeta();
      initNetworkStatus();
      registerServiceWorker();
      initInstallPrompt();
      initAppResumeBroadcast();
      if (isStandalone()) {
        document.documentElement.classList.add("bpf-standalone");
      }
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
    checkForUpdates: () => checkForUpdates(true),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
