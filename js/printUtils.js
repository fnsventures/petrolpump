/**
 * Shared hidden-iframe print pipeline (invoice, reports, salary slips, credit, staff ID, letterhead).
 * On mobile Chrome/Safari, iframe.contentWindow.print() prints the parent page instead —
 * those clients use an in-page print host that calls window.print().
 */
(function (global) {
  const DEFAULT_IFRAME_STYLE =
    "position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none";

  const COMPACT_IFRAME_STYLE =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";

  const PRINT_HOST_ID = "print-utils-host";

  const PRINT_HOST_SHELL_CSS = `
#${PRINT_HOST_ID} {
  position: fixed;
  left: 0;
  top: 0;
  width: 210mm;
  max-width: 100%;
  margin: 0;
  padding: 0;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
  background: #fff;
}
@media print {
  body > *:not(#${PRINT_HOST_ID}) {
    display: none !important;
  }
  #${PRINT_HOST_ID} {
    display: block !important;
    position: static !important;
    left: auto !important;
    top: auto !important;
    width: 100% !important;
    max-width: none !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    z-index: auto !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;

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

  /**
   * Sanitize one segment for Print → Save as PDF default filenames.
   * Keeps letters/numbers (incl. Unicode), collapses spaces to hyphens, lowercases.
   * @param {unknown} text
   * @param {number} [maxLen=48]
   * @returns {string}
   */
  function sanitizeFilenamePart(text, maxLen = 48) {
    const lim = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 48;
    return String(text ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\/\\]+/g, "-")
      .replace(/[^\p{L}\p{N}\s._-]+/gu, "")
      .trim()
      .replace(/[\s._]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, lim)
      .replace(/-+$/g, "")
      .toLowerCase();
  }

  /**
   * Hyphenated print/PDF title from parts (type, name, month, dates, …).
   * Empty parts are skipped. Example:
   * buildPrintFilename("salary-slip", "Rajesh Kumar", "2025-07")
   * → "salary-slip-rajesh-kumar-2025-07"
   * @param {...unknown} parts
   * @returns {string}
   */
  function buildPrintFilename(...parts) {
    const joined = parts
      .flat()
      .map((p) => sanitizeFilenamePart(p))
      .filter(Boolean)
      .join("-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return joined || "document";
  }

  /**
   * Mobile browsers (esp. Chrome Android) ignore iframe print and print the top page.
   * Cached after first check — UA does not change mid-session.
   * @returns {boolean}
   */
  let _iframePrintUnreliable;
  function iframePrintUnreliable() {
    if (typeof _iframePrintUnreliable === "boolean") return _iframePrintUnreliable;
    if (typeof navigator === "undefined") {
      _iframePrintUnreliable = false;
      return false;
    }
    const ua = navigator.userAgent || "";
    _iframePrintUnreliable =
      /Android/i.test(ua) ||
      /iPhone|iPad|iPod/i.test(ua) ||
      (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
    return _iframePrintUnreliable;
  }

  /**
   * Print CSS files target html/body (iframe document). Remap those selectors
   * onto the in-page print host so host-mode print keeps the same layout.
   */
  function adaptPrintCssForHost(cssText) {
    return String(cssText || "")
      .replace(
        /(^|[,{\s>+~])html(\s*,\s*body)?(?=[\s,{>:#[.]|$)/g,
        (_, pre) => `${pre}#${PRINT_HOST_ID}`
      )
      .replace(
        /(^|[,{\s>+~])body(\.[\w-]+)?(?=[\s,{>:#[.]|$)/g,
        (_, pre, cls) => `${pre}#${PRINT_HOST_ID}${cls || ""}`
      );
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

  function clearPrintHostArtifacts() {
    document.querySelectorAll("[data-print-utils]").forEach((el) => el.remove());
    document.getElementById(PRINT_HOST_ID)?.remove();
  }

  async function waitForStylesheet(link, timeoutMs = 2000) {
    await Promise.race([
      new Promise((resolve) => {
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener("error", resolve, { once: true });
      }),
      new Promise((resolve) => window.setTimeout(resolve, timeoutMs)),
    ]);
  }

  async function injectHeadExtras(headExtras, { printOnly = false } = {}) {
    if (!headExtras) return;
    const template = document.createElement("template");
    template.innerHTML = String(headExtras).trim();
    const pending = [];
    for (const node of Array.from(template.content.children)) {
      node.setAttribute("data-print-utils", "extra");
      if (
        printOnly &&
        node.tagName === "LINK" &&
        node.getAttribute("rel") === "stylesheet" &&
        !node.getAttribute("media")
      ) {
        // Avoid restyling the live page while the print dialog is open.
        node.setAttribute("media", "print");
      }
      if (node.tagName === "LINK" && node.getAttribute("rel") === "stylesheet") {
        pending.push(waitForStylesheet(node));
      }
      document.head.appendChild(node);
    }
    if (pending.length) await Promise.all(pending);
  }

  async function resolvePrintCssText(cssText, cssHref) {
    if (cssText) return String(cssText);
    if (!cssHref) return "";
    const res = await fetch(resolveAssetUrl(cssHref), { cache: "default" });
    if (!res.ok) throw new Error("Could not load print stylesheet.");
    return await res.text();
  }

  /**
   * Print via a temporary host on the current page (mobile-safe).
   * Hides all other body children under @media print.
   */
  async function printInHostDocument(options) {
    const {
      title = "Print",
      bodyHtml = "",
      cssHref,
      cssText,
      headExtras = "",
      bodyClass = "",
      containerClass = "",
      waitForReady,
      cleanupTimeoutMs = 5000,
    } = options;

    clearPrintHostArtifacts();

    const prevTitle = document.title;
    document.title = title;

    const shellStyle = document.createElement("style");
    shellStyle.setAttribute("data-print-utils", "shell");
    shellStyle.textContent = PRINT_HOST_SHELL_CSS;
    document.head.appendChild(shellStyle);

    const resolvedCss = await resolvePrintCssText(cssText, cssHref);
    if (resolvedCss) {
      const contentStyle = document.createElement("style");
      contentStyle.setAttribute("data-print-utils", "css");
      // Keep slip/report CSS off the live screen; apply only when printing.
      // Remap html/body selectors onto the host (iframe CSS assumes a full document).
      contentStyle.textContent = `@media print {\n${escapeInlineCss(
        adaptPrintCssForHost(resolvedCss)
      )}\n}`;
      document.head.appendChild(contentStyle);
    }

    await injectHeadExtras(headExtras, { printOnly: true });

    const host = document.createElement("div");
    host.id = PRINT_HOST_ID;
    if (bodyClass) host.className = bodyClass;
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = containerClass
      ? `<div class="${containerClass}">${bodyHtml}</div>`
      : bodyHtml;
    document.body.appendChild(host);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearPrintHostArtifacts();
      document.title = prevTitle;
    };

    try {
      if (typeof waitForReady === "function") {
        await waitForReady(document, window);
      } else {
        await waitForPrintReady(document, window, {
          ...options,
          waitForLoad: false,
        });
      }

      window.addEventListener("afterprint", cleanup, { once: true });
      window.focus();
      window.print();
      window.setTimeout(cleanup, cleanupTimeoutMs);
      return true;
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  /**
   * Print HTML in a hidden iframe, then remove it after printing.
   * On mobile, uses an in-page print host instead (iframe print is unreliable).
   * @param {Object} options
   * @returns {Promise<boolean>} true when print dialog opened; false when fallback used
   */
  async function printInIframe(options) {
    if (iframePrintUnreliable()) {
      return printInHostDocument(options);
    }

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
    buildPrintFilename,
    escapeInlineCss,
    getStationLogoPrintUrl,
    iframePrintUnreliable,
    printInIframe,
    resolveAssetUrl,
    sanitizeFilenamePart,
    waitForFrameLoad,
    waitForImages,
    waitForPaint,
    waitForPrintReady,
  };
})(typeof window !== "undefined" ? window : globalThis);
