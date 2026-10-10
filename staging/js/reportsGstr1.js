function buildGstr1Sections(o,s){const t=isBillingIncludedInGstReports(),u=buildFuelSalesDailyInvoices(o.dsrRows,s).map(n=>({date:n.date,invoiceNumber:n.invoiceNumber,party:n.partyName,gstin:"",taxable:0,cgst:0,sgst:0,igst:0,nilValue:Number(n.nilValue??n.gross??0),gross:Number(n.gross??0),product:n.productLabel})),m=[],i=[];t&&o.invoices.forEach(n=>{const l=(n.party_gstin||"").trim().toUpperCase(),r=Number(n.cgst_total??0),h=Number(n.sgst_total??0),p=Number(n.igst_total??0),f=Number(n.non_gst_total??0),R=Number(n.nil_rate_total??0),$=invoiceHeaderTaxable(n),N={date:n.invoice_date,invoiceNumber:n.invoice_number,party:n.party_name,gstin:l,taxable:$,cgst:r,sgst:h,igst:p,nilValue:f+R,gross:Number(n.total_amount??0)};l.length>=15?m.push(N):i.push(N)});const c=(n,l)=>n.reduce((r,h)=>(l.forEach(p=>{r[p]=(r[p]||0)+Number(h[p]||0)}),r),{});return{includeBilling:t,nilRows:u,b2b:m,b2cs:i,nilTotals:c(u,["nilValue","gross"]),b2bTotals:c(m,["taxable","cgst","sgst","igst","gross"]),b2csTotals:c(i,["taxable","cgst","sgst","igst","nilValue","gross"])}}function renderGstr1Table(o,s,t,e,u){return`
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(o)}</h3>
      <p class="report-subtitle muted">${s}</p>
      <table class="report-table report-gst-detail">
        <thead><tr>${t}</tr></thead>
        <tbody>${e}</tbody>
        ${u||""}
      </table>
    </section>`}function renderGstr1Register(o,s){const t=getGstr1Sections(o,s),e=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL section still included.</p>',u=t.nilRows.map(l=>{const r=String(l.product||"").toLowerCase().includes("diesel")?"diesel":"petrol";return`<tr class="${fuelRowClass(r)}">
      <td>${formatNumericDate(l.date)}</td>
      <td>${escapeHtml(l.invoiceNumber)}</td>
      <td>${escapeHtml(l.product||"Fuel")}</td>
      <td class="num">${formatNumberPlain(l.nilValue)}</td>
      <td class="num">${formatNumberPlain(l.gross)}</td>
    </tr>`}).join("")||'<tr><td colspan="5" class="muted">No fuel sales in this period</td></tr>',m=t.nilRows.length?`<tfoot><tr class="report-total-row">
        <td colspan="3"><strong>NIL total (${t.nilRows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(t.nilTotals.nilValue)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(t.nilTotals.gross)}</strong></td>
      </tr></tfoot>`:"",i=`
    <th>Date</th><th>Invoice</th><th>Party</th><th>GSTIN</th>
    <th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th>
    <th class="num">IGST</th><th class="num">Exempt/NIL</th><th class="num">Gross</th>`,c=l=>l.map(r=>`<tr>
      <td>${formatNumericDate(r.date)}</td>
      <td>${escapeHtml(r.invoiceNumber)}</td>
      <td>${escapeHtml(r.party)}</td>
      <td>${escapeHtml(r.gstin||"\u2014")}</td>
      <td class="num">${formatNumberPlain(r.taxable)}</td>
      <td class="num">${formatNumberPlain(r.cgst)}</td>
      <td class="num">${formatNumberPlain(r.sgst)}</td>
      <td class="num">${formatNumberPlain(r.igst)}</td>
      <td class="num">${formatNumberPlain(r.nilValue)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`).join("")||'<tr><td colspan="10" class="muted">No invoices in this section</td></tr>',n=(l,r)=>l.length?`<tfoot><tr class="report-total-row">
        <td colspan="4"><strong>Total (${l.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(r.taxable)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(r.cgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(r.sgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(r.igst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(r.nilValue||0)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(r.gross)}</strong></td>
      </tr></tfoot>`:"";return`
    ${reportHeader("GSTR-1 style outward register",s.start,s.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-1 \u2014 not a GST portal JSON upload. Sections mirror B2B, B2CS and NIL rated fuel (SFC).</p>
    ${e}
    ${renderGstr1Table("4A/4B \u2014 B2B (registered party GSTIN)","Billing invoices with a 15-character party GSTIN.",i,c(t.b2b),n(t.b2b,t.b2bTotals))}
    ${renderGstr1Table("7 \u2014 B2CS (unregistered / Cash)","Billing invoices without a party GSTIN.",i,c(t.b2cs),n(t.b2cs,t.b2csTotals))}
    ${renderGstr1Table("8 \u2014 NIL rated (fuel SFC)","Daily fuel outward vouchers from DSR (NIL rate).",'<th>Date</th><th>Invoice</th><th>Product</th><th class="num">NIL value</th><th class="num">Gross</th>',u,m)}
    <p class="report-note muted">Use <strong>Download CSV</strong> for a flat file you can reconcile in Excel. Portal filing still requires the official GST offline tool / API.</p>`}function buildGstr1Csv(o,s){const t=getGstr1Sections(o,s),e=[["section","date","invoice","party","gstin","product","taxable","cgst","sgst","igst","nil_value","gross"].join(",")],u=i=>{const c=String(i??"");return/[",\n]/.test(c)?`"${c.replace(/"/g,'""')}"`:c},m=(i,c)=>{e.push([i,c.date,c.invoiceNumber,c.party||"",c.gstin||"",c.product||"",c.taxable??"",c.cgst??"",c.sgst??"",c.igst??"",c.nilValue??"",c.gross??""].map(u).join(","))};return t.b2b.forEach(i=>m("B2B",i)),t.b2cs.forEach(i=>m("B2CS",i)),t.nilRows.forEach(i=>m("NIL",i)),e.join(`
`)}function downloadGstr1Csv(){if(!cachedData||!cachedRange)return;const o=buildGstr1Csv(cachedData,cachedRange),s=new Blob([o],{type:"text/csv;charset=utf-8"}),t=URL.createObjectURL(s),e=document.createElement("a"),u=cachedRange.start.replace(/-/g,""),m=cachedRange.end.replace(/-/g,"");e.href=t,e.download=`gstr1-register_${u}_${m}.csv`,document.body.appendChild(e),e.click(),e.remove(),URL.revokeObjectURL(t)}function formatGstr1PortalDate(o){if(!o||String(o).length<10)return"";const[s,t,e]=String(o).slice(0,10).split("-");return`${e}-${t}-${s}`}function gstr1FilingPeriod(o){const s=String(o?.end||"").slice(0,10);if(s.length<7)return"";const[t,e]=s.split("-");return`${e}${t}`}function gstr1StateCodeFromGstin(o){const s=String(o||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function gstr1InvoiceRate(o){const s=Number(o.taxable||0);if(s<=0)return 0;const e=(Number(o.cgst||0)+Number(o.sgst||0)+Number(o.igst||0))/s*100;return e<3?0:e<8?5:e<15?12:e<21?18:e<26?24:28}function buildGstr1Json(o,s){const t=getGstr1Sections(o,s),e=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),u=gstr1StateCodeFromGstin(e)||"21",m=gstr1FilingPeriod(s),i=new Map;t.b2b.forEach(a=>{const d=String(a.gstin||"").trim().toUpperCase();i.has(d)||i.set(d,[]);const g=gstr1InvoiceRate(a),b={txval:Number(Number(a.taxable||0).toFixed(2)),rt:g};Number(a.igst||0)>0?b.iamt=Number(Number(a.igst).toFixed(2)):(b.camt=Number(Number(a.cgst||0).toFixed(2)),b.samt=Number(Number(a.sgst||0).toFixed(2))),i.get(d).push({inum:a.invoiceNumber,idt:formatGstr1PortalDate(a.date),val:Number(Number(a.gross||0).toFixed(2)),pos:gstr1StateCodeFromGstin(d)||u,rchrg:"N",inv_typ:"R",itms:[{num:1,itm_det:b}]})});const c=Array.from(i.entries()).map(([a,d])=>({ctin:a,inv:d})),n=new Map;t.b2cs.forEach(a=>{const d=gstr1InvoiceRate(a),g=Number(a.igst||0)>0,b=`${g?"INTER":"INTRA"}|${u}|${d}`;n.has(b)||n.set(b,{sply_ty:g?"INTER":"INTRA",pos:u,typ:"OE",txval:0,rt:d,iamt:0,camt:0,samt:0,csamt:0});const S=n.get(b);S.txval+=Number(a.taxable||0),S.iamt+=Number(a.igst||0),S.camt+=Number(a.cgst||0),S.samt+=Number(a.sgst||0)});const l=Array.from(n.values()).map(a=>({...a,txval:Number(a.txval.toFixed(2)),iamt:Number(a.iamt.toFixed(2)),camt:Number(a.camt.toFixed(2)),samt:Number(a.samt.toFixed(2))})),h={inv:[{sply_ty:"INTRB2C",expt_amt:0,nil_amt:Number((t.nilTotals.nilValue||0).toFixed(2)),ngsup_amt:0}]},p=(a,d)=>{if(!a.length)return null;const g=a.map(b=>String(b.invoiceNumber||"")).filter(Boolean).sort();return{doc_num:d,docs:[{num:1,from:g[0],to:g[g.length-1],totnum:g.length,cancel:0,net_issue:g.length}]}},f=[],R=[...t.b2b,...t.b2cs],$=p(R,1);$&&f.push($);const N=p(t.nilRows,4);return N&&f.push(N),{gstin:e||null,fp:m,version:"GST3.1.6",hash:"hash",b2b:c,b2cs:l,nil:h,doc_issue:{doc_det:f},_meta:{note:"Internal aid for GSTR-1 filing tools. Verify every figure before portal upload.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),fuelNilCount:t.nilRows.length,b2bCount:t.b2b.length,b2csCount:t.b2cs.length}}}function downloadGstr1Json(){if(!cachedData||!cachedRange)return;const o=buildGstr1Json(cachedData,cachedRange),s=new Blob([JSON.stringify(o,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),e=document.createElement("a"),u=cachedRange.start.replace(/-/g,""),m=cachedRange.end.replace(/-/g,"");e.href=t,e.download=`gstr1_${o.fp||`${u}_${m}`}.json`,document.body.appendChild(e),e.click(),e.remove(),URL.revokeObjectURL(t)}
