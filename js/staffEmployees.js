/**
 * Employee roster — single source of truth for active / inactive staff.
 * Operational pages use active only; Staff page can load inactive; history resolves by id.
 */
(function (global) {
  const CACHE_KEY_ACTIVE_DETAIL = "active_employees_detail_v2";
  const CACHE_KEY_ACTIVE_ROSTER = "active_employees_roster_v1";
  const CACHE_KEY_INACTIVE = "inactive_employees_detail_v1";
  const staffLoadGuard =
    typeof global.createRequestGuard === "function" ? global.createRequestGuard() : null;

  /** Full HR fields — matches list_employees_salary() + is_active. */
  const EMPLOYEE_DETAIL_SELECT =
    "id, name, role_display, display_order, monthly_salary, phone_number, aadhar_number, address, pan_number, pf_number, pf_contribution, blood_group, photo_url, date_of_birth, id_valid_from, id_valid_to, is_active";

  function normalizeStatus(status) {
    if (status === "inactive" || status === "all") return status;
    return "active";
  }

  function asActive(row) {
    return { ...row, is_active: row.is_active !== false };
  }

  async function fetchFromEmployeesTable(client, status) {
    let query = client
      .from("employees")
      .select(EMPLOYEE_DETAIL_SELECT)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });

    if (status === "active") query = query.eq("is_active", true);
    else if (status === "inactive") query = query.eq("is_active", false);

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async function fetchFromSalaryRpc(client) {
    const { data, error } = await client.rpc("list_employees_salary");
    if (error) throw error;
    return (data ?? []).map((row) => asActive({ ...row, is_active: true }));
  }

  async function fetchFromRosterRpc(client) {
    const { data, error } = await client.rpc("list_employees_roster");
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      role_display: row.role_display,
      monthly_salary: row.monthly_salary ?? 0,
      display_order: row.display_order,
      is_active: true,
    }));
  }

  /** Prefer salary RPC (shared shape); admin falls back to table; then light roster. */
  async function fetchActiveDetail(client, isAdmin) {
    try {
      return await fetchFromSalaryRpc(client);
    } catch (rpcErr) {
      const missingFn =
        /list_employees_salary/i.test(rpcErr.message || "") || rpcErr.code === "PGRST202";
      if (!missingFn && !isAdmin) throw rpcErr;
      if (isAdmin) {
        try {
          return await fetchFromEmployeesTable(client, "active");
        } catch (tableErr) {
          if (typeof global.AppError !== "undefined" && global.AppError.report) {
            global.AppError.report(tableErr, { context: "StaffEmployees.fetchFromEmployeesTable" });
          }
          if (!missingFn) throw rpcErr;
          throw tableErr;
        }
      }
      return fetchFromRosterRpc(client);
    }
  }

  /**
   * @param {object} client
   * @param {{ isAdmin?: boolean, useCache?: boolean, status?: 'active'|'inactive'|'all' }} [options]
   */
  async function loadEmployees(client, options = {}) {
    const loadId = staffLoadGuard ? staffLoadGuard.next() : 0;
    const { isAdmin = false, useCache = true } = options;
    const status = normalizeStatus(options.status);

    let result;
    if (status === "active") {
      const fetchFn = () => fetchActiveDetail(client, isAdmin);
      if (useCache && global.AppCache) {
        result = await global.AppCache.getWithSWR(CACHE_KEY_ACTIVE_DETAIL, fetchFn, "staff_list");
      } else {
        result = await fetchFn();
      }
    } else if (status === "inactive") {
      const fetchFn = () => fetchFromEmployeesTable(client, "inactive");
      if (useCache && global.AppCache) {
        result = await global.AppCache.getWithSWR(CACHE_KEY_INACTIVE, fetchFn, "staff_list");
      } else {
        result = await fetchFn();
      }
    } else {
      result = await fetchFromEmployeesTable(client, "all");
    }

    if (staffLoadGuard && !staffLoadGuard.isCurrent(loadId)) return [];
    return result;
  }

  async function loadActiveEmployees(client, options = {}) {
    return loadEmployees(client, { ...options, status: "active" });
  }

  /** Lightweight active roster (id/name/role) — attendance, E-20 datalist. */
  async function loadActiveRoster(client, options = {}) {
    const loadId = staffLoadGuard ? staffLoadGuard.next() : 0;
    const { useCache = true } = options;
    const fetchFn = () => fetchFromRosterRpc(client);
    let result;
    if (useCache && global.AppCache) {
      result = await global.AppCache.getWithSWR(CACHE_KEY_ACTIVE_ROSTER, fetchFn, "staff_list");
    } else {
      result = await fetchFn();
    }
    if (staffLoadGuard && !staffLoadGuard.isCurrent(loadId)) return [];
    return result;
  }

  /**
   * Resolve employee rows by id (includes inactive). Used for payment/attendance history.
   * @returns {Promise<Map<string, object>>}
   */
  async function resolveEmployeesByIds(client, ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    const map = new Map();
    if (!unique.length) return map;

    let rpcFailedMissing = false;
    try {
      const { data, error } = await client.rpc("get_employees_by_ids", { p_ids: unique });
      if (!error) {
        (data ?? []).forEach((row) => map.set(row.id, row));
        return map;
      }
      rpcFailedMissing =
        /get_employees_by_ids/i.test(error.message || "") || error.code === "PGRST202";
      if (!rpcFailedMissing) throw error;
    } catch (rpcErr) {
      rpcFailedMissing =
        /get_employees_by_ids/i.test(rpcErr?.message || "") || rpcErr?.code === "PGRST202";
      if (!rpcFailedMissing) throw rpcErr;
    }

    const { data, error } = await client
      .from("employees")
      .select(EMPLOYEE_DETAIL_SELECT)
      .in("id", unique);
    if (error) throw error;
    (data ?? []).forEach((row) => map.set(row.id, row));
    return map;
  }

  /** Admin: soft-deactivate or reactivate. Prefer RPC; fall back to direct update. */
  async function setEmployeeActive(client, employeeId, isActive) {
    try {
      const { error } = await client.rpc("set_employee_active", {
        p_employee_id: employeeId,
        p_is_active: !!isActive,
      });
      if (!error) {
        invalidateActiveEmployeesCache();
        return;
      }
      const missingFn =
        /set_employee_active/i.test(error.message || "") || error.code === "PGRST202";
      if (!missingFn) throw error;
    } catch (rpcErr) {
      const missingFn =
        /set_employee_active/i.test(rpcErr?.message || "") || rpcErr?.code === "PGRST202";
      if (!missingFn) throw rpcErr;
    }

    const { error: upErr } = await client
      .from("employees")
      .update({ is_active: !!isActive })
      .eq("id", employeeId);
    if (upErr) throw upErr;
    invalidateActiveEmployeesCache();
  }

  function displayName(employee) {
    if (!employee) return "—";
    const name = (employee.name || "").trim() || "—";
    if (employee.is_active === false) return `${name} (inactive)`;
    return name;
  }

  function invalidateActiveEmployeesCache() {
    if (!global.AppCache) return;
    global.AppCache.remove(CACHE_KEY_ACTIVE_DETAIL);
    global.AppCache.remove(CACHE_KEY_ACTIVE_ROSTER);
    global.AppCache.remove(CACHE_KEY_INACTIVE);
    // Legacy keys from earlier inactive-staff rollout
    global.AppCache.remove("active_employees_detail_v1");
    global.AppCache.invalidateByType("staff_list");
  }

  global.StaffEmployees = {
    ACTIVE_EMPLOYEE_DETAIL_SELECT: EMPLOYEE_DETAIL_SELECT,
    EMPLOYEE_DETAIL_SELECT,
    CACHE_KEY: CACHE_KEY_ACTIVE_DETAIL,
    CACHE_KEY_ACTIVE: CACHE_KEY_ACTIVE_DETAIL,
    CACHE_KEY_ACTIVE_ROSTER,
    CACHE_KEY_INACTIVE,
    loadEmployees,
    loadActiveEmployees,
    loadActiveRoster,
    resolveEmployeesByIds,
    setEmployeeActive,
    displayName,
    invalidateActiveEmployeesCache,
  };
})(typeof window !== "undefined" ? window : globalThis);
