/**
 * Shared hidden-iframe print pipeline (invoice, reports, salary slips, credit, staff ID).
 */
(function (global) {
  const DEFAULT_IFRAME_STYLE =
    "position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none";

  const COMPACT_IFRAME_STYLE =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";

  function resolveAssetUrl(path) {
    return new URL(path, window.location.href).href;
  }

  const PRINT_LOGO_ASSET_RE =
    "logo-44|logo-80|logo-104|logo-print|bpcl-logo|bishnupriya-fuels-logo";
  const PRINT_LOGO_CLASS_RE =
    "invoice-bpcl-logo|report-bpcl-logo|salary-slip-logo";
  const PRINT_LOGO_IMAGE_SELECTORS =
    ".report-bpcl-logo, .invoice-bpcl-logo, .salary-slip-logo";

  /** Resolved absolute URL for letterhead logos in print/PDF output. */
  function getStationLogoPrintUrl() {
    const path =
      (typeof AppConfig !== "undefined" && AppConfig.getStationLogoPrintSrc?.()) ||
      "assets/logo-print.webp";
    return resolveAssetUrl(path);
  }

  /** Normalize logo markup before iframe print (high-res src, no picture/srcset). */
  function applyPrintLogos(html) {
    const logoUrl = getStationLogoPrintUrl();
    return String(html || "")
      .replace(
        new RegExp(
          `<picture>[\\s\\S]*?<img([^>]*class="[^"]*(?:${PRINT_LOGO_CLASS_RE})[^"]*"[^>]*)>[\\s\\S]*?<\\/picture>`,
          "gi"
        ),
        `<img$1 src="${logoUrl}" width="128" height="128" />`
      )
      .replace(
        new RegExp(`src="[^"]*(?:${PRINT_LOGO_ASSET_RE})[^"]*"`, "gi"),
        `src="${logoUrl}"`
      )
      .replace(
        new RegExp(`srcset="[^"]*(?:${PRINT_LOGO_ASSET_RE})[^"]*"`, "gi"),
        ""
      );
  }

  function escapeInlineCss(cssText) {
    return String(cssText || "").replace(/<\/style/gi, "<\\/style");
  }

  async function waitForFrameLoad(win, timeoutMs = 5000) {
    await new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, timeoutMs);
      const finish = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      if (win.document.readyState === "complete") {
        finish();
      } else {
        win.addEventListener("load", finish, { once: true });
      }
    });
  }

  /**
   * Wait for one or more images (by selector) before printing.
   * @param {Document} doc
   * @param {string|string[]} selectors
   * @param {number} [timeoutMs]
   */
  async function waitForImages(doc, selectors, timeoutMs = 2500) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const images = list.flatMap((sel) => Array.from(doc.querySelectorAll(sel)));
    const pending = images.filter((img) => img && !img.complete);
    if (!pending.length) return;

    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            })
        )
      ),
      new Promise((resolve) => window.setTimeout(resolve, timeoutMs)),
    ]);
  }

  async function waitForPaint(doc) {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    if (doc?.body) void doc.body.offsetHeight;
  }

  async function waitForPrintReady(doc, win, options = {}) {
    const { imageSelectors = [], waitForLoad = true, timeoutMs = 2500 } = options;
    if (waitForLoad && win) await waitForFrameLoad(win);
    if (imageSelectors.length) await waitForImages(doc, imageSelectors, timeoutMs);
    await waitForPaint(doc);
  }

  function buildPrintDocumentHtml(options) {
    const {
      title = "Print",
      bodyHtml = "",
      cssHref,
      cssText,
      headExtras = "",
      bodyClass = "",
      containerClass = "",
    } = options;

    const titleSafe = typeof escapeHtml === "function" ? escapeHtml(title) : title;
    const cssBlock = cssText
      ? `<style>${escapeInlineCss(cssText)}</style>`
      : cssHref
        ? `<link rel="stylesheet" href="${resolveAssetUrl(cssHref)}" />`
        : "";

    const bodyAttr = bodyClass ? ` class="${bodyClass}"` : "";
    const inner = containerClass
      ? `<div class="${containerClass}">${bodyHtml}</div>`
      : bodyHtml;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${titleSafe}</title>
  ${cssBlock}
  ${headExtras}
</head>
<body${bodyAttr}>
  ${inner}
</body>
</html>`;
  }

  /**
   * Print HTML in a hidden iframe, then remove it after printing.
   * @param {Object} options
   * @returns {Promise<boolean>} true when print dialog opened; false when fallback used
   */
  async function printInIframe(options) {
    const {
      title = "Print",
      bodyHtml = "",
      cssHref,
      cssText,
      headExtras = "",
      bodyClass = "",
      containerClass = "",
      iframeTitle = "Print",
      iframeStyle = DEFAULT_IFRAME_STYLE,
      waitForReady,
      cleanupTimeoutMs = 5000,
      onFallback,
    } = options;

    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", iframeTitle);
    iframe.style.cssText = iframeStyle;
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) {
      iframe.remove();
      if (typeof onFallback === "function") {
        onFallback();
        return false;
      }
      throw new Error("Print frame unavailable");
    }

    doc.open();
    doc.write(
      buildPrintDocumentHtml({
        title,
        bodyHtml,
        cssHref,
        cssText,
        headExtras,
        bodyClass,
        containerClass,
      })
    );
    doc.close();

    try {
      if (typeof waitForReady === "function") {
        await waitForReady(doc, win);
      } else {
        await waitForPrintReady(doc, win, options);
      }

      const cleanup = () => iframe.remove();
      win.addEventListener("afterprint", cleanup, { once: true });
      win.focus();
      win.print();
      window.setTimeout(cleanup, cleanupTimeoutMs);
      return true;
    } catch (err) {
      iframe.remove();
      throw err;
    }
  }

  global.PrintUtils = {
    COMPACT_IFRAME_STYLE,
    DEFAULT_IFRAME_STYLE,
    PRINT_LOGO_IMAGE_SELECTORS,
    applyPrintLogos,
    buildPrintDocumentHtml,
    escapeInlineCss,
    getStationLogoPrintUrl,
    printInIframe,
    resolveAssetUrl,
    waitForFrameLoad,
    waitForImages,
    waitForPaint,
    waitForPrintReady,
  };
})(typeof window !== "undefined" ? window : globalThis);
