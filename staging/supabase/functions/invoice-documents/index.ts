// Supabase Edge Function: invoice-documents
// Upload, list metadata, download invoice files to/from Google Drive (year/month folders).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const TOKEN_CACHE_MS = 50 * 60 * 1000;
const SETTINGS_CACHE_MS = 30 * 1000;
const FOLDER_CACHE_MS = 10 * 60 * 1000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface GoogleDriveConfig {
  enabled?: boolean;
  rootFolderId?: string;
}

interface AuthUser {
  userId: string;
  role: string;
}

interface PumpDriveSettings {
  rootFolderId: string | null;
  settingsEnabled: boolean;
}

type DriveAuthMode = "oauth" | "service_account";

let tokenCache: { value: string; mode: DriveAuthMode; expiresAt: number } | null = null;
let settingsCache: (PumpDriveSettings & { expiresAt: number }) | null = null;
let serviceAccountCache: ServiceAccount | null = null;
const folderCache = new Map<string, { id: string; expiresAt: number }>();

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function driveHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function envTrim(key: string): string {
  return Deno.env.get(key)?.trim() ?? "";
}

function resolveDriveAuthMode(): DriveAuthMode | null {
  if (envTrim("GOOGLE_OAUTH_REFRESH_TOKEN") && envTrim("GOOGLE_OAUTH_CLIENT_ID") && envTrim("GOOGLE_OAUTH_CLIENT_SECRET")) {
    return "oauth";
  }
  if (envTrim("GOOGLE_SERVICE_ACCOUNT_JSON")) return "service_account";
  return null;
}

async function fetchGoogleToken(body: URLSearchParams, errorLabel: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`${errorLabel}: ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`${errorLabel}: missing access_token`);
  return data.access_token as string;
}

async function fetchOAuthToken(): Promise<string> {
  return fetchGoogleToken(
    new URLSearchParams({
      client_id: envTrim("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: envTrim("GOOGLE_OAUTH_CLIENT_SECRET"),
      refresh_token: envTrim("GOOGLE_OAUTH_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
    "Google OAuth token error"
  );
}

async function fetchServiceAccountToken(sa: ServiceAccount): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({
      iss: sa.client_email,
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }))
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  return fetchGoogleToken(
    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    "Google token error"
  );
}

function parseServiceAccount(): ServiceAccount {
  if (serviceAccountCache) return serviceAccountCache;
  const raw = envTrim("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("Google service account is not configured.");
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error("Invalid Google service account JSON.");
  serviceAccountCache = sa;
  return sa;
}

async function getDriveAccessToken(): Promise<string> {
  const mode = resolveDriveAuthMode();
  if (!mode) {
    throw new Error(
      "Google Drive is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, " +
      "and GOOGLE_OAUTH_REFRESH_TOKEN in Supabase secrets."
    );
  }

  const now = Date.now();
  if (tokenCache && tokenCache.mode === mode && tokenCache.expiresAt > now) {
    return tokenCache.value;
  }

  const token = mode === "oauth"
    ? await fetchOAuthToken()
    : await fetchServiceAccountToken(parseServiceAccount());

  tokenCache = { value: token, mode, expiresAt: now + TOKEN_CACHE_MS };
  return token;
}

async function driveFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  const url = path.startsWith("http") ? path : `${DRIVE_API}${path}${sep}supportsAllDrives=true`;
  return fetch(url, { ...init, headers: { ...driveHeaders(token), ...init?.headers } });
}

async function findFolder(token: string, parentId: string, name: string): Promise<string | null> {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await driveFetch(`/files?q=${q}&fields=files(id)&pageSize=1&includeItemsFromAllDrives=true`, token);
  if (!res.ok) throw new Error(`Drive list error: ${await res.text()}`);
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function createFolder(token: string, parentId: string, name: string): Promise<string> {
  const res = await driveFetch("/files", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`Drive create folder error: ${await res.text()}`);
  return (await res.json()).id as string;
}

function monthFolderName(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long" });
}

async function ensureYearMonthFolder(token: string, rootFolderId: string, year: number, month: number): Promise<string> {
  const cacheKey = `${rootFolderId}:${year}:${month}`;
  const now = Date.now();
  const cached = folderCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.id;

  const yearStr = String(year);
  const monthStr = monthFolderName(year, month);

  let yearFolderId = await findFolder(token, rootFolderId, yearStr);
  if (!yearFolderId) yearFolderId = await createFolder(token, rootFolderId, yearStr);

  let monthFolderId = await findFolder(token, yearFolderId, monthStr);
  if (!monthFolderId) monthFolderId = await createFolder(token, yearFolderId, monthStr);

  folderCache.set(cacheKey, { id: monthFolderId, expiresAt: now + FOLDER_CACHE_MS });
  return monthFolderId;
}

async function uploadToDrive(
  token: string,
  folderId: string,
  fileName: string,
  mimeType: string,
  bytes: Uint8Array
): Promise<{ fileId: string; webViewLink: string | null }> {
  const boundary = "petrolpump_invoice_boundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const prefix = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
  body.set(prefix, 0);
  body.set(bytes, prefix.length);
  body.set(suffix, prefix.length + bytes.length);

  const res = await fetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`,
    {
      method: "POST",
      headers: { ...driveHeaders(token), "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive upload error: ${await res.text()}`);
  const data = await res.json();

  driveFetch(`/files/${data.id}/permissions`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  }).catch(() => {});

  return { fileId: data.id, webViewLink: data.webViewLink ?? null };
}

async function downloadFromDrive(
  token: string,
  fileId: string,
  fallback?: { fileName?: string | null; mimeType?: string | null }
) {
  const fileRes = await driveFetch(`/files/${fileId}?alt=media`, token);
  if (!fileRes.ok) throw new Error(`Drive download error: ${await fileRes.text()}`);

  return {
    bytes: new Uint8Array(await fileRes.arrayBuffer()),
    mimeType: fallback?.mimeType || "application/octet-stream",
    fileName: fallback?.fileName || "invoice",
  };
}

async function deleteFromDrive(token: string, fileId: string): Promise<void> {
  const res = await driveFetch(`/files/${fileId}`, token, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete error: ${await res.text()}`);
}

async function readPumpSettings(): Promise<PumpDriveSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) {
    return {
      rootFolderId: settingsCache.rootFolderId,
      settingsEnabled: settingsCache.settingsEnabled,
    };
  }

  const { data, error } = await supabaseAdmin.from("pump_settings").select("config").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);

  const gd = (data?.config as { integrations?: { googleDrive?: GoogleDriveConfig } })?.integrations?.googleDrive;
  const rootFolderId = gd?.rootFolderId?.trim() || null;
  const settingsEnabled = gd?.enabled === true;
  settingsCache = { rootFolderId, settingsEnabled, expiresAt: now + SETTINGS_CACHE_MS };
  return { rootFolderId, settingsEnabled };
}

async function getDriveConfig(): Promise<string> {
  const { rootFolderId, settingsEnabled } = await readPumpSettings();
  if (!settingsEnabled) throw new Error("Google Drive integration is disabled in Settings.");
  if (!rootFolderId) throw new Error("Google Drive root folder ID is not configured in Settings.");
  return rootFolderId;
}

async function getInvoiceDocument(id: string, columns: string) {
  const { data, error } = await supabaseAdmin.from("invoice_documents").select(columns).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Document not found");
  return data;
}

async function verifyAuth(req: Request): Promise<AuthUser> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Missing authorization header");

  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  if (!jwt || jwt === supabaseAnonKey) throw new Error("Invalid session");

  const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const [{ data: userData, error: userError }, { data: access, error: accessError }] = await Promise.all([
    authedClient.auth.getUser(jwt),
    authedClient.rpc("check_page_access", { p_page: "invoices" }),
  ]);

  if (userError || !userData.user) throw new Error(userError?.message || "Invalid session");
  if (accessError) throw new Error(accessError.message);
  if (access?.allowed !== true && access?.allowed !== "true") throw new Error("Access denied");

  return { userId: userData.user.id, role: String(access?.role ?? "") };
}

function buildDriveStatus(settings: PumpDriveSettings) {
  const mode = resolveDriveAuthMode();
  return {
    configured: !!mode && !!settings.rootFolderId && settings.settingsEnabled,
    authMode: mode,
    hasOAuth: mode === "oauth",
    hasServiceAccount: mode === "service_account",
    rootFolderId: settings.rootFolderId,
    settingsEnabled: settings.settingsEnabled,
  };
}

function httpErrorStatus(message: string): number {
  return message.includes("Access denied") || message.includes("Invalid session") ? 403 : 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const auth = await verifyAuth(req);
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return jsonResponse({ error: "file is required" }, 400);

      const invoiceDate = String(form.get("invoiceDate") || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
        return jsonResponse({ error: "invoiceDate is required (YYYY-MM-DD)" }, 400);
      }
      if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
        return jsonResponse({ error: `File must be between 1 byte and ${MAX_FILE_BYTES / (1024 * 1024)} MB` }, 400);
      }
      if (!ALLOWED_MIME.has(file.type)) {
        return jsonResponse({ error: "Allowed types: PDF, JPEG, PNG, WebP" }, 400);
      }

      const [yearStr, monthStr] = invoiceDate.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      const amountRaw = String(form.get("amount") || "").trim();
      const amount = amountRaw ? Number(amountRaw) : null;
      const safeName = file.name.replace(/[^\w.\-() ]+/g, "_").slice(0, 200);

      const bytesPromise = file.arrayBuffer();
      const [token, rootFolderId] = await Promise.all([
        getDriveAccessToken(),
        getDriveConfig(),
      ]);
      const folderId = await ensureYearMonthFolder(token, rootFolderId, year, month);
      const { fileId, webViewLink } = await uploadToDrive(
        token,
        folderId,
        safeName,
        file.type,
        new Uint8Array(await bytesPromise)
      );

      const { data: row, error: insertError } = await supabaseAdmin
        .from("invoice_documents")
        .insert({
          invoice_date: invoiceDate,
          year,
          month,
          title: String(form.get("title") || "").trim() || null,
          vendor: String(form.get("vendor") || "").trim() || null,
          amount: Number.isFinite(amount) ? amount : null,
          file_name: safeName,
          mime_type: file.type,
          file_size: file.size,
          drive_file_id: fileId,
          drive_folder_id: folderId,
          drive_web_view_link: webViewLink,
          notes: String(form.get("notes") || "").trim() || null,
          uploaded_by: auth.userId,
        })
        .select("id, invoice_date, year, month, title, vendor, amount, file_name, mime_type, file_size, drive_web_view_link, created_at")
        .single();

      if (insertError) {
        await deleteFromDrive(token, fileId).catch(() => {});
        throw new Error(insertError.message);
      }
      return jsonResponse({ ok: true, document: row });
    }

    const body = await req.json();
    const action = body.action as string;

    if (action === "status") {
      const [settings, authResult] = await Promise.all([
        readPumpSettings(),
        verifyAuth(req)
          .then(() => ({ authOk: true as const, authError: null as string | null }))
          .catch((err) => ({
            authOk: false as const,
            authError: err instanceof Error ? err.message : "Auth failed",
          })),
      ]);
      return jsonResponse({ ...buildDriveStatus(settings), ...authResult });
    }

    const auth = await verifyAuth(req);

    if (action === "download") {
      const id = body.id as string;
      if (!id) return jsonResponse({ error: "id is required" }, 400);

      const [doc, token] = await Promise.all([
        getInvoiceDocument(id, "drive_file_id, file_name, mime_type"),
        getDriveAccessToken(),
      ]);
      const { bytes, mimeType, fileName } = await downloadFromDrive(token, doc.drive_file_id, doc);

      return new Response(bytes, {
        headers: {
          ...corsHeaders,
          "Content-Type": mimeType || doc.mime_type,
          "Content-Disposition": `attachment; filename="${fileName || doc.file_name}"`,
        },
      });
    }

    if (action === "delete") {
      if (auth.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      const id = body.id as string;
      if (!id) return jsonResponse({ error: "id is required" }, 400);

      const [doc, token] = await Promise.all([
        getInvoiceDocument(id, "drive_file_id"),
        getDriveAccessToken(),
      ]);
      await deleteFromDrive(token, doc.drive_file_id);
      const { error: delError } = await supabaseAdmin.from("invoice_documents").delete().eq("id", id);
      if (delError) throw new Error(delError.message);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "Document not found" ? 404 : httpErrorStatus(message);
    return jsonResponse({ error: message }, status);
  }
});
