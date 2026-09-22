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
})(typeof window !== "undefined" ? window : globalThis);
