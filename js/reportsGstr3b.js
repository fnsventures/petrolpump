/* global escapeHtml, formatNumberPlain, reportHeader, getGstr1Sections, getFuelPurchaseRows, gstr1FilingPeriod, cachedData, cachedRange */
/**
 * GSTR-3B style summary and portal-style JSON.
 */


function gstrMoney(n) {
  return Number(Number(n || 0).toFixed(2));
}

function gstrTaxBucket(txval = 0, iamt = 0, camt = 0, samt = 0, csamt = 0) {
  return {
    txval: gstrMoney(txval),
    iamt: gstrMoney(iamt),
    camt: gstrMoney(camt),
    samt: gstrMoney(samt),
    csamt: gstrMoney(csamt),
  };
}

/**
 * GSTR-3B summary figures from the same sources as GSTR-1 / purchase GST reports.
 */
function buildGstr3bSummary(data, range) {
  const g1 = getGstr1Sections(data, range);
  const purchase = getFuelPurchaseRows(data, range);

  let billingNil = 0;
  let billingNonGst = 0;
  if (g1.includeBilling) {
    (data.invoices || []).forEach((inv) => {
      billingNil += Number(inv.nil_rate_total ?? 0);
      billingNonGst += Number(inv.non_gst_total ?? 0);
    });
  }

  const osupDet = gstrTaxBucket(
    (g1.b2bTotals.taxable || 0) + (g1.b2csTotals.taxable || 0),
    (g1.b2bTotals.igst || 0) + (g1.b2csTotals.igst || 0),
    (g1.b2bTotals.cgst || 0) + (g1.b2csTotals.cgst || 0),
    (g1.b2bTotals.sgst || 0) + (g1.b2csTotals.sgst || 0),
    0
  );
  const osupNil = { txval: gstrMoney((g1.nilTotals.nilValue || 0) + billingNil) };
  const osupNongst = { txval: gstrMoney(billingNonGst) };
  const osupZero = gstrTaxBucket(0, 0, 0, 0, 0);
  const isupRev = gstrTaxBucket(0, 0, 0, 0, 0);

  // Table 3.2 — interstate B2CS (unregistered). POS not stored on invoices; omit rows when unknown.
  let interUnregTaxable = 0;
  let interUnregIgst = 0;
  g1.b2cs.forEach((row) => {
    const igst = Number(row.igst || 0);
    if (igst <= 0) return;
    interUnregTaxable += Number(row.taxable || 0);
    interUnregIgst += igst;
  });

  let itcIamt = 0;
  let itcCamt = 0;
  let itcSamt = 0;
  (purchase.detailRows || []).forEach((r) => {
    itcIamt += Number(r.igst || 0);
    itcCamt += Number(r.cgst || 0);
    itcSamt += Number(r.sgst || 0);
  });
  const itcOth = {
    ty: "OTH",
    iamt: gstrMoney(itcIamt),
    camt: gstrMoney(itcCamt),
    samt: gstrMoney(itcSamt),
    csamt: 0,
  };
  const itcZero = { iamt: 0, camt: 0, samt: 0, csamt: 0 };

  return {
    includeBilling: g1.includeBilling,
    retPeriod: gstr1FilingPeriod(range),
    osupDet,
    osupZero,
    osupNil,
    osupNongst,
    isupRev,
    interUnregTaxable: gstrMoney(interUnregTaxable),
    interUnregIgst: gstrMoney(interUnregIgst),
    itcOth,
    itcNet: {
      iamt: itcOth.iamt,
      camt: itcOth.camt,
      samt: itcOth.samt,
      csamt: 0,
    },
    itcZero,
    purchaseMissingBuying: purchase.missingBuyingCount || 0,
    purchaseLineCount: (purchase.detailRows || []).length,
    g1,
  };
}

function renderGstr3bRegister(data, range) {
  const s = getGstr3bSummary(data, range);
  const billingNote = s.includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices excluded (enable in Settings → Billing). Fuel NIL still included in 3.1(c).</p>`;
  const purchaseNote =
    s.purchaseMissingBuying > 0
      ? `<p class="report-note warning">${s.purchaseMissingBuying} fuel receipt(s) missing buying price — excluded from Table 4 ITC.</p>`
      : "";

  const row3_1 = (code, label, bucket, showTax = true) => {
    if (showTax) {
      return `<tr>
        <td>${escapeHtml(code)}</td>
        <td>${escapeHtml(label)}</td>
        <td class="num">${formatNumberPlain(bucket.txval)}</td>
        <td class="num">${formatNumberPlain(bucket.iamt)}</td>
        <td class="num">${formatNumberPlain(bucket.camt)}</td>
        <td class="num">${formatNumberPlain(bucket.samt)}</td>
        <td class="num">${formatNumberPlain(bucket.csamt || 0)}</td>
      </tr>`;
    }
    return `<tr>
      <td>${escapeHtml(code)}</td>
      <td>${escapeHtml(label)}</td>
      <td class="num">${formatNumberPlain(bucket.txval)}</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">—</td>
    </tr>`;
  };

  const interNote =
    s.interUnregIgst > 0
      ? `<p class="report-note warning">Interstate B2CS found (taxable ${formatNumberPlain(
          s.interUnregTaxable
        )}, IGST ${formatNumberPlain(
          s.interUnregIgst
        )}). Place of supply is not stored on cash invoices — enter Table 3.2 POS manually on the portal / offline tool.</p>`
      : `<p class="report-note muted">No interstate B2CS (unregistered) detected in this period.</p>`;

  return `
    ${reportHeader("GSTR-3B style summary", range.start, range.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-3B — not a guaranteed GST portal upload. Figures roll up from DSR fuel (NIL) and billing invoices; ITC from fuel receipt VAT.</p>
    ${billingNote}
    <section class="report-gst-section">
      <h3 class="report-section-title">3.1 — Outward supplies &amp; inward liable to reverse charge</h3>
      <table class="report-table report-gst-detail">
        <thead>
          <tr>
            <th>Nature</th><th>Particulars</th>
            <th class="num">Taxable</th><th class="num">IGST</th>
            <th class="num">CGST</th><th class="num">SGST</th><th class="num">Cess</th>
          </tr>
        </thead>
        <tbody>
          ${row3_1("(a)", "Outward taxable supplies (other than zero / nil / exempt)", s.osupDet)}
          ${row3_1("(b)", "Outward taxable supplies (zero rated)", s.osupZero)}
          ${row3_1("(c)", "Other outward supplies (nil rated, exempted)", s.osupNil, false)}
          ${row3_1("(d)", "Inward supplies liable to reverse charge", s.isupRev)}
          ${row3_1("(e)", "Non-GST outward supplies", s.osupNongst, false)}
        </tbody>
      </table>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">3.2 — Inter-state supplies to unregistered / composition / UIN</h3>
      ${interNote}
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">4 — Eligible ITC (from fuel receipts)</h3>
      <table class="report-table report-gst-detail">
        <thead>
          <tr>
            <th>Details</th><th class="num">IGST</th><th class="num">CGST</th>
            <th class="num">SGST</th><th class="num">Cess</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>(A) ITC Available — Other (OTH) · ${s.purchaseLineCount} receipt line(s)</td>
            <td class="num">${formatNumberPlain(s.itcOth.iamt)}</td>
            <td class="num">${formatNumberPlain(s.itcOth.camt)}</td>
            <td class="num">${formatNumberPlain(s.itcOth.samt)}</td>
            <td class="num">${formatNumberPlain(s.itcOth.csamt)}</td>
          </tr>
          <tr class="report-total-row">
            <td><strong>(C) Net ITC available</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.iamt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.camt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.samt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(s.itcNet.csamt)}</strong></td>
          </tr>
        </tbody>
      </table>
      ${purchaseNote}
      <p class="report-note muted">Import / ISD / RCM ITC and reversals are not tracked here — leave those rows blank or fill from books.</p>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">5 — Exempt / nil / non-GST inward</h3>
      <p class="report-note muted">Not auto-filled (composition / exempt inward not tracked). Leave zeros unless you have separate purchase books.</p>
    </section>
    <p class="report-note muted">Use <strong>Download GSTR-3B JSON</strong> for an offline-utility-style summary file. Verify every figure before portal upload.</p>`;
}

/**
 * Offline GSTR-3B-style JSON (aid for portal tools — verify before upload).
 */
function buildGstr3bJson(data, range) {
  const s = getGstr3bSummary(data, range);
  const gstin = (PumpSettings.getStationGstin?.() || PumpSettings.getCachedSync().station?.gstin || "")
    .trim()
    .toUpperCase();

  const zeroTy = (ty) => ({ ty, ...s.itcZero });

  return {
    gstin: gstin || null,
    ret_period: s.retPeriod,
    sup_details: {
      osup_det: s.osupDet,
      osup_zero: { txval: s.osupZero.txval, iamt: s.osupZero.iamt, csamt: s.osupZero.csamt },
      osup_nil_exmp: s.osupNil,
      isup_rev: s.isupRev,
      osup_nongst: s.osupNongst,
    },
    inter_sup: {
      unreg_details: [],
      comp_details: [],
      uin_details: [],
    },
    eco_dtls: {
      eco_sup: gstrTaxBucket(0),
      eco_reg_sup: { txval: 0 },
    },
    itc_elg: {
      itc_avl: [
        zeroTy("IMPG"),
        zeroTy("IMPS"),
        zeroTy("ISRC"),
        zeroTy("ISD"),
        { ...s.itcOth },
      ],
      itc_rev: [zeroTy("RUL"), zeroTy("OTH")],
      itc_net: s.itcNet,
      itc_inelg: [zeroTy("RUL"), zeroTy("OTH")],
    },
    inward_sup: {
      isup_details: [
        { ty: "GST", inter: 0, intra: 0 },
        { ty: "NONGST", inter: 0, intra: 0 },
      ],
    },
    intr_ltfee: {
      intr_details: { iamt: 0, camt: 0, samt: 0, csamt: 0 },
      ltfee_details: { camt: 0, samt: 0 },
    },
    _meta: {
      note: "Internal aid for GSTR-3B filing tools. Verify every figure before portal upload. Table 3.2 POS omitted when unknown.",
      range: { start: range.start, end: range.end },
      generatedAt: new Date().toISOString(),
      interUnregTaxable: s.interUnregTaxable,
      interUnregIgst: s.interUnregIgst,
      purchaseLineCount: s.purchaseLineCount,
      purchaseMissingBuying: s.purchaseMissingBuying,
      includeBilling: s.includeBilling,
    },
  };
}

function downloadGstr3bJson() {
  if (!cachedData || !cachedRange) return;
  const payload = buildGstr3bJson(cachedData, cachedRange);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const start = cachedRange.start.replace(/-/g, "");
  const end = cachedRange.end.replace(/-/g, "");
  a.href = url;
  a.download = `gstr3b_${payload.ret_period || `${start}_${end}`}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
