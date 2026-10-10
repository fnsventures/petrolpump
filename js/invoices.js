/* global window.supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, AppError, AppDialog, escapeHtml, readDateRangeFromControls, createDateRangeFilter, getYearRange, getLocalDateString, showProgress, hideProgress, ActionProgress, PumpSettings, loadPumpSettings, initPersistedDateInput, finishRecordFormSave, RECORD_DATE_KEYS, VaultDocuments */

const MAX_INVOICE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const FALLBACK_DOCUMENT_CATEGORIES = [
  { value: "purchase", label: "Purchase invoices" },
  { value: "license", label: "License / permit" },
  { value: "insurance", label: "Insurance" },
  { value: "compliance", label: "Tax / compliance" },
  { value: "bank", label: "Bank / finance" },
  { value: "other", label: "Other" },
];
const INVOICE_LIST_COLUMNS =
  "id, invoice_date, year, month, category, title, vendor, amount, file_name, mime_type, created_at";
const VAULT_OPEN_STORAGE_KEY = "vaultLibraryOpen";

let currentAuth = null;
let driveConfigured = false;
let vaultListController = null;
let vaultRows = [];
let vaultReady = false;
let documentCategories = FALLBACK_DOCUMENT_CATEGORIES.slice();
let documentCategoryLabelMap = Object.fromEntries(
  FALLBACK_DOCUMENT_CATEGORIES.map((c) => [c.value, c.label])
);

document.addEventListener("DOMContentLoaded", async () => {
  await window.configPromise;
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
  bindVaultLibraryControls();

  await Promise.all([refreshDriveStatus(), loadDocumentCategories(), loadVaultDocuments()]);
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

  const { data, error } = await window.supabaseClient
    .from("document_categories")
    .select("name, label")
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true })
    .limit(LOOKUP_ROW_LIMIT);

  let categories = [];
  if (!error && data?.length) {
    categories = data.map((row) => ({ value: row.name, label: row.label }));
  } else {
    if (error) AppError.report(error, { context: "loadDocumentCategories" });
    categories = FALLBACK_DOCUMENT_CATEGORIES.slice();
  }

  documentCategories = categories;
  documentCategoryLabelMap = Object.fromEntries(categories.map((c) => [c.value, c.label]));
  if (vaultReady) renderVaultLibrary();

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
  const { data } = await window.supabaseClient.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Session expired. Please log in again.");
  return token;
}

function invoiceFunctionUrl() {
  const cfg = appConfig();
  return `${cfg.SUPABASE_URL || window.supabaseClient.supabaseUrl}/functions/v1/invoice-documents`;
}

async function invoiceFunctionHeaders(json = false) {
  const cfg = appConfig();
  const headers = {
    Authorization: `Bearer ${await getSessionToken()}`,
    apikey: cfg.SUPABASE_ANON_KEY || window.supabaseClient.supabaseKey,
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
      VaultDocuments.revokePublicLinks().catch((err) => {
        AppError.report(err, { context: "revokeVaultPublicLinks" });
      });
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

function postInvoiceUpload(form, hooks) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", invoiceFunctionUrl());
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !event.total) return;
      hooks?.onSent(event.loaded / event.total);
    });
    xhr.upload.addEventListener("load", () => {
      hooks?.onBodySent();
    });
    xhr.addEventListener("load", () => {
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        payload = {};
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(payload.error || `Upload failed (${xhr.status})`));
        return;
      }
      resolve(payload);
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed. Check the connection and try again.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload was cancelled.")));
    invoiceFunctionHeaders(false)
      .then((headers) => {
        Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
        xhr.send(new FormData(form));
      })
      .catch(reject);
  });
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
    const progress = typeof ActionProgress !== "undefined" ? ActionProgress : null;
    progress?.start({
      title: "Uploading document",
      status: "Uploading to Google Drive…",
      timeoutMs: 180000,
    });

    try {
      await postInvoiceUpload(form, {
        onSent(ratio) {
          progress?.setPercent(ratio * 78);
        },
        onBodySent() {
          progress?.setPercent(null, "Saving on Google Drive…");
        },
      });

      await progress?.succeed("Uploaded");

      successEl?.classList.remove("hidden");
      const savedDate = document.getElementById("invoice-date")?.value;
      finishRecordFormSave(form, { invoiceDate: savedDate }, {
        invoiceDate: RECORD_DATE_KEYS.invoiceUpload,
      });
      if (fileInput) fileInput.value = "";
      loadVaultDocuments();
    } catch (err) {
      AppError.report(err, { context: "invoiceUpload" });
      showFormError(errorEl, err.message || "Upload failed.");
    } finally {
      progress?.close();
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
    onApply: () => loadVaultDocuments(),
  });
}

function vaultOpenStorageKey() {
  const range = document.getElementById("invoice-range")?.value || "this-year";
  const category = document.getElementById("invoice-category-filter")?.value || "all";
  return `${range}|${category}`;
}

function readOpenCategories() {
  try {
    const all = JSON.parse(sessionStorage.getItem(VAULT_OPEN_STORAGE_KEY) || "{}");
    const list = all[vaultOpenStorageKey()];
    return Array.isArray(list) ? new Set(list) : null;
  } catch {
    return null;
  }
}

function writeOpenCategories(openSet) {
  try {
    const all = JSON.parse(sessionStorage.getItem(VAULT_OPEN_STORAGE_KEY) || "{}");
    all[vaultOpenStorageKey()] = [...openSet];
    sessionStorage.setItem(VAULT_OPEN_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* Private mode can block sessionStorage. Groups still open for this render. */
  }
}

function vaultSearchQuery() {
  return (document.getElementById("invoice-search")?.value || "").trim();
}

function filterVaultRows(rows, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    const haystack = [
      row.invoice_date,
      row.vendor,
      row.title,
      row.file_name,
      getDocumentCategoryLabel(row.category),
      row.amount != null ? String(row.amount) : "",
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

function groupVaultDocuments(rows) {
  const order = new Map(documentCategories.map((category, index) => [category.value, index]));
  const groups = new Map();
  rows.forEach((row) => {
    const value = row.category || "";
    let group = groups.get(value);
    if (!group) {
      group = { value, label: getDocumentCategoryLabel(value), rows: [] };
      groups.set(value, group);
    }
    group.rows.push(row);
  });
  return [...groups.values()].sort((a, b) => {
    const aOrder = order.has(a.value) ? order.get(a.value) : Number.MAX_SAFE_INTEGER;
    const bOrder = order.has(b.value) ? order.get(b.value) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

function categoriesToOpen(groups) {
  const saved = readOpenCategories();
  if (saved) return saved;
  const filter = document.getElementById("invoice-category-filter")?.value || "all";
  if (filter !== "all" || groups.length === 1) return new Set(groups.map((group) => group.value));
  return new Set();
}

function groupAmountTotal(rows) {
  let total = 0;
  let hasAmount = false;
  rows.forEach((row) => {
    if (row.amount == null || row.amount === "") return;
    const amount = Number(row.amount);
    if (Number.isNaN(amount)) return;
    hasAmount = true;
    total += amount;
  });
  if (!hasAmount) return "";
  return formatCurrency(Math.round(total * 100) / 100);
}

function groupMeta(rows) {
  const latest = rows[0]?.invoice_date ? `Latest ${rows[0].invoice_date}` : "";
  const total = groupAmountTotal(rows);
  return [latest, total].filter(Boolean).join(" · ");
}

function librarySummary(groups, totalRows) {
  const docs = groups.reduce((count, group) => count + group.rows.length, 0);
  const docWord = docs === 1 ? "document" : "documents";
  const typeWord = groups.length === 1 ? "type" : "types";
  const base = `${docs} ${docWord} in ${groups.length} ${typeWord}`;
  if (totalRows != null && docs !== totalRows) return `${base}, filtered from ${totalRows}`;
  return base;
}

function renderVaultDocumentRow(row, isAdmin) {
  const title = (row.title || "").trim();
  const fileName = row.file_name || "";
  const showFile = title && title !== fileName;
  const viewBtn = `<button type="button" class="button-secondary button-small" data-action="view" data-id="${escapeHtml(row.id)}">View</button>`;
  const downloadBtn = `<button type="button" class="button-secondary button-small" data-action="download" data-id="${escapeHtml(row.id)}">Download</button>`;
  const deleteBtn = isAdmin
    ? `<button type="button" class="button-delete button-small" data-action="delete" data-id="${escapeHtml(row.id)}">Delete</button>`
    : "";
  const actions = [viewBtn, downloadBtn, deleteBtn].filter(Boolean).join("");
  return `<tr>
    <td data-label="Date">${escapeHtml(row.invoice_date)}</td>
    <td data-label="From">${escapeHtml(row.vendor || "—")}</td>
    <td>
      <div class="vault-doc">
        <span class="vault-doc-title">${escapeHtml(title || fileName || "—")}</span>
        ${showFile ? `<span class="vault-doc-file">${escapeHtml(fileName)}</span>` : ""}
      </div>
    </td>
    <td class="vault-amount" data-label="Amount">${row.amount != null ? formatCurrency(row.amount) : "—"}</td>
    <td class="table-actions"><div class="vault-row-actions">${actions || "—"}</div></td>
  </tr>`;
}

function renderVaultGroup(group, isOpen, isAdmin) {
  const noun = group.rows.length === 1 ? "document" : "documents";
  const meta = groupMeta(group.rows);
  return `<details class="vault-group" data-category="${escapeHtml(group.value)}"${isOpen ? " open" : ""}>
    <summary>
      <span class="vault-group-text">
        <span class="vault-group-title">${escapeHtml(group.label)}</span>
        ${meta ? `<span class="vault-group-meta">${escapeHtml(meta)}</span>` : ""}
      </span>
      <span class="vault-count">${group.rows.length}<span class="sr-only"> ${noun}</span></span>
    </summary>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>From</th>
            <th>Document</th>
            <th class="vault-amount">Amount (₹)</th>
            <th class="table-actions">Action</th>
          </tr>
        </thead>
        <tbody>
          ${group.rows.map((row) => renderVaultDocumentRow(row, isAdmin)).join("")}
        </tbody>
      </table>
    </div>
  </details>`;
}

function setVaultExpandDisabled(disabled) {
  ["vault-expand-all", "vault-collapse-all"].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  });
}

function showVaultEmpty(message, hint) {
  const empty = document.getElementById("invoice-empty-cta");
  const messageEl = document.getElementById("invoice-empty-message");
  const hintEl = document.getElementById("invoice-empty-hint");
  if (messageEl) messageEl.textContent = message;
  if (hintEl) {
    hintEl.textContent = hint;
    hintEl.classList.toggle("hidden", !hint);
  }
  empty?.classList.remove("hidden");
}

function renderVaultLibrary() {
  const bar = document.getElementById("vault-library-bar");
  const summary = document.getElementById("invoice-library-summary");
  const groupsEl = document.getElementById("invoice-groups");
  const empty = document.getElementById("invoice-empty-cta");
  if (!groupsEl) return;

  empty?.classList.add("hidden");
  const query = vaultSearchQuery();

  if (!vaultRows.length) {
    bar?.classList.add("hidden");
    groupsEl.innerHTML = "";
    if (summary) summary.textContent = "";
    setVaultExpandDisabled(true);
    showVaultEmpty(
      "No documents found for this period.",
      "Upload a document from the Upload document section."
    );
    return;
  }

  bar?.classList.remove("hidden");
  const matched = filterVaultRows(vaultRows, query);
  if (!matched.length) {
    groupsEl.innerHTML = "";
    if (summary) summary.textContent = `No documents match “${query}”.`;
    setVaultExpandDisabled(true);
    return;
  }

  const groups = groupVaultDocuments(matched);
  const searching = query.length > 0;
  const openSet = searching ? new Set(groups.map((group) => group.value)) : categoriesToOpen(groups);
  const isAdmin = currentAuth?.role === "admin";
  if (summary) summary.textContent = librarySummary(groups, vaultRows.length);
  groupsEl.innerHTML = groups
    .map((group) => renderVaultGroup(group, openSet.has(group.value), isAdmin))
    .join("");
  setVaultExpandDisabled(false);
}

function setLibraryLoading() {
  const bar = document.getElementById("vault-library-bar");
  const summary = document.getElementById("invoice-library-summary");
  const groupsEl = document.getElementById("invoice-groups");
  const empty = document.getElementById("invoice-empty-cta");
  vaultReady = false;
  bar?.classList.add("hidden");
  empty?.classList.add("hidden");
  if (groupsEl) groupsEl.innerHTML = "";
  if (summary) {
    summary.textContent = "Loading…";
    summary.classList.remove("error");
  }
  setVaultExpandDisabled(true);
}

function setLibraryError(message) {
  const summary = document.getElementById("invoice-library-summary");
  const groupsEl = document.getElementById("invoice-groups");
  vaultRows = [];
  vaultReady = false;
  if (groupsEl) groupsEl.innerHTML = "";
  if (summary) {
    summary.textContent = message;
    summary.classList.add("error");
  }
  setVaultExpandDisabled(true);
}

async function loadVaultDocuments() {
  const groupsEl = document.getElementById("invoice-groups");
  if (!groupsEl) return;

  vaultListController?.abort();
  const controller = new AbortController();
  vaultListController = controller;
  setLibraryLoading();

  const { start, end } = getInvoiceDateRange();
  const categoryFilter = document.getElementById("invoice-category-filter")?.value || "all";
  const { data, error } = await fetchAllRows(() => {
    let query = window.supabaseClient
      .from("invoice_documents")
      .select(INVOICE_LIST_COLUMNS)
      .order("invoice_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .abortSignal(controller.signal);
    if (start) query = query.gte("invoice_date", start);
    if (end) query = query.lte("invoice_date", end);
    if (categoryFilter !== "all") query = query.eq("category", categoryFilter);
    return query;
  });

  if (controller.signal.aborted) return;

  if (error) {
    setLibraryError(AppError.getUserMessage(error));
    return;
  }

  vaultRows = data || [];
  vaultReady = true;
  const summary = document.getElementById("invoice-library-summary");
  summary?.classList.remove("error");
  renderVaultLibrary();
}

function setAllVaultGroupsOpen(open) {
  const searching = vaultSearchQuery().length > 0;
  const saved = readOpenCategories() ?? new Set();
  document.querySelectorAll("#invoice-groups details.vault-group").forEach((details) => {
    details.open = open;
    if (searching) return;
    const key = details.dataset.category ?? "";
    if (open) saved.add(key);
    else saved.delete(key);
  });
  if (!searching) writeOpenCategories(saved);
}

function bindVaultLibraryControls() {
  const groupsEl = document.getElementById("invoice-groups");
  groupsEl?.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("vault-group")) return;
    if (vaultSearchQuery()) return;
    const saved = readOpenCategories() ?? new Set();
    const key = details.dataset.category ?? "";
    if (details.open) saved.add(key);
    else saved.delete(key);
    writeOpenCategories(saved);
  }, true);

  document.getElementById("invoice-search")?.addEventListener("input", () => {
    if (vaultReady) renderVaultLibrary();
  });
  document.getElementById("vault-expand-all")?.addEventListener("click", () => setAllVaultGroupsOpen(true));
  document.getElementById("vault-collapse-all")?.addEventListener("click", () => setAllVaultGroupsOpen(false));
}

function bindInvoiceTableActions() {
  const groupsEl = document.getElementById("invoice-groups");
  if (!groupsEl) return;

  groupsEl.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || !groupsEl.contains(btn)) return;

    const id = btn.dataset.id;
    if (btn.dataset.action === "view") {
      const preview = window.open("", "_blank");
      try {
        await VaultDocuments.open(id, { previewWindow: preview });
      } catch (err) {
        AppError.report(err, { context: "invoiceView" });
        AppError.showToast(err.message || "Could not open the document.", "error");
      }
      return;
    }
    if (btn.dataset.action === "download") await downloadInvoice(id, btn);
    if (btn.dataset.action === "delete") await deleteVaultDocument(id);
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
    AppError.showToast(err.message || "Download failed.", "error");
  } finally {
    hideProgress();
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || "Download";
    }
  }
}

async function deleteVaultDocument(id) {
  if (!id || currentAuth?.role !== "admin") return;
  if (!(await AppDialog.confirm("Delete this document from Google Drive and the app?", { title: "Delete document", confirmLabel: "Delete", danger: true }))) return;

  try {
    await ActionProgress.track(
      {
        title: "Deleting",
        status: "Removing from Google Drive…",
        doneStatus: "Deleted",
      },
      async () => {
        await invokeInvoiceFunction({ action: "delete", id });
        loadVaultDocuments();
      }
    );
  } catch (err) {
    AppError.report(err, { context: "invoiceDelete" });
    AppError.showToast(err.message || "Delete failed.", "error");
  }
}

bindLiveRefresh(() => {
  vaultListController?.abort();
  void loadVaultDocuments();
}, { match: () => Boolean(document.getElementById("invoice-groups")) });
