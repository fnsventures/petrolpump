/**
 * One modal <dialog> for confirm, prompt, and short forms.
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
  let fieldsEl = null;
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

    titleEl = document.createElement("h2");
    titleEl.id = "app-dialog-title";
    titleEl.className = "app-dialog-title";

    messageEl = document.createElement("p");
    messageEl.id = "app-dialog-message";
    messageEl.className = "app-dialog-message";

    fieldsEl = document.createElement("div");
    fieldsEl.className = "app-dialog-fields";

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
    form.append(titleEl, messageEl, fieldsEl, actions);
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

  function fieldControl(field, id) {
    const type = field.type || "text";
    let input;
    if (type === "textarea") {
      input = document.createElement("textarea");
      input.rows = field.rows || 3;
    } else if (type === "select") {
      input = document.createElement("select");
      (field.options || []).forEach((opt) => {
        const option = document.createElement("option");
        if (opt && typeof opt === "object") {
          option.value = opt.value == null ? "" : String(opt.value);
          option.textContent = opt.label == null ? option.value : String(opt.label);
        } else {
          option.value = String(opt);
          option.textContent = String(opt);
        }
        input.append(option);
      });
    } else {
      input = document.createElement("input");
      input.type = type;
      if (field.inputmode) input.inputMode = field.inputmode;
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
      if (field.step != null) input.step = String(field.step);
    }
    input.id = id;
    input.name = field.name;
    input.className = "app-dialog-input";
    if (field.required) input.required = true;
    if (field.maxlength) input.maxLength = Number(field.maxlength);
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.autocomplete) input.autocomplete = field.autocomplete;
    else input.autocomplete = "off";
    const value = field.value == null ? "" : String(field.value);
    if (type !== "select") input.value = value;
    else if (value) input.value = value;
    return input;
  }

  function renderFields(fields) {
    fieldsEl.replaceChildren();
    (fields || []).forEach((field) => {
      if (!field || !field.name) return;
      const id = `app-dialog-field-${field.name}`;
      const wrap = document.createElement("div");
      wrap.className = "form-field";
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = field.label || field.name;
      wrap.append(label, fieldControl(field, id));
      fieldsEl.append(wrap);
    });
  }

  function readFields() {
    const data = {};
    fieldsEl.querySelectorAll("input, select, textarea").forEach((input) => {
      if (input.name) data[input.name] = input.value;
    });
    return data;
  }

  function focusTarget(prefer) {
    if (prefer && typeof prefer.focus === "function") {
      prefer.focus();
      return;
    }
    const first = fieldsEl.querySelector("input, select, textarea");
    (first || okBtn).focus();
  }

  function present(config) {
    ensure();
    const kind = config.kind;
    const message = config.message == null ? "" : String(config.message);
    titleEl.textContent = config.title || (kind === "confirm" ? "Please confirm" : kind === "alert" ? "Notice" : "Enter details");
    messageEl.textContent = message;
    messageEl.hidden = !message;
    if (message) dialog.setAttribute("aria-describedby", "app-dialog-message");
    else dialog.removeAttribute("aria-describedby");

    renderFields(config.fields);

    const danger = config.danger === true;
    okBtn.className = danger ? "button-delete" : "button-primary";
    okBtn.textContent = config.confirmLabel || (kind === "alert" ? "OK" : kind === "confirm" ? "Confirm" : "Save");
    cancelBtn.textContent = config.cancelLabel || "Cancel";
    const showCancel = kind !== "alert";
    cancelBtn.hidden = !showCancel;
    cancelBtn.disabled = !showCancel;

    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    return new Promise((resolve) => {
      const finish = () => {
        dialog.removeEventListener("close", onClose);
        const accepted = dialog.returnValue === "ok";
        let result = null;
        if (kind === "alert") result = undefined;
        else if (kind === "confirm") result = accepted;
        else if (kind === "prompt") result = accepted ? (readFields().value ?? "") : null;
        else result = accepted ? readFields() : null;
        resolve(result);
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
        if (kind === "prompt" || kind === "form") focusTarget();
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

  function enqueue(config) {
    return new Promise((resolve, reject) => {
      queue.push({ config, resolve, reject });
      drain();
    });
  }

  function drain() {
    if (busy || !queue.length) return;
    const job = queue.shift();
    busy = true;
    present(job.config).then(job.resolve, job.reject).finally(() => {
      busy = false;
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

  function promptDialog(message, options) {
    const opts = options || {};
    return enqueue({
      kind: "prompt",
      message,
      title: opts.title || "Enter a value",
      confirmLabel: opts.confirmLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
      fields: [
        {
          name: "value",
          label: opts.label || "Value",
          type: opts.type || "text",
          value: opts.value == null ? "" : opts.value,
          required: opts.required === true,
          placeholder: opts.placeholder || "",
          maxlength: opts.maxlength,
        },
      ],
    });
  }

  function formDialog(options) {
    const opts = options || {};
    return enqueue({
      kind: "form",
      message: opts.message || "",
      title: opts.title || "Enter details",
      confirmLabel: opts.confirmLabel || opts.submitLabel || "Save",
      cancelLabel: opts.cancelLabel || "Cancel",
      danger: opts.danger === true,
      fields: opts.fields || [],
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
    form: formDialog,
    show,
    hide,
    toast,
  };
})();
