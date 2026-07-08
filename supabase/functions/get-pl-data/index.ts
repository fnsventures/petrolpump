// Supabase Edge Function: get-pl-data
// Bundles DSR (with receipt-history split), expenses, and lube sales for dashboard P&L.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DSR_SELECT_PL =
  "id, date, product, total_sales, testing, petrol_rate, diesel_rate, receipts, buying_price_per_litre";
const DSR_SELECT_RECEIPT = "date, product, receipts, buying_price_per_litre";
const DEFAULT_RECEIPT_HISTORY_START = "2000-01-01";

interface PlRequest {
  startDate: string;
  endDate: string;
  receiptHistoryStart?: string;
}

interface DsrRow {
  id?: string;
  date: string;
  product: string;
  total_sales?: number | null;
  testing?: number | null;
  petrol_rate?: number | null;
  diesel_rate?: number | null;
  receipts?: number | null;
  buying_price_per_litre?: number | null;
}

interface PlResponse {
  dsrRows: DsrRow[];
  receiptRows: DsrRow[];
  expenseRows: unknown[] | null;
  lubeSales: number;
  errors: {
    dsr: string | null;
    expense: string | null;
    lube: string | null;
  };
}

function extractReceiptRows(rows: DsrRow[]) {
  return (rows ?? [])
    .filter((row) => {
      if (Number(row.receipts ?? 0) <= 0) return false;
      const rate = Number(row.buying_price_per_litre);
      return Number.isFinite(rate) && rate > 0;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDsrBundle(supabase: any, startDate: string, endDate: string, receiptStart: string) {
  if (receiptStart < startDate) {
    const [rangeResult, receiptResult] = await Promise.all([
      supabase
        .from("dsr")
        .select(DSR_SELECT_PL)
        .gte("date", startDate)
        .lte("date", endDate)
        .order("date", { ascending: true }),
      supabase
        .from("dsr")
        .select(DSR_SELECT_RECEIPT)
        .gte("date", receiptStart)
        .lt("date", startDate)
        .gt("receipts", 0)
        .gt("buying_price_per_litre", 0)
        .order("date", { ascending: true }),
    ]);

    const error = rangeResult.error ?? receiptResult.error;
    if (error) {
      return { dsrRows: null, receiptRows: null, error: error.message as string };
    }

    const rangeRows = (rangeResult.data ?? []) as DsrRow[];
    const allDsr = [...((receiptResult.data ?? []) as DsrRow[]), ...rangeRows];
    return {
      dsrRows: rangeRows,
      receiptRows: extractReceiptRows(allDsr),
      error: null,
    };
  }

  const { data, error } = await supabase
    .from("dsr")
    .select(DSR_SELECT_PL)
    .gte("date", receiptStart)
    .lte("date", endDate)
    .order("date", { ascending: true });

  if (error) {
    return { dsrRows: null, receiptRows: null, error: error.message as string };
  }

  const allDsr = (data ?? []) as DsrRow[];
  return {
    dsrRows: allDsr.filter((row) => row.date >= startDate && row.date <= endDate),
    receiptRows: extractReceiptRows(allDsr),
    error: null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { startDate, endDate, receiptHistoryStart }: PlRequest = await req.json();

    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "startDate and endDate are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const receiptStart = receiptHistoryStart || DEFAULT_RECEIPT_HISTORY_START;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const [dsrBundle, expenseResult, invoiceResult] = await Promise.all([
      fetchDsrBundle(supabase, startDate, endDate, receiptStart),
      supabase
        .from("expenses")
        .select("date, category, amount")
        .gte("date", startDate)
        .lte("date", endDate),
      supabase
        .from("invoices")
        .select("invoice_date, total_amount")
        .gte("invoice_date", startDate)
        .lte("invoice_date", endDate),
    ]);

    let lubeSales = 0;
    if (!invoiceResult.error) {
      lubeSales = (invoiceResult.data ?? []).reduce(
        (sum: number, row: { total_amount?: number | null }) =>
          sum + Number(row.total_amount ?? 0),
        0
      );
    }

    const response: PlResponse = {
      dsrRows: dsrBundle.dsrRows ?? [],
      receiptRows: dsrBundle.receiptRows ?? [],
      expenseRows: expenseResult.data,
      lubeSales,
      errors: {
        dsr: dsrBundle.error,
        expense: expenseResult.error?.message ?? null,
        lube: invoiceResult.error?.message ?? null,
      },
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
