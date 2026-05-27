/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, invalidateUserRoleCache, AppError, formatCurrency, escapeHtml, PumpSettings, loadPumpSettings, AppConfig */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "settings",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  await loadPumpSettings(true);
  initSettingsNav();
  populateGstAndUnitSelects();
  bindStationForm(auth);
  bindBillingDefaultsForm(auth);
  bindPumpsForm(auth);
  bindShiftsForm(auth);
  bindAlertsForm(auth);
  initProducts();
  initUsersForm();
  initManageEmployees(auth);
  initExpenseCategories();
  loadStaffList();
});

// ─── Section navigation ──────────────────────────────────────────────────────

const VALID_SECTIONS = ["station", "billing", "pumps", "users", "hr", "attendance", "alerts", "expenses", "access"];

function initSettingsNav() {
  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "station", validSections: VALID_SECTIONS });
  }
}

function populateGstAndUnitSelects() {
  const unitSel = document.getElementById("prod-unit");
  if (unitSel) {
    unitSel.innerHTML = AppConfig.PRODUCT_UNITS.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  }
  const gstSel = document.getElementById("prod-gst");
  if (gstSel) {
    gstSel.innerHTML = AppConfig.GST_SLABS.map((s) => {
      const label = s.pct < 0 ? "Non-GST" : s.pct === 0 ? "NIL (0%)" : s.pct + "%";
      const selected = s.pct === 18 ? " selected" : "";
      return `<option value="${s.pct}"${selected}>${escapeHtml(label)}</option>`;
    }).join("");
  }
}

// ─── Station ─────────────────────────────────────────────────────────────────

function bindStationForm(auth) {
  const form = document.getElementById("station-form");
  if (!form) return;
  const s = PumpSettings.getCachedSync().station || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? "";
  };
  set("st-display-name", s.displayName);
  set("st-legal-name", s.legalName);
  set("st-brand-short", s.brandShort);
  set("st-brand-accent", s.brandAccent);
  set("st-tagline", s.tagline);
  set("st-address", s.address);
  set("st-email", s.email);
  set("st-mobile", s.mobile);
  set("st-gstin", s.gstin);
  set("st-license", s.license);
  set("st-support-email", s.supportEmail);
  set("st-support-whatsapp", s.supportWhatsapp);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const successEl = document.getElementById("station-success");
    const errorEl = document.getElementById("station-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      await PumpSettings.savePumpSettings({
        station: {
          displayName: document.getElementById("st-display-name")?.value?.trim(),
          legalName: document.getElementById("st-legal-name")?.value?.trim(),
          brandShort: document.getElementById("st-brand-short")?.value?.trim(),
          brandAccent: document.getElementById("st-brand-accent")?.value?.trim(),
          tagline: document.getElementById("st-tagline")?.value?.trim(),
          address: document.getElementById("st-address")?.value?.trim(),
          email: document.getElementById("st-email")?.value?.trim(),
          mobile: document.getElementById("st-mobile")?.value?.trim(),
          gstin: document.getElementById("st-gstin")?.value?.trim(),
          license: document.getElementById("st-license")?.value?.trim(),
          supportEmail: document.getElementById("st-support-email")?.value?.trim(),
          supportWhatsapp: document.getElementById("st-support-whatsapp")?.value?.trim(),
        },
      }, auth.session?.user?.id);
      successEl?.classList.remove("hidden");
    } catch (err) {
      AppError.handle(err, { target: errorEl });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save station details"; }
    }
  });
}

// ─── Billing defaults & products ─────────────────────────────────────────────

function bindBillingDefaultsForm(auth) {
  const form = document.getElementById("billing-defaults-form");
  if (!form) return;
  const b = PumpSettings.getCachedSync().billing || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  set("bill-invoice-prefix", b.invoicePrefix);
  set("bill-default-party", b.defaultPartyName);
  set("bill-fuel-gst", b.defaultFuelGstPct);
  const r = PumpSettings.getCachedSync().reports || {};
  set("bill-petrol-vat", r.petrolPurchaseVatPct ?? AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct);
  set("bill-diesel-vat", r.dieselPurchaseVatPct ?? AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct);
  const inclEl = document.getElementById("bill-purchase-tax-inclusive");
  if (inclEl) {
    inclEl.checked =
      typeof r.purchaseTaxInclusive === "boolean"
        ? r.purchaseTaxInclusive
        : AppConfig.DEFAULT_REPORTS.purchaseTaxInclusive === true;
  }
  set("bill-receipt-start", b.receiptHistoryStart);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const successEl = document.getElementById("billing-defaults-success");
    const errorEl = document.getElementById("billing-defaults-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      await PumpSettings.savePumpSettings({
        billing: {
          invoicePrefix: document.getElementById("bill-invoice-prefix")?.value?.trim(),
          defaultPartyName: document.getElementById("bill-default-party")?.value?.trim(),
          defaultFuelGstPct: Number(document.getElementById("bill-fuel-gst")?.value),
          receiptHistoryStart: document.getElementById("bill-receipt-start")?.value,
        },
        reports: {
          fuelGstPct: Number(document.getElementById("bill-fuel-gst")?.value) || 18,
          petrolPurchaseVatPct:
            Number(document.getElementById("bill-petrol-vat")?.value) ||
            AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct,
          dieselPurchaseVatPct:
            Number(document.getElementById("bill-diesel-vat")?.value) ||
            AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct,
          purchaseTaxInclusive: Boolean(
            document.getElementById("bill-purchase-tax-inclusive")?.checked
          ),
        },
      }, auth.session?.user?.id);
      successEl?.classList.remove("hidden");
    } catch (err) {
      AppError.handle(err, { target: errorEl });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save billing defaults"; }
    }
  });
}

function formatGstLabel(pct) {
  if (pct < 0) return "Exempt";
  if (pct === 0) return "Nil";
  return pct + "%";
}

function initProducts() {
  const form = document.getElementById("product-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveProduct(form);
  });
  void loadProducts();
}

async function loadProducts() {
  const tbody = document.getElementById("products-table-body");
  if (!tbody) return;
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .eq("is_active", true)
    .order("name");

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    return;
  }
  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan=\"6\" class=\"muted\">No products yet.</td></tr>";
    return;
  }
  tbody.innerHTML = data
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.hsn_code || "—")}</td>
      <td>${escapeHtml(p.unit)}</td>
      <td>${formatCurrency(p.default_rate)}</td>
      <td>${escapeHtml(formatGstLabel(p.gst_percent))}</td>
      <td><button type="button" class="button-secondary delete-product-btn" data-id="${escapeHtml(p.id)}">Delete</button></td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll(".delete-product-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteProduct(btn.dataset.id));
  });
}

async function saveProduct(form) {
  const successEl = document.getElementById("product-success");
  const errorEl = document.getElementById("product-error");
  successEl?.classList.add("hidden");
  errorEl?.classList.add("hidden");
  const fd = new FormData(form);
  const payload = {
    name: String(fd.get("name") || "").trim(),
    hsn_code: fd.get("hsn_code") || null,
    unit: fd.get("unit") || "Pcs",
    default_rate: Number(fd.get("default_rate") || 0),
    gst_percent: Number(fd.get("gst_percent") ?? 18),
    is_active: true,
  };
  if (!payload.name) {
    if (errorEl) { errorEl.textContent = "Product name is required."; errorEl.classList.remove("hidden"); }
    return;
  }
  const { error } = await supabaseClient.from("products").insert(payload);
  if (error) {
    AppError.handle(error, { target: errorEl });
    return;
  }
  form.reset();
  const gstSel = document.getElementById("prod-gst");
  if (gstSel) gstSel.value = "18";
  successEl?.classList.remove("hidden");
  await loadProducts();
}

async function deleteProduct(id) {
  if (!id || !confirm("Delete this product?")) return;
  const { error } = await supabaseClient.from("products").delete().eq("id", id);
  if (error) {
    alert(AppError.getUserMessage(error));
    return;
  }
  await loadProducts();
}

// ─── Pumps ───────────────────────────────────────────────────────────────────

function bindPumpsForm(auth) {
  const form = document.getElementById("pumps-form");
  if (!form) return;
  const pumps = PumpSettings.getCachedSync().pumps || AppConfig.DEFAULT_PUMP_CONFIG;
  const fill = (product, prefix) => {
    const p = pumps[product] || {};
    const set = (suffix, val) => {
      const el = document.getElementById(`pump-${product}-${suffix}`);
      if (el && val != null) el.value = val;
    };
    set("pumps", p.pumps);
    set("nozzles", p.nozzlesPerPump);
    set("label", p.tankLabel);
    set("capacity", p.tankCapacity);
  };
  fill("petrol");
  fill("diesel");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const successEl = document.getElementById("pumps-success");
    const errorEl = document.getElementById("pumps-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");
    const read = (product, suffix) => document.getElementById(`pump-${product}-${suffix}`)?.value;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      await PumpSettings.savePumpSettings({
        pumps: {
          petrol: {
            pumps: Number(read("petrol", "pumps")),
            nozzlesPerPump: Number(read("petrol", "nozzles")),
            tankLabel: read("petrol", "label")?.trim(),
            tankCapacity: read("petrol", "capacity")?.trim(),
          },
          diesel: {
            pumps: Number(read("diesel", "pumps")),
            nozzlesPerPump: Number(read("diesel", "nozzles")),
            tankLabel: read("diesel", "label")?.trim(),
            tankCapacity: read("diesel", "capacity")?.trim(),
          },
        },
      }, auth.session?.user?.id);
      successEl?.classList.remove("hidden");
    } catch (err) {
      AppError.handle(err, { target: errorEl });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save pump configuration"; }
    }
  });
}

// ─── Shifts & alerts (DB-backed) ─────────────────────────────────────────────

function bindShiftsForm(auth) {
  const form = document.getElementById("shifts-form");
  if (!form) return;
  const sh = PumpSettings.getCachedSync().shifts || AppConfig.DEFAULT_SHIFTS;
  const fields = {
    morningName: document.getElementById("shift-morning-name"),
    morningStart: document.getElementById("shift-morning-start"),
    morningEnd: document.getElementById("shift-morning-end"),
    afternoonName: document.getElementById("shift-afternoon-name"),
    afternoonStart: document.getElementById("shift-afternoon-start"),
    afternoonEnd: document.getElementById("shift-afternoon-end"),
  };
  if (fields.morningName) fields.morningName.value = sh.morning?.name || "";
  if (fields.morningStart) fields.morningStart.value = sh.morning?.start || "";
  if (fields.morningEnd) fields.morningEnd.value = sh.morning?.end || "";
  if (fields.afternoonName) fields.afternoonName.value = sh.afternoon?.name || "";
  if (fields.afternoonStart) fields.afternoonStart.value = sh.afternoon?.start || "";
  if (fields.afternoonEnd) fields.afternoonEnd.value = sh.afternoon?.end || "";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const successEl = document.getElementById("shifts-success");
    const errorEl = document.getElementById("shifts-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      await PumpSettings.savePumpSettings({
        shifts: {
          morning: {
            name: fields.morningName?.value?.trim() || AppConfig.DEFAULT_SHIFTS.morning.name,
            start: fields.morningStart?.value || AppConfig.DEFAULT_SHIFTS.morning.start,
            end: fields.morningEnd?.value || AppConfig.DEFAULT_SHIFTS.morning.end,
          },
          afternoon: {
            name: fields.afternoonName?.value?.trim() || AppConfig.DEFAULT_SHIFTS.afternoon.name,
            start: fields.afternoonStart?.value || AppConfig.DEFAULT_SHIFTS.afternoon.start,
            end: fields.afternoonEnd?.value || AppConfig.DEFAULT_SHIFTS.afternoon.end,
          },
        },
      }, auth.session?.user?.id);
      successEl?.classList.remove("hidden");
    } catch (err) {
      AppError.handle(err, { target: errorEl });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save shifts"; }
    }
  });
}

function bindAlertsForm(auth) {
  const form = document.getElementById("alerts-form");
  if (!form) return;
  const a = PumpSettings.getAlertThresholds();
  const petrolInput = document.getElementById("low-stock-petrol");
  const dieselInput = document.getElementById("low-stock-diesel");
  const highCreditInput = document.getElementById("alert-high-credit");
  const highVariationInput = document.getElementById("alert-high-variation");
  const dayClosingCheck = document.getElementById("alert-day-closing");
  if (petrolInput) petrolInput.value = a.petrol;
  if (dieselInput) dieselInput.value = a.diesel;
  if (highCreditInput) highCreditInput.value = a.highCredit || "";
  if (highVariationInput) highVariationInput.value = a.highVariation || "";
  if (dayClosingCheck) dayClosingCheck.checked = a.dayClosingReminder;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const successEl = document.getElementById("alerts-success");
    const errorEl = document.getElementById("alerts-error");
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      await PumpSettings.savePumpSettings({
        alerts: {
          lowStockPetrol: Number(petrolInput?.value),
          lowStockDiesel: Number(dieselInput?.value),
          highCredit: Number(highCreditInput?.value) || 0,
          highVariation: Number(highVariationInput?.value) || 0,
          dayClosingReminder: dayClosingCheck?.checked !== false,
        },
      }, auth.session?.user?.id);
      successEl?.classList.remove("hidden");
    } catch (err) {
      AppError.handle(err, { target: errorEl });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Save alerts"; }
    }
  });
}

// ─── Users ───────────────────────────────────────────────────────────────────

function initUsersForm() {
  const form = document.getElementById("settings-form");
  const successEl = document.getElementById("settings-success");
  const errorEl = document.getElementById("settings-error");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");

    const formData = new FormData(form);
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const role = formData.get("role");
    const password = String(formData.get("password") || "").trim();

    if (!email) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
      if (errorEl) { errorEl.textContent = "Email is required."; errorEl.classList.remove("hidden"); }
      return;
    }

    const { data: existingUser, error: userError } = await supabaseClient
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (userError) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
      AppError.handle(userError, { target: errorEl });
      return;
    }

    if (!existingUser && !password) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
      if (errorEl) { errorEl.textContent = "Password is required to create a new login."; errorEl.classList.remove("hidden"); }
      return;
    }

    if (password) {
      const { error: signupError } = await supabaseClient.auth.signUp({ email, password });
      if (signupError && !isExistingUserError(signupError)) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
        AppError.handle(signupError, { target: errorEl });
        return;
      }
    }

    const displayName = formData.get("display_name")?.trim() || null;
    const { error } = await supabaseClient.rpc("upsert_staff", {
      p_email: email,
      p_role: role,
      p_display_name: displayName || null,
    });

    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
    if (error) {
      AppError.handle(error, { target: errorEl });
      return;
    }

    form.reset();
    successEl?.classList.remove("hidden");
    if (typeof invalidateUserRoleCache === "function") invalidateUserRoleCache(email);
    invalidateEmployeeListCache();
    loadStaffList();
  });
}

// ─── Expense categories ──────────────────────────────────────────────────────

function slugifyCategoryName(label) {
  return (
    String(label || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 60) || "miscellaneous"
  );
}

function initExpenseCategories() {
  loadExpenseCategories();
  const addForm = document.getElementById("expense-category-add-form");
  const labelInput = document.getElementById("expense-category-label");
  const addError = document.getElementById("expense-category-add-error");
  const addSuccess = document.getElementById("expense-category-add-success");

  if (addForm && labelInput) {
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = addForm.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
      addError?.classList.add("hidden");
      addSuccess?.classList.add("hidden");
      const label = String(labelInput.value || "").trim();
      if (!label) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Add"; }
        if (addError) { addError.textContent = "Enter a category name."; addError.classList.remove("hidden"); }
        return;
      }
      const { error } = await supabaseClient.from("expense_categories").insert({
        name: slugifyCategoryName(label),
        label: label.slice(0, 80),
        sort_order: 999,
      });
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Add"; }
      if (error) {
        if (error.code === "23505" && addError) {
          addError.textContent = "Category already exists.";
          addError.classList.remove("hidden");
        } else AppError.handle(error, { target: addError });
        return;
      }
      addForm.reset();
      addSuccess?.classList.remove("hidden");
      loadExpenseCategories();
    });
  }
}

async function loadExpenseCategories() {
  const tbody = document.getElementById("settings-expense-categories");
  if (!tbody) return;
  const { data, error } = await supabaseClient
    .from("expense_categories")
    .select("id, name, label")
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="2" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    return;
  }
  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan=\"2\" class=\"muted\">No categories.</td></tr>";
    return;
  }
  tbody.innerHTML = data
    .map(
      (row) => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td><button type="button" class="button-secondary delete-expense-category" data-id="${escapeHtml(row.id)}" data-name="${escapeHtml(row.name)}" data-label="${escapeHtml(row.label)}">Delete</button></td>
    </tr>`
    )
    .join("");
  tbody.querySelectorAll(".delete-expense-category").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteExpenseCategory(btn));
  });
}

async function handleDeleteExpenseCategory(btn) {
  const id = btn.dataset.id;
  const name = btn.dataset.name;
  const label = btn.dataset.label || name;
  if (!id || !confirm(`Delete category "${label}"?`)) return;
  const { count } = await supabaseClient.from("expenses").select("*", { count: "exact", head: true }).eq("category", name);
  if (count > 0) {
    alert(`Cannot delete: ${count} expense(s) use this category.`);
    return;
  }
  const { error } = await supabaseClient.from("expense_categories").delete().eq("id", id);
  if (error) {
    alert(AppError.getUserMessage(error));
    return;
  }
  loadExpenseCategories();
}

// ─── HR employees ────────────────────────────────────────────────────────────

function invalidateEmployeeListCache() {
  if (typeof AppCache !== "undefined" && AppCache) AppCache.invalidateByType("staff_list");
}

function initManageEmployees(auth) {
  const staffMemberForm = document.getElementById("emp-member-form");
  const staffFormSuccess = document.getElementById("emp-form-success");
  const staffFormError = document.getElementById("emp-form-error");
  const staffSubmitBtn = document.getElementById("emp-submit-btn");
  const staffCancelBtn = document.getElementById("emp-cancel-btn");
  const membersTbody = document.getElementById("emp-members-body");
  const idInput = document.getElementById("emp-member-id");
  const nameInput = document.getElementById("emp-name");
  const roleInput = document.getElementById("emp-job-role");
  const salaryInput = document.getElementById("emp-monthly-salary");
  if (!staffMemberForm || !membersTbody) return;

  let staffList = [];
  let staffListLoadError = null;

  async function loadStaffMembers() {
    const { data, error } = await supabaseClient
      .from("employees")
      .select("id, name, role_display, monthly_salary, display_order")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      staffListLoadError = error;
      staffList = [];
      return [];
    }
    staffListLoadError = null;
    staffList = data ?? [];
    return staffList;
  }

  function renderStaffMembersTable() {
    if (staffListLoadError) {
      membersTbody.innerHTML = `<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(staffListLoadError))}</td></tr>`;
      return;
    }
    if (!staffList.length) {
      membersTbody.innerHTML = "<tr><td colspan=\"4\" class=\"muted\">No staff yet.</td></tr>";
      return;
    }
    membersTbody.innerHTML = staffList
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.role_display ?? "—")}</td>
        <td>${formatCurrency(s.monthly_salary)}</td>
        <td>
          <button type="button" class="edit-emp-staff-btn button-secondary" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" data-role="${escapeHtml(s.role_display ?? "")}" data-salary="${escapeHtml(String(s.monthly_salary ?? 0))}">Edit</button>
          <button type="button" class="delete-emp-staff-btn button-secondary" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" style="margin-left:0.35rem">Delete</button>
        </td>
      </tr>`
      )
      .join("");
  }

  membersTbody.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const delBtn = t.closest(".delete-emp-staff-btn");
    if (delBtn) {
      e.preventDefault();
      void handleDeleteEmployee(delBtn.getAttribute("data-id"), delBtn.getAttribute("data-name") || "this person");
      return;
    }
    const editBtn = t.closest(".edit-emp-staff-btn");
    if (editBtn) {
      e.preventDefault();
      if (idInput) idInput.value = editBtn.getAttribute("data-id") || "";
      if (nameInput) nameInput.value = editBtn.getAttribute("data-name") || "";
      if (roleInput) roleInput.value = editBtn.getAttribute("data-role") || "";
      if (salaryInput) salaryInput.value = editBtn.getAttribute("data-salary") || "";
      if (staffSubmitBtn) staffSubmitBtn.textContent = "Update";
      staffCancelBtn?.classList.remove("hidden");
    }
  });

  async function handleDeleteEmployee(id, name) {
    if (!window.confirm(`Remove ${name} from the active staff list?`)) return;
    staffFormError?.classList.add("hidden");
    const { error: delErr } = await supabaseClient.from("employees").delete().eq("id", id);
    if (!delErr) {
      invalidateEmployeeListCache();
      staffFormSuccess?.classList.remove("hidden");
      await loadStaffMembers();
      renderStaffMembersTable();
      return;
    }
    const msg = (delErr.message || "").toLowerCase();
    if (delErr.code === "23503" || msg.includes("foreign key")) {
      const { error: upErr } = await supabaseClient.from("employees").update({ is_active: false }).eq("id", id);
      if (!upErr) {
        invalidateEmployeeListCache();
        if (staffFormSuccess) {
          staffFormSuccess.textContent = "Removed from list (kept for history).";
          staffFormSuccess.classList.remove("hidden");
        }
        await loadStaffMembers();
        renderStaffMembersTable();
      } else AppError.handle(upErr, { target: staffFormError });
      return;
    }
    AppError.handle(delErr, { target: staffFormError });
  }

  staffMemberForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (staffSubmitBtn) { staffSubmitBtn.disabled = true; staffSubmitBtn.textContent = "Saving…"; }
    staffFormSuccess?.classList.add("hidden");
    staffFormError?.classList.add("hidden");
    const id = idInput?.value?.trim() || null;
    const name = nameInput?.value?.trim();
    const monthlySalary = Number(salaryInput?.value || 0);
    if (!name) {
      if (staffSubmitBtn) { staffSubmitBtn.disabled = false; staffSubmitBtn.textContent = "Add staff"; }
      if (staffFormError) { staffFormError.textContent = "Name is required."; staffFormError.classList.remove("hidden"); }
      return;
    }
    const payload = { name, role_display: roleInput?.value?.trim() || null, monthly_salary: monthlySalary };
    if (auth.session?.user?.id) payload.created_by = auth.session.user.id;
    const { error } = id
      ? await supabaseClient.from("employees").update(payload).eq("id", id)
      : await supabaseClient.from("employees").insert(payload);
    if (staffSubmitBtn) { staffSubmitBtn.disabled = false; staffSubmitBtn.textContent = "Add staff"; }
    if (error) {
      AppError.handle(error, { target: staffFormError });
      return;
    }
    staffMemberForm.reset();
    if (idInput) idInput.value = "";
    staffCancelBtn?.classList.add("hidden");
    staffFormSuccess?.classList.remove("hidden");
    invalidateEmployeeListCache();
    await loadStaffMembers();
    renderStaffMembersTable();
  });

  staffCancelBtn?.addEventListener("click", () => {
    staffMemberForm.reset();
    if (idInput) idInput.value = "";
    if (staffSubmitBtn) staffSubmitBtn.textContent = "Add staff";
    staffCancelBtn.classList.add("hidden");
  });

  void loadStaffMembers().then(renderStaffMembersTable);
}

async function loadStaffList() {
  const tbody = document.getElementById("settings-table-body");
  if (!tbody) return;
  tbody.innerHTML = "<tr><td colspan='4' class='muted'>Loading…</td></tr>";
  const { data, error } = await supabaseClient
    .from("users")
    .select("email, display_name, role, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    tbody.innerHTML = `<tr><td colspan='4' class='error'>${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
    return;
  }
  if (!data?.length) {
    tbody.innerHTML = "<tr><td colspan='4' class='muted'>No users yet.</td></tr>";
    return;
  }
  tbody.innerHTML = data
    .map(
      (row) => `
    <tr>
      <td>${escapeHtml(row.email)}</td>
      <td>${escapeHtml(row.display_name ?? "—")}</td>
      <td>${escapeHtml(row.role)}</td>
      <td>${formatSettingsDate(row.created_at)}</td>
    </tr>`
    )
    .join("");
}

function formatSettingsDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function isExistingUserError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("already registered") || message.includes("already exists");
}
