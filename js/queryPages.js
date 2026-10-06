/**
 * PostgREST stops at 1000 rows unless the query asks for the next page.
 * List reads that can grow go through fetchAllRows so a long range is complete.
 * Small lookup tables use LOOKUP_ROW_LIMIT instead.
 */

const POSTGREST_PAGE_SIZE = 1000;
const QUERY_ROW_CAP = 50000;
const LOOKUP_ROW_LIMIT = 500;

/**
 * @param {() => { range: Function }} buildQuery Fresh select chain. No limit/range yet. Order the rows.
 * @returns {Promise<{ data: unknown[] | null, error: { message?: string } | null, truncated: boolean }>}
 */
async function fetchAllRows(buildQuery, options = {}) {
  if (typeof buildQuery !== "function") {
    return { data: null, error: { message: "fetchAllRows needs a query factory." }, truncated: false };
  }
  const pageSize = Math.min(POSTGREST_PAGE_SIZE, Number(options.pageSize) || POSTGREST_PAGE_SIZE);
  const maxRows = Number(options.maxRows) || QUERY_ROW_CAP;
  const rows = [];
  let from = 0;

  while (from < maxRows) {
    const size = Math.min(pageSize, maxRows - from);
    const { data, error } = await buildQuery().range(from, from + size - 1);
    if (error) return { data: null, error, truncated: false };
    const page = data || [];
    rows.push(...page);
    if (page.length < size) return { data: rows, error: null, truncated: false };
    from += page.length;
  }

  return {
    data: null,
    error: { message: "This list is larger than the app can load at once. Narrow the dates or filters." },
    truncated: true,
  };
}

/**
 * Page a `.in(column, ids)` select. Each id chunk is itself paged past 1000 rows.
 */
async function fetchAllByIds(buildQuery, ids, column, options = {}) {
  const chunkSize = Number(options.chunkSize) || 80;
  const list = ids || [];
  const rows = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const result = await fetchAllRows(() => buildQuery().in(column, chunk), options);
    if (result.error) return result;
    rows.push(...(result.data || []));
  }
  return { data: rows, error: null, truncated: false };
}
