function gstrMoney(r){return Number(Number(r||0).toFixed(2))}function gstrTaxBucket(r=0,s=0,t=0,a=0,e=0){return{txval:gstrMoney(r),iamt:gstrMoney(s),camt:gstrMoney(t),samt:gstrMoney(a),csamt:gstrMoney(e)}}function buildGstr3bSummary(r,s){const t=getGstr1Sections(r,s),a=getFuelPurchaseRows(r,s);let e=0,n=0;t.includeBilling&&(r.invoices||[]).forEach(i=>{e+=Number(i.nil_rate_total??0),n+=Number(i.non_gst_total??0)});const m=gstrTaxBucket((t.b2bTotals.taxable||0)+(t.b2csTotals.taxable||0),(t.b2bTotals.igst||0)+(t.b2csTotals.igst||0),(t.b2bTotals.cgst||0)+(t.b2csTotals.cgst||0),(t.b2bTotals.sgst||0)+(t.b2csTotals.sgst||0),0),l={txval:gstrMoney((t.nilTotals.nilValue||0)+e)},c={txval:gstrMoney(n)},o=gstrTaxBucket(0,0,0,0,0),d=gstrTaxBucket(0,0,0,0,0);let p=0,g=0;t.b2cs.forEach(i=>{const N=Number(i.igst||0);N<=0||(p+=Number(i.taxable||0),g+=N)});let b=0,h=0,f=0;(a.detailRows||[]).forEach(i=>{b+=Number(i.igst||0),h+=Number(i.cgst||0),f+=Number(i.sgst||0)});const u={ty:"OTH",iamt:gstrMoney(b),camt:gstrMoney(h),samt:gstrMoney(f),csamt:0},T={iamt:0,camt:0,samt:0,csamt:0};return{includeBilling:t.includeBilling,retPeriod:gstr1FilingPeriod(s),osupDet:m,osupZero:o,osupNil:l,osupNongst:c,isupRev:d,interUnregTaxable:gstrMoney(p),interUnregIgst:gstrMoney(g),itcOth:u,itcNet:{iamt:u.iamt,camt:u.camt,samt:u.samt,csamt:0},itcZero:T,purchaseMissingBuying:a.missingBuyingCount||0,purchaseLineCount:(a.detailRows||[]).length,g1:t}}function renderGstr3bRegister(r,s){const t=getGstr3bSummary(r,s),a=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL still included in 3.1(c).</p>',e=t.purchaseMissingBuying>0?`<p class="report-note warning">${t.purchaseMissingBuying} fuel receipt(s) missing buying price \u2014 excluded from Table 4 ITC.</p>`:"",n=(l,c,o,d=!0)=>d?`<tr>
        <td>${escapeHtml(l)}</td>
        <td>${escapeHtml(c)}</td>
        <td class="num">${formatNumberPlain(o.txval)}</td>
        <td class="num">${formatNumberPlain(o.iamt)}</td>
        <td class="num">${formatNumberPlain(o.camt)}</td>
        <td class="num">${formatNumberPlain(o.samt)}</td>
        <td class="num">${formatNumberPlain(o.csamt||0)}</td>
      </tr>`:`<tr>
      <td>${escapeHtml(l)}</td>
      <td>${escapeHtml(c)}</td>
      <td class="num">${formatNumberPlain(o.txval)}</td>
      <td class="num">\u2014</td>
      <td class="num">\u2014</td>
      <td class="num">\u2014</td>
      <td class="num">\u2014</td>
    </tr>`,m=t.interUnregIgst>0?`<p class="report-note warning">Interstate B2CS found (taxable ${formatNumberPlain(t.interUnregTaxable)}, IGST ${formatNumberPlain(t.interUnregIgst)}). Place of supply is not stored on cash invoices \u2014 enter Table 3.2 POS manually on the portal / offline tool.</p>`:'<p class="report-note muted">No interstate B2CS (unregistered) detected in this period.</p>';return`
    ${reportHeader("GSTR-3B style summary",s.start,s.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-3B \u2014 not a guaranteed GST portal upload. Figures roll up from DSR fuel (NIL) and billing invoices; ITC from fuel receipt VAT.</p>
    ${a}
    <section class="report-gst-section">
      <h3 class="report-section-title">3.1 \u2014 Outward supplies &amp; inward liable to reverse charge</h3>
      <table class="report-table report-gst-detail">
        <thead>
          <tr>
            <th>Nature</th><th>Particulars</th>
            <th class="num">Taxable</th><th class="num">IGST</th>
            <th class="num">CGST</th><th class="num">SGST</th><th class="num">Cess</th>
          </tr>
        </thead>
        <tbody>
          ${n("(a)","Outward taxable supplies (other than zero / nil / exempt)",t.osupDet)}
          ${n("(b)","Outward taxable supplies (zero rated)",t.osupZero)}
          ${n("(c)","Other outward supplies (nil rated, exempted)",t.osupNil,!1)}
          ${n("(d)","Inward supplies liable to reverse charge",t.isupRev)}
          ${n("(e)","Non-GST outward supplies",t.osupNongst,!1)}
        </tbody>
      </table>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">3.2 \u2014 Inter-state supplies to unregistered / composition / UIN</h3>
      ${m}
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">4 \u2014 Eligible ITC (from fuel receipts)</h3>
      <table class="report-table report-gst-detail">
        <thead>
          <tr>
            <th>Details</th><th class="num">IGST</th><th class="num">CGST</th>
            <th class="num">SGST</th><th class="num">Cess</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>(A) ITC Available \u2014 Other (OTH) \xB7 ${t.purchaseLineCount} receipt line(s)</td>
            <td class="num">${formatNumberPlain(t.itcOth.iamt)}</td>
            <td class="num">${formatNumberPlain(t.itcOth.camt)}</td>
            <td class="num">${formatNumberPlain(t.itcOth.samt)}</td>
            <td class="num">${formatNumberPlain(t.itcOth.csamt)}</td>
          </tr>
          <tr class="report-total-row">
            <td><strong>(C) Net ITC available</strong></td>
            <td class="num"><strong>${formatNumberPlain(t.itcNet.iamt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(t.itcNet.camt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(t.itcNet.samt)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(t.itcNet.csamt)}</strong></td>
          </tr>
        </tbody>
      </table>
      ${e}
      <p class="report-note muted">Import / ISD / RCM ITC and reversals are not tracked here \u2014 leave those rows blank or fill from books.</p>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">5 \u2014 Exempt / nil / non-GST inward</h3>
      <p class="report-note muted">Not auto-filled (composition / exempt inward not tracked). Leave zeros unless you have separate purchase books.</p>
    </section>
    <p class="report-note muted">Use <strong>Download GSTR-3B JSON</strong> for an offline-utility-style summary file. Verify every figure before portal upload.</p>`}function buildGstr3bJson(r,s){const t=getGstr3bSummary(r,s),a=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),e=n=>({ty:n,...t.itcZero});return{gstin:a||null,ret_period:t.retPeriod,sup_details:{osup_det:t.osupDet,osup_zero:{txval:t.osupZero.txval,iamt:t.osupZero.iamt,csamt:t.osupZero.csamt},osup_nil_exmp:t.osupNil,isup_rev:t.isupRev,osup_nongst:t.osupNongst},inter_sup:{unreg_details:[],comp_details:[],uin_details:[]},eco_dtls:{eco_sup:gstrTaxBucket(0),eco_reg_sup:{txval:0}},itc_elg:{itc_avl:[e("IMPG"),e("IMPS"),e("ISRC"),e("ISD"),{...t.itcOth}],itc_rev:[e("RUL"),e("OTH")],itc_net:t.itcNet,itc_inelg:[e("RUL"),e("OTH")]},inward_sup:{isup_details:[{ty:"GST",inter:0,intra:0},{ty:"NONGST",inter:0,intra:0}]},intr_ltfee:{intr_details:{iamt:0,camt:0,samt:0,csamt:0},ltfee_details:{camt:0,samt:0}},_meta:{note:"Internal aid for GSTR-3B filing tools. Verify every figure before portal upload. Table 3.2 POS omitted when unknown.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),interUnregTaxable:t.interUnregTaxable,interUnregIgst:t.interUnregIgst,purchaseLineCount:t.purchaseLineCount,purchaseMissingBuying:t.purchaseMissingBuying,includeBilling:t.includeBilling}}}function downloadGstr3bJson(){if(!cachedData||!cachedRange)return;const r=buildGstr3bJson(cachedData,cachedRange),s=new Blob([JSON.stringify(r,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),a=document.createElement("a"),e=cachedRange.start.replace(/-/g,""),n=cachedRange.end.replace(/-/g,"");a.href=t,a.download=`gstr3b_${r.ret_period||`${e}_${n}`}.json`,document.body.appendChild(a),a.click(),a.remove(),URL.revokeObjectURL(t)}
