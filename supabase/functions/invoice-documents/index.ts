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

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface GoogleDriveConfig {
  enabled?: boolean;
  rootFolderId?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64UrlEncode(data: Uint8Array): string {
  const str = btoa(String.fromCharCode(...data));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: DRIVE_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      })
    )
  );

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token error: ${err}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

async function findFolder(
  token: string,
  parentId: string,
  name: string
): Promise<string | null> {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await fetch(
    `${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive list error: ${await res.text()}`);
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function createFolder(
  token: string,
  parentId: string,
  name: string
): Promise<string> {
  const res = await fetch(`${DRIVE_API}/files?supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!res.ok) throw new Error(`Drive create folder error: ${await res.text()}`);
  const data = await res.json();
  return data.id as string;
}

async function ensureYearMonthFolder(
  token: string,
  rootFolderId: string,
  year: number,
  month: number
): Promise<string> {
  const yearName = String(year);
  const monthName = String(month).padStart(2, "0");

  let yearFolderId = await findFolder(token, rootFolderId, yearName);
  if (!yearFolderId) {
    yearFolderId = await createFolder(token, rootFolderId, yearName);
  }

  let monthFolderId = await findFolder(token, yearFolderId, monthName);
  if (!monthFolderId) {
    monthFolderId = await createFolder(token, yearFolderId, monthName);
  }

  return monthFolderId;
}

async function uploadToDrive(
  token: string,
  folderId: string,
  fileName: string,
  mimeType: string,
  bytes: Uint8Array
): Promise<{ fileId: string; webViewLink: string | null }> {
  const metadata = { name: fileName, parents: [folderId] };
  const boundary = "petrolpump_invoice_boundary";
  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];
  const prefix = new TextEncoder().encode(bodyParts.join(""));
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
  const fullBody = new Uint8Array(prefix.length + bytes.length + suffix.length);
  fullBody.set(prefix, 0);
  fullBody.set(bytes, prefix.length);
  fullBody.set(suffix, prefix.length + bytes.length);

  const res = await fetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: fullBody,
    }
  );

  if (!res.ok) throw new Error(`Drive upload error: ${await res.text()}`);
  const data = await res.json();

  // Allow viewing via web link for logged-in app users
  await fetch(`${DRIVE_API}/files/${data.id}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  }).catch(() => {});

  return { fileId: data.id, webViewLink: data.webViewLink ?? null };
}

async function downloadFromDrive(
  token: string,
  fileId: string
): Promise<{ bytes: Uint8Array; mimeType: string; fileName: string }> {
  const metaRes = await fetch(
    `${DRIVE_API}/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`Drive metadata error: ${await metaRes.text()}`);
  const meta = await metaRes.json();

  const fileRes = await fetch(
    `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!fileRes.ok) throw new Error(`Drive download error: ${await fileRes.text()}`);
  const buf = await fileRes.arrayBuffer();

  return {
    bytes: new Uint8Array(buf),
    mimeType: meta.mimeType || "application/octet-stream",
    fileName: meta.name || "invoice",
  };
}

async function deleteFromDrive(token: string, fileId: string): Promise<void> {
  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?supportsAllDrives=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Drive delete error: ${await res.text()}`);
  }
}

function getServiceAccount(): ServiceAccount {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("Google Drive is not configured (missing service account).");
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Invalid Google service account JSON.");
  }
  return sa;
}

async function getDriveConfig(
  supabaseAdmin: ReturnType<typeof createClient>
): Promise<{ rootFolderId: string }> {
  const { data, error } = await supabaseAdmin
    .from("pump_settings")
    .select("config")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const integrations = (data?.config as { integrations?: { googleDrive?: GoogleDriveConfig } })
    ?.integrations;
  const gd = integrations?.googleDrive;

  if (!gd?.enabled) throw new Error("Google Drive integration is disabled in Settings.");
  if (!gd?.rootFolderId?.trim()) {
    throw new Error("Google Drive root folder ID is not configured in Settings.");
  }

  return { rootFolderId: gd.rootFolderId.trim() };
}

async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Missing authorization header");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: access, error: accessError } = await userClient.rpc("check_page_access", {
    p_page: "invoices",
  });
  if (accessError) throw new Error(accessError.message);
  if (!access?.allowed) throw new Error("Access denied");

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) throw new Error("Invalid session");

  return { userId: user.id, role: access.role as string };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await verifyAuth(req);
    const contentType = req.headers.get("content-type") || "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    // Multipart upload
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return jsonResponse({ error: "file is required" }, 400);
      }

      const invoiceDate = String(form.get("invoiceDate") || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
        return jsonResponse({ error: "invoiceDate is required (YYYY-MM-DD)" }, 400);
      }

      if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
        return jsonResponse({ error: `File must be between 1 byte and ${MAX_FILE_BYTES / (1024 * 1024)} MB` }, 400);
      }

      const allowedTypes = new Set([
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
      ]);
      if (!allowedTypes.has(file.type)) {
        return jsonResponse({ error: "Allowed types: PDF, JPEG, PNG, WebP" }, 400);
      }

      const [yearStr, monthStr] = invoiceDate.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);

      const title = String(form.get("title") || "").trim() || null;
      const vendor = String(form.get("vendor") || "").trim() || null;
      const notes = String(form.get("notes") || "").trim() || null;
      const amountRaw = String(form.get("amount") || "").trim();
      const amount = amountRaw ? Number(amountRaw) : null;

      const sa = getServiceAccount();
      const token = await getGoogleAccessToken(sa);
      const { rootFolderId } = await getDriveConfig(supabaseAdmin);
      const folderId = await ensureYearMonthFolder(token, rootFolderId, year, month);

      const bytes = new Uint8Array(await file.arrayBuffer());
      const safeName = file.name.replace(/[^\w.\-() ]+/g, "_").slice(0, 200);
      const { fileId, webViewLink } = await uploadToDrive(
        token,
        folderId,
        safeName,
        file.type,
        bytes
      );

      const { data: row, error: insertError } = await supabaseAdmin
        .from("invoice_documents")
        .insert({
          invoice_date: invoiceDate,
          year,
          month,
          title,
          vendor,
          amount: Number.isFinite(amount) ? amount : null,
          file_name: safeName,
          mime_type: file.type,
          file_size: file.size,
          drive_file_id: fileId,
          drive_folder_id: folderId,
          drive_web_view_link: webViewLink,
          notes,
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
      const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
      let driveConfigured = false;
      let rootFolderId: string | null = null;
      try {
        const { rootFolderId: rid } = await getDriveConfig(supabaseAdmin);
        driveConfigured = !!saJson;
        rootFolderId = rid;
      } catch {
        driveConfigured = false;
      }
      return jsonResponse({
        configured: !!saJson && !!rootFolderId,
        hasServiceAccount: !!saJson,
        rootFolderId,
      });
    }

    if (action === "download") {
      const id = body.id as string;
      if (!id) return jsonResponse({ error: "id is required" }, 400);

      const { data: doc, error: docError } = await supabaseAdmin
        .from("invoice_documents")
        .select("drive_file_id, file_name, mime_type")
        .eq("id", id)
        .maybeSingle();

      if (docError) throw new Error(docError.message);
      if (!doc) return jsonResponse({ error: "Document not found" }, 404);

      const sa = getServiceAccount();
      const token = await getGoogleAccessToken(sa);
      const { bytes, mimeType, fileName } = await downloadFromDrive(
        token,
        doc.drive_file_id
      );

      return new Response(bytes, {
        headers: {
          ...corsHeaders,
          "Content-Type": mimeType || doc.mime_type,
          "Content-Disposition": `attachment; filename="${fileName || doc.file_name}"`,
        },
      });
    }

    if (action === "delete") {
      if (auth.role !== "admin") {
        return jsonResponse({ error: "Admin only" }, 403);
      }
      const id = body.id as string;
      if (!id) return jsonResponse({ error: "id is required" }, 400);

      const { data: doc, error: docError } = await supabaseAdmin
        .from("invoice_documents")
        .select("drive_file_id")
        .eq("id", id)
        .maybeSingle();

      if (docError) throw new Error(docError.message);
      if (!doc) return jsonResponse({ error: "Document not found" }, 404);

      const sa = getServiceAccount();
      const token = await getGoogleAccessToken(sa);
      await deleteFromDrive(token, doc.drive_file_id);

      const { error: delError } = await supabaseAdmin
        .from("invoice_documents")
        .delete()
        .eq("id", id);

      if (delError) throw new Error(delError.message);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Access denied") || message.includes("Invalid session") ? 403 : 500;
    return jsonResponse({ error: message }, status);
  }
});
