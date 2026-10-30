/* global requireAuth, applyRoleVisibility, escapeHtml, escapeIlikePattern, PumpSettings, loadPumpSettings, PrintUtils, AppError, AppConfig, initPageSections, formatNumericDate, getLocalDateString, readDateRangeFromControls, createDateRangeFilter, getYearRange, AdminDelete, DriveFiles, ActionProgress, syncLoadMorePager, preloadPdfPreview, DrivePreview, debounce, bindUnsavedDraft, runAppRequest, renderTableRetryRow, isCancelledRequestError, resetPaginationLoading, bindLiveRefresh, isSettingsPanelActive */

(function () {
  const PRINT_CSS = "css/letterhead-print.css";
  /** Full 512px station mark. Printed at 28mm; the larger bitmap is what keeps A4 sharp. */
  const LETTER_LOGO_SRC = "assets/bishnupriya-fuels-logo.png";
  const PAGE_SIZE = 20;
  const HISTORY_COLSPAN = 3;
  const LETTER_LIST_SELECT =
    "id, letter_date, subject, export_type, include_sign, created_at, drive_file_id, drive_web_view_link, drive_file_name";
  const LETTER_DETAIL_SELECT = `${LETTER_LIST_SELECT}, body`;

  let currentAuth = null;
  let letterDraft = null;
  let letterheadPrintBusy = false;
  let letterheadPrintCssCache = null;
  let historyReportLetter = null;
  let historyLoadSeq = 0;
  const historyRows = new Map();
  let historyPagination = {
    offset: 0,
    hasMore: true,
    totalCount: 0,
    isLoading: false,
  };

  function letterheadAssetUrl(path) {
    return typeof PrintUtils !== "undefined" && PrintUtils.resolveAssetUrl
      ? PrintUtils.resolveAssetUrl(path)
      : new URL(path, window.location.href).href;
  }

  async function getLetterheadPrintCssText() {
    if (letterheadPrintCssCache) return letterheadPrintCssCache;
    const url = letterheadAssetUrl(PRINT_CSS);
    const res = await fetch(url, { cache: "default" });
    if (!res.ok) throw new Error("Could not load letterhead print styles.");
    letterheadPrintCssCache = await res.text();
    return letterheadPrintCssCache;
  }

  function setPrintButtonsBusy(busy) {
    ["letterhead-print-blank", "letterhead-print-content"].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = busy;
      if (busy) {
        btn.dataset.prevLabel = btn.textContent || "";
        btn.textContent = "Preparing…";
      } else if (btn.dataset.prevLabel != null) {
        btn.textContent = btn.dataset.prevLabel;
        delete btn.dataset.prevLabel;
      }
    });
  }

  function getComposeValues() {
    return {
      date: document.getElementById("letterhead-date")?.value || "",
      subject: document.getElementById("letterhead-subject")?.value?.trim() || "",
      body: document.getElementById("letterhead-body")?.value || "",
      includeSign: Boolean(document.getElementById("letterhead-include-sign")?.checked),
    };
  }

  function hasLetterContent(values) {
    return Boolean(values.subject || String(values.body || "").trim());
  }

  function stationParts() {
    const s = PumpSettings.getStation() || {};
    const short = (s.brandShort || "Bishnu Priya").trim();
    const accent = (s.brandAccent || "Fuels").trim();
    const legal = (s.legalName || "").trim();
    return {
      short,
      accent,
      tagline: (s.tagline || "").trim(),
      address: (s.address || "").trim(),
      email: (s.email || "").trim(),
      mobile: (s.mobile || "").trim(),
      gstin: (s.gstin || "").trim(),
      license: (s.license || "").trim(),
      legalName: legal || `${short} ${accent}`,
      displayName: PumpSettings.getStationDisplayName() || `${short} ${accent}`,
      signFrom: `FROM ${(legal || `${short} ${accent}`).toUpperCase()}`,
    };
  }

  function bodyToParagraphsHtml(bodyText) {
    const raw = String(bodyText || "").replace(/\r\n/g, "\n").trim();
    if (!raw) return "";
    return raw
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block.split("\n").map((line) => escapeHtml(line));
        return `<p class="letterhead-paragraph">${lines.join("<br />")}</p>`;
      })
      .join("");
  }

  function letterLogoUrl() {
    return letterheadAssetUrl(LETTER_LOGO_SRC);
  }

  function buildLetterheadBannerHtml({ logoSrc } = {}) {
    const s = stationParts();
    const logo = logoSrc || letterLogoUrl();

    const contactBits = [];
    if (s.email) contactBits.push(`<span><em>Email</em> ${escapeHtml(s.email)}</span>`);
    if (s.mobile) contactBits.push(`<span><em>Mobile</em> ${escapeHtml(s.mobile)}</span>`);
    if (s.gstin) contactBits.push(`<span><em>GSTIN</em> ${escapeHtml(s.gstin)}</span>`);
    if (s.license) contactBits.push(`<span><em>License</em> ${escapeHtml(s.license)}</span>`);

    return `
      <header class="invoice-letterhead">
        <div class="invoice-logo-wrap">
          ${
            logo
              ? `<img src="${logo}" alt="${escapeHtml(s.displayName)}" class="station-logo invoice-bpcl-logo" width="512" height="512" />`
              : ""
          }
        </div>
        <div class="invoice-letterhead-body">
          <h1 class="invoice-brand">${escapeHtml(s.short)} <span>${escapeHtml(s.accent)}</span></h1>
          ${s.tagline ? `<p class="invoice-tagline">${escapeHtml(s.tagline)}</p>` : ""}
          ${s.address ? `<p class="invoice-address">${escapeHtml(s.address)}</p>` : ""}
          ${contactBits.length ? `<div class="invoice-contact-grid">${contactBits.join("")}</div>` : ""}
        </div>
      </header>`;
  }

  function buildDocumentBodyHtml({ date, subject, body, includeSign }) {
    const dateHtml = date
      ? `<div class="letterhead-meta"><p class="letterhead-date">${escapeHtml(formatNumericDate(date))}</p></div>`
      : "";
    const subjectHtml = subject
      ? `<p class="letterhead-subject"><span class="letterhead-subject-label">Subject:</span> ${escapeHtml(subject)}</p>`
      : "";
    const paragraphs = bodyToParagraphsHtml(body);
    const hasContent = Boolean(subjectHtml || paragraphs || dateHtml);

    if (!hasContent) {
      return `<div class="letterhead-doc-body"><div class="letterhead-blank-spacer" aria-hidden="true"></div></div>`;
    }

    const sign = includeSign
      ? `<div class="letterhead-sign">
          <p class="letterhead-sign-for">${escapeHtml(stationParts().signFrom)}</p>
          <p class="letterhead-sign-role">Authorised Signatory</p>
        </div>`
      : "";

    return `<div class="letterhead-doc-body">${dateHtml}${subjectHtml}${paragraphs}${sign}</div>`;
  }

  function buildSheetHtml({ date = "", subject = "", body = "", logoSrc, includeSign = false } = {}) {
    return `
      <div class="letterhead-sheet">
        ${buildLetterheadBannerHtml({ logoSrc })}
        ${buildDocumentBodyHtml({ date, subject, body, includeSign })}
      </div>`;
  }

  function valuesFromLetterRow(row) {
    return {
      date: row?.letter_date || "",
      subject: row?.subject || "",
      body: row?.body || "",
      includeSign: row?.include_sign !== false,
    };
  }

  function refreshPreview() {
    const preview = document.getElementById("letterhead-preview");
    if (!preview) return;
    const values = getComposeValues();
    preview.innerHTML = buildSheetHtml({
      ...values,
      includeSign: hasLetterContent(values) && values.includeSign,
    });
  }

  function setStatus(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!msg) {
      el.textContent = "";
      el.classList.add("hidden");
      return;
    }
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function showError(msg) {
    setStatus("letterhead-error", msg);
  }

  function showSuccess(msg) {
    setStatus("letterhead-success", msg);
  }

  function refreshLetterheadDriveBanner() {
    const banner = document.getElementById("letterhead-drive-banner");
    if (!banner || typeof DriveFiles === "undefined") return;
    const local = DriveFiles.localSettings();
    if (local.enabled && local.rootFolderId) {
      banner.classList.add("hidden");
      banner.hidden = true;
      banner.textContent = "";
      return;
    }
    const hint =
      currentAuth?.role === "admin"
        ? "Enable it in Settings → Integrations so created letters are archived to Drive."
        : "Ask an admin to enable Google Drive in Settings.";
    banner.className = "smart-alert smart-alert--warning";
    banner.hidden = false;
    banner.classList.remove("hidden");
    banner.textContent = `Google Drive is not fully configured. Letters can still save in history. ${hint}`;
  }

  function clearMessages() {
    showError("");
    showSuccess("");
  }

  function previewSnippet(text, maxLen = 72) {
    const oneLine = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!oneLine) return "—";
    if (oneLine.length <= maxLen) return oneLine;
    return `${oneLine.slice(0, maxLen - 1)}…`;
  }

  async function saveLetterHistoryToDatabase(values, exportType) {
    const payload = {
      letter_date:
        values.date || getLocalDateString(),
      subject: (values.subject || "").trim() || previewSnippet(values.body, 80).replace(/^—$/, "") || "Letter",
      body: values.body || "",
      export_type: exportType === "word" ? "word" : exportType === "save" ? "save" : "print",
      include_sign: Boolean(values.includeSign),
    };
    if (currentAuth?.session?.user?.id) {
      payload.created_by = currentAuth.session.user.id;
    }

    const { data, error } = await window.supabaseClient
      .from("letterhead_letters")
      .insert(payload)
      .select(LETTER_DETAIL_SELECT)
      .single();
    if (error) {
      AppError?.report?.(error, { context: "letterheadSaveHistory" });
      return { ok: false, error };
    }
    letterDraft?.markClean();
    return { ok: true, letter: data };
  }

  function driveConfiguredLocally() {
    const local = typeof DriveFiles !== "undefined" ? DriveFiles.localSettings?.() : null;
    return Boolean(local?.enabled && local?.rootFolderId);
  }

  /** Store the letter PDF in Google Drive after the history row has committed. */
  async function fileLetterToDrive(letterId) {
    if (!letterId || typeof DriveFiles === "undefined" || typeof DriveFiles.archive !== "function") {
      if (driveConfiguredLocally()) {
        throw new Error("The letter was saved, but the PDF was not filed to Google Drive.");
      }
      return { filed: false, reason: "unavailable" };
    }
    if (!driveConfiguredLocally()) {
      return { filed: false, reason: "not_configured" };
    }
    const data = await DriveFiles.archive({ kind: "letter", letterId });
    if (data?.letter?.drive_file_id) return { filed: true };
    if (data?.skipped && data?.reason === "drive_disabled") {
      return { filed: false, reason: "not_configured" };
    }
    if (data?.skipped && DriveFiles.waitUntilArchived) {
      const waited = await DriveFiles.waitUntilArchived({
        table: "letterhead_letters",
        id: letterId,
        timeoutMs: 8000,
      });
      if (waited) return { filed: true };
    }
    throw new Error("The letter was saved, but the PDF was not filed to Google Drive.");
  }

  async function noteAfterLetterSave(saved, { failedSave, failedDrive }) {
    if (!saved?.ok) return failedSave;
    if (saved.skipped) return "";
    try {
      const filed = await fileLetterToDrive(saved.letter?.id);
      if (location.hash === "#history") loadHistory(true);
      return filed.filed ? " PDF filed to Google Drive." : " Saved to history.";
    } catch (err) {
      AppError?.report?.(err, { context: "letterheadDriveArchive" });
      if (location.hash === "#history") loadHistory(true);
      return failedDrive;
    }
  }

  async function saveLetterHistory(values, exportType) {
    if (!hasLetterContent(values)) return { ok: true, skipped: true };
    const saved = await saveLetterHistoryToDatabase(values, exportType);
    return saved;
  }

  async function saveLetterOnly() {
    clearMessages();
    const values = getComposeValues();
    if (!hasLetterContent(values)) {
      showError("Type a subject or letter body before saving.");
      return;
    }

    const btn = document.getElementById("letterhead-save");
    if (btn) {
      btn.disabled = true;
      btn.dataset.prevLabel = btn.textContent || "";
      btn.textContent = "Saving…";
    }

    try {
      const saved = await (typeof ActionProgress !== "undefined"
        ? ActionProgress.run(
            {
              title: "Saving letter",
              status: "Saving letter…",
              steps: driveConfiguredLocally() ? 2 : 1,
              doneStatus: "Letter saved",
            },
            async (p) => {
              p.setStep(0, "Saving letter…");
              const result = await saveLetterHistory(values, "save");
              if (!result.ok) {
                throw result.error || new Error("Could not save the letter.");
              }
              let filed = false;
              if (driveConfiguredLocally() && result.letter?.id) {
                p.setStep(1, "Filing PDF to Google Drive…");
                filed = (await fileLetterToDrive(result.letter.id)).filed;
              }
              return { ...result, filed };
            }
          )
        : (async () => {
            const result = await saveLetterHistory(values, "save");
            if (!result.ok || !driveConfiguredLocally() || !result.letter?.id) return result;
            const filed = await fileLetterToDrive(result.letter.id);
            return { ...result, filed: filed.filed };
          })());
      if (!saved?.ok) {
        showError(AppError?.getUserMessage?.(saved?.error) || "Could not save the letter. Try again.");
        return;
      }
      showSuccess(
        saved.filed
          ? "Letter saved. PDF filed to Google Drive."
          : "Letter saved. Open Letter history to view it."
      );
      if (location.hash === "#history") loadHistory(true);
    } catch (err) {
      showError(AppError?.getUserMessage?.(err) || "Could not save the letter. Try again.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.prevLabel || "Save letter";
        delete btn.dataset.prevLabel;
      }
    }
  }

  async function printLetterhead({ includeContent, values: overrideValues, saveHistory = true }) {
    if (letterheadPrintBusy) return;
    clearMessages();
    const values = overrideValues || getComposeValues();
    const useContent = Boolean(includeContent);
    if (useContent && !hasLetterContent(values)) {
      showError("Type a subject or letter body first, or use Print blank.");
      return;
    }

    letterheadPrintBusy = true;
    setPrintButtonsBusy(true);

    const title = useContent
      ? PrintUtils.buildPrintFilename("letterhead", values.subject || "letter", values.date)
      : PrintUtils.buildPrintFilename("letterhead", "blank");

    try {
      const [sheetHtml, cssText] = await Promise.all([
        Promise.resolve(
          PrintUtils.applyPrintLogos(
            buildSheetHtml({
              date: useContent ? values.date : "",
              subject: useContent ? values.subject : "",
              body: useContent ? values.body : "",
              includeSign: useContent && hasLetterContent(values) && values.includeSign,
            }),
            letterLogoUrl()
          )
        ),
        getLetterheadPrintCssText(),
      ]);

      await PrintUtils.printInIframe({
        title,
        bodyHtml: sheetHtml,
        cssText,
        containerClass: "letterhead-print-container",
        bodyClass: "letterhead-print-body",
        iframeTitle: "Letterhead print",
        imageSelectors: PrintUtils.PRINT_LOGO_IMAGE_SELECTORS,
      });

      let historyNote = "";
      if (useContent && saveHistory) {
        const saved = await saveLetterHistory(values, "print");
        historyNote = await noteAfterLetterSave(saved, {
          failedSave: " (Could not save to history — print still opened.)",
          failedDrive: " Saved to history, but the PDF was not filed to Google Drive.",
        });
      }

      showSuccess(
        useContent
          ? `Print dialog opened. Choose Save as PDF if you need a PDF file.${historyNote}`
          : "Print dialog opened for blank letterhead. Choose Save as PDF if you need a PDF file."
      );
    } catch (err) {
      AppError?.report?.(err, { context: "letterheadPrint" });
      showError("Could not open print dialog. Try again.");
    } finally {
      letterheadPrintBusy = false;
      setPrintButtonsBusy(false);
    }
  }

  /** Word does not render WebP (or linked http/file paths) — embed PNG as a data URL. */
  function resolveWordLogoCandidates() {
    const printSrc =
      (typeof AppConfig !== "undefined" && AppConfig.getStationLogoPrintSrc
        ? AppConfig.getStationLogoPrintSrc()
        : null) || "assets/logo-print.webp";
    const pngFromPrint = String(printSrc).replace(/\.webp$/i, ".png");
    return [
      "assets/bishnupriya-fuels-logo.png",
      pngFromPrint,
      "assets/logo-104.png",
      "assets/logo-80.png",
      printSrc,
    ].filter((src, i, arr) => src && arr.indexOf(src) === i);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`logo image load failed: ${url}`));
      img.src = url;
    });
  }

  async function logoAsPngDataUrl() {
    const candidates = resolveWordLogoCandidates();
    let lastErr = null;

    for (const path of candidates) {
      try {
        const url =
          typeof PrintUtils !== "undefined" && PrintUtils.resolveAssetUrl
            ? PrintUtils.resolveAssetUrl(path)
            : new URL(path, window.location.href).href;
        const img = await loadImage(url);
        const w = img.naturalWidth || img.width || 192;
        const h = img.naturalHeight || img.height || 192;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas unavailable");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/png");
        if (!dataUrl.startsWith("data:image/png")) {
          throw new Error("png encode failed");
        }
        return dataUrl;
      } catch (err) {
        lastErr = err;
      }
    }

    AppError?.report?.(lastErr || new Error("logo unavailable"), {
      context: "letterheadLogoDataUrl",
    });
    return "";
  }

  function wordInlineStyles() {
    return `
      body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1a2332; margin: 18mm 16mm; }
      .invoice-letterhead { display: flex; gap: 14pt; align-items: center; padding-bottom: 10pt; border-bottom: 3pt solid #0070c0; margin-bottom: 14pt; }
      .invoice-bpcl-logo { width: 80pt; height: 80pt; }
      .invoice-brand { margin: 0 0 4pt; font-size: 18pt; font-weight: 700; color: #005a9c; }
      .invoice-brand span { color: #0070c0; font-weight: 800; }
      .invoice-tagline { margin: 0 0 4pt; font-size: 9pt; font-weight: 600; color: #0070c0; }
      .invoice-address { margin: 0 0 6pt; font-size: 9pt; color: #4a5f7a; }
      .invoice-contact-grid { font-size: 9pt; color: #1a2332; margin: 0; }
      .invoice-contact-grid span { display: inline-block; margin-right: 14pt; margin-bottom: 2pt; }
      .invoice-contact-grid em { font-style: normal; font-weight: 600; color: #4a5f7a; margin-right: 3pt; }
      .letterhead-meta { text-align: right; margin: 0 0 12pt; }
      .letterhead-date { margin: 0; font-size: 10pt; }
      .letterhead-subject { margin: 0 0 12pt; font-size: 11pt; }
      .letterhead-subject-label { font-weight: 700; margin-right: 4pt; }
      .letterhead-paragraph { margin: 0 0 10pt; font-size: 11pt; line-height: 1.5; }
      .letterhead-blank-spacer { height: 140mm; }
      .letterhead-sign { margin-top: 28pt; text-align: right; }
      .letterhead-sign-for { margin: 0 0 28pt; font-size: 9pt; font-weight: 700; text-transform: uppercase; color: #005a9c; }
      .letterhead-sign-role { margin: 0; font-size: 9pt; font-weight: 600; color: #4a5f7a; }
    `;
  }

  function buildWordHtml({ date, subject, body, logoSrc, includeSign }) {
    const s = stationParts();
    const sheet = buildSheetHtml({ date, subject, body, logoSrc, includeSign });
    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(s.legalName)} — Letterhead</title>
  <!--[if gte mso 9]>
  <xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
    </w:WordDocument>
  </xml>
  <![endif]-->
  <style>${wordInlineStyles()}</style>
</head>
<body>${sheet}</body>
</html>`;
  }

  async function buildLetterDocFile(values) {
    const logoSrc = await logoAsPngDataUrl();
    const html = buildWordHtml({
      date: values.date,
      subject: values.subject,
      body: values.body,
      logoSrc,
      includeSign: hasLetterContent(values) && values.includeSign,
    });
    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const name = PrintUtils.buildPrintFilename(
      "letterhead",
      values.subject || "letter",
      values.date
    );
    return new File([blob], `${name}.doc`, { type: "application/msword" });
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function downloadWord({ includeContent }) {
    clearMessages();
    const values = getComposeValues();
    const useContent = Boolean(includeContent);
    if (useContent && !hasLetterContent(values)) {
      showError("Type a subject or letter body first, or use Download blank.");
      return;
    }

    const btnIds = useContent
      ? ["letterhead-word-content"]
      : ["letterhead-word-blank"];
    btnIds.forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = true;
    });

    try {
      const file = await buildLetterDocFile({
        date: useContent ? values.date : "",
        subject: useContent ? values.subject : "",
        body: useContent ? values.body : "",
        includeSign: useContent && hasLetterContent(values) && values.includeSign,
      });
      downloadBlob(file.name, file);

      let historyNote = "";
      if (useContent) {
        const saved = await saveLetterHistory(values, "word");
        historyNote = await noteAfterLetterSave(saved, {
          failedSave: " (Could not save to history — file still downloaded.)",
          failedDrive: " Saved to history, but the PDF was not filed to Google Drive.",
        });
      }

      showSuccess(
        useContent
          ? `Word file downloaded. Open it in Microsoft Word or Google Docs.${historyNote}`
          : "Blank letterhead Word file downloaded."
      );
    } catch (err) {
      AppError?.report?.(err, { context: "letterheadWordDownload" });
      showError("Could not create the Word file. Try again.");
    } finally {
      btnIds.forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
      });
    }
  }

  function getHistoryDateRange() {
    const range = readDateRangeFromControls(document.getElementById("letterhead-range"), null, null);
    if (range) return { start: range.start, end: range.end };
    return getYearRange(new Date().getFullYear());
  }

  function historySearchQuery() {
    return (document.getElementById("letterhead-search")?.value || "").trim();
  }

  function initHistoryFilters() {
    createDateRangeFilter({
      storageKey: "letterhead_history",
      ranges: ["this-year", "last-year", "all-time"],
      defaultRange: "this-year",
      rangeSelect: "letterhead-range",
      trigger: "auto",
      runOnInit: false,
      onApply: () => {
        closeHistoryReport();
        loadHistory(true);
      },
    });

    document
      .getElementById("letterhead-load-more")
      ?.addEventListener("click", () => loadHistory(false));
    document.getElementById("letterhead-search")?.addEventListener(
      "input",
      debounce(() => {
        loadHistory(true);
      }, 300)
    );
  }

  function updateHistoryPaginationUI() {
    syncLoadMorePager({
      info: document.getElementById("letterhead-pagination-info"),
      button: document.getElementById("letterhead-load-more"),
      shown: Math.min(historyPagination.offset, historyPagination.totalCount || historyPagination.offset),
      total: historyPagination.totalCount,
      hasMore: historyPagination.hasMore,
      noun: "letters",
    });
  }

  function closeHistoryReport() {
    historyReportLetter = null;
    if (typeof DrivePreview !== "undefined") DrivePreview.close();
  }

  function letterHasBody(row) {
    return Boolean(String(row?.body || "").trim());
  }

  function letterSheetHtml(row) {
    const values = valuesFromLetterRow(row);
    return `<div class="letterhead-preview-sheet">${buildSheetHtml({
      ...values,
      includeSign: hasLetterContent(values) && values.includeSign,
    })}</div>`;
  }

  async function printArchivedLetter(row) {
    if (row.drive_file_id && typeof DriveFiles !== "undefined") {
      await DriveFiles.openBlob({ kind: "letter", id: row.id });
      AppError.showToast("Opened the Drive PDF. Use the browser print dialog for a paper copy.");
      return;
    }
    if (!letterHasBody(row)) {
      AppError.showToast("This letter is stored in Google Drive. Download it to print.", "error");
      return;
    }
    await printLetterhead({
      includeContent: true,
      saveHistory: false,
      values: valuesFromLetterRow(row),
    });
  }

  async function downloadLetterFile(id, btn) {
    if (!id || typeof DriveFiles === "undefined") return;
    if (btn) btn.disabled = true;
    try {
      await ActionProgress.track(
        {
          title: "Downloading letter",
          status: "Fetching the PDF…",
          doneStatus: "Downloaded",
          timeoutMs: 180000,
        },
        async () => {
          await DriveFiles.downloadAndSave({ kind: "letter", id });
        }
      );
    } catch (err) {
      AppError.report(err, { context: "letterheadDownload" });
      AppError.showToast(AppError.getUserMessage(err) || "Could not download the letter.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function printHistoryReport() {
    const row = historyReportLetter;
    if (!row) return;
    await printArchivedLetter(row);
  }

  function editHistoryReportInCompose() {
    const row = historyReportLetter;
    if (!row) return;
    if (!letterHasBody(row)) {
      AppError.showToast("Letter text is not kept in the database. Download the PDF, or compose a new letter.", "error");
      return;
    }
    setComposeValues(valuesFromLetterRow(row));
    closeHistoryReport();
    location.hash = "#compose";
    showSuccess("Letter loaded into Compose. Edit if needed, then save, print, or download.");
  }

  function openLetterPreview(id) {
    if (!id) return;
    if (typeof DrivePreview === "undefined") {
      AppError.showToast("Could not open the preview.", "error");
      return;
    }
    const known = historyRows.get(id);
    if (known?.drive_file_id && typeof preloadPdfPreview === "function") preloadPdfPreview();
    clearMessages();
    DrivePreview.open({
      title: known?.subject?.trim() || "Letter",
      subtitle: known ? formatNumericDate(known.letter_date) : "Loading…",
      download: known && !known.drive_file_id ? null : () => downloadLetterFile(id),
      actions: [
        { id: "print", label: "Print", onClick: () => printHistoryReport() },
        { id: "edit", label: "Edit in Compose", hidden: true, onClick: () => editHistoryReportInCompose() },
      ],
      load: async (ctx) => {
        const row = await fetchLetterById(id);
        if (!ctx.isCurrent()) return null;
        if (!row) throw new Error("Could not load that letter.");
        historyReportLetter = row;
        ctx.setTitle(row.subject?.trim() || "(No subject)");
        ctx.setSubtitle(formatNumericDate(row.letter_date));
        ctx.showAction("edit", letterHasBody(row));
        ctx.showDownload(Boolean(row.drive_file_id));
        if (row.drive_file_id && typeof DriveFiles !== "undefined") {
          const { blob, fileName } = await DriveFiles.download({ kind: "letter", id: row.id });
          return { blob, fileName: fileName || row.drive_file_name || "letter.pdf" };
        }
        if (letterHasBody(row)) return { html: letterSheetHtml(row) };
        return {
          html: `<p class="muted">This letter is stored in Google Drive, and the file could not be opened.</p>`,
        };
      },
    });
  }

  async function loadHistory(reset = false) {
    const tbody = document.getElementById("letterhead-history-body");
    if (!tbody) return;
    if (!reset && historyPagination.isLoading) return;

    const seq = ++historyLoadSeq;
    historyPagination.isLoading = true;

    const { start, end } = getHistoryDateRange();
    const needle = historySearchQuery();
    const pageFrom = reset ? 0 : historyPagination.offset;
    const loadMoreBtn = document.getElementById("letterhead-load-more");

    if (reset) {
      historyPagination.offset = 0;
      historyPagination.hasMore = true;
      historyPagination.totalCount = 0;
      tbody.innerHTML = `<tr><td colspan="${HISTORY_COLSPAN}" class="muted">Loading…</td></tr>`;
    }

    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = "Loading…";
    }

    const stillCurrent = () => seq === historyLoadSeq;

    try {
      const { data, error, count } = await runAppRequest("Letter history", () => {
        let listQuery = window.supabaseClient
          .from("letterhead_letters")
          .select(LETTER_LIST_SELECT, { count: "exact" })
          .order("letter_date", { ascending: false })
          .order("created_at", { ascending: false })
          .range(pageFrom, pageFrom + PAGE_SIZE - 1);
        if (start) listQuery = listQuery.gte("letter_date", start);
        if (end) listQuery = listQuery.lte("letter_date", end);
        if (needle) listQuery = listQuery.ilike("subject", `%${escapeIlikePattern(needle)}%`);
        return listQuery;
      });

      if (!stillCurrent()) return;

      if (error) {
        if (reset) {
          renderTableRetryRow(tbody, HISTORY_COLSPAN, AppError.getUserMessage(error), () => loadHistory(true));
        }
        AppError.report(error, { context: "letterheadLoadHistory" });
        return;
      }

      const fetchedCount = data?.length || 0;
      if (typeof count === "number") historyPagination.totalCount = count;
      historyPagination.offset = pageFrom + fetchedCount;
      historyPagination.hasMore =
        typeof count === "number" ? historyPagination.offset < count : fetchedCount === PAGE_SIZE;

      if (reset && !fetchedCount) {
        historyRows.clear();
        const emptyLabel = needle ? "No letters match that subject." : "No letters for this period.";
        tbody.innerHTML = `<tr><td colspan="${HISTORY_COLSPAN}" class="muted">${emptyLabel}</td></tr>`;
        return;
      }

      if (reset) {
        tbody.innerHTML = "";
        historyRows.clear();
      }

      const isAdmin = currentAuth?.role === "admin";

      (data || []).forEach((row) => {
        historyRows.set(row.id, row);
        const tr = document.createElement("tr");
        const subjectLabel = row.subject?.trim() || "(No subject)";
        const deleteBtn = isAdmin
          ? AdminDelete.buttonHtml({
              selector: "letterhead-delete-btn",
              data: {
                letterId: row.id,
                letterSubject: subjectLabel,
                letterDate: row.letter_date,
                letterFile: row.drive_file_name || "",
                letterDrive: row.drive_file_id ? "1" : "0",
              },
              title: "Delete letter (admin)",
            })
          : "";
        const downloadBtn = row.drive_file_id
          ? `<button type="button" class="button-secondary button-small" data-download-letter="${row.id}">Download</button>`
          : "";

        tr.innerHTML = `
          <td data-label="Date">${formatNumericDate(row.letter_date)}</td>
          <td data-label="Subject"><strong>${escapeHtml(subjectLabel)}</strong></td>
          <td class="table-actions" data-label="Actions">
            <div class="drive-row-actions">
              <button type="button" class="button-secondary button-small" data-view-letter="${row.id}">View</button>
              ${downloadBtn}
              ${deleteBtn}
            </div>
          </td>
        `;
        tr.dataset.letterId = row.id;
        tbody.appendChild(tr);
      });

      if (!tbody.dataset.letterheadActionsBound) {
        tbody.dataset.letterheadActionsBound = "1";
        tbody.addEventListener("click", (e) => {
          const viewBtn = e.target.closest("[data-view-letter]");
          if (viewBtn) {
            openLetterPreview(viewBtn.dataset.viewLetter);
            return;
          }
          const downloadBtnEl = e.target.closest("[data-download-letter]");
          if (downloadBtnEl) downloadLetterFile(downloadBtnEl.dataset.downloadLetter, downloadBtnEl);
        });
        AdminDelete.bindOnce(tbody, ".letterhead-delete-btn", deleteLetter, "letterheadDeleteBound");
      }
    } catch (err) {
      if (!stillCurrent()) return;
      if (reset && !isCancelledRequestError(err)) {
        renderTableRetryRow(tbody, HISTORY_COLSPAN, AppError.getUserMessage(err), () => loadHistory(true));
      }
      if (!isCancelledRequestError(err)) {
        AppError.report(err, { context: "letterheadLoadHistory" });
      }
    } finally {
      if (!stillCurrent()) return;
      resetPaginationLoading(historyPagination, loadMoreBtn);
      updateHistoryPaginationUI();
    }
  }

  async function fetchLetterById(id) {
    const { data, error } = await window.supabaseClient
      .from("letterhead_letters")
      .select(LETTER_DETAIL_SELECT)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      AppError.report(error, { context: "letterheadFetchLetter", letterId: id });
      return null;
    }
    return data;
  }

  function setComposeValues({ date = "", subject = "", body = "", includeSign = true }) {
    const dateEl = document.getElementById("letterhead-date");
    const subjectEl = document.getElementById("letterhead-subject");
    const bodyEl = document.getElementById("letterhead-body");
    const signEl = document.getElementById("letterhead-include-sign");
    if (dateEl) dateEl.value = date || "";
    if (subjectEl) subjectEl.value = subject || "";
    if (bodyEl) bodyEl.value = body || "";
    if (signEl) signEl.checked = includeSign !== false;
    refreshPreview();
    letterDraft?.markClean();
  }

  function bindLetterDraft() {
    const form = document.getElementById("letterhead-form");
    if (!form || letterDraft || typeof bindUnsavedDraft !== "function") return;
    const dateEl = document.getElementById("letterhead-date");
    if (dateEl && !dateEl.value && typeof getLocalDateString === "function") {
      dateEl.value = getLocalDateString();
    }
    letterDraft = bindUnsavedDraft({
      key: "letterhead.compose",
      root: form,
    });
    letterDraft.adoptServerState();
    if (letterDraft.restore()) {
      refreshPreview();
      AppError.showToast("Restored an unsaved letter from this device.", "info");
    }
  }

  async function deleteLetter(btn) {
    const letterId = btn.dataset.letterId;
    const subject = btn.dataset.letterSubject || "this letter";
    const letterDate = formatNumericDate(btn.dataset.letterDate || "");
    const fileName = (btn.dataset.letterFile || "").trim();
    const lines = [`Delete letter “${subject}” dated ${letterDate}?`];
    if (fileName) lines.push(`File: ${fileName}`);
    lines.push(
      "",
      btn.dataset.letterDrive === "1"
        ? "The PDF in Google Drive will also be deleted. This cannot be undone."
        : "This cannot be undone."
    );

    await AdminDelete.execute({
      btn,
      auth: currentAuth,
      actionLabel: "delete letterhead history",
      confirmMessage: lines.join("\n"),
      deleteFn: async () => {
        await DriveFiles.remove({ kind: "letter", id: letterId });
        return { error: null };
      },
      cacheScope: "operational",
      onSuccess: async () => {
        if (historyReportLetter?.id === letterId) closeHistoryReport();
        await loadHistory(true);
      },
      errorContext: { context: "letterheadDeleteLetter", letterId },
    });
  }

  function bindUi() {
    const dateEl = document.getElementById("letterhead-date");
    const subject = document.getElementById("letterhead-subject");
    const body = document.getElementById("letterhead-body");
    const includeSign = document.getElementById("letterhead-include-sign");
    const onInput = () => {
      clearMessages();
      refreshPreview();
    };
    dateEl?.addEventListener("change", onInput);
    subject?.addEventListener("input", onInput);
    body?.addEventListener("input", onInput);
    includeSign?.addEventListener("change", onInput);

    document
      .getElementById("letterhead-save")
      ?.addEventListener("click", () => saveLetterOnly());
    document
      .getElementById("letterhead-print-blank")
      ?.addEventListener("click", () => printLetterhead({ includeContent: false }));
    document
      .getElementById("letterhead-word-blank")
      ?.addEventListener("click", () => downloadWord({ includeContent: false }));
    document
      .getElementById("letterhead-word-content")
      ?.addEventListener("click", () => downloadWord({ includeContent: true }));

    document.getElementById("letterhead-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      printLetterhead({ includeContent: true });
    });

  }

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
  const auth = await requireAuth({
      allowedRoles: ["admin", "supervisor"],
      onDenied: "dashboard.html",
      pageName: "letterhead",
    });
    if (!auth) return;
    currentAuth = auth;
    applyRoleVisibility(auth.role);

    const actionsHead = document.getElementById("letterhead-actions-head");
    if (actionsHead && auth.role !== "admin") {
      actionsHead.textContent = "Actions";
    }

    if (typeof initPageSections === "function") {
      initPageSections({
        defaultSection: "compose",
        validSections: ["compose", "history", "guide"],
        onSectionChange: (section) => {
          closeHistoryReport();
          if (section === "history") loadHistory(true);
        },
      });
    }

    await loadPumpSettings();
    refreshLetterheadDriveBanner();
    bindUi();
    bindLetterDraft();
    initHistoryFilters();
    refreshPreview();

    if (location.hash === "#history") {
      loadHistory(true);
    }
  });

  bindLiveRefresh(
    () => {
      if (isSettingsPanelActive("history") || location.hash === "#history") {
        void loadHistory(true);
      }
    },
    { match: () => Boolean(document.getElementById("letterhead-history-body")) }
  );
})();
