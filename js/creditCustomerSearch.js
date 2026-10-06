/**
 * Credit-customer autocomplete. Searches the server for a short match list
 * instead of downloading every customer.
 */

const CREDIT_CUSTOMER_SUGGEST_LIMIT = 20;

const CREDIT_CUSTOMER_SEARCH_SELECT =
  "id, customer_name, vehicle_no, mobile, address, amount_due, prepaid_balance, created_at";

function escapeCreditIlike(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function creditCustomerSearchFilter(query) {
  const raw = String(query || "")
    .trim()
    .replace(/[,()*]/g, " ")
    .replace(/\s+/g, " ");
  const pattern = `%${escapeCreditIlike(raw)}%`;
  return `customer_name.ilike.${pattern},mobile.ilike.${pattern}`;
}

/**
 * @param {string} query Empty query returns the first page of names, not the whole table.
 * @returns {Promise<object[]>}
 */
async function searchCreditCustomers(query, options = {}) {
  const limit = Math.min(CREDIT_CUSTOMER_SUGGEST_LIMIT, Number(options.limit) || CREDIT_CUSTOMER_SUGGEST_LIMIT);
  const q = String(query || "").trim();
  let request = window.supabaseClient
    .from("credit_customers")
    .select(options.select || CREDIT_CUSTOMER_SEARCH_SELECT)
    .order("customer_name", { ascending: true })
    .limit(limit);
  if (q) request = request.or(creditCustomerSearchFilter(q));
  const { data, error } = await request;
  if (error) throw error;
  return data || [];
}

async function fetchCreditCustomerById(id) {
  if (!id) return null;
  const { data, error } = await window.supabaseClient
    .from("credit_customers")
    .select(CREDIT_CUSTOMER_SEARCH_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}
