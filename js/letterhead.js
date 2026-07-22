/* global requireAuth, applyRoleVisibility, escapeHtml, PumpSettings, loadPumpSettings, PrintUtils, AppError, AppConfig, initPageSections, formatNumericDate, getLocalDateString, supabaseClient, readDateRangeFromControls, createDateRangeFilter, getYearRange, AdminDelete */

(function () {
  const PRINT_CSS = "css/letterhead-print.css?v=3";
  const PAGE_SIZE = 20;
  const HISTORY_COLSPAN = 5;

  let currentAuth = null;
  let letterheadPrintBusy = false;
  let letterheadPrintCssCache = null;
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
      signFor: `FOR ${(legal || `${short} ${accent}`).toUpperCase()}`,
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

  function buildLetterheadBannerHtml({ logoSrc } = {}) {
    const s = stationParts();
    const logo =
      logoSrc ||
      (typeof PrintUtils !== "undefined" && PrintUtils.getStationLogoPrintUrl
        ? PrintUtils.getStationLogoPrintUrl()
        : "assets/logo-print.webp");

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
              ? `<img src="${logo}" alt="${escapeHtml(s.displayName)}" class="station-logo invoice-bpcl-logo" width="192" height="192" />`
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
          <p class="letterhead-sign-for">${escapeHtml(stationParts().signFor)}</p>
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

  function refreshPreview() {
    const preview = document.getElementById("letterhead-preview");
    if (!preview) return;
    const values = getComposeValues();
    preview.innerHTML = buildSheetHtml({
      ...values,
      includeSign: hasLetterContent(values),
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

  function exportTypeLabel(type) {
    return type === "word" ? "Word" : "Print";
  }

  async function saveLetterHistory(values, exportType) {
    if (!hasLetterContent(values)) return { ok: true, skipped: true };

    const payload = {
      letter_date:
        values.date ||
        (typeof getLocalDateString === "function" ? getLocalDateString() : new Date().toISOString().slice(0, 10)),
      subject: values.subject || "",
      body: values.body || "",
      export_type: exportType === "word" ? "word" : "print",
    };
    if (currentAuth?.session?.user?.id) {
      payload.created_by = currentAuth.session.user.id;
    }

    const { error } = await supabaseClient.from("letterhead_letters").insert(payload);
    if (error) {
      AppError?.report?.(error, { context: "letterheadSaveHistory" });
      return { ok: false, error };
    }
    return { ok: true };
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
      ? values.subject || "Letter"
      : `${stationParts().legalName} — Letterhead`;

    try {
      const [sheetHtml, cssText] = await Promise.all([
        Promise.resolve(
          PrintUtils.applyPrintLogos(
            buildSheetHtml({
              date: useContent ? values.date : "",
              subject: useContent ? values.subject : "",
              body: useContent ? values.body : "",
              includeSign: useContent && hasLetterContent(values),
            })
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
        if (saved.ok && !saved.skipped) {
          historyNote = " Saved to letter history.";
          if (location.hash === "#history") loadHistory(true);
        } else if (!saved.ok) {
          historyNote = " (Could not save to history — print still opened.)";
        }
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

  function safeFilenamePart(text) {
    return String(text || "")
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40);
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
      const logoSrc = await logoAsPngDataUrl();
      const html = buildWordHtml({
        date: useContent ? values.date : "",
        subject: useContent ? values.subject : "",
        body: useContent ? values.body : "",
        logoSrc,
        includeSign: useContent && hasLetterContent(values),
      });
      const blob = new Blob(["\ufeff", html], {
        type: "application/msword",
      });
      const base = safeFilenamePart(stationParts().legalName) || "letterhead";
      const suffix = useContent
        ? safeFilenamePart(values.subject) || "letter"
        : "blank";
      downloadBlob(`${base}-${suffix}.doc`, blob);

      let historyNote = "";
      if (useContent) {
        const saved = await saveLetterHistory(values, "word");
        if (saved.ok && !saved.skipped) {
          historyNote = " Saved to letter history.";
          if (location.hash === "#history") loadHistory(true);
        } else if (!saved.ok) {
          historyNote = " (Could not save to history — file still downloaded.)";
        }
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
    const range = readDateRangeFromControls(
      document.getElementById("letterhead-range"),
      document.getElementById("letterhead-start"),
      document.getElementById("letterhead-end")
    );
    if (range) return { start: range.start, end: range.end };
    return getYearRange(new Date().getFullYear());
  }

  function initHistoryFilters() {
    createDateRangeFilter({
      storageKey: "letterhead_history",
      ranges: ["this-year", "last-year", "all-time"],
      defaultRange: "this-year",
      rangeSelect: "letterhead-range",
      startInput: "letterhead-start",
      endInput: "letterhead-end",
      customRange: "letterhead-custom-range",
      applyBtn: "letterhead-apply-filter",
      trigger: "apply",
      runOnInit: false,
      onApply: () => loadHistory(true),
    });

    document
      .getElementById("letterhead-load-more")
      ?.addEventListener("click", () => loadHistory(false));
  }

  function updateHistoryPaginationUI() {
    const loadMoreBtn = document.getElementById("letterhead-load-more");
    const paginationInfo = document.getElementById("letterhead-pagination-info");

    if (paginationInfo) {
      if (historyPagination.totalCount > 0) {
        const showing = Math.min(historyPagination.offset, historyPagination.totalCount);
        paginationInfo.textContent = `Showing ${showing} of ${historyPagination.totalCount} letters`;
      } else {
        paginationInfo.textContent = "";
      }
    }

    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Load more";
      loadMoreBtn.classList.toggle(
        "hidden",
        !historyPagination.hasMore || historyPagination.offset === 0
      );
    }
  }

  async function loadHistory(reset = false) {
    const tbody = document.getElementById("letterhead-history-body");
    if (!tbody) return;
    if (historyPagination.isLoading) return;
    historyPagination.isLoading = true;

    const { start, end } = getHistoryDateRange();
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

    try {
      if (reset) {
        let countQuery = supabaseClient
          .from("letterhead_letters")
          .select("id", { count: "exact", head: true });
        if (start) countQuery = countQuery.gte("letter_date", start);
        if (end) countQuery = countQuery.lte("letter_date", end);
        const { count } = await countQuery;
        historyPagination.totalCount = count || 0;
      }

      let listQuery = supabaseClient
        .from("letterhead_letters")
        .select("id, letter_date, subject, body, export_type, created_at")
        .order("created_at", { ascending: false })
        .range(historyPagination.offset, historyPagination.offset + PAGE_SIZE - 1);
      if (start) listQuery = listQuery.gte("letter_date", start);
      if (end) listQuery = listQuery.lte("letter_date", end);
      const { data, error } = await listQuery;

      if (error) {
        if (reset) {
          tbody.innerHTML = `<tr><td colspan="${HISTORY_COLSPAN}" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
        }
        AppError.report(error, { context: "letterheadLoadHistory" });
        return;
      }

      const fetchedCount = data?.length || 0;
      historyPagination.offset += fetchedCount;
      historyPagination.hasMore = fetchedCount === PAGE_SIZE;

      if (reset && !fetchedCount) {
        tbody.innerHTML = `<tr><td colspan="${HISTORY_COLSPAN}" class="muted">No typed letters for this period.</td></tr>`;
        return;
      }

      if (reset) tbody.innerHTML = "";

      const isAdmin = currentAuth?.role === "admin";

      (data || []).forEach((row) => {
        const tr = document.createElement("tr");
        const subjectLabel = row.subject?.trim() || "(No subject)";
        const deleteBtn = isAdmin
          ? ` ${AdminDelete.buttonHtml({
              selector: "letterhead-delete-btn",
              data: {
                letterId: row.id,
                letterSubject: subjectLabel,
                letterDate: row.letter_date,
              },
              title: "Delete letter (admin)",
            })}`
          : "";

        tr.innerHTML = `
          <td>${formatNumericDate(row.letter_date)}</td>
          <td><strong>${escapeHtml(subjectLabel)}</strong></td>
          <td class="letterhead-history-preview">${escapeHtml(previewSnippet(row.body || row.subject))}</td>
          <td>${escapeHtml(exportTypeLabel(row.export_type))}</td>
          <td class="table-actions">
            <button type="button" class="link" data-open-letter="${row.id}">Open</button>
            <button type="button" class="link" data-print-letter="${row.id}">Print</button>${deleteBtn}
          </td>
        `;
        tr.dataset.letterId = row.id;
        tr._letterRow = row;
        tbody.appendChild(tr);
      });

      tbody.querySelectorAll("[data-open-letter]").forEach((btn) => {
        btn.addEventListener("click", () => openLetterInCompose(btn.dataset.openLetter));
      });
      tbody.querySelectorAll("[data-print-letter]").forEach((btn) => {
        btn.addEventListener("click", () => reprintLetter(btn.dataset.printLetter));
      });

      if (!tbody.dataset.letterheadDeleteBound) {
        AdminDelete.bindOnce(tbody, ".letterhead-delete-btn", deleteLetter, "letterheadDeleteBound");
      }
    } catch (err) {
      if (reset) {
        tbody.innerHTML = `<tr><td colspan="${HISTORY_COLSPAN}" class="error">${escapeHtml(AppError.getUserMessage(err))}</td></tr>`;
      }
      AppError.report(err, { context: "letterheadLoadHistory" });
    } finally {
      historyPagination.isLoading = false;
      updateHistoryPaginationUI();
    }
  }

  function findLoadedLetter(id) {
    const tbody = document.getElementById("letterhead-history-body");
    if (!tbody) return null;
    const tr = [...tbody.querySelectorAll("tr")].find((row) => row.dataset.letterId === id);
    return tr?._letterRow || null;
  }

  async function fetchLetterById(id) {
    const cached = findLoadedLetter(id);
    if (cached) return cached;

    const { data, error } = await supabaseClient
      .from("letterhead_letters")
      .select("id, letter_date, subject, body, export_type, created_at")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      AppError.report(error, { context: "letterheadFetchLetter", letterId: id });
      return null;
    }
    return data;
  }

  function setComposeValues({ date = "", subject = "", body = "" }) {
    const dateEl = document.getElementById("letterhead-date");
    const subjectEl = document.getElementById("letterhead-subject");
    const bodyEl = document.getElementById("letterhead-body");
    if (dateEl) dateEl.value = date || "";
    if (subjectEl) subjectEl.value = subject || "";
    if (bodyEl) bodyEl.value = body || "";
    refreshPreview();
  }

  async function openLetterInCompose(id) {
    clearMessages();
    const row = await fetchLetterById(id);
    if (!row) {
      showError("Could not load that letter.");
      return;
    }
    setComposeValues({
      date: row.letter_date || "",
      subject: row.subject || "",
      body: row.body || "",
    });
    location.hash = "#compose";
    showSuccess("Letter loaded into Compose. Edit if needed, then print or download.");
  }

  async function reprintLetter(id) {
    clearMessages();
    const row = await fetchLetterById(id);
    if (!row) {
      showError("Could not load that letter to print.");
      return;
    }
    await printLetterhead({
      includeContent: true,
      saveHistory: false,
      values: {
        date: row.letter_date || "",
        subject: row.subject || "",
        body: row.body || "",
      },
    });
  }

  async function deleteLetter(btn) {
    const letterId = btn.dataset.letterId;
    const subject = btn.dataset.letterSubject || "this letter";
    const letterDate = btn.dataset.letterDate || "";

    await AdminDelete.execute({
      btn,
      auth: currentAuth,
      actionLabel: "delete letterhead history",
      confirmMessage: `Delete letter “${subject}” dated ${formatNumericDate(letterDate)}?\n\nThis cannot be undone.`,
      deleteFn: () => supabaseClient.from("letterhead_letters").delete().eq("id", letterId),
      cacheScope: "operational",
      onSuccess: () => loadHistory(true),
      errorContext: { context: "letterheadDeleteLetter", letterId },
    });
  }

  function bindUi() {
    const dateEl = document.getElementById("letterhead-date");
    const subject = document.getElementById("letterhead-subject");
    const body = document.getElementById("letterhead-body");
    const onInput = () => {
      clearMessages();
      refreshPreview();
    };
    dateEl?.addEventListener("change", onInput);
    subject?.addEventListener("input", onInput);
    body?.addEventListener("input", onInput);

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
          if (section === "history") loadHistory(true);
        },
      });
    }

    await loadPumpSettings();
    bindUi();
    initHistoryFilters();
    refreshPreview();

    if (location.hash === "#history") {
      loadHistory(true);
    }
  });
})();
