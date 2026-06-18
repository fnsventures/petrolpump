/* global supabaseClient, requireAuth, applyRoleVisibility, AppCache, invalidateUserRoleCache, AppError, formatCurrency, escapeHtml, PumpSettings, loadPumpSettings, AppConfig, AdminDelete */

document.addEventListener("DOMContentLoaded", async () => {
  const auth = await requireAuth({
    allowedRoles: ["admin"],
    onDenied: "dashboard.html",
    pageName: "settings",
  });
  if (!auth) return;
  applyRoleVisibility(auth.role);

  await loadPumpSettings(true);
  applyStationBranding();
  initSettingsNav();
  populateGstAndUnitSelects();
  bindStationForm(auth);
  bindBillingDefaultsForm(auth);
  bindPumpsForm(auth);
  bindShiftsForm(auth);
  bindAlertsForm(auth);
  initProducts();
  initUsersForm();
  initStaffSalaries();
  initExpenseCategories();
  loadStaffList();
});

// ─── Section navigation ──────────────────────────────────────────────────────

const VALID_SECTIONS = ["station", "billing", "pumps", "users", "salaries", "attendance", "alerts", "expenses", "access"];

function parseOptionalNumber(raw, fallback) {
  const s = raw === undefined || raw === null ? "" : String(raw).trim();
  if (s === "") return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function applyStationBranding() {
  const name = PumpSettings.getStationDisplayName();
  document.querySelectorAll("header.topbar .brand a[href='dashboard.html']").forEach((a) => {
    a.textContent = name;
  });
  const subtitle = document.querySelector("header.topbar .page-subtitle")?.textContent?.trim();
  if (subtitle) document.title = `${subtitle} · ${name}`;
}

function initSettingsNav() {
  if (typeof initPageSections === "function") {
    initPageSections({ defaultSection: "station", validSections: VALID_SECTIONS });
  }
  const refreshAccessIfNeeded = () => {
    const section = (location.hash || "").replace(/^#/, "");
    if (section === "access") void loadStaffList();
  };
  window.addEventListener("hashchange", refreshAccessIfNeeded);
  refreshAccessIfNeeded();
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
  set("st-pf-establishment", s.pfEstablishmentCode);
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
          pfEstablishmentCode: document.getElementById("st-pf-establishment")?.value?.trim() || "",
          supportEmail: document.getElementById("st-support-email")?.value?.trim(),
          supportWhatsapp: document.getElementById("st-support-whatsapp")?.value?.trim(),
        },
      }, auth.session?.user?.id);
      applyStationBranding();
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
    if (el) el.value = val ?? "";
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
  const gstReportsEl = document.getElementById("bill-include-in-gst-reports");
  if (gstReportsEl) {
    const fromBilling = b.includeInGstReports;
    const fromReports = r.includeBillingInGst;
    gstReportsEl.checked =
      typeof fromBilling === "boolean"
        ? fromBilling
        : typeof fromReports === "boolean"
          ? fromReports
          : AppConfig.DEFAULT_BILLING.includeInGstReports !== false;
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
      const fuelGst = parseOptionalNumber(
        document.getElementById("bill-fuel-gst")?.value,
        b.defaultFuelGstPct ?? AppConfig.DEFAULT_BILLING.defaultFuelGstPct
      );
      const includeInGstReports = Boolean(
        document.getElementById("bill-include-in-gst-reports")?.checked
      );
      await PumpSettings.savePumpSettings({
        billing: {
          invoicePrefix: document.getElementById("bill-invoice-prefix")?.value?.trim(),
          defaultPartyName: document.getElementById("bill-default-party")?.value?.trim(),
          defaultFuelGstPct: fuelGst,
          receiptHistoryStart: document.getElementById("bill-receipt-start")?.value,
          includeInGstReports,
        },
        reports: {
          fuelGstPct: fuelGst,
          petrolPurchaseVatPct: parseOptionalNumber(
            document.getElementById("bill-petrol-vat")?.value,
            r.petrolPurchaseVatPct ?? AppConfig.DEFAULT_REPORTS.petrolPurchaseVatPct
          ),
          dieselPurchaseVatPct: parseOptionalNumber(
            document.getElementById("bill-diesel-vat")?.value,
            r.dieselPurchaseVatPct ?? AppConfig.DEFAULT_REPORTS.dieselPurchaseVatPct
          ),
          purchaseTaxInclusive: Boolean(
            document.getElementById("bill-purchase-tax-inclusive")?.checked
          ),
          includeBillingInGst: includeInGstReports,
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
      <td>${AdminDelete.buttonHtml({
        selector: "delete-product-btn",
        data: { id: p.id },
        label: "Remove",
        title: "Remove product",
        small: false,
      })}</td>
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
  if (!id || !confirm("Remove this product from the billing list?")) return;
  const { error } = await supabaseClient.from("products").update({ is_active: false }).eq("id", id);
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
      const curAlerts = PumpSettings.getCachedSync().alerts || {};
      await PumpSettings.savePumpSettings({
        alerts: {
          lowStockPetrol: parseOptionalNumber(
            petrolInput?.value,
            curAlerts.lowStockPetrol ?? AppConfig.DEFAULT_ALERTS.lowStockPetrol
          ),
          lowStockDiesel: parseOptionalNumber(
            dieselInput?.value,
            curAlerts.lowStockDiesel ?? AppConfig.DEFAULT_ALERTS.lowStockDiesel
          ),
          highCredit: parseOptionalNumber(highCreditInput?.value, curAlerts.highCredit ?? 0),
          highVariation: parseOptionalNumber(highVariationInput?.value, curAlerts.highVariation ?? 0),
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
    if (successEl) successEl.textContent = "Role saved.";

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

    let passwordNote = "";
    if (password) {
      if (!existingUser) {
        const { error: signupError } = await supabaseClient.auth.signUp({ email, password });
        if (signupError && !isExistingUserError(signupError)) {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
          AppError.handle(signupError, { target: errorEl });
          return;
        }
      } else {
        const { error: resetError } = await supabaseClient.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/login.html",
        });
        if (resetError) {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Save role"; }
          AppError.handle(resetError, { target: errorEl });
          return;
        }
        passwordNote = " Password reset email sent.";
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
    if (successEl) {
      successEl.textContent = passwordNote ? `Role saved.${passwordNote}` : "Role saved.";
      successEl.classList.remove("hidden");
    }
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
      <td>${AdminDelete.buttonHtml({
        selector: "delete-expense-category",
        data: { id: row.id, name: row.name, label: row.label },
        title: "Delete category",
        small: false,
      })}</td>
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

// ─── Staff salaries ──────────────────────────────────────────────────────────

function invalidateEmployeeListCache() {
  if (typeof AppCache !== "undefined" && AppCache) AppCache.invalidateByType("staff_list");
}

function initStaffSalaries() {
  const tbody = document.getElementById("emp-salaries-body");
  const successEl = document.getElementById("emp-salaries-success");
  const errorEl = document.getElementById("emp-salaries-error");
  if (!tbody) return;

  let staffList = [];

  async function loadSalaries() {
    const { data, error } = await supabaseClient
      .from("employees")
      .select("id, name, role_display, monthly_salary, pf_contribution, display_order")
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      tbody.innerHTML = `<tr><td colspan="5" class="error">${escapeHtml(AppError.getUserMessage(error))}</td></tr>`;
      return;
    }
    staffList = data ?? [];
    renderSalariesTable();
  }

  function formatPfContributionValue(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "";
  }

  function renderSalariesTable() {
    if (!staffList.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="muted">No staff yet. <a href="staff.html">Add staff in HR → Staff</a> first.</td></tr>';
      return;
    }
    tbody.innerHTML = staffList
      .map(
        (s) => `
      <tr data-employee-id="${escapeHtml(s.id)}">
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.role_display ?? "—")}</td>
        <td>
          <input type="number" class="emp-salary-input" min="0" step="0.01" value="${escapeHtml(String(s.monthly_salary ?? 0))}" aria-label="Monthly salary for ${escapeHtml(s.name)}" />
        </td>
        <td>
          <input type="number" class="emp-pf-input" min="0" step="1" placeholder="e.g. 200 or 150" value="${escapeHtml(formatPfContributionValue(s.pf_contribution))}" aria-label="PF contribution for ${escapeHtml(s.name)}" />
        </td>
        <td>
          <button type="button" class="save-emp-salary-btn button-secondary" data-id="${escapeHtml(s.id)}">Save</button>
        </td>
      </tr>`
      )
      .join("");
  }

  tbody.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest(".save-emp-salary-btn");
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute("data-id");
    const row = tbody.querySelector(`tr[data-employee-id="${id}"]`);
    const salaryInput = row?.querySelector(".emp-salary-input");
    const pfInput = row?.querySelector(".emp-pf-input");
    const monthlySalary = Number(salaryInput?.value ?? 0);
    const pfRaw = pfInput?.value ?? "";
    const pfContribution = String(pfRaw).trim() === "" ? null : Number(pfRaw);
    if (!Number.isFinite(monthlySalary) || monthlySalary < 0) {
      if (errorEl) {
        errorEl.textContent = "Enter a valid salary (0 or more).";
        errorEl.classList.remove("hidden");
      }
      successEl?.classList.add("hidden");
      return;
    }
    if (pfContribution != null && (!Number.isFinite(pfContribution) || pfContribution < 0)) {
      if (errorEl) {
        errorEl.textContent = "Enter a valid PF contribution (0 or more), or leave blank.";
        errorEl.classList.remove("hidden");
      }
      successEl?.classList.add("hidden");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Saving…";
    successEl?.classList.add("hidden");
    errorEl?.classList.add("hidden");
    const { error } = await supabaseClient
      .from("employees")
      .update({ monthly_salary: monthlySalary, pf_contribution: pfContribution })
      .eq("id", id);
    btn.disabled = false;
    btn.textContent = "Save";
    if (error) {
      AppError.handle(error, { target: errorEl });
      return;
    }
    invalidateEmployeeListCache();
    const item = staffList.find((s) => s.id === id);
    if (item) {
      item.monthly_salary = monthlySalary;
      item.pf_contribution = pfContribution;
    }
    successEl?.classList.remove("hidden");
  });

  void loadSalaries();
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
