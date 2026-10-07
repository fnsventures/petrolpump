/* global window */
/**
 * Client for the drive-files edge function (sales invoices, letters, staff photos, Aadhaar).
 */
(function (global) {
  function appConfig() {
    return global.__APP_CONFIG__ || {};
  }

  function functionUrl() {
    const cfg = appConfig();
    const client = global.supabaseClient;
    return `${cfg.SUPABASE_URL || client?.supabaseUrl}/functions/v1/drive-files`;
  }

  async function getSessionToken() {
    const { data } = await global.supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Session expired. Please log in again.");
    return token;
  }

  async function functionHeaders(json = false) {
    const cfg = appConfig();
    const headers = {
      Authorization: `Bearer ${await getSessionToken()}`,
      apikey: cfg.SUPABASE_ANON_KEY || global.supabaseClient.supabaseKey,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function parseErrorResponse(res) {
    const errBody = await res.json().catch(() => ({}));
    return errBody.error || `Request failed (${res.status})`;
  }

  function isNotConfiguredError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return (
      msg.includes("google drive") ||
      msg.includes("root folder") ||
      msg.includes("not configured") ||
      msg.includes("disabled in settings")
    );
  }

  async function invokeJson(body, init = {}) {
    const res = await fetch(functionUrl(), {
      method: "POST",
      headers: await functionHeaders(true),
      body: JSON.stringify(body),
      keepalive: body?.action === "archive",
      ...init,
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const data = await res.json().catch(() => ({}));
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function status() {
    return invokeJson({ action: "status" });
  }

  async function archive(params) {
    return invokeJson({ action: "archive", ...params });
  }

  async function waitUntilArchived({ table, id, timeoutMs = 18000 } = {}) {
    const client = global.supabaseClient;
    if (!table || !id || !client) return false;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { data } = await client.from(table).select("drive_file_id").eq("id", id).maybeSingle();
      if (data?.drive_file_id) return true;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return false;
  }

  /**
   * @param {{ kind: string, file: File|Blob, fields?: Record<string, string|number|boolean|null|undefined> }} opts
   */
  async function upload({ kind, file, fields = {} }) {
    if (!kind) throw new Error("kind is required");
    if (!file) throw new Error("file is required");
    const form = new FormData();
    form.set("kind", kind);
    const uploadFile =
      file instanceof File
        ? file
        : new File([file], fields.fileName || "upload", { type: file.type || "application/octet-stream" });
    form.set("file", uploadFile);
    Object.entries(fields).forEach(([key, value]) => {
      if (key === "fileName") return;
      if (value == null || value === "") return;
      form.set(key, String(value));
    });

    const res = await fetch(functionUrl(), {
      method: "POST",
      headers: await functionHeaders(false),
      body: form,
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const data = await res.json().catch(() => ({}));
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function mimeFromFileName(fileName) {
    const name = String(fileName || "").toLowerCase();
    if (name.endsWith(".pdf")) return "application/pdf";
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".webp")) return "image/webp";
    if (name.endsWith(".gif")) return "image/gif";
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
    return "";
  }

  function fileNameFromDisposition(header, fallback) {
    const value = String(header || "");
    const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
    const quoted = value.match(/filename="([^"]+)"/i);
    const plain = value.match(/filename=([^;]+)/i);
    const raw = encoded?.[1] || quoted?.[1] || plain?.[1] || "";
    try {
      const decoded = decodeURIComponent(raw.replace(/"/g, "").trim());
      if (decoded) return decoded;
    } catch {
      if (raw.trim()) return raw.trim();
    }
    return fallback || "download";
  }

  function withUsefulType(blob, fileName) {
    const type = String(blob?.type || "").toLowerCase();
    if (type && type !== "application/octet-stream") return blob;
    const guessed = mimeFromFileName(fileName);
    return guessed ? new Blob([blob], { type: guessed }) : blob;
  }

  async function download(params) {
    const { previewWindow: _previewWindow, ...request } = params || {};
    const res = await fetch(functionUrl(), {
      method: "POST",
      headers: await functionHeaders(true),
      body: JSON.stringify({ action: "download", ...request }),
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const fileName = fileNameFromDisposition(
      res.headers.get("Content-Disposition"),
      params.fileName
    );
    const blob = withUsefulType(await res.blob(), fileName);
    return { blob, fileName };
  }

  function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function downloadAndSave(params) {
    const { blob, fileName } = await download(params);
    saveBlob(blob, fileName);
    return { blob, fileName };
  }

  async function openBlob(params) {
    const preview = params.previewWindow && !params.previewWindow.closed ? params.previewWindow : null;
    const { blob, fileName } = await download(params);
    const url = URL.createObjectURL(blob);
    if (preview) {
      preview.location.replace(url);
    } else {
      const opened = window.open(url, "_blank");
      if (!opened) saveBlob(blob, fileName);
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    return url;
  }

  async function remove(params) {
    return invokeJson({ action: "delete", ...params });
  }

  function invoiceDocumentsUrl() {
    const cfg = appConfig();
    const client = global.supabaseClient;
    return `${cfg.SUPABASE_URL || client?.supabaseUrl}/functions/v1/invoice-documents`;
  }

  async function postInvoiceDocuments(body) {
    const res = await fetch(invoiceDocumentsUrl(), {
      method: "POST",
      headers: await functionHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      return { json: data };
    }
    return { response: res };
  }

  function previewLogoUrl() {
    try {
      return new URL("assets/logo-104.webp", global.document.baseURI).href;
    } catch {
      return "";
    }
  }

  function paintPreviewShell(preview) {
    if (!preview || preview.closed) return false;
    const logo = previewLogoUrl().replace(/"/g, "");
    const logoHtml = logo ? `<img class="logo" alt="" src="${logo}">` : "";
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening document</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f8fafc; color: #1a2332; font-family: system-ui, sans-serif; }
  .card { width: min(18rem, calc(100vw - 2rem)); text-align: center; }
  .mark { width: 4.5rem; height: 4.5rem; margin: 0 auto 0.9rem; position: relative; }
  .ring { position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(from 0deg, rgba(0,112,192,0.08), #0070c0 55%, #ffc20e 82%, rgba(0,112,192,0.08));
    -webkit-mask: radial-gradient(closest-side, transparent 66%, #000 68%);
    mask: radial-gradient(closest-side, transparent 66%, #000 68%);
    animation: spin 1.15s linear infinite; }
  .logo { position: absolute; inset: 18%; width: 64%; height: 64%; object-fit: contain; }
  h1 { margin: 0; font-size: 1.05rem; }
  p { margin: 0.35rem 0 0.85rem; color: #4a5f7a; font-size: 0.9rem; }
  .track { height: 8px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
  .fill { height: 100%; width: 0; border-radius: inherit; background: #0070c0;
    transition: width 0.45s cubic-bezier(0.22, 1, 0.36, 1); }
  .pct { margin: 0.4rem 0 0; font-size: 0.75rem; font-weight: 650; color: #0070c0; text-align: right;
    font-variant-numeric: tabular-nums; }
  .is-error .ring { animation: none; opacity: 0.35; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .ring { animation: none; }
    .fill { transition: none; }
  }
</style>
</head>
<body>
  <div class="card" id="load-card">
    <div class="mark">${logoHtml}<div class="ring"></div></div>
    <h1 id="load-title">Opening document</h1>
    <p id="load-status">Fetching the file…</p>
    <div class="track" id="load-track"><div id="load-fill" class="fill"></div></div>
    <p id="load-pct" class="pct">0%</p>
  </div>
</body>
</html>`;
    try {
      const doc = preview.document;
      doc.open();
      doc.write(html);
      doc.close();
      return true;
    } catch {
      return false;
    }
  }

  function setPreviewProgress(preview, pct, status) {
    if (!preview || preview.closed) return;
    try {
      const doc = preview.document;
      const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
      const fill = doc.getElementById("load-fill");
      const pctEl = doc.getElementById("load-pct");
      const statusEl = doc.getElementById("load-status");
      if (fill) fill.style.width = `${clamped}%`;
      if (pctEl) pctEl.textContent = `${Math.round(clamped)}%`;
      if (status && statusEl) statusEl.textContent = status;
    } catch {
      /* The preview tab was closed or navigated away. */
    }
  }

  function showPreviewError(preview, message) {
    if (!preview || preview.closed) return;
    try {
      const doc = preview.document;
      doc.getElementById("load-card")?.classList.add("is-error");
      const title = doc.getElementById("load-title");
      const status = doc.getElementById("load-status");
      const track = doc.getElementById("load-track");
      const pct = doc.getElementById("load-pct");
      if (title) title.textContent = "Couldn’t open the document";
      if (status) status.textContent = message || "Something went wrong.";
      if (track) track.hidden = true;
      if (pct) pct.hidden = true;
    } catch {
      /* Ignore a closed preview. */
    }
  }

  function startPreviewCreep(preview) {
    const started = performance.now();
    let ratio = 0;
    const timer = setInterval(() => {
      const elapsed = performance.now() - started;
      const eased = 92 * (1 - Math.exp(-elapsed / 2800));
      const fromBytes = ratio * 94;
      setPreviewProgress(
        preview,
        Math.min(96, Math.max(eased, fromBytes)),
        ratio > 0 ? "Downloading…" : "Fetching the file…"
      );
    }, 80);
    return {
      ratio(next) {
        ratio = Math.max(ratio, Math.max(0, Math.min(1, Number(next) || 0)));
      },
      stop() {
        clearInterval(timer);
      },
    };
  }

  async function readDownloadBody(response, onRatio) {
    const total = Number(response.headers.get("Content-Length")) || 0;
    if (!response.body || !response.body.getReader) return new Uint8Array(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total) onRatio(received / total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    chunks.forEach((chunk) => {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return bytes;
  }

  async function openVaultDocument(id, options = {}) {
    const preview = options.previewWindow && !options.previewWindow.closed ? options.previewWindow : null;
    const painted = paintPreviewShell(preview);
    const creep = painted ? startPreviewCreep(preview) : null;
    try {
      const res = await fetch(invoiceDocumentsUrl(), {
        method: "POST",
        headers: await functionHeaders(true),
        body: JSON.stringify({ action: "download", id }),
      });
      if (!res.ok) throw new Error(await parseErrorResponse(res));
      const fileName = fileNameFromDisposition(res.headers.get("Content-Disposition"), "document");
      const bytes = await readDownloadBody(res, (ratio) => creep?.ratio(ratio));
      const blob = withUsefulType(new Blob([bytes]), fileName);
      creep?.stop();
      setPreviewProgress(preview, 100, "Opening…");
      await new Promise((resolve) => setTimeout(resolve, 220));
      const url = URL.createObjectURL(blob);
      if (preview && !preview.closed) {
        try {
          preview.document.body.style.transition = "opacity 0.2s ease";
          preview.document.body.style.opacity = "0";
        } catch {
          /* Preview may already be closing. */
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
        preview.location.replace(url);
      } else {
        const opened = window.open(url, "_blank");
        if (!opened) saveBlob(blob, fileName);
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (err) {
      creep?.stop();
      showPreviewError(preview, err instanceof Error ? err.message : "Could not open the document.");
      throw err;
    }
  }

  async function revokeVaultPublicLinks() {
    let after = "";
    for (let i = 0; i < 100; i += 1) {
      const { json } = await postInvoiceDocuments({ action: "revoke-public-links", after });
      if (!json || json.done) return json;
      if (!json.after || json.after === after) return json;
      after = json.after;
    }
    return null;
  }

  function localSettings() {
    const gd = global.PumpSettings?.getCachedSync?.()?.integrations?.googleDrive;
    return {
      enabled: gd?.enabled === true,
      rootFolderId: (gd?.rootFolderId || "").trim() || null,
    };
  }

  global.DriveFiles = {
    functionUrl,
    status,
    archive,
    waitUntilArchived,
    upload,
    download,
    downloadAndSave,
    openBlob,
    remove,
    isNotConfiguredError,
    localSettings,
  };

  global.VaultDocuments = {
    open: openVaultDocument,
    revokePublicLinks: revokeVaultPublicLinks,
  };
})(typeof window !== "undefined" ? window : globalThis);
