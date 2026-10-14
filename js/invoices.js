/* global window.supabaseClient, requireAuth, applyRoleVisibility, formatCurrency, formatNumericDate, AppError, AppDialog, escapeHtml, escapeIlikePattern, readDateRangeFromControls, createDateRangeFilter, getYearRange, getLocalDateString, showProgress, hideProgress, ActionProgress, PumpSettings, loadPumpSettings, initPersistedDateInput, finishRecordFormSave, RECORD_DATE_KEYS, VaultDocuments, DrivePreview, debounce, preloadPdfPreview, fetchAllRows */

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
let vaultGroups = [];
let vaultPeriodCount = 0;
let vaultSeq = 0;
let suppressVaultToggle = 0;
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
  const footerYear = document.getElementById("invoice-footer-year");
  if (footerYear) footerYear.textContent = String(new Date().getFullYear());
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

  await Promise.all([refreshDriveStatus(), loadDocumentCategories()]);
  await loadVaultDocuments();
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
  if (vaultReady) {
    vaultGroups.forEach((group) => {
      group.label = getDocumentCategoryLabel(group.value);
    });
    sortVaultGroups(vaultGroups);
    renderVaultLibrary();
  }

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
      await loadVaultDocuments();
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

function getVaultDateRange() {
  const range = readDateRangeFromControls(document.getElementById("invoice-range"), null, null);
  if (range) return { start: range.start, end: range.end };
  return getYearRange(new Date().getFullYear());
}

function initInvoiceFilter() {
  createDateRangeFilter({
    storageKey: "invoices",
    ranges: ["this-year", "last-year", "all-time"],
    defaultRange: "this-year",
    rangeSelect: "invoice-range",
    trigger: "auto",
    runOnInit: false,
    onApply: () => loadVaultDocuments(),
  });
}

function vaultPeriodLabel() {
  const value = document.getElementById("invoice-range")?.value || "this-year";
  if (value === "last-year") return "Last year";
  if (value === "all-time") return "All time";
  return "This year";
}

function isAbortError(err) {
  const name = err?.name || "";
  const message = err?.message || "";
  return name === "AbortError" || /abort/i.test(message);
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

function sortVaultGroups(groups) {
  const order = new Map(documentCategories.map((category, index) => [category.value, index]));
  groups.sort((a, b) => {
    const aOrder = order.has(a.value) ? order.get(a.value) : Number.MAX_SAFE_INTEGER;
    const bOrder = order.has(b.value) ? order.get(b.value) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  return groups;
}

function groupVaultDocuments(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const value = row.category || "";
    let group = groups.get(value);
    if (!group) {
      group = {
        value,
        label: getDocumentCategoryLabel(value),
        rows: [],
        count: 0,
        latest: "",
        loading: false,
        error: "",
      };
      groups.set(value, group);
    }
    group.rows.push(row);
  });
  groups.forEach((group) => {
    group.count = group.rows.length;
    group.latest = group.rows[0]?.invoice_date || "";
  });
  return sortVaultGroups([...groups.values()]);
}

function categoriesToOpen(groups) {
  const saved = readOpenCategories();
  if (saved) return saved;
  if (!groups.length) return new Set();
  const filter = document.getElementById("invoice-category-filter")?.value || "all";
  if (filter !== "all" || groups.length === 1) return new Set(groups.map((group) => group.value));
  return new Set([groups[0].value]);
}

function findVaultRow(id) {
  for (const group of vaultGroups) {
    const hit = group.rows?.find((row) => row.id === id);
    if (hit) return hit;
  }
  return null;
}

function findGroupDetails(value) {
  return [...document.querySelectorAll("#invoice-groups details.vault-group")].find(
    (el) => el.dataset.category === value
  );
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
  const latest = rows[0]?.invoice_date ? `Latest ${formatNumericDate(rows[0].invoice_date)}` : "";
  const total = groupAmountTotal(rows);
  return [latest, total].filter(Boolean).join(" · ");
}

function groupHeadingMeta(group) {
  if (group.rows) return groupMeta(group.rows);
  return group.latest ? `Latest ${formatNumericDate(group.latest)}` : "";
}

function librarySummary(groups) {
  const docs = groups.reduce((count, group) => count + (group.count || 0), 0);
  const docWord = docs === 1 ? "document" : "documents";
  const typeWord = groups.length === 1 ? "type" : "types";
  const base = `${docs} ${docWord} in ${groups.length} ${typeWord}`;
  const searching = vaultSearchQuery().length > 0;
  const line = searching && vaultPeriodCount > 0 && docs !== vaultPeriodCount
    ? `${base}, filtered from ${vaultPeriodCount}`
    : base;
  return `${line} · ${vaultPeriodLabel()}`;
}

const VAULT_UPLOAD_HINT = 'Upload a document from the <a href="#upload">Upload document section</a>.';

function renderVaultDocumentRow(row, isAdmin) {
  const title = (row.title || "").trim();
  const fileName = row.file_name || "";
  const showFile = title && title !== fileName;
  const viewBtn = `<button type="button" class="button-secondary button-small" data-action="view" data-id="${escapeHtml(row.id)}">View</button>`;
  const downloadBtn = `<button type="button" class="button-secondary button-small" data-action="download" data-id="${escapeHtml(row.id)}">Download</button>`;
  const deleteBtn = isAdmin
    ? `<button type="button" class="button-delete button-small" data-action="delete" data-id="${escapeHtml(row.id)}" data-title="${escapeHtml(title || fileName || "")}" data-vendor="${escapeHtml(row.vendor || "")}" data-date="${escapeHtml(row.invoice_date || "")}" data-file="${escapeHtml(fileName)}">Delete</button>`
    : "";
  const actions = [viewBtn, downloadBtn, deleteBtn].filter(Boolean).join("");
  return `<tr>
    <td data-label="Date">${formatNumericDate(row.invoice_date)}</td>
    <td data-label="From">${escapeHtml(row.vendor || "—")}</td>
    <td data-label="Document">
      <div class="vault-doc">
        <span class="vault-doc-title">${escapeHtml(title || fileName || "—")}</span>
        ${showFile ? `<span class="vault-doc-file">${escapeHtml(fileName)}</span>` : ""}
      </div>
    </td>
    <td class="vault-amount" data-label="Amount">${row.amount != null ? formatCurrency(row.amount) : "—"}</td>
    <td class="table-actions" data-label="Action"><div class="drive-row-actions">${actions || "—"}</div></td>
  </tr>`;
}

function vaultTableHtml(group, isAdmin) {
  if (!group.rows?.length) return `<p class="muted vault-group-loading">No documents in this type.</p>`;
  return `<div class="table-wrap">
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
    </div>`;
}

function groupSlotHtml(group, isOpen, isAdmin) {
  if (group.rows) return vaultTableHtml(group, isAdmin);
  if (group.error) {
    return `<p class="error vault-group-loading">${escapeHtml(group.error)} <button type="button" class="button-secondary button-small" data-vault-retry="${escapeHtml(group.value)}">Retry</button></p>`;
  }
  if (isOpen || group.loading) return `<p class="muted vault-group-loading">Loading…</p>`;
  return "";
}

function renderVaultGroup(group, isOpen, isAdmin) {
  const count = group.count ?? group.rows?.length ?? 0;
  const noun = count === 1 ? "document" : "documents";
  const meta = groupHeadingMeta(group);
  return `<details class="vault-group" data-category="${escapeHtml(group.value)}"${isOpen ? " open" : ""}>
    <summary>
      <span class="vault-group-text">
        <span class="vault-group-title">${escapeHtml(group.label)}</span>
        ${meta ? `<span class="vault-group-meta">${escapeHtml(meta)}</span>` : `<span class="vault-group-meta" hidden></span>`}
      </span>
      <span class="vault-count"><span class="vault-count-num">${count}</span><span class="sr-only"> ${noun}</span></span>
    </summary>
    <div data-vault-slot>${groupSlotHtml(group, isOpen, isAdmin)}</div>
  </details>`;
}

function fillGroupBody(group) {
  const details = findGroupDetails(group.value);
  if (!details) return;
  const slot = details.querySelector("[data-vault-slot]");
  if (slot) slot.innerHTML = groupSlotHtml(group, details.open, currentAuth?.role === "admin");
  const metaEl = details.querySelector(".vault-group-meta");
  const meta = groupHeadingMeta(group);
  if (metaEl) {
    metaEl.textContent = meta;
    metaEl.hidden = !meta;
  }
  const countEl = details.querySelector(".vault-count-num");
  if (countEl && group.rows) countEl.textContent = String(group.rows.length);
}

function setVaultExpandDisabled(disabled) {
  ["vault-expand-all", "vault-collapse-all"].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  });
}

function showVaultEmpty() {
  const empty = document.getElementById("invoice-empty-cta");
  const messageEl = document.getElementById("invoice-empty-message");
  const hintEl = document.getElementById("invoice-empty-hint");
  const period = vaultPeriodLabel().toLowerCase();
  if (messageEl) {
    messageEl.textContent = period === "all time" ? "No documents found." : `No documents found for ${period}.`;
  }
  if (hintEl) {
    hintEl.innerHTML = VAULT_UPLOAD_HINT;
    hintEl.classList.remove("hidden");
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
  summary?.classList.remove("error");

  if (!vaultGroups.length) {
    groupsEl.innerHTML = "";
    setVaultExpandDisabled(true);
    if (query) {
      bar?.classList.remove("hidden");
      if (summary) summary.textContent = `No documents match “${query}”.`;
      return;
    }
    bar?.classList.add("hidden");
    if (summary) summary.textContent = "";
    showVaultEmpty();
    return;
  }

  bar?.classList.remove("hidden");
  const searching = query.length > 0;
  const openSet = searching ? new Set(vaultGroups.map((group) => group.value)) : categoriesToOpen(vaultGroups);
  const isAdmin = currentAuth?.role === "admin";
  if (summary) summary.textContent = librarySummary(vaultGroups);
  groupsEl.innerHTML = vaultGroups
    .map((group) => renderVaultGroup(group, openSet.has(group.value), isAdmin))
    .join("");
  setVaultExpandDisabled(false);
  vaultGroups.forEach((group) => {
    if (openSet.has(group.value) && !group.rows && !group.loading) void ensureGroupRows(group.value);
  });
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
  vaultGroups = [];
  vaultReady = false;
  if (groupsEl) {
    groupsEl.innerHTML = `<p><button type="button" class="button-secondary button-small" id="vault-library-retry">Retry</button></p>`;
  }
  if (summary) {
    summary.textContent = message;
    summary.classList.add("error");
  }
  setVaultExpandDisabled(true);
}

function filteredListQuery(signal, categoryValue) {
  const { start, end } = getVaultDateRange();
  let query = window.supabaseClient.from("invoice_documents").select(INVOICE_LIST_COLUMNS);
  if (start) query = query.gte("invoice_date", start);
  if (end) query = query.lte("invoice_date", end);
  const selected = document.getElementById("invoice-category-filter")?.value || "all";
  const category = categoryValue || (selected !== "all" ? selected : "");
  if (category) query = query.eq("category", category);
  if (signal) query = query.abortSignal(signal);
  return query;
}

function orderedListQuery(query) {
  return query
    .order("invoice_date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });
}

function listQuery(signal, categoryValue) {
  return orderedListQuery(filteredListQuery(signal, categoryValue));
}

function searchQuery(signal, raw) {
  const needle = escapeIlikePattern(raw).replace(/"/g, "");
  const orFilter = ["title", "vendor", "file_name"].map((col) => `${col}.ilike."%${needle}%"`).join(",");
  return orderedListQuery(filteredListQuery(signal).or(orFilter));
}

async function fetchCategoryCount(category, signal) {
  const { start, end } = getVaultDateRange();
  let query = window.supabaseClient
    .from("invoice_documents")
    .select("invoice_date", { count: "exact" })
    .eq("category", category.value)
    .order("invoice_date", { ascending: false })
    .limit(1)
    .abortSignal(signal);
  if (start) query = query.gte("invoice_date", start);
  if (end) query = query.lte("invoice_date", end);
  const { data, error, count } = await query;
  if (error) {
    const err = new Error(error.message || "Could not load documents.");
    err.code = error.code;
    throw err;
  }
  return {
    value: category.value,
    label: category.label,
    count: count || 0,
    latest: data?.[0]?.invoice_date || "",
    rows: null,
    loading: false,
    error: "",
  };
}

async function loadVaultOutline(seq, controller) {
  const filter = document.getElementById("invoice-category-filter")?.value || "all";
  const categories = filter === "all"
    ? documentCategories
    : documentCategories.filter((category) => category.value === filter);
  const summaries = await Promise.all(
    categories.map((category) => fetchCategoryCount(category, controller.signal))
  );
  if (seq !== vaultSeq || controller.signal.aborted) return;
  vaultGroups = sortVaultGroups(summaries.filter((group) => group.count > 0));
  vaultPeriodCount = vaultGroups.reduce((sum, group) => sum + group.count, 0);
  vaultReady = true;
  renderVaultLibrary();
}

async function loadVaultSearch(seq, controller, raw) {
  const { data, error } = await fetchAllRows(() => searchQuery(controller.signal, raw));
  if (seq !== vaultSeq || controller.signal.aborted) return;
  if (error) {
    if (isAbortError(error)) return;
    const err = new Error(error.message || "Could not search documents.");
    err.code = error.code;
    throw err;
  }
  vaultGroups = groupVaultDocuments(data || []);
  vaultReady = true;
  renderVaultLibrary();
}

async function loadVaultDocuments(options = {}) {
  const groupsEl = document.getElementById("invoice-groups");
  if (!groupsEl) return;

  const soft = options.soft === true;
  const seq = ++vaultSeq;
  vaultListController?.abort();
  const controller = new AbortController();
  vaultListController = controller;
  if (!soft) {
    vaultPeriodCount = 0;
    vaultGroups = [];
    setLibraryLoading();
  } else {
    const summary = document.getElementById("invoice-library-summary");
    if (summary) {
      summary.textContent = "Loading…";
      summary.classList.remove("error");
    }
  }

  try {
    const query = vaultSearchQuery();
    if (query) await loadVaultSearch(seq, controller, query);
    else await loadVaultOutline(seq, controller);
  } catch (err) {
    if (seq !== vaultSeq || controller.signal.aborted || isAbortError(err)) return;
    setLibraryError(AppError.getUserMessage(err));
    AppError.report(err, { context: "loadVaultDocuments" });
  }
}

async function ensureGroupRows(value) {
  const group = vaultGroups.find((item) => item.value === value);
  if (!group || group.rows || group.loading) return;
  const controller = vaultListController;
  if (!controller || controller.signal.aborted) return;
  const seq = vaultSeq;
  group.loading = true;
  group.error = "";
  fillGroupBody(group);
  try {
    const { data, error } = await fetchAllRows(() => listQuery(controller.signal, group.value));
    if (seq !== vaultSeq || controller.signal.aborted) return;
    group.loading = false;
    if (error) {
      if (isAbortError(error)) return;
      group.error = AppError.getUserMessage(error);
      fillGroupBody(group);
      return;
    }
    group.rows = data || [];
    group.count = group.rows.length;
    group.latest = group.rows[0]?.invoice_date || group.latest;
    fillGroupBody(group);
  } catch (err) {
    if (seq !== vaultSeq || controller.signal.aborted || isAbortError(err)) return;
    group.loading = false;
    group.error = AppError.getUserMessage(err);
    fillGroupBody(group);
  }
}

async function loadAllGroupRows() {
  if (vaultGroups.every((group) => Array.isArray(group.rows))) {
    vaultGroups.forEach((group) => fillGroupBody(group));
    return;
  }
  const controller = vaultListController;
  if (!controller || controller.signal.aborted) return;
  const seq = vaultSeq;
  vaultGroups.forEach((group) => {
    if (!group.rows) group.loading = true;
  });
  try {
    const { data, error } = await fetchAllRows(() => listQuery(controller.signal));
    if (seq !== vaultSeq || controller.signal.aborted) return;
    if (error) {
      if (isAbortError(error)) return;
      const err = new Error(error.message || "Could not load documents.");
      err.code = error.code;
      throw err;
    }
    const byValue = new Map(groupVaultDocuments(data || []).map((group) => [group.value, group]));
    vaultGroups.forEach((group) => {
      const loaded = byValue.get(group.value);
      group.rows = loaded?.rows || [];
      group.count = group.rows.length;
      group.loading = false;
      group.error = "";
      fillGroupBody(group);
    });
  } catch (err) {
    if (seq !== vaultSeq || controller.signal.aborted || isAbortError(err)) return;
    vaultGroups.forEach((group) => {
      if (group.rows) return;
      group.loading = false;
      group.error = AppError.getUserMessage(err);
      fillGroupBody(group);
    });
  }
}

function setAllVaultGroupsOpen(open) {
  const searching = vaultSearchQuery().length > 0;
  const saved = readOpenCategories() ?? new Set();
  if (open && !searching) {
    vaultGroups.forEach((group) => {
      if (!group.rows) group.loading = true;
    });
  }
  suppressVaultToggle += 1;
  document.querySelectorAll("#invoice-groups details.vault-group").forEach((details) => {
    details.open = open;
    if (searching) return;
    const key = details.dataset.category ?? "";
    if (open) saved.add(key);
    else saved.delete(key);
  });
  suppressVaultToggle -= 1;
  if (!searching) writeOpenCategories(saved);
  if (open && !searching) void loadAllGroupRows();
}

function bindVaultLibraryControls() {
  const groupsEl = document.getElementById("invoice-groups");
  groupsEl?.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("vault-group")) return;
    if (suppressVaultToggle) return;
    if (vaultSearchQuery()) return;
    const saved = readOpenCategories() ?? new Set();
    const key = details.dataset.category ?? "";
    if (details.open) saved.add(key);
    else saved.delete(key);
    writeOpenCategories(saved);
    if (details.open) void ensureGroupRows(key);
  }, true);

  document.getElementById("invoice-category-filter")?.addEventListener("change", () => {
    void loadVaultDocuments();
  });
  document.getElementById("invoice-search")?.addEventListener("input", debounce(() => {
    void loadVaultDocuments({ soft: true });
  }, 300));
  document.getElementById("vault-expand-all")?.addEventListener("click", () => setAllVaultGroupsOpen(true));
  document.getElementById("vault-collapse-all")?.addEventListener("click", () => setAllVaultGroupsOpen(false));
}

function bindInvoiceTableActions() {
  const groupsEl = document.getElementById("invoice-groups");
  if (!groupsEl) return;

  groupsEl.addEventListener("click", async (event) => {
    if (event.target.closest("#vault-library-retry")) {
      void loadVaultDocuments();
      return;
    }
    const retry = event.target.closest("[data-vault-retry]");
    if (retry && groupsEl.contains(retry)) {
      const group = vaultGroups.find((item) => item.value === retry.dataset.vaultRetry);
      if (!group) return;
      group.loading = false;
      group.error = "";
      group.rows = null;
      void ensureGroupRows(group.value);
      return;
    }
    const btn = event.target.closest("[data-action]");
    if (!btn || !groupsEl.contains(btn)) return;

    const id = btn.dataset.id;
    if (btn.dataset.action === "view") {
      openVaultPreview(id);
      return;
    }
    if (btn.dataset.action === "download") await downloadInvoice(id, btn);
    if (btn.dataset.action === "delete") await deleteVaultDocument(id, btn);
  });
}

function openVaultPreview(id) {
  const row = findVaultRow(id);
  const title = (row?.title || "").trim() || row?.file_name || "Document";
  const dateLabel = formatNumericDate(row?.invoice_date);
  const subtitle = [
    dateLabel !== "—" ? dateLabel : "",
    (row?.vendor || "").trim(),
    getDocumentCategoryLabel(row?.category),
  ].filter(Boolean).join(" · ");
  const fileName = row?.file_name || "";
  const mimeType = row?.mime_type || "";
  if ((mimeType === "application/pdf" || /\.pdf$/i.test(fileName)) && typeof preloadPdfPreview === "function") {
    preloadPdfPreview();
  }
  if (typeof DrivePreview === "undefined") {
    AppError.showToast("Could not open the preview.", "error");
    return;
  }
  DrivePreview.open({
    title,
    subtitle,
    download: () => downloadInvoice(id),
    load: async (ctx) => {
      if (typeof VaultDocuments?.file !== "function") throw new Error("Could not open the document.");
      const file = await VaultDocuments.file(id, { fileName, mimeType });
      if (!ctx.isCurrent()) return null;
      return { blob: file.blob, fileName: file.fileName || fileName };
    },
  });
}

async function downloadInvoice(id, btn) {
  if (!id) return;
  const row = findVaultRow(id);
  if (btn) btn.disabled = true;

  try {
    await ActionProgress.track(
      {
        title: "Downloading document",
        status: "Fetching the file…",
        doneStatus: "Downloaded",
        timeoutMs: 180000,
      },
      async ({ setPercent }) => {
        await VaultDocuments.save(id, {
          fileName: row?.file_name,
          mimeType: row?.mime_type,
          onRatio(ratio) {
            setPercent(ratio * 100, "Downloading…");
          },
        });
      }
    );
  } catch (err) {
    AppError.report(err, { context: "invoiceDownload" });
    AppError.showToast(err.message || "Download failed.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function vaultDeleteMessage(btn) {
  const title = (btn?.dataset.title || "").trim() || (btn?.dataset.file || "").trim() || "this document";
  const party = (btn?.dataset.vendor || "").trim();
  const date = formatNumericDate(btn?.dataset.date || "");
  const partyBit = party ? ` from ${party}` : "";
  const dateBit = date && date !== "—" ? ` dated ${date}` : "";
  return `Delete “${title}”${partyBit}${dateBit} from Google Drive and the app?\n\nThis cannot be undone.`;
}

async function deleteVaultDocument(id, btn) {
  if (!id || currentAuth?.role !== "admin") return;
  if (!(await AppDialog.confirm(vaultDeleteMessage(btn), { title: "Delete document", confirmLabel: "Delete", danger: true }))) return;

  try {
    await ActionProgress.track(
      {
        title: "Deleting",
        status: "Removing from Google Drive…",
        doneStatus: "Deleted",
      },
      async () => {
        await invokeInvoiceFunction({ action: "delete", id });
        await loadVaultDocuments();
      }
    );
  } catch (err) {
    AppError.report(err, { context: "invoiceDelete" });
    AppError.showToast(err.message || "Delete failed.", "error");
  }
}

bindLiveRefresh(() => {
  void loadVaultDocuments();
}, { match: () => Boolean(document.getElementById("invoice-groups")) });
