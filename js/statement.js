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

  function setText(id, text) {
    const el = document.getElementById(id);
    el.textContent = text || "";
    el.hidden = !text;
  }

  /** cells: strings, or { text, cls } for a styled cell. The last numCols columns are right-aligned. */
  function table(headers, rows, { numCols = 1, empty = "None." } = {}) {
    if (!rows.length) return `<p class="statement-muted">${escapeHtml(empty)}</p>`;
    const numFrom = headers.length - numCols;
    const cellCls = (i, extra) => {
      const cls = [i >= numFrom ? "num" : "", extra || ""].filter(Boolean).join(" ");
      return cls ? ` class="${cls}"` : "";
    };
    const head = headers
      .map((h, i) => {
        const cell = typeof h === "object" && h ? h : { text: h };
        return `<th${cellCls(i, cell.cls)}>${escapeHtml(cell.text)}</th>`;
      })
      .join("");
    const body = rows
      .map(
        (cells) =>
          `<tr>${cells
            .map((c, i) => {
              const cell = typeof c === "object" && c ? c : { text: c };
              return `<td${cellCls(i, cell.cls)}>${escapeHtml(cell.text)}</td>`;
            })
            .join("")}</tr>`
      )
      .join("");
    return `<div class="statement-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function signedMoney(value) {
    const n = Number(value) || 0;
    return n < 0 ? `${money(Math.abs(n))} Cr` : money(n);
  }

  function litres(q) {
    const n = Number(q);
    return Number.isFinite(n) && n > 0 ? `${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} L` : "";
  }

  /** Older statement payloads have credits/payments but no lines; build lines without a running balance. */
  function legacyLines(s) {
    return [
      ...(s.credits || []).map((c) => ({ ...c, kind: c.opening ? "opening" : "fuel" })),
      ...(s.payments || []).map((p) => ({ ...p, kind: "payment", amount: -Number(p.amount || 0) })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function render(s) {
    const station = s.station || { name: s.station_name };
    document.title = `Statement · ${s.customer_name} · ${station.name || "Bishnupriya Fuels"}`;
    setText("statement-station", station.name);
    setText("statement-tagline", station.tagline);
    setText("statement-address", [station.address, station.gstin ? `GSTIN: ${station.gstin}` : ""].filter(Boolean).join(" · "));
    const contact = [station.mobile, station.email].filter(Boolean).join(" · ");
    setText("statement-contact", contact);
    document.getElementById("statement-foot-contact").textContent = station.mobile ? ` on ${station.mobile}` : "";

    document.getElementById("statement-customer").textContent = s.customer_name;
    document.getElementById("statement-date").textContent = day(s.as_of);
    document.getElementById("statement-period").textContent = `${day(s.from)} – ${day(s.as_of)}`;

    const balance = Number(s.balance) || 0;
    const balanceBox = document.querySelector(".statement-balance");
    balanceBox.classList.toggle("is-advance", balance < 0);
    balanceBox.classList.toggle("is-clear", Math.abs(balance) < 0.005);
    document.getElementById("statement-balance-label").textContent =
      balance < 0 ? "Advance with us" : Math.abs(balance) < 0.005 ? "No amount due" : "Amount due";
    document.getElementById("statement-balance").textContent = money(Math.abs(balance));

    const lines = Array.isArray(s.lines) ? s.lines : legacyLines(s);
    const hasRunning = Array.isArray(s.lines);
    const billed = s.period_billed ?? lines.filter((l) => l.kind !== "payment").reduce((t, l) => t + Number(l.amount || 0), 0);
    const paid = s.period_paid ?? -lines.filter((l) => l.kind === "payment").reduce((t, l) => t + Number(l.amount || 0), 0);
    document.getElementById("statement-sum-opening").textContent = signedMoney(s.opening_balance);
    document.getElementById("statement-sum-billed").textContent = money(billed);
    document.getElementById("statement-sum-paid").textContent = money(paid);

    const openBills = s.open_bills || [];
    const openTotal = openBills.reduce((t, b) => t + Number(b.open || 0), 0);
    const openRows = openBills.map((b) => [
      day(b.date),
      { text: `${b.age_days} days`, cls: b.age_days > 30 ? "is-overdue" : "" },
      money(b.amount ?? b.open),
      money(b.open),
    ]);
    if (openRows.length > 1) {
      openRows.push([{ text: "Total", cls: "is-total" }, { text: "", cls: "is-total" }, { text: "", cls: "is-total" }, { text: money(openTotal), cls: "is-total" }]);
    }
    document.getElementById("statement-open").innerHTML = table(["Bill date", "Age", "Bill amount", "Unpaid"], openRows, {
      numCols: 2,
      empty: "No unpaid bills.",
    });

    // Phones show one signed Amount column (col-phone); wider screens and print show Debit / Credit (col-wide).
    const actHeaders = [
      "Date",
      "Details",
      { text: "Amount", cls: "col-phone" },
      { text: "Debit", cls: "col-wide" },
      { text: "Credit", cls: "col-wide" },
      ...(hasRunning ? ["Balance"] : []),
    ];
    const detail = (l) => {
      if (l.kind === "opening") return "Opening balance";
      if (l.kind === "payment") return `Payment received${l.mode ? ` · ${l.mode}` : ""}`;
      const qty = litres(l.quantity);
      return `Fuel · ${l.fuel_type}${qty ? ` · ${qty}` : ""}`;
    };
    const actRows = [
      [
        day(s.from),
        "Brought forward",
        { text: hasRunning ? "" : signedMoney(s.opening_balance), cls: "col-phone" },
        { text: "", cls: "col-wide" },
        { text: "", cls: "col-wide" },
        ...(hasRunning ? [signedMoney(s.opening_balance)] : []),
      ],
      ...lines.map((l) => {
        const amt = Number(l.amount) || 0;
        return [
          day(l.date),
          detail(l),
          { text: amt < 0 ? `− ${money(-amt)}` : money(amt), cls: "col-phone" },
          { text: amt > 0 ? money(amt) : "", cls: "col-wide" },
          { text: amt < 0 ? money(-amt) : "", cls: "col-wide" },
          ...(hasRunning ? [signedMoney(l.balance)] : []),
        ];
      }),
    ];
    document.getElementById("statement-activity").innerHTML = table(actHeaders, actRows, { numCols: hasRunning ? 4 : 3 });

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
