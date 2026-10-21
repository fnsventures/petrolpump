/**
 * Centralized error handling for Petrol Pump application.
 * - User-friendly error messages
 * - Optional reporting to monitoring service
 * - Retry logic for transient failures
 * - Global handlers for uncaught errors and unhandled rejections
 */

(function () {
  "use strict";

  const CONFIG = (typeof window !== "undefined" && window.__APP_CONFIG__) || {};
  const REPORT_URL = CONFIG.ERROR_REPORT_URL || null;
  const APP_ENV = CONFIG.APP_ENV || "staging";

  // Patterns/codes that indicate transient failures (worth retrying)
  const TRANSIENT_PATTERNS = [
    /network\s*error/i,
    /failed\s*to\s*fetch/i,
    /load\s*failed/i,
    /timeout/i,
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
    /503\s*service\s*unavailable/i,
    /502\s*bad\s*gateway/i,
    /504\s*gateway\s*timeout/i,
    /429\s*too\s*many\s*requests/i,
  ];

  const TRANSIENT_HTTP_CODES = [408, 429, 500, 502, 503, 504];

  /**
   * Normalize unknown values to an Error-like object.
   * @param {*} err
   * @returns {{ message: string, code?: string, original: unknown }}
   */
  function normalizeError(err) {
    if (!err) {
      return { message: "Something went wrong.", original: err };
    }
    if (err instanceof Error) {
      return {
        message: err.message,
        code: err.code,
        name: err.name,
        original: err,
      };
    }
    if (typeof err === "object" && err !== null && "message" in err) {
      return {
        message: String(err.message),
        code: err.code != null ? String(err.code) : undefined,
        name: err.name != null ? String(err.name) : undefined,
        original: err,
      };
    }
    return { message: String(err), original: err };
  }

  const RELOAD_MESSAGE = "Something went wrong. Reload the page and try again.";

  function isRawClientFailure(message, name) {
    if (/^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)$/.test(name || "")) {
      return true;
    }
    return /cannot read propert|cannot set propert|cannot convert|is not a function|is not defined|is not iterable|is not a constructor|undefined is not|null is not|unexpected token|unexpected end|maximum call stack|assignment to constant|circular structure/i.test(
      message || ""
    );
  }

  /** Postgres RAISE / check messages this app wrote. Shown unchanged. */
  function isOwnServerMessage(message, code) {
    const text = String(message || "").trim();
    if (!text) return false;
    if (code === "P0001") return true;
    return code === "23514" && !/violates check constraint/i.test(text);
  }

  /**
   * A sentence we wrote (client check or server RAISE whose code was dropped).
   * Infrastructure and engine boilerplate stay out so they can be translated.
   */
  function isHumanAppMessage(message) {
    const text = String(message || "").trim();
    if (!text || text.length > 400 || !/\s/.test(text)) return false;
    if (isRawClientFailure(text, "")) return false;
    if (/\n/.test(text) && /\bat\s+\S+\s+\(/.test(text)) return false;
    return !/violates |duplicate key|syntax error at|permission denied for (table|relation|schema)|row-level security|jwt|pgrst\d|failed to fetch|network\s*error|load failed|timeout|timed out|invalid login|invalid_credentials|email not confirmed|too many requests/i.test(
      text
    );
  }

  /**
   * Map technical errors to user-friendly messages.
   * @param {string} message
   * @param {{ code?: string, httpStatus?: number }} context
   * @returns {string}
   */
  function getUserFriendlyMessage(message, context) {
    const code = (context && context.code) || "";
    const status = context && context.httpStatus;
    const name = (context && context.name) || "";
    const text = String(message || "").trim();
    const lower = text.toLowerCase();

    // PGRST116 - No rows returned (expected for .maybeSingle()/.single() when no match)
    if (code === "PGRST116" || lower.includes("pgrst116") || lower.includes("no rows")) {
      return "";
    }

    if (isRawClientFailure(text, name)) return RELOAD_MESSAGE;

    // Application text, including RAISE EXCEPTION, stays as written.
    if (isOwnServerMessage(text, code) || isHumanAppMessage(text)) return text;

    if (lower.includes("invalid login") || lower.includes("invalid_credentials")) {
      return "Invalid email or password. Please try again.";
    }
    if (lower.includes("email not confirmed")) {
      return "Please confirm your email before signing in.";
    }
    if (lower.includes("failed to fetch") || lower.includes("network error") || lower.includes("load failed")) {
      return "Connection problem. Please check your internet and try again.";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "The request took too long. Please try again.";
    }
    if (status === 429 || lower.includes("too many requests")) {
      return "Too many requests. Please wait a moment and try again.";
    }
    if (status >= 500 || lower.includes("503") || lower.includes("502") || lower.includes("504")) {
      return "Our servers are temporarily busy. Please try again in a moment.";
    }
    if (lower.includes("duplicate key") || lower.includes("unique constraint") || code === "23505") {
      return "This record already exists. Please use a different value.";
    }
    if (lower.includes("foreign key") || code === "23503") {
      return "This action cannot be completed because it references missing data.";
    }
    if (
      lower.includes("row-level security") ||
      lower.includes("permission denied for table") ||
      lower.includes("permission denied for relation")
    ) {
      return "You don't have permission to perform this action.";
    }
    if (lower.includes("jwt") || lower.includes("invalid token") || lower.includes("token expired")) {
      return "Your session may have expired. Please sign in again.";
    }

    return RELOAD_MESSAGE;
  }

  /**
   * Extract HTTP status from Supabase/postgrest error if present.
   * @param {*} err
   * @returns {number|undefined}
   */
  function getHttpStatus(err) {
    if (!err || typeof err !== "object") return undefined;
    if (typeof err.status === "number") return err.status;
    if (typeof err.statusCode === "number") return err.statusCode;
    return undefined;
  }

  /**
   * Report error to monitoring service (if configured).
   * @param {*} err
   * @param {Object} context
   */
  function reportToMonitoring(err, context) {
    if (!REPORT_URL || typeof fetch === "undefined") return;

    const normalized = normalizeError(err);
    const payload = {
      env: APP_ENV,
      message: normalized.message,
      code: normalized.code,
      url: typeof window !== "undefined" ? window.location.href : "",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      timestamp: new Date().toISOString(),
      ...context,
    };

    try {
      fetch(REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {
        // Silently ignore report failures to avoid feedback loops
      });
    } catch (_) {
      // Ignore
    }
  }

  /**
   * Check if the error looks transient (suitable for retry).
   * @param {*} err
   * @returns {boolean}
   */
  function isTransientError(err) {
    const normalized = normalizeError(err);
    const msg = (normalized.message || "").toLowerCase();
    const status = getHttpStatus(normalized.original);

    if (status != null && TRANSIENT_HTTP_CODES.includes(status)) return true;
    return TRANSIENT_PATTERNS.some(function (p) {
      return p.test(msg);
    });
  }

  /**
   * Retry an async function with exponential backoff for transient failures.
   * @param {() => Promise<T>} fn
   * @param {{ maxAttempts?: number, baseMs?: number, maxMs?: number, isRetryable?: (err: unknown) => boolean }} options
   * @returns {Promise<T>}
   */
  async function withRetry(fn, options) {
    const maxAttempts = options && options.maxAttempts != null ? options.maxAttempts : 3;
    const baseMs = options && options.baseMs != null ? options.baseMs : 500;
    const maxMs = options && options.maxMs != null ? options.maxMs : 10000;
    const isRetryable = options && typeof options.isRetryable === "function" ? options.isRetryable : isTransientError;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isRetryable(err)) throw err;
        const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
        await new Promise(function (r) {
          setTimeout(r, delay);
        });
      }
    }
    throw lastErr;
  }

  let fieldErrorSeq = 0;

  function labelText(control) {
    const doc = control.ownerDocument;
    if (control.id && doc) {
      const labels = doc.querySelectorAll("label[for]");
      for (let i = 0; i < labels.length; i++) {
        if (labels[i].htmlFor === control.id || labels[i].getAttribute("for") === control.id) {
          return labels[i].textContent || "";
        }
      }
    }
    const wrap = control.closest && control.closest("label");
    if (wrap) return wrap.textContent || "";
    return control.getAttribute("aria-label") || "";
  }

  function findFieldForMessage(form, message) {
    if (!form || !message || typeof form.querySelectorAll !== "function") return null;
    const text = String(message).toLowerCase();
    const controls = form.querySelectorAll("input, select, textarea, button");
    let best = null;
    let bestScore = 0;
    const ignore = { input: 1, select: 1, field: 1, form: 1, this: 1, that: 1, with: 1, from: 1, enter: 1, value: 1, button: 1 };
    for (let i = 0; i < controls.length; i++) {
      const control = controls[i];
      if (control.type === "hidden" || control.disabled) continue;
      const label = labelText(control).toLowerCase().replace(/\s+/g, " ").trim();
      const name = `${control.name || ""} ${control.id || ""}`.toLowerCase().replace(/[_-]+/g, " ");
      let score = 0;
      const cleanLabel = label.replace(/[:*()₹]/g, "").trim();
      if (cleanLabel.length > 2 && text.includes(cleanLabel)) score += 50 + cleanLabel.length;
      const tokens = `${label} ${name}`.split(/[^a-z0-9]+/);
      for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        if (!token || token.length < 4 || ignore[token]) continue;
        if (text.includes(token)) score += token.length;
      }
      if (score > bestScore) {
        best = control;
        bestScore = score;
      }
    }
    return bestScore >= 4 ? best : null;
  }

  function clearFieldError(field) {
    if (!field) return;
    const id = field.dataset && field.dataset.fieldErrorId;
    if (id && field.ownerDocument) {
      const note = field.ownerDocument.getElementById(id);
      if (note) note.remove();
    }
    if (field.dataset) delete field.dataset.fieldErrorId;
    field.removeAttribute("aria-invalid");
    const described = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter((part) => part && part !== id);
    if (described.length) field.setAttribute("aria-describedby", described.join(" "));
    else field.removeAttribute("aria-describedby");
  }

  function showFieldError(field, message) {
    if (!field || !field.ownerDocument) return;
    clearFieldError(field);
    const text = String(message || "").trim();
    if (!text) return;
    const note = field.ownerDocument.createElement("p");
    note.className = "field-error";
    note.id = `field-error-${++fieldErrorSeq}`;
    note.setAttribute("role", "alert");
    note.textContent = text;
    const host = (field.closest && field.closest(".form-field, td")) || field.parentElement;
    if (host) host.appendChild(note);
    else field.insertAdjacentElement("afterend", note);
    if (field.dataset) field.dataset.fieldErrorId = note.id;
    field.setAttribute("aria-invalid", "true");
    const described = field.getAttribute("aria-describedby");
    field.setAttribute("aria-describedby", described ? `${described} ${note.id}` : note.id);
    if (!field.dataset.fieldErrorClear) {
      field.dataset.fieldErrorClear = "1";
      const clear = () => clearFieldError(field);
      field.addEventListener("input", clear);
      field.addEventListener("change", clear);
    }
    const focusable = /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(field.tagName || "");
    if (!focusable && field.tabIndex < 0) field.tabIndex = -1;
    try {
      field.focus({ preventScroll: true });
    } catch (_) {
      try { field.focus(); } catch (_focus) { /* not focusable */ }
    }
    if (typeof field.scrollIntoView === "function") {
      field.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * Put a save error on the control it describes and move focus there.
   * Falls back to the form's error element when no control matches.
   * @returns {boolean} true when the message was placed on a field
   */
  function showSaveError(message, options) {
    const opts = options || {};
    const text = String(message || "").trim();
    if (!text) return false;
    const form = opts.form || (opts.field && opts.field.form) || (opts.target && opts.target.closest && opts.target.closest("form"));
    const field = opts.field || findFieldForMessage(form, text);
    if (field) {
      showFieldError(field, text);
      if (opts.target && typeof opts.target.textContent !== "undefined") {
        opts.target.textContent = "";
        opts.target.classList && opts.target.classList.add("hidden");
      }
      return true;
    }
    if (opts.target && typeof opts.target.textContent !== "undefined") {
      opts.target.textContent = text;
      opts.target.classList && opts.target.classList.remove("hidden");
    }
    return false;
  }

  /**
   * Central handle: normalize, get friendly message, report, optionally show in UI.
   * @param {*} err
   * @param {{ target?: HTMLElement | null, report?: boolean, context?: Object, toast?: boolean }} options
   *   toast defaults to false (opt-in) so form field errors are not double-shown.
   * @returns {string} User-friendly message
   */
  function handle(err, options) {
    const opts = options || {};
    const target = opts.target;
    const shouldReport = opts.report !== false;
    const shouldToast = opts.toast === true;
    const context = opts.context || {};

    const normalized = normalizeError(err);
    const httpStatus = getHttpStatus(normalized.original);
    const friendly = getUserFriendlyMessage(normalized.message, {
      code: normalized.code,
      name: normalized.name,
      httpStatus,
    });

    // PGRST116 (no rows) is expected - don't report or show to user
    const isExpectedNoRows = normalized.code === "PGRST116" ||
      (normalized.message && normalized.message.toLowerCase().includes("no rows"));

    if (shouldReport && !isExpectedNoRows) {
      reportToMonitoring(err, { ...context, friendlyMessage: friendly, httpStatus });
    }

    if (typeof console !== "undefined" && console.error) {
      console.error("[AppError]", friendly, normalized.original);
    }

    const placedOnField = friendly
      ? showSaveError(friendly, { field: opts.field, target, form: opts.form })
      : false;
    if (!placedOnField && target && typeof target.textContent !== "undefined" && !friendly) {
      target.textContent = "";
      target.classList && target.classList.add("hidden");
    }

    if (shouldToast && friendly && !isExpectedNoRows && !placedOnField) {
      showToast(friendly, "error");
    }

    return friendly;
  }

  /**
   * Show a global error banner (creates and injects if not present).
   * @param {string} message
   */
  function showGlobalBanner(message) {
    if (typeof document === "undefined" || !document.body) return;

    let banner = document.getElementById("app-error-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "app-error-banner";
      banner.setAttribute("role", "alert");
      banner.className = "app-error-banner";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "app-error-banner-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "×";
      close.addEventListener("click", function () {
        banner.classList.add("hidden");
      });
      banner.appendChild(document.createTextNode(""));
      banner.appendChild(close);
      document.body.insertBefore(banner, document.body.firstChild);
    }

    const text = banner.firstChild;
    if (text && text.nodeType === Node.TEXT_NODE) {
      text.textContent = message;
    } else {
      banner.insertBefore(document.createTextNode(message), banner.firstChild);
    }
    banner.classList.remove("hidden");
  }

  function onUnhandledError(event) {
    const err = event.error || event.reason || new Error("Unknown error");
    const friendly = handle(err, { report: true, context: { source: "global" } });
    showGlobalBanner(friendly);
    if (event.preventDefault) event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    return false;
  }

  function onUnhandledRejection(event) {
    const err = event.reason;
    if (!err) return;
    const friendly = handle(err, { report: true, context: { source: "unhandledrejection" } });
    showGlobalBanner(friendly);
    event.preventDefault();
  }

  // Attach global handlers
  if (typeof window !== "undefined") {
    window.addEventListener("error", onUnhandledError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  /**
   * A modal dialog stays above other top-layer popovers. Park the element
   * inside the topmost open dialog, then show it as a manual popover, so a
   * toast or the progress overlay paints over that dialog. No-op where
   * popovers are unsupported.
   */
  function topmostOpenDialog() {
    const open = document.querySelectorAll("dialog[open]");
    if (!open.length) return null;
    const active = document.activeElement;
    if (active && typeof active.closest === "function") {
      const owner = active.closest("dialog[open]");
      if (owner) return owner;
    }
    return open[open.length - 1];
  }

  function layerIsShowing(el) {
    if (!el || el.hidden) return false;
    if (el.id === "app-toast-container") return !!el.querySelector(".app-toast");
    return el.id === "action-progress";
  }

  function raiseToTopLayer(el) {
    if (!el || typeof el.showPopover !== "function") return;
    const host = topmostOpenDialog() || document.body;
    if (el.parentElement !== host) host.appendChild(el);
    if (!el.hasAttribute("popover")) el.setAttribute("popover", "manual");
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      el.showPopover();
    } catch (_) {
      /* element not connected */
    }
  }

  function retargetOpenLayers() {
    ["app-toast-container", "action-progress"].forEach((id) => {
      const el = document.getElementById(id);
      if (!layerIsShowing(el)) return;
      const host = topmostOpenDialog() || document.body;
      if (el.parentElement !== host || !el.matches(":popover-open")) raiseToTopLayer(el);
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("close", (event) => {
      if (event.target instanceof HTMLDialogElement) retargetOpenLayers();
    }, true);
    const layerObserver = new MutationObserver((records) => {
      if (records.some((record) => record.target instanceof HTMLDialogElement && record.target.open)) {
        retargetOpenLayers();
      }
    });
    layerObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
  }

  /**
   * Toast notification system for user-facing messages.
   * Error toasts stay until dismissed. Pass duration 0 to keep any toast up.
   * @param {string} message
   * @param {string} [type="info"] - "success" | "error" | "warning" | "info"
   * @param {number} [duration=4000]
   * @param {{ actionLabel?: string, onAction?: () => void }} [extras]
   */
  function showToast(message, type = "info", duration = 4000, extras) {
    if (typeof document === "undefined" || !document.body) return;
    const text = String(message || "").trim();
    if (!text) return;
    const options = extras && typeof extras === "object" ? extras : null;
    const sticky = type === "error" || !duration;

    let container = document.getElementById("app-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "app-toast-container";
      container.setAttribute("aria-live", "polite");
      container.setAttribute("aria-atomic", "true");
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `app-toast app-toast--${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");

    const body = document.createElement("span");
    body.className = "app-toast-message";
    body.textContent = text;
    toast.appendChild(body);

    let timer = 0;
    const dismiss = () => {
      clearTimeout(timer);
      toast.classList.remove("app-toast--visible");
      const remove = () => toast.remove();
      toast.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 300);
    };

    if (options && options.actionLabel && typeof options.onAction === "function") {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "app-toast-action";
      action.textContent = options.actionLabel;
      action.addEventListener("click", (e) => {
        e.stopPropagation();
        dismiss();
        try {
          options.onAction();
        } catch (err) {
          if (window.AppError?.handle) AppError.handle(err, { context: { source: "toastAction" } });
        }
      });
      toast.appendChild(action);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "app-toast-close";
    closeBtn.setAttribute("aria-label", "Dismiss");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
    });
    toast.appendChild(closeBtn);

    container.appendChild(toast);
    raiseToTopLayer(container);

    requestAnimationFrame(() => {
      toast.classList.add("app-toast--visible");
    });

    if (!sticky) timer = setTimeout(dismiss, duration);
  }

  // Public API
  window.AppError = {
    handle: handle,
    getUserMessage: function (err) {
      const n = normalizeError(err);
      return getUserFriendlyMessage(n.message, {
        code: n.code,
        name: n.name,
        httpStatus: getHttpStatus(n.original),
      });
    },
    report: reportToMonitoring,
    withRetry: withRetry,
    isTransient: isTransientError,
    showGlobalBanner: showGlobalBanner,
    showToast: showToast,
    showFieldError: showFieldError,
    clearFieldError: clearFieldError,
    showSaveError: showSaveError,
    raiseToTopLayer: raiseToTopLayer,
    normalize: normalizeError,
  };
})();

/**
 * Shared admin delete UX: role guard, confirm, disable button, cache invalidation.
 */
const AdminDelete = (function () {
  function dataAttrName(key) {
    return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  }

  /**
   * Unified admin delete button markup for table actions and forms.
   * @param {object} options
   * @param {string} options.selector - Page-specific class for event delegation (e.g. "expense-delete-btn")
   * @param {Record<string, string|number>} [options.data] - data-* attributes (camelCase keys)
   * @param {string} [options.label="Delete"]
   * @param {string} [options.title="Delete (admin)"]
   * @param {boolean} [options.small=true]
   */
  function buttonHtml(options) {
    const {
      selector,
      data = {},
      label = "Delete",
      title = "Delete (admin)",
      small = true,
    } = options || {};

    const classes = ["button-delete", small && "button-small", selector].filter(Boolean).join(" ");
    const dataAttrs = Object.entries(data)
      .map(([key, val]) => `data-${dataAttrName(key)}="${escapeHtml(val)}"`)
      .join(" ");
    const attrs = [dataAttrs, `title="${escapeHtml(title)}"`].filter(Boolean).join(" ");

    return `<button type="button" class="${classes}" ${attrs}>${escapeHtml(label)}</button>`;
  }

  function requireAdmin(auth, actionLabel) {
    if (auth?.role === "admin") return true;
    AppDialog.toast(`Only an admin can ${actionLabel}.`, "warning");
    return false;
  }

  function bindOnce(container, selector, handler, datasetKey) {
    const key = datasetKey || "adminDeleteBound";
    if (!container || container.dataset[key]) return;
    container.dataset[key] = "1";
    container.addEventListener("click", async (e) => {
      const btn = e.target.closest?.(selector);
      if (!btn) return;
      e.preventDefault();
      await handler(btn);
    });
  }

  async function execute(options) {
    const {
      btn,
      auth,
      actionLabel,
      confirmMessage,
      deleteFn,
      cacheScope = "operational",
      onSuccess,
      errorContext,
    } = options;

    if (!requireAdmin(auth, actionLabel)) return;
    if (!(await AppDialog.confirm(confirmMessage, { title: "Delete record", confirmLabel: "Delete", danger: true }))) return;

    if (btn) btn.disabled = true;
    const progress = window.ActionProgress;
    try {
      await progress.track(
        {
          title: "Deleting",
          status: "Removing this record…",
          doneStatus: "Deleted",
        },
        async (p) => {
          p.setStep(0, "Removing from the app and Google Drive…");
          const result = await deleteFn();
          const error = result?.error ?? null;
          if (error) {
            const wrapped = new Error(window.AppError.getUserMessage(error));
            wrapped.original = error;
            wrapped.handled = true;
            AppDialog.toast(wrapped.message, "error");
            window.AppError.report(error, errorContext || {});
            throw wrapped;
          }
          if (typeof window.CacheInvalidation !== "undefined") {
            window.CacheInvalidation.invalidate(cacheScope);
          }
          if (onSuccess) await onSuccess();
        }
      );
    } catch (err) {
      if (btn) btn.disabled = false;
      if (!err?.handled) {
        AppDialog.toast(window.AppError.getUserMessage(err), "error");
        window.AppError.report(err, errorContext || {});
      }
    }
  }

  return { requireAdmin, bindOnce, execute, buttonHtml };
})();

window.AdminDelete = AdminDelete;
