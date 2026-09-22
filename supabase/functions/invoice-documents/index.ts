// Supabase Edge Function: invoice-documents
// Upload, download, and delete vault documents (purchase invoices + other pump files) in Google Drive.

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
  parseIsoDate,
  readPumpSettings,
  sanitizeFileName,
  supabaseAdmin,
  uploadToDrive,
  vaultDocumentFolderSegments,
  verifyPageAccess,
} from "../_shared/googleDrive.ts";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function getInvoiceDocument(id: string, columns: string) {
  const { data, error } = await supabaseAdmin.from("invoice_documents").select(columns).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Document not found");
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const auth = await verifyPageAccess(req, "invoices");
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return jsonResponse({ error: "file is required" }, 400);

      const invoiceDate = String(form.get("invoiceDate") || "").slice(0, 10);
      const parsed = parseIsoDate(invoiceDate);
      if (!parsed) {
        return jsonResponse({ error: "invoiceDate is required (YYYY-MM-DD)" }, 400);
      }
      const category = String(form.get("category") || "purchase").trim().toLowerCase();
      const { data: categoryRow, error: categoryError } = await supabaseAdmin
        .from("document_categories")
        .select("name, label, folder_layout")
        .eq("name", category)
        .maybeSingle();
      if (categoryError) {
        console.error("document category lookup failed", categoryError);
        return jsonResponse({ error: "Could not validate document type" }, 500);
      }
      if (!categoryRow) {
        return jsonResponse({ error: "Invalid document type" }, 400);
      }
      if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
        return jsonResponse({ error: `File must be between 1 byte and ${MAX_FILE_BYTES / (1024 * 1024)} MB` }, 400);
      }
      if (!ALLOWED_MIME.has(file.type)) {
        return jsonResponse({ error: "Allowed types: PDF, JPEG, PNG, WebP" }, 400);
      }

      const { year, month } = parsed;
      const amountRaw = String(form.get("amount") || "").trim();
      const amount = amountRaw ? Number(amountRaw) : null;
      const safeName = sanitizeFileName(file.name, "document");
      const categoryLabel = String(categoryRow.label || category);

      const bytesPromise = file.arrayBuffer();
      const [token, rootFolderId] = await Promise.all([
        getDriveAccessToken(),
        getDriveConfig(),
      ]);
      const folderId = await ensureFolderPath(
        token,
        rootFolderId,
        vaultDocumentFolderSegments(category, categoryLabel, year, month)
      );
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
          category,
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
        .select("id, invoice_date, year, month, category, title, vendor, amount, file_name, mime_type, file_size, drive_web_view_link, created_at")
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
        verifyPageAccess(req, "invoices")
          .then(() => ({ authOk: true as const, authError: null as string | null }))
          .catch((err) => ({
            authOk: false as const,
            authError: err instanceof Error ? err.message : "Auth failed",
          })),
      ]);
      return jsonResponse({ ...buildDriveStatus(settings), ...authResult });
    }

    const auth = await verifyPageAccess(req, "invoices");

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
