// Supabase Edge Function: get-dashboard-data
// Combines multiple dashboard queries into a single round-trip
// This reduces latency by ~60-70% compared to multiple parallel API calls

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { bindRequestCors, corsHeaders } from "../_shared/cors.ts";

interface DashboardRequest {
  startDate: string;
  endDate: string;
}

interface DsrRow {
  date: string;
  product: string;
  total_sales: number | null;
  testing: number | null;
  stock: number | null;
  petrol_rate: number | null;
  diesel_rate: number | null;
}

interface StockRow {
  date: string;
  product: string;
  variation: number | null;
  dip_stock: number | null;
}

interface DashboardResponse {
  dsrData: DsrRow[] | null;
  stockData: StockRow[] | null;
  expenseData: null;
  creditData: null;
  expenseTotal: number | null;
  creditGiven: number | null;
  errors: {
    dsr: string | null;
    stock: string | null;
    expense: string | null;
    credit: string | null;
  };
}

Deno.serve(async (req: Request) => {
  bindRequestCors(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        {
          status: 401,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        }
      );
    }

    const { startDate, endDate }: DashboardRequest = await req.json();

    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "startDate and endDate are required" }),
        {
          status: 400,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const { data, error } = await supabase.rpc("get_dashboard_snapshot", {
      p_start: startDate,
      p_end: endDate,
    });
    if (error) throw new Error(error.message);
    const snap = (data || {}) as {
      dsrData?: DsrRow[];
      stockData?: StockRow[];
      expenseTotal?: number | null;
      creditGiven?: number | null;
    };

    const response: DashboardResponse = {
      dsrData: snap.dsrData ?? [],
      stockData: snap.stockData ?? [],
      expenseData: null,
      creditData: null,
      expenseTotal: snap.expenseTotal == null ? null : Number(snap.expenseTotal),
      creditGiven: snap.creditGiven == null ? null : Number(snap.creditGiven),
      errors: { dsr: null, stock: null, expense: null, credit: null },
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
