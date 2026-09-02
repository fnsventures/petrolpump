const REPORT_CATALOG=[{group:"Operations",reports:[{id:"dsr",title:"Tank-wise DSR",description:"HSD + MS tanks: dips, receipts, shortage, testing, variance, rates, TVA."},{id:"fuel-income",title:"Fuel Income",description:"Daily dealer margin: net litres \xD7 (selling \u2212 landed buying) for MS and HSD."},{id:"pump-sales",title:"Pump-wise sales",description:"Sale litres by pump (P1/P2) from daily meters and shift nozzle rollups."},{id:"shift-sales",title:"Shift-wise sales",description:"Morning / afternoon sales by fuel with staff count from shift register."},{id:"salesman-sales",title:"Salesman sales",description:"Per salesman litres, expected cash, cash + phone + credit + expenses, and short from shift register."}]},{group:"GST \u2014 Sales",reports:[{id:"gst-sales-summary",title:"GST Sales Summary",description:"Inside / outside state outward supply: fuel NIL + billing slabs (CGST/SGST/IGST)."},{id:"gst-sales-detail",title:"GST Sales Detail",description:"Daily fuel NIL invoices (SFC) \u2014 one MS + one HSD per sale day; billing with GSTIN/IGST when enabled."}]},{group:"GST \u2014 Purchases (Fuel inward)",reports:[{id:"gst-purchase-summary",title:"GST Purchase Summary",description:"Inside / outside state fuel inward by VAT slab (supplier GSTIN vs station)."},{id:"gst-purchase-detail",title:"GST Purchase Detail",description:"Receipt-wise register with BPCL invoice no, GSTIN, qty, VAT and gross."}]},{group:"Accounts",reports:[{id:"trading",title:"Trading account",description:"Stock-based books (opening/closing stock). Gross income c/d is a balancing figure \u2014 not take-home profit."},{id:"pl",title:"Profit & Loss",description:"Your real profit is Nett Profit here. Gross Profit = margin before expenses; same engine as Analysis and Dashboard Net profit."}]},{group:"GST \u2014 Filing aids",reports:[{id:"gstr1",title:"GSTR-1 style register",description:"B2B / B2CS / NIL (fuel SFC) outward summary \u2014 printable; CSV and portal-style JSON from the toolbar."},{id:"gstr3b",title:"GSTR-3B style summary",description:"Tables 3.1 / 3.2 / 4 / 5 from fuel + billing \u2014 printable; portal-style JSON from the toolbar."}]}];let activeReport="dsr",cachedData=null,cachedRange=null;const reportsLoadGuard=typeof createRequestGuard=="function"?createRequestGuard():null;let reportsLoadInFlight=null,reportPrintBusy=!1;document.addEventListener("DOMContentLoaded",async()=>{await window.configPromise;const e=await requireAuth({allowedRoles:["admin"],onDenied:"dashboard.html",pageName:"reports"});e&&(applyRoleVisibility(e.role),await loadPumpSettings(),initReportsPage())});function findReportMeta(e){for(const s of REPORT_CATALOG){const t=s.reports.find(r=>r.id===e);if(t)return t}return null}function getFuelGstPct(){return Number(PumpSettings.getCachedSync().reports?.fuelGstPct)||AppConfig.DEFAULT_REPORTS.fuelGstPct}function isBillingIncludedInGstReports(){const e=PumpSettings.getCachedSync().billing||{},s=PumpSettings.getCachedSync().reports||{};return typeof e.includeInGstReports=="boolean"?e.includeInGstReports:typeof s.includeBillingInGst=="boolean"?s.includeBillingInGst:AppConfig.DEFAULT_BILLING.includeInGstReports!==!1}function formatMonthLabel(e){const[s,t]=e.split("-").map(Number);return!s||!t?e:new Date(s,t-1,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"})}const FUEL_OUTWARD_GST_PCT=0;function calcDailyFuelSale(e){const{revenue:s,litres:t}=computeFuelRowMargin(e,null);return{litres:t,gross:s}}function aggregateFuelSalesByMonth(e,s){const t=new Map;return(e??[]).forEach(r=>{if(r.date<s.start||r.date>s.end)return;const n=normalizeProduct(r.product);if(n!=="petrol"&&n!=="diesel")return;const{litres:o,gross:a}=calcDailyFuelSale(r);if(o<=0&&a<=0)return;const l=r.date.slice(0,7);t.has(l)||t.set(l,{petrol:{litres:0,gross:0},diesel:{litres:0,gross:0}});const c=t.get(l)[n];c.litres+=o,c.gross+=a}),t}function buildFuelSalesMonthLines(e,s){const t=FUEL_OUTWARD_GST_PCT,r=classifyGstSlab(t),n=[];return[...aggregateFuelSalesByMonth(e,s).entries()].sort(([o],[a])=>o.localeCompare(a)).forEach(([o,a])=>{["petrol","diesel"].forEach(l=>{const{litres:c,gross:g}=a[l];c<=0&&g<=0||n.push({monthKey:o,monthLabel:formatMonthLabel(o),product:l,productLabel:l==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:c,gstPct:t,slabKey:r,taxable:0,cgst:0,sgst:0,gross:g,nilValue:g})})}),n}function buildFuelSalesDailyInvoices(e,s){const t=FUEL_OUTWARD_GST_PCT,r=classifyGstSlab(t),n={petrol:0,diesel:1};return(e??[]).filter(a=>a.date>=s.start&&a.date<=s.end).map(a=>{const l=normalizeProduct(a.product);if(l!=="petrol"&&l!=="diesel")return null;const{litres:c,gross:g}=calcDailyFuelSale(a);return c<=0&&g<=0?null:{date:a.date,product:l,productLabel:l==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:c,gross:g,nilValue:g,gstPct:t,slabKey:r,taxable:0,cgst:0,sgst:0,partyName:"Cash A/c"}}).filter(Boolean).sort((a,l)=>a.date.localeCompare(l.date)||(n[a.product]??9)-(n[l.product]??9)).map((a,l)=>({...a,invoiceNumber:`SFC/${String(l+1).padStart(4,"0")}`}))}function sumFuelSalesLines(e){return e.reduce((s,t)=>({litres:s.litres+t.litres,taxable:s.taxable+t.taxable,cgst:s.cgst+t.cgst,sgst:s.sgst+t.sgst,gross:s.gross+t.gross}),{litres:0,taxable:0,cgst:0,sgst:0,gross:0})}function mergeSlabTotals(e,s){const t={};return GST_SLABS.forEach(r=>{const n=e[r.key]||emptySlabBucket(),o=s[r.key]||emptySlabBucket();t[r.key]={taxable:n.taxable+o.taxable,cgst:n.cgst+o.cgst,sgst:n.sgst+o.sgst,igst:(n.igst||0)+(o.igst||0),gross:n.gross+o.gross}}),t}function emptySlabBucket(){return{taxable:0,cgst:0,sgst:0,igst:0,gross:0}}function emptySlabTotals(){const e={};return GST_SLABS.forEach(s=>{e[s.key]=emptySlabBucket()}),e}function fuelSalesToSlabTotals(e){const s=emptySlabTotals();return e.forEach(t=>{const r=t.slabKey||classifyGstSlab(t.gstPct);if(!s[r])return;const n=Number(t.nilValue??t.gross??0);r==="nil"?(s[r].taxable+=n,s[r].gross+=n):(s[r].taxable+=t.taxable,s[r].cgst+=t.cgst,s[r].sgst+=t.sgst,s[r].igst+=Number(t.igst||0),s[r].gross+=t.gross)}),s}function gstinStateCode(e){const s=String(e||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function getStationGstinStateCode(){return gstinStateCode(typeof PumpSettings<"u"?PumpSettings.getStationGstin():"")}function isInterstatePartyGstin(e){const s=gstinStateCode(e),t=getStationGstinStateCode();return!s||!t?!1:s!==t}function getFuelSupplierLabel(){return PumpSettings.getCachedSync().reports?.fuelSupplierLabel||AppConfig.DEFAULT_REPORTS.fuelSupplierLabel}function getFuelSupplierGstin(){const e=PumpSettings.getCachedSync().reports?.fuelSupplierGstin;return e!=null&&String(e).trim()?String(e).trim().toUpperCase():AppConfig.DEFAULT_REPORTS.fuelSupplierGstin||""}function resolveSupplierGstin(e){const s=e!=null?String(e).trim():"";return s?s.toUpperCase():getFuelSupplierGstin()}function initReportsAboutAccordion(){initDocsAccordion(document.querySelector(".reports-about-accordion"))}function initReportsPage(){const e=document.getElementById("reports-start"),s=document.getElementById("reports-end"),t=new Date,r=t.getFullYear(),n=t.getMonth(),o=p=>String(p).padStart(2,"0"),a=`${r}-${o(n+1)}-01`,l=`${r}-${o(n+1)}-${o(new Date(r,n+1,0).getDate())}`;e&&(e.value=a),s&&(s.value=l),renderReportCatalog(),setActiveReportTab(activeReport),PrintUtils.preloadReportPrintCss?.(),initReportsAboutAccordion(),initPageSections({navItemSelector:".reports-nav .settings-nav-item",panelSelector:".reports-panels .settings-panel",defaultSection:"generate",validSections:["generate","about"]});const c=new URLSearchParams(window.location.search);c.get("start")&&e&&(e.value=c.get("start")),c.get("end")&&s&&(s.value=c.get("end"));const g=c.get("tab");g&&findReportMeta(g)&&setActiveReportTab(g),document.getElementById("reports-catalog")?.addEventListener("click",async p=>{const h=p.target.closest(".reports-pick");if(h?.dataset.report){if(setActiveReportTab(h.dataset.report),document.querySelector(".reports-output")?.scrollIntoView({behavior:"smooth",block:"nearest"}),!cachedData){const u=document.getElementById("reports-preview");u&&(u.innerHTML='<p class="muted">Loading report data\u2026</p>');try{await ensureReportsDataLoaded()}catch{}}renderActiveReport()}}),document.getElementById("reports-filter-form")?.addEventListener("submit",async p=>{p.preventDefault(),await loadAndRenderReports()}),document.getElementById("reports-print-btn")?.addEventListener("click",()=>{handleReportPrintClick()}),document.getElementById("reports-csv-btn")?.addEventListener("click",()=>{downloadGstr1Csv()}),document.getElementById("reports-json-btn")?.addEventListener("click",()=>{activeReport==="gstr3b"?downloadGstr3bJson():downloadGstr1Json()}),syncReportsAboutHash(),window.addEventListener("hashchange",syncReportsAboutHash),typeof bindLiveRefresh=="function"&&bindLiveRefresh(()=>{cachedData&&loadAndRenderReports()},{match:()=>!!document.getElementById("reports-preview")})}function syncReportsAboutHash(){if((location.hash||"").replace(/^#/,"")!=="about")return;const e=document.getElementById("reports-about");e?.hidden||e.scrollIntoView({behavior:"smooth",block:"start"})}function ensureReportsDataLoaded(){return cachedData?Promise.resolve():reportsLoadInFlight||(reportsLoadInFlight=loadAndRenderReports().finally(()=>{reportsLoadInFlight=null}),reportsLoadInFlight)}function renderReportCatalog(){const e=document.getElementById("reports-catalog");e&&(e.innerHTML=REPORT_CATALOG.map(s=>`
    <div class="reports-nav-group" role="group" aria-labelledby="reports-group-${slugify(s.group)}">
      <p class="reports-nav-group-title" id="reports-group-${slugify(s.group)}">${escapeHtml(s.group)}</p>
      ${s.reports.map(t=>`
        <button type="button" class="reports-pick reports-nav-item${t.id===activeReport?" is-active":""}" data-report="${escapeHtml(t.id)}" aria-pressed="${t.id===activeReport?"true":"false"}">
          ${escapeHtml(t.title)}
        </button>`).join("")}
    </div>`).join(""))}function slugify(e){return String(e).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}function setActiveReportTab(e){const s=findReportMeta(e);activeReport=s?s.id:"dsr",document.querySelectorAll(".reports-pick").forEach(o=>{const a=o.dataset.report===activeReport;o.classList.toggle("is-active",a),o.setAttribute("aria-pressed",a?"true":"false")});const t=document.getElementById("reports-active-title"),r=document.getElementById("reports-active-desc"),n=findReportMeta(activeReport);t&&n&&(t.textContent=n.title),r&&(r.textContent=n?.description??""),updateReportsCsvButtonVisibility()}function parseReportTankCapacityLiters(e){if(!e)return null;const s=String(e).trim().toUpperCase().replace(/\s/g,""),t=s.match(/^([\d.]+)KL$/);if(t)return Number(t[1])*1e3;const r=s.match(/^([\d.]+)L$/);if(r)return Number(r[1]);const n=Number(s.replace(/[^\d.]/g,""));return Number.isFinite(n)&&n>0?n:null}function buildTankDsrSection(e,s,t,r,n){let o=0,a=0,l=0,c=0,g=0,p=0,h=0,u=0,d=null;const i=parseReportTankCapacityLiters(t),m=r.map(b=>{const y=Number(b.opening_stock??0),N=Number(b.receipts??0),S=Number(b.testing??0),v=Number(b.total_sales??0),T=getDsrNetSaleLitres(b);o+=T;const _=Number(b.dip_stock??b.stock??0),R=Math.max(0,Number(b.variation??0)),P=Math.max(y+N-R,0),$=Math.max(y+N-_,0);u=_;const w=T-$;a+=w;const L=i!=null&&Number.isFinite(_)?Math.max(0,i-_):null;d=L,l+=N,c+=R,g+=S,p+=v,h+=T;const C=Number(b[n]??0);return`<tr>
        <td>${formatNumericDate(b.date)}</td>
        <td class="num">${formatNumberPlain(y)}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${formatNumberPlain(R)}</td>
        <td class="num">${formatNumberPlain(P)}</td>
        <td class="num">${formatNumberPlain(S)}</td>
        <td class="num">${formatNumberPlain(v)}</td>
        <td class="num">${formatNumberPlain(T)}</td>
        <td class="num">${formatNumberPlain(o)}</td>
        <td class="num">${formatNumberPlain($)}</td>
        <td class="num">${formatNumberPlain(_)}</td>
        <td class="num">${formatNumberPlain(w)}</td>
        <td class="num">${formatNumberPlain(a)}</td>
        <td class="num">${formatNumberPlain(C)}</td>
        <td class="num">${L==null?"\u2014":formatNumberPlain(L)}</td>
      </tr>`}).join(""),f=e==="diesel"?"Diesel":"Petrol";return`
    <section class="report-tank-section report-tank-section--${e}">
      <h3 class="report-tank-title">Tank: ${escapeHtml(s)} \xB7 ${escapeHtml(t)} \xB7 ${escapeHtml(f)}</h3>
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
        <tbody>${m||'<tr><td colspan="15" class="muted">No entries</td></tr>'}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(g)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
            <td></td>
            <td class="num"><strong>${d==null?"\u2014":formatNumberPlain(d)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </section>`}function renderTankWiseDsr(e,s){const t=DsrQueries.mergeDsrStock(e.dsrRows,e.stockRows),r=PumpSettings.getCachedSync().reports?.tanks||AppConfig.DEFAULT_REPORT_TANKS;let n=reportHeader("Tank-wise DSR report",s.start,s.end),o=!1;return r.forEach(a=>{const l=t.filter(g=>normalizeProduct(g.product)===a.product);if(!l.length)return;o=!0;const c=a.product==="petrol"?"petrol_rate":"diesel_rate";n+=buildTankDsrSection(a.product,a.label,a.capacity,l,c)}),o?n+='<p class="report-note muted">One section per physical tank (HSD and MS). Short = max(0, book \u2212 dip); Total = open + buy \u2212 short; Actual = meter \u2212 testing; Var = actual \u2212 sale by dip (open + buy \u2212 close); TVA = tank capacity \u2212 closing dip.</p>':n+='<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>',n}function fuelIncomeMetrics(e,s){if(!e)return{litres:0,saleRate:0,buyRate:null,income:null,missingBuy:!1};const t=getDsrNetSaleLitres(e),r=getDsrSaleRate(e),n=getEffectiveBuyingRate(e,s),o=t>0&&n==null,a=n!=null&&t>0?t*(r-n):null;return{litres:t,saleRate:r,buyRate:n,income:a,missingBuy:o}}function formatFuelIncomeCell(e,{empty:s="\u2014"}={}){return e==null||!Number.isFinite(e)?s:formatNumberPlain(e)}function renderFuelIncome(e,s){const t=createBuyingRateContext(e.receiptRows),r=new Map;(e.dsrRows??[]).forEach(d=>{const i=d.date;if(!i)return;r.has(i)||r.set(i,{petrol:null,diesel:null});const m=normalizeProduct(d.product);(m==="petrol"||m==="diesel")&&(r.get(i)[m]=d)});const n=[...r.keys()].sort();let o=0,a=0,l=0,c=0,g=0;const p=n.map(d=>{const i=r.get(d),m=fuelIncomeMetrics(i.petrol,t),f=fuelIncomeMetrics(i.diesel,t);(m.missingBuy||f.missingBuy)&&(g+=1),o+=m.litres,a+=f.litres,m.income!=null&&(l+=m.income),f.income!=null&&(c+=f.income);const b=(m.income!=null?m.income:0)+(f.income!=null?f.income:0),y=m.income==null&&f.income==null&&(m.litres>0||f.litres>0)?"\u2014":formatNumberPlain(b);return`<tr>
        <td>${formatNumericDate(d)}</td>
        <td class="num">${formatFuelIncomeCell(m.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(m.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(m.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(m.income)}</td>
        <td class="num">${formatFuelIncomeCell(f.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(f.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(f.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(f.income)}</td>
        <td class="num"><strong>${y}</strong></td>
      </tr>`}).join(""),h=l+c,u=g>0?`<p class="report-note warning">${g} day(s) have sale litres but no landed buying rate \u2014 P.Rate / P.Income blank for those products. Enter buying price on Meter Reading \u2192 Purchase cost for receipt days.</p>`:"";return`
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
      <tbody>${p||'<tr><td colspan="10" class="muted">No meter readings in this period.</td></tr>'}</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${formatNumberPlain(o)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
        </tr>
      </tfoot>
    </table>
    ${u}
    <p class="report-note muted">P.Income = net litres (meter \u2212 testing) \xD7 (selling rate \u2212 landed buying rate incl. VAT + delivery + LFR). Same fuel-margin basis as Analysis and Reports P&amp;L.</p>`}function reportHeader(e,s,t){const r=PumpSettings.getStationGstin();return`
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
    </header>`}async function loadAndRenderReports(){const e=reportsLoadGuard?reportsLoadGuard.next():0,s=document.getElementById("reports-start")?.value,t=document.getElementById("reports-end")?.value,r=document.getElementById("reports-error"),n=document.getElementById("reports-preview"),o=document.getElementById("reports-date-label");if(r?.classList.add("hidden"),!s||!t){r&&(r.textContent="Please select from and to dates.",r.classList.remove("hidden"));return}let a=s,l=t;l<a&&([a,l]=[l,a]),o&&(o.textContent=a===l?formatNumericDate(a):`${formatNumericDate(a)} \u2013 ${formatNumericDate(l)}`),n&&(n.textContent="Loading\u2026"),setReportPrintButtonWaiting();const c=`reports_${a}_${l}`,g=async()=>{const h=await fetchReportData(a,l);try{const{data:u,error:d}=await window.supabaseClient.rpc("get_meter_sales_breakdown",{p_start:a,p_end:l});if(d)throw d;h.meterBreakdown=u||null}catch(u){AppError.report(u,{context:"loadAndRenderReports.meterBreakdown"}),h.meterBreakdown=null}return h},p=h=>{reportsLoadGuard&&!reportsLoadGuard.isCurrent(e)||(cachedData=h,cachedRange={start:a,end:l},clearReportDerivedCache(),renderActiveReport())};try{if(await loadPumpSettings(),typeof withProgress=="function"?cachedData=await withProgress(async()=>typeof AppCache<"u"&&AppCache?AppCache.getWithSWR(c,g,"reports_data",p):g()):typeof AppCache<"u"&&AppCache?cachedData=await AppCache.getWithSWR(c,g,"reports_data",p):cachedData=await g(),reportsLoadGuard&&!reportsLoadGuard.isCurrent(e))return;cachedRange={start:a,end:l},clearReportDerivedCache(),renderActiveReport()}catch(h){if(reportsLoadGuard&&!reportsLoadGuard.isCurrent(e))return;AppError.report(h,{context:"loadAndRenderReports"}),n&&(n.innerHTML=`<p class="error">${escapeHtml(h.message||"Failed to load data.")}</p>`)}}function normalizeReportsPayload(e){const s=[e.dsrError,e.stockError,e.expenseError,e.invoiceError,e.invoiceItemsError,e.categoriesError].filter(Boolean);if(s.length)throw s[0];return{dsrRows:e.dsrRows??[],stockRows:e.stockRows??[],expenseRows:e.expenseRows??[],invoices:e.invoices??[],invoiceItems:e.invoiceItems??[],vaultPurchases:e.vaultPurchases??[],categoryMap:buildExpenseCategoryMap(e.expenseCategories),receiptRows:e.receiptRows??[]}}async function fetchReportData(e,s){try{const t=()=>window.supabaseClient.functions.invoke("get-reports-data",{body:{startDate:e,endDate:s,receiptHistoryStart:PumpSettings.getReceiptHistoryStart()}}),{data:r,error:n}=typeof AppError<"u"&&AppError?.withRetry?await AppError.withRetry(t,{maxAttempts:3}):await t();if(n)throw n;return normalizeReportsPayload({dsrRows:r.dsrRows,receiptRows:r.receiptRows,stockRows:r.stockRows,expenseRows:r.expenseRows,invoices:r.invoices,invoiceItems:r.invoiceItems,vaultPurchases:r.vaultPurchases,expenseCategories:r.expenseCategories,dsrError:r.errors?.dsr?new Error(r.errors.dsr):null,stockError:r.errors?.stock?new Error(r.errors.stock):null,expenseError:r.errors?.expense?new Error(r.errors.expense):null,invoiceError:r.errors?.invoice?new Error(r.errors.invoice):null,invoiceItemsError:r.errors?.invoiceItems?new Error(r.errors.invoiceItems):null,categoriesError:r.errors?.categories?new Error(r.errors.categories):null})}catch{return fetchReportDataDirect(e,s)}}async function fetchReportDataDirect(e,s){const[t,r,n,o,a,l]=await Promise.all([DsrQueries.fetchDsrRows(e,s,{select:DsrQueries.DSR_SELECT_FULL}),window.supabaseClient.rpc("get_dsr_stock_range",{p_start:e,p_end:s}),DsrQueries.fetchExpenses(e,s,"date, category, amount, description"),supabaseClient.from("invoices").select("id, invoice_number, invoice_date, party_name, party_gstin, total_amount, cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total").gte("invoice_date",e).lte("invoice_date",s).order("invoice_date",{ascending:!0}),window.supabaseClient.from("expense_categories").select("name, label").order("sort_order"),supabaseClient.from("invoice_documents").select("id, invoice_date, vendor, amount, category, title, drive_web_view_link").eq("category","purchase").gte("invoice_date",e).lte("invoice_date",s)]),c=o.data??[];let g=[];if(c.length){const p=c.map(i=>i.id),h=80,u=[];for(let i=0;i<p.length;i+=h)u.push(p.slice(i,i+h));const d=await Promise.all(u.map(i=>supabaseClient.from("invoice_items").select("invoice_id, gst_percent, amount").in("invoice_id",i)));for(const i of d){if(i.error)throw i.error;i.data?.length&&g.push(...i.data)}}return normalizeReportsPayload({dsrRows:t.data,receiptRows:t.receiptRows,stockRows:r.data,expenseRows:n.data,invoices:c,invoiceItems:g,vaultPurchases:l.error?[]:l.data??[],expenseCategories:a.data,dsrError:t.error,stockError:r.error,expenseError:n.error,invoiceError:o.error,invoiceItemsError:null,categoriesError:a.error})}function classifyGstSlab(e){const s=Number(e);return s<0?"non_gst":s===0?"nil":s===5?"r5":s===12?"r12":s===18?"r18":s===24?"r24":s===28?"r28":"r18"}function slabHasActivity(e){return e?Math.abs(Number(e.taxable??0))>.005||Math.abs(Number(e.gross??0))>.005:!1}function sumInvoiceLineAmounts(e){let s=0,t=0,r=0;return e.forEach(n=>{const o=Number(n.amount??0),a=Number(n.gst_percent??0);a>0?s+=o/(1+a/100):a===0?r+=o:t+=o}),{taxable:s,nonGst:t,nilRate:r}}function invoiceHeaderTaxable(e){const s=Number(e.cgst_total??0),t=Number(e.sgst_total??0),r=Number(e.igst_total??0),n=Number(e.non_gst_total??0),o=Number(e.nil_rate_total??0),l=Number(e.total_amount??0)-s-t-r-n-o;if(Number.isFinite(l)&&l>=0)return l;const c=Number(e.subtotal??0)-Number(e.discount??0);return Number.isFinite(c)&&c>=0?c:0}function aggregateInvoiceGst(e,s){return aggregateInvoiceGstByPlace(e,s).combined}function aggregateInvoiceGstByPlace(e,s){const t=new Map;s.forEach(a=>{t.has(a.invoice_id)||t.set(a.invoice_id,[]),t.get(a.invoice_id).push(a)});const r=emptySlabTotals(),n=emptySlabTotals(),o=(a,l,{taxable:c=0,cgst:g=0,sgst:p=0,igst:h=0,gross:u=0})=>{a[l]&&(a[l].taxable+=c,a[l].cgst+=g,a[l].sgst+=p,a[l].igst+=h,a[l].gross+=u)};return e.forEach(a=>{const l=t.get(a.id)||[],c=Number(a.igst_total??0),g=Number(a.cgst_total??0),p=Number(a.sgst_total??0),h=c>0||g+p<=0&&isInterstatePartyGstin(a.party_gstin),u=h?n:r;if(l.length)l.forEach(d=>{const i=Number(d.amount??0),m=Number(d.gst_percent??0),f=classifyGstSlab(m);if(m>0){const b=i/(1+m/100),y=i-b;h?o(u,f,{taxable:b,igst:y,gross:i}):o(u,f,{taxable:b,cgst:y/2,sgst:y/2,gross:i})}else m===0?o(u,"nil",{taxable:i,gross:i}):o(u,"non_gst",{taxable:i,gross:i})});else{const d=Number(a.non_gst_total??0),i=Number(a.nil_rate_total??0),m=Number(a.total_amount??0),f=invoiceHeaderTaxable(a);if(g>0||p>0||c>0){const b=classifyGstSlab(18);h?o(u,b,{taxable:f,igst:c>0?c:g+p,gross:f+g+p+c}):o(u,b,{taxable:f,cgst:g,sgst:p,gross:f+g+p+c})}else i>0?o(u,"nil",{taxable:i,gross:i}):d>0?o(u,"non_gst",{taxable:d,gross:d}):m>0&&o(u,"non_gst",{taxable:m,gross:m})}}),{inside:r,outside:n,combined:mergeSlabTotals(r,n)}}function renderGstSummaryTable(e,s,t,r,n={}){const{sectionOnly:o=!1,sectionTitle:a=s,place:l="inside",showIgst:c=l==="outside"||l==="all"}=n,p=GST_SLABS.filter(P=>slabHasActivity(e[P.key])).map(P=>{const $=e[P.key]||emptySlabBucket(),w=$.cgst+$.sgst;return l==="outside"?`<tr>
      <td>${escapeHtml(P.label)}</td>
      <td class="num">${formatNumberPlain($.taxable)}</td>
      <td class="num">${formatNumberPlain($.igst||0)}</td>
      <td class="num">${formatNumberPlain($.gross)}</td>
    </tr>`:r?`<tr>
      <td>${escapeHtml(P.label)}</td>
      <td class="num">${formatNumberPlain($.taxable)}</td>
      <td class="num">${formatNumberPlain(w)}</td>
      <td class="num">${c?formatNumberPlain($.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain($.gross)}</td>
    </tr>`:`<tr>
      <td>${escapeHtml(P.label)}</td>
      <td class="num">${formatNumberPlain($.taxable)}</td>
      <td class="num">${formatNumberPlain($.cgst)}</td>
      <td class="num">${formatNumberPlain($.sgst)}</td>
      <td class="num">${c?formatNumberPlain($.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain($.gross)}</td>
    </tr>`}).join(""),h=GST_SLABS.reduce((P,$)=>P+(e[$.key]?.taxable||0),0),u=GST_SLABS.reduce((P,$)=>P+(e[$.key]?.cgst||0),0),d=GST_SLABS.reduce((P,$)=>P+(e[$.key]?.sgst||0),0),i=GST_SLABS.reduce((P,$)=>P+(e[$.key]?.igst||0),0),m=u+d,f=GST_SLABS.reduce((P,$)=>P+(e[$.key]?.gross||0),0);let b,y,N;l==="outside"?(b='<th>Slab</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">Total</th>',y=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(f)}</strong></td>`,N=4):r?(b=`<th>Slab</th><th class="num">Taxable</th><th class="num">VAT/LST</th><th class="num">${c?"IGST":"\u2014"}</th><th class="num">Total</th>`,y=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(m)}</strong></td>
          <td class="num"><strong>${c?formatNumberPlain(i):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(f)}</strong></td>`,N=5):(b=`<th>Slab</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">${c?"IGST":"\u2014"}</th><th class="num">Total</th>`,y=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(d)}</strong></td>
          <td class="num"><strong>${c?formatNumberPlain(i):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(f)}</strong></td>`,N=6);const S=l==="outside"?"Outside state (IGST)":l==="all"?r?"Combined inward supply":"Combined outward supply":r?"Inside state inward supply":"Inside state outward supply (CGST + SGST)",v=r?`${S} \xB7 ${escapeHtml(getPurchaseTaxPctLabel())} \xB7 ${isPurchaseTaxInclusive()?"tax-inclusive rate":"pre-tax rate (BPCL)"}`:S,T=o?`<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(a)}</h3>`:reportHeader(s,t.start,t.end),_=o?"</section>":"",R=r?`VAT/LST: <strong>${formatNumberPlain(m)}</strong>${c?` \xB7 IGST: <strong>${formatNumberPlain(i)}</strong>`:""}`:`CGST: <strong>${formatNumberPlain(u)}</strong> \xB7 SGST: <strong>${formatNumberPlain(d)}</strong>${c?` \xB7 IGST: <strong>${formatNumberPlain(i)}</strong>`:""}`;return`
    ${T}
    <p class="report-subtitle${o?" muted":""}">${v}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>${b}</tr>
      </thead>
      <tbody>${p||`<tr><td colspan="${N}" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          ${y}
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Taxable: <strong>${formatNumberPlain(h)}</strong> \xB7 ${R} \xB7 Gross: <strong>${formatNumberPlain(f)}</strong></p>${_}`}function slabTotalsHaveActivity(e){return GST_SLABS.some(s=>slabHasActivity(e[s.key]))}function renderFuelSalesMonthTable(e,s){const t=e.map(n=>`<tr class="${fuelRowClass(n.product)}">
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
    </section>`}function renderGstSalesSummary(e,s){const t=isBillingIncludedInGstReports(),r=buildFuelSalesMonthLines(e.dsrRows,s),n=fuelSalesToSlabTotals(r),o=t?aggregateInvoiceGst(e.invoices,e.invoiceItems):null,a=o?mergeSlabTotals(n,o):n,l=renderFuelSalesMonthTable(r,"Fuel sales \u2014 month-wise"),c=t?renderGstSummaryTable(o,"Billing \u2014 GST slab summary",s,!1,{sectionOnly:!0,sectionTitle:"Billing \u2014 GST slab summary"}):'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing \u2192 Include billing in GST sales reports).</p>',g=renderGstSummaryTable(a,"Combined outward supply \u2014 GST summary",s,!1,{sectionOnly:!0,sectionTitle:"Combined outward supply \u2014 GST summary"});return`
    ${reportHeader("Outward supply \u2014 GST summary",s.start,s.end)}
    ${l}
    ${c}
    ${g}`}function renderGstSalesDetail(e,s){const t=isBillingIncludedInGstReports(),r=buildFuelSalesDailyInvoices(e.dsrRows,s),n=r.map(d=>({sortDate:d.date,sortKey:`0-${d.invoiceNumber}`,html:`<tr class="${fuelRowClass(d.product)}">
        <td>${formatNumericDate(d.date)}</td>
        <td>Fuel \xB7 ${escapeHtml(d.productLabel)}</td>
        <td>${escapeHtml(d.invoiceNumber)} \xB7 ${escapeHtml(d.partyName)}</td>
        <td>\u2014</td>
        <td class="num">${formatNumberPlain(d.litres)}</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">${formatNumberPlain(d.nilValue??d.gross)}</td>
        <td class="num">${formatNumberPlain(d.gross)}</td>
      </tr>`})),o=new Map;e.invoiceItems.forEach(d=>{o.has(d.invoice_id)||o.set(d.invoice_id,[]),o.get(d.invoice_id).push(d)});const a=t?e.invoices.map(d=>{const i=o.get(d.id)||[],m=Number(d.cgst_total??0),f=Number(d.sgst_total??0),b=Number(d.igst_total??0),y=m+f+b>0,N=(d.party_gstin||"").trim().toUpperCase()||"\u2014";let S=0,v=0,T=0;if(i.length){const _=sumInvoiceLineAmounts(i);S=_.taxable,v=_.nonGst,T=_.nilRate}else v=Number(d.non_gst_total??0),T=Number(d.nil_rate_total??0),S=invoiceHeaderTaxable(d);return{sortDate:d.invoice_date,sortKey:`1-${d.invoice_number}`,html:`<tr class="report-billing-row">
        <td>${formatNumericDate(d.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(d.invoice_number)} \xB7 ${escapeHtml(d.party_name)}</td>
        <td>${escapeHtml(N)}</td>
        <td class="num">\u2014</td>
        <td class="num">${y||S>0?formatNumberPlain(S):"\u2014"}</td>
        <td class="num">${formatNumberPlain(m)}</td>
        <td class="num">${formatNumberPlain(f)}</td>
        <td class="num">${formatNumberPlain(b)}</td>
        <td class="num">${formatNumberPlain(v+T)}</td>
        <td class="num">${formatNumberPlain(d.total_amount)}</td>
      </tr>`}}):[],l=[...n,...a].sort((d,i)=>d.sortDate.localeCompare(i.sortDate)||d.sortKey.localeCompare(i.sortKey)).map(d=>d.html).join(""),c=sumFuelSalesLines(r),g=r.length>0,p=t&&e.invoices.length>0,h=!g&&!p?`<tr><td colspan="11" class="muted">${t?"No fuel sales or billing in this period":"No fuel sales in this period"}</td></tr>`:"",u=t?"":'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing).</p>';return`
    ${reportHeader("Outward supply \u2014 GST detail register",s.start,s.end)}
    <p class="report-subtitle muted">Fuel days as NIL invoices (SFC/####) \u2014 one voucher per tank sale day (MS, HSD). Value = net litres \xD7 that day&apos;s selling rate. Billing rows show party GSTIN and IGST when interstate.</p>
    ${u}
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
        ${l}
        ${h}
      </tbody>
      ${g?`<tfoot>
        <tr class="report-total-row">
          <td colspan="4"><strong>Fuel total (${r.length} SFC)</strong></td>
          <td class="num"><strong>${formatNumberPlain(c.litres)}</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>${formatNumberPlain(c.gross)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(c.gross)}</strong></td>
        </tr>
      </tfoot>`:""}
    </table>`}function collectFuelPurchaseLines(e,s,t){const r=u=>u.date>=s.start&&u.date<=s.end,n=t??createBuyingRateContext(e.receiptRows??[]).getStored,o=e.vaultPurchases??[],a=new Map(o.map(u=>[u.id,u])),l=new Map;o.forEach(u=>{const d=String(u.title||"").trim().toLowerCase();d&&!l.has(d)&&l.set(d,u)});const c=[],g=new Set,p=u=>{if(u.invoiceDocumentId&&a.has(u.invoiceDocumentId))return a.get(u.invoiceDocumentId);const d=String(u.supplierInvoiceNo||"").trim().toLowerCase();return d?l.has(d)?l.get(d):o.find(i=>String(i.title||"").toLowerCase().includes(d))||null:null},h=(u,d,i,m,f={})=>{const b=Number(i),y=Number(m);if(!Number.isFinite(b)||b<=0||!Number.isFinite(y)||y<=0)return;const N=`${u}-${normalizeProduct(d)}`;if(g.has(N))return;g.add(N);const S=p(f);c.push({date:u,product:d,litres:b,rate:y,deliveryPerKl:f.deliveryPerKl??null,supplierInvoiceNo:f.supplierInvoiceNo||S?.title||"",supplierGstin:f.supplierGstin||"",invoiceDocumentId:f.invoiceDocumentId||S?.id||null,driveWebViewLink:S?.drive_web_view_link||null})};return(e.receiptRows??[]).filter(r).forEach(u=>{h(u.date,u.product,Number(u.receipts??0),Number(u.buying_price_per_litre),{supplierInvoiceNo:u.supplier_invoice_no,supplierGstin:u.supplier_gstin,invoiceDocumentId:u.invoice_document_id,deliveryPerKl:u.purchase_delivery_per_kl})}),(e.dsrRows??[]).filter(r).forEach(u=>{const d=Number(u.receipts??0);if(d<=0)return;const i=Number(u.buying_price_per_litre);!Number.isFinite(i)||i<=0||h(u.date,u.product,d,i,{supplierInvoiceNo:u.supplier_invoice_no,supplierGstin:u.supplier_gstin,invoiceDocumentId:u.invoice_document_id,deliveryPerKl:u.purchase_delivery_per_kl})}),c.sort((u,d)=>u.date.localeCompare(d.date)||normalizeProduct(u.product).localeCompare(normalizeProduct(d.product)))}function countReceiptsMissingBuying(e,s){const t=r=>r.date>=s.start&&r.date<=s.end;return(e.dsrRows??[]).filter(r=>{if(!t(r)||Number(r.receipts??0)<=0)return!1;const n=Number(r.buying_price_per_litre);return!Number.isFinite(n)||n<=0}).length}function buildFuelPurchaseRows(e,s){const t=createBuyingRateContext(e.receiptRows??[]).getStored,r=collectFuelPurchaseLines(e,s,t),n=countReceiptsMissingBuying(e,s),o=emptySlabTotals(),a=emptySlabTotals();return{detailRows:r.map(({date:c,product:g,litres:p,rate:h,deliveryPerKl:u,supplierInvoiceNo:d,supplierGstin:i,invoiceDocumentId:m,driveWebViewLink:f})=>{const b=getPurchaseTaxPct(g),y=classifyGstSlab(b),{taxable:N,tax:S,gross:v,cgst:T,sgst:_}=calcPurchaseLineTax(p,h,b,{product:g,date:c,deliveryPerKl:u}),R=resolveSupplierGstin(i),P=isInterstatePartyGstin(R),$=P?a:o;return $[y]&&($[y].taxable+=N,P?$[y].igst+=S:($[y].cgst+=T,$[y].sgst+=_),$[y].gross+=v),{date:c,product:g,litres:p,rate:h,taxPct:b,taxable:N,tax:S,gross:v,cgst:P?0:T,sgst:P?0:_,igst:P?S:0,interstate:P,supplierInvoiceNo:d||"",supplierGstin:R,invoiceDocumentId:m||null,driveWebViewLink:f||null}}),insideSlabs:o,outsideSlabs:a,slabTotals:mergeSlabTotals(o,a),missingBuyingCount:n}}function renderGstPurchaseSummary(e,s){const{insideSlabs:t,outsideSlabs:r,slabTotals:n,detailRows:o,missingBuyingCount:a}=getFuelPurchaseRows(e,s),l=a>0?`<p class="report-note warning">${a} receipt(s) in this period have no buying price \u2014 excluded. Enter buying price on Meter Reading \u2192 Purchase cost.</p>`:"",c=o.length===0?'<p class="report-note muted">No fuel receipts with buying price in this period.</p>':"",g=renderGstSummaryTable(t,"Inside state",s,!0,{sectionOnly:!0,sectionTitle:"Inside state inward supply",place:"inside",showIgst:!1}),p=slabTotalsHaveActivity(r)?renderGstSummaryTable(r,"Outside state",s,!0,{sectionOnly:!0,sectionTitle:"Outside state inward supply",place:"outside",showIgst:!0}):'<section class="report-gst-section"><h3 class="report-section-title">Outside state inward supply</h3><p class="muted">No interstate inward supply in this period (supplier GSTIN state matches station, or GSTIN blank).</p></section>',h=renderGstSummaryTable(n,"Combined",s,!0,{sectionOnly:!0,sectionTitle:"Total inward supply summary",place:"all",showIgst:!0});return`
    ${reportHeader("Inward supply \u2014 GST summary (Fuel receipts)",s.start,s.end)}
    ${c}
    ${g}
    ${p}
    ${h}
    ${l}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())} Place of supply uses supplier GSTIN vs station GSTIN.</p>`}function renderGstPurchaseDetail(e,s){const{detailRows:t,missingBuyingCount:r}=getFuelPurchaseRows(e,s),n=t.map(o=>{const a=normalizeProduct(o.product),l=a==="petrol"?"MS":a==="diesel"?"HSD":String(o.product).toUpperCase(),c=o.supplierInvoiceNo?escapeHtml(o.supplierInvoiceNo):"\u2014",g=o.supplierGstin?escapeHtml(o.supplierGstin):"\u2014",p=o.driveWebViewLink?`<a href="${escapeHtml(o.driveWebViewLink)}" target="_blank" rel="noopener">View PDF</a>`:o.invoiceDocumentId?"Linked":"\u2014";return`<tr class="${fuelRowClass(a)}">
      <td>${formatNumericDate(o.date)}</td>
      <td>${formatFuelBadge(l)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td>${c}</td>
      <td>${g}</td>
      <td class="num">${p}</td>
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
    <p class="report-note muted">Vault PDF links match DSR receipt \u2192 Invoices (purchase) by document id or invoice title. Enter invoice no with buying price on Meter Reading \u2192 Purchase cost. ${escapeHtml(getPurchaseGstDetailNote())}</p>`}function computeTradingAndPl(e,s){const t=createBuyingRateContext(e.receiptRows),r=DsrQueries.mergeDsrStock(e.dsrRows,e.stockRows),n={petrol:{label:"Petrol (MS)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},diesel:{label:"Diesel (HSD)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},lube:{label:"Lubricant / Billing",sales:0,purchase:0,openingStockVal:0,closingStockVal:0}},o={petrol:{first:null,last:null},diesel:{first:null,last:null}};r.forEach(m=>{const f=normalizeProduct(m.product);if(!n[f])return;const b=getDsrNetSaleLitres(m),y=getDsrSaleRate(m),N=Number(m.receipts??0);if(N>0){const S=getEffectiveBuyingRate(m,t);S!=null&&(n[f].purchase+=N*S)}n[f].sales+=b*y,o[f]&&(o[f].first||(o[f].first=m),o[f].last=m)}),["petrol","diesel"].forEach(m=>{const f=o[m].first,b=o[m].last;if(!f||!b)return;n[m].openingL=Number(f.opening_stock??0),n[m].closingL=Number(b.dip_stock??b.stock??0);const y=getLandedBuyingRateForDate(m,f.date,t)??0,N=getLandedBuyingRateForDate(m,b.date,t)??y;n[m].openingStockVal=n[m].openingL*y,n[m].closingStockVal=n[m].closingL*N}),n.lube.sales=e.invoices.reduce((m,f)=>m+Number(f.total_amount??0),0);const a=(e.vaultPurchases??[]).reduce((m,f)=>{const b=Number(f.amount??0);return b>0?m+b:m},0);n.lube.purchase=a;const l=Object.values(n).reduce((m,f)=>m+f.sales,0),c=Object.values(n).reduce((m,f)=>m+f.purchase,0),g=Object.values(n).reduce((m,f)=>m+f.openingStockVal,0),p=Object.values(n).reduce((m,f)=>m+f.closingStockVal,0),h=l+p-g-c,u=computeProfitLossSummary({dsrRows:r,receiptRows:e.receiptRows,expenseRows:e.expenseRows,lubeSales:n.lube.sales,lubeCogs:a,requireAllBuying:!0,buyingContext:t,categoryMap:e.categoryMap}),d=new Map,i=new Map;return e.expenseRows.forEach(m=>{const f=m.category||"misc",b=getExpenseCategoryLabel(m,e.categoryMap),y=Number(m.amount??0),N=isTestingExpenseRow(m,e.categoryMap)?i:d;N.has(f)||N.set(f,{label:b,amount:0}),N.get(f).amount+=y}),{products:n,grossSales:l,totalPurchase:c,openingStock:g,closingStock:p,grossIncome:h,vaultPurchaseTotal:a,fuelGrossProfit:u.canCalculate?u.fuelGrossProfit??0:null,lubeGrossProfit:u.canCalculate?u.lubeGrossProfit??0:null,lubeCogs:a,grossProfit:u.canCalculate?u.grossProfit??0:null,expensesByCategory:d,testingExpensesByCategory:i,totalExpenses:u.totalExpenses,testingExpenses:u.testingExpenses,netProfit:u.canCalculate?u.netProfit:null,canCalculate:u.canCalculate,missingBuyingPrice:u.missingBuyingPrice,unresolvedBuying:u.unresolvedBuying,usingProvisionalBuying:u.usingProvisionalBuying}}function renderProfitGuide(e){return e==="trading"?`
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
    </aside>`}function renderTradingAccount(e,s){const t=getTradingAndPl(e,s),r=[["Sales \u2014 Petrol (MS)",t.products.petrol.sales,"petrol"],["Sales \u2014 Diesel (HSD)",t.products.diesel.sales,"diesel"],["Sales \u2014 Lube / Billing",t.products.lube.sales,null],["Closing stock \u2014 Petrol",t.products.petrol.closingStockVal,"petrol"],["Closing stock \u2014 Diesel",t.products.diesel.closingStockVal,"diesel"]],n=[["Opening stock \u2014 Petrol",t.products.petrol.openingStockVal,"petrol"],["Opening stock \u2014 Diesel",t.products.diesel.openingStockVal,"diesel"],["Purchases \u2014 Petrol",t.products.petrol.purchase,"petrol"],["Purchases \u2014 Diesel",t.products.diesel.purchase,"diesel"]];t.vaultPurchaseTotal>0&&n.push(["Purchases \u2014 Lube / other (vault)",t.vaultPurchaseTotal,null]),n.push(["Gross income c/d",t.grossIncome,null]);const o=(g,p)=>{const h=p.map(([d,i,m])=>`<tr class="${fuelRowClass(m)}"><td>${escapeHtml(d)}</td><td class="num">${formatNumberPlain(i)}</td></tr>`).join(""),u=p.reduce((d,[,i])=>d+Number(i),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(g)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${h}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(u)}</strong></td></tr></tfoot>
        </table>
      </div>`},a=t.usingProvisionalBuying&&t.missingBuyingPrice?.length?`<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) use the previous buying rate for stock/purchases \u2014 enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on Meter Reading \u2192 Purchase cost to lock the correct rate.</p>`:t.canCalculate?"":formatUnresolvedBuyingWarning(t),l=t.fuelGrossProfit!=null?`<p class="report-note muted">Dealer Margin (ops check, not a trading credit) = net litres \xD7 (selling \u2212 landed buying): <strong>${formatCurrency(t.fuelGrossProfit)}</strong> \u2014 same as Dashboard / P&amp;L fuel gross.</p>`:"",c=t.vaultPurchaseTotal>0?'<p class="report-note muted">Lube / other purchases = sum of vault <strong>Purchase invoice</strong> amounts in this period (Invoices page). Fuel inward remains on MS/HSD purchase lines from DSR.</p>':'<p class="report-note muted">No vault purchase amounts in this period \u2014 lube stock/COGS is not tracked separately. Add purchase PDFs with amounts on Invoices to populate Lube purchases.</p>';return`
    ${reportHeader("Trading account",s.start,s.end)}
    ${renderProfitGuide("trading")}
    <div class="report-pl-grid report-trading-grid">
      ${o("Debit",n)}
      ${o("Credit",r)}
    </div>
    <p class="report-note muted">Debit and credit totals match via Gross income c/d (stock-based: Sales + Closing \u2212 Opening \u2212 Purchases). This is not Nett Profit.</p>
    ${a}
    ${l}
    ${c}
    <p class="report-summary-line">Gross income c/d: <strong>${formatCurrency(t.grossIncome)}</strong> <span class="muted">(trading balance \u2014 see P&amp;L for real profit)</span></p>`}function formatUnresolvedBuyingWarning(e){const s=escapeHtml(getBuyingPriceUnitLabel()),t=e.unresolvedBuying?.length??0,r=e.missingBuyingPrice?.length??0;if(!e.canCalculate){const n=t>0?`${t} sale/receipt day(s) have no resolvable buying rate (no prior receipt rate in history)`:"Some days have no resolvable buying rate",o=r>0?` (${r} receipt day(s) also have no entered \u20B9/KL yet)`:"";return`<p class="report-note warning">${n}${o}. Enter pre-VAT ${s} on Meter Reading \u2192 Purchase cost before net profit can be calculated.</p>`}return e.usingProvisionalBuying&&r>0?`<p class="report-note warning">${r} receipt day(s) still need an entered buying price \u2014 figures below use the previous receipt rate until you save ${s} on Meter Reading \u2192 Purchase cost.</p>`:""}function renderProfitLoss(e,s){const t=getTradingAndPl(e,s),r=Array.from(t.expensesByCategory.values()).sort((i,m)=>i.label.localeCompare(m.label)),n=Array.from(t.testingExpensesByCategory.values()).sort((i,m)=>i.label.localeCompare(m.label)),o=formatUnresolvedBuyingWarning(t),a=Number(t.totalExpenses??0),l=n.length?`<p class="report-note muted">Testing expenses excluded from net profit (day closing): ${n.map(i=>`${escapeHtml(i.label)} \u20B9${formatNumberPlain(i.amount)}`).join("; ")}.</p>`:"";if(!t.canCalculate){const i=r.length>0?`<table class="report-table">
            <thead><tr><th>Expense head</th><th class="num">Amount (\u20B9)</th></tr></thead>
            <tbody>${r.map(m=>`<tr><td>${escapeHtml(m.label)}</td><td class="num">${formatNumberPlain(m.amount)}</td></tr>`).join("")}</tbody>
            <tfoot><tr class="report-total-row"><td><strong>Total (excl. testing)</strong></td><td class="num"><strong>${formatNumberPlain(a)}</strong></td></tr></tfoot>
          </table>`:'<p class="muted">No operating expenses in this period.</p>';return`
      ${reportHeader("Profit & loss account",s.start,s.end)}
      ${o}
      <p class="report-summary-line">Gross profit: <strong>\u2014</strong> \xB7 Expenses: <strong>${formatCurrency(a)}</strong> \xB7 Nett profit: <strong>\u2014</strong></p>
      <h3>Operating expenses</h3>
      ${i}
      ${l}
      <p class="report-note muted">Books debit/credit layout is hidden until every sale/receipt day can resolve a buying rate (entered or prior receipt).</p>`}const c=Number(t.grossProfit??0),g=Number(t.netProfit??0),p=[["Gross Profit",c]],h=r.map(i=>[i.label,i.amount]);h.push(["Nett Profit",g]);const u=(i,m,{boldLast:f=!1}={})=>{const b=m.map(([N,S],v)=>{const T=f&&v===m.length-1,_=T?' class="report-total-row"':"",R=T?`<strong>${escapeHtml(N)}</strong>`:escapeHtml(N),P=T?`<strong>${formatNumberPlain(S)}</strong>`:formatNumberPlain(S);return`<tr${_}><td>${R}</td><td class="num">${P}</td></tr>`}).join(""),y=m.reduce((N,[,S])=>N+Number(S),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(i)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${b||'<tr><td colspan="2" class="muted">No entries</td></tr>'}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(y)}</strong></td></tr></tfoot>
        </table>
      </div>`},d=`<p class="report-note muted">Gross profit = fuel gross <strong>${formatCurrency(t.fuelGrossProfit)}</strong>${t.lubeCogs>0||t.products.lube.sales>0?` + lube gross <strong>${formatCurrency(t.lubeGrossProfit)}</strong> (sales \u2212 vault purchases)`:""}. Same formula as Analysis and the Dashboard Net profit glance.</p>`;return`
    ${reportHeader("Profit & loss account",s.start,s.end)}
    ${renderProfitGuide("pl")}
    ${o}
    <div class="report-pl-grid report-trading-grid">
      ${u("Debit (indirect expenses)",h,{boldLast:!0})}
      ${u("Credit",p,{boldLast:!0})}
    </div>
    <p class="report-summary-line">Gross profit: <strong>${formatCurrency(c)}</strong> \xB7 Expenses: <strong>${formatCurrency(a)}</strong> \xB7 Nett profit (real profit): <strong>${formatCurrency(g)}</strong></p>
    ${l}
    ${d}`}function buildGstr1Sections(e,s){const t=isBillingIncludedInGstReports(),n=buildFuelSalesDailyInvoices(e.dsrRows,s).map(c=>({date:c.date,invoiceNumber:c.invoiceNumber,party:c.partyName,gstin:"",taxable:0,cgst:0,sgst:0,igst:0,nilValue:Number(c.nilValue??c.gross??0),gross:Number(c.gross??0),product:c.productLabel})),o=[],a=[];t&&e.invoices.forEach(c=>{const g=(c.party_gstin||"").trim().toUpperCase(),p=Number(c.cgst_total??0),h=Number(c.sgst_total??0),u=Number(c.igst_total??0),d=Number(c.non_gst_total??0),i=Number(c.nil_rate_total??0),m=invoiceHeaderTaxable(c),f={date:c.invoice_date,invoiceNumber:c.invoice_number,party:c.party_name,gstin:g,taxable:m,cgst:p,sgst:h,igst:u,nilValue:d+i,gross:Number(c.total_amount??0)};g.length>=15?o.push(f):a.push(f)});const l=(c,g)=>c.reduce((p,h)=>(g.forEach(u=>{p[u]=(p[u]||0)+Number(h[u]||0)}),p),{});return{includeBilling:t,nilRows:n,b2b:o,b2cs:a,nilTotals:l(n,["nilValue","gross"]),b2bTotals:l(o,["taxable","cgst","sgst","igst","gross"]),b2csTotals:l(a,["taxable","cgst","sgst","igst","nilValue","gross"])}}let reportDerivedCache={dataRef:null,rangeKey:"",gstr1:null,purchases:null,gstr3b:null,tradingPl:null};function clearReportDerivedCache(){reportDerivedCache={dataRef:null,rangeKey:"",gstr1:null,purchases:null,gstr3b:null,tradingPl:null}}function reportDerivedSlot(e,s){const t=`${s?.start||""}|${s?.end||""}`;return(reportDerivedCache.dataRef!==e||reportDerivedCache.rangeKey!==t)&&(clearReportDerivedCache(),reportDerivedCache.dataRef=e,reportDerivedCache.rangeKey=t),reportDerivedCache}function getGstr1Sections(e,s){const t=reportDerivedSlot(e,s);return t.gstr1||(t.gstr1=buildGstr1Sections(e,s)),t.gstr1}function getFuelPurchaseRows(e,s){const t=reportDerivedSlot(e,s);return t.purchases||(t.purchases=buildFuelPurchaseRows(e,s)),t.purchases}function getGstr3bSummary(e,s){const t=reportDerivedSlot(e,s);return t.gstr3b||(t.gstr3b=buildGstr3bSummary(e,s)),t.gstr3b}function getTradingAndPl(e,s){const t=reportDerivedSlot(e,s);return t.tradingPl||(t.tradingPl=computeTradingAndPl(e,s)),t.tradingPl}function renderGstr1Table(e,s,t,r,n){return`
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(e)}</h3>
      <p class="report-subtitle muted">${s}</p>
      <table class="report-table report-gst-detail">
        <thead><tr>${t}</tr></thead>
        <tbody>${r}</tbody>
        ${n||""}
      </table>
    </section>`}function renderGstr1Register(e,s){const t=getGstr1Sections(e,s),r=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL section still included.</p>',n=t.nilRows.map(g=>{const p=String(g.product||"").toLowerCase().includes("diesel")?"diesel":"petrol";return`<tr class="${fuelRowClass(p)}">
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
    <th class="num">IGST</th><th class="num">Exempt/NIL</th><th class="num">Gross</th>`,l=g=>g.map(p=>`<tr>
      <td>${formatNumericDate(p.date)}</td>
      <td>${escapeHtml(p.invoiceNumber)}</td>
      <td>${escapeHtml(p.party)}</td>
      <td>${escapeHtml(p.gstin||"\u2014")}</td>
      <td class="num">${formatNumberPlain(p.taxable)}</td>
      <td class="num">${formatNumberPlain(p.cgst)}</td>
      <td class="num">${formatNumberPlain(p.sgst)}</td>
      <td class="num">${formatNumberPlain(p.igst)}</td>
      <td class="num">${formatNumberPlain(p.nilValue)}</td>
      <td class="num">${formatNumberPlain(p.gross)}</td>
    </tr>`).join("")||'<tr><td colspan="10" class="muted">No invoices in this section</td></tr>',c=(g,p)=>g.length?`<tfoot><tr class="report-total-row">
        <td colspan="4"><strong>Total (${g.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(p.taxable)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(p.cgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(p.sgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(p.igst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(p.nilValue||0)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(p.gross)}</strong></td>
      </tr></tfoot>`:"";return`
    ${reportHeader("GSTR-1 style outward register",s.start,s.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-1 \u2014 not a GST portal JSON upload. Sections mirror B2B, B2CS and NIL rated fuel (SFC).</p>
    ${r}
    ${renderGstr1Table("4A/4B \u2014 B2B (registered party GSTIN)","Billing invoices with a 15-character party GSTIN.",a,l(t.b2b),c(t.b2b,t.b2bTotals))}
    ${renderGstr1Table("7 \u2014 B2CS (unregistered / Cash)","Billing invoices without a party GSTIN.",a,l(t.b2cs),c(t.b2cs,t.b2csTotals))}
    ${renderGstr1Table("8 \u2014 NIL rated (fuel SFC)","Daily fuel outward vouchers from DSR (NIL rate).",'<th>Date</th><th>Invoice</th><th>Product</th><th class="num">NIL value</th><th class="num">Gross</th>',n,o)}
    <p class="report-note muted">Use <strong>Download CSV</strong> for a flat file you can reconcile in Excel. Portal filing still requires the official GST offline tool / API.</p>`}function buildGstr1Csv(e,s){const t=getGstr1Sections(e,s),r=[["section","date","invoice","party","gstin","product","taxable","cgst","sgst","igst","nil_value","gross"].join(",")],n=a=>{const l=String(a??"");return/[",\n]/.test(l)?`"${l.replace(/"/g,'""')}"`:l},o=(a,l)=>{r.push([a,l.date,l.invoiceNumber,l.party||"",l.gstin||"",l.product||"",l.taxable??"",l.cgst??"",l.sgst??"",l.igst??"",l.nilValue??"",l.gross??""].map(n).join(","))};return t.b2b.forEach(a=>o("B2B",a)),t.b2cs.forEach(a=>o("B2CS",a)),t.nilRows.forEach(a=>o("NIL",a)),r.join(`
`)}function downloadGstr1Csv(){if(!cachedData||!cachedRange)return;const e=buildGstr1Csv(cachedData,cachedRange),s=new Blob([e],{type:"text/csv;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr1-register_${n}_${o}.csv`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function formatGstr1PortalDate(e){if(!e||String(e).length<10)return"";const[s,t,r]=String(e).slice(0,10).split("-");return`${r}-${t}-${s}`}function gstr1FilingPeriod(e){const s=String(e?.end||"").slice(0,10);if(s.length<7)return"";const[t,r]=s.split("-");return`${r}${t}`}function gstr1StateCodeFromGstin(e){const s=String(e||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function gstr1InvoiceRate(e){const s=Number(e.taxable||0);if(s<=0)return 0;const r=(Number(e.cgst||0)+Number(e.sgst||0)+Number(e.igst||0))/s*100;return r<3?0:r<8?5:r<15?12:r<21?18:r<26?24:28}function buildGstr1Json(e,s){const t=getGstr1Sections(e,s),r=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),n=gstr1StateCodeFromGstin(r)||"21",o=gstr1FilingPeriod(s),a=new Map;t.b2b.forEach(b=>{const y=String(b.gstin||"").trim().toUpperCase();a.has(y)||a.set(y,[]);const N=gstr1InvoiceRate(b),S={txval:Number(Number(b.taxable||0).toFixed(2)),rt:N};Number(b.igst||0)>0?S.iamt=Number(Number(b.igst).toFixed(2)):(S.camt=Number(Number(b.cgst||0).toFixed(2)),S.samt=Number(Number(b.sgst||0).toFixed(2))),a.get(y).push({inum:b.invoiceNumber,idt:formatGstr1PortalDate(b.date),val:Number(Number(b.gross||0).toFixed(2)),pos:gstr1StateCodeFromGstin(y)||n,rchrg:"N",inv_typ:"R",itms:[{num:1,itm_det:S}]})});const l=Array.from(a.entries()).map(([b,y])=>({ctin:b,inv:y})),c=new Map;t.b2cs.forEach(b=>{const y=gstr1InvoiceRate(b),N=Number(b.igst||0)>0,S=`${N?"INTER":"INTRA"}|${n}|${y}`;c.has(S)||c.set(S,{sply_ty:N?"INTER":"INTRA",pos:n,typ:"OE",txval:0,rt:y,iamt:0,camt:0,samt:0,csamt:0});const v=c.get(S);v.txval+=Number(b.taxable||0),v.iamt+=Number(b.igst||0),v.camt+=Number(b.cgst||0),v.samt+=Number(b.sgst||0)});const g=Array.from(c.values()).map(b=>({...b,txval:Number(b.txval.toFixed(2)),iamt:Number(b.iamt.toFixed(2)),camt:Number(b.camt.toFixed(2)),samt:Number(b.samt.toFixed(2))})),h={inv:[{sply_ty:"INTRB2C",expt_amt:0,nil_amt:Number((t.nilTotals.nilValue||0).toFixed(2)),ngsup_amt:0}]},u=(b,y)=>{if(!b.length)return null;const N=b.map(S=>String(S.invoiceNumber||"")).filter(Boolean).sort();return{doc_num:y,docs:[{num:1,from:N[0],to:N[N.length-1],totnum:N.length,cancel:0,net_issue:N.length}]}},d=[],i=[...t.b2b,...t.b2cs],m=u(i,1);m&&d.push(m);const f=u(t.nilRows,4);return f&&d.push(f),{gstin:r||null,fp:o,version:"GST3.1.6",hash:"hash",b2b:l,b2cs:g,nil:h,doc_issue:{doc_det:d},_meta:{note:"Internal aid for GSTR-1 filing tools. Verify every figure before portal upload.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),fuelNilCount:t.nilRows.length,b2bCount:t.b2b.length,b2csCount:t.b2cs.length}}}function downloadGstr1Json(){if(!cachedData||!cachedRange)return;const e=buildGstr1Json(cachedData,cachedRange),s=new Blob([JSON.stringify(e,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr1_${e.fp||`${n}_${o}`}.json`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function gstrMoney(e){return Number(Number(e||0).toFixed(2))}function gstrTaxBucket(e=0,s=0,t=0,r=0,n=0){return{txval:gstrMoney(e),iamt:gstrMoney(s),camt:gstrMoney(t),samt:gstrMoney(r),csamt:gstrMoney(n)}}function buildGstr3bSummary(e,s){const t=getGstr1Sections(e,s),r=getFuelPurchaseRows(e,s);let n=0,o=0;t.includeBilling&&(e.invoices||[]).forEach(y=>{n+=Number(y.nil_rate_total??0),o+=Number(y.non_gst_total??0)});const a=gstrTaxBucket((t.b2bTotals.taxable||0)+(t.b2csTotals.taxable||0),(t.b2bTotals.igst||0)+(t.b2csTotals.igst||0),(t.b2bTotals.cgst||0)+(t.b2csTotals.cgst||0),(t.b2bTotals.sgst||0)+(t.b2csTotals.sgst||0),0),l={txval:gstrMoney((t.nilTotals.nilValue||0)+n)},c={txval:gstrMoney(o)},g=gstrTaxBucket(0,0,0,0,0),p=gstrTaxBucket(0,0,0,0,0);let h=0,u=0;t.b2cs.forEach(y=>{const N=Number(y.igst||0);N<=0||(h+=Number(y.taxable||0),u+=N)});let d=0,i=0,m=0;(r.detailRows||[]).forEach(y=>{d+=Number(y.igst||0),i+=Number(y.cgst||0),m+=Number(y.sgst||0)});const f={ty:"OTH",iamt:gstrMoney(d),camt:gstrMoney(i),samt:gstrMoney(m),csamt:0},b={iamt:0,camt:0,samt:0,csamt:0};return{includeBilling:t.includeBilling,retPeriod:gstr1FilingPeriod(s),osupDet:a,osupZero:g,osupNil:l,osupNongst:c,isupRev:p,interUnregTaxable:gstrMoney(h),interUnregIgst:gstrMoney(u),itcOth:f,itcNet:{iamt:f.iamt,camt:f.camt,samt:f.samt,csamt:0},itcZero:b,purchaseMissingBuying:r.missingBuyingCount||0,purchaseLineCount:(r.detailRows||[]).length,g1:t}}function renderGstr3bRegister(e,s){const t=getGstr3bSummary(e,s),r=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL still included in 3.1(c).</p>',n=t.purchaseMissingBuying>0?`<p class="report-note warning">${t.purchaseMissingBuying} fuel receipt(s) missing buying price \u2014 excluded from Table 4 ITC.</p>`:"",o=(l,c,g,p=!0)=>p?`<tr>
        <td>${escapeHtml(l)}</td>
        <td>${escapeHtml(c)}</td>
        <td class="num">${formatNumberPlain(g.txval)}</td>
        <td class="num">${formatNumberPlain(g.iamt)}</td>
        <td class="num">${formatNumberPlain(g.camt)}</td>
        <td class="num">${formatNumberPlain(g.samt)}</td>
        <td class="num">${formatNumberPlain(g.csamt||0)}</td>
      </tr>`:`<tr>
      <td>${escapeHtml(l)}</td>
      <td>${escapeHtml(c)}</td>
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
    <p class="report-note muted">Use <strong>Download GSTR-3B JSON</strong> for an offline-utility-style summary file. Verify every figure before portal upload.</p>`}function buildGstr3bJson(e,s){const t=getGstr3bSummary(e,s),r=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),n=o=>({ty:o,...t.itcZero});return{gstin:r||null,ret_period:t.retPeriod,sup_details:{osup_det:t.osupDet,osup_zero:{txval:t.osupZero.txval,iamt:t.osupZero.iamt,csamt:t.osupZero.csamt},osup_nil_exmp:t.osupNil,isup_rev:t.isupRev,osup_nongst:t.osupNongst},inter_sup:{unreg_details:[],comp_details:[],uin_details:[]},eco_dtls:{eco_sup:gstrTaxBucket(0),eco_reg_sup:{txval:0}},itc_elg:{itc_avl:[n("IMPG"),n("IMPS"),n("ISRC"),n("ISD"),{...t.itcOth}],itc_rev:[n("RUL"),n("OTH")],itc_net:t.itcNet,itc_inelg:[n("RUL"),n("OTH")]},inward_sup:{isup_details:[{ty:"GST",inter:0,intra:0},{ty:"NONGST",inter:0,intra:0}]},intr_ltfee:{intr_details:{iamt:0,camt:0,samt:0,csamt:0},ltfee_details:{camt:0,samt:0}},_meta:{note:"Internal aid for GSTR-3B filing tools. Verify every figure before portal upload. Table 3.2 POS omitted when unknown.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),interUnregTaxable:t.interUnregTaxable,interUnregIgst:t.interUnregIgst,purchaseLineCount:t.purchaseLineCount,purchaseMissingBuying:t.purchaseMissingBuying,includeBilling:t.includeBilling}}}function downloadGstr3bJson(){if(!cachedData||!cachedRange)return;const e=buildGstr3bJson(cachedData,cachedRange),s=new Blob([JSON.stringify(e,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr3b_${e.ret_period||`${n}_${o}`}.json`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function updateReportsCsvButtonVisibility(){const e=document.getElementById("reports-csv-btn"),s=document.getElementById("reports-json-btn"),t=!!(cachedData&&cachedRange),r=activeReport==="gstr1"&&t,n=(activeReport==="gstr1"||activeReport==="gstr3b")&&t;e&&(e.classList.toggle("hidden",!r),e.disabled=!r),s&&(s.classList.toggle("hidden",!n),s.disabled=!n,s.textContent=activeReport==="gstr3b"?"Download GSTR-3B JSON":"Download GSTR-1 JSON")}function renderReportHtml(e,s,t){switch(e){case"gst-sales-summary":return renderGstSalesSummary(s,t);case"gst-sales-detail":return renderGstSalesDetail(s,t);case"gst-purchase-summary":return renderGstPurchaseSummary(s,t);case"gst-purchase-detail":return renderGstPurchaseDetail(s,t);case"trading":return renderTradingAccount(s,t);case"pl":return renderProfitLoss(s,t);case"gstr1":return renderGstr1Register(s,t);case"gstr3b":return renderGstr3bRegister(s,t);case"fuel-income":return renderFuelIncome(s,t);case"pump-sales":return renderPumpSalesReport(s,t);case"shift-sales":return renderShiftSalesReport(s,t);case"salesman-sales":return renderSalesmanSalesReport(s,t);case"dsr":default:return renderTankWiseDsr(s,t)}}function productFuelLabel(e){const s=normalizeProduct(e);return s==="petrol"?"MS":s==="diesel"?"HSD":e||"\u2014"}function shiftReportLabel(e){const s=PumpSettings.getShiftConfig?.()||{};return e==="morning"?s.morningName||"Morning":e==="afternoon"?s.afternoonName||"Afternoon":e||"\u2014"}function renderPumpSalesReport(e,s){const t=e.meterBreakdown,r=t?.by_pump||[],n=t?.daily_pump||[],o=new Set(r.map(p=>`${p.reading_date}|${normalizeProduct(p.product)}|${p.pump_no}`)),a=(n||[]).flatMap(p=>{const h=p.date||p.reading_date,u=normalizeProduct(p.product),d=[];for(const i of[1,2]){const m=`${h}|${u}|${i}`;o.has(m)||d.push({reading_date:h,shift:null,product:u,pump_no:i,litres:i===1?Number(p.sales_pump1)||0:Number(p.sales_pump2)||0,net_litres:null,from_daily:!0})}return d}),l=[...r,...a].sort((p,h)=>{const u=String(h.reading_date).localeCompare(String(p.reading_date));if(u)return u;const d=String(p.shift||"").localeCompare(String(h.shift||""));if(d)return d;const i=String(p.product).localeCompare(String(h.product));return i||(p.pump_no||0)-(h.pump_no||0)});let c=0;const g=l.map(p=>(c+=Number(p.litres)||0,`<tr>
          <td>${formatNumericDate(p.reading_date)}</td>
          <td>${p.from_daily?"Daily":escapeHtml(shiftReportLabel(p.shift))}</td>
          <td>${formatFuelBadge(productFuelLabel(p.product))}</td>
          <td>Pump ${escapeHtml(String(p.pump_no))}</td>
          <td class="num">${formatNumberPlain(p.litres)}</td>
          <td class="num">${p.net_litres==null?"\u2014":formatNumberPlain(p.net_litres)}</td>
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
          <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
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
      <p class="muted">Assign staff to nozzles under <a href="meter-reading.html#shift-readings">Shift register</a>.</p>`;const r=new Map;(e.dsrRows||[]).forEach(i=>{const m=r.get(i.date)||{petrol:0,diesel:0},f=normalizeProduct(i.product);f==="petrol"&&(m.petrol=Number(i.petrol_rate)||m.petrol),f==="diesel"&&(m.diesel=Number(i.diesel_rate)||m.diesel),r.set(i.date,m)});let n=0,o=0,a=0,l=0,c=0,g=0,p=0,h=0,u=!1;const d=t.map(i=>{const m=r.get(i.reading_date)||{},f=i.petrol_net_litres!=null?Number(i.petrol_net_litres):Number(i.petrol_litres)||0,b=i.diesel_net_litres!=null?Number(i.diesel_net_litres):Number(i.diesel_litres)||0,y=f*(m.petrol||0)+b*(m.diesel||0),N=Number(i.cash_collected)||0,S=Number(i.phone_pay)||0,v=Number(i.credit_amount)||0,T=Number(i.expense_amount)||0,_=i.total_collected!=null?Number(i.total_collected)||0:N+S+v+T,R=m.petrol||m.diesel;return R&&(u=!0,o+=y,h+=y-_),n+=Number(i.total_litres)||0,a+=N,l+=S,c+=v,g+=T,p+=_,`<tr>
        <td>${formatNumericDate(i.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(i.shift))}</td>
        <td>${escapeHtml(i.employee_name||"Staff")}</td>
        <td class="num">${formatNumberPlain(i.petrol_litres)}</td>
        <td class="num">${formatNumberPlain(i.diesel_litres)}</td>
        <td class="num">${formatNumberPlain(i.total_litres)}</td>
        <td class="num">${R?formatNumberPlain(y):"\u2014"}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${formatNumberPlain(S)}</td>
        <td class="num">${formatNumberPlain(v)}</td>
        <td class="num">${formatNumberPlain(T)}</td>
        <td class="num">${formatNumberPlain(_)}</td>
        <td class="num">${R?formatNumberPlain(y-_):"\u2014"}</td>
      </tr>`}).join("");return`
    ${reportHeader("Salesman sales",s.start,s.end)}
    <p class="muted report-note">Short = expected \u2212 (cash + phone + credit + expenses). Expected = net litres (sale \u2212 testing) \xD7 daily selling rates.</p>
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
          <th class="num">Credit \u20B9</th>
          <th class="num">Exp \u20B9</th>
          <th class="num">Total \u20B9</th>
          <th class="num">Short \u20B9</th>
        </tr>
      </thead>
      <tbody>${d}</tbody>
      <tfoot>
        <tr>
          <td colspan="5"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(n)}</strong></td>
          <td class="num"><strong>${u?formatNumberPlain(o):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(g)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
          <td class="num"><strong>${u?formatNumberPlain(h):"\u2014"}</strong></td>
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
