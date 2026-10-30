// Supabase Edge Function: credit-statement
// Public read-only customer statement for a link made by create_credit_statement_link.
// Called from statement.html with the anon key (no login). The token is the only secret:
// get_credit_statement_by_token checks hash, expiry and revocation, and runs as service_role
// because anon may execute no app function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { bindRequestCors, corsHeaders } from "../_shared/cors.ts";

const TOKEN_RE = /^[0-9a-f]{64}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  bindRequestCors(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "").trim().toLowerCase();
    // Same answer for a malformed, unknown, expired or revoked token.
    if (!TOKEN_RE.test(token)) {
      return json({ error: "This link is not valid or has expired." }, 404);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );
    const { data, error } = await supabase.rpc("get_credit_statement_by_token", { p_token: token });
    if (error) throw error;
    if (!data) {
      return json({ error: "This link is not valid or has expired." }, 404);
    }
    return json({ statement: data });
  } catch (error) {
    console.error("credit-statement", error instanceof Error ? error.message : error);
    return json({ error: "Could not load the statement. Try again later." }, 500);
  }
});
