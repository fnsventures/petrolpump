/**
 * Public read-only credit statement (statement.html#t=<token>). No login, no app scripts:
 * POSTs the token to the credit-statement Edge Function with the anon key.
 * The token is in the fragment so it is never sent to the web server.
 */
(function () {
  const CONFIG = window.__APP_CONFIG__ || {};
  const BAD_LINK = "This link is not valid or has expired. Ask the station for a new one.";

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function money(value) {
    return "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function day(dateStr) {
    const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  function setStatus(text, isError) {
    const el = document.getElementById("statement-status");
    el.hidden = !text;
    el.textContent = text || "";
    el.classList.toggle("is-error", Boolean(isError));
  }

  function table(headers, rows) {
    if (!rows.length) return `<p class="statement-muted">None.</p>`;
    const head = headers.map((h, i) => `<th${i === headers.length - 1 ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("");
    const body = rows
      .map((cells) => `<tr>${cells.map((c, i) => `<td${i === cells.length - 1 ? ' class="num"' : ""}>${escapeHtml(c)}</td>`).join("")}</tr>`)
      .join("");
    return `<div class="statement-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function render(s) {
    document.title = `Statement · ${s.customer_name}`;
    document.getElementById("statement-station").textContent = s.station_name;
    document.getElementById("statement-customer").textContent = s.customer_name;
    document.getElementById("statement-period").textContent = `As on ${day(s.as_of)}`;

    const balance = Number(s.balance) || 0;
    document.getElementById("statement-balance-label").textContent = balance < 0 ? "Advance with us" : "Outstanding";
    document.getElementById("statement-balance").textContent = money(Math.abs(balance));

    document.getElementById("statement-open").innerHTML = table(
      ["Bill date", "Age", "Open"],
      (s.open_bills || []).map((b) => [day(b.date), `${b.age_days} days`, money(b.open)])
    );

    const lines = [
      ...(s.credits || []).map((c) => ({
        date: c.date,
        text: c.opening ? "Opening balance" : `Fuel (${c.fuel_type})`,
        amount: money(c.amount),
      })),
      ...(s.payments || []).map((p) => ({
        date: p.date,
        text: `Payment${p.mode ? ` · ${p.mode}` : ""}`,
        amount: `− ${money(p.amount)}`,
      })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const opening = Number(s.opening_balance) || 0;
    const rows = [[day(s.from), "Brought forward", money(opening)], ...lines.map((l) => [day(l.date), l.text, l.amount])];
    document.getElementById("statement-activity").innerHTML = table(["Date", "Details", "Amount"], rows);

    document.getElementById("statement-expiry").textContent = `Link valid until ${new Date(s.expires_at).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}.`;
    setStatus("");
    document.getElementById("statement-body").hidden = false;
  }

  async function load() {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("t") || "";
    if (!/^[0-9a-f]{64}$/i.test(token) || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
      setStatus(BAD_LINK, true);
      return;
    }
    try {
      const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/credit-statement`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ token }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 404) return setStatus(BAD_LINK, true);
      if (!res.ok || !payload.statement) throw new Error(payload.error || `HTTP ${res.status}`);
      render(payload.statement);
    } catch (err) {
      setStatus("Could not load the statement. Check your connection and try again.", true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("statement-print").addEventListener("click", () => window.print());
    void load();
  });
})();
