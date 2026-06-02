/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, AppError, escapeHtml, PumpSettings, loadPumpSettings, StaffEmployees */

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const STATION_ID_BRAND = "BISHNUPRIYA FUELS";
const STATION_ISSUER_NAME = "M/s Bishnupriya Fuels";
const STATION_ISSUER_PLACE = "Padmanavpur";
const BPCL_TAGLINE = "Energising Lives";
const STAFF_ID_TAGLINE_FONT_URL =
  "https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=swap";
const STAFF_PHOTO_BUCKET = "staff-photos";
const MAX_STAFF_PHOTO_BYTES = 2 * 1024 * 1024;
const STAFF_PHOTO_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "staff",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);
  await loadPumpSettings(true);
  applyStaffBranding();
  initStaffPage(auth);
});

function applyStaffBranding() {
  const name = PumpSettings.getStationDisplayName();
  document.querySelectorAll("header.topbar .brand a[href='dashboard.html']").forEach((a) => {
    a.textContent = name;
  });
  const subtitle = document.querySelector("header.topbar .page-subtitle")?.textContent?.trim();
  if (subtitle) document.title = `${subtitle} · ${name}`;
}

function staffInitial(name) {
  const t = (name || "").trim();
  return t ? t.charAt(0).toUpperCase() : "?";
}

function formatDetail(value) {
  const v = (value ?? "").toString().trim();
  return v || "—";
}

function normalizeEmployeeDetailFields(raw) {
  const digits = (v) => (v || "").replace(/\D/g, "");
  const aadhar = digits(raw.aadhar);
  const phone = digits(raw.phone);
  const pan = (raw.pan || "").trim().toUpperCase();
  const pf = (raw.pf || "").trim();
  const address = (raw.address || "").trim();
  const blood = (raw.bloodGroup || "").trim();
  const dob = (raw.dob || "").trim();
  const validFrom = (raw.validFrom || "").trim();
  const validTo = (raw.validTo || "").trim();
  if (aadhar && aadhar.length !== 12) return { error: "Aadhaar must be 12 digits." };
  if (phone && phone.length !== 10) return { error: "Phone must be 10 digits." };
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { error: "PAN must be in ABCDE1234F format." };
  if (pf && pf.length > 30) return { error: "PF number is too long (max 30 characters)." };
  if (address.length > 500) return { error: "Address is too long (max 500 characters)." };
  if (blood && !BLOOD_GROUPS.includes(blood)) return { error: "Select a valid blood group." };
  if (dob && Number.isNaN(Date.parse(dob))) return { error: "Invalid date of birth." };
  if (validFrom && Number.isNaN(Date.parse(validFrom))) return { error: "Invalid ID valid-from date." };
  if (validTo && Number.isNaN(Date.parse(validTo))) return { error: "Invalid ID valid-to date." };
  if (validFrom && validTo && validFrom > validTo) {
    return { error: "ID valid-to must be on or after valid-from." };
  }
  return {
    aadhar_number: aadhar || null,
    phone_number: phone || null,
    pan_number: pan || null,
    pf_number: pf || null,
    address: address || null,
    blood_group: blood || null,
    date_of_birth: dob || null,
    id_valid_from: validFrom || null,
    id_valid_to: validTo || null,
  };
}

function invalidateEmployeeListCache() {
  if (typeof StaffEmployees !== "undefined" && StaffEmployees) {
    StaffEmployees.invalidateActiveEmployeesCache();
  } else if (typeof AppCache !== "undefined" && AppCache) {
    AppCache.invalidateByType("staff_list");
  }
}

function buildPhotoSlotHtml(employee) {
  if (employee.photo_url) {
    return `<img class="staff-id-photo" src="${escapeHtml(employee.photo_url)}" alt="" crossorigin="anonymous" />`;
  }
  return `<div class="staff-id-photo-placeholder" aria-hidden="true">${escapeHtml(staffInitial(employee.name))}</div>`;
}

function formatIdDateShort(isoDate) {
  if (!isoDate) return "—";
  const parts = String(isoDate).slice(0, 10).split("-");
  if (parts.length !== 3) return "—";
  const [, m, d] = parts;
  const y = parts[0].slice(-2);
  return `${d}/${m}/${y}`;
}

function formatDobDisplay(isoDate) {
  return formatIdDateShort(isoDate);
}

function defaultIdValidity() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

function getIdValidity(employee) {
  if (employee.id_valid_from && employee.id_valid_to) {
    return { from: employee.id_valid_from, to: employee.id_valid_to };
  }
  return defaultIdValidity();
}

function bloodDropIconSvg() {
  return `<svg class="staff-id-blood-drop" viewBox="0 0 24 24" width="14" height="14" focusable="false">
    <path fill="currentColor" d="M12 2s-7 8.5-7 12.5a7 7 0 0 0 14 0C19 10.5 12 2 12 2z"/>
  </svg>`;
}

function idCardWaveSvg() {
  return `<svg class="staff-id-wave-svg" viewBox="0 0 216 32" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="#002d5c" d="M0,10 C54,2 108,14 162,8 C186,5 204,11 216,9 L216,32 L0,32 Z"/>
    <path fill="#005baa" d="M0,15 C72,7 144,19 216,13 L216,32 L0,32 Z"/>
    <path fill="#f7b500" d="M0,22 C108,14 162,26 216,20 L216,32 L0,32 Z"/>
  </svg>`;
}

/** BPCL wave footer — same on front and back */
function idCardWaveFooterHtml() {
  return `
    <footer class="staff-id-wave-footer" aria-label="${escapeHtml(BPCL_TAGLINE)}">
      ${idCardWaveSvg()}
      <span class="staff-id-wave-tagline">${escapeHtml(BPCL_TAGLINE)}</span>
    </footer>`;
}

async function waitForTaglineFont(doc) {
  const fonts = doc.defaultView?.fonts || document.fonts;
  if (!fonts?.load) return;
  try {
    await fonts.load('600 11px "Caveat"');
  } catch {
    /* optional webfont */
  }
}

function idCardTopbarHtml(tagline) {
  const bpclLogo = staffIdAssetUrl("assets/bpcl-logo.png");
  return `
    <div class="staff-id-topbar">
      <img class="staff-id-topbar-logo" src="${bpclLogo}" width="32" height="32" alt="BPCL" />
      <div class="staff-id-topbar-text">
        <span class="staff-id-topbar-tag">${escapeHtml(tagline)}</span>
        <span class="staff-id-topbar-brand">${escapeHtml(STATION_ID_BRAND)}</span>
      </div>
    </div>`;
}

function idFieldRow(label, value) {
  return `
    <div class="staff-id-field">
      <span class="staff-id-field-label">${escapeHtml(label)}</span>
      <span class="staff-id-field-value">${escapeHtml(value || "—")}</span>
    </div>`;
}

function buildIdCardFrontHtml(employee) {
  const role = employee.role_display || "Staff";
  const dob = formatDobDisplay(employee.date_of_birth);
  const blood = employee.blood_group || "—";
  const name = escapeHtml(employee.name || "");
  return `
    <article class="staff-id-card staff-id-card--front" aria-label="ID card front">
      <div class="staff-id-card-glow" aria-hidden="true"></div>
      ${idCardTopbarHtml("Employee ID")}
      <div class="staff-id-card-body">
        <div class="staff-id-hero">
          <div class="staff-id-photo-ring">
            <div class="staff-id-photo-wrap">${buildPhotoSlotHtml(employee)}</div>
          </div>
        </div>
        <h3 class="staff-id-display-name">${name}</h3>
        <div class="staff-id-highlights">
          <span class="staff-id-highlight staff-id-highlight--role">${escapeHtml(role)}</span>
          <span class="staff-id-highlight staff-id-highlight--blood">
            <span class="staff-id-blood-icon" aria-hidden="true">${bloodDropIconSvg()}</span>
            <span class="staff-id-blood-value">${escapeHtml(blood)}</span>
          </span>
        </div>
        <div class="staff-id-fields">
          ${idFieldRow("D.O.B", dob)}
        </div>
      </div>
      ${idCardWaveFooterHtml()}
    </article>`;
}

function buildIdCardBackHtml(employee) {
  const validity = getIdValidity(employee);
  const from = formatIdDateShort(validity.from);
  const to = formatIdDateShort(validity.to);
  return `
    <article class="staff-id-card staff-id-card--back" aria-label="ID card back">
      <div class="staff-id-card-glow" aria-hidden="true"></div>
      ${idCardTopbarHtml("Official use")}
      <div class="staff-id-card-body staff-id-card-body--back">
        <ul class="staff-id-rules">
          <li>Wear the badge prominently while on duty.</li>
          <li>This card must be presented on demand.</li>
          <li>Return this card to the manager when employment ends.</li>
        </ul>
        <div class="staff-id-validity-box">
          <span class="staff-id-validity-label">Validity</span>
          <span class="staff-id-validity-dates">
            <span>${escapeHtml(from)}</span>
            <span class="staff-id-validity-sep">→</span>
            <span>${escapeHtml(to)}</span>
          </span>
        </div>
        <div class="staff-id-signature-block">
          <div class="staff-id-signature">
            <span class="staff-id-signature-label">Authorised signature</span>
            <span class="staff-id-signature-line"></span>
          </div>
          <div class="staff-id-issuer">
            <p class="staff-id-issuer-name">${escapeHtml(STATION_ISSUER_NAME)}</p>
            <p class="staff-id-issuer-place">${escapeHtml(STATION_ISSUER_PLACE)}</p>
          </div>
        </div>
      </div>
      ${idCardWaveFooterHtml()}
    </article>`;
}

function buildIdCardSheetHtml(employee) {
  return buildIdCardFrontHtml(employee) + buildIdCardBackHtml(employee);
}

function staffIdAssetUrl(path) {
  return new URL(path, window.location.href).href;
}

async function runStaffIdPrintInIframe(emp) {
  const sheetHtml = buildIdCardSheetHtml(emp);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Staff ID print");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error("Print frame unavailable");
  }

  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(emp.name || "Staff")} · ID card</title>
  <link rel="stylesheet" href="${STAFF_ID_TAGLINE_FONT_URL}" />
  <link rel="stylesheet" href="${staffIdAssetUrl("css/app.css")}" />
  <link rel="stylesheet" href="${staffIdAssetUrl("css/staff-id-print.css")}" />
</head>
<body>
  <div class="staff-id-sheet">${sheetHtml}</div>
</body>
</html>`);
  doc.close();

  await waitForCardImages(doc.body);
  await waitForTaglineFont(doc);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    throw new Error("Print frame unavailable");
  }

  const cleanup = () => {
    iframe.remove();
  };

  win.addEventListener("afterprint", cleanup);
  win.focus();
  win.print();
  window.setTimeout(cleanup, 3000);
}

function idCardReadiness(employee) {
  const missing = [];
  if (!employee.photo_url) missing.push("photo");
  if (!employee.blood_group) missing.push("blood group");
  if (!employee.date_of_birth) missing.push("date of birth");
  return missing;
}

function photoExtensionFromFile(file) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

async function uploadEmployeePhoto(employeeId, file) {
  if (!STAFF_PHOTO_MIME.has(file.type)) throw new Error("Use a JPG, PNG, or WebP image.");
  if (file.size > MAX_STAFF_PHOTO_BYTES) throw new Error("Image must be 2 MB or smaller.");
  const ext = photoExtensionFromFile(file);
  const path = `${employeeId}/photo.${ext}`;
  const { error: uploadError } = await supabaseClient.storage
    .from(STAFF_PHOTO_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type, cacheControl: "3600" });
  if (uploadError) throw uploadError;
  const { data: urlData } = supabaseClient.storage.from(STAFF_PHOTO_BUCKET).getPublicUrl(path);
  const publicUrl = `${urlData.publicUrl}?v=${Date.now()}`;
  const { error: rpcError } = await supabaseClient.rpc("set_employee_photo", {
    p_employee_id: employeeId,
    p_photo_url: publicUrl,
  });
  if (rpcError) throw rpcError;
  return publicUrl;
}

async function clearEmployeePhoto(employeeId) {
  await supabaseClient.storage.from(STAFF_PHOTO_BUCKET).remove([
    `${employeeId}/photo.jpg`,
    `${employeeId}/photo.png`,
    `${employeeId}/photo.webp`,
  ]);
  const { error: rpcError } = await supabaseClient.rpc("set_employee_photo", {
    p_employee_id: employeeId,
    p_photo_url: null,
  });
  if (rpcError) throw rpcError;
}

function waitForCardImages(root) {
  const imgs = root.querySelectorAll("img.staff-id-photo, img.staff-id-topbar-logo");
  if (!imgs.length) return Promise.resolve();
  return Promise.all(
    Array.from(imgs).map(
      (img) =>
        new Promise((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve();
          else {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }
        })
    )
  );
}

function initStaffPage(auth) {
  const rosterList = document.getElementById("staff-roster-list");
  const rosterCount = document.getElementById("staff-roster-count");
  const emptyState = document.getElementById("staff-empty-state");
  const formPanel = document.getElementById("staff-form-panel");
  const profilePanel = document.getElementById("staff-profile-panel");
  const formTitle = document.getElementById("staff-form-title");
  const staffMemberForm = document.getElementById("emp-member-form");
  const staffFormSuccess = document.getElementById("emp-form-success");
  const staffFormError = document.getElementById("emp-form-error");
  const staffSubmitBtn = document.getElementById("emp-submit-btn");
  const idInput = document.getElementById("emp-member-id");
  const nameInput = document.getElementById("emp-name");
  const roleInput = document.getElementById("emp-job-role");
  const bloodInput = document.getElementById("emp-blood-group");
  const phoneInput = document.getElementById("emp-phone");
  const aadharInput = document.getElementById("emp-aadhar");
  const panInput = document.getElementById("emp-pan");
  const pfInput = document.getElementById("emp-pf");
  const addressInput = document.getElementById("emp-address");
  const photoFileInput = document.getElementById("emp-photo-file");
  const photoPreviewBox = document.getElementById("emp-photo-preview");
  const photoPreviewImg = document.getElementById("emp-photo-img");
  const photoPreviewInitial = document.getElementById("emp-photo-initial");
  const photoClearBtn = document.getElementById("emp-photo-clear");
  const profileName = document.getElementById("staff-profile-name");
  const profileRole = document.getElementById("staff-profile-role");
  const profilePhotoBox = document.getElementById("staff-profile-photo");
  const profilePhotoImg = document.getElementById("staff-profile-img");
  const profileInitial = document.getElementById("staff-profile-initial");
  const profileBlood = document.getElementById("staff-profile-blood");
  const profileDob = document.getElementById("staff-profile-dob");
  const profileValidity = document.getElementById("staff-profile-validity");
  const profilePhone = document.getElementById("staff-profile-phone");
  const dobInput = document.getElementById("emp-dob");
  const validFromInput = document.getElementById("emp-valid-from");
  const validToInput = document.getElementById("emp-valid-to");
  const profileAadhar = document.getElementById("staff-profile-aadhar");
  const profilePan = document.getElementById("staff-profile-pan");
  const profilePf = document.getElementById("staff-profile-pf");
  const profilePfContribution = document.getElementById("staff-profile-pf-contribution");
  const profileAddress = document.getElementById("staff-profile-address");
  const idCardPreview = document.getElementById("id-card-preview");
  const idCardHint = document.getElementById("id-card-hint");
  const printBtn = document.getElementById("id-card-print-btn");
  const printRoot = document.getElementById("staff-id-print-root");

  if (!rosterList || !staffMemberForm) return;

  let staffList = [];
  let staffListLoadError = null;
  let selectedId = null;
  let pendingPhotoFile = null;
  let removePhotoOnSave = false;

  function showPanel(mode) {
    emptyState?.classList.toggle("hidden", mode !== "empty");
    if (emptyState) emptyState.hidden = mode !== "empty";
    formPanel?.classList.toggle("hidden", mode !== "form");
    if (formPanel) formPanel.hidden = mode !== "form";
    profilePanel?.classList.toggle("hidden", mode !== "profile");
    if (profilePanel) profilePanel.hidden = mode !== "profile";
  }

  function setFormPhotoPreview(url, name) {
    if (!photoPreviewBox) return;
    if (url && photoPreviewImg) {
      photoPreviewImg.src = url;
      photoPreviewImg.alt = name ? `Photo of ${name}` : "";
      photoPreviewImg.classList.remove("hidden");
      if (photoPreviewInitial) photoPreviewInitial.textContent = "";
      photoPreviewBox.classList.remove("is-placeholder");
      photoClearBtn?.classList.remove("hidden");
    } else {
      if (photoPreviewImg) {
        photoPreviewImg.removeAttribute("src");
        photoPreviewImg.classList.add("hidden");
      }
      if (photoPreviewInitial) photoPreviewInitial.textContent = staffInitial(name);
      photoPreviewBox.classList.add("is-placeholder");
      photoClearBtn?.classList.add("hidden");
    }
  }

  function setProfilePhoto(url, name) {
    if (!profilePhotoBox) return;
    if (url && profilePhotoImg) {
      profilePhotoImg.src = url;
      profilePhotoImg.alt = name ? `Photo of ${name}` : "";
      profilePhotoImg.classList.remove("hidden");
      if (profileInitial) profileInitial.textContent = "";
      profilePhotoBox.classList.remove("is-placeholder");
    } else {
      if (profilePhotoImg) {
        profilePhotoImg.removeAttribute("src");
        profilePhotoImg.classList.add("hidden");
      }
      if (profileInitial) profileInitial.textContent = staffInitial(name);
      profilePhotoBox.classList.add("is-placeholder");
    }
  }

  function resetFormPhoto() {
    pendingPhotoFile = null;
    removePhotoOnSave = false;
    if (photoFileInput) photoFileInput.value = "";
    setFormPhotoPreview(null, "");
  }

  function fillFormFromEmployee(emp) {
    if (idInput) idInput.value = emp.id || "";
    if (nameInput) nameInput.value = emp.name || "";
    if (roleInput) roleInput.value = emp.role_display || "";
    if (bloodInput) bloodInput.value = emp.blood_group || "";
    if (dobInput) dobInput.value = emp.date_of_birth ? String(emp.date_of_birth).slice(0, 10) : "";
    if (validFromInput) validFromInput.value = emp.id_valid_from ? String(emp.id_valid_from).slice(0, 10) : "";
    if (validToInput) validToInput.value = emp.id_valid_to ? String(emp.id_valid_to).slice(0, 10) : "";
    if (phoneInput) phoneInput.value = emp.phone_number || "";
    if (aadharInput) aadharInput.value = emp.aadhar_number || "";
    if (panInput) panInput.value = emp.pan_number || "";
    if (pfInput) pfInput.value = emp.pf_number || "";
    if (addressInput) addressInput.value = emp.address || "";
    if (photoFileInput) photoFileInput.value = "";
    pendingPhotoFile = null;
    removePhotoOnSave = false;
    setFormPhotoPreview(emp.photo_url, emp.name);
    if (formTitle) formTitle.textContent = "Edit staff";
    if (staffSubmitBtn) staffSubmitBtn.textContent = "Save changes";
  }

  function resetFormForAdd() {
    staffMemberForm.reset();
    if (idInput) idInput.value = "";
    resetFormPhoto();
    const y = new Date().getFullYear();
    if (validFromInput) validFromInput.value = `${y}-01-01`;
    if (validToInput) validToInput.value = `${y}-12-31`;
    if (formTitle) formTitle.textContent = "Add staff";
    if (staffSubmitBtn) staffSubmitBtn.textContent = "Save staff";
    staffFormSuccess?.classList.add("hidden");
    staffFormError?.classList.add("hidden");
  }

  function openAddForm() {
    resetFormForAdd();
    showPanel("form");
    nameInput?.focus();
  }

  function openEditForm(emp) {
    fillFormFromEmployee(emp);
    showPanel("form");
    nameInput?.focus();
  }

  async function renderIdCardPanel(emp) {
    if (!idCardPreview) return;
    idCardPreview.innerHTML = buildIdCardSheetHtml(emp);
    await waitForCardImages(idCardPreview);
    await waitForTaglineFont(document);
    const missing = idCardReadiness(emp);
    if (printBtn) {
      printBtn.disabled = missing.length > 0;
      printBtn.title = missing.length
        ? `Add ${missing.join(" and ")} to enable printing`
        : "Print staff ID card";
    }
    if (idCardHint) {
      if (missing.length) {
        idCardHint.textContent = `Add ${missing.join(" and ")} (edit profile) to print the ID card.`;
        idCardHint.classList.remove("hidden");
        idCardHint.classList.remove("is-ready");
      } else {
        idCardHint.textContent = "Ready to print.";
        idCardHint.classList.remove("hidden");
        idCardHint.classList.add("is-ready");
      }
    }
  }

  function renderProfile(emp) {
    selectedId = emp.id;
    if (profileName) profileName.textContent = emp.name || "—";
    if (profileRole) profileRole.textContent = emp.role_display || "Staff member";
    if (profileBlood) profileBlood.textContent = formatDetail(emp.blood_group);
    if (profileDob) profileDob.textContent = emp.date_of_birth ? formatDobDisplay(emp.date_of_birth) : "—";
    if (profileValidity) {
      const v = getIdValidity(emp);
      profileValidity.textContent = `${formatIdDateShort(v.from)} – ${formatIdDateShort(v.to)}`;
    }
    if (profilePhone) profilePhone.textContent = formatDetail(emp.phone_number);
    if (profileAadhar) profileAadhar.textContent = formatDetail(emp.aadhar_number);
    if (profilePan) profilePan.textContent = formatDetail(emp.pan_number);
    if (profilePf) profilePf.textContent = formatDetail(emp.pf_number);
    if (profilePfContribution) {
      const amt = Number(emp.pf_contribution);
      profilePfContribution.textContent =
        Number.isFinite(amt) && amt > 0
          ? `₹ ${amt.toLocaleString("en-IN")} / month`
          : "Not set — use Settings → Staff salaries";
    }
    if (profileAddress) profileAddress.textContent = formatDetail(emp.address);
    setProfilePhoto(emp.photo_url, emp.name);
    renderRosterList();
    void renderIdCardPanel(emp);
    showPanel("profile");
    if (location.hash !== `#${emp.id}`) {
      history.replaceState(null, "", `staff.html#${emp.id}`);
    }
  }

  function selectEmployee(id) {
    const emp = staffList.find((s) => s.id === id);
    if (emp) renderProfile(emp);
  }

  function renderRosterList() {
    if (!rosterList) return;
    if (staffListLoadError) {
      rosterList.innerHTML = `<li class="staff-roster-error">${escapeHtml(AppError.getUserMessage(staffListLoadError))}</li>`;
      if (rosterCount) rosterCount.textContent = "—";
      return;
    }
    if (rosterCount) {
      rosterCount.textContent =
        staffList.length === 0
          ? "No staff yet"
          : `${staffList.length} member${staffList.length === 1 ? "" : "s"}`;
    }
    if (!staffList.length) {
      rosterList.innerHTML = '<li class="staff-roster-empty muted">Add your first staff member.</li>';
      return;
    }
    rosterList.innerHTML = staffList
      .map((s) => {
        const active = s.id === selectedId ? " is-active" : "";
        const thumb = s.photo_url
          ? `<img class="staff-roster-thumb" src="${escapeHtml(s.photo_url)}" alt="" />`
          : `<span class="staff-roster-thumb staff-roster-thumb-placeholder">${escapeHtml(staffInitial(s.name))}</span>`;
        const ready = idCardReadiness(s).length === 0;
        return `
        <li>
          <button type="button" class="staff-roster-item${active}" data-id="${escapeHtml(s.id)}" role="option" aria-selected="${s.id === selectedId}">
            ${thumb}
            <span class="staff-roster-item-text">
              <span class="staff-roster-item-name">${escapeHtml(s.name)}</span>
              <span class="staff-roster-item-meta">${escapeHtml(s.role_display || "Staff")}${ready ? " · ID ready" : ""}</span>
            </span>
          </button>
        </li>`;
      })
      .join("");
  }

  async function loadStaffMembers() {
    try {
      staffList = await StaffEmployees.loadActiveEmployees(supabaseClient, {
        isAdmin: true,
        useCache: true,
      });
      staffListLoadError = null;
    } catch (error) {
      staffListLoadError = error;
      staffList = [];
      AppError.report(error, { context: "loadStaffMembers" });
    }
    return staffList;
  }

  async function refreshAndSelect(id) {
    await loadStaffMembers();
    renderRosterList();
    if (id) selectEmployee(id);
    else if (staffList.length) selectEmployee(staffList[0].id);
    else {
      selectedId = null;
      showPanel("empty");
      history.replaceState(null, "", "staff.html");
    }
  }

  async function handleDeleteEmployee(id, name) {
    if (!window.confirm(`Remove ${name} from the active staff list?`)) return;
    const { error: delErr } = await supabaseClient.from("employees").delete().eq("id", id);
    if (!delErr) {
      invalidateEmployeeListCache();
      selectedId = null;
      await refreshAndSelect(null);
      return;
    }
    const msg = (delErr.message || "").toLowerCase();
    if (delErr.code === "23503" || msg.includes("foreign key")) {
      const { error: upErr } = await supabaseClient.from("employees").update({ is_active: false }).eq("id", id);
      if (!upErr) {
        invalidateEmployeeListCache();
        selectedId = null;
        await refreshAndSelect(null);
      } else alert(AppError.getUserMessage(upErr));
      return;
    }
    alert(AppError.getUserMessage(delErr));
  }

  rosterList.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".staff-roster-item") : null;
    if (!btn) return;
    selectEmployee(btn.getAttribute("data-id"));
  });

  document.getElementById("staff-add-btn")?.addEventListener("click", openAddForm);
  document.getElementById("staff-empty-add-btn")?.addEventListener("click", openAddForm);
  document.getElementById("staff-form-close")?.addEventListener("click", () => {
    if (selectedId) selectEmployee(selectedId);
    else showPanel(staffList.length ? "empty" : "empty");
  });

  document.getElementById("staff-profile-edit-btn")?.addEventListener("click", () => {
    const emp = staffList.find((s) => s.id === selectedId);
    if (emp) openEditForm(emp);
  });

  document.getElementById("staff-profile-delete-btn")?.addEventListener("click", () => {
    const emp = staffList.find((s) => s.id === selectedId);
    if (emp) void handleDeleteEmployee(emp.id, emp.name);
  });

  photoFileInput?.addEventListener("change", () => {
    const file = photoFileInput.files?.[0];
    if (!file) return;
    if (!STAFF_PHOTO_MIME.has(file.type)) {
      alert("Use a JPG, PNG, or WebP image.");
      photoFileInput.value = "";
      return;
    }
    if (file.size > MAX_STAFF_PHOTO_BYTES) {
      alert("Image must be 2 MB or smaller.");
      photoFileInput.value = "";
      return;
    }
    pendingPhotoFile = file;
    removePhotoOnSave = false;
    if (photoPreviewImg) {
      photoPreviewImg.src = URL.createObjectURL(file);
      photoPreviewImg.classList.remove("hidden");
      photoPreviewBox?.classList.remove("is-placeholder");
      photoClearBtn?.classList.remove("hidden");
    }
  });

  photoClearBtn?.addEventListener("click", () => {
    pendingPhotoFile = null;
    removePhotoOnSave = true;
    if (photoFileInput) photoFileInput.value = "";
    setFormPhotoPreview(null, nameInput?.value || "");
  });

  async function runStaffIdPrint(emp) {
    try {
      await runStaffIdPrintInIframe(emp);
    } catch (err) {
      AppError.report(err, { context: "staffIdPrint" });
      alert(AppError.getUserMessage(err) || "Could not open the print dialog.");
    }
  }

  printBtn?.addEventListener("click", () => {
    const emp = staffList.find((s) => s.id === selectedId);
    if (!emp) return;
    const missing = idCardReadiness(emp);
    if (missing.length) {
      alert(`Add ${missing.join(" and ")} in the profile before printing.`);
      openEditForm(emp);
      return;
    }
    void runStaffIdPrint(emp);
  });

  staffMemberForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const isEdit = Boolean(idInput?.value?.trim());
    if (staffSubmitBtn) {
      staffSubmitBtn.disabled = true;
      staffSubmitBtn.textContent = "Saving…";
    }
    staffFormSuccess?.classList.add("hidden");
    staffFormError?.classList.add("hidden");

    const id = idInput?.value?.trim() || null;
    const name = nameInput?.value?.trim();
    if (!name) {
      if (staffFormError) {
        staffFormError.textContent = "Name is required.";
        staffFormError.classList.remove("hidden");
      }
      if (staffSubmitBtn) {
        staffSubmitBtn.disabled = false;
        staffSubmitBtn.textContent = isEdit ? "Save changes" : "Save staff";
      }
      return;
    }

    const details = normalizeEmployeeDetailFields({
      aadhar: aadharInput?.value,
      phone: phoneInput?.value,
      pan: panInput?.value,
      pf: pfInput?.value,
      address: addressInput?.value,
      bloodGroup: bloodInput?.value,
      dob: dobInput?.value,
      validFrom: validFromInput?.value,
      validTo: validToInput?.value,
    });
    if (details.error) {
      if (staffFormError) {
        staffFormError.textContent = details.error;
        staffFormError.classList.remove("hidden");
      }
      if (staffSubmitBtn) {
        staffSubmitBtn.disabled = false;
        staffSubmitBtn.textContent = isEdit ? "Save changes" : "Save staff";
      }
      return;
    }

    const payload = { name, role_display: roleInput?.value?.trim() || null, ...details };
    if (!id && auth.session?.user?.id) payload.created_by = auth.session.user.id;

    let employeeId = id;
    if (id) {
      const { error } = await supabaseClient.from("employees").update(payload).eq("id", id);
      if (error) {
        AppError.handle(error, { target: staffFormError });
        if (staffSubmitBtn) {
          staffSubmitBtn.disabled = false;
          staffSubmitBtn.textContent = "Save changes";
        }
        return;
      }
    } else {
      const { data, error } = await supabaseClient.from("employees").insert(payload).select("id").single();
      if (error) {
        AppError.handle(error, { target: staffFormError });
        if (staffSubmitBtn) {
          staffSubmitBtn.disabled = false;
          staffSubmitBtn.textContent = "Save staff";
        }
        return;
      }
      employeeId = data.id;
    }

    try {
      if (removePhotoOnSave && employeeId) await clearEmployeePhoto(employeeId);
      else if (pendingPhotoFile && employeeId) await uploadEmployeePhoto(employeeId, pendingPhotoFile);
    } catch (photoErr) {
      AppError.handle(photoErr, { target: staffFormError });
      if (staffSubmitBtn) {
        staffSubmitBtn.disabled = false;
        staffSubmitBtn.textContent = isEdit ? "Save changes" : "Save staff";
      }
      return;
    }

    invalidateEmployeeListCache();
    if (staffSubmitBtn) {
      staffSubmitBtn.disabled = false;
      staffSubmitBtn.textContent = isEdit ? "Save changes" : "Save staff";
    }
    await refreshAndSelect(employeeId);
  });

  void (async () => {
    await loadStaffMembers();
    renderRosterList();
    const hashId = (location.hash || "").replace(/^#/, "");
    if (hashId && staffList.some((s) => s.id === hashId)) {
      selectEmployee(hashId);
    } else if (staffList.length) {
      selectEmployee(staffList[0].id);
    } else {
      showPanel("empty");
    }
  })();
}
