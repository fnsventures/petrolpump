// Supabase Edge Function: drive-files
// Upload/download/delete sales invoices, letters, staff photos, and Aadhaar scans in Google Drive.

import {
  buildInvoicePdf,
  buildLetterPdf,
  buildStaffAttachmentPdf,
  canEmbedRaster,
} from "../_shared/archivePdf.ts";
import {
  buildDriveStatus,
  corsHeaders,
  deleteFromDrive,
  deleteNamedFilesInFolder,
  downloadFromDrive,
  ensureFolderPath,
  getDriveAccessToken,
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

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_AADHAAR_BYTES = 10 * 1024 * 1024;
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

    if (action === "archive") {
      const kind = parseKind(String(body.kind || "").trim());
      if (!kind) return jsonResponse({ error: "kind is required" }, 400);
      const auth = await verifyKindAuth(req, kind);
      if (kind === "sales_invoice") return handleSalesInvoiceArchive(String(body.invoiceId || ""));
      if (kind === "letter") return handleLetterArchive(String(body.letterId || ""), auth);
      return jsonResponse({ error: "kind does not support archive" }, 400);
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

async function handleSalesInvoiceUpload(_auth: AuthUser, form: FormData, _file: File) {
  const invoiceId = String(form.get("invoiceId") || "").trim();
  if (!invoiceId) return jsonResponse({ error: "invoiceId is required" }, 400);
  return handleSalesInvoiceArchive(invoiceId);
}

async function handleLetterUpload(auth: AuthUser, form: FormData, _file: File) {
  const letterDate = String(form.get("letterDate") || "").slice(0, 10);
  const parsed = parseIsoDate(letterDate);
  if (!parsed) return jsonResponse({ error: "letterDate is required (YYYY-MM-DD)" }, 400);
  const subjectRaw = String(form.get("subject") || "").trim();
  const body = String(form.get("body") || "");
  if (!subjectRaw && !body.trim()) return jsonResponse({ error: "Subject or body is required" }, 400);
  const subject = subjectRaw || "Letter";

  const exportTypeRaw = String(form.get("exportType") || "save").trim();
  const exportType = exportTypeRaw === "word" || exportTypeRaw === "print" || exportTypeRaw === "save"
    ? exportTypeRaw
    : "save";
  const includeSign = String(form.get("includeSign") || "true") !== "false";

  const { data: row, error: insertError } = await supabaseAdmin
    .from("letterhead_letters")
    .insert({
      letter_date: letterDate,
      subject,
      body,
      export_type: exportType,
      include_sign: includeSign,
      created_by: auth.userId,
    })
    .select("id")
    .single();
  if (insertError) throw new Error(insertError.message);
  return handleLetterArchive(String(row.id), auth);
}

async function handleSalesInvoiceArchive(invoiceIdRaw: string) {
  const invoiceId = invoiceIdRaw.trim();
  if (!invoiceId) return jsonResponse({ error: "invoiceId is required" }, 400);

  const [{ data: invoice, error: invError }, { data: items, error: itemsError }, settings] = await Promise.all([
    supabaseAdmin
      .from("invoices")
      .select(
        "id, invoice_number, invoice_date, invoice_type, party_name, party_address, party_gstin, vehicle_no, mobile, km_reading, subtotal, discount, round_off, total_amount, drive_file_id"
      )
      .eq("id", invoiceId)
      .maybeSingle(),
    supabaseAdmin
      .from("invoice_items")
      .select("sl_no, item_name, quantity, unit, rate, gst_percent, amount")
      .eq("invoice_id", invoiceId)
      .order("sl_no"),
    readPumpSettings(),
  ]);
  if (invError) throw new Error(invError.message);
  if (itemsError) throw new Error(itemsError.message);
  if (!invoice) throw new Error("Invoice not found");
  if (!settings.settingsEnabled || !settings.rootFolderId) {
    return jsonResponse({ ok: true, skipped: true, reason: "drive_disabled" });
  }
  if (invoice.drive_file_id) {
    return jsonResponse({ ok: true, skipped: true, file: { id: invoiceId, drive_file_id: invoice.drive_file_id } });
  }

  const invoiceDate = String(invoice.invoice_date || "").slice(0, 10);
  const parsed = parseIsoDate(invoiceDate);
  if (!parsed) return jsonResponse({ error: "invoice date is invalid" }, 400);

  const [token, pdfBytes] = await Promise.all([
    getDriveAccessToken(),
    buildInvoicePdf(invoice, items || [], settings.station),
  ]);
  const folderId = await ensureFolderPath(
    token,
    settings.rootFolderId,
    salesInvoiceFolderSegments(parsed.year, parsed.month)
  );
  const fallbackName = `${invoice.invoice_number || "invoice"} - ${invoice.party_name || "Cash"} - ${invoiceDate}.pdf`;
  const safeName = sanitizeFileName(fallbackName, `${invoiceDate}.pdf`);
  const { fileId, webViewLink } = await uploadToDrive(token, folderId, safeName, "application/pdf", pdfBytes, {
    makePublic: false,
  });

  const { data: claimed, error: updateError } = await supabaseAdmin
    .from("invoices")
    .update({
      drive_file_id: fileId,
      drive_folder_id: folderId,
      drive_web_view_link: webViewLink,
      drive_file_name: safeName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId)
    .is("drive_file_id", null)
    .select("drive_file_id")
    .maybeSingle();
  if (updateError) {
    await deleteFromDrive(token, fileId).catch(() => {});
    throw new Error(updateError.message);
  }
  if (!claimed) {
    await deleteFromDrive(token, fileId).catch(() => {});
    return jsonResponse({ ok: true, skipped: true, file: { id: invoiceId } });
  }

  return jsonResponse({
    ok: true,
    file: {
      id: invoiceId,
      kind: "sales_invoice",
      drive_file_id: fileId,
      drive_web_view_link: webViewLink,
      file_name: safeName,
    },
  });
}

async function handleLetterArchive(letterIdRaw: string, _auth: AuthUser) {
  const letterId = letterIdRaw.trim();
  if (!letterId) return jsonResponse({ error: "letterId is required" }, 400);

  const [{ data: letter, error: letterError }, settings] = await Promise.all([
    supabaseAdmin
      .from("letterhead_letters")
      .select("id, letter_date, subject, body, include_sign, drive_file_id")
      .eq("id", letterId)
      .maybeSingle(),
    readPumpSettings(),
  ]);
  if (letterError) throw new Error(letterError.message);
  if (!letter) throw new Error("Letter not found");
  if (!settings.settingsEnabled || !settings.rootFolderId) {
    return jsonResponse({ ok: true, skipped: true, reason: "drive_disabled" });
  }

  if (letter.drive_file_id) {
    return jsonResponse({
      ok: true,
      skipped: true,
      letter: { id: letterId, drive_file_id: letter.drive_file_id },
    });
  }

  if (!String(letter.body || "").trim()) {
    throw new Error("Letter text is missing");
  }

  const letterDate = String(letter.letter_date || "").slice(0, 10);
  const parsed = parseIsoDate(letterDate);
  if (!parsed) return jsonResponse({ error: "letter date is invalid" }, 400);

  const [token, pdfBytes] = await Promise.all([
    getDriveAccessToken(),
    buildLetterPdf(letter, settings.station),
  ]);
  const folderId = await ensureFolderPath(
    token,
    settings.rootFolderId,
    letterFolderSegments(parsed.year, parsed.month)
  );
  const fallbackName = `${letterDate} - ${letter.subject || "letter"}.pdf`;
  const safeName = sanitizeFileName(fallbackName, `${letterDate}.pdf`);
  const { fileId, webViewLink } = await uploadToDrive(token, folderId, safeName, "application/pdf", pdfBytes, {
    makePublic: false,
  });

  const { data: claimed, error: updateError } = await supabaseAdmin
    .from("letterhead_letters")
    .update({
      drive_file_id: fileId,
      drive_folder_id: folderId,
      drive_web_view_link: webViewLink,
      drive_file_name: safeName,
      mime_type: "application/pdf",
      body: "",
    })
    .eq("id", letterId)
    .is("drive_file_id", null)
    .select("drive_file_id")
    .maybeSingle();
  if (updateError) {
    await deleteFromDrive(token, fileId).catch(() => {});
    throw new Error(updateError.message);
  }
  if (!claimed) {
    await deleteFromDrive(token, fileId).catch(() => {});
    return jsonResponse({ ok: true, skipped: true, letter: { id: letterId } });
  }

  return jsonResponse({
    ok: true,
    letter: {
      id: letterId,
      drive_file_id: fileId,
      drive_web_view_link: webViewLink,
      drive_file_name: safeName,
    },
  });
}

const STAFF_PHOTO_PDF_NAME = "Photo (letterhead).pdf";
const STAFF_PHOTO_PDF_ALIASES = ["Photo (letterhead).pdf", "03 Photograph.pdf"];

async function deleteStaffPhotoPdfs(token: string, folderId: string) {
  for (const name of STAFF_PHOTO_PDF_ALIASES) {
    await deleteNamedFilesInFolder(token, folderId, name);
  }
}

async function archiveStaffPhotoPdf(
  token: string,
  folderId: string,
  station: Awaited<ReturnType<typeof readPumpSettings>>["station"],
  employeeName: string,
  imageBytes: Uint8Array,
  imageMime: string
) {
  await deleteStaffPhotoPdfs(token, folderId);
  if (!canEmbedRaster(imageMime)) return;
  try {
    const pdfBytes = await buildStaffAttachmentPdf(
      {
        title: "Staff photograph",
        personName: employeeName,
        caption: "ID-card photograph on station letterhead.",
        imageBytes,
        imageMime,
      },
      station
    );
    await uploadToDrive(token, folderId, STAFF_PHOTO_PDF_NAME, "application/pdf", pdfBytes, {
      makePublic: false,
    });
  } catch {
    // Keep the original photo even if the letterhead PDF cannot be built.
  }
}

async function handleStaffPhotoUpload(form: FormData, file: File) {
  const employeeId = String(form.get("employeeId") || "").trim();
  if (!employeeId) return jsonResponse({ error: "employeeId is required" }, 400);
  if (!PHOTO_MIME.has(file.type)) return jsonResponse({ error: "Use a JPG, PNG, or WebP image." }, 400);
  if (file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
    return jsonResponse({ error: "Image must be 2 MB or smaller." }, 400);
  }

  const employee = await loadEmployee(employeeId);
  const fileName = `Photo.${photoExtension(file.type)}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [token, settings] = await Promise.all([getDriveAccessToken(), readPumpSettings()]);
  if (!settings.settingsEnabled) throw new Error("Google Drive integration is disabled in Settings.");
  if (!settings.rootFolderId) throw new Error("Google Drive root folder ID is not configured in Settings.");
  const folderId = await ensureFolderPath(
    token,
    settings.rootFolderId,
    staffRecordFolderSegments(staffFolderName(employee.name, employee.id))
  );
  if (employee.photo_drive_file_id) {
    await deleteFromDrive(token, employee.photo_drive_file_id).catch(() => {});
  }
  const { fileId, webViewLink } = await uploadToDrive(token, folderId, fileName, file.type, bytes, {
    makePublic: true,
  });
  await archiveStaffPhotoPdf(token, folderId, settings.station, employee.name, bytes, file.type);
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
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const [token, settings] = await Promise.all([getDriveAccessToken(), readPumpSettings()]);
  if (!settings.settingsEnabled) throw new Error("Google Drive integration is disabled in Settings.");
  if (!settings.rootFolderId) throw new Error("Google Drive root folder ID is not configured in Settings.");
  const folderId = await ensureFolderPath(
    token,
    settings.rootFolderId,
    staffRecordFolderSegments(staffFolderName(employee.name, employee.id))
  );
  if (employee.aadhaar_drive_file_id) {
    await deleteFromDrive(token, employee.aadhaar_drive_file_id).catch(() => {});
  }

  let fileName = `Aadhaar.${aadhaarExtension(file.type, file.name)}`;
  let mimeType = file.type;
  let bytes = originalBytes;
  if (canEmbedRaster(file.type)) {
    try {
      bytes = await buildStaffAttachmentPdf(
        {
          title: "Aadhaar card",
          personName: employee.name,
          imageBytes: originalBytes,
          imageMime: file.type,
        },
        settings.station
      );
      mimeType = "application/pdf";
      fileName = "Aadhaar.pdf";
    } catch {
      bytes = originalBytes;
      mimeType = file.type;
    }
  }

  const { fileId } = await uploadToDrive(token, folderId, fileName, mimeType, bytes, {
    makePublic: false,
  });

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
      mimeType: "application/pdf",
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
  const fallbackName = kind === "staff_photo" ? "Photo.jpg" : employee.aadhaar_file_name || "Aadhaar.pdf";
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
    if (token) {
      const settings = await readPumpSettings().catch(() => null);
      if (settings?.rootFolderId) {
        const folderId = await ensureFolderPath(
          token,
          settings.rootFolderId,
          staffRecordFolderSegments(staffFolderName(employee.name, employee.id))
        ).catch(() => null);
        if (folderId) await deleteStaffPhotoPdfs(token, folderId);
      }
    }
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
  const safeName = String(fileName || "download").replace(/[\r\n"]/g, "").trim() || "download";
  return new Response(bytes, {
    headers: {
      ...corsHeaders,
      "Content-Type": mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Access-Control-Expose-Headers": "Content-Disposition, Content-Type",
    },
  });
}
