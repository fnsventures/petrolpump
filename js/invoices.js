/* global supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppError, escapeHtml, readDateRangeFromControls, createDateRangeFilter, getYearRange, getLocalDateString, showProgress, hideProgress, PumpSettings, loadPumpSettings, initPersistedDateInput, finishRecordFormSave, RECORD_DATE_KEYS */

const MAX_INVOICE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FALLBACK_DOCUMENT_CATEGORIES = [
  { value: "purchase", label: "Purchase invoices" },
  { value: "license", label: "License / permit" },
  { value: "insurance", label: "Insurance" },
  { value: "compliance", label: "Tax / compliance" },
  { value: "bank", label: "Bank / finance" },
  { value: "other", label: "Other" },
];
const INVOICE_LIST_COLUMNS =
  "id, invoice_date, year, month, category, title, vendor, amount, file_name, mime_type, drive_web_view_link, created_at";
const TABLE_COLSPAN = 7;

let currentAuth = null;
let driveConfigured = false;
let loadInvoicesController = null;
let documentCategoryLabelMap = Object.fromEntries(
  FALLBACK_DOCUMENT_CATEGORIES.map((c) => [c.value, c.label])
);

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin", "supervisor"],
    onDenied: "dashboard.html",
    pageName: "invoices",
  });
  if (!auth) return;
  currentAuth = auth;
  applyRoleVisibility(auth.role);
  await loadPumpSettings();
  applyInvoicesBranding();
  applyLocalDriveBanner();

  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "upload", validSections: ["upload", "library"] });
  }

  const dateInput = document.getElementById("invoice-date");
  if (dateInput) initPersistedDateInput(dateInput, RECORD_DATE_KEYS.invoiceUpload);

  initInvoiceFilter();
  bindUploadForm();
  bindInvoiceTableActions();

  await Promise.all([refreshDriveStatus(), loadDocumentCategories(), loadInvoices()]);
});

function getDocumentCategoryLabel(value) {
  return documentCategoryLabelMap[value] || value || "Other";
}

function fillSelectOptions(select, options, { selectedValue, placeholder } = {}) {
  if (!select) return;
  select.innerHTML = "";
  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = placeholder.value;
    opt.textContent = placeholder.label;
    select.appendChild(opt);
  }
  if (!options.length && !placeholder) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No types configured";
    select.appendChild(opt);
    return;
  }
  options.forEach((c, index) => {
    const opt = document.createElement("option");
    opt.value = c.value;
    opt.textContent = c.label;
    select.appendChild(opt);
    if (!selectedValue && !placeholder && index === 0) opt.selected = true;
  });
  if (selectedValue) select.value = selectedValue;
}

async function loadDocumentCategories() {
  const uploadSelect = document.getElementById("invoice-category");
  const filterSelect = document.getElementById("invoice-category-filter");
  const previousFilter = filterSelect?.value || "all";
  const previousUpload = uploadSelect?.value || "";

  const { data, error } = await supabaseClient
    .from("document_categories")
    .select("name, label")
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  let categories = [];
  if (!error && data?.length) {
    categories = data.map((row) => ({ value: row.name, label: row.label }));
  } else {
    if (error) AppError.report(error, { context: "loadDocumentCategories" });
    categories = FALLBACK_DOCUMENT_CATEGORIES.slice();
  }

  documentCategoryLabelMap = Object.fromEntries(categories.map((c) => [c.value, c.label]));

  fillSelectOptions(uploadSelect, categories, {
    selectedValue: categories.some((c) => c.value === previousUpload) ? previousUpload : "",
  });
  fillSelectOptions(filterSelect, categories, {
    selectedValue: categories.some((c) => c.value === previousFilter) ? previousFilter : "all",
    placeholder: { value: "all", label: "All types" },
  });
}

function applyInvoicesBranding() {
  const name = PumpSettings.getStationDisplayName();
  document.querySelectorAll("header.topbar .brand a[href='dashboard.html']").forEach((a) => {
    a.textContent = name;
  });
  const subtitle = document.querySelector("header.topbar .page-subtitle")?.textContent?.trim();
  if (subtitle) document.title = `${subtitle} · ${name}`;
}

function appConfig() {
  return window.__APP_CONFIG__ || {};
}

function getLocalDriveSettings() {
  const gd = PumpSettings.getCachedSync()?.integrations?.googleDrive;
  return {
    enabled: gd?.enabled === true,
    rootFolderId: (gd?.rootFolderId || "").trim() || null,
  };
}

function driveSetupHint() {
  return currentAuth?.role === "admin"
    ? "See Settings → Integrations for setup steps."
    : "Ask an admin to complete Google Drive setup.";
}

function applyLocalDriveBanner() {
  const local = getLocalDriveSettings();
  if (local.enabled && local.rootFolderId) return;

  const parts = [];
  if (!local.enabled) parts.push("Google Drive integration is disabled in Settings.");
  else if (!local.rootFolderId) parts.push("Root folder ID is missing in Settings → Integrations.");
  if (parts.length) setDriveBanner(`${parts.join(" ")} ${driveSetupHint()}`.trim());
}

async function getSessionToken() {
  const { data } = await supabaseClient.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Session expired. Please log in again.");
  return token;
}

function invoiceFunctionUrl() {
  const cfg = appConfig();
  return `${cfg.SUPABASE_URL || supabaseClient.supabaseUrl}/functions/v1/invoice-documents`;
}

async function invoiceFunctionHeaders(json = false) {
  const cfg = appConfig();
  const headers = {
    Authorization: `Bearer ${await getSessionToken()}`,
    apikey: cfg.SUPABASE_ANON_KEY || supabaseClient.supabaseKey,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function parseFunctionErrorResponse(res) {
  const errBody = await res.json().catch(() => ({}));
  return errBody.error || `Request failed (${res.status})`;
}

async function postInvoiceFunction(body, init = {}) {
  const res = await fetch(invoiceFunctionUrl(), {
    method: "POST",
    headers: await invoiceFunctionHeaders(true),
    body: JSON.stringify(body),
    ...init,
  });
  if (!res.ok) throw new Error(await parseFunctionErrorResponse(res));
  return res;
}

async function invokeInvoiceFunction(body) {
  const res = await postInvoiceFunction(body);
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}

function setDriveBanner(message, disableUpload = true) {
  const banner = document.getElementById("invoice-drive-banner");
  const uploadBtn = document.getElementById("invoice-upload-btn");
  if (!banner) return;
  banner.classList.remove("hidden");
  banner.className = "smart-alert smart-alert--warning";
  banner.innerHTML = `<span class="smart-alert-message">${escapeHtml(message)}</span>`;
  if (uploadBtn) uploadBtn.disabled = disableUpload;
}

function hideDriveBanner() {
  const banner = document.getElementById("invoice-drive-banner");
  const uploadBtn = document.getElementById("invoice-upload-btn");
  banner?.classList.add("hidden");
  if (uploadBtn) uploadBtn.disabled = false;
}

function buildDriveBannerMessage(data) {
  const parts = [];
  if (!data.hasOAuth && !data.hasServiceAccount) {
    parts.push("Google OAuth secrets are not configured on the server.");
  } else if (data.hasServiceAccount && !data.hasOAuth) {
    parts.push("Service accounts cannot upload to personal Gmail — add OAuth secrets in Supabase.");
  }
  if (!data.settingsEnabled) parts.push("Google Drive integration is disabled in Settings.");
  else if (!data.rootFolderId) parts.push("Root folder ID is missing in Settings → Integrations.");
  return `${parts.join(" ")} ${driveSetupHint()}`.trim();
}

async function refreshDriveStatus() {
  try {
    const data = await invokeInvoiceFunction({ action: "status" });

    if (data.authOk === false && data.authError) {
      driveConfigured = false;
      setDriveBanner(`Session error: ${data.authError} Log out and log in again.`);
      return;
    }

    driveConfigured = !!data.configured;
    if (driveConfigured) {
      hideDriveBanner();
      return;
    }

    setDriveBanner(buildDriveBannerMessage(data));
  } catch (err) {
    driveConfigured = false;
    AppError.report(err, { context: "invoiceDriveStatus" });
    const local = getLocalDriveSettings();
    if (!local.enabled || !local.rootFolderId) return;
    setDriveBanner(err.message || "Could not verify Google Drive setup.");
  }
}

function showFormError(errorEl, message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
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
      showFormError(errorEl, "Google Drive is not configured.");
      return;
    }

    const fileInput = document.getElementById("invoice-file");
    const file = fileInput?.files?.[0];
    if (!file) return showFormError(errorEl, "Select a file to upload.");
    if (!ALLOWED_MIME.has(file.type)) return showFormError(errorEl, "Allowed types: PDF, JPEG, PNG, WebP.");
    if (file.size > MAX_INVOICE_BYTES) return showFormError(errorEl, "File is too large (max 15 MB).");

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Uploading…";
    }
    showProgress();

    try {
      const res = await fetch(invoiceFunctionUrl(), {
        method: "POST",
        headers: await invoiceFunctionHeaders(false),
        body: new FormData(form),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Upload failed (${res.status})`);

      successEl?.classList.remove("hidden");
      const savedDate = document.getElementById("invoice-date")?.value;
      finishRecordFormSave(form, { invoiceDate: savedDate }, {
        invoiceDate: RECORD_DATE_KEYS.invoiceUpload,
      });
      if (fileInput) fileInput.value = "";
      loadInvoices();
    } catch (err) {
      AppError.report(err, { context: "invoiceUpload" });
      showFormError(errorEl, err.message || "Upload failed.");
    } finally {
      hideProgress();
      if (submitBtn) {
        submitBtn.disabled = !driveConfigured;
        submitBtn.textContent = "Upload document";
      }
    }
  });
}

function getInvoiceDateRange() {
  const range = readDateRangeFromControls(
    document.getElementById("invoice-range"),
    document.getElementById("invoice-start"),
    document.getElementById("invoice-end")
  );
  if (range) return { start: range.start, end: range.end };
  return getYearRange(new Date().getFullYear());
}

function initInvoiceFilter() {
  createDateRangeFilter({
    storageKey: "invoices",
    ranges: ["this-year", "last-year", "all-time"],
    defaultRange: "this-year",
    rangeSelect: "invoice-range",
    startInput: "invoice-start",
    endInput: "invoice-end",
    customRange: "invoice-custom-range",
    applyBtn: "invoice-apply-filter",
    trigger: "apply",
    runOnInit: false,
    onApply: () => loadInvoices(),
  });
}

async function loadInvoices() {
  const tbody = document.getElementById("invoice-table-body");
  const emptyCta = document.getElementById("invoice-empty-cta");
  const tableEl = tbody?.closest("table");
  if (!tbody) return;

  loadInvoicesController?.abort();
  const controller = new AbortController();
  loadInvoicesController = controller;

  tbody.innerHTML = `<tr><td colspan="${TABLE_COLSPAN}" class="muted">Loading…</td></tr>`;
  emptyCta?.classList.add("hidden");
  if (tableEl) tableEl.classList.remove("hidden");

  const { start, end } = getInvoiceDateRange();
  const categoryFilter = document.getElementById("invoice-category-filter")?.value || "all";
  let query = supabaseClient
    .from("invoice_documents")
    .select(INVOICE_LIST_COLUMNS)
    .order("invoice_date", { ascending: false })
    .order("created_at", { ascending: false })
    .abortSignal(controller.signal);
  if (start) query = query.gte("invoice_date", start);
  if (end) query = query.lte("invoice_date", end);
  if (categoryFilter !== "all") {
    query = query.eq("category", categoryFilter);
  }
  const { data, error } = await query;

  if (controller.signal.aborted) return;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="${TABLE_COLSPAN}" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = "";
    if (tableEl) tableEl.classList.add("hidden");
    emptyCta?.classList.remove("hidden");
    return;
  }

  const isAdmin = currentAuth?.role === "admin";
  tbody.innerHTML = data.map((row) => {
    const folderLabel = `${row.year} / ${MONTH_NAMES[(row.month || 1) - 1] || row.month}`;
    const viewBtn = row.drive_web_view_link
      ? `<button type="button" class="link" data-action="view" data-href="${escapeHtml(row.drive_web_view_link)}">View</button>`
      : "";
    const downloadBtn = `<button type="button" class="link" data-action="download" data-id="${escapeHtml(row.id)}">Download</button>`;
    const deleteBtn = isAdmin
      ? `<button type="button" class="link danger" data-action="delete" data-id="${escapeHtml(row.id)}">Delete</button>`
      : "";
    const actions = [viewBtn, downloadBtn, deleteBtn].filter(Boolean).join(" · ");

    const categoryLabel = getDocumentCategoryLabel(row.category);
    return `<tr>
      <td>${escapeHtml(row.invoice_date)}<br><small class="muted">${escapeHtml(folderLabel)}</small></td>
      <td>${escapeHtml(categoryLabel)}</td>
      <td>${escapeHtml(row.vendor || "—")}</td>
      <td>${escapeHtml(row.title || "—")}</td>
      <td>${row.amount != null ? formatCurrency(row.amount) : "—"}</td>
      <td>${escapeHtml(row.file_name)}</td>
      <td class="table-actions">${actions || "—"}</td>
    </tr>`;
  }).join("");
}

function bindInvoiceTableActions() {
  const tbody = document.getElementById("invoice-table-body");
  if (!tbody) return;

  tbody.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || !tbody.contains(btn)) return;

    const id = btn.dataset.id;
    if (btn.dataset.action === "view") {
      const href = btn.dataset.href;
      if (href) window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    if (btn.dataset.action === "download") await downloadInvoice(id, btn);
    if (btn.dataset.action === "delete") await deleteInvoice(id);
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
    const res = await postInvoiceFunction({ action: "download", id });
    const blob = await res.blob();
    const match = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
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
  if (!confirm("Delete this document from Google Drive and the app?")) return;

  showProgress();
  try {
    await invokeInvoiceFunction({ action: "delete", id });
    loadInvoices();
  } catch (err) {
    AppError.report(err, { context: "invoiceDelete" });
    alert(err.message || "Delete failed.");
  } finally {
    hideProgress();
  }
}
