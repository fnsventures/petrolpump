/* global supabaseClient, PumpSettings */

/**
 * Shared DSR and expense query helpers for dashboard, reports, and analysis.
 */
(function (global) {
  const DSR_SELECT_FULL =
    "date, product, sales_pump1, sales_pump2, total_sales, testing, stock, receipts, petrol_rate, diesel_rate, buying_price_per_litre";
  const DSR_SELECT_PL =
    "date, product, total_sales, testing, petrol_rate, diesel_rate, receipts, buying_price_per_litre";
  const DSR_SELECT_SUMMARY = "date, product, total_sales, testing, stock, petrol_rate, diesel_rate";

  function filterDsrByRange(rows, startDate, endDate) {
    return (rows ?? []).filter((row) => row.date >= startDate && row.date <= endDate);
  }

  function extractReceiptRows(rows) {
    return (rows ?? [])
      .filter((row) => {
        if (Number(row.receipts ?? 0) <= 0) return false;
        const rate = Number(row.buying_price_per_litre);
        return Number.isFinite(rate) && rate > 0;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Fetch DSR rows for a date range. When useReceiptHistoryStart is true (default),
   * queries from receipt history start so effective buying prices can be resolved.
   */
  async function fetchDsrRows(startDate, endDate, options) {
    const opts = options || {};
    const receiptStart = opts.receiptHistoryStart ?? PumpSettings.getReceiptHistoryStart();
    const queryStart = opts.useReceiptHistoryStart !== false ? receiptStart : startDate;
    const select = opts.select ?? DSR_SELECT_PL;

    const { data, error } = await supabaseClient
      .from("dsr")
      .select(select)
      .gte("date", queryStart)
      .lte("date", endDate)
      .order("date", { ascending: true });

    if (error) return { data: null, allDsr: [], receiptRows: [], error };

    const allDsr = data ?? [];
    return {
      data: filterDsrByRange(allDsr, startDate, endDate),
      allDsr,
      receiptRows: extractReceiptRows(allDsr),
      error: null,
    };
  }

  async function fetchExpenses(startDate, endDate, select) {
    const { data, error } = await supabaseClient
      .from("expenses")
      .select(select || "date, category, amount")
      .gte("date", startDate)
      .lte("date", endDate);
    return { data: data ?? [], error };
  }

  /** Lube/billing invoice totals for P&L (matches Reports trading account). */
  async function fetchLubeSales(startDate, endDate) {
    const { data, error } = await supabaseClient
      .from("invoices")
      .select("invoice_date, total_amount")
      .gte("invoice_date", startDate)
      .lte("invoice_date", endDate);
    if (error) return { total: 0, byDate: new Map(), error };

    const byDate = new Map();
    let total = 0;
    (data ?? []).forEach((row) => {
      const amount = Number(row.total_amount ?? 0);
      total += amount;
      const key = row.invoice_date;
      byDate.set(key, (byDate.get(key) ?? 0) + amount);
    });
    return { total, byDate, error: null };
  }

  /** Merge DSR meter rows with dsr_stock dip/opening fields (date + product key). */
  function mergeDsrStock(dsrRows, stockRows) {
    const map = new Map();
    (dsrRows ?? []).forEach((row) => {
      const key = `${row.date}-${row.product}`;
      map.set(key, { ...row });
    });
    (stockRows ?? []).forEach((row) => {
      const key = `${row.date}-${row.product}`;
      map.set(key, { ...(map.get(key) || {}), ...row, product: row.product, date: row.date });
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  global.DsrQueries = {
    DSR_SELECT_FULL,
    DSR_SELECT_PL,
    DSR_SELECT_SUMMARY,
    filterDsrByRange,
    extractReceiptRows,
    fetchDsrRows,
    fetchExpenses,
    fetchLubeSales,
    mergeDsrStock,
  };
})(typeof window !== "undefined" ? window : globalThis);
