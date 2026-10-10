/* global escapeHtml, formatNumericDate, formatNumberPlain, fuelRowClass, PumpSettings, reportHeader, isBillingIncludedInGstReports, buildFuelSalesDailyInvoices, invoiceHeaderTaxable, getGstr1Sections, cachedData, cachedRange */
/**
 * GSTR-1 style register, CSV, and portal-style JSON.
 */


/**
 * GSTR-1 style outward register: B2B (GSTIN), B2CS (no GSTIN billing), NIL (fuel SFC).
 */
function buildGstr1Sections(data, range) {
  const includeBilling = isBillingIncludedInGstReports();
  const fuelInvoices = buildFuelSalesDailyInvoices(data.dsrRows, range);
  const nilRows = fuelInvoices.map((line) => ({
    date: line.date,
    invoiceNumber: line.invoiceNumber,
    party: line.partyName,
    gstin: "",
    taxable: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    nilValue: Number(line.nilValue ?? line.gross ?? 0),
    gross: Number(line.gross ?? 0),
    product: line.productLabel,
  }));

  const b2b = [];
  const b2cs = [];
  if (includeBilling) {
    data.invoices.forEach((inv) => {
      const gstin = (inv.party_gstin || "").trim().toUpperCase();
      const cgst = Number(inv.cgst_total ?? 0);
      const sgst = Number(inv.sgst_total ?? 0);
      const igst = Number(inv.igst_total ?? 0);
      const nonGst = Number(inv.non_gst_total ?? 0);
      const nilRate = Number(inv.nil_rate_total ?? 0);
      const taxable = invoiceHeaderTaxable(inv);
      const row = {
        date: inv.invoice_date,
        invoiceNumber: inv.invoice_number,
        party: inv.party_name,
        gstin,
        taxable,
        cgst,
        sgst,
        igst,
        nilValue: nonGst + nilRate,
        gross: Number(inv.total_amount ?? 0),
      };
      if (gstin.length >= 15) b2b.push(row);
      else b2cs.push(row);
    });
  }

  const sumRows = (rows, keys) =>
    rows.reduce((acc, r) => {
      keys.forEach((k) => {
        acc[k] = (acc[k] || 0) + Number(r[k] || 0);
      });
      return acc;
    }, {});

  return {
    includeBilling,
    nilRows,
    b2b,
    b2cs,
    nilTotals: sumRows(nilRows, ["nilValue", "gross"]),
    b2bTotals: sumRows(b2b, ["taxable", "cgst", "sgst", "igst", "gross"]),
    b2csTotals: sumRows(b2cs, ["taxable", "cgst", "sgst", "igst", "nilValue", "gross"]),
  };
}

function renderGstr1Table(title, subtitle, headers, rowsHtml, footHtml) {
  return `
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(title)}</h3>
      <p class="report-subtitle muted">${subtitle}</p>
      <table class="report-table report-gst-detail">
        <thead><tr>${headers}</tr></thead>
        <tbody>${rowsHtml}</tbody>
        ${footHtml || ""}
      </table>
    </section>`;
}

function renderGstr1Register(data, range) {
  const g = getGstr1Sections(data, range);
  const billingNote = g.includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices excluded (enable in Settings → Billing). Fuel NIL section still included.</p>`;

  const nilBody =
    g.nilRows
      .map((r) => {
        const prod = String(r.product || "").toLowerCase().includes("diesel") ? "diesel" : "petrol";
        return `<tr class="${fuelRowClass(prod)}">
      <td>${formatNumericDate(r.date)}</td>
      <td>${escapeHtml(r.invoiceNumber)}</td>
      <td>${escapeHtml(r.product || "Fuel")}</td>
      <td class="num">${formatNumberPlain(r.nilValue)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`;
      })
      .join("") || `<tr><td colspan="5" class="muted">No fuel sales in this period</td></tr>`;

  const nilFoot = g.nilRows.length
    ? `<tfoot><tr class="report-total-row">
        <td colspan="3"><strong>NIL total (${g.nilRows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(g.nilTotals.nilValue)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(g.nilTotals.gross)}</strong></td>
      </tr></tfoot>`
    : "";

  const billHeaders = `
    <th>Date</th><th>Invoice</th><th>Party</th><th>GSTIN</th>
    <th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th>
    <th class="num">IGST</th><th class="num">Exempt/NIL</th><th class="num">Gross</th>`;

  const mapBillRows = (rows) =>
    rows
      .map(
        (r) => `<tr>
      <td>${formatNumericDate(r.date)}</td>
      <td>${escapeHtml(r.invoiceNumber)}</td>
      <td>${escapeHtml(r.party)}</td>
      <td>${escapeHtml(r.gstin || "—")}</td>
      <td class="num">${formatNumberPlain(r.taxable)}</td>
      <td class="num">${formatNumberPlain(r.cgst)}</td>
      <td class="num">${formatNumberPlain(r.sgst)}</td>
      <td class="num">${formatNumberPlain(r.igst)}</td>
      <td class="num">${formatNumberPlain(r.nilValue)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="10" class="muted">No invoices in this section</td></tr>`;

  const billFoot = (rows, totals) =>
    rows.length
      ? `<tfoot><tr class="report-total-row">
        <td colspan="4"><strong>Total (${rows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.taxable)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.cgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.sgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.igst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.nilValue || 0)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(totals.gross)}</strong></td>
      </tr></tfoot>`
      : "";

  return `
    ${reportHeader("GSTR-1 style outward register", range.start, range.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-1 — not a GST portal JSON upload. Sections mirror B2B, B2CS and NIL rated fuel (SFC).</p>
    ${billingNote}
    ${renderGstr1Table(
      "4A/4B — B2B (registered party GSTIN)",
      "Billing invoices with a 15-character party GSTIN.",
      billHeaders,
      mapBillRows(g.b2b),
      billFoot(g.b2b, g.b2bTotals)
    )}
    ${renderGstr1Table(
      "7 — B2CS (unregistered / Cash)",
      "Billing invoices without a party GSTIN.",
      billHeaders,
      mapBillRows(g.b2cs),
      billFoot(g.b2cs, g.b2csTotals)
    )}
    ${renderGstr1Table(
      "8 — NIL rated (fuel SFC)",
      "Daily fuel outward vouchers from DSR (NIL rate).",
      `<th>Date</th><th>Invoice</th><th>Product</th><th class="num">NIL value</th><th class="num">Gross</th>`,
      nilBody,
      nilFoot
    )}
    <p class="report-note muted">Use <strong>Download CSV</strong> for a flat file you can reconcile in Excel. Portal filing still requires the official GST offline tool / API.</p>`;
}

function buildGstr1Csv(data, range) {
  const g = getGstr1Sections(data, range);
  const lines = [
    ["section", "date", "invoice", "party", "gstin", "product", "taxable", "cgst", "sgst", "igst", "nil_value", "gross"].join(
      ","
    ),
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const push = (section, r) => {
    lines.push(
      [
        section,
        r.date,
        r.invoiceNumber,
        r.party || "",
        r.gstin || "",
        r.product || "",
        r.taxable ?? "",
        r.cgst ?? "",
        r.sgst ?? "",
        r.igst ?? "",
        r.nilValue ?? "",
        r.gross ?? "",
      ]
        .map(esc)
        .join(",")
    );
  };
  g.b2b.forEach((r) => push("B2B", r));
  g.b2cs.forEach((r) => push("B2CS", r));
  g.nilRows.forEach((r) => push("NIL", r));
  return lines.join("\n");
}

function downloadGstr1Csv() {
  if (!cachedData || !cachedRange) return;
  const csv = buildGstr1Csv(cachedData, cachedRange);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const start = cachedRange.start.replace(/-/g, "");
  const end = cachedRange.end.replace(/-/g, "");
  a.href = url;
  a.download = `gstr1-register_${start}_${end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatGstr1PortalDate(isoDate) {
  if (!isoDate || String(isoDate).length < 10) return "";
  const [y, m, d] = String(isoDate).slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

function gstr1FilingPeriod(range) {
  const end = String(range?.end || "").slice(0, 10);
  if (end.length < 7) return "";
  const [y, m] = end.split("-");
  return `${m}${y}`;
}

function gstr1StateCodeFromGstin(gstin) {
  const g = String(gstin || "").trim().toUpperCase();
  return g.length >= 2 ? g.slice(0, 2) : "";
}

function gstr1InvoiceRate(row) {
  const taxable = Number(row.taxable || 0);
  if (taxable <= 0) return 0;
  const tax = Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0);
  const pct = (tax / taxable) * 100;
  if (pct < 3) return 0;
  if (pct < 8) return 5;
  if (pct < 15) return 12;
  if (pct < 21) return 18;
  if (pct < 26) return 24;
  return 28;
}

/**
 * Offline GSTR-1-style JSON (aid for portal tools — verify before upload).
 */
function buildGstr1Json(data, range) {
  const g = getGstr1Sections(data, range);
  const gstin = (PumpSettings.getStationGstin?.() || PumpSettings.getCachedSync().station?.gstin || "")
    .trim()
    .toUpperCase();
  const pos = gstr1StateCodeFromGstin(gstin) || "21";
  const fp = gstr1FilingPeriod(range);

  const b2bByCtin = new Map();
  g.b2b.forEach((row) => {
    const ctin = String(row.gstin || "").trim().toUpperCase();
    if (!b2bByCtin.has(ctin)) b2bByCtin.set(ctin, []);
    const rt = gstr1InvoiceRate(row);
    const itmDet = {
      txval: Number(Number(row.taxable || 0).toFixed(2)),
      rt,
    };
    if (Number(row.igst || 0) > 0) itmDet.iamt = Number(Number(row.igst).toFixed(2));
    else {
      itmDet.camt = Number(Number(row.cgst || 0).toFixed(2));
      itmDet.samt = Number(Number(row.sgst || 0).toFixed(2));
    }
    b2bByCtin.get(ctin).push({
      inum: row.invoiceNumber,
      idt: formatGstr1PortalDate(row.date),
      val: Number(Number(row.gross || 0).toFixed(2)),
      pos: gstr1StateCodeFromGstin(ctin) || pos,
      rchrg: "N",
      inv_typ: "R",
      itms: [{ num: 1, itm_det: itmDet }],
    });
  });

  const b2b = Array.from(b2bByCtin.entries()).map(([ctin, inv]) => ({ ctin, inv }));

  const b2csMap = new Map();
  g.b2cs.forEach((row) => {
    const rt = gstr1InvoiceRate(row);
    const inter = Number(row.igst || 0) > 0;
    const key = `${inter ? "INTER" : "INTRA"}|${pos}|${rt}`;
    if (!b2csMap.has(key)) {
      b2csMap.set(key, {
        sply_ty: inter ? "INTER" : "INTRA",
        pos,
        typ: "OE",
        txval: 0,
        rt,
        iamt: 0,
        camt: 0,
        samt: 0,
        csamt: 0,
      });
    }
    const agg = b2csMap.get(key);
    agg.txval += Number(row.taxable || 0);
    agg.iamt += Number(row.igst || 0);
    agg.camt += Number(row.cgst || 0);
    agg.samt += Number(row.sgst || 0);
  });
  const b2cs = Array.from(b2csMap.values()).map((r) => ({
    ...r,
    txval: Number(r.txval.toFixed(2)),
    iamt: Number(r.iamt.toFixed(2)),
    camt: Number(r.camt.toFixed(2)),
    samt: Number(r.samt.toFixed(2)),
  }));

  const nilAmt = Number((g.nilTotals.nilValue || 0).toFixed(2));
  const nil = {
    inv: [
      {
        sply_ty: "INTRB2C",
        expt_amt: 0,
        nil_amt: nilAmt,
        ngsup_amt: 0,
      },
    ],
  };

  const docSeries = (rows, docTyp) => {
    if (!rows.length) return null;
    const nums = rows.map((r) => String(r.invoiceNumber || "")).filter(Boolean).sort();
    return {
      doc_num: docTyp,
      docs: [
        {
          num: 1,
          from: nums[0],
          to: nums[nums.length - 1],
          totnum: nums.length,
          cancel: 0,
          net_issue: nums.length,
        },
      ],
    };
  };

  const docDet = [];
  const billingDocs = [...g.b2b, ...g.b2cs];
  const billingSeries = docSeries(billingDocs, 1);
  if (billingSeries) docDet.push(billingSeries);
  const nilSeries = docSeries(g.nilRows, 4);
  if (nilSeries) docDet.push(nilSeries);

  return {
    gstin: gstin || null,
    fp,
    version: "GST3.1.6",
    hash: "hash",
    b2b,
    b2cs,
    nil,
    doc_issue: { doc_det: docDet },
    _meta: {
      note: "Internal aid for GSTR-1 filing tools. Verify every figure before portal upload.",
      range: { start: range.start, end: range.end },
      generatedAt: new Date().toISOString(),
      fuelNilCount: g.nilRows.length,
      b2bCount: g.b2b.length,
      b2csCount: g.b2cs.length,
    },
  };
}

function downloadGstr1Json() {
  if (!cachedData || !cachedRange) return;
  const payload = buildGstr1Json(cachedData, cachedRange);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const start = cachedRange.start.replace(/-/g, "");
  const end = cachedRange.end.replace(/-/g, "");
  a.href = url;
  a.download = `gstr1_${payload.fp || `${start}_${end}`}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
