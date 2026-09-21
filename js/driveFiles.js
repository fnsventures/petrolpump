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

  async function download(params) {
    const res = await fetch(functionUrl(), {
      method: "POST",
      headers: await functionHeaders(true),
      body: JSON.stringify({ action: "download", ...params }),
    });
    if (!res.ok) throw new Error(await parseErrorResponse(res));
    const blob = await res.blob();
    const header = res.headers.get("Content-Disposition") || "";
    const match = header.match(/filename="([^"]+)"/i);
    return { blob, fileName: match?.[1] || params.fileName || "download" };
  }

  async function downloadAndSave(params) {
    const { blob, fileName } = await download(params);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { blob, fileName };
  }

  async function openBlob(params) {
    const { blob } = await download(params);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
    upload,
    download,
    downloadAndSave,
    openBlob,
    remove,
    isNotConfiguredError,
    localSettings,
  };
})(typeof window !== "undefined" ? window : globalThis);
