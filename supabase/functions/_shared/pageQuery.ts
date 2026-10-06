/** Page past PostgREST's default 1000-row cap. `build` must return a fresh ordered select. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAll(build: () => any, maxRows = 50000) {
  const pageSize = 1000;
  const rows: unknown[] = [];
  let from = 0;
  while (from < maxRows) {
    const size = Math.min(pageSize, maxRows - from);
    const { data, error } = await build().range(from, from + size - 1);
    if (error) return { data: null as unknown[] | null, error };
    const page = (data ?? []) as unknown[];
    rows.push(...page);
    if (page.length < size) return { data: rows, error: null };
    from += page.length;
  }
  return {
    data: null as unknown[] | null,
    error: { message: "Result exceeded the page limit. Narrow the date range." },
  };
}

export const LOOKUP_ROW_LIMIT = 500;
