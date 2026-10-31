// Supabase Edge Function: weekly-credit-sms
// Weekly SMS to every credit customer who owes money, sent through an Android phone running
// SMS Gate (https://sms-gate.app, capcom6/android-sms-gateway) in Cloud mode.
// Called by .github/workflows/weekly-credit-sms.yml with the x-cron-secret header; no user login.
//
// Customers are grouped by name, as the ledger and statement are. Each group with a net balance
// of at least MIN_BALANCE gets one SMS per distinct mobile, with a new statement link
// (credit_statement_links row, created_by null). A group that already got a link from this job
// in the last 5 days is skipped, so a re-run in the same week does not text anyone twice.
// Body { "dry_run": true } lists who would be texted and sends nothing.
//
// Secrets (Supabase → Edge Functions → Secrets): CRON_SECRET, SMS_GATE_USERNAME,
// SMS_GATE_PASSWORD, SITE_URL. Optional: SMS_GATE_URL, MIN_BALANCE, MAX_SMS_PER_RUN,
// STATEMENT_LINK_DAYS, SMS_TEST_TO (staging: every SMS goes to this one number instead, max 3
// per run, because staging holds a copy of prod's real customers).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { fetchAll } from "../_shared/pageQuery.ts";
import { creditSmsText } from "../_shared/creditMessage.js";

const DEFAULT_GATE_URL = "https://api.sms-gate.app/3rdparty/v1/message";
const RESEND_GUARD_DAYS = 5;

type CustomerRow = {
  id: string;
  customer_name: string | null;
  mobile: string | null;
  amount_due: number | null;
  prepaid_balance: number | null;
};

type Group = { name: string; ids: string[]; mobiles: Set<string>; net: number };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Same rule as creditCustomerPhoneDigits in js/creditCustomer.js. */
function phoneE164(mobile: string | null): string {
  const digits = String(mobile || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+91${digits.slice(1)}`;
  return digits.length >= 11 ? `+${digits}` : "";
}

function istDisplayDate() {
  return new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function numEnv(name: string, fallback: number) {
  const n = Number(Deno.env.get(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return json({ error: "Forbidden" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;

  const gateUrl = Deno.env.get("SMS_GATE_URL") || DEFAULT_GATE_URL;
  const gateUser = Deno.env.get("SMS_GATE_USERNAME") || "";
  const gatePass = Deno.env.get("SMS_GATE_PASSWORD") || "";
  const siteUrl = (Deno.env.get("SITE_URL") || "").replace(/\/+$/, "");
  if (!siteUrl || (!dryRun && (!gateUser || !gatePass))) {
    return json({ error: "SITE_URL, SMS_GATE_USERNAME and SMS_GATE_PASSWORD must be set." }, 500);
  }
  const minBalance = numEnv("MIN_BALANCE", 1);
  const maxPerRun = numEnv("MAX_SMS_PER_RUN", 90);
  const linkDays = Math.min(90, numEnv("STATEMENT_LINK_DAYS", 14));
  const testTo = phoneE164(Deno.env.get("SMS_TEST_TO") || null);
  const runCap = testTo ? 3 : maxPerRun;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const { data: rows, error } = await fetchAll(() =>
      supabase
        .from("credit_customers")
        .select("id, customer_name, mobile, amount_due, prepaid_balance")
        .order("id")
    );
    if (error) throw error;

    const groups = new Map<string, Group>();
    for (const r of (rows ?? []) as CustomerRow[]) {
      const name = String(r.customer_name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const g = groups.get(key) ?? { name, ids: [], mobiles: new Set<string>(), net: 0 };
      g.ids.push(r.id);
      g.net += Number(r.amount_due || 0) - Number(r.prepaid_balance || 0);
      const phone = phoneE164(r.mobile);
      if (phone) g.mobiles.add(phone);
      groups.set(key, g);
    }

    const since = new Date(Date.now() - RESEND_GUARD_DAYS * 86400_000).toISOString();
    const { data: recent, error: recentErr } = await supabase
      .from("credit_statement_links")
      .select("credit_customer_id")
      .is("created_by", null)
      .gte("created_at", since);
    if (recentErr) throw recentErr;
    const recentlySent = new Set((recent ?? []).map((l) => l.credit_customer_id as string));

    const { data: settings } = await supabase.from("pump_settings").select("config").eq("id", 1).maybeSingle();
    const stationCfg =
      (settings?.config as { station?: { legalName?: string; tagline?: string; mobile?: string } } | null)?.station ?? {};
    // Same fallbacks as AppConfig.DEFAULT_STATION when settings leave a field blank.
    const station = {
      name: stationCfg.legalName,
      tagline: stationCfg.tagline || "Authorized Dealer — Bharat Petroleum Corporation Ltd.",
      mobile: stationCfg.mobile || "+91 96689 13299",
    };
    const asOn = istDisplayDate();

    const due = [...groups.values()]
      .filter((g) => Math.round(g.net * 100) / 100 >= minBalance && g.mobiles.size > 0)
      .sort((a, b) => b.net - a.net);

    const result = {
      dry_run: dryRun,
      test_to: testTo ? "set" : null,
      sent: [] as { name: string; phone: string; balance: number }[],
      skipped_recent: [] as string[],
      deferred_over_cap: [] as string[],
      failed: [] as { name: string; phone: string; error: string }[],
      no_mobile: [...groups.values()].filter((g) => g.net >= minBalance && g.mobiles.size === 0).map((g) => g.name),
    };

    let count = 0;
    for (const g of due) {
      if (g.ids.some((id) => recentlySent.has(id))) {
        result.skipped_recent.push(g.name);
        continue;
      }
      const phones = testTo ? new Set([testTo]) : g.mobiles;
      if (count + phones.size > runCap) {
        result.deferred_over_cap.push(g.name);
        continue;
      }
      const balance = Math.round(g.net * 100) / 100;
      if (dryRun) {
        for (const phone of phones) result.sent.push({ name: g.name, phone, balance });
        count += phones.size;
        continue;
      }

      const token = newToken();
      const { data: link, error: linkErr } = await supabase
        .from("credit_statement_links")
        .insert({
          credit_customer_id: g.ids[0],
          token_hash: await sha256Hex(token),
          expires_at: new Date(Date.now() + linkDays * 86400_000).toISOString(),
        })
        .select("id")
        .single();
      if (linkErr) throw linkErr;

      // Same wording as the SMS icon in the app (supabase/functions/_shared/creditMessage.js).
      const text = creditSmsText({
        station,
        customerName: g.name,
        amount: balance,
        asOn,
        url: `${siteUrl}/statement.html#t=${token}`,
        linkDays,
      });

      let delivered = 0;
      for (const phone of phones) {
        count += 1;
        try {
          const res = await fetch(gateUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Basic " + btoa(`${gateUser}:${gatePass}`),
            },
            body: JSON.stringify({ textMessage: { text }, phoneNumbers: [phone] }),
          });
          if (!res.ok) throw new Error(`SMS Gate ${res.status}: ${(await res.text()).slice(0, 200)}`);
          delivered += 1;
          result.sent.push({ name: g.name, phone, balance });
        } catch (err) {
          result.failed.push({ name: g.name, phone, error: err instanceof Error ? err.message : String(err) });
        }
      }
      // Nothing queued: drop the link so next run retries this customer.
      if (delivered === 0) {
        await supabase.from("credit_statement_links").delete().eq("id", link.id);
      }
    }

    return json(result, result.failed.length ? 207 : 200);
  } catch (error) {
    console.error("weekly-credit-sms", error instanceof Error ? error.message : error);
    return json({ error: "Weekly SMS run failed." }, 500);
  }
});
