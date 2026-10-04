/**
 * Standard PWA client lifecycle for BPFuels.
 * - Install prompt (Android beforeinstallprompt, iOS Add to Home Screen)
 * - Controlled SW updates (banner → safe apply → reload)
 * - Offline / online status with cache invalidation on reconnect
 * - Throttled app-resume for ops pages (desktop focus thrash safe)
 */
(function () {
  const INSTALL_DISMISS_KEY = "bpf-pwa-install-dismissed";
  const INSTALL_SEEN_KEY = "bpf-pwa-install-seen";
  const INSTALL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
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

  function isMobileClient() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function isIos() {
    const ua = navigator.userAgent || "";
    return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isIosSafari() {
    if (!isIos()) return false;
    return !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat/i.test(
      navigator.userAgent || ""
    );
  }

  function installDismissedRecently() {
    const raw = readStorage(INSTALL_DISMISS_KEY);
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < INSTALL_DISMISS_MS;
  }

  function readSession(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSession(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
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

  function dismissInstallSheet(persist) {
    document.getElementById("app-install-sheet")?.remove();
    document.body.classList.remove("has-install-sheet");
    if (persist) writeStorage(INSTALL_DISMISS_KEY, String(Date.now()));
  }

  function installSteps(items) {
    const list = document.createElement("ol");
    list.className = "app-install-sheet-steps";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    });
    return list;
  }

  function fillInstallBody(body, kind) {
    body.replaceChildren();
    const lead = document.createElement("p");
    if (kind === "native") {
      lead.textContent = "Install BPFuels on this phone. It opens full screen from your home screen.";
      body.appendChild(lead);
      return;
    }
    if (kind === "ios-safari") {
      lead.textContent = "Add BPFuels to your Home Screen. It opens full screen, like an installed app.";
      body.append(
        lead,
        installSteps([
          "Tap the Share button in Safari (the square with an arrow).",
          "Scroll down and tap Add to Home Screen.",
          "Tap Add.",
        ])
      );
      return;
    }
    if (kind === "ios-other") {
      lead.textContent = "This browser can’t install the app. Open the page in Safari, then add it to your Home Screen.";
      body.append(
        lead,
        installSteps(["Copy the page address.", "Open Safari and paste it.", "Tap Share, then Add to Home Screen."])
      );
      return;
    }
    lead.textContent = "Add BPFuels from the browser menu. It then opens full screen from your home screen.";
    body.append(
      lead,
      installSteps(["Tap the browser menu (⋮).", "Tap Install app or Add to Home screen.", "Confirm Add or Install."])
    );
  }

  function showInstallSheet() {
    if (typeof document === "undefined" || !document.body) return;
    if (document.getElementById("app-install-sheet")) return;

    const iosSafari = isIosSafari();
    const iosOther = isIos() && !iosSafari;
    const kind = iosSafari ? "ios-safari" : iosOther ? "ios-other" : "native";

    const root = document.createElement("div");
    root.id = "app-install-sheet";
    root.className = "app-install-sheet";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "app-install-sheet-title");

    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "app-install-sheet-backdrop";
    backdrop.setAttribute("aria-label", "Dismiss install prompt");
    backdrop.addEventListener("click", () => dismissInstallSheet(true));

    const panel = document.createElement("div");
    panel.className = "app-install-sheet-panel";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "app-install-sheet-close";
    close.setAttribute("aria-label", "Not now");
    close.textContent = "×";
    close.addEventListener("click", () => dismissInstallSheet(true));

    const icon = document.createElement("img");
    icon.className = "app-install-sheet-icon";
    icon.alt = "";
    icon.width = 56;
    icon.height = 56;
    icon.src = new URL("assets/apple-touch-icon.png", window.location.href).href;

    const title = document.createElement("h2");
    title.id = "app-install-sheet-title";
    title.className = "app-install-sheet-title";
    title.textContent = "Install BPFuels";

    const body = document.createElement("div");
    body.className = "app-install-sheet-body";
    fillInstallBody(body, kind);

    const actions = document.createElement("div");
    actions.className = "app-install-sheet-actions";

    const later = document.createElement("button");
    later.type = "button";
    later.className = "app-install-sheet-dismiss";
    later.textContent = kind === "native" || kind === "android" ? "Not now" : "Got it";
    later.addEventListener("click", () => dismissInstallSheet(true));

    if (kind === "native" || kind === "android") {
      const install = document.createElement("button");
      install.type = "button";
      install.className = "app-install-sheet-action";
      install.textContent = "Install";
      install.addEventListener("click", () => {
        if (deferredInstallPrompt) {
          void promptInstall();
          return;
        }
        fillInstallBody(body, "android");
        install.remove();
        later.textContent = "Got it";
      });
      actions.append(install, later);
    } else {
      actions.append(later);
    }

    panel.append(close, icon, title, body, actions);
    root.append(backdrop, panel);
    document.body.appendChild(root);
    document.body.classList.add("has-install-sheet");
    writeSession(INSTALL_SEEN_KEY, "1");
    (root.querySelector(".app-install-sheet-action") || later).focus();
  }

  async function promptInstall() {
    if (!deferredInstallPrompt) return false;

    try {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;

      if (outcome === "accepted") {
        dismissInstallSheet(false);
        return true;
      }
    } catch (error) {
      console.warn("[PWA] Install prompt failed:", error);
      deferredInstallPrompt = null;
      const body = document.querySelector(".app-install-sheet-body");
      if (body) fillInstallBody(body, "android");
      document.querySelector(".app-install-sheet-action")?.remove();
    }

    return false;
  }

  function shouldOfferInstall() {
    if (isStandalone() || !isMobileClient()) return false;
    if (installDismissedRecently()) return false;
    if (readSession(INSTALL_SEEN_KEY) === "1") return false;
    const file = (window.location.pathname.split("/").pop() || "").toLowerCase();
    return file !== "offline.html";
  }

  function initInstallPrompt() {
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      dismissInstallSheet(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.getElementById("app-install-sheet")) {
        dismissInstallSheet(true);
      }
    });

    if (!shouldOfferInstall()) return;
    window.setTimeout(showInstallSheet, 700);
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (!isMobileClient() || isStandalone()) return;
    event.preventDefault();
    deferredInstallPrompt = event;
    const action = document.querySelector(".app-install-sheet-action");
    if (action) action.hidden = false;
  });

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
