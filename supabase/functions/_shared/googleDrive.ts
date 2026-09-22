// Shared Google Drive helpers for invoice-documents and drive-files edge functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.94.1?target=denonext";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_CACHE_MS = 50 * 60 * 1000;
const SETTINGS_CACHE_MS = 30 * 1000;
const FOLDER_CACHE_MS = 6 * 60 * 60 * 1000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface GoogleDriveConfig {
  enabled?: boolean;
  rootFolderId?: string;
}

export interface AuthUser {
  userId: string;
  role: string;
}

export interface StationBranding {
  displayName: string;
  brandShort: string;
  brandAccent: string;
  legalName: string;
  tagline: string;
  address: string;
  email: string;
  mobile: string;
  gstin: string;
  license: string;
}

export interface PumpDriveSettings {
  rootFolderId: string | null;
  settingsEnabled: boolean;
  station: StationBranding;
}

export type DriveAuthMode = "oauth" | "service_account";

export const DRIVE_TREE = {
  billing: "Billing invoices",
  letters: "Letters",
  purchaseInvoices: "Purchase invoices",
  staff: "Staff",
  otherDocuments: "Other documents",
} as const;

const DEFAULT_STATION: StationBranding = {
  displayName: "Bishnupriya Fuels",
  brandShort: "Bishnu Priya",
  brandAccent: "Fuels",
  legalName: "BISHNU PRIYA FUELS",
  tagline: "Authorized Dealer - Bharat Petroleum Corporation Ltd.",
  address: "",
  email: "",
  mobile: "",
  gstin: "",
  license: "",
};

function parseStation(config: Record<string, unknown> | null | undefined): StationBranding {
  const s = (config?.station || {}) as Partial<StationBranding>;
  return {
    displayName: String(s.displayName || DEFAULT_STATION.displayName),
    brandShort: String(s.brandShort || DEFAULT_STATION.brandShort),
    brandAccent: String(s.brandAccent || DEFAULT_STATION.brandAccent),
    legalName: String(s.legalName || DEFAULT_STATION.legalName),
    tagline: String(s.tagline || DEFAULT_STATION.tagline),
    address: String(s.address || ""),
    email: String(s.email || ""),
    mobile: String(s.mobile || ""),
    gstin: String(s.gstin || ""),
    license: String(s.license || ""),
  };
}

let tokenCache: { value: string; mode: DriveAuthMode; expiresAt: number } | null = null;
let settingsCache: (PumpDriveSettings & { expiresAt: number }) | null = null;
let serviceAccountCache: ServiceAccount | null = null;
const folderCache = new Map<string, { id: string; expiresAt: number }>();

export const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

export function jsonResponse(body: unknown, status = 200): Response {
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

export function envTrim(key: string): string {
  return Deno.env.get(key)?.trim() ?? "";
}

export function resolveDriveAuthMode(): DriveAuthMode | null {
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

export async function getDriveAccessToken(): Promise<string> {
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

export async function driveFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
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

export function monthFolderName(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function ensureChildFolder(token: string, parentId: string, name: string): Promise<string> {
  let folderId = await findFolder(token, parentId, name);
  if (!folderId) folderId = await createFolder(token, parentId, name);
  return folderId;
}

async function readCachedFolderId(cacheKey: string): Promise<string | null> {
  const now = Date.now();
  const mem = folderCache.get(cacheKey);
  if (mem && mem.expiresAt > now) return mem.id;
  const { data, error } = await supabaseAdmin
    .from("drive_folder_cache")
    .select("folder_id")
    .eq("cache_key", cacheKey)
    .maybeSingle();
  if (error || !data?.folder_id) return null;
  folderCache.set(cacheKey, { id: data.folder_id, expiresAt: now + FOLDER_CACHE_MS });
  return data.folder_id;
}

async function writeCachedFolderId(cacheKey: string, folderId: string): Promise<void> {
  folderCache.set(cacheKey, { id: folderId, expiresAt: Date.now() + FOLDER_CACHE_MS });
  await supabaseAdmin.from("drive_folder_cache").upsert({
    cache_key: cacheKey,
    folder_id: folderId,
    updated_at: new Date().toISOString(),
  });
}

export async function ensureFolderPath(token: string, rootFolderId: string, segments: string[]): Promise<string> {
  const trimmed = segments.map((name) => String(name || "").trim()).filter(Boolean);
  const fullKey = `${rootFolderId}:${trimmed.join("/")}`;
  const hit = await readCachedFolderId(fullKey);
  if (hit) return hit;

  let parentId = rootFolderId;
  let path = "";
  for (const name of trimmed) {
    path = path ? `${path}/${name}` : name;
    const key = `${rootFolderId}:${path}`;
    const cached = await readCachedFolderId(key);
    if (cached) {
      parentId = cached;
      continue;
    }
    parentId = await ensureChildFolder(token, parentId, name);
    await writeCachedFolderId(key, parentId);
  }
  return parentId;
}

export function vaultDocumentFolderSegments(
  categoryName: string,
  categoryLabel: string,
  year: number,
  _month: number
): string[] {
  if (categoryName === "purchase") {
    return [DRIVE_TREE.purchaseInvoices, String(year)];
  }
  const label = (categoryLabel || "Other").trim() || "Other";
  return [DRIVE_TREE.otherDocuments, label, String(year)];
}

export function salesInvoiceFolderSegments(year: number, _month: number): string[] {
  return [DRIVE_TREE.billing, String(year)];
}

export function letterFolderSegments(year: number, _month: number): string[] {
  return [DRIVE_TREE.letters, String(year)];
}

export function staffRecordFolderSegments(staffFolderName: string): string[] {
  return [DRIVE_TREE.staff, staffFolderName];
}

export function staffFolderName(name: string, employeeId: string): string {
  const safe = String(name || "")
    .replace(/[^\p{L}\p{N}\s._-]+/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80) || "Staff";
  const short = String(employeeId || "").replace(/-/g, "").slice(0, 4).toUpperCase();
  return short ? `${safe} · ${short}` : safe;
}

export function sanitizeFileName(name: string, fallback = "file"): string {
  const safe = String(name || "")
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return safe || fallback;
}

export async function uploadToDrive(
  token: string,
  folderId: string,
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
  options: { makePublic?: boolean } = {}
): Promise<{ fileId: string; webViewLink: string | null }> {
  const boundary = "petrolpump_drive_boundary";
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

  if (options.makePublic !== false) {
    driveFetch(`/files/${data.id}/permissions`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    }).catch(() => {});
  }

  return { fileId: data.id, webViewLink: data.webViewLink ?? null };
}

export async function downloadFromDrive(
  token: string,
  fileId: string,
  fallback?: { fileName?: string | null; mimeType?: string | null }
) {
  const fileRes = await driveFetch(`/files/${fileId}?alt=media`, token);
  if (!fileRes.ok) throw new Error(`Drive download error: ${await fileRes.text()}`);

  const headerType = (fileRes.headers.get("content-type") || "").split(";")[0].trim();
  const preferred =
    fallback?.mimeType && fallback.mimeType !== "application/octet-stream" ? fallback.mimeType : "";

  return {
    bytes: new Uint8Array(await fileRes.arrayBuffer()),
    mimeType: preferred || headerType || "application/octet-stream",
    fileName: fallback?.fileName || "download",
  };
}

export async function deleteFromDrive(token: string, fileId: string): Promise<void> {
  if (!fileId) return;
  const res = await driveFetch(`/files/${fileId}`, token, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete error: ${await res.text()}`);
}

export async function deleteNamedFilesInFolder(
  token: string,
  folderId: string,
  fileName: string
): Promise<void> {
  if (!folderId || !fileName) return;
  const escaped = fileName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = encodeURIComponent(`name = '${escaped}' and '${folderId}' in parents and trashed = false`);
  const res = await driveFetch(
    `/files?q=${q}&fields=files(id)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    token
  );
  if (!res.ok) return;
  const data = await res.json();
  for (const file of data.files || []) {
    if (file?.id) await deleteFromDrive(token, file.id).catch(() => {});
  }
}

export function publicDriveImageUrl(fileId: string): string {
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

export async function readPumpSettings(): Promise<PumpDriveSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) {
    return {
      rootFolderId: settingsCache.rootFolderId,
      settingsEnabled: settingsCache.settingsEnabled,
      station: settingsCache.station,
    };
  }

  const { data, error } = await supabaseAdmin.from("pump_settings").select("config").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);

  const config = (data?.config || {}) as Record<string, unknown>;
  const gd = (config.integrations as { googleDrive?: GoogleDriveConfig } | undefined)?.googleDrive;
  const rootFolderId = gd?.rootFolderId?.trim() || null;
  const settingsEnabled = gd?.enabled === true;
  const station = parseStation(config);
  settingsCache = { rootFolderId, settingsEnabled, station, expiresAt: now + SETTINGS_CACHE_MS };
  return { rootFolderId, settingsEnabled, station };
}

export async function getDriveConfig(): Promise<string> {
  const { rootFolderId, settingsEnabled } = await readPumpSettings();
  if (!settingsEnabled) throw new Error("Google Drive integration is disabled in Settings.");
  if (!rootFolderId) throw new Error("Google Drive root folder ID is not configured in Settings.");
  return rootFolderId;
}

export function buildDriveStatus(settings: PumpDriveSettings) {
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

export async function verifyPageAccess(req: Request, page: string): Promise<AuthUser> {
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
    authedClient.rpc("check_page_access", { p_page: page }),
  ]);

  if (userError || !userData.user) throw new Error(userError?.message || "Invalid session");
  if (accessError) throw new Error(accessError.message);
  if (access?.allowed !== true && access?.allowed !== "true") throw new Error("Access denied");

  return { userId: userData.user.id, role: String(access?.role ?? "") };
}

export function httpErrorStatus(message: string): number {
  return message.includes("Access denied") || message.includes("Invalid session") ? 403 : 500;
}

export function parseIsoDate(value: string): { year: number; month: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [yearStr, monthStr] = value.split("-");
  return { year: Number(yearStr), month: Number(monthStr) };
}
