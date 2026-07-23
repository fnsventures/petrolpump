/* global supabaseClient, PumpSettings */

/**
 * Shared DSR and expense query helpers for dashboard, reports, and analysis.
 */
(function (global) {
  const DSR_SELECT_FULL =
    "date, product, sales_pump1, sales_pump2, total_sales, testing, stock, receipts, petrol_rate, diesel_rate, buying_price_per_litre, supplier_invoice_no, supplier_gstin, invoice_document_id";
  const DSR_SELECT_PL =
    "date, product, total_sales, testing, petrol_rate, diesel_rate, receipts, buying_price_per_litre, supplier_invoice_no, supplier_gstin, invoice_document_id";
  const DSR_SELECT_SUMMARY = "date, product, total_sales, testing, stock, petrol_rate, diesel_rate";
  const DSR_SELECT_RECEIPT = "date, product, receipts, buying_price_per_litre";
  const RECEIPT_LOOKBACK_PRODUCTS = ["petrol", "diesel"];

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
   * Latest priced receipt on/before the report window, per product.
   * Buying-rate carry-forward only needs this prior rate + in-range receipts.
   */
  async function fetchReceiptHistoryBefore(startDate, receiptStart) {
    if (!startDate || !receiptStart || receiptStart >= startDate) {
      return { data: [], error: null };
    }
    const results = await Promise.all(
      RECEIPT_LOOKBACK_PRODUCTS.map((product) =>
        supabaseClient
          .from("dsr")
          .select(DSR_SELECT_RECEIPT)
          .eq("product", product)
          .gte("date", receiptStart)
          .lt("date", startDate)
          .gt("receipts", 0)
          .gt("buying_price_per_litre", 0)
          .order("date", { ascending: false })
          .limit(1)
      )
    );
    const error = results.find((r) => r.error)?.error ?? null;
    if (error) return { data: [], error };
    const data = results.flatMap((r) => r.data ?? []);
    return { data, error: null };
  }

  /**
   * Fetch DSR rows for a date range. When useReceiptHistoryStart is true (default),
   * loads receipt history for effective buying prices without fetching every DSR row
   * from receipt history start when the report range is shorter.
   */
  async function fetchDsrRows(startDate, endDate, options) {
    const opts = options || {};
    const receiptStart = opts.receiptHistoryStart ?? PumpSettings.getReceiptHistoryStart();
    const useReceiptHistory = opts.useReceiptHistoryStart !== false;
    const select = opts.select ?? DSR_SELECT_PL;

    if (useReceiptHistory && receiptStart < startDate) {
      const [rangeResult, receiptResult] = await Promise.all([
        supabaseClient
          .from("dsr")
          .select(select)
          .gte("date", startDate)
          .lte("date", endDate)
          .order("date", { ascending: true }),
        fetchReceiptHistoryBefore(startDate, receiptStart),
      ]);

      const error = rangeResult.error || receiptResult.error;
      if (error) return { data: null, allDsr: [], receiptRows: [], error };

      const rangeRows = rangeResult.data ?? [];
      const allDsr = [...(receiptResult.data ?? []), ...rangeRows];
      return {
        data: rangeRows,
        allDsr,
        receiptRows: extractReceiptRows(allDsr),
        error: null,
      };
    }

    const queryStart = useReceiptHistory ? receiptStart : startDate;
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

  let missingBuyingPriceInflight = null;

  /**
   * Receipt days with fuel received but no usable buying price (receipt history window).
   * Matches the P&L todo banner count and buying-price entry list on the dashboard.
   */
  async function fetchMissingBuyingPriceRows() {
    if (!missingBuyingPriceInflight) {
      missingBuyingPriceInflight = (async () => {
        const endStr = new Date().toISOString().slice(0, 10);
        const startStr = PumpSettings.getReceiptHistoryStart();

        const { data, error } = await supabaseClient
          .from("dsr")
          .select("id, date, product, receipts, buying_price_per_litre, supplier_invoice_no, supplier_gstin, invoice_document_id")
          .gte("date", startStr)
          .lte("date", endStr)
          .gt("receipts", 0)
          .or("buying_price_per_litre.is.null,buying_price_per_litre.lte.0")
          .order("date", { ascending: false });

        return { data: data ?? [], error };
      })().finally(() => {
        missingBuyingPriceInflight = null;
      });
    }
    return missingBuyingPriceInflight;
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
    fetchMissingBuyingPriceRows,
    fetchExpenses,
    fetchLubeSales,
    mergeDsrStock,
  };
})(typeof window !== "undefined" ? window : globalThis);
