function getFuelGstPct(){return Number(PumpSettings.getCachedSync().reports?.fuelGstPct)||AppConfig.DEFAULT_REPORTS.fuelGstPct}function isBillingIncludedInGstReports(){const s=PumpSettings.getCachedSync().billing||{},t=PumpSettings.getCachedSync().reports||{};return typeof s.includeInGstReports=="boolean"?s.includeInGstReports:typeof t.includeBillingInGst=="boolean"?t.includeBillingInGst:AppConfig.DEFAULT_BILLING.includeInGstReports!==!1}const FUEL_OUTWARD_GST_PCT=0;function calcDailyFuelSale(s){const{revenue:t,litres:r}=computeFuelRowMargin(s,null);return{litres:r,gross:t}}function aggregateFuelSalesByMonth(s,t){const r=new Map;return(s??[]).forEach(e=>{if(e.date<t.start||e.date>t.end)return;const i=normalizeProduct(e.product);if(i!=="petrol"&&i!=="diesel")return;const{litres:n,gross:a}=calcDailyFuelSale(e);if(n<=0&&a<=0)return;const c=e.date.slice(0,7);r.has(c)||r.set(c,{petrol:{litres:0,gross:0},diesel:{litres:0,gross:0}});const u=r.get(c)[i];u.litres+=n,u.gross+=a}),r}function buildFuelSalesMonthLines(s,t){const r=FUEL_OUTWARD_GST_PCT,e=classifyGstSlab(r),i=[];return[...aggregateFuelSalesByMonth(s,t).entries()].sort(([n],[a])=>n.localeCompare(a)).forEach(([n,a])=>{["petrol","diesel"].forEach(c=>{const{litres:u,gross:m}=a[c];u<=0&&m<=0||i.push({monthKey:n,monthLabel:formatMonthLabel(n),product:c,productLabel:c==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:u,gstPct:r,slabKey:e,taxable:0,cgst:0,sgst:0,gross:m,nilValue:m})})}),i}function buildFuelSalesDailyInvoices(s,t){const r=FUEL_OUTWARD_GST_PCT,e=classifyGstSlab(r),i={petrol:0,diesel:1};return(s??[]).filter(a=>a.date>=t.start&&a.date<=t.end).map(a=>{const c=normalizeProduct(a.product);if(c!=="petrol"&&c!=="diesel")return null;const{litres:u,gross:m}=calcDailyFuelSale(a);return u<=0&&m<=0?null:{date:a.date,product:c,productLabel:c==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:u,gross:m,nilValue:m,gstPct:r,slabKey:e,taxable:0,cgst:0,sgst:0,partyName:"Cash A/c"}}).filter(Boolean).sort((a,c)=>a.date.localeCompare(c.date)||(i[a.product]??9)-(i[c.product]??9)).map((a,c)=>({...a,invoiceNumber:`SFC/${String(c+1).padStart(4,"0")}`}))}function sumFuelSalesLines(s){return s.reduce((t,r)=>({litres:t.litres+r.litres,taxable:t.taxable+r.taxable,cgst:t.cgst+r.cgst,sgst:t.sgst+r.sgst,gross:t.gross+r.gross}),{litres:0,taxable:0,cgst:0,sgst:0,gross:0})}function mergeSlabTotals(s,t){const r={};return GST_SLABS.forEach(e=>{const i=s[e.key]||emptySlabBucket(),n=t[e.key]||emptySlabBucket();r[e.key]={taxable:i.taxable+n.taxable,cgst:i.cgst+n.cgst,sgst:i.sgst+n.sgst,igst:(i.igst||0)+(n.igst||0),gross:i.gross+n.gross}}),r}function emptySlabBucket(){return{taxable:0,cgst:0,sgst:0,igst:0,gross:0}}function emptySlabTotals(){const s={};return GST_SLABS.forEach(t=>{s[t.key]=emptySlabBucket()}),s}function fuelSalesToSlabTotals(s){const t=emptySlabTotals();return s.forEach(r=>{const e=r.slabKey||classifyGstSlab(r.gstPct);if(!t[e])return;const i=Number(r.nilValue??r.gross??0);e==="nil"?(t[e].taxable+=i,t[e].gross+=i):(t[e].taxable+=r.taxable,t[e].cgst+=r.cgst,t[e].sgst+=r.sgst,t[e].igst+=Number(r.igst||0),t[e].gross+=r.gross)}),t}function gstinStateCode(s){const t=String(s||"").trim().toUpperCase();return t.length>=2?t.slice(0,2):""}function getStationGstinStateCode(){return gstinStateCode(typeof PumpSettings<"u"?PumpSettings.getStationGstin():"")}function isInterstatePartyGstin(s){const t=gstinStateCode(s),r=getStationGstinStateCode();return!t||!r?!1:t!==r}function getFuelSupplierLabel(){return PumpSettings.getCachedSync().reports?.fuelSupplierLabel||AppConfig.DEFAULT_REPORTS.fuelSupplierLabel}function getFuelSupplierGstin(){const s=PumpSettings.getCachedSync().reports?.fuelSupplierGstin;return s!=null&&String(s).trim()?String(s).trim().toUpperCase():AppConfig.DEFAULT_REPORTS.fuelSupplierGstin||""}function resolveSupplierGstin(s){const t=s!=null?String(s).trim():"";return t?t.toUpperCase():getFuelSupplierGstin()}function classifyGstSlab(s){const t=Number(s);return t<0?"non_gst":t===0?"nil":t===5?"r5":t===12?"r12":t===18?"r18":t===24?"r24":t===28?"r28":"r18"}function slabHasActivity(s){return s?Math.abs(Number(s.taxable??0))>.005||Math.abs(Number(s.gross??0))>.005:!1}function sumInvoiceLineAmounts(s){let t=0,r=0,e=0;return s.forEach(i=>{const n=Number(i.amount??0),a=Number(i.gst_percent??0);a>0?t+=n/(1+a/100):a===0?e+=n:r+=n}),{taxable:t,nonGst:r,nilRate:e}}function invoiceHeaderTaxable(s){const t=Number(s.cgst_total??0),r=Number(s.sgst_total??0),e=Number(s.igst_total??0),i=Number(s.non_gst_total??0),n=Number(s.nil_rate_total??0),c=Number(s.total_amount??0)-t-r-e-i-n;if(Number.isFinite(c)&&c>=0)return c;const u=Number(s.subtotal??0)-Number(s.discount??0);return Number.isFinite(u)&&u>=0?u:0}function aggregateInvoiceGst(s,t){return aggregateInvoiceGstByPlace(s,t).combined}function aggregateInvoiceGstByPlace(s,t){const r=new Map;t.forEach(a=>{r.has(a.invoice_id)||r.set(a.invoice_id,[]),r.get(a.invoice_id).push(a)});const e=emptySlabTotals(),i=emptySlabTotals(),n=(a,c,{taxable:u=0,cgst:m=0,sgst:h=0,igst:S=0,gross:l=0})=>{a[c]&&(a[c].taxable+=u,a[c].cgst+=m,a[c].sgst+=h,a[c].igst+=S,a[c].gross+=l)};return s.forEach(a=>{const c=r.get(a.id)||[],u=Number(a.igst_total??0),m=Number(a.cgst_total??0),h=Number(a.sgst_total??0),S=u>0||m+h<=0&&isInterstatePartyGstin(a.party_gstin),l=S?i:e;if(c.length)c.forEach(o=>{const d=Number(o.amount??0),N=Number(o.gst_percent??0),g=classifyGstSlab(N);if(N>0){const p=d/(1+N/100),y=d-p;S?n(l,g,{taxable:p,igst:y,gross:d}):n(l,g,{taxable:p,cgst:y/2,sgst:y/2,gross:d})}else N===0?n(l,"nil",{taxable:d,gross:d}):n(l,"non_gst",{taxable:d,gross:d})});else{const o=Number(a.non_gst_total??0),d=Number(a.nil_rate_total??0),N=Number(a.total_amount??0),g=invoiceHeaderTaxable(a);if(m>0||h>0||u>0){const p=classifyGstSlab(18);S?n(l,p,{taxable:g,igst:u>0?u:m+h,gross:g+m+h+u}):n(l,p,{taxable:g,cgst:m,sgst:h,gross:g+m+h+u})}else d>0?n(l,"nil",{taxable:d,gross:d}):o>0?n(l,"non_gst",{taxable:o,gross:o}):N>0&&n(l,"non_gst",{taxable:N,gross:N})}}),{inside:e,outside:i,combined:mergeSlabTotals(e,i)}}function renderGstSummaryTable(s,t,r,e,i={}){const{sectionOnly:n=!1,sectionTitle:a=t,place:c="inside",showIgst:u=c==="outside"||c==="all"}=i,h=GST_SLABS.filter(b=>slabHasActivity(s[b.key])).map(b=>{const f=s[b.key]||emptySlabBucket(),x=f.cgst+f.sgst;return c==="outside"?`<tr>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${formatNumberPlain(f.taxable)}</td>
      <td class="num">${formatNumberPlain(f.igst||0)}</td>
      <td class="num">${formatNumberPlain(f.gross)}</td>
    </tr>`:e?`<tr>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${formatNumberPlain(f.taxable)}</td>
      <td class="num">${formatNumberPlain(x)}</td>
      <td class="num">${u?formatNumberPlain(f.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain(f.gross)}</td>
    </tr>`:`<tr>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${formatNumberPlain(f.taxable)}</td>
      <td class="num">${formatNumberPlain(f.cgst)}</td>
      <td class="num">${formatNumberPlain(f.sgst)}</td>
      <td class="num">${u?formatNumberPlain(f.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain(f.gross)}</td>
    </tr>`}).join(""),S=GST_SLABS.reduce((b,f)=>b+(s[f.key]?.taxable||0),0),l=GST_SLABS.reduce((b,f)=>b+(s[f.key]?.cgst||0),0),o=GST_SLABS.reduce((b,f)=>b+(s[f.key]?.sgst||0),0),d=GST_SLABS.reduce((b,f)=>b+(s[f.key]?.igst||0),0),N=l+o,g=GST_SLABS.reduce((b,f)=>b+(s[f.key]?.gross||0),0);let p,y,$;c==="outside"?(p='<th>Slab</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">Total</th>',y=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(S)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(d)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(g)}</strong></td>`,$=4):e?(p=`<th>Slab</th><th class="num">Taxable</th><th class="num">VAT/LST</th><th class="num">${u?"IGST":"\u2014"}</th><th class="num">Total</th>`,y=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(S)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(N)}</strong></td>
          <td class="num"><strong>${u?formatNumberPlain(d):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(g)}</strong></td>`,$=5):(p=`<th>Slab</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">${u?"IGST":"\u2014"}</th><th class="num">Total</th>`,y=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(S)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(o)}</strong></td>
          <td class="num"><strong>${u?formatNumberPlain(d):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(g)}</strong></td>`,$=6);const P=c==="outside"?"Outside state (IGST)":c==="all"?e?"Combined inward supply":"Combined outward supply":e?"Inside state inward supply":"Inside state outward supply (CGST + SGST)",T=e?`${P} \xB7 ${escapeHtml(getPurchaseTaxPctLabel())} \xB7 ${isPurchaseTaxInclusive()?"tax-inclusive rate":"pre-tax rate (BPCL)"}`:P,G=n?`<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(a)}</h3>`:reportHeader(t,r.start,r.end),_=n?"</section>":"",I=e?`VAT/LST: <strong>${formatNumberPlain(N)}</strong>${u?` \xB7 IGST: <strong>${formatNumberPlain(d)}</strong>`:""}`:`CGST: <strong>${formatNumberPlain(l)}</strong> \xB7 SGST: <strong>${formatNumberPlain(o)}</strong>${u?` \xB7 IGST: <strong>${formatNumberPlain(d)}</strong>`:""}`;return`
    ${G}
    <p class="report-subtitle${n?" muted":""}">${T}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>${p}</tr>
      </thead>
      <tbody>${h||`<tr><td colspan="${$}" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          ${y}
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Taxable: <strong>${formatNumberPlain(S)}</strong> \xB7 ${I} \xB7 Gross: <strong>${formatNumberPlain(g)}</strong></p>${_}`}function slabTotalsHaveActivity(s){return GST_SLABS.some(t=>slabHasActivity(s[t.key]))}function renderFuelSalesMonthTable(s,t){const r=s.map(i=>`<tr class="${fuelRowClass(i.product)}">
        <td>${escapeHtml(i.monthLabel)}</td>
        <td>${escapeHtml(i.productLabel)}</td>
        <td class="num">${formatNumberPlain(i.litres)}</td>
        <td class="num">${formatNumberPlain(i.nilValue??i.gross)}</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">${formatNumberPlain(i.gross)}</td>
      </tr>`).join(""),e=sumFuelSalesLines(s);return`
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(t)}</h3>
      <p class="report-subtitle muted">Outward fuel supply \xB7 NIL rate \xB7 Value = daily qty (L) \xD7 that day&apos;s selling price from DSR</p>
      <table class="report-table report-gst-fuel-month">
        <thead>
          <tr>
            <th>Month</th>
            <th>Product</th>
            <th class="num">Qty (L)</th>
            <th class="num">Nil value</th>
            <th class="num">CGST</th>
            <th class="num">SGST</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${r||'<tr><td colspan="7" class="muted">No fuel sales in this period</td></tr>'}</tbody>
        ${s.length?`<tfoot>
          <tr class="report-total-row">
            <td colspan="2"><strong>Fuel total</strong></td>
            <td class="num"><strong>${formatNumberPlain(e.litres)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(e.gross)}</strong></td>
            <td class="num"><strong>\u2014</strong></td>
            <td class="num"><strong>\u2014</strong></td>
            <td class="num"><strong>${formatNumberPlain(e.gross)}</strong></td>
          </tr>
        </tfoot>`:""}
      </table>
    </section>`}function renderGstSalesSummary(s,t){const r=isBillingIncludedInGstReports(),e=buildFuelSalesMonthLines(s.dsrRows,t),i=fuelSalesToSlabTotals(e),n=r?aggregateInvoiceGst(s.invoices,s.invoiceItems):null,a=n?mergeSlabTotals(i,n):i,c=renderFuelSalesMonthTable(e,"Fuel sales \u2014 month-wise"),u=r?renderGstSummaryTable(n,"Billing \u2014 GST slab summary",t,!1,{sectionOnly:!0,sectionTitle:"Billing \u2014 GST slab summary"}):'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing \u2192 Include billing in GST sales reports).</p>',m=renderGstSummaryTable(a,"Combined outward supply \u2014 GST summary",t,!1,{sectionOnly:!0,sectionTitle:"Combined outward supply \u2014 GST summary"});return`
    ${reportHeader("Outward supply \u2014 GST summary",t.start,t.end)}
    ${c}
    ${u}
    ${m}`}function renderGstSalesDetail(s,t){const r=isBillingIncludedInGstReports(),e=buildFuelSalesDailyInvoices(s.dsrRows,t),i=e.map(o=>({sortDate:o.date,sortKey:`0-${o.invoiceNumber}`,html:`<tr class="${fuelRowClass(o.product)}">
        <td>${formatNumericDate(o.date)}</td>
        <td>Fuel \xB7 ${escapeHtml(o.productLabel)}</td>
        <td>${escapeHtml(o.invoiceNumber)} \xB7 ${escapeHtml(o.partyName)}</td>
        <td>\u2014</td>
        <td class="num">${formatNumberPlain(o.litres)}</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">${formatNumberPlain(o.nilValue??o.gross)}</td>
        <td class="num">${formatNumberPlain(o.gross)}</td>
      </tr>`})),n=new Map;s.invoiceItems.forEach(o=>{n.has(o.invoice_id)||n.set(o.invoice_id,[]),n.get(o.invoice_id).push(o)});const a=r?s.invoices.map(o=>{const d=n.get(o.id)||[],N=Number(o.cgst_total??0),g=Number(o.sgst_total??0),p=Number(o.igst_total??0),y=N+g+p>0,$=(o.party_gstin||"").trim().toUpperCase()||"\u2014";let P=0,T=0,G=0;if(d.length){const _=sumInvoiceLineAmounts(d);P=_.taxable,T=_.nonGst,G=_.nilRate}else T=Number(o.non_gst_total??0),G=Number(o.nil_rate_total??0),P=invoiceHeaderTaxable(o);return{sortDate:o.invoice_date,sortKey:`1-${o.invoice_number}`,html:`<tr class="report-billing-row">
        <td>${formatNumericDate(o.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(o.invoice_number)} \xB7 ${escapeHtml(o.party_name)}</td>
        <td>${escapeHtml($)}</td>
        <td class="num">\u2014</td>
        <td class="num">${y||P>0?formatNumberPlain(P):"\u2014"}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${formatNumberPlain(g)}</td>
        <td class="num">${formatNumberPlain(p)}</td>
        <td class="num">${formatNumberPlain(T+G)}</td>
        <td class="num">${formatNumberPlain(o.total_amount)}</td>
      </tr>`}}):[],c=[...i,...a].sort((o,d)=>o.sortDate.localeCompare(d.sortDate)||o.sortKey.localeCompare(d.sortKey)).map(o=>o.html).join(""),u=sumFuelSalesLines(e),m=e.length>0,h=r&&s.invoices.length>0,S=!m&&!h?`<tr><td colspan="11" class="muted">${r?"No fuel sales or billing in this period":"No fuel sales in this period"}</td></tr>`:"",l=r?"":'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing).</p>';return`
    ${reportHeader("Outward supply \u2014 GST detail register",t.start,t.end)}
    <p class="report-subtitle muted">Fuel days as NIL invoices (SFC/####) \u2014 one voucher per tank sale day (MS, HSD). Value = net litres \xD7 that day&apos;s selling rate. Billing rows show party GSTIN and IGST when interstate.</p>
    ${l}
    <table class="report-table report-gst-detail">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Invoice / Party</th>
          <th>GSTIN</th>
          <th class="num">Qty (L)</th>
          <th class="num">Taxable</th>
          <th class="num">CGST</th>
          <th class="num">SGST</th>
          <th class="num">IGST</th>
          <th class="num">Exempt / NIL</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>
        ${c}
        ${S}
      </tbody>
      ${m?`<tfoot>
        <tr class="report-total-row">
          <td colspan="4"><strong>Fuel total (${e.length} SFC)</strong></td>
          <td class="num"><strong>${formatNumberPlain(u.litres)}</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>${formatNumberPlain(u.gross)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(u.gross)}</strong></td>
        </tr>
      </tfoot>`:""}
    </table>`}function collectFuelPurchaseLines(s,t,r){const e=l=>l.date>=t.start&&l.date<=t.end,i=r??createBuyingRateContext(s.receiptRows??[]).getStored,n=s.vaultPurchases??[],a=new Map(n.map(l=>[l.id,l])),c=new Map;n.forEach(l=>{const o=String(l.title||"").trim().toLowerCase();o&&!c.has(o)&&c.set(o,l)});const u=[],m=new Set,h=l=>{if(l.invoiceDocumentId&&a.has(l.invoiceDocumentId))return a.get(l.invoiceDocumentId);const o=String(l.supplierInvoiceNo||"").trim().toLowerCase();return o?c.has(o)?c.get(o):n.find(d=>String(d.title||"").toLowerCase().includes(o))||null:null},S=(l,o,d,N,g={})=>{const p=Number(d),y=Number(N);if(!Number.isFinite(p)||p<=0||!Number.isFinite(y)||y<=0)return;const $=`${l}-${normalizeProduct(o)}`;if(m.has($))return;m.add($);const P=h(g);u.push({date:l,product:o,litres:p,rate:y,deliveryPerKl:g.deliveryPerKl??null,supplierInvoiceNo:g.supplierInvoiceNo||P?.title||"",supplierGstin:g.supplierGstin||"",invoiceDocumentId:g.invoiceDocumentId||P?.id||null})};return(s.receiptRows??[]).filter(e).forEach(l=>{S(l.date,l.product,Number(l.receipts??0),Number(l.buying_price_per_litre),{supplierInvoiceNo:l.supplier_invoice_no,supplierGstin:l.supplier_gstin,invoiceDocumentId:l.invoice_document_id,deliveryPerKl:l.purchase_delivery_per_kl})}),(s.dsrRows??[]).filter(e).forEach(l=>{const o=Number(l.receipts??0);if(o<=0)return;const d=Number(l.buying_price_per_litre);!Number.isFinite(d)||d<=0||S(l.date,l.product,o,d,{supplierInvoiceNo:l.supplier_invoice_no,supplierGstin:l.supplier_gstin,invoiceDocumentId:l.invoice_document_id,deliveryPerKl:l.purchase_delivery_per_kl})}),u.sort((l,o)=>l.date.localeCompare(o.date)||normalizeProduct(l.product).localeCompare(normalizeProduct(o.product)))}function countReceiptsMissingBuying(s,t){const r=e=>e.date>=t.start&&e.date<=t.end;return(s.dsrRows??[]).filter(e=>{if(!r(e)||Number(e.receipts??0)<=0)return!1;const i=Number(e.buying_price_per_litre);return!Number.isFinite(i)||i<=0}).length}function buildFuelPurchaseRows(s,t){const r=createBuyingRateContext(s.receiptRows??[]).getStored,e=collectFuelPurchaseLines(s,t,r),i=countReceiptsMissingBuying(s,t),n=emptySlabTotals(),a=emptySlabTotals();return{detailRows:e.map(({date:u,product:m,litres:h,rate:S,deliveryPerKl:l,supplierInvoiceNo:o,supplierGstin:d,invoiceDocumentId:N})=>{const g=getPurchaseTaxPct(m),p=classifyGstSlab(g),{taxable:y,tax:$,gross:P,cgst:T,sgst:G}=calcPurchaseLineTax(h,S,g,{product:m,date:u,deliveryPerKl:l}),_=resolveSupplierGstin(d),I=isInterstatePartyGstin(_),b=I?a:n;return b[p]&&(b[p].taxable+=y,I?b[p].igst+=$:(b[p].cgst+=T,b[p].sgst+=G),b[p].gross+=P),{date:u,product:m,litres:h,rate:S,taxPct:g,taxable:y,tax:$,gross:P,cgst:I?0:T,sgst:I?0:G,igst:I?$:0,interstate:I,supplierInvoiceNo:o||"",supplierGstin:_,invoiceDocumentId:N||null}}),insideSlabs:n,outsideSlabs:a,slabTotals:mergeSlabTotals(n,a),missingBuyingCount:i}}function renderGstPurchaseSummary(s,t){const{insideSlabs:r,outsideSlabs:e,slabTotals:i,detailRows:n,missingBuyingCount:a}=getFuelPurchaseRows(s,t),c=a>0?`<p class="report-note warning">${a} receipt(s) in this period have no buying price \u2014 excluded. Enter buying price on Meter Reading \u2192 Purchase cost.</p>`:"",u=n.length===0?'<p class="report-note muted">No fuel receipts with buying price in this period.</p>':"",m=renderGstSummaryTable(r,"Inside state",t,!0,{sectionOnly:!0,sectionTitle:"Inside state inward supply",place:"inside",showIgst:!1}),h=slabTotalsHaveActivity(e)?renderGstSummaryTable(e,"Outside state",t,!0,{sectionOnly:!0,sectionTitle:"Outside state inward supply",place:"outside",showIgst:!0}):'<section class="report-gst-section"><h3 class="report-section-title">Outside state inward supply</h3><p class="muted">No interstate inward supply in this period (supplier GSTIN state matches station, or GSTIN blank).</p></section>',S=renderGstSummaryTable(i,"Combined",t,!0,{sectionOnly:!0,sectionTitle:"Total inward supply summary",place:"all",showIgst:!0});return`
    ${reportHeader("Inward supply \u2014 GST summary (Fuel receipts)",t.start,t.end)}
    ${u}
    ${m}
    ${h}
    ${S}
    ${c}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())} Place of supply uses supplier GSTIN vs station GSTIN.</p>`}function renderGstPurchaseDetail(s,t){const{detailRows:r,missingBuyingCount:e}=getFuelPurchaseRows(s,t),i=r.map(n=>{const a=normalizeProduct(n.product),c=a==="petrol"?"MS":a==="diesel"?"HSD":String(n.product).toUpperCase(),u=n.supplierInvoiceNo?escapeHtml(n.supplierInvoiceNo):"\u2014",m=n.supplierGstin?escapeHtml(n.supplierGstin):"\u2014",h=n.invoiceDocumentId?`<button type="button" class="link" data-vault-document="${escapeHtml(n.invoiceDocumentId)}">View PDF</button>`:"\u2014";return`<tr class="${fuelRowClass(a)}">
      <td>${formatNumericDate(n.date)}</td>
      <td>${formatFuelBadge(c)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td>${u}</td>
      <td>${m}</td>
      <td class="num">${h}</td>
      <td class="num">${formatNumberPlain(n.litres)}</td>
      <td class="num">${formatBuyingRatePerKl(n.rate)}</td>
      <td class="num">${formatNumberPlain(n.taxable)}</td>
      <td class="num">${n.taxPct}%</td>
      <td class="num">${formatNumberPlain(n.tax)}</td>
      <td class="num">${formatNumberPlain(n.gross)}</td>
    </tr>`}).join("");return`
    ${reportHeader("Inward supply \u2014 GST detail (Fuel receipts)",t.start,t.end)}
    <table class="report-table report-gst-detail report-gst-detail--purchase">
      <thead>
        <tr>
          <th>Date</th>
          <th>Prod</th>
          <th>Party</th>
          <th>Invoice No</th>
          <th>GSTIN</th>
          <th>Vault</th>
          <th class="num">Qty (L)</th>
          <th class="num">Rate (${escapeHtml(getBuyingPriceUnitLabel())})</th>
          <th class="num">Taxable</th>
          <th class="num">VAT%</th>
          <th class="num">VAT</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>${i||'<tr><td colspan="12" class="muted">No receipts with buying price in period</td></tr>'}</tbody>
    </table>
    ${e>0?`<p class="report-note warning">${e} receipt(s) excluded \u2014 buying price not set on Meter Reading \u2192 Purchase cost.</p>`:""}
    <p class="report-note muted">Vault PDF links match DSR receipt \u2192 Invoices (purchase) by document id or invoice title. Enter invoice no with buying price on Meter Reading \u2192 Purchase cost. ${escapeHtml(getPurchaseGstDetailNote())}</p>`}
