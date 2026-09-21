// Supabase Edge Function: drive-files
// Upload/download/delete sales invoices, letters, staff photos, and Aadhaar scans in Google Drive.

import {
  buildDriveStatus,
  corsHeaders,
  deleteFromDrive,
  downloadFromDrive,
  ensureFolderPath,
  getDriveAccessToken,
  getDriveConfig,
  httpErrorStatus,
  jsonResponse,
  letterFolderSegments,
  parseIsoDate,
  publicDriveImageUrl,
  readPumpSettings,
  salesInvoiceFolderSegments,
  sanitizeFileName,
  staffFolderName,
  staffRecordFolderSegments,
  supabaseAdmin,
  uploadToDrive,
  verifyPageAccess,
  type AuthUser,
} from "../_shared/googleDrive.ts";

const MAX_DOC_BYTES = 15 * 1024 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_AADHAAR_BYTES = 10 * 1024 * 1024;

const DOC_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/html",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const PHOTO_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const AADHAAR_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

type DriveKind = "sales_invoice" | "letter" | "staff_photo" | "staff_aadhaar";

function kindPage(kind: DriveKind): string {
  if (kind === "sales_invoice") return "billing";
  if (kind === "letter") return "letterhead";
  return "staff";
}

function parseKind(raw: string): DriveKind | null {
  if (raw === "sales_invoice" || raw === "letter" || raw === "staff_photo" || raw === "staff_aadhaar") {
    return raw;
  }
  return null;
}

function photoExtension(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function aadhaarExtension(mime: string, fileName: string): string {
  if (mime === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  return photoExtension(mime);
}

async function verifyKindAuth(req: Request, kind: DriveKind): Promise<AuthUser> {
  return verifyPageAccess(req, kindPage(kind));
}

async function loadEmployee(id: string) {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name, photo_drive_file_id, aadhaar_drive_file_id, aadhaar_file_name")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Employee not found");
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const kind = parseKind(String(form.get("kind") || "").trim());
      if (!kind) return jsonResponse({ error: "kind is required" }, 400);

      const auth = await verifyKindAuth(req, kind);
      const file = form.get("file");
      if (!(file instanceof File)) return jsonResponse({ error: "file is required" }, 400);

      if (kind === "sales_invoice") return handleSalesInvoiceUpload(auth, form, file);
      if (kind === "letter") return handleLetterUpload(auth, form, file);
      if (kind === "staff_photo") return handleStaffPhotoUpload(form, file);
      return handleStaffAadhaarUpload(form, file);
    }

    const body = await req.json();
    const action = body.action as string;

    if (action === "status") {
      const [settings, authResult] = await Promise.all([
        readPumpSettings(),
        verifyPageAccess(req, "billing")
          .catch(() => verifyPageAccess(req, "letterhead"))
          .catch(() => verifyPageAccess(req, "staff"))
          .then(() => ({ authOk: true as const, authError: null as string | null }))
          .catch((err) => ({
            authOk: false as const,
            authError: err instanceof Error ? err.message : "Auth failed",
          })),
      ]);
      return jsonResponse({ ...buildDriveStatus(settings), ...authResult });
    }

    const kind = parseKind(String(body.kind || "").trim());
    if (!kind) return jsonResponse({ error: "kind is required" }, 400);
    const auth = await verifyKindAuth(req, kind);

    if (action === "download") {
      return handleDownload(kind, body);
    }

    if (action === "delete") {
      return handleDelete(auth, kind, body);
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const notFound =
      message === "Document not found" ||
      message === "Employee not found" ||
      message === "Letter not found" ||
      message === "Invoice not found";
    const status = notFound ? 404 : httpErrorStatus(message);
    return jsonResponse({ error: message }, status);
  }
});

async function handleSalesInvoiceUpload(auth: AuthUser, form: FormData, file: File) {
  const invoiceId = String(form.get("invoiceId") || "").trim();
  const invoiceDate = String(form.get("invoiceDate") || "").slice(0, 10);
  const parsed = parseIsoDate(invoiceDate);
  if (!invoiceId) return jsonResponse({ error: "invoiceId is required" }, 400);
  if (!parsed) return jsonResponse({ error: "invoiceDate is required (YYYY-MM-DD)" }, 400);
  if (file.size <= 0 || file.size > MAX_DOC_BYTES) {
    return jsonResponse({ error: `File must be between 1 byte and ${MAX_DOC_BYTES / (1024 * 1024)} MB` }, 400);
  }
  if (!DOC_MIME.has(file.type)) {
    return jsonResponse({ error: "Allowed types: PDF, Word, HTML, JPEG, PNG, WebP" }, 400);
  }

  const { data: invoice, error: invError } = await supabaseAdmin
    .from("invoices")
    .select("id, invoice_number, party_name, drive_file_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invError) throw new Error(invError.message);
  if (!invoice) throw new Error("Invoice not found");

  const invoiceNumber = String(form.get("invoiceNumber") || invoice.invoice_number || "invoice");
  const partyName = String(form.get("partyName") || invoice.party_name || "party");
  const fallbackName = `${invoiceNumber} — ${partyName} — ${invoiceDate}.doc`;
  const safeName = sanitizeFileName(file.name || fallbackName, fallbackName);

  const bytesPromise = file.arrayBuffer();
  const [token, rootFolderId] = await Promise.all([getDriveAccessToken(), getDriveConfig()]);
  const folderId = await ensureFolderPath(token, rootFolderId, salesInvoiceFolderSegments(parsed.year, parsed.month));
  if (invoice.drive_file_id) await deleteFromDrive(token, invoice.drive_file_id).catch(() => {});
  const { fileId, webViewLink } = await uploadToDrive(
    token,
    folderId,
    safeName,
    file.type,
    new Uint8Array(await bytesPromise)
  );

  const { error: updateError } = await supabaseAdmin
    .from("invoices")
    .update({
      drive_file_id: fileId,
      drive_folder_id: folderId,
      drive_web_view_link: webViewLink,
      drive_file_name: safeName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);
  if (updateError) {
    await deleteFromDrive(token, fileId).catch(() => {});
    throw new Error(updateError.message);
  }

  return jsonResponse({
    ok: true,
    file: {
      id: invoiceId,
      kind: "sales_invoice",
      drive_file_id: fileId,
      drive_web_view_link: webViewLink,
      file_name: safeName,
      uploaded_by: auth.userId,
    },
  });
}

async function handleLetterUpload(auth: AuthUser, form: FormData, file: File) {
  const letterDate = String(form.get("letterDate") || "").slice(0, 10);
  const parsed = parseIsoDate(letterDate);
  if (!parsed) return jsonResponse({ error: "letterDate is required (YYYY-MM-DD)" }, 400);
  const subject = String(form.get("subject") || "").trim();
  const body = String(form.get("body") || "");
  if (!subject && !body.trim()) return jsonResponse({ error: "Subject or body is required" }, 400);
  if (file.size <= 0 || file.size > MAX_DOC_BYTES) {
    return jsonResponse({ error: `File must be between 1 byte and ${MAX_DOC_BYTES / (1024 * 1024)} MB` }, 400);
  }
  if (!DOC_MIME.has(file.type)) {
    return jsonResponse({ error: "Allowed types: PDF, Word, HTML, JPEG, PNG, WebP" }, 400);
  }

  const exportTypeRaw = String(form.get("exportType") || "save").trim();
  const exportType = exportTypeRaw === "word" || exportTypeRaw === "print" || exportTypeRaw === "save"
    ? exportTypeRaw
    : "save";
  const includeSign = String(form.get("includeSign") || "true") !== "false";
  const fallbackName = `${letterDate} — ${subject || "letter"}.doc`;
  const safeName = sanitizeFileName(file.name || fallbackName, fallbackName);

  const bytesPromise = file.arrayBuffer();
  const [token, rootFolderId] = await Promise.all([getDriveAccessToken(), getDriveConfig()]);
  const folderId = await ensureFolderPath(token, rootFolderId, letterFolderSegments(parsed.year, parsed.month));
  const { fileId, webViewLink } = await uploadToDrive(
    token,
    folderId,
    safeName,
    file.type,
    new Uint8Array(await bytesPromise)
  );

  const { data: row, error: insertError } = await supabaseAdmin
    .from("letterhead_letters")
    .insert({
      letter_date: letterDate,
      subject,
      body,
      export_type: exportType,
      include_sign: includeSign,
      created_by: auth.userId,
      drive_file_id: fileId,
      drive_folder_id: folderId,
      drive_web_view_link: webViewLink,
      drive_file_name: safeName,
      mime_type: file.type,
    })
    .select("id, letter_date, subject, body, export_type, include_sign, created_at, drive_file_id, drive_web_view_link, drive_file_name")
    .single();

  if (insertError) {
    await deleteFromDrive(token, fileId).catch(() => {});
    throw new Error(insertError.message);
  }

  return jsonResponse({ ok: true, letter: row });
}

async function handleStaffPhotoUpload(form: FormData, file: File) {
  const employeeId = String(form.get("employeeId") || "").trim();
  if (!employeeId) return jsonResponse({ error: "employeeId is required" }, 400);
  if (!PHOTO_MIME.has(file.type)) return jsonResponse({ error: "Use a JPG, PNG, or WebP image." }, 400);
  if (file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
    return jsonResponse({ error: "Image must be 2 MB or smaller." }, 400);
  }

  const employee = await loadEmployee(employeeId);
  const fileName = `01 Photo.${photoExtension(file.type)}`;
  const bytesPromise = file.arrayBuffer();
  const [token, rootFolderId] = await Promise.all([getDriveAccessToken(), getDriveConfig()]);
  const folderId = await ensureFolderPath(
    token,
    rootFolderId,
    staffRecordFolderSegments(staffFolderName(employee.name, employee.id))
  );
  if (employee.photo_drive_file_id) {
    await deleteFromDrive(token, employee.photo_drive_file_id).catch(() => {});
  }
  const { fileId, webViewLink } = await uploadToDrive(
    token,
    folderId,
    fileName,
    file.type,
    new Uint8Array(await bytesPromise),
    { makePublic: true }
  );
  const photoUrl = `${publicDriveImageUrl(fileId)}?v=${Date.now()}`;

  const { error: updateError } = await supabaseAdmin
    .from("employees")
    .update({
      photo_url: photoUrl,
      photo_drive_file_id: fileId,
    })
    .eq("id", employeeId);
  if (updateError) {
    await deleteFromDrive(token, fileId).catch(() => {});
    throw new Error(updateError.message);
  }

  return jsonResponse({
    ok: true,
    photo: {
      employee_id: employeeId,
      photo_url: photoUrl,
      drive_file_id: fileId,
      drive_web_view_link: webViewLink,
      file_name: fileName,
    },
  });
}

async function handleStaffAadhaarUpload(form: FormData, file: File) {
  const employeeId = String(form.get("employeeId") || "").trim();
  if (!employeeId) return jsonResponse({ error: "employeeId is required" }, 400);
  if (!AADHAAR_MIME.has(file.type)) {
    return jsonResponse({ error: "Aadhaar card must be PDF, JPG, PNG, or WebP." }, 400);
  }
  if (file.size <= 0 || file.size > MAX_AADHAAR_BYTES) {
    return jsonResponse({ error: "Aadhaar file must be 10 MB or smaller." }, 400);
  }

  const employee = await loadEmployee(employeeId);
  const fileName = `02 Aadhaar.${aadhaarExtension(file.type, file.name)}`;
  const bytesPromise = file.arrayBuffer();
  const [token, rootFolderId] = await Promise.all([getDriveAccessToken(), getDriveConfig()]);
  const folderId = await ensureFolderPath(
    token,
    rootFolderId,
    staffRecordFolderSegments(staffFolderName(employee.name, employee.id))
  );
  if (employee.aadhaar_drive_file_id) {
    await deleteFromDrive(token, employee.aadhaar_drive_file_id).catch(() => {});
  }
  const { fileId } = await uploadToDrive(
    token,
    folderId,
    fileName,
    file.type,
    new Uint8Array(await bytesPromise),
    { makePublic: false }
  );

  const { error: updateError } = await supabaseAdmin
    .from("employees")
    .update({
      aadhaar_drive_file_id: fileId,
      aadhaar_file_name: fileName,
    })
    .eq("id", employeeId);
  if (updateError) {
    await deleteFromDrive(token, fileId).catch(() => {});
    throw new Error(updateError.message);
  }

  return jsonResponse({
    ok: true,
    aadhaar: {
      employee_id: employeeId,
      drive_file_id: fileId,
      file_name: fileName,
    },
  });
}

async function handleDownload(kind: DriveKind, body: Record<string, unknown>) {
  const token = await getDriveAccessToken();

  if (kind === "sales_invoice") {
    const id = String(body.id || "").trim();
    if (!id) return jsonResponse({ error: "id is required" }, 400);
    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("drive_file_id, drive_file_name")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.drive_file_id) throw new Error("Invoice not found");
    const { bytes, mimeType, fileName } = await downloadFromDrive(token, data.drive_file_id, {
      fileName: data.drive_file_name,
      mimeType: "application/msword",
    });
    return fileResponse(bytes, mimeType, fileName);
  }

  if (kind === "letter") {
    const id = String(body.id || "").trim();
    if (!id) return jsonResponse({ error: "id is required" }, 400);
    const { data, error } = await supabaseAdmin
      .from("letterhead_letters")
      .select("drive_file_id, drive_file_name, mime_type")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.drive_file_id) throw new Error("Letter not found");
    const { bytes, mimeType, fileName } = await downloadFromDrive(token, data.drive_file_id, {
      fileName: data.drive_file_name,
      mimeType: data.mime_type,
    });
    return fileResponse(bytes, mimeType, fileName);
  }

  const employeeId = String(body.employeeId || body.id || "").trim();
  if (!employeeId) return jsonResponse({ error: "employeeId is required" }, 400);
  const employee = await loadEmployee(employeeId);
  const fileId = kind === "staff_photo" ? employee.photo_drive_file_id : employee.aadhaar_drive_file_id;
  if (!fileId) throw new Error("Document not found");
  const fallbackName = kind === "staff_photo" ? "01 Photo.jpg" : employee.aadhaar_file_name || "02 Aadhaar.pdf";
  const { bytes, mimeType, fileName } = await downloadFromDrive(token, fileId, { fileName: fallbackName });
  return fileResponse(bytes, mimeType, fileName);
}

async function handleDelete(auth: AuthUser, kind: DriveKind, body: Record<string, unknown>) {
  if (kind === "sales_invoice" || kind === "letter") {
    if (auth.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
  }

  const token = await getDriveAccessToken().catch(() => null);

  if (kind === "sales_invoice") {
    const id = String(body.id || "").trim();
    if (!id) return jsonResponse({ error: "id is required" }, 400);
    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("drive_file_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (token && data?.drive_file_id) await deleteFromDrive(token, data.drive_file_id);
    if (body.deleteRecord === true) {
      const { error: delError } = await supabaseAdmin.from("invoices").delete().eq("id", id);
      if (delError) throw new Error(delError.message);
    } else {
      await supabaseAdmin
        .from("invoices")
        .update({
          drive_file_id: null,
          drive_folder_id: null,
          drive_web_view_link: null,
          drive_file_name: null,
        })
        .eq("id", id);
    }
    return jsonResponse({ ok: true });
  }

  if (kind === "letter") {
    const id = String(body.id || "").trim();
    if (!id) return jsonResponse({ error: "id is required" }, 400);
    const { data, error } = await supabaseAdmin
      .from("letterhead_letters")
      .select("drive_file_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Letter not found");
    if (token && data.drive_file_id) await deleteFromDrive(token, data.drive_file_id);
    const { error: delError } = await supabaseAdmin.from("letterhead_letters").delete().eq("id", id);
    if (delError) throw new Error(delError.message);
    return jsonResponse({ ok: true });
  }

  const employeeId = String(body.employeeId || body.id || "").trim();
  if (!employeeId) return jsonResponse({ error: "employeeId is required" }, 400);
  const employee = await loadEmployee(employeeId);

  if (kind === "staff_photo") {
    if (token && employee.photo_drive_file_id) await deleteFromDrive(token, employee.photo_drive_file_id);
    const { error: updateError } = await supabaseAdmin
      .from("employees")
      .update({ photo_url: null, photo_drive_file_id: null })
      .eq("id", employeeId);
    if (updateError) throw new Error(updateError.message);
    return jsonResponse({ ok: true });
  }

  if (token && employee.aadhaar_drive_file_id) await deleteFromDrive(token, employee.aadhaar_drive_file_id);
  const { error: updateError } = await supabaseAdmin
    .from("employees")
    .update({ aadhaar_drive_file_id: null, aadhaar_file_name: null })
    .eq("id", employeeId);
  if (updateError) throw new Error(updateError.message);
  return jsonResponse({ ok: true });
}

function fileResponse(bytes: Uint8Array, mimeType: string, fileName: string) {
  return new Response(bytes, {
    headers: {
      ...corsHeaders,
      "Content-Type": mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName || "download"}"`,
    },
  });
}
