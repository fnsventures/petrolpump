/**
 * Active employee records — same fields as HR → Staff (employees table).
 * Cached via AppCache (staff_list). Supervisors use list_employees_salary RPC.
 */
(function (global) {
  const CACHE_KEY = "active_employees_detail_v1";

  /** Must match staff.js employees.select and list_employees_salary() return shape. */
  const ACTIVE_EMPLOYEE_DETAIL_SELECT =
    "id, name, role_display, display_order, monthly_salary, phone_number, aadhar_number, address, pan_number, pf_number, pf_contribution, blood_group, photo_url, date_of_birth, id_valid_from, id_valid_to";

  async function fetchFromEmployeesTable(client) {
    const { data, error } = await client
      .from("employees")
      .select(ACTIVE_EMPLOYEE_DETAIL_SELECT)
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  async function fetchFromSalaryRpc(client) {
    const { data, error } = await client.rpc("list_employees_salary");
    if (error) throw error;
    return data ?? [];
  }

  async function fetchFromRosterRpc(client) {
    const { data, error } = await client.rpc("list_employees_roster");
    if (error) throw error;
    return (data ?? []).map((row) => ({
      ...row,
      monthly_salary: row.monthly_salary ?? 0,
      phone_number: null,
      aadhar_number: null,
      address: null,
      pan_number: null,
      pf_number: null,
      pf_contribution: null,
      blood_group: null,
      photo_url: null,
      date_of_birth: null,
      id_valid_from: null,
      id_valid_to: null,
    }));
  }

  async function loadActiveEmployees(client, options = {}) {
    const { isAdmin = false, useCache = true } = options;

    const fetchFn = async () => {
      if (isAdmin) {
        try {
          return await fetchFromEmployeesTable(client);
        } catch (err) {
          if (typeof global.AppError !== "undefined" && global.AppError.report) {
            global.AppError.report(err, { context: "StaffEmployees.fetchFromEmployeesTable" });
          }
          throw err;
        }
      }
      try {
        return await fetchFromSalaryRpc(client);
      } catch (rpcErr) {
        const missingFn =
          /list_employees_salary/i.test(rpcErr.message || "") || rpcErr.code === "PGRST202";
        if (!missingFn) throw rpcErr;
        return fetchFromRosterRpc(client);
      }
    };

    if (useCache && global.AppCache) {
      return global.AppCache.getWithSWR(CACHE_KEY, fetchFn, "staff_list");
    }
    return fetchFn();
  }

  function invalidateActiveEmployeesCache() {
    if (!global.AppCache) return;
    global.AppCache.remove(CACHE_KEY);
    global.AppCache.invalidateByType("staff_list");
  }

  global.StaffEmployees = {
    ACTIVE_EMPLOYEE_DETAIL_SELECT,
    CACHE_KEY,
    loadActiveEmployees,
    invalidateActiveEmployeesCache,
  };
})(typeof window !== "undefined" ? window : globalThis);
