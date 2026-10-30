/**
 * Standard PWA client lifecycle for BPFuels.
 * - Install prompt (Android beforeinstallprompt, iOS Add to Home Screen)
 * - Controlled SW updates (logo popup, or a slim "New version — Reload" strip mid-entry)
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
  const UPDATE_CHECK_MIN_MS = 60 * 1000;
  const UPDATE_POLL_MS = 30 * 1000;
  const UPDATE_SNOOZE_MS = 5 * 60 * 1000;
  const MIN_RESUME_GAP_MS = 5000;
  const MIN_HIDDEN_FOR_RESUME_MS = 2000;

  let deferredInstallPrompt = null;
  let registrationRef = null;
  let waitingWorkerRef = null;
  let waitingVersion = "";
  let snoozedWorker = null;
  let snoozedVersion = "";
  let updateSnoozeUntil = 0;
  let updatePollStarted = false;
  let refreshing = false;
  let reloadOnControllerChange = false;
  let updateReloadAction = null;
  let lastUpdateCheckAt = 0;

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

  function focusedFieldHasEntry() {
    const el = document.activeElement;
    if (!el || !isUserActivelyEditing()) return false;
    if (el.isContentEditable) return (el.textContent || "").trim().length > 0;
    return String(el.value || "").trim().length > 0;
  }

  /** Typed input a reload would lose. Forms with a local draft come back after reload. */
  function reloadWouldLoseInput() {
    if (typeof window.unsavedWorkWouldBeLost === "function") return window.unsavedWorkWouldBeLost();
    return focusedFieldHasEntry();
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

  function logoUrl(file) {
    return new URL(`assets/${file}`, window.location.href).href;
  }

  function dismissUpdateSheet(snooze) {
    document.getElementById("app-update-sheet")?.remove();
    document.getElementById("app-update-toast")?.remove();
    document.body.classList.remove("has-update-sheet");
    if (!snooze) return;
    snoozedWorker = waitingWorkerRef;
    snoozedVersion = waitingVersion;
    updateSnoozeUntil = Date.now() + UPDATE_SNOOZE_MS;
  }

  function updateIsSnoozed(worker, version) {
    if (Date.now() >= updateSnoozeUntil) return false;
    if (worker && snoozedWorker && worker !== snoozedWorker) return false;
    if (version && snoozedVersion && version !== snoozedVersion) return false;
    return Boolean(snoozedWorker || snoozedVersion);
  }

  /** Non-modal strip used while someone is typing, so the sheet does not steal focus mid-entry. */
  function showAppUpdateToast() {
    if (document.getElementById("app-update-toast")) return;
    const root = document.createElement("div");
    root.id = "app-update-toast";
    root.className = "app-update-toast";
    root.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "app-update-toast-text";
    text.textContent = "New version";

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "app-update-toast-action";
    reloadBtn.textContent = "Reload";
    reloadBtn.addEventListener("click", () => {
      const action = updateReloadAction;
      dismissUpdateSheet(false);
      if (typeof action === "function") action();
    });

    const later = document.createElement("button");
    later.type = "button";
    later.className = "app-update-toast-dismiss";
    later.setAttribute("aria-label", "Remind me later");
    later.textContent = "×";
    later.addEventListener("click", () => dismissUpdateSheet(true));

    root.append(text, reloadBtn, later);
    document.body.appendChild(root);
  }

  function showAppUpdateBanner(onReload) {
    if (typeof document === "undefined" || !document.body) return;
    updateReloadAction = onReload;
    // Once the strip is up it stays the strip; polling must not swap in the modal mid-shift.
    if (document.getElementById("app-update-sheet") || document.getElementById("app-update-toast")) return;
    if (isUserActivelyEditing() || reloadWouldLoseInput() || document.querySelector("dialog[open]")) {
      showAppUpdateToast();
      return;
    }

    const root = document.createElement("div");
    root.id = "app-update-sheet";
    root.className = "app-update-sheet";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "app-update-sheet-title");
    root.setAttribute("aria-describedby", "app-update-sheet-message");

    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "app-update-sheet-backdrop";
    backdrop.setAttribute("aria-label", "Remind me later");
    backdrop.addEventListener("click", () => dismissUpdateSheet(true));

    const panel = document.createElement("div");
    panel.className = "app-update-sheet-panel";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "app-update-sheet-close";
    close.setAttribute("aria-label", "Remind me later");
    close.textContent = "×";
    close.addEventListener("click", () => dismissUpdateSheet(true));

    const logo = document.createElement("img");
    logo.className = "app-update-sheet-logo";
    logo.alt = "";
    logo.width = 104;
    logo.height = 104;
    logo.decoding = "async";
    logo.src = logoUrl("logo-104.webp");
    logo.addEventListener("error", () => {
      logo.src = logoUrl("logo-104.png");
    });

    const title = document.createElement("h2");
    title.id = "app-update-sheet-title";
    title.className = "app-update-sheet-title";
    title.textContent = "Update available";

    const message = document.createElement("p");
    message.id = "app-update-sheet-message";
    message.className = "app-update-sheet-message";
    message.textContent = reloadWouldLoseInput()
      ? "A new version of Bishnupriya Fuels is ready. Reload to use the latest changes. Unsaved entries on this page will be lost."
      : "A new version of Bishnupriya Fuels is ready. Reload to use the latest changes.";

    const actions = document.createElement("div");
    actions.className = "app-update-sheet-actions";

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "app-update-sheet-action";
    reloadBtn.textContent = "Reload";
    reloadBtn.addEventListener("click", () => {
      const action = updateReloadAction;
      dismissUpdateSheet(false);
      if (typeof action === "function") action();
    });

    const later = document.createElement("button");
    later.type = "button";
    later.className = "app-update-sheet-dismiss";
    later.textContent = "Later";
    later.addEventListener("click", () => dismissUpdateSheet(true));

    actions.append(reloadBtn, later);
    panel.append(close, logo, title, message, actions);
    root.append(backdrop, panel);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const items = [close, reloadBtn, later];
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    });
    document.body.appendChild(root);
    document.body.classList.add("has-update-sheet");
    const dialogOpen = document.querySelector("dialog[open]");
    if (document.visibilityState === "visible" && !isUserActivelyEditing() && !dialogOpen) reloadBtn.focus();
  }

  function reloadThisPage() {
    if (refreshing) return;
    refreshing = true;
    // Typed input is written to its draft first and restored on the new page.
    window.saveDraftsForReload?.();
    reloadOnControllerChange = false;
    waitingWorkerRef = null;
    dismissUpdateSheet(false);
    window.location.reload();
  }

  function applyWaitingWorker(worker) {
    if (!worker || worker.state === "activated" || worker.state === "redundant") {
      reloadThisPage();
      return;
    }
    reloadOnControllerChange = true;
    worker.postMessage({ type: "SKIP_WAITING" });
  }

  function promptWaitingWorker(worker, version) {
    if (!worker) return;
    waitingWorkerRef = worker;
    if (version) waitingVersion = version;
    if (updateIsSnoozed(worker, version || waitingVersion)) return;
    showAppUpdateBanner(() => applyWaitingWorker(waitingWorkerRef));
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

  const trackedWorkers = new WeakSet();

  function trackInstallingWorker(worker) {
    if (!worker || trackedWorkers.has(worker)) return;
    trackedWorkers.add(worker);
    worker.addEventListener("statechange", () => {
      handleInstalledWorker(worker);
    });
    handleInstalledWorker(worker);
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
      lead.textContent = isMobileClient()
        ? "Install BPFuels on this phone. It opens full screen from your home screen."
        : "Install BPFuels on this computer. It opens in its own window from the Start menu, Dock or desktop.";
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
    icon.width = 72;
    icon.height = 72;
    icon.src = logoUrl("logo-104.webp");
    icon.addEventListener("error", () => {
      icon.src = logoUrl("logo-104.png");
    });

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
    if (isStandalone()) return false;
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
      if (event.key !== "Escape") return;
      if (document.getElementById("app-install-sheet")) {
        dismissInstallSheet(true);
        return;
      }
      if (document.getElementById("app-update-sheet")) dismissUpdateSheet(true);
    });

    // Desktop browsers without beforeinstallprompt have no install steps worth showing.
    if (!shouldOfferInstall() || !isMobileClient()) return;
    window.setTimeout(showInstallSheet, 700);
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandalone()) return;
    event.preventDefault();
    deferredInstallPrompt = event;
    const action = document.querySelector(".app-install-sheet-action");
    if (action) action.hidden = false;
    if (!isMobileClient() && shouldOfferInstall() && !isPublicLandingPage()) {
      window.setTimeout(showInstallSheet, 700);
    }
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

    const saveSelector = 'button[type="submit"], button.shift-save-btn, button.button-primary, #day-closing-save';
    let offlineHintSeq = 0;
    const offlineHintFor = (btn) => {
      const next = btn.nextElementSibling;
      if (next && next.classList.contains("offline-save-hint")) return next;
      const hint = document.createElement("p");
      hint.className = "offline-save-hint";
      hint.id = `offline-save-hint-${++offlineHintSeq}`;
      hint.textContent = "Reconnect to save";
      btn.insertAdjacentElement("afterend", hint);
      return hint;
    };
    const setSavesEnabled = (online) => {
      document.querySelectorAll(saveSelector).forEach((btn) => {
        if (!(btn instanceof HTMLButtonElement)) return;
        if (!online) {
          if (btn.disabled && btn.dataset.offlineDisabled !== "1") return;
          btn.dataset.offlineDisabled = "1";
          btn.disabled = true;
          btn.title = "Reconnect to save";
          const hint = offlineHintFor(btn);
          if (!("offlineDescribedby" in btn.dataset)) {
            btn.dataset.offlineDescribedby = btn.getAttribute("aria-describedby") || "";
          }
          const prev = btn.dataset.offlineDescribedby;
          btn.setAttribute("aria-describedby", prev ? `${prev} ${hint.id}` : hint.id);
          return;
        }
        if (btn.dataset.offlineDisabled === "1") {
          btn.disabled = false;
          btn.title = "";
          if ("offlineDescribedby" in btn.dataset) {
            if (btn.dataset.offlineDescribedby) btn.setAttribute("aria-describedby", btn.dataset.offlineDescribedby);
            else btn.removeAttribute("aria-describedby");
            delete btn.dataset.offlineDescribedby;
          }
          const hint = btn.nextElementSibling;
          if (hint && hint.classList.contains("offline-save-hint")) hint.remove();
          delete btn.dataset.offlineDisabled;
        }
      });
    };
    const update = (online) => {
      setSavesEnabled(online);
      if (!online) {
        status.textContent = "You are offline. Saves are paused until the connection returns.";
        status.classList.remove("hidden");
        return;
      }
      status.classList.add("hidden");
      void checkForUpdates(true);
      dispatchAppResume({ reason: "online" });
    };

    /* Buttons inserted after the connection drops (shift rows, billing lines) stay blocked. */
    let offlineWatch = 0;
    const observer = new MutationObserver(() => {
      if (navigator.onLine || offlineWatch) return;
      offlineWatch = window.setTimeout(() => {
        offlineWatch = 0;
        if (!navigator.onLine) setSavesEnabled(false);
      }, 50);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener(
      "click",
      (event) => {
        if (navigator.onLine) return;
        const btn = event.target instanceof Element ? event.target.closest(saveSelector) : null;
        if (!(btn instanceof HTMLButtonElement)) return;
        if (!btn.disabled) {
          event.preventDefault();
          event.stopPropagation();
        }
        setSavesEnabled(false);
      },
      true
    );

    window.addEventListener("online", () => update(true));
    window.addEventListener("offline", () => update(false));
    update(navigator.onLine);
  }

  async function checkForUpdates(force = false) {
    if (!registrationRef) return;
    const now = Date.now();
    const due = force || now - lastUpdateCheckAt >= UPDATE_CHECK_MIN_MS;
    if (due) {
      lastUpdateCheckAt = now;
      try {
        await registrationRef.update();
      } catch {
        /* offline or blocked */
      }
    }
    if (registrationRef.waiting && navigator.serviceWorker.controller) {
      promptWaitingWorker(registrationRef.waiting);
    }
  }

  function startUpdatePolling() {
    if (updatePollStarted) return;
    updatePollStarted = true;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void checkForUpdates(true);
    });

    window.addEventListener("focus", () => {
      void checkForUpdates(false);
    });

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) void checkForUpdates(true);
    });

    setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void checkForUpdates(false);
    }, UPDATE_POLL_MS);
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
        startUpdatePolling();

        navigator.serviceWorker.addEventListener("message", (event) => {
          if (event.data?.type !== "UPDATE_AVAILABLE") return;
          if (!navigator.serviceWorker.controller) return;
          const announced = event.source;
          const announcedOk =
            announced &&
            typeof announced.postMessage === "function" &&
            announced.state !== "redundant";
          const worker = announcedOk ? announced : registration.waiting || registration.installing;
          if (!worker || typeof worker.postMessage !== "function") return;
          promptWaitingWorker(worker, event.data.version);
        });

        registration.addEventListener("updatefound", () => {
          trackInstallingWorker(registration.installing);
        });

        if (registration.installing) trackInstallingWorker(registration.installing);
        if (registration.waiting) handleInstalledWorker(registration.waiting);

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
      if (reloadOnControllerChange) {
        reloadThisPage();
        return;
      }
      // Another tab applied the update. Ask here so an open form is not wiped.
      updateReloadAction = reloadThisPage;
      showAppUpdateBanner(reloadThisPage);
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
        return;
      }
      if (document.visibilityState !== "visible") return;

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
