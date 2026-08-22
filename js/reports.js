const REPORT_CATALOG=[{group:"Operations",reports:[{id:"dsr",title:"Tank-wise DSR",description:"HSD + MS tanks: dips, receipts, shortage, testing, variance, rates, TVA."},{id:"fuel-income",title:"Fuel Income",description:"Daily dealer margin: net litres \xD7 (selling \u2212 landed buying) for MS and HSD."},{id:"pump-sales",title:"Pump-wise sales",description:"Sale litres by pump (P1/P2) from daily meters and shift nozzle rollups."},{id:"shift-sales",title:"Shift-wise sales",description:"Morning / afternoon sales by fuel with staff count from shift register."},{id:"salesman-sales",title:"Salesman sales",description:"Per salesman litres, expected cash, cash + phone pay total, and short from shift register."}]},{group:"GST \u2014 Sales",reports:[{id:"gst-sales-summary",title:"GST Sales Summary",description:"Inside / outside state outward supply: fuel NIL + billing slabs (CGST/SGST/IGST)."},{id:"gst-sales-detail",title:"GST Sales Detail",description:"Daily fuel NIL invoices (SFC) \u2014 one MS + one HSD per sale day; billing with GSTIN/IGST when enabled."}]},{group:"GST \u2014 Purchases (Fuel inward)",reports:[{id:"gst-purchase-summary",title:"GST Purchase Summary",description:"Inside / outside state fuel inward by VAT slab (supplier GSTIN vs station)."},{id:"gst-purchase-detail",title:"GST Purchase Detail",description:"Receipt-wise register with BPCL invoice no, GSTIN, qty, VAT and gross."}]},{group:"Accounts",reports:[{id:"trading",title:"Trading account",description:"Stock-based books (opening/closing stock). Gross income c/d is a balancing figure \u2014 not take-home profit."},{id:"pl",title:"Profit & Loss",description:"Your real profit is Nett Profit here. Gross Profit = margin before expenses; same engine as Analysis and Dashboard Net profit."}]},{group:"GST \u2014 Filing aids",reports:[{id:"gstr1",title:"GSTR-1 style register",description:"B2B / B2CS / NIL (fuel SFC) outward summary \u2014 printable; CSV and portal-style JSON from the toolbar."},{id:"gstr3b",title:"GSTR-3B style summary",description:"Tables 3.1 / 3.2 / 4 / 5 from fuel + billing \u2014 printable; portal-style JSON from the toolbar."}]}];let activeReport="dsr",cachedData=null,cachedRange=null,reportsLoadInFlight=null,reportPrintBusy=!1;document.addEventListener("DOMContentLoaded",async()=>{const e=await requireAuth({allowedRoles:["admin"],onDenied:"dashboard.html",pageName:"reports"});e&&(applyRoleVisibility(e.role),await loadPumpSettings(),initReportsPage())});function findReportMeta(e){for(const s of REPORT_CATALOG){const t=s.reports.find(r=>r.id===e);if(t)return t}return null}function getFuelGstPct(){return Number(PumpSettings.getCachedSync().reports?.fuelGstPct)||AppConfig.DEFAULT_REPORTS.fuelGstPct}function isBillingIncludedInGstReports(){const e=PumpSettings.getCachedSync().billing||{},s=PumpSettings.getCachedSync().reports||{};return typeof e.includeInGstReports=="boolean"?e.includeInGstReports:typeof s.includeBillingInGst=="boolean"?s.includeBillingInGst:AppConfig.DEFAULT_BILLING.includeInGstReports!==!1}function formatMonthLabel(e){const[s,t]=e.split("-").map(Number);return!s||!t?e:new Date(s,t-1,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"})}const FUEL_OUTWARD_GST_PCT=0;function calcDailyFuelSale(e){const{revenue:s,litres:t}=computeFuelRowMargin(e,null);return{litres:t,gross:s}}function aggregateFuelSalesByMonth(e,s){const t=new Map;return(e??[]).forEach(r=>{if(r.date<s.start||r.date>s.end)return;const n=normalizeProduct(r.product);if(n!=="petrol"&&n!=="diesel")return;const{litres:o,gross:a}=calcDailyFuelSale(r);if(o<=0&&a<=0)return;const u=r.date.slice(0,7);t.has(u)||t.set(u,{petrol:{litres:0,gross:0},diesel:{litres:0,gross:0}});const i=t.get(u)[n];i.litres+=o,i.gross+=a}),t}function buildFuelSalesMonthLines(e,s){const t=FUEL_OUTWARD_GST_PCT,r=classifyGstSlab(t),n=[];return[...aggregateFuelSalesByMonth(e,s).entries()].sort(([o],[a])=>o.localeCompare(a)).forEach(([o,a])=>{["petrol","diesel"].forEach(u=>{const{litres:i,gross:g}=a[u];i<=0&&g<=0||n.push({monthKey:o,monthLabel:formatMonthLabel(o),product:u,productLabel:u==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:i,gstPct:t,slabKey:r,taxable:0,cgst:0,sgst:0,gross:g,nilValue:g})})}),n}function buildFuelSalesDailyInvoices(e,s){const t=FUEL_OUTWARD_GST_PCT,r=classifyGstSlab(t),n={petrol:0,diesel:1};return(e??[]).filter(a=>a.date>=s.start&&a.date<=s.end).map(a=>{const u=normalizeProduct(a.product);if(u!=="petrol"&&u!=="diesel")return null;const{litres:i,gross:g}=calcDailyFuelSale(a);return i<=0&&g<=0?null:{date:a.date,product:u,productLabel:u==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:i,gross:g,nilValue:g,gstPct:t,slabKey:r,taxable:0,cgst:0,sgst:0,partyName:"Cash A/c"}}).filter(Boolean).sort((a,u)=>a.date.localeCompare(u.date)||(n[a.product]??9)-(n[u.product]??9)).map((a,u)=>({...a,invoiceNumber:`SFC/${String(u+1).padStart(4,"0")}`}))}function sumFuelSalesLines(e){return e.reduce((s,t)=>({litres:s.litres+t.litres,taxable:s.taxable+t.taxable,cgst:s.cgst+t.cgst,sgst:s.sgst+t.sgst,gross:s.gross+t.gross}),{litres:0,taxable:0,cgst:0,sgst:0,gross:0})}function mergeSlabTotals(e,s){const t={};return GST_SLABS.forEach(r=>{const n=e[r.key]||emptySlabBucket(),o=s[r.key]||emptySlabBucket();t[r.key]={taxable:n.taxable+o.taxable,cgst:n.cgst+o.cgst,sgst:n.sgst+o.sgst,igst:(n.igst||0)+(o.igst||0),gross:n.gross+o.gross}}),t}function emptySlabBucket(){return{taxable:0,cgst:0,sgst:0,igst:0,gross:0}}function emptySlabTotals(){const e={};return GST_SLABS.forEach(s=>{e[s.key]=emptySlabBucket()}),e}function fuelSalesToSlabTotals(e){const s=emptySlabTotals();return e.forEach(t=>{const r=t.slabKey||classifyGstSlab(t.gstPct);if(!s[r])return;const n=Number(t.nilValue??t.gross??0);r==="nil"?(s[r].taxable+=n,s[r].gross+=n):(s[r].taxable+=t.taxable,s[r].cgst+=t.cgst,s[r].sgst+=t.sgst,s[r].igst+=Number(t.igst||0),s[r].gross+=t.gross)}),s}function gstinStateCode(e){const s=String(e||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function getStationGstinStateCode(){return gstinStateCode(typeof PumpSettings<"u"?PumpSettings.getStationGstin():"")}function isInterstatePartyGstin(e){const s=gstinStateCode(e),t=getStationGstinStateCode();return!s||!t?!1:s!==t}function getFuelSupplierLabel(){return PumpSettings.getCachedSync().reports?.fuelSupplierLabel||AppConfig.DEFAULT_REPORTS.fuelSupplierLabel}function getFuelSupplierGstin(){const e=PumpSettings.getCachedSync().reports?.fuelSupplierGstin;return e!=null&&String(e).trim()?String(e).trim().toUpperCase():AppConfig.DEFAULT_REPORTS.fuelSupplierGstin||""}function resolveSupplierGstin(e){const s=e!=null?String(e).trim():"";return s?s.toUpperCase():getFuelSupplierGstin()}function initReportsAboutAccordion(){initDocsAccordion(document.querySelector(".reports-about-accordion"))}function initReportsPage(){const e=document.getElementById("reports-start"),s=document.getElementById("reports-end"),t=new Date,r=t.getFullYear(),n=t.getMonth(),o=d=>String(d).padStart(2,"0"),a=`${r}-${o(n+1)}-01`,u=`${r}-${o(n+1)}-${o(new Date(r,n+1,0).getDate())}`;e&&(e.value=a),s&&(s.value=u),renderReportCatalog(),setActiveReportTab(activeReport),PrintUtils.preloadReportPrintCss?.(),initReportsAboutAccordion(),initPageSections({navItemSelector:".reports-nav .settings-nav-item",panelSelector:".reports-panels .settings-panel",defaultSection:"generate",validSections:["generate","about"]});const i=new URLSearchParams(window.location.search);i.get("start")&&e&&(e.value=i.get("start")),i.get("end")&&s&&(s.value=i.get("end"));const g=i.get("tab");g&&findReportMeta(g)&&setActiveReportTab(g),document.getElementById("reports-catalog")?.addEventListener("click",async d=>{const y=d.target.closest(".reports-pick");if(y?.dataset.report){if(setActiveReportTab(y.dataset.report),document.querySelector(".reports-output")?.scrollIntoView({behavior:"smooth",block:"nearest"}),!cachedData){const l=document.getElementById("reports-preview");l&&(l.innerHTML='<p class="muted">Loading report data\u2026</p>');try{await ensureReportsDataLoaded()}catch{}}renderActiveReport()}}),document.getElementById("reports-filter-form")?.addEventListener("submit",async d=>{d.preventDefault(),await loadAndRenderReports()}),document.getElementById("reports-print-btn")?.addEventListener("click",()=>{handleReportPrintClick()}),document.getElementById("reports-csv-btn")?.addEventListener("click",()=>{downloadGstr1Csv()}),document.getElementById("reports-json-btn")?.addEventListener("click",()=>{activeReport==="gstr3b"?downloadGstr3bJson():downloadGstr1Json()}),syncReportsAboutHash(),window.addEventListener("hashchange",syncReportsAboutHash)}function syncReportsAboutHash(){if((location.hash||"").replace(/^#/,"")!=="about")return;const e=document.getElementById("reports-about");e?.hidden||e.scrollIntoView({behavior:"smooth",block:"start"})}function ensureReportsDataLoaded(){return cachedData?Promise.resolve():reportsLoadInFlight||(reportsLoadInFlight=loadAndRenderReports().finally(()=>{reportsLoadInFlight=null}),reportsLoadInFlight)}function renderReportCatalog(){const e=document.getElementById("reports-catalog");e&&(e.innerHTML=REPORT_CATALOG.map(s=>`
    <div class="reports-nav-group" role="group" aria-labelledby="reports-group-${slugify(s.group)}">
      <p class="reports-nav-group-title" id="reports-group-${slugify(s.group)}">${escapeHtml(s.group)}</p>
      ${s.reports.map(t=>`
        <button type="button" class="reports-pick reports-nav-item${t.id===activeReport?" is-active":""}" data-report="${escapeHtml(t.id)}" aria-pressed="${t.id===activeReport?"true":"false"}">
          ${escapeHtml(t.title)}
        </button>`).join("")}
    </div>`).join(""))}function slugify(e){return String(e).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}function setActiveReportTab(e){const s=findReportMeta(e);activeReport=s?s.id:"dsr",document.querySelectorAll(".reports-pick").forEach(o=>{const a=o.dataset.report===activeReport;o.classList.toggle("is-active",a),o.setAttribute("aria-pressed",a?"true":"false")});const t=document.getElementById("reports-active-title"),r=document.getElementById("reports-active-desc"),n=findReportMeta(activeReport);t&&n&&(t.textContent=n.title),r&&(r.textContent=n?.description??""),updateReportsCsvButtonVisibility()}function parseReportTankCapacityLiters(e){if(!e)return null;const s=String(e).trim().toUpperCase().replace(/\s/g,""),t=s.match(/^([\d.]+)KL$/);if(t)return Number(t[1])*1e3;const r=s.match(/^([\d.]+)L$/);if(r)return Number(r[1]);const n=Number(s.replace(/[^\d.]/g,""));return Number.isFinite(n)&&n>0?n:null}function buildTankDsrSection(e,s,t,r,n){let o=0,a=0,u=0,i=0,g=0,d=0,y=0,l=0,c=null;const m=parseReportTankCapacityLiters(t),p=r.map(f=>{const h=Number(f.opening_stock??0),N=Number(f.receipts??0),S=Number(f.testing??0),v=Number(f.total_sales??0),T=getDsrNetSaleLitres(f);o+=T;const _=Number(f.dip_stock??f.stock??0),R=Math.max(0,Number(f.variation??0)),$=Math.max(h+N-R,0),P=Math.max(h+N-_,0);l=_;const w=T-P;a+=w;const L=m!=null&&Number.isFinite(_)?Math.max(0,m-_):null;c=L,u+=N,i+=R,g+=S,d+=v,y+=T;const C=Number(f[n]??0);return`<tr>
        <td>${formatNumericDate(f.date)}</td>
        <td class="num">${formatNumberPlain(h)}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${formatNumberPlain(R)}</td>
        <td class="num">${formatNumberPlain($)}</td>
        <td class="num">${formatNumberPlain(S)}</td>
        <td class="num">${formatNumberPlain(v)}</td>
        <td class="num">${formatNumberPlain(T)}</td>
        <td class="num">${formatNumberPlain(o)}</td>
        <td class="num">${formatNumberPlain(P)}</td>
        <td class="num">${formatNumberPlain(_)}</td>
        <td class="num">${formatNumberPlain(w)}</td>
        <td class="num">${formatNumberPlain(a)}</td>
        <td class="num">${formatNumberPlain(C)}</td>
        <td class="num">${L==null?"\u2014":formatNumberPlain(L)}</td>
      </tr>`}).join(""),b=e==="diesel"?"Diesel":"Petrol";return`
    <section class="report-tank-section report-tank-section--${e}">
      <h3 class="report-tank-title">Tank: ${escapeHtml(s)} \xB7 ${escapeHtml(t)} \xB7 ${escapeHtml(b)}</h3>
      <table class="report-table report-dsr-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" class="num" title="Opening dip (L)">Open</th>
            <th scope="col" class="num" title="Purchase / receipts (L)">Buy</th>
            <th scope="col" class="num" title="Physical shortage (L): max(0, book \u2212 dip)">Short</th>
            <th scope="col" class="num" title="Book total = open + buy \u2212 short (L)">Total</th>
            <th scope="col" class="num" title="Testing (L)">Test</th>
            <th scope="col" class="num" title="Sale by meter (L)">Meter</th>
            <th scope="col" class="num" title="Actual sale (L)">Actual</th>
            <th scope="col" class="num" title="Cumulative sale (L)">Cum</th>
            <th scope="col" class="num" title="Sale by dip (L)">Dip</th>
            <th scope="col" class="num" title="Closing dip (L)">Close</th>
            <th scope="col" class="num" title="Variance = actual \u2212 sale by dip (L)">Var</th>
            <th scope="col" class="num" title="Cumulative variance (L)">CumV</th>
            <th scope="col" class="num" title="Selling rate (\u20B9/L)">Rate</th>
            <th scope="col" class="num" title="Tank volume available = capacity \u2212 closing dip (L)">TVA</th>
          </tr>
        </thead>
        <tbody>${p||'<tr><td colspan="15" class="muted">No entries</td></tr>'}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(g)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(d)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
            <td></td>
            <td class="num"><strong>${c==null?"\u2014":formatNumberPlain(c)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </section>`}function renderTankWiseDsr(e,s){const t=DsrQueries.mergeDsrStock(e.dsrRows,e.stockRows),r=PumpSettings.getCachedSync().reports?.tanks||AppConfig.DEFAULT_REPORT_TANKS;let n=reportHeader("Tank-wise DSR report",s.start,s.end),o=!1;return r.forEach(a=>{const u=t.filter(g=>normalizeProduct(g.product)===a.product);if(!u.length)return;o=!0;const i=a.product==="petrol"?"petrol_rate":"diesel_rate";n+=buildTankDsrSection(a.product,a.label,a.capacity,u,i)}),o?n+='<p class="report-note muted">One section per physical tank (HSD and MS). Short = max(0, book \u2212 dip); Total = open + buy \u2212 short; Actual = meter \u2212 testing; Var = actual \u2212 sale by dip (open + buy \u2212 close); TVA = tank capacity \u2212 closing dip.</p>':n+='<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>',n}function fuelIncomeMetrics(e,s){if(!e)return{litres:0,saleRate:0,buyRate:null,income:null,missingBuy:!1};const t=getDsrNetSaleLitres(e),r=getDsrSaleRate(e),n=getEffectiveBuyingRate(e,s),o=t>0&&n==null,a=n!=null&&t>0?t*(r-n):null;return{litres:t,saleRate:r,buyRate:n,income:a,missingBuy:o}}function formatFuelIncomeCell(e,{empty:s="\u2014"}={}){return e==null||!Number.isFinite(e)?s:formatNumberPlain(e)}function renderFuelIncome(e,s){const t=createBuyingRateContext(e.receiptRows),r=new Map;(e.dsrRows??[]).forEach(c=>{const m=c.date;if(!m)return;r.has(m)||r.set(m,{petrol:null,diesel:null});const p=normalizeProduct(c.product);(p==="petrol"||p==="diesel")&&(r.get(m)[p]=c)});const n=[...r.keys()].sort();let o=0,a=0,u=0,i=0,g=0;const d=n.map(c=>{const m=r.get(c),p=fuelIncomeMetrics(m.petrol,t),b=fuelIncomeMetrics(m.diesel,t);(p.missingBuy||b.missingBuy)&&(g+=1),o+=p.litres,a+=b.litres,p.income!=null&&(u+=p.income),b.income!=null&&(i+=b.income);const f=(p.income!=null?p.income:0)+(b.income!=null?b.income:0),h=p.income==null&&b.income==null&&(p.litres>0||b.litres>0)?"\u2014":formatNumberPlain(f);return`<tr>
        <td>${formatNumericDate(c)}</td>
        <td class="num">${formatFuelIncomeCell(p.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(p.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(p.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(p.income)}</td>
        <td class="num">${formatFuelIncomeCell(b.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(b.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(b.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(b.income)}</td>
        <td class="num"><strong>${h}</strong></td>
      </tr>`}).join(""),y=u+i,l=g>0?`<p class="report-note warning">${g} day(s) have sale litres but no landed buying rate \u2014 P.Rate / P.Income blank for those products. Enter buying price on Meter Reading \u2192 Purchase cost for receipt days.</p>`:"";return`
    ${reportHeader("Fuel Sale Income Report",s.start,s.end)}
    <table class="report-table report-fuel-income-table">
      <thead>
        <tr>
          <th rowspan="2" scope="col">Date</th>
          <th colspan="4" scope="colgroup">Petrol (MS)</th>
          <th colspan="4" scope="colgroup">Diesel (HSD)</th>
          <th rowspan="2" scope="col" class="num">Total Income</th>
        </tr>
        <tr>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate \u20B9/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate \u20B9/L">P.Rate</th>
          <th scope="col" class="num" title="Margin \u20B9">P.Income</th>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate \u20B9/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate \u20B9/L">P.Rate</th>
          <th scope="col" class="num" title="Margin \u20B9">P.Income</th>
        </tr>
      </thead>
      <tbody>${d||'<tr><td colspan="10" class="muted">No meter readings in this period.</td></tr>'}</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${formatNumberPlain(o)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
        </tr>
      </tfoot>
    </table>
    ${l}
    <p class="report-note muted">P.Income = net litres (meter \u2212 testing) \xD7 (selling rate \u2212 landed buying rate incl. VAT + delivery). Same fuel-margin basis as Analysis and Reports P&amp;L.</p>`}function reportHeader(e,s,t){const r=PumpSettings.getStationGstin();return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
          ${r?`<p class="report-gstin">GSTIN: ${escapeHtml(r)}</p>`:""}
          <p class="report-title">${escapeHtml(e)}</p>
          <p class="report-period">Period: ${formatNumericDate(s)} &nbsp;\u2013&nbsp; ${formatNumericDate(t)}</p>
        </div>
      </div>
    </header>`}async function loadAndRenderReports(){const e=document.getElementById("reports-start")?.value,s=document.getElementById("reports-end")?.value,t=document.getElementById("reports-error"),r=document.getElementById("reports-preview"),n=document.getElementById("reports-date-label");if(t?.classList.add("hidden"),!e||!s){t&&(t.textContent="Please select from and to dates.",t.classList.remove("hidden"));return}let o=e,a=s;a<o&&([o,a]=[a,o]),n&&(n.textContent=o===a?formatNumericDate(o):`${formatNumericDate(o)} \u2013 ${formatNumericDate(a)}`),r&&(r.textContent="Loading\u2026"),setReportPrintButtonWaiting();const u=`reports_${o}_${a}`,i=()=>fetchReportData(o,a);try{await loadPumpSettings(),typeof withProgress=="function"?cachedData=await withProgress(async()=>typeof AppCache<"u"&&AppCache?AppCache.getWithSWR(u,i,"reports_data"):i()):typeof AppCache<"u"&&AppCache?cachedData=await AppCache.getWithSWR(u,i,"reports_data"):cachedData=await i(),cachedRange={start:o,end:a},clearReportDerivedCache();try{const{data:g,error:d}=await supabaseClient.rpc("get_meter_sales_breakdown",{p_start:o,p_end:a});if(d)throw d;cachedData&&(cachedData.meterBreakdown=g||null)}catch(g){AppError.report(g,{context:"loadAndRenderReports.meterBreakdown"}),cachedData&&(cachedData.meterBreakdown=null)}renderActiveReport()}catch(g){AppError.report(g,{context:"loadAndRenderReports"}),r&&(r.innerHTML=`<p class="error">${escapeHtml(g.message||"Failed to load data.")}</p>`)}}function normalizeReportsPayload(e){const s=[e.dsrError,e.stockError,e.expenseError,e.invoiceError,e.invoiceItemsError,e.categoriesError].filter(Boolean);if(s.length)throw s[0];return{dsrRows:e.dsrRows??[],stockRows:e.stockRows??[],expenseRows:e.expenseRows??[],invoices:e.invoices??[],invoiceItems:e.invoiceItems??[],vaultPurchases:e.vaultPurchases??[],categoryMap:buildExpenseCategoryMap(e.expenseCategories),receiptRows:e.receiptRows??[]}}async function fetchReportData(e,s){try{const t=()=>supabaseClient.functions.invoke("get-reports-data",{body:{startDate:e,endDate:s,receiptHistoryStart:PumpSettings.getReceiptHistoryStart()}}),{data:r,error:n}=typeof AppError<"u"&&AppError?.withRetry?await AppError.withRetry(t,{maxAttempts:3}):await t();if(n)throw n;return normalizeReportsPayload({dsrRows:r.dsrRows,receiptRows:r.receiptRows,stockRows:r.stockRows,expenseRows:r.expenseRows,invoices:r.invoices,invoiceItems:r.invoiceItems,vaultPurchases:r.vaultPurchases,expenseCategories:r.expenseCategories,dsrError:r.errors?.dsr?new Error(r.errors.dsr):null,stockError:r.errors?.stock?new Error(r.errors.stock):null,expenseError:r.errors?.expense?new Error(r.errors.expense):null,invoiceError:r.errors?.invoice?new Error(r.errors.invoice):null,invoiceItemsError:r.errors?.invoiceItems?new Error(r.errors.invoiceItems):null,categoriesError:r.errors?.categories?new Error(r.errors.categories):null})}catch{return fetchReportDataDirect(e,s)}}async function fetchReportDataDirect(e,s){const[t,r,n,o,a,u]=await Promise.all([DsrQueries.fetchDsrRows(e,s,{select:DsrQueries.DSR_SELECT_FULL}),supabaseClient.rpc("get_dsr_stock_range",{p_start:e,p_end:s}),DsrQueries.fetchExpenses(e,s,"date, category, amount, description"),supabaseClient.from("invoices").select("id, invoice_number, invoice_date, party_name, party_gstin, total_amount, cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total").gte("invoice_date",e).lte("invoice_date",s).order("invoice_date",{ascending:!0}),supabaseClient.from("expense_categories").select("name, label").order("sort_order"),supabaseClient.from("invoice_documents").select("id, invoice_date, vendor, amount, category, title, drive_web_view_link").eq("category","purchase").gte("invoice_date",e).lte("invoice_date",s)]),i=o.data??[];let g=[];if(i.length){const d=i.map(m=>m.id),y=80,l=[];for(let m=0;m<d.length;m+=y)l.push(d.slice(m,m+y));const c=await Promise.all(l.map(m=>supabaseClient.from("invoice_items").select("invoice_id, gst_percent, amount").in("invoice_id",m)));for(const m of c){if(m.error)throw m.error;m.data?.length&&g.push(...m.data)}}return normalizeReportsPayload({dsrRows:t.data,receiptRows:t.receiptRows,stockRows:r.data,expenseRows:n.data,invoices:i,invoiceItems:g,vaultPurchases:u.error?[]:u.data??[],expenseCategories:a.data,dsrError:t.error,stockError:r.error,expenseError:n.error,invoiceError:o.error,invoiceItemsError:null,categoriesError:a.error})}function classifyGstSlab(e){const s=Number(e);return s<0?"non_gst":s===0?"nil":s===5?"r5":s===12?"r12":s===18?"r18":s===24?"r24":s===28?"r28":"r18"}function slabHasActivity(e){return e?Math.abs(Number(e.taxable??0))>.005||Math.abs(Number(e.gross??0))>.005:!1}function sumInvoiceLineAmounts(e){let s=0,t=0,r=0;return e.forEach(n=>{const o=Number(n.amount??0),a=Number(n.gst_percent??0);a>0?s+=o/(1+a/100):a===0?r+=o:t+=o}),{taxable:s,nonGst:t,nilRate:r}}function invoiceHeaderTaxable(e){const s=Number(e.cgst_total??0),t=Number(e.sgst_total??0),r=Number(e.igst_total??0),n=Number(e.non_gst_total??0),o=Number(e.nil_rate_total??0),u=Number(e.total_amount??0)-s-t-r-n-o;if(Number.isFinite(u)&&u>=0)return u;const i=Number(e.subtotal??0)-Number(e.discount??0);return Number.isFinite(i)&&i>=0?i:0}function aggregateInvoiceGst(e,s){return aggregateInvoiceGstByPlace(e,s).combined}function aggregateInvoiceGstByPlace(e,s){const t=new Map;s.forEach(a=>{t.has(a.invoice_id)||t.set(a.invoice_id,[]),t.get(a.invoice_id).push(a)});const r=emptySlabTotals(),n=emptySlabTotals(),o=(a,u,{taxable:i=0,cgst:g=0,sgst:d=0,igst:y=0,gross:l=0})=>{a[u]&&(a[u].taxable+=i,a[u].cgst+=g,a[u].sgst+=d,a[u].igst+=y,a[u].gross+=l)};return e.forEach(a=>{const u=t.get(a.id)||[],i=Number(a.igst_total??0),g=Number(a.cgst_total??0),d=Number(a.sgst_total??0),y=i>0||g+d<=0&&isInterstatePartyGstin(a.party_gstin),l=y?n:r;if(u.length)u.forEach(c=>{const m=Number(c.amount??0),p=Number(c.gst_percent??0),b=classifyGstSlab(p);if(p>0){const f=m/(1+p/100),h=m-f;y?o(l,b,{taxable:f,igst:h,gross:m}):o(l,b,{taxable:f,cgst:h/2,sgst:h/2,gross:m})}else p===0?o(l,"nil",{taxable:m,gross:m}):o(l,"non_gst",{taxable:m,gross:m})});else{const c=Number(a.non_gst_total??0),m=Number(a.nil_rate_total??0),p=Number(a.total_amount??0),b=invoiceHeaderTaxable(a);if(g>0||d>0||i>0){const f=classifyGstSlab(18);y?o(l,f,{taxable:b,igst:i>0?i:g+d,gross:b+g+d+i}):o(l,f,{taxable:b,cgst:g,sgst:d,gross:b+g+d+i})}else m>0?o(l,"nil",{taxable:m,gross:m}):c>0?o(l,"non_gst",{taxable:c,gross:c}):p>0&&o(l,"non_gst",{taxable:p,gross:p})}}),{inside:r,outside:n,combined:mergeSlabTotals(r,n)}}function renderGstSummaryTable(e,s,t,r,n={}){const{sectionOnly:o=!1,sectionTitle:a=s,place:u="inside",showIgst:i=u==="outside"||u==="all"}=n,d=GST_SLABS.filter($=>slabHasActivity(e[$.key])).map($=>{const P=e[$.key]||emptySlabBucket(),w=P.cgst+P.sgst;return u==="outside"?`<tr>
      <td>${escapeHtml($.label)}</td>
      <td class="num">${formatNumberPlain(P.taxable)}</td>
      <td class="num">${formatNumberPlain(P.igst||0)}</td>
      <td class="num">${formatNumberPlain(P.gross)}</td>
    </tr>`:r?`<tr>
      <td>${escapeHtml($.label)}</td>
      <td class="num">${formatNumberPlain(P.taxable)}</td>
      <td class="num">${formatNumberPlain(w)}</td>
      <td class="num">${i?formatNumberPlain(P.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain(P.gross)}</td>
    </tr>`:`<tr>
      <td>${escapeHtml($.label)}</td>
      <td class="num">${formatNumberPlain(P.taxable)}</td>
      <td class="num">${formatNumberPlain(P.cgst)}</td>
      <td class="num">${formatNumberPlain(P.sgst)}</td>
      <td class="num">${i?formatNumberPlain(P.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain(P.gross)}</td>
    </tr>`}).join(""),y=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.taxable||0),0),l=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.cgst||0),0),c=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.sgst||0),0),m=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.igst||0),0),p=l+c,b=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.gross||0),0);let f,h,N;u==="outside"?(f='<th>Slab</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">Total</th>',h=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(m)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(b)}</strong></td>`,N=4):r?(f=`<th>Slab</th><th class="num">Taxable</th><th class="num">VAT/LST</th><th class="num">${i?"IGST":"\u2014"}</th><th class="num">Total</th>`,h=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
          <td class="num"><strong>${i?formatNumberPlain(m):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(b)}</strong></td>`,N=5):(f=`<th>Slab</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">${i?"IGST":"\u2014"}</th><th class="num">Total</th>`,h=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
          <td class="num"><strong>${i?formatNumberPlain(m):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(b)}</strong></td>`,N=6);const S=u==="outside"?"Outside state (IGST)":u==="all"?r?"Combined inward supply":"Combined outward supply":r?"Inside state inward supply":"Inside state outward supply (CGST + SGST)",v=r?`${S} \xB7 ${escapeHtml(getPurchaseTaxPctLabel())} \xB7 ${isPurchaseTaxInclusive()?"tax-inclusive rate":"pre-tax rate (BPCL)"}`:S,T=o?`<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(a)}</h3>`:reportHeader(s,t.start,t.end),_=o?"</section>":"",R=r?`VAT/LST: <strong>${formatNumberPlain(p)}</strong>${i?` \xB7 IGST: <strong>${formatNumberPlain(m)}</strong>`:""}`:`CGST: <strong>${formatNumberPlain(l)}</strong> \xB7 SGST: <strong>${formatNumberPlain(c)}</strong>${i?` \xB7 IGST: <strong>${formatNumberPlain(m)}</strong>`:""}`;return`
    ${T}
    <p class="report-subtitle${o?" muted":""}">${v}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>${f}</tr>
      </thead>
      <tbody>${d||`<tr><td colspan="${N}" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          ${h}
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Taxable: <strong>${formatNumberPlain(y)}</strong> \xB7 ${R} \xB7 Gross: <strong>${formatNumberPlain(b)}</strong></p>${_}`}function slabTotalsHaveActivity(e){return GST_SLABS.some(s=>slabHasActivity(e[s.key]))}function renderFuelSalesMonthTable(e,s){const t=e.map(n=>`<tr class="${fuelRowClass(n.product)}">
        <td>${escapeHtml(n.monthLabel)}</td>
        <td>${escapeHtml(n.productLabel)}</td>
        <td class="num">${formatNumberPlain(n.litres)}</td>
        <td class="num">${formatNumberPlain(n.nilValue??n.gross)}</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">${formatNumberPlain(n.gross)}</td>
      </tr>`).join(""),r=sumFuelSalesLines(e);return`
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(s)}</h3>
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
        <tbody>${t||'<tr><td colspan="7" class="muted">No fuel sales in this period</td></tr>'}</tbody>
        ${e.length?`<tfoot>
          <tr class="report-total-row">
            <td colspan="2"><strong>Fuel total</strong></td>
            <td class="num"><strong>${formatNumberPlain(r.litres)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(r.gross)}</strong></td>
            <td class="num"><strong>\u2014</strong></td>
            <td class="num"><strong>\u2014</strong></td>
            <td class="num"><strong>${formatNumberPlain(r.gross)}</strong></td>
          </tr>
        </tfoot>`:""}
      </table>
    </section>`}function renderGstSalesSummary(e,s){const t=isBillingIncludedInGstReports(),r=buildFuelSalesMonthLines(e.dsrRows,s),n=fuelSalesToSlabTotals(r),o=t?aggregateInvoiceGst(e.invoices,e.invoiceItems):null,a=o?mergeSlabTotals(n,o):n,u=renderFuelSalesMonthTable(r,"Fuel sales \u2014 month-wise"),i=t?renderGstSummaryTable(o,"Billing \u2014 GST slab summary",s,!1,{sectionOnly:!0,sectionTitle:"Billing \u2014 GST slab summary"}):'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing \u2192 Include billing in GST sales reports).</p>',g=renderGstSummaryTable(a,"Combined outward supply \u2014 GST summary",s,!1,{sectionOnly:!0,sectionTitle:"Combined outward supply \u2014 GST summary"});return`
    ${reportHeader("Outward supply \u2014 GST summary",s.start,s.end)}
    ${u}
    ${i}
    ${g}`}function renderGstSalesDetail(e,s){const t=isBillingIncludedInGstReports(),r=buildFuelSalesDailyInvoices(e.dsrRows,s),n=r.map(c=>({sortDate:c.date,sortKey:`0-${c.invoiceNumber}`,html:`<tr class="${fuelRowClass(c.product)}">
        <td>${formatNumericDate(c.date)}</td>
        <td>Fuel \xB7 ${escapeHtml(c.productLabel)}</td>
        <td>${escapeHtml(c.invoiceNumber)} \xB7 ${escapeHtml(c.partyName)}</td>
        <td>\u2014</td>
        <td class="num">${formatNumberPlain(c.litres)}</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">${formatNumberPlain(c.nilValue??c.gross)}</td>
        <td class="num">${formatNumberPlain(c.gross)}</td>
      </tr>`})),o=new Map;e.invoiceItems.forEach(c=>{o.has(c.invoice_id)||o.set(c.invoice_id,[]),o.get(c.invoice_id).push(c)});const a=t?e.invoices.map(c=>{const m=o.get(c.id)||[],p=Number(c.cgst_total??0),b=Number(c.sgst_total??0),f=Number(c.igst_total??0),h=p+b+f>0,N=(c.party_gstin||"").trim().toUpperCase()||"\u2014";let S=0,v=0,T=0;if(m.length){const _=sumInvoiceLineAmounts(m);S=_.taxable,v=_.nonGst,T=_.nilRate}else v=Number(c.non_gst_total??0),T=Number(c.nil_rate_total??0),S=invoiceHeaderTaxable(c);return{sortDate:c.invoice_date,sortKey:`1-${c.invoice_number}`,html:`<tr class="report-billing-row">
        <td>${formatNumericDate(c.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(c.invoice_number)} \xB7 ${escapeHtml(c.party_name)}</td>
        <td>${escapeHtml(N)}</td>
        <td class="num">\u2014</td>
        <td class="num">${h||S>0?formatNumberPlain(S):"\u2014"}</td>
        <td class="num">${formatNumberPlain(p)}</td>
        <td class="num">${formatNumberPlain(b)}</td>
        <td class="num">${formatNumberPlain(f)}</td>
        <td class="num">${formatNumberPlain(v+T)}</td>
        <td class="num">${formatNumberPlain(c.total_amount)}</td>
      </tr>`}}):[],u=[...n,...a].sort((c,m)=>c.sortDate.localeCompare(m.sortDate)||c.sortKey.localeCompare(m.sortKey)).map(c=>c.html).join(""),i=sumFuelSalesLines(r),g=r.length>0,d=t&&e.invoices.length>0,y=!g&&!d?`<tr><td colspan="11" class="muted">${t?"No fuel sales or billing in this period":"No fuel sales in this period"}</td></tr>`:"",l=t?"":'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing).</p>';return`
    ${reportHeader("Outward supply \u2014 GST detail register",s.start,s.end)}
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
        ${u}
        ${y}
      </tbody>
      ${g?`<tfoot>
        <tr class="report-total-row">
          <td colspan="4"><strong>Fuel total (${r.length} SFC)</strong></td>
          <td class="num"><strong>${formatNumberPlain(i.litres)}</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>${formatNumberPlain(i.gross)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(i.gross)}</strong></td>
        </tr>
      </tfoot>`:""}
    </table>`}function collectFuelPurchaseLines(e,s,t){const r=l=>l.date>=s.start&&l.date<=s.end,n=t??createBuyingRateContext(e.receiptRows??[]).getStored,o=e.vaultPurchases??[],a=new Map(o.map(l=>[l.id,l])),u=new Map;o.forEach(l=>{const c=String(l.title||"").trim().toLowerCase();c&&!u.has(c)&&u.set(c,l)});const i=[],g=new Set,d=l=>{if(l.invoiceDocumentId&&a.has(l.invoiceDocumentId))return a.get(l.invoiceDocumentId);const c=String(l.supplierInvoiceNo||"").trim().toLowerCase();return c?u.has(c)?u.get(c):o.find(m=>String(m.title||"").toLowerCase().includes(c))||null:null},y=(l,c,m,p,b={})=>{const f=Number(m),h=Number(p);if(!Number.isFinite(f)||f<=0||!Number.isFinite(h)||h<=0)return;const N=`${l}-${normalizeProduct(c)}`;if(g.has(N))return;g.add(N);const S=d(b);i.push({date:l,product:c,litres:f,rate:h,supplierInvoiceNo:b.supplierInvoiceNo||S?.title||"",supplierGstin:b.supplierGstin||"",invoiceDocumentId:b.invoiceDocumentId||S?.id||null,driveWebViewLink:S?.drive_web_view_link||null})};return(e.receiptRows??[]).filter(r).forEach(l=>{y(l.date,l.product,Number(l.receipts??0),Number(l.buying_price_per_litre),{supplierInvoiceNo:l.supplier_invoice_no,supplierGstin:l.supplier_gstin,invoiceDocumentId:l.invoice_document_id})}),(e.dsrRows??[]).filter(r).forEach(l=>{const c=Number(l.receipts??0);if(c<=0)return;const m=Number(l.buying_price_per_litre);!Number.isFinite(m)||m<=0||y(l.date,l.product,c,m,{supplierInvoiceNo:l.supplier_invoice_no,supplierGstin:l.supplier_gstin,invoiceDocumentId:l.invoice_document_id})}),i.sort((l,c)=>l.date.localeCompare(c.date)||normalizeProduct(l.product).localeCompare(normalizeProduct(c.product)))}function countReceiptsMissingBuying(e,s){const t=r=>r.date>=s.start&&r.date<=s.end;return(e.dsrRows??[]).filter(r=>{if(!t(r)||Number(r.receipts??0)<=0)return!1;const n=Number(r.buying_price_per_litre);return!Number.isFinite(n)||n<=0}).length}function buildFuelPurchaseRows(e,s){const t=createBuyingRateContext(e.receiptRows??[]).getStored,r=collectFuelPurchaseLines(e,s,t),n=countReceiptsMissingBuying(e,s),o=emptySlabTotals(),a=emptySlabTotals();return{detailRows:r.map(({date:i,product:g,litres:d,rate:y,supplierInvoiceNo:l,supplierGstin:c,invoiceDocumentId:m,driveWebViewLink:p})=>{const b=getPurchaseTaxPct(g),f=classifyGstSlab(b),{taxable:h,tax:N,gross:S,cgst:v,sgst:T}=calcPurchaseLineTax(d,y,b),_=resolveSupplierGstin(c),R=isInterstatePartyGstin(_),$=R?a:o;return $[f]&&($[f].taxable+=h,R?$[f].igst+=N:($[f].cgst+=v,$[f].sgst+=T),$[f].gross+=S),{date:i,product:g,litres:d,rate:y,taxPct:b,taxable:h,tax:N,gross:S,cgst:R?0:v,sgst:R?0:T,igst:R?N:0,interstate:R,supplierInvoiceNo:l||"",supplierGstin:_,invoiceDocumentId:m||null,driveWebViewLink:p||null}}),insideSlabs:o,outsideSlabs:a,slabTotals:mergeSlabTotals(o,a),missingBuyingCount:n}}function renderGstPurchaseSummary(e,s){const{insideSlabs:t,outsideSlabs:r,slabTotals:n,detailRows:o,missingBuyingCount:a}=getFuelPurchaseRows(e,s),u=a>0?`<p class="report-note warning">${a} receipt(s) in this period have no buying price \u2014 excluded. Enter buying price on Meter Reading \u2192 Purchase cost.</p>`:"",i=o.length===0?'<p class="report-note muted">No fuel receipts with buying price in this period.</p>':"",g=renderGstSummaryTable(t,"Inside state",s,!0,{sectionOnly:!0,sectionTitle:"Inside state inward supply",place:"inside",showIgst:!1}),d=slabTotalsHaveActivity(r)?renderGstSummaryTable(r,"Outside state",s,!0,{sectionOnly:!0,sectionTitle:"Outside state inward supply",place:"outside",showIgst:!0}):'<section class="report-gst-section"><h3 class="report-section-title">Outside state inward supply</h3><p class="muted">No interstate inward supply in this period (supplier GSTIN state matches station, or GSTIN blank).</p></section>',y=renderGstSummaryTable(n,"Combined",s,!0,{sectionOnly:!0,sectionTitle:"Total inward supply summary",place:"all",showIgst:!0});return`
    ${reportHeader("Inward supply \u2014 GST summary (Fuel receipts)",s.start,s.end)}
    ${i}
    ${g}
    ${d}
    ${y}
    ${u}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())} Place of supply uses supplier GSTIN vs station GSTIN.</p>`}function renderGstPurchaseDetail(e,s){const{detailRows:t,missingBuyingCount:r}=getFuelPurchaseRows(e,s),n=t.map(o=>{const a=normalizeProduct(o.product),u=a==="petrol"?"MS":a==="diesel"?"HSD":String(o.product).toUpperCase(),i=o.supplierInvoiceNo?escapeHtml(o.supplierInvoiceNo):"\u2014",g=o.supplierGstin?escapeHtml(o.supplierGstin):"\u2014",d=o.driveWebViewLink?`<a href="${escapeHtml(o.driveWebViewLink)}" target="_blank" rel="noopener">View PDF</a>`:o.invoiceDocumentId?"Linked":"\u2014";return`<tr class="${fuelRowClass(a)}">
      <td>${formatNumericDate(o.date)}</td>
      <td>${formatFuelBadge(u)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td>${i}</td>
      <td>${g}</td>
      <td class="num">${d}</td>
      <td class="num">${formatNumberPlain(o.litres)}</td>
      <td class="num">${formatBuyingRatePerKl(o.rate)}</td>
      <td class="num">${formatNumberPlain(o.taxable)}</td>
      <td class="num">${o.taxPct}%</td>
      <td class="num">${formatNumberPlain(o.tax)}</td>
      <td class="num">${formatNumberPlain(o.gross)}</td>
    </tr>`}).join("");return`
    ${reportHeader("Inward supply \u2014 GST detail (Fuel receipts)",s.start,s.end)}
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
      <tbody>${n||'<tr><td colspan="12" class="muted">No receipts with buying price in period</td></tr>'}</tbody>
    </table>
    ${r>0?`<p class="report-note warning">${r} receipt(s) excluded \u2014 buying price not set on Meter Reading \u2192 Purchase cost.</p>`:""}
    <p class="report-note muted">Vault PDF links match DSR receipt \u2192 Invoices (purchase) by document id or invoice title. Enter invoice no with buying price on Meter Reading \u2192 Purchase cost. ${escapeHtml(getPurchaseGstDetailNote())}</p>`}function computeTradingAndPl(e,s){const t=createBuyingRateContext(e.receiptRows),r=DsrQueries.mergeDsrStock(e.dsrRows,e.stockRows),n={petrol:{label:"Petrol (MS)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},diesel:{label:"Diesel (HSD)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},lube:{label:"Lubricant / Billing",sales:0,purchase:0,openingStockVal:0,closingStockVal:0}},o={petrol:{first:null,last:null},diesel:{first:null,last:null}};r.forEach(p=>{const b=normalizeProduct(p.product);if(!n[b])return;const f=getDsrNetSaleLitres(p),h=getDsrSaleRate(p),N=Number(p.receipts??0);if(N>0){const S=getEffectiveBuyingRate(p,t);S!=null&&(n[b].purchase+=N*S)}n[b].sales+=f*h,o[b]&&(o[b].first||(o[b].first=p),o[b].last=p)}),["petrol","diesel"].forEach(p=>{const b=o[p].first,f=o[p].last;if(!b||!f)return;n[p].openingL=Number(b.opening_stock??0),n[p].closingL=Number(f.dip_stock??f.stock??0);const h=getLandedBuyingRateForDate(p,b.date,t)??0,N=getLandedBuyingRateForDate(p,f.date,t)??h;n[p].openingStockVal=n[p].openingL*h,n[p].closingStockVal=n[p].closingL*N}),n.lube.sales=e.invoices.reduce((p,b)=>p+Number(b.total_amount??0),0);const a=(e.vaultPurchases??[]).reduce((p,b)=>{const f=Number(b.amount??0);return f>0?p+f:p},0);n.lube.purchase=a;const u=Object.values(n).reduce((p,b)=>p+b.sales,0),i=Object.values(n).reduce((p,b)=>p+b.purchase,0),g=Object.values(n).reduce((p,b)=>p+b.openingStockVal,0),d=Object.values(n).reduce((p,b)=>p+b.closingStockVal,0),y=u+d-g-i,l=computeProfitLossSummary({dsrRows:r,receiptRows:e.receiptRows,expenseRows:e.expenseRows,lubeSales:n.lube.sales,lubeCogs:a,requireAllBuying:!0,buyingContext:t,categoryMap:e.categoryMap}),c=new Map,m=new Map;return e.expenseRows.forEach(p=>{const b=p.category||"misc",f=getExpenseCategoryLabel(p,e.categoryMap),h=Number(p.amount??0),N=isTestingExpenseRow(p,e.categoryMap)?m:c;N.has(b)||N.set(b,{label:f,amount:0}),N.get(b).amount+=h}),{products:n,grossSales:u,totalPurchase:i,openingStock:g,closingStock:d,grossIncome:y,vaultPurchaseTotal:a,fuelGrossProfit:l.canCalculate?l.fuelGrossProfit??0:null,lubeGrossProfit:l.canCalculate?l.lubeGrossProfit??0:null,lubeCogs:a,grossProfit:l.canCalculate?l.grossProfit??0:null,expensesByCategory:c,testingExpensesByCategory:m,totalExpenses:l.totalExpenses,testingExpenses:l.testingExpenses,netProfit:l.canCalculate?l.netProfit:null,canCalculate:l.canCalculate,missingBuyingPrice:l.missingBuyingPrice,unresolvedBuying:l.unresolvedBuying,usingProvisionalBuying:l.usingProvisionalBuying}}function renderProfitGuide(e){return e==="trading"?`
      <aside class="report-profit-guide no-print" aria-label="How to read Gross income">
        <p class="report-profit-guide-title">Quick reference</p>
        <ul class="report-profit-guide-list">
          <li><strong>Gross income c/d</strong> \u2014 balances the trading account using stock. Useful for books, <em>not</em> your take-home profit.</li>
          <li><strong>Do not compare</strong> this to Gross profit / Nett profit on P&amp;L \u2014 different formula (stock vs per-litre margin).</li>
          <li><strong>Your real profit</strong> \u2014 open <strong>Profit &amp; Loss</strong> and use <strong>Nett Profit</strong> (or Dashboard \u2192 P&amp;L).</li>
        </ul>
      </aside>`:`
    <aside class="report-profit-guide no-print" aria-label="How to read profit figures">
      <p class="report-profit-guide-title">Quick reference</p>
      <ul class="report-profit-guide-list">
        <li><strong>Nett Profit</strong> \u2014 your <em>real profit</em> after expenses for this period. Use this number.</li>
        <li><strong>Gross Profit</strong> \u2014 margin before rent, salary, electricity, etc. (not take-home yet).</li>
        <li><strong>Gross income c/d</strong> (Trading account) \u2014 different figure; stock-based, not the same as Gross / Nett profit.</li>
      </ul>
    </aside>`}function renderTradingAccount(e,s){const t=getTradingAndPl(e,s),r=[["Sales \u2014 Petrol (MS)",t.products.petrol.sales,"petrol"],["Sales \u2014 Diesel (HSD)",t.products.diesel.sales,"diesel"],["Sales \u2014 Lube / Billing",t.products.lube.sales,null],["Closing stock \u2014 Petrol",t.products.petrol.closingStockVal,"petrol"],["Closing stock \u2014 Diesel",t.products.diesel.closingStockVal,"diesel"]],n=[["Opening stock \u2014 Petrol",t.products.petrol.openingStockVal,"petrol"],["Opening stock \u2014 Diesel",t.products.diesel.openingStockVal,"diesel"],["Purchases \u2014 Petrol",t.products.petrol.purchase,"petrol"],["Purchases \u2014 Diesel",t.products.diesel.purchase,"diesel"]];t.vaultPurchaseTotal>0&&n.push(["Purchases \u2014 Lube / other (vault)",t.vaultPurchaseTotal,null]),n.push(["Gross income c/d",t.grossIncome,null]);const o=(g,d)=>{const y=d.map(([c,m,p])=>`<tr class="${fuelRowClass(p)}"><td>${escapeHtml(c)}</td><td class="num">${formatNumberPlain(m)}</td></tr>`).join(""),l=d.reduce((c,[,m])=>c+Number(m),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(g)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${y}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(l)}</strong></td></tr></tfoot>
        </table>
      </div>`},a=t.usingProvisionalBuying&&t.missingBuyingPrice?.length?`<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) use the previous buying rate for stock/purchases \u2014 enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on Meter Reading \u2192 Purchase cost to lock the correct rate.</p>`:t.canCalculate?"":formatUnresolvedBuyingWarning(t),u=t.fuelGrossProfit!=null?`<p class="report-note muted">Dealer Margin (ops check, not a trading credit) = net litres \xD7 (selling \u2212 landed buying): <strong>${formatCurrency(t.fuelGrossProfit)}</strong> \u2014 same as Dashboard / P&amp;L fuel gross.</p>`:"",i=t.vaultPurchaseTotal>0?'<p class="report-note muted">Lube / other purchases = sum of vault <strong>Purchase invoice</strong> amounts in this period (Invoices page). Fuel inward remains on MS/HSD purchase lines from DSR.</p>':'<p class="report-note muted">No vault purchase amounts in this period \u2014 lube stock/COGS is not tracked separately. Add purchase PDFs with amounts on Invoices to populate Lube purchases.</p>';return`
    ${reportHeader("Trading account",s.start,s.end)}
    ${renderProfitGuide("trading")}
    <div class="report-pl-grid report-trading-grid">
      ${o("Debit",n)}
      ${o("Credit",r)}
    </div>
    <p class="report-note muted">Debit and credit totals match via Gross income c/d (stock-based: Sales + Closing \u2212 Opening \u2212 Purchases). This is not Nett Profit.</p>
    ${a}
    ${u}
    ${i}
    <p class="report-summary-line">Gross income c/d: <strong>${formatCurrency(t.grossIncome)}</strong> <span class="muted">(trading balance \u2014 see P&amp;L for real profit)</span></p>`}function formatUnresolvedBuyingWarning(e){const s=escapeHtml(getBuyingPriceUnitLabel()),t=e.unresolvedBuying?.length??0,r=e.missingBuyingPrice?.length??0;if(!e.canCalculate){const n=t>0?`${t} sale/receipt day(s) have no resolvable buying rate (no prior receipt rate in history)`:"Some days have no resolvable buying rate",o=r>0?` (${r} receipt day(s) also have no entered \u20B9/KL yet)`:"";return`<p class="report-note warning">${n}${o}. Enter pre-VAT ${s} on Meter Reading \u2192 Purchase cost before net profit can be calculated.</p>`}return e.usingProvisionalBuying&&r>0?`<p class="report-note warning">${r} receipt day(s) still need an entered buying price \u2014 figures below use the previous receipt rate until you save ${s} on Meter Reading \u2192 Purchase cost.</p>`:""}function renderProfitLoss(e,s){const t=getTradingAndPl(e,s),r=Array.from(t.expensesByCategory.values()).sort((m,p)=>m.label.localeCompare(p.label)),n=Array.from(t.testingExpensesByCategory.values()).sort((m,p)=>m.label.localeCompare(p.label)),o=formatUnresolvedBuyingWarning(t),a=Number(t.totalExpenses??0),u=n.length?`<p class="report-note muted">Testing expenses excluded from net profit (day closing): ${n.map(m=>`${escapeHtml(m.label)} \u20B9${formatNumberPlain(m.amount)}`).join("; ")}.</p>`:"";if(!t.canCalculate){const m=r.length>0?`<table class="report-table">
            <thead><tr><th>Expense head</th><th class="num">Amount (\u20B9)</th></tr></thead>
            <tbody>${r.map(p=>`<tr><td>${escapeHtml(p.label)}</td><td class="num">${formatNumberPlain(p.amount)}</td></tr>`).join("")}</tbody>
            <tfoot><tr class="report-total-row"><td><strong>Total (excl. testing)</strong></td><td class="num"><strong>${formatNumberPlain(a)}</strong></td></tr></tfoot>
          </table>`:'<p class="muted">No operating expenses in this period.</p>';return`
      ${reportHeader("Profit & loss account",s.start,s.end)}
      ${o}
      <p class="report-summary-line">Gross profit: <strong>\u2014</strong> \xB7 Expenses: <strong>${formatCurrency(a)}</strong> \xB7 Nett profit: <strong>\u2014</strong></p>
      <h3>Operating expenses</h3>
      ${m}
      ${u}
      <p class="report-note muted">Books debit/credit layout is hidden until every sale/receipt day can resolve a buying rate (entered or prior receipt).</p>`}const i=Number(t.grossProfit??0),g=Number(t.netProfit??0),d=[["Gross Profit",i]],y=r.map(m=>[m.label,m.amount]);y.push(["Nett Profit",g]);const l=(m,p,{boldLast:b=!1}={})=>{const f=p.map(([N,S],v)=>{const T=b&&v===p.length-1,_=T?' class="report-total-row"':"",R=T?`<strong>${escapeHtml(N)}</strong>`:escapeHtml(N),$=T?`<strong>${formatNumberPlain(S)}</strong>`:formatNumberPlain(S);return`<tr${_}><td>${R}</td><td class="num">${$}</td></tr>`}).join(""),h=p.reduce((N,[,S])=>N+Number(S),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(m)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${f||'<tr><td colspan="2" class="muted">No entries</td></tr>'}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(h)}</strong></td></tr></tfoot>
        </table>
      </div>`},c=`<p class="report-note muted">Gross profit = fuel gross <strong>${formatCurrency(t.fuelGrossProfit)}</strong>${t.lubeCogs>0||t.products.lube.sales>0?` + lube gross <strong>${formatCurrency(t.lubeGrossProfit)}</strong> (sales \u2212 vault purchases)`:""}. Same formula as Analysis and the Dashboard Net profit glance.</p>`;return`
    ${reportHeader("Profit & loss account",s.start,s.end)}
    ${renderProfitGuide("pl")}
    ${o}
    <div class="report-pl-grid report-trading-grid">
      ${l("Debit (indirect expenses)",y,{boldLast:!0})}
      ${l("Credit",d,{boldLast:!0})}
    </div>
    <p class="report-summary-line">Gross profit: <strong>${formatCurrency(i)}</strong> \xB7 Expenses: <strong>${formatCurrency(a)}</strong> \xB7 Nett profit (real profit): <strong>${formatCurrency(g)}</strong></p>
    ${u}
    ${c}`}function buildGstr1Sections(e,s){const t=isBillingIncludedInGstReports(),n=buildFuelSalesDailyInvoices(e.dsrRows,s).map(i=>({date:i.date,invoiceNumber:i.invoiceNumber,party:i.partyName,gstin:"",taxable:0,cgst:0,sgst:0,igst:0,nilValue:Number(i.nilValue??i.gross??0),gross:Number(i.gross??0),product:i.productLabel})),o=[],a=[];t&&e.invoices.forEach(i=>{const g=(i.party_gstin||"").trim().toUpperCase(),d=Number(i.cgst_total??0),y=Number(i.sgst_total??0),l=Number(i.igst_total??0),c=Number(i.non_gst_total??0),m=Number(i.nil_rate_total??0),p=invoiceHeaderTaxable(i),b={date:i.invoice_date,invoiceNumber:i.invoice_number,party:i.party_name,gstin:g,taxable:p,cgst:d,sgst:y,igst:l,nilValue:c+m,gross:Number(i.total_amount??0)};g.length>=15?o.push(b):a.push(b)});const u=(i,g)=>i.reduce((d,y)=>(g.forEach(l=>{d[l]=(d[l]||0)+Number(y[l]||0)}),d),{});return{includeBilling:t,nilRows:n,b2b:o,b2cs:a,nilTotals:u(n,["nilValue","gross"]),b2bTotals:u(o,["taxable","cgst","sgst","igst","gross"]),b2csTotals:u(a,["taxable","cgst","sgst","igst","nilValue","gross"])}}let reportDerivedCache={dataRef:null,rangeKey:"",gstr1:null,purchases:null,gstr3b:null,tradingPl:null};function clearReportDerivedCache(){reportDerivedCache={dataRef:null,rangeKey:"",gstr1:null,purchases:null,gstr3b:null,tradingPl:null}}function reportDerivedSlot(e,s){const t=`${s?.start||""}|${s?.end||""}`;return(reportDerivedCache.dataRef!==e||reportDerivedCache.rangeKey!==t)&&(clearReportDerivedCache(),reportDerivedCache.dataRef=e,reportDerivedCache.rangeKey=t),reportDerivedCache}function getGstr1Sections(e,s){const t=reportDerivedSlot(e,s);return t.gstr1||(t.gstr1=buildGstr1Sections(e,s)),t.gstr1}function getFuelPurchaseRows(e,s){const t=reportDerivedSlot(e,s);return t.purchases||(t.purchases=buildFuelPurchaseRows(e,s)),t.purchases}function getGstr3bSummary(e,s){const t=reportDerivedSlot(e,s);return t.gstr3b||(t.gstr3b=buildGstr3bSummary(e,s)),t.gstr3b}function getTradingAndPl(e,s){const t=reportDerivedSlot(e,s);return t.tradingPl||(t.tradingPl=computeTradingAndPl(e,s)),t.tradingPl}function renderGstr1Table(e,s,t,r,n){return`
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(e)}</h3>
      <p class="report-subtitle muted">${s}</p>
      <table class="report-table report-gst-detail">
        <thead><tr>${t}</tr></thead>
        <tbody>${r}</tbody>
        ${n||""}
      </table>
    </section>`}function renderGstr1Register(e,s){const t=getGstr1Sections(e,s),r=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL section still included.</p>',n=t.nilRows.map(g=>{const d=String(g.product||"").toLowerCase().includes("diesel")?"diesel":"petrol";return`<tr class="${fuelRowClass(d)}">
      <td>${formatNumericDate(g.date)}</td>
      <td>${escapeHtml(g.invoiceNumber)}</td>
      <td>${escapeHtml(g.product||"Fuel")}</td>
      <td class="num">${formatNumberPlain(g.nilValue)}</td>
      <td class="num">${formatNumberPlain(g.gross)}</td>
    </tr>`}).join("")||'<tr><td colspan="5" class="muted">No fuel sales in this period</td></tr>',o=t.nilRows.length?`<tfoot><tr class="report-total-row">
        <td colspan="3"><strong>NIL total (${t.nilRows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(t.nilTotals.nilValue)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(t.nilTotals.gross)}</strong></td>
      </tr></tfoot>`:"",a=`
    <th>Date</th><th>Invoice</th><th>Party</th><th>GSTIN</th>
    <th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th>
    <th class="num">IGST</th><th class="num">Exempt/NIL</th><th class="num">Gross</th>`,u=g=>g.map(d=>`<tr>
      <td>${formatNumericDate(d.date)}</td>
      <td>${escapeHtml(d.invoiceNumber)}</td>
      <td>${escapeHtml(d.party)}</td>
      <td>${escapeHtml(d.gstin||"\u2014")}</td>
      <td class="num">${formatNumberPlain(d.taxable)}</td>
      <td class="num">${formatNumberPlain(d.cgst)}</td>
      <td class="num">${formatNumberPlain(d.sgst)}</td>
      <td class="num">${formatNumberPlain(d.igst)}</td>
      <td class="num">${formatNumberPlain(d.nilValue)}</td>
      <td class="num">${formatNumberPlain(d.gross)}</td>
    </tr>`).join("")||'<tr><td colspan="10" class="muted">No invoices in this section</td></tr>',i=(g,d)=>g.length?`<tfoot><tr class="report-total-row">
        <td colspan="4"><strong>Total (${g.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(d.taxable)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(d.cgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(d.sgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(d.igst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(d.nilValue||0)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(d.gross)}</strong></td>
      </tr></tfoot>`:"";return`
    ${reportHeader("GSTR-1 style outward register",s.start,s.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-1 \u2014 not a GST portal JSON upload. Sections mirror B2B, B2CS and NIL rated fuel (SFC).</p>
    ${r}
    ${renderGstr1Table("4A/4B \u2014 B2B (registered party GSTIN)","Billing invoices with a 15-character party GSTIN.",a,u(t.b2b),i(t.b2b,t.b2bTotals))}
    ${renderGstr1Table("7 \u2014 B2CS (unregistered / Cash)","Billing invoices without a party GSTIN.",a,u(t.b2cs),i(t.b2cs,t.b2csTotals))}
    ${renderGstr1Table("8 \u2014 NIL rated (fuel SFC)","Daily fuel outward vouchers from DSR (NIL rate).",'<th>Date</th><th>Invoice</th><th>Product</th><th class="num">NIL value</th><th class="num">Gross</th>',n,o)}
    <p class="report-note muted">Use <strong>Download CSV</strong> for a flat file you can reconcile in Excel. Portal filing still requires the official GST offline tool / API.</p>`}function buildGstr1Csv(e,s){const t=getGstr1Sections(e,s),r=[["section","date","invoice","party","gstin","product","taxable","cgst","sgst","igst","nil_value","gross"].join(",")],n=a=>{const u=String(a??"");return/[",\n]/.test(u)?`"${u.replace(/"/g,'""')}"`:u},o=(a,u)=>{r.push([a,u.date,u.invoiceNumber,u.party||"",u.gstin||"",u.product||"",u.taxable??"",u.cgst??"",u.sgst??"",u.igst??"",u.nilValue??"",u.gross??""].map(n).join(","))};return t.b2b.forEach(a=>o("B2B",a)),t.b2cs.forEach(a=>o("B2CS",a)),t.nilRows.forEach(a=>o("NIL",a)),r.join(`
`)}function downloadGstr1Csv(){if(!cachedData||!cachedRange)return;const e=buildGstr1Csv(cachedData,cachedRange),s=new Blob([e],{type:"text/csv;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr1-register_${n}_${o}.csv`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function formatGstr1PortalDate(e){if(!e||String(e).length<10)return"";const[s,t,r]=String(e).slice(0,10).split("-");return`${r}-${t}-${s}`}function gstr1FilingPeriod(e){const s=String(e?.end||"").slice(0,10);if(s.length<7)return"";const[t,r]=s.split("-");return`${r}${t}`}function gstr1StateCodeFromGstin(e){const s=String(e||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function gstr1InvoiceRate(e){const s=Number(e.taxable||0);if(s<=0)return 0;const r=(Number(e.cgst||0)+Number(e.sgst||0)+Number(e.igst||0))/s*100;return r<3?0:r<8?5:r<15?12:r<21?18:r<26?24:28}function buildGstr1Json(e,s){const t=getGstr1Sections(e,s),r=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),n=gstr1StateCodeFromGstin(r)||"21",o=gstr1FilingPeriod(s),a=new Map;t.b2b.forEach(f=>{const h=String(f.gstin||"").trim().toUpperCase();a.has(h)||a.set(h,[]);const N=gstr1InvoiceRate(f),S={txval:Number(Number(f.taxable||0).toFixed(2)),rt:N};Number(f.igst||0)>0?S.iamt=Number(Number(f.igst).toFixed(2)):(S.camt=Number(Number(f.cgst||0).toFixed(2)),S.samt=Number(Number(f.sgst||0).toFixed(2))),a.get(h).push({inum:f.invoiceNumber,idt:formatGstr1PortalDate(f.date),val:Number(Number(f.gross||0).toFixed(2)),pos:gstr1StateCodeFromGstin(h)||n,rchrg:"N",inv_typ:"R",itms:[{num:1,itm_det:S}]})});const u=Array.from(a.entries()).map(([f,h])=>({ctin:f,inv:h})),i=new Map;t.b2cs.forEach(f=>{const h=gstr1InvoiceRate(f),N=Number(f.igst||0)>0,S=`${N?"INTER":"INTRA"}|${n}|${h}`;i.has(S)||i.set(S,{sply_ty:N?"INTER":"INTRA",pos:n,typ:"OE",txval:0,rt:h,iamt:0,camt:0,samt:0,csamt:0});const v=i.get(S);v.txval+=Number(f.taxable||0),v.iamt+=Number(f.igst||0),v.camt+=Number(f.cgst||0),v.samt+=Number(f.sgst||0)});const g=Array.from(i.values()).map(f=>({...f,txval:Number(f.txval.toFixed(2)),iamt:Number(f.iamt.toFixed(2)),camt:Number(f.camt.toFixed(2)),samt:Number(f.samt.toFixed(2))})),y={inv:[{sply_ty:"INTRB2C",expt_amt:0,nil_amt:Number((t.nilTotals.nilValue||0).toFixed(2)),ngsup_amt:0}]},l=(f,h)=>{if(!f.length)return null;const N=f.map(S=>String(S.invoiceNumber||"")).filter(Boolean).sort();return{doc_num:h,docs:[{num:1,from:N[0],to:N[N.length-1],totnum:N.length,cancel:0,net_issue:N.length}]}},c=[],m=[...t.b2b,...t.b2cs],p=l(m,1);p&&c.push(p);const b=l(t.nilRows,4);return b&&c.push(b),{gstin:r||null,fp:o,version:"GST3.1.6",hash:"hash",b2b:u,b2cs:g,nil:y,doc_issue:{doc_det:c},_meta:{note:"Internal aid for GSTR-1 filing tools. Verify every figure before portal upload.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),fuelNilCount:t.nilRows.length,b2bCount:t.b2b.length,b2csCount:t.b2cs.length}}}function downloadGstr1Json(){if(!cachedData||!cachedRange)return;const e=buildGstr1Json(cachedData,cachedRange),s=new Blob([JSON.stringify(e,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr1_${e.fp||`${n}_${o}`}.json`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function gstrMoney(e){return Number(Number(e||0).toFixed(2))}function gstrTaxBucket(e=0,s=0,t=0,r=0,n=0){return{txval:gstrMoney(e),iamt:gstrMoney(s),camt:gstrMoney(t),samt:gstrMoney(r),csamt:gstrMoney(n)}}function buildGstr3bSummary(e,s){const t=getGstr1Sections(e,s),r=getFuelPurchaseRows(e,s);let n=0,o=0;t.includeBilling&&(e.invoices||[]).forEach(h=>{n+=Number(h.nil_rate_total??0),o+=Number(h.non_gst_total??0)});const a=gstrTaxBucket((t.b2bTotals.taxable||0)+(t.b2csTotals.taxable||0),(t.b2bTotals.igst||0)+(t.b2csTotals.igst||0),(t.b2bTotals.cgst||0)+(t.b2csTotals.cgst||0),(t.b2bTotals.sgst||0)+(t.b2csTotals.sgst||0),0),u={txval:gstrMoney((t.nilTotals.nilValue||0)+n)},i={txval:gstrMoney(o)},g=gstrTaxBucket(0,0,0,0,0),d=gstrTaxBucket(0,0,0,0,0);let y=0,l=0;t.b2cs.forEach(h=>{const N=Number(h.igst||0);N<=0||(y+=Number(h.taxable||0),l+=N)});let c=0,m=0,p=0;(r.detailRows||[]).forEach(h=>{c+=Number(h.igst||0),m+=Number(h.cgst||0),p+=Number(h.sgst||0)});const b={ty:"OTH",iamt:gstrMoney(c),camt:gstrMoney(m),samt:gstrMoney(p),csamt:0},f={iamt:0,camt:0,samt:0,csamt:0};return{includeBilling:t.includeBilling,retPeriod:gstr1FilingPeriod(s),osupDet:a,osupZero:g,osupNil:u,osupNongst:i,isupRev:d,interUnregTaxable:gstrMoney(y),interUnregIgst:gstrMoney(l),itcOth:b,itcNet:{iamt:b.iamt,camt:b.camt,samt:b.samt,csamt:0},itcZero:f,purchaseMissingBuying:r.missingBuyingCount||0,purchaseLineCount:(r.detailRows||[]).length,g1:t}}function renderGstr3bRegister(e,s){const t=getGstr3bSummary(e,s),r=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL still included in 3.1(c).</p>',n=t.purchaseMissingBuying>0?`<p class="report-note warning">${t.purchaseMissingBuying} fuel receipt(s) missing buying price \u2014 excluded from Table 4 ITC.</p>`:"",o=(u,i,g,d=!0)=>d?`<tr>
        <td>${escapeHtml(u)}</td>
        <td>${escapeHtml(i)}</td>
        <td class="num">${formatNumberPlain(g.txval)}</td>
        <td class="num">${formatNumberPlain(g.iamt)}</td>
        <td class="num">${formatNumberPlain(g.camt)}</td>
        <td class="num">${formatNumberPlain(g.samt)}</td>
        <td class="num">${formatNumberPlain(g.csamt||0)}</td>
      </tr>`:`<tr>
      <td>${escapeHtml(u)}</td>
      <td>${escapeHtml(i)}</td>
      <td class="num">${formatNumberPlain(g.txval)}</td>
      <td class="num">\u2014</td>
      <td class="num">\u2014</td>
      <td class="num">\u2014</td>
      <td class="num">\u2014</td>
    </tr>`,a=t.interUnregIgst>0?`<p class="report-note warning">Interstate B2CS found (taxable ${formatNumberPlain(t.interUnregTaxable)}, IGST ${formatNumberPlain(t.interUnregIgst)}). Place of supply is not stored on cash invoices \u2014 enter Table 3.2 POS manually on the portal / offline tool.</p>`:'<p class="report-note muted">No interstate B2CS (unregistered) detected in this period.</p>';return`
    ${reportHeader("GSTR-3B style summary",s.start,s.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-3B \u2014 not a guaranteed GST portal upload. Figures roll up from DSR fuel (NIL) and billing invoices; ITC from fuel receipt VAT.</p>
    ${r}
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
          ${o("(a)","Outward taxable supplies (other than zero / nil / exempt)",t.osupDet)}
          ${o("(b)","Outward taxable supplies (zero rated)",t.osupZero)}
          ${o("(c)","Other outward supplies (nil rated, exempted)",t.osupNil,!1)}
          ${o("(d)","Inward supplies liable to reverse charge",t.isupRev)}
          ${o("(e)","Non-GST outward supplies",t.osupNongst,!1)}
        </tbody>
      </table>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">3.2 \u2014 Inter-state supplies to unregistered / composition / UIN</h3>
      ${a}
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
      ${n}
      <p class="report-note muted">Import / ISD / RCM ITC and reversals are not tracked here \u2014 leave those rows blank or fill from books.</p>
    </section>
    <section class="report-gst-section">
      <h3 class="report-section-title">5 \u2014 Exempt / nil / non-GST inward</h3>
      <p class="report-note muted">Not auto-filled (composition / exempt inward not tracked). Leave zeros unless you have separate purchase books.</p>
    </section>
    <p class="report-note muted">Use <strong>Download GSTR-3B JSON</strong> for an offline-utility-style summary file. Verify every figure before portal upload.</p>`}function buildGstr3bJson(e,s){const t=getGstr3bSummary(e,s),r=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),n=o=>({ty:o,...t.itcZero});return{gstin:r||null,ret_period:t.retPeriod,sup_details:{osup_det:t.osupDet,osup_zero:{txval:t.osupZero.txval,iamt:t.osupZero.iamt,csamt:t.osupZero.csamt},osup_nil_exmp:t.osupNil,isup_rev:t.isupRev,osup_nongst:t.osupNongst},inter_sup:{unreg_details:[],comp_details:[],uin_details:[]},eco_dtls:{eco_sup:gstrTaxBucket(0),eco_reg_sup:{txval:0}},itc_elg:{itc_avl:[n("IMPG"),n("IMPS"),n("ISRC"),n("ISD"),{...t.itcOth}],itc_rev:[n("RUL"),n("OTH")],itc_net:t.itcNet,itc_inelg:[n("RUL"),n("OTH")]},inward_sup:{isup_details:[{ty:"GST",inter:0,intra:0},{ty:"NONGST",inter:0,intra:0}]},intr_ltfee:{intr_details:{iamt:0,camt:0,samt:0,csamt:0},ltfee_details:{camt:0,samt:0}},_meta:{note:"Internal aid for GSTR-3B filing tools. Verify every figure before portal upload. Table 3.2 POS omitted when unknown.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),interUnregTaxable:t.interUnregTaxable,interUnregIgst:t.interUnregIgst,purchaseLineCount:t.purchaseLineCount,purchaseMissingBuying:t.purchaseMissingBuying,includeBilling:t.includeBilling}}}function downloadGstr3bJson(){if(!cachedData||!cachedRange)return;const e=buildGstr3bJson(cachedData,cachedRange),s=new Blob([JSON.stringify(e,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr3b_${e.ret_period||`${n}_${o}`}.json`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function updateReportsCsvButtonVisibility(){const e=document.getElementById("reports-csv-btn"),s=document.getElementById("reports-json-btn"),t=!!(cachedData&&cachedRange),r=activeReport==="gstr1"&&t,n=(activeReport==="gstr1"||activeReport==="gstr3b")&&t;e&&(e.classList.toggle("hidden",!r),e.disabled=!r),s&&(s.classList.toggle("hidden",!n),s.disabled=!n,s.textContent=activeReport==="gstr3b"?"Download GSTR-3B JSON":"Download GSTR-1 JSON")}function renderReportHtml(e,s,t){switch(e){case"gst-sales-summary":return renderGstSalesSummary(s,t);case"gst-sales-detail":return renderGstSalesDetail(s,t);case"gst-purchase-summary":return renderGstPurchaseSummary(s,t);case"gst-purchase-detail":return renderGstPurchaseDetail(s,t);case"trading":return renderTradingAccount(s,t);case"pl":return renderProfitLoss(s,t);case"gstr1":return renderGstr1Register(s,t);case"gstr3b":return renderGstr3bRegister(s,t);case"fuel-income":return renderFuelIncome(s,t);case"pump-sales":return renderPumpSalesReport(s,t);case"shift-sales":return renderShiftSalesReport(s,t);case"salesman-sales":return renderSalesmanSalesReport(s,t);case"dsr":default:return renderTankWiseDsr(s,t)}}function productFuelLabel(e){const s=normalizeProduct(e);return s==="petrol"?"MS":s==="diesel"?"HSD":e||"\u2014"}function shiftReportLabel(e){const s=PumpSettings.getShiftConfig?.()||{};return e==="morning"?s.morningName||"Morning":e==="afternoon"?s.afternoonName||"Afternoon":e||"\u2014"}function renderPumpSalesReport(e,s){const t=e.meterBreakdown,r=t?.by_pump||[],n=t?.daily_pump||[],o=new Set(r.map(d=>`${d.reading_date}|${normalizeProduct(d.product)}|${d.pump_no}`)),a=(n||[]).flatMap(d=>{const y=d.date||d.reading_date,l=normalizeProduct(d.product),c=[];for(const m of[1,2]){const p=`${y}|${l}|${m}`;o.has(p)||c.push({reading_date:y,shift:null,product:l,pump_no:m,litres:m===1?Number(d.sales_pump1)||0:Number(d.sales_pump2)||0,net_litres:null,from_daily:!0})}return c}),u=[...r,...a].sort((d,y)=>{const l=String(y.reading_date).localeCompare(String(d.reading_date));if(l)return l;const c=String(d.shift||"").localeCompare(String(y.shift||""));if(c)return c;const m=String(d.product).localeCompare(String(y.product));return m||(d.pump_no||0)-(y.pump_no||0)});let i=0;const g=u.map(d=>(i+=Number(d.litres)||0,`<tr>
          <td>${formatNumericDate(d.reading_date)}</td>
          <td>${d.from_daily?"Daily":escapeHtml(shiftReportLabel(d.shift))}</td>
          <td>${formatFuelBadge(productFuelLabel(d.product))}</td>
          <td>Pump ${escapeHtml(String(d.pump_no))}</td>
          <td class="num">${formatNumberPlain(d.litres)}</td>
          <td class="num">${d.net_litres==null?"\u2014":formatNumberPlain(d.net_litres)}</td>
        </tr>`)).join("");return g?`
    ${reportHeader("Pump-wise sales",s.start,s.end)}
    <p class="muted report-note">Shift nozzle rollups when available; days without shift data fall back to daily P1/P2.</p>
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Fuel</th>
          <th>Pump</th>
          <th class="num">Sale (L)</th>
          <th class="num">Net (L)</th>
        </tr>
      </thead>
      <tbody>${g}</tbody>
      <tfoot>
        <tr>
          <td colspan="4"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td></td>
        </tr>
      </tfoot>
    </table>`:`${reportHeader("Pump-wise sales",s.start,s.end)}
      <p class="muted">No pump sales in this period.</p>
      <p class="muted">Enter meters on <a href="meter-reading.html">Meter Reading</a> or shift nozzle assignments.</p>`}function renderShiftSalesReport(e,s){const t=e.meterBreakdown?.by_shift||[];if(!t.length)return`${reportHeader("Shift-wise sales",s.start,s.end)}
      <p class="muted">No shift register entries in this period.</p>
      <p class="muted">Enter data under <a href="meter-reading.html#shift-readings">Meter Reading \u2192 Shift register</a>.</p>`;let r=0;const n=t.map(o=>(r+=Number(o.litres)||0,`<tr>
        <td>${formatNumericDate(o.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(o.shift))}</td>
        <td>${formatFuelBadge(productFuelLabel(o.product))}</td>
        <td class="num">${formatNumberPlain(o.litres)}</td>
        <td class="num">${formatNumberPlain(o.net_litres)}</td>
        <td class="num">${o.staff_count??"\u2014"}</td>
      </tr>`)).join("");return`
    ${reportHeader("Shift-wise sales",s.start,s.end)}
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Fuel</th>
          <th class="num">Sale (L)</th>
          <th class="num">Net (L)</th>
          <th class="num">Staff</th>
        </tr>
      </thead>
      <tbody>${n}</tbody>
      <tfoot>
        <tr>
          <td colspan="3"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(r)}</strong></td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>`}function renderSalesmanSalesReport(e,s){const t=e.meterBreakdown?.by_salesman||[];if(!t.length)return`${reportHeader("Salesman sales",s.start,s.end)}
      <p class="muted">No salesman assignments in this period.</p>
      <p class="muted">Assign staff to nozzles under <a href="meter-reading.html#shift-readings">Shift register</a>.</p>`;const r=new Map;(e.dsrRows||[]).forEach(l=>{const c=r.get(l.date)||{petrol:0,diesel:0},m=normalizeProduct(l.product);m==="petrol"&&(c.petrol=Number(l.petrol_rate)||c.petrol),m==="diesel"&&(c.diesel=Number(l.diesel_rate)||c.diesel),r.set(l.date,c)});let n=0,o=0,a=0,u=0,i=0,g=0,d=!1;const y=t.map(l=>{const c=r.get(l.reading_date)||{},m=l.petrol_net_litres!=null?Number(l.petrol_net_litres):Number(l.petrol_litres)||0,p=l.diesel_net_litres!=null?Number(l.diesel_net_litres):Number(l.diesel_litres)||0,b=m*(c.petrol||0)+p*(c.diesel||0),f=Number(l.cash_collected)||0,h=Number(l.phone_pay)||0,N=l.total_collected!=null?Number(l.total_collected)||0:f+h,S=c.petrol||c.diesel;return S&&(d=!0,o+=b,g+=b-N),n+=Number(l.total_litres)||0,a+=f,u+=h,i+=N,`<tr>
        <td>${formatNumericDate(l.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(l.shift))}</td>
        <td>${escapeHtml(l.employee_name||"Staff")}</td>
        <td class="num">${formatNumberPlain(l.petrol_litres)}</td>
        <td class="num">${formatNumberPlain(l.diesel_litres)}</td>
        <td class="num">${formatNumberPlain(l.total_litres)}</td>
        <td class="num">${S?formatNumberPlain(b):"\u2014"}</td>
        <td class="num">${formatNumberPlain(f)}</td>
        <td class="num">${formatNumberPlain(h)}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${S?formatNumberPlain(b-N):"\u2014"}</td>
      </tr>`}).join("");return`
    ${reportHeader("Salesman sales",s.start,s.end)}
    <p class="muted report-note">Short = expected \u2212 (cash + phone pay). Expected = net litres (sale \u2212 testing) \xD7 daily selling rates.</p>
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Salesman</th>
          <th class="num">MS (L)</th>
          <th class="num">HSD (L)</th>
          <th class="num">Total (L)</th>
          <th class="num">Expected \u20B9</th>
          <th class="num">Cash \u20B9</th>
          <th class="num">Phone \u20B9</th>
          <th class="num">Total \u20B9</th>
          <th class="num">Short \u20B9</th>
        </tr>
      </thead>
      <tbody>${y}</tbody>
      <tfoot>
        <tr>
          <td colspan="5"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(n)}</strong></td>
          <td class="num"><strong>${d?formatNumberPlain(o):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td class="num"><strong>${d?formatNumberPlain(g):"\u2014"}</strong></td>
        </tr>
      </tfoot>
    </table>`}function sanitizeReportHtmlForPrint(e){return PrintUtils.applyPrintLogos(e).replace(/<a\b[^>]*>/gi,"").replace(/<\/a>/gi,"")}function buildPrintSheetWrapped(e,s,t){const n=findReportMeta(s)?.title||"Report",o=t?t.start===t.end?formatNumericDate(t.start):`${formatNumericDate(t.start)} \u2013 ${formatNumericDate(t.end)}`:"";return`
    <div class="report-print-sheet" data-report="${escapeHtml(s)}">
      ${e}
      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>${escapeHtml(n)}${o?` \xB7 ${escapeHtml(o)}`:""}</span>
      </footer>
    </div>`}async function handleReportPrintClick(){if(reportPrintBusy)return;const e=document.getElementById("reports-print-btn"),s=e?.textContent||"Print this report";reportPrintBusy=!0,e&&(e.disabled=!0,e.textContent="Preparing\u2026");try{await runReportPrint()}catch(t){AppError?.report?.(t,{context:"runReportPrint"}),alert(AppError?.getUserMessage?.(t)||"Could not open the print dialog.")}finally{reportPrintBusy=!1,e&&(e.disabled=!1,e.textContent=s)}}async function runReportPrint(){if(!cachedData||!cachedRange){alert("Load report data first (pick dates and click Load data).");return}const e=renderReportHtml(activeReport,cachedData,cachedRange);if(!e?.trim()){alert("No report content to print.");return}const s=sanitizeReportHtmlForPrint(e),t=buildPrintSheetWrapped(s,activeReport,cachedRange),r=await PrintUtils.getReportPrintCssText(),n=PrintUtils.buildPrintFilename(activeReport||"report",cachedRange?.start,cachedRange?.start!==cachedRange?.end?cachedRange?.end:null);await PrintUtils.printInIframe({title:n,bodyHtml:t,cssText:r,bodyClass:"report-print-body",containerClass:"report-print-container",iframeTitle:"Report print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}function renderActiveReport(){const e=document.getElementById("reports-preview"),s=document.getElementById("reports-print-root"),t=findReportMeta(activeReport);if(!cachedData||!cachedRange){if(e&&e.textContent!=="Loading\u2026"&&e.textContent!=="Loading report data\u2026"){const o=t?.title?escapeHtml(t.title):"this report";e.innerHTML=`<p class="muted">Select dates and click <strong>Load data</strong> to preview <strong>${o}</strong>.</p>`,e.classList.add("muted")}s&&(s.innerHTML="",s.setAttribute("aria-hidden","true")),setReportPrintButtonWaiting();return}const r=renderReportHtml(activeReport,cachedData,cachedRange);e&&(e.innerHTML=`<div class="report-preview-inner">${r}</div>`,e.classList.remove("muted")),s&&(s.innerHTML=`<div class="report-print-sheet">${r}</div>`,s.removeAttribute("aria-hidden"));const n=document.getElementById("reports-print-btn");n&&!reportPrintBusy&&(n.disabled=!1,n.title=""),updateReportsCsvButtonVisibility()}function setReportPrintButtonWaiting(){const e=document.getElementById("reports-print-btn");e&&!reportPrintBusy&&(e.disabled=!0,e.title="Load report data first"),updateReportsCsvButtonVisibility()}
