/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppError, escapeHtml, readDateRangeFromControls, createDateRangeFilter, getMonthRange, getLocalDateString, showProgress, hideProgress, PumpSettings, loadPumpSettings */

const MAX_INVOICE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

let currentAuth = null;
let driveConfigured = false;

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "invoices",
  });
  if (!auth) return;
  currentAuth = auth;
  applyRoleVisibility(auth.role);
  await loadPumpSettings(true);
  applyInvoicesBranding();

  const actionsHead = document.getElementById("invoice-actions-head");
  if (actionsHead) actionsHead.hidden = auth.role !== "admin";

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "upload", validSections: ["upload", "library"] });
  }

  const dateInput = document.getElementById("invoice-date");
  if (dateInput) dateInput.value = getLocalDateString();

  await refreshDriveStatus();
  bindUploadForm();
  initInvoiceFilter();
  loadInvoices();
});

function applyInvoicesBranding() {
  const name = PumpSettings.getStationDisplayName();
  document.querySelectorAll("header.topbar .brand a[href='dashboard.html']").forEach((a) => {
    a.textContent = name;
  });
  const subtitle = document.querySelector("header.topbar .page-subtitle")?.textContent?.trim();
  if (subtitle) document.title = `${subtitle} · ${name}`;
}

async function refreshDriveStatus() {
  const banner = document.getElementById("invoice-drive-banner");
  const uploadBtn = document.getElementById("invoice-upload-btn");
  if (!banner) return;

  try {
    const { data, error } = await supabaseClient.functions.invoke("invoice-documents", {
      body: { action: "status" },
    });
    if (error) throw error;
    driveConfigured = !!data?.configured;
    if (driveConfigured) {
      banner.classList.add("hidden");
      if (uploadBtn) uploadBtn.disabled = false;
      return;
    }
    banner.classList.remove("hidden");
    banner.className = "smart-alert smart-alert--warning";
    const parts = [];
    if (!data?.hasServiceAccount) {
      parts.push("Google service account is not configured on the server.");
    }
    if (!data?.rootFolderId) {
      parts.push("Root Google Drive folder ID is missing in Settings → Integrations.");
    }
    banner.innerHTML = `<span class="smart-alert-message">${escapeHtml(parts.join(" ") + (currentAuth?.role === "admin"
      ? " Configure it in Settings, then share the folder with the service account email."
      : " Ask an admin to configure Google Drive in Settings."))}</span>`;
    if (uploadBtn) uploadBtn.disabled = true;
  } catch (err) {
    driveConfigured = false;
    banner.classList.remove("hidden");
    banner.className = "smart-alert smart-alert--warning";
    banner.innerHTML = `<span class="smart-alert-message">Could not verify Google Drive setup. Upload may be unavailable.</span>`;
    if (uploadBtn) uploadBtn.disabled = true;
    AppError.report(err, { context: "invoiceDriveStatus" });
  }
}

function bindUploadForm() {
  const form = document.getElementById("invoice-upload-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const successEl = document.getElementById("invoice-upload-success");
    const errorEl = document.getElementById("invoice-upload-error");
    const submitBtn = document.getElementById("invoice-upload-btn");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");

    if (!driveConfigured) {
      if (errorEl) {
        errorEl.textContent = "Google Drive is not configured.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const fileInput = document.getElementById("invoice-file");
    const file = fileInput?.files?.[0];
    if (!file) {
      if (errorEl) {
        errorEl.textContent = "Select a file to upload.";
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (!ALLOWED_MIME.has(file.type)) {
      if (errorEl) {
        errorEl.textContent = "Allowed types: PDF, JPEG, PNG, WebP.";
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (file.size > MAX_INVOICE_BYTES) {
      if (errorEl) {
        errorEl.textContent = "File is too large (max 15 MB).";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    const formData = new FormData(form);
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Uploading…";
    }
    showProgress();

    try {
      const { data: sessionData } = await supabaseClient.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Session expired. Please log in again.");

      const cfg = window.__APP_CONFIG__ || {};
      const supabaseUrl = cfg.SUPABASE_URL || supabaseClient.supabaseUrl;
      const res = await fetch(`${supabaseUrl}/functions/v1/invoice-documents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: cfg.SUPABASE_ANON_KEY || supabaseClient.supabaseKey,
        },
        body: formData,
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `Upload failed (${res.status})`);
      }

      successEl?.classList.remove("hidden");
      form.reset();
      const dateInput = document.getElementById("invoice-date");
      if (dateInput) dateInput.value = getLocalDateString();
      if (fileInput) fileInput.value = "";
      loadInvoices();
    } catch (err) {
      AppError.report(err, { context: "invoiceUpload" });
      if (errorEl) {
        errorEl.textContent = err.message || "Upload failed.";
        errorEl.classList.remove("hidden");
      }
    } finally {
      hideProgress();
      if (submitBtn) {
        submitBtn.disabled = !driveConfigured;
        submitBtn.textContent = "Upload to Google Drive";
      }
    }
  });
}

function getInvoiceDateRange() {
  const rangeSelect = document.getElementById("invoice-range");
  const mode = rangeSelect?.value || "this-month";
  const today = new Date();

  if (mode === "this-year") {
    const y = today.getFullYear();
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }

  const range = readDateRangeFromControls(
    document.getElementById("invoice-range"),
    document.getElementById("invoice-start"),
    document.getElementById("invoice-end")
  );
  if (range) return { start: range.start, end: range.end };
  return getMonthRange(today.getFullYear(), today.getMonth());
}

function initInvoiceFilter() {
  createDateRangeFilter({
    storageKey: "invoices",
    ranges: ["this-month", "this-year", "custom"],
    defaultRange: "this-month",
    rangeSelect: "invoice-range",
    startInput: "invoice-start",
    endInput: "invoice-end",
    customRange: "invoice-custom-range",
    applyBtn: "invoice-apply-filter",
    trigger: "apply",
    persist: false,
    runOnInit: false,
    onApply: () => loadInvoices(),
  });
}

async function loadInvoices() {
  const tbody = document.getElementById("invoice-table-body");
  const emptyCta = document.getElementById("invoice-empty-cta");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  emptyCta?.classList.add("hidden");

  const { start, end } = getInvoiceDateRange();

  const { data, error } = await supabaseClient
    .from("invoice_documents")
    .select("id, invoice_date, year, month, title, vendor, amount, file_name, mime_type, drive_web_view_link, created_at")
    .gte("invoice_date", start)
    .lte("invoice_date", end)
    .order("invoice_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "";
    emptyCta?.classList.remove("hidden");
    return;
  }

  const isAdmin = currentAuth?.role === "admin";

  tbody.innerHTML = data.map((row) => {
    const folderLabel = `${row.year} / ${MONTH_NAMES[(row.month || 1) - 1] || row.month}`;
    const amountCell = row.amount != null ? formatCurrency(row.amount) : "—";
    const viewLink = row.drive_web_view_link
      ? `<a href="${escapeHtml(row.drive_web_view_link)}" target="_blank" rel="noopener noreferrer">View</a>`
      : "";
    const downloadBtn = `<button type="button" class="link invoice-download-btn" data-id="${escapeHtml(row.id)}">Download</button>`;
    const actions = isAdmin
      ? `<td class="table-actions"><button type="button" class="link danger invoice-delete-btn" data-id="${escapeHtml(row.id)}">Delete</button></td>`
      : "";

    return `<tr>
      <td>${escapeHtml(row.invoice_date)}<br><small class="muted">${escapeHtml(folderLabel)}</small></td>
      <td>${escapeHtml(row.vendor || "—")}</td>
      <td>${escapeHtml(row.title || "—")}</td>
      <td>${amountCell}</td>
      <td>${escapeHtml(row.file_name)} ${viewLink ? " · " + viewLink : ""} · ${downloadBtn}</td>
      ${actions}
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".invoice-download-btn").forEach((btn) => {
    btn.addEventListener("click", () => downloadInvoice(btn.dataset.id, btn));
  });
  tbody.querySelectorAll(".invoice-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteInvoice(btn.dataset.id));
  });
}

async function downloadInvoice(id, btn) {
  if (!id) return;
  const originalText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  showProgress();

  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) throw new Error("Session expired.");

    const cfg = window.__APP_CONFIG__ || {};
    const supabaseUrl = cfg.SUPABASE_URL || supabaseClient.supabaseUrl;
    const res = await fetch(`${supabaseUrl}/functions/v1/invoice-documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: cfg.SUPABASE_ANON_KEY || supabaseClient.supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "download", id }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Download failed (${res.status})`);
    }

    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const fileName = match?.[1] || "invoice";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    AppError.report(err, { context: "invoiceDownload" });
    alert(err.message || "Download failed.");
  } finally {
    hideProgress();
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || "Download";
    }
  }
}

async function deleteInvoice(id) {
  if (!id || currentAuth?.role !== "admin") return;
  if (!confirm("Delete this invoice from Google Drive and the app?")) return;

  showProgress();
  try {
    const { data, error } = await supabaseClient.functions.invoke("invoice-documents", {
      body: { action: "delete", id },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    loadInvoices();
  } catch (err) {
    AppError.report(err, { context: "invoiceDelete" });
    alert(err.message || "Delete failed.");
  } finally {
    hideProgress();
  }
}
