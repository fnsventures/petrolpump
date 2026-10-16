/**
 * One modal <dialog> for confirm and alert.
 * Page overlays call show/hide so focus, Escape, and the inert background stay consistent.
 */
/* global AppError */

(function () {
  const FOCUSABLE = [
    "input:not([type='hidden']):not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "button:not([disabled])",
    "a[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  let dialog = null;
  let form = null;
  let titleEl = null;
  let messageEl = null;
  let reasonInput = null;
  let okBtn = null;
  let cancelBtn = null;
  let lastFocus = null;
  const queue = [];
  let busy = false;

  function ensure() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "app-dialog";
    dialog.className = "app-dialog";
    dialog.setAttribute("aria-labelledby", "app-dialog-title");

    form = document.createElement("form");
    form.method = "dialog";
    form.className = "app-dialog-form";
    form.noValidate = true;

    const logo = document.createElement("img");
    logo.className = "app-dialog-logo";
    logo.alt = "";
    logo.width = 104;
    logo.height = 104;
    logo.decoding = "async";
    logo.src = new URL("assets/logo-104.webp", window.location.href).href;
    logo.addEventListener("error", () => {
      logo.src = new URL("assets/logo-104.png", window.location.href).href;
    });

    titleEl = document.createElement("h2");
    titleEl.id = "app-dialog-title";
    titleEl.className = "app-dialog-title";

    messageEl = document.createElement("p");
    messageEl.id = "app-dialog-message";
    messageEl.className = "app-dialog-message";

    reasonInput = document.createElement("textarea");
    reasonInput.id = "app-dialog-reason";
    reasonInput.className = "app-dialog-reason";
    reasonInput.rows = 3;
    reasonInput.maxLength = 500;
    reasonInput.required = true;

    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";

    okBtn = document.createElement("button");
    okBtn.type = "submit";
    okBtn.id = "app-dialog-ok";
    okBtn.value = "ok";

    cancelBtn = document.createElement("button");
    cancelBtn.type = "submit";
    cancelBtn.id = "app-dialog-cancel";
    cancelBtn.className = "button-secondary";
    cancelBtn.value = "cancel";

    actions.append(okBtn, cancelBtn);
    form.append(logo, titleEl, messageEl, reasonInput, actions);
    dialog.append(form);
    document.body.append(dialog);

    // Close on the next turn. Closing inside this click lets the same click
    // fall through onto the page button underneath and reopen the popup.
    const requestClose = (value) => {
      if (value !== "cancel" && !form.checkValidity()) {
        form.reportValidity();
        return;
      }
      window.setTimeout(() => {
        if (dialog.open) dialog.close(value);
      }, 0);
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = event.submitter && event.submitter.value ? event.submitter.value : "ok";
      requestClose(value);
    });

    // A click listener on document can cancel the submit default action.
    // Close from the button click itself so Certify / Revoke still dismiss.
    okBtn.addEventListener("click", (event) => {
      event.preventDefault();
      requestClose("ok");
    });
    cancelBtn.addEventListener("click", (event) => {
      event.preventDefault();
      requestClose("cancel");
    });

    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) requestClose("cancel");
    });
  }

  function present(config) {
    ensure();
    const kind = config.kind;
    const message = config.message == null ? "" : String(config.message);
    titleEl.textContent = config.title || (kind === "confirm" ? "Please confirm" : "Notice");
    messageEl.textContent = message;
    messageEl.hidden = !message;
    if (message) dialog.setAttribute("aria-describedby", "app-dialog-message");
    else dialog.removeAttribute("aria-describedby");

    const danger = config.danger === true;
    okBtn.className = danger ? "button-delete" : "button-primary";
    okBtn.textContent = config.confirmLabel || (kind === "alert" ? "OK" : "Confirm");
    cancelBtn.textContent = config.cancelLabel || "Cancel";
    const showCancel = kind !== "alert";
    cancelBtn.hidden = !showCancel;
    cancelBtn.disabled = !showCancel;
    const showReason = kind === "prompt";
    reasonInput.hidden = !showReason;
    reasonInput.required = showReason;
    reasonInput.disabled = !showReason;
    reasonInput.value = "";
    reasonInput.placeholder = config.reasonLabel || "Reason";
    if (showReason) reasonInput.setAttribute("aria-label", config.reasonLabel || "Reason");

    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Esc closes a <dialog> without touching returnValue. Clear it so a
    // dismissed confirm never reads the previous popup's "ok".
    dialog.returnValue = "";

    return new Promise((resolve) => {
      const finish = () => {
        dialog.removeEventListener("close", onClose);
        const accepted = dialog.returnValue === "ok";
        if (kind === "prompt") resolve(accepted ? reasonInput.value.trim() : null);
        else resolve(kind === "confirm" ? accepted : undefined);
        unlockPage();
        if (lastFocus && document.contains(lastFocus)) {
          try {
            lastFocus.focus();
          } catch (_) {
            /* the opener may already be gone */
          }
        }
      };
      const onClose = () => finish();
      dialog.addEventListener("close", onClose);
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      document.body.classList.add("modal-open");
      requestAnimationFrame(() => {
        if (kind === "prompt") reasonInput.focus();
        else if (danger && showCancel) cancelBtn.focus();
        else okBtn.focus();
      });
    });
  }

  function unlockPage() {
    if (!document.querySelector("dialog[open]")) {
      document.body.classList.remove("modal-open");
    }
  }

  let current = null;

  function sameConfirm(a, b) {
    return a && b && a.kind === "confirm" && b.kind === "confirm" && a.title === b.title && a.message === b.message;
  }

  function enqueue(config) {
    // A double tap on Delete would queue the same confirm twice and then run
    // the action twice. The extra copy resolves as Cancel.
    if (sameConfirm(current, config) || queue.some((job) => sameConfirm(job.config, config))) {
      return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
      queue.push({ config, resolve, reject });
      drain();
    });
  }

  function drain() {
    if (busy || !queue.length) return;
    const job = queue.shift();
    busy = true;
    current = job.config;
    present(job.config).then(job.resolve, job.reject).finally(() => {
      busy = false;
      current = null;
      drain();
    });
  }

  function alertDialog(message, options) {
    const opts = options || {};
    return enqueue({
      kind: "alert",
      message,
      title: opts.title || "Notice",
      confirmLabel: opts.confirmLabel || "OK",
    });
  }

  function promptDialog(message, options) {
    const opts = options || {};
    return enqueue({
      kind: "prompt",
      message,
      title: opts.title || "Please confirm",
      confirmLabel: opts.confirmLabel || "Confirm",
      cancelLabel: opts.cancelLabel || "Cancel",
      reasonLabel: opts.reasonLabel || "Reason",
      danger: opts.danger === true,
    });
  }

  function confirmDialog(message, options) {
    const opts = options || {};
    return enqueue({
      kind: "confirm",
      message,
      title: opts.title || "Please confirm",
      confirmLabel: opts.confirmLabel || "Confirm",
      cancelLabel: opts.cancelLabel || "Cancel",
      danger: opts.danger === true,
    });
  }

  function resolveFocus(el, focus) {
    if (focus === false) return null;
    if (typeof focus === "string") return el.querySelector(focus);
    if (focus && typeof focus.focus === "function") return focus;
    return el.querySelector(FOCUSABLE);
  }

  function bindPageDialog(el) {
    if (el.dataset.appDialogBound) return;
    el.dataset.appDialogBound = "1";
    el.addEventListener("cancel", (event) => {
      event.preventDefault();
      const dismiss = el._appDialogOnDismiss;
      if (typeof dismiss === "function") dismiss();
      else hide(el);
    });
  }

  function show(el, options) {
    if (!el) return;
    const opts = options || {};
    if (typeof opts.onDismiss === "function") el._appDialogOnDismiss = opts.onDismiss;
    if (el.getAttribute("aria-hidden") !== "false" && document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)) {
      el._appDialogReturnFocus = document.activeElement;
    }
    el.hidden = false;
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    if (el.tagName === "DIALOG") {
      bindPageDialog(el);
      if (!el.open && typeof el.showModal === "function") el.showModal();
    }
    document.body.classList.add("modal-open");
    const target = resolveFocus(el, opts.focus);
    if (target) {
      requestAnimationFrame(() => {
        try {
          target.focus();
        } catch (_) {
          /* ignore */
        }
      });
    }
  }

  function hide(el) {
    if (!el) return;
    if (el.tagName === "DIALOG" && el.open) el.close();
    el.setAttribute("aria-hidden", "true");
    el.classList.add("hidden");
    el.hidden = true;
    unlockPage();
    const back = el._appDialogReturnFocus;
    el._appDialogReturnFocus = null;
    if (back && document.contains(back) && !document.querySelector("dialog[open]")) {
      try {
        back.focus();
      } catch (_) {
        /* the opener may already be gone */
      }
    }
  }

  function toast(message, type) {
    const text = String(message || "").trim();
    if (!text) return;
    if (window.AppError && typeof AppError.showToast === "function") {
      AppError.showToast(text, type || "info");
      return;
    }
    void alertDialog(text);
  }

  window.AppDialog = {
    alert: alertDialog,
    confirm: confirmDialog,
    prompt: promptDialog,
    show,
    hide,
    toast,
  };
})();
