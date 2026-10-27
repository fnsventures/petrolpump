/* global AppDialog, AppError, escapeHtml, mountPdfPreview, preloadPdfPreview */
/**
 * In-page preview for a Drive file. The list underneath stays mounted.
 */
(function (global) {
  let seq = 0;
  let dialog = null;
  let titleEl = null;
  let subtitleEl = null;
  let bodyEl = null;
  let actionsEl = null;
  let downloadBtn = null;
  let objectUrl = "";

  function revokeUrl() {
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = "";
  }

  function ensure() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "drive-preview-modal";
    dialog.className = "app-modal app-modal-shell drive-preview-modal hidden";
    dialog.hidden = true;
    dialog.setAttribute("aria-labelledby", "drive-preview-title");
    dialog.innerHTML = `
      <div class="app-modal-backdrop" data-drive-preview-close tabindex="-1" aria-hidden="true"></div>
      <div class="card app-modal-panel drive-preview-panel">
        <div class="card-head snapshot-head app-modal-head">
          <div>
            <h2 id="drive-preview-title"></h2>
            <p id="drive-preview-subtitle" class="muted drive-preview-subtitle"></p>
          </div>
          <button type="button" class="app-modal-close" data-drive-preview-close aria-label="Close">×</button>
        </div>
        <div id="drive-preview-body" class="drive-preview-body"></div>
        <div id="drive-preview-actions" class="drive-preview-actions"></div>
      </div>`;
    document.body.append(dialog);
    titleEl = dialog.querySelector("#drive-preview-title");
    subtitleEl = dialog.querySelector("#drive-preview-subtitle");
    bodyEl = dialog.querySelector("#drive-preview-body");
    actionsEl = dialog.querySelector("#drive-preview-actions");
    dialog.addEventListener("click", (event) => {
      const closer = event.target instanceof Element ? event.target.closest("[data-drive-preview-close]") : null;
      if (closer || event.target === dialog) close();
    });
  }

  function close() {
    if (!dialog) return;
    seq += 1;
    revokeUrl();
    if (bodyEl) bodyEl.innerHTML = "";
    AppDialog.hide(dialog);
  }

  function actionButton(id) {
    if (!actionsEl || !id) return null;
    return actionsEl.querySelector(`[data-preview-action="${id}"]`);
  }

  function setBusy(busy) {
    if (!actionsEl) return;
    actionsEl.querySelectorAll("button").forEach((btn) => {
      if (!btn.hidden) btn.disabled = busy;
    });
    actionsEl.hidden = ![...actionsEl.children].some((el) => !el.hidden);
  }

  async function paint(token, result) {
    if (token !== seq || !bodyEl) return;
    if (result?.html != null) {
      bodyEl.innerHTML = result.html;
      return;
    }
    const blob = result?.blob;
    if (!blob) {
      bodyEl.innerHTML = `<p class="muted">Nothing to preview.</p>`;
      return;
    }
    const fileName = result.fileName || "";
    const type = String(blob.type || "").toLowerCase();
    const isPdf = type === "application/pdf" || /\.pdf$/i.test(fileName);
    if (type.startsWith("image/")) {
      revokeUrl();
      objectUrl = URL.createObjectURL(blob);
      bodyEl.replaceChildren();
      const frame = document.createElement("div");
      frame.className = "drive-preview-frame";
      const img = document.createElement("img");
      img.alt = fileName || "Document";
      img.src = objectUrl;
      frame.append(img);
      bodyEl.append(frame);
      return;
    }
    if (isPdf) {
      if (typeof preloadPdfPreview === "function") preloadPdfPreview();
      bodyEl.innerHTML = `<div class="drive-preview-pages"></div>`;
      const pages = bodyEl.querySelector(".drive-preview-pages");
      try {
        await mountPdfPreview(pages, blob);
      } catch (err) {
        if (token !== seq) return;
        AppError?.report?.(err, { context: "drivePreviewPdf" });
        if (pages?.isConnected) {
          bodyEl.innerHTML = `<p class="muted">This PDF can’t be previewed here. Use Download to save it.</p>`;
        }
      }
      return;
    }
    bodyEl.innerHTML = `<p class="muted">This file can’t be previewed here. Use Download to save it.</p>`;
  }

  function renderActions(token, options) {
    actionsEl.replaceChildren();
    downloadBtn = null;
    if (typeof options.download === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "button-secondary";
      btn.textContent = "Download";
      btn.disabled = true;
      btn.addEventListener("click", () => {
        btn.disabled = true;
        Promise.resolve()
          .then(() => options.download())
          .catch((err) => {
            AppError?.report?.(err, { context: "drivePreviewDownload" });
            AppError?.showToast?.(AppError.getUserMessage(err) || "Download failed.", "error");
          })
          .finally(() => {
            if (token === seq) btn.disabled = false;
          });
      });
      actionsEl.append(btn);
      downloadBtn = btn;
    }
    (options.actions || []).forEach((action) => {
      const id = String(action.id || "").trim();
      if (!/^[a-z0-9-]+$/i.test(id)) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = action.className || "button-secondary";
      btn.textContent = action.label || "Action";
      btn.hidden = action.hidden === true;
      btn.disabled = true;
      btn.dataset.previewAction = id;
      btn.addEventListener("click", () => {
        action.onClick?.();
      });
      actionsEl.append(btn);
    });
    actionsEl.hidden = actionsEl.childElementCount === 0;
  }

  /**
   * @param {{ title?: string, subtitle?: string, download?: (() => Promise<void>)|null, actions?: Array<{ id: string, label: string, hidden?: boolean, className?: string, onClick?: () => void }>, load: (ctx: object) => Promise<{ blob?: Blob, fileName?: string, html?: string }|null|undefined> }} options
   */
  function open(options) {
    const token = ++seq;
    ensure();
    revokeUrl();
    if (titleEl) titleEl.textContent = options.title || "Document";
    if (subtitleEl) {
      subtitleEl.textContent = options.subtitle || "";
      subtitleEl.hidden = !options.subtitle;
    }
    if (bodyEl) bodyEl.innerHTML = `<p class="drive-preview-loading">Opening…</p>`;
    renderActions(token, options);
    const ctx = {
      isCurrent: () => token === seq,
      setTitle(text) {
        if (token === seq && titleEl) titleEl.textContent = text || "Document";
      },
      setSubtitle(text) {
        if (token !== seq || !subtitleEl) return;
        subtitleEl.textContent = text || "";
        subtitleEl.hidden = !text;
      },
      showAction(id, visible) {
        const btn = actionButton(id);
        if (btn) btn.hidden = !visible;
      },
      showDownload(visible) {
        if (downloadBtn) downloadBtn.hidden = !visible;
      },
    };
    AppDialog.show(dialog, { focus: ".app-modal-close", onDismiss: close });
    Promise.resolve()
      .then(() => options.load(ctx))
      .then(async (result) => {
        if (token !== seq) return;
        setBusy(false);
        await paint(token, result);
      })
      .catch((err) => {
        if (token !== seq || !bodyEl) return;
        AppError?.report?.(err, { context: "drivePreview" });
        const message = AppError?.getUserMessage?.(err) || err?.message || "Could not open the document.";
        bodyEl.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
      });
  }

  global.DrivePreview = { open, close };
})(typeof window !== "undefined" ? window : globalThis);
