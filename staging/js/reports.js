const REPORT_CATALOG=[{group:"Operations",reports:[{id:"dsr",title:"Tank-wise DSR",description:"HSD + MS tanks: dips, receipts, shortage, testing, variance, rates, TVA."},{id:"fuel-income",title:"Fuel Income",description:"Daily dealer margin: net litres \xD7 (selling \u2212 landed buying) for MS and HSD."}]},{group:"GST \u2014 Sales",reports:[{id:"gst-sales-summary",title:"GST Sales Summary",description:"Inside / outside state outward supply: fuel NIL + billing slabs (CGST/SGST/IGST)."},{id:"gst-sales-detail",title:"GST Sales Detail",description:"Daily fuel NIL invoices (SFC) \u2014 one MS + one HSD per sale day; billing with GSTIN/IGST when enabled."}]},{group:"GST \u2014 Purchases (Fuel inward)",reports:[{id:"gst-purchase-summary",title:"GST Purchase Summary",description:"Inside / outside state fuel inward by VAT slab (supplier GSTIN vs station)."},{id:"gst-purchase-detail",title:"GST Purchase Detail",description:"Receipt-wise register with BPCL invoice no, GSTIN, qty, VAT and gross."}]},{group:"Accounts",reports:[{id:"trading",title:"Trading account",description:"Stock-based books (opening/closing stock). Gross income c/d is a balancing figure \u2014 not take-home profit."},{id:"pl",title:"Profit & Loss",description:"Your real profit is Nett Profit here. Gross Profit = margin before expenses; same engine as Analysis and Dashboard Net profit."}]},{group:"GST \u2014 Filing aids",reports:[{id:"gstr1",title:"GSTR-1 style register",description:"B2B / B2CS / NIL (fuel SFC) outward summary \u2014 printable; CSV and portal-style JSON from the toolbar."},{id:"gstr3b",title:"GSTR-3B style summary",description:"Tables 3.1 / 3.2 / 4 / 5 from fuel + billing \u2014 printable; portal-style JSON from the toolbar."}]}];let activeReport="dsr",cachedData=null,cachedRange=null,reportsLoadInFlight=null,reportPrintBusy=!1;document.addEventListener("DOMContentLoaded",async()=>{const e=await requireAuth({allowedRoles:["admin"],onDenied:"dashboard.html",pageName:"reports"});e&&(applyRoleVisibility(e.role),await loadPumpSettings(),initReportsPage())});function findReportMeta(e){for(const s of REPORT_CATALOG){const t=s.reports.find(r=>r.id===e);if(t)return t}return null}function getFuelGstPct(){return Number(PumpSettings.getCachedSync().reports?.fuelGstPct)||AppConfig.DEFAULT_REPORTS.fuelGstPct}function isBillingIncludedInGstReports(){const e=PumpSettings.getCachedSync().billing||{},s=PumpSettings.getCachedSync().reports||{};return typeof e.includeInGstReports=="boolean"?e.includeInGstReports:typeof s.includeBillingInGst=="boolean"?s.includeBillingInGst:AppConfig.DEFAULT_BILLING.includeInGstReports!==!1}function formatMonthLabel(e){const[s,t]=e.split("-").map(Number);return!s||!t?e:new Date(s,t-1,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"})}const FUEL_OUTWARD_GST_PCT=0;function calcDailyFuelSale(e){const{revenue:s,litres:t}=computeFuelRowMargin(e,null);return{litres:t,gross:s}}function aggregateFuelSalesByMonth(e,s){const t=new Map;return(e??[]).forEach(r=>{if(r.date<s.start||r.date>s.end)return;const n=normalizeProduct(r.product);if(n!=="petrol"&&n!=="diesel")return;const{litres:o,gross:a}=calcDailyFuelSale(r);if(o<=0&&a<=0)return;const i=r.date.slice(0,7);t.has(i)||t.set(i,{petrol:{litres:0,gross:0},diesel:{litres:0,gross:0}});const l=t.get(i)[n];l.litres+=o,l.gross+=a}),t}function buildFuelSalesMonthLines(e,s){const t=FUEL_OUTWARD_GST_PCT,r=classifyGstSlab(t),n=[];return[...aggregateFuelSalesByMonth(e,s).entries()].sort(([o],[a])=>o.localeCompare(a)).forEach(([o,a])=>{["petrol","diesel"].forEach(i=>{const{litres:l,gross:m}=a[i];l<=0&&m<=0||n.push({monthKey:o,monthLabel:formatMonthLabel(o),product:i,productLabel:i==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:l,gstPct:t,slabKey:r,taxable:0,cgst:0,sgst:0,gross:m,nilValue:m})})}),n}function buildFuelSalesDailyInvoices(e,s){const t=FUEL_OUTWARD_GST_PCT,r=classifyGstSlab(t),n={petrol:0,diesel:1};return(e??[]).filter(a=>a.date>=s.start&&a.date<=s.end).map(a=>{const i=normalizeProduct(a.product);if(i!=="petrol"&&i!=="diesel")return null;const{litres:l,gross:m}=calcDailyFuelSale(a);return l<=0&&m<=0?null:{date:a.date,product:i,productLabel:i==="petrol"?"Petrol (MS)":"Diesel (HSD)",litres:l,gross:m,nilValue:m,gstPct:t,slabKey:r,taxable:0,cgst:0,sgst:0,partyName:"Cash A/c"}}).filter(Boolean).sort((a,i)=>a.date.localeCompare(i.date)||(n[a.product]??9)-(n[i.product]??9)).map((a,i)=>({...a,invoiceNumber:`SFC/${String(i+1).padStart(4,"0")}`}))}function sumFuelSalesLines(e){return e.reduce((s,t)=>({litres:s.litres+t.litres,taxable:s.taxable+t.taxable,cgst:s.cgst+t.cgst,sgst:s.sgst+t.sgst,gross:s.gross+t.gross}),{litres:0,taxable:0,cgst:0,sgst:0,gross:0})}function mergeSlabTotals(e,s){const t={};return GST_SLABS.forEach(r=>{const n=e[r.key]||emptySlabBucket(),o=s[r.key]||emptySlabBucket();t[r.key]={taxable:n.taxable+o.taxable,cgst:n.cgst+o.cgst,sgst:n.sgst+o.sgst,igst:(n.igst||0)+(o.igst||0),gross:n.gross+o.gross}}),t}function emptySlabBucket(){return{taxable:0,cgst:0,sgst:0,igst:0,gross:0}}function emptySlabTotals(){const e={};return GST_SLABS.forEach(s=>{e[s.key]=emptySlabBucket()}),e}function fuelSalesToSlabTotals(e){const s=emptySlabTotals();return e.forEach(t=>{const r=t.slabKey||classifyGstSlab(t.gstPct);if(!s[r])return;const n=Number(t.nilValue??t.gross??0);r==="nil"?(s[r].taxable+=n,s[r].gross+=n):(s[r].taxable+=t.taxable,s[r].cgst+=t.cgst,s[r].sgst+=t.sgst,s[r].igst+=Number(t.igst||0),s[r].gross+=t.gross)}),s}function gstinStateCode(e){const s=String(e||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function getStationGstinStateCode(){return gstinStateCode(typeof PumpSettings<"u"?PumpSettings.getStationGstin():"")}function isInterstatePartyGstin(e){const s=gstinStateCode(e),t=getStationGstinStateCode();return!s||!t?!1:s!==t}function getFuelSupplierLabel(){return PumpSettings.getCachedSync().reports?.fuelSupplierLabel||AppConfig.DEFAULT_REPORTS.fuelSupplierLabel}function getFuelSupplierGstin(){const e=PumpSettings.getCachedSync().reports?.fuelSupplierGstin;return e!=null&&String(e).trim()?String(e).trim().toUpperCase():AppConfig.DEFAULT_REPORTS.fuelSupplierGstin||""}function resolveSupplierGstin(e){const s=e!=null?String(e).trim():"";return s?s.toUpperCase():getFuelSupplierGstin()}function initReportsAboutAccordion(){initDocsAccordion(document.querySelector(".reports-about-accordion"))}function initReportsPage(){const e=document.getElementById("reports-start"),s=document.getElementById("reports-end"),t=new Date,r=t.getFullYear(),n=t.getMonth(),o=f=>String(f).padStart(2,"0"),a=`${r}-${o(n+1)}-01`,i=`${r}-${o(n+1)}-${o(new Date(r,n+1,0).getDate())}`;e&&(e.value=a),s&&(s.value=i),renderReportCatalog(),setActiveReportTab(activeReport),PrintUtils.preloadReportPrintCss?.(),initReportsAboutAccordion(),initPageSections({navItemSelector:".reports-nav .settings-nav-item",panelSelector:".reports-panels .settings-panel",defaultSection:"generate",validSections:["generate","about"]});const m=new URLSearchParams(window.location.search).get("tab");m&&findReportMeta(m)&&setActiveReportTab(m),document.getElementById("reports-catalog")?.addEventListener("click",async f=>{const y=f.target.closest(".reports-pick");if(y?.dataset.report){if(setActiveReportTab(y.dataset.report),document.querySelector(".reports-output")?.scrollIntoView({behavior:"smooth",block:"nearest"}),!cachedData){const c=document.getElementById("reports-preview");c&&(c.innerHTML='<p class="muted">Loading report data\u2026</p>');try{await ensureReportsDataLoaded()}catch{}}renderActiveReport()}}),document.getElementById("reports-filter-form")?.addEventListener("submit",async f=>{f.preventDefault(),await loadAndRenderReports()}),document.getElementById("reports-print-btn")?.addEventListener("click",()=>{handleReportPrintClick()}),document.getElementById("reports-csv-btn")?.addEventListener("click",()=>{downloadGstr1Csv()}),document.getElementById("reports-json-btn")?.addEventListener("click",()=>{activeReport==="gstr3b"?downloadGstr3bJson():downloadGstr1Json()}),syncReportsAboutHash(),window.addEventListener("hashchange",syncReportsAboutHash)}function syncReportsAboutHash(){if((location.hash||"").replace(/^#/,"")!=="about")return;const e=document.getElementById("reports-about");e?.hidden||e.scrollIntoView({behavior:"smooth",block:"start"})}function ensureReportsDataLoaded(){return cachedData?Promise.resolve():reportsLoadInFlight||(reportsLoadInFlight=loadAndRenderReports().finally(()=>{reportsLoadInFlight=null}),reportsLoadInFlight)}function renderReportCatalog(){const e=document.getElementById("reports-catalog");e&&(e.innerHTML=REPORT_CATALOG.map(s=>`
    <div class="reports-nav-group" role="group" aria-labelledby="reports-group-${slugify(s.group)}">
      <p class="reports-nav-group-title" id="reports-group-${slugify(s.group)}">${escapeHtml(s.group)}</p>
      ${s.reports.map(t=>`
        <button type="button" class="reports-pick reports-nav-item${t.id===activeReport?" is-active":""}" data-report="${escapeHtml(t.id)}" aria-pressed="${t.id===activeReport?"true":"false"}">
          ${escapeHtml(t.title)}
        </button>`).join("")}
    </div>`).join(""))}function slugify(e){return String(e).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}function setActiveReportTab(e){const s=findReportMeta(e);activeReport=s?s.id:"dsr",document.querySelectorAll(".reports-pick").forEach(o=>{const a=o.dataset.report===activeReport;o.classList.toggle("is-active",a),o.setAttribute("aria-pressed",a?"true":"false")});const t=document.getElementById("reports-active-title"),r=document.getElementById("reports-active-desc"),n=findReportMeta(activeReport);t&&n&&(t.textContent=n.title),r&&(r.textContent=n?.description??""),updateReportsCsvButtonVisibility()}function parseReportTankCapacityLiters(e){if(!e)return null;const s=String(e).trim().toUpperCase().replace(/\s/g,""),t=s.match(/^([\d.]+)KL$/);if(t)return Number(t[1])*1e3;const r=s.match(/^([\d.]+)L$/);if(r)return Number(r[1]);const n=Number(s.replace(/[^\d.]/g,""));return Number.isFinite(n)&&n>0?n:null}function buildTankDsrSection(e,s,t,r,n){let o=0,a=0,i=0,l=0,m=0,f=0,y=0,c=0,u=null;const p=parseReportTankCapacityLiters(t),d=r.map(g=>{const h=Number(g.opening_stock??0),N=Number(g.receipts??0),S=Number(g.testing??0),v=Number(g.total_sales??0),T=getDsrNetSaleLitres(g);o+=T;const R=Number(g.dip_stock??g.stock??0),L=Math.max(0,Number(g.variation??0)),$=Math.max(h+N-L,0),P=Math.max(h+N-R,0);c=R;const w=T-P;a+=w;const I=p!=null&&Number.isFinite(R)?Math.max(0,p-R):null;u=I,i+=N,l+=L,m+=S,f+=v,y+=T;const C=Number(g[n]??0);return`<tr>
        <td>${formatNumericDate(g.date)}</td>
        <td class="num">${formatNumberPlain(h)}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${formatNumberPlain(L)}</td>
        <td class="num">${formatNumberPlain($)}</td>
        <td class="num">${formatNumberPlain(S)}</td>
        <td class="num">${formatNumberPlain(v)}</td>
        <td class="num">${formatNumberPlain(T)}</td>
        <td class="num">${formatNumberPlain(o)}</td>
        <td class="num">${formatNumberPlain(P)}</td>
        <td class="num">${formatNumberPlain(R)}</td>
        <td class="num">${formatNumberPlain(w)}</td>
        <td class="num">${formatNumberPlain(a)}</td>
        <td class="num">${formatNumberPlain(C)}</td>
        <td class="num">${I==null?"\u2014":formatNumberPlain(I)}</td>
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
        <tbody>${d||'<tr><td colspan="15" class="muted">No entries</td></tr>'}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(m)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(f)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
            <td></td>
            <td class="num"><strong>${u==null?"\u2014":formatNumberPlain(u)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </section>`}function renderTankWiseDsr(e,s){const t=DsrQueries.mergeDsrStock(e.dsrRows,e.stockRows),r=PumpSettings.getCachedSync().reports?.tanks||AppConfig.DEFAULT_REPORT_TANKS;let n=reportHeader("Tank-wise DSR report",s.start,s.end),o=!1;return r.forEach(a=>{const i=t.filter(m=>normalizeProduct(m.product)===a.product);if(!i.length)return;o=!0;const l=a.product==="petrol"?"petrol_rate":"diesel_rate";n+=buildTankDsrSection(a.product,a.label,a.capacity,i,l)}),o?n+='<p class="report-note muted">One section per physical tank (HSD and MS). Short = max(0, book \u2212 dip); Total = open + buy \u2212 short; Actual = meter \u2212 testing; Var = actual \u2212 sale by dip (open + buy \u2212 close); TVA = tank capacity \u2212 closing dip.</p>':n+='<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>',n}function fuelIncomeMetrics(e,s){if(!e)return{litres:0,saleRate:0,buyRate:null,income:null,missingBuy:!1};const t=getDsrNetSaleLitres(e),r=getDsrSaleRate(e),n=getEffectiveBuyingRate(e,s),o=t>0&&n==null,a=n!=null&&t>0?t*(r-n):null;return{litres:t,saleRate:r,buyRate:n,income:a,missingBuy:o}}function formatFuelIncomeCell(e,{empty:s="\u2014"}={}){return e==null||!Number.isFinite(e)?s:formatNumberPlain(e)}function renderFuelIncome(e,s){const t=createBuyingRateContext(e.receiptRows),r=new Map;(e.dsrRows??[]).forEach(u=>{const p=u.date;if(!p)return;r.has(p)||r.set(p,{petrol:null,diesel:null});const d=normalizeProduct(u.product);(d==="petrol"||d==="diesel")&&(r.get(p)[d]=u)});const n=[...r.keys()].sort();let o=0,a=0,i=0,l=0,m=0;const f=n.map(u=>{const p=r.get(u),d=fuelIncomeMetrics(p.petrol,t),b=fuelIncomeMetrics(p.diesel,t);(d.missingBuy||b.missingBuy)&&(m+=1),o+=d.litres,a+=b.litres,d.income!=null&&(i+=d.income),b.income!=null&&(l+=b.income);const g=(d.income!=null?d.income:0)+(b.income!=null?b.income:0),h=d.income==null&&b.income==null&&(d.litres>0||b.litres>0)?"\u2014":formatNumberPlain(g);return`<tr>
        <td>${formatNumericDate(u)}</td>
        <td class="num">${formatFuelIncomeCell(d.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(d.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(d.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(d.income)}</td>
        <td class="num">${formatFuelIncomeCell(b.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(b.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(b.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(b.income)}</td>
        <td class="num"><strong>${h}</strong></td>
      </tr>`}).join(""),y=i+l,c=m>0?`<p class="report-note warning">${m} day(s) have sale litres but no landed buying rate \u2014 P.Rate / P.Income blank for those products. Enter buying price on Meter Reading \u2192 Purchase cost for receipt days.</p>`:"";return`
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
      <tbody>${f||'<tr><td colspan="10" class="muted">No meter readings in this period.</td></tr>'}</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${formatNumberPlain(o)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(a)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
        </tr>
      </tfoot>
    </table>
    ${c}
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
    </header>`}async function loadAndRenderReports(){const e=document.getElementById("reports-start")?.value,s=document.getElementById("reports-end")?.value,t=document.getElementById("reports-error"),r=document.getElementById("reports-preview"),n=document.getElementById("reports-date-label");if(t?.classList.add("hidden"),!e||!s){t&&(t.textContent="Please select from and to dates.",t.classList.remove("hidden"));return}let o=e,a=s;a<o&&([o,a]=[a,o]),n&&(n.textContent=o===a?formatNumericDate(o):`${formatNumericDate(o)} \u2013 ${formatNumericDate(a)}`),r&&(r.textContent="Loading\u2026"),setReportPrintButtonWaiting();const i=`reports_${o}_${a}`,l=()=>fetchReportData(o,a);try{await loadPumpSettings(),typeof withProgress=="function"?cachedData=await withProgress(async()=>typeof AppCache<"u"&&AppCache?AppCache.getWithSWR(i,l,"reports_data"):l()):typeof AppCache<"u"&&AppCache?cachedData=await AppCache.getWithSWR(i,l,"reports_data"):cachedData=await l(),cachedRange={start:o,end:a},clearReportDerivedCache(),renderActiveReport()}catch(m){AppError.report(m,{context:"loadAndRenderReports"}),r&&(r.innerHTML=`<p class="error">${escapeHtml(m.message||"Failed to load data.")}</p>`)}}function normalizeReportsPayload(e){const s=[e.dsrError,e.stockError,e.expenseError,e.invoiceError,e.invoiceItemsError,e.categoriesError].filter(Boolean);if(s.length)throw s[0];return{dsrRows:e.dsrRows??[],stockRows:e.stockRows??[],expenseRows:e.expenseRows??[],invoices:e.invoices??[],invoiceItems:e.invoiceItems??[],vaultPurchases:e.vaultPurchases??[],categoryMap:buildExpenseCategoryMap(e.expenseCategories),receiptRows:e.receiptRows??[]}}async function fetchReportData(e,s){try{const t=()=>supabaseClient.functions.invoke("get-reports-data",{body:{startDate:e,endDate:s,receiptHistoryStart:PumpSettings.getReceiptHistoryStart()}}),{data:r,error:n}=typeof AppError<"u"&&AppError?.withRetry?await AppError.withRetry(t,{maxAttempts:3}):await t();if(n)throw n;return normalizeReportsPayload({dsrRows:r.dsrRows,receiptRows:r.receiptRows,stockRows:r.stockRows,expenseRows:r.expenseRows,invoices:r.invoices,invoiceItems:r.invoiceItems,vaultPurchases:r.vaultPurchases,expenseCategories:r.expenseCategories,dsrError:r.errors?.dsr?new Error(r.errors.dsr):null,stockError:r.errors?.stock?new Error(r.errors.stock):null,expenseError:r.errors?.expense?new Error(r.errors.expense):null,invoiceError:r.errors?.invoice?new Error(r.errors.invoice):null,invoiceItemsError:r.errors?.invoiceItems?new Error(r.errors.invoiceItems):null,categoriesError:r.errors?.categories?new Error(r.errors.categories):null})}catch{return fetchReportDataDirect(e,s)}}async function fetchReportDataDirect(e,s){const[t,r,n,o,a,i]=await Promise.all([DsrQueries.fetchDsrRows(e,s,{select:DsrQueries.DSR_SELECT_FULL}),supabaseClient.rpc("get_dsr_stock_range",{p_start:e,p_end:s}),DsrQueries.fetchExpenses(e,s,"date, category, amount, description"),supabaseClient.from("invoices").select("id, invoice_number, invoice_date, party_name, party_gstin, total_amount, cgst_total, sgst_total, igst_total, non_gst_total, nil_rate_total").gte("invoice_date",e).lte("invoice_date",s).order("invoice_date",{ascending:!0}),supabaseClient.from("expense_categories").select("name, label").order("sort_order"),supabaseClient.from("invoice_documents").select("id, invoice_date, vendor, amount, category, title, drive_web_view_link").eq("category","purchase").gte("invoice_date",e).lte("invoice_date",s)]),l=o.data??[];let m=[];if(l.length){const f=l.map(p=>p.id),y=80,c=[];for(let p=0;p<f.length;p+=y)c.push(f.slice(p,p+y));const u=await Promise.all(c.map(p=>supabaseClient.from("invoice_items").select("invoice_id, gst_percent, amount").in("invoice_id",p)));for(const p of u){if(p.error)throw p.error;p.data?.length&&m.push(...p.data)}}return normalizeReportsPayload({dsrRows:t.data,receiptRows:t.receiptRows,stockRows:r.data,expenseRows:n.data,invoices:l,invoiceItems:m,vaultPurchases:i.error?[]:i.data??[],expenseCategories:a.data,dsrError:t.error,stockError:r.error,expenseError:n.error,invoiceError:o.error,invoiceItemsError:null,categoriesError:a.error})}function classifyGstSlab(e){const s=Number(e);return s<0?"non_gst":s===0?"nil":s===5?"r5":s===12?"r12":s===18?"r18":s===24?"r24":s===28?"r28":"r18"}function slabHasActivity(e){return e?Math.abs(Number(e.taxable??0))>.005||Math.abs(Number(e.gross??0))>.005:!1}function sumInvoiceLineAmounts(e){let s=0,t=0,r=0;return e.forEach(n=>{const o=Number(n.amount??0),a=Number(n.gst_percent??0);a>0?s+=o/(1+a/100):a===0?r+=o:t+=o}),{taxable:s,nonGst:t,nilRate:r}}function invoiceHeaderTaxable(e){const s=Number(e.cgst_total??0),t=Number(e.sgst_total??0),r=Number(e.igst_total??0),n=Number(e.non_gst_total??0),o=Number(e.nil_rate_total??0),i=Number(e.total_amount??0)-s-t-r-n-o;if(Number.isFinite(i)&&i>=0)return i;const l=Number(e.subtotal??0)-Number(e.discount??0);return Number.isFinite(l)&&l>=0?l:0}function aggregateInvoiceGst(e,s){return aggregateInvoiceGstByPlace(e,s).combined}function aggregateInvoiceGstByPlace(e,s){const t=new Map;s.forEach(a=>{t.has(a.invoice_id)||t.set(a.invoice_id,[]),t.get(a.invoice_id).push(a)});const r=emptySlabTotals(),n=emptySlabTotals(),o=(a,i,{taxable:l=0,cgst:m=0,sgst:f=0,igst:y=0,gross:c=0})=>{a[i]&&(a[i].taxable+=l,a[i].cgst+=m,a[i].sgst+=f,a[i].igst+=y,a[i].gross+=c)};return e.forEach(a=>{const i=t.get(a.id)||[],l=Number(a.igst_total??0),m=Number(a.cgst_total??0),f=Number(a.sgst_total??0),y=l>0||m+f<=0&&isInterstatePartyGstin(a.party_gstin),c=y?n:r;if(i.length)i.forEach(u=>{const p=Number(u.amount??0),d=Number(u.gst_percent??0),b=classifyGstSlab(d);if(d>0){const g=p/(1+d/100),h=p-g;y?o(c,b,{taxable:g,igst:h,gross:p}):o(c,b,{taxable:g,cgst:h/2,sgst:h/2,gross:p})}else d===0?o(c,"nil",{taxable:p,gross:p}):o(c,"non_gst",{taxable:p,gross:p})});else{const u=Number(a.non_gst_total??0),p=Number(a.nil_rate_total??0),d=Number(a.total_amount??0),b=invoiceHeaderTaxable(a);if(m>0||f>0||l>0){const g=classifyGstSlab(18);y?o(c,g,{taxable:b,igst:l>0?l:m+f,gross:b+m+f+l}):o(c,g,{taxable:b,cgst:m,sgst:f,gross:b+m+f+l})}else p>0?o(c,"nil",{taxable:p,gross:p}):u>0?o(c,"non_gst",{taxable:u,gross:u}):d>0&&o(c,"non_gst",{taxable:d,gross:d})}}),{inside:r,outside:n,combined:mergeSlabTotals(r,n)}}function renderGstSummaryTable(e,s,t,r,n={}){const{sectionOnly:o=!1,sectionTitle:a=s,place:i="inside",showIgst:l=i==="outside"||i==="all"}=n,f=GST_SLABS.filter($=>slabHasActivity(e[$.key])).map($=>{const P=e[$.key]||emptySlabBucket(),w=P.cgst+P.sgst;return i==="outside"?`<tr>
      <td>${escapeHtml($.label)}</td>
      <td class="num">${formatNumberPlain(P.taxable)}</td>
      <td class="num">${formatNumberPlain(P.igst||0)}</td>
      <td class="num">${formatNumberPlain(P.gross)}</td>
    </tr>`:r?`<tr>
      <td>${escapeHtml($.label)}</td>
      <td class="num">${formatNumberPlain(P.taxable)}</td>
      <td class="num">${formatNumberPlain(w)}</td>
      <td class="num">${l?formatNumberPlain(P.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain(P.gross)}</td>
    </tr>`:`<tr>
      <td>${escapeHtml($.label)}</td>
      <td class="num">${formatNumberPlain(P.taxable)}</td>
      <td class="num">${formatNumberPlain(P.cgst)}</td>
      <td class="num">${formatNumberPlain(P.sgst)}</td>
      <td class="num">${l?formatNumberPlain(P.igst||0):"\u2014"}</td>
      <td class="num">${formatNumberPlain(P.gross)}</td>
    </tr>`}).join(""),y=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.taxable||0),0),c=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.cgst||0),0),u=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.sgst||0),0),p=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.igst||0),0),d=c+u,b=GST_SLABS.reduce(($,P)=>$+(e[P.key]?.gross||0),0);let g,h,N;i==="outside"?(g='<th>Slab</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">Total</th>',h=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(b)}</strong></td>`,N=4):r?(g=`<th>Slab</th><th class="num">Taxable</th><th class="num">VAT/LST</th><th class="num">${l?"IGST":"\u2014"}</th><th class="num">Total</th>`,h=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(d)}</strong></td>
          <td class="num"><strong>${l?formatNumberPlain(p):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(b)}</strong></td>`,N=5):(g=`<th>Slab</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">${l?"IGST":"\u2014"}</th><th class="num">Total</th>`,h=`<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(y)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
          <td class="num"><strong>${l?formatNumberPlain(p):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(b)}</strong></td>`,N=6);const S=i==="outside"?"Outside state (IGST)":i==="all"?r?"Combined inward supply":"Combined outward supply":r?"Inside state inward supply":"Inside state outward supply (CGST + SGST)",v=r?`${S} \xB7 ${escapeHtml(getPurchaseTaxPctLabel())} \xB7 ${isPurchaseTaxInclusive()?"tax-inclusive rate":"pre-tax rate (BPCL)"}`:S,T=o?`<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(a)}</h3>`:reportHeader(s,t.start,t.end),R=o?"</section>":"",L=r?`VAT/LST: <strong>${formatNumberPlain(d)}</strong>${l?` \xB7 IGST: <strong>${formatNumberPlain(p)}</strong>`:""}`:`CGST: <strong>${formatNumberPlain(c)}</strong> \xB7 SGST: <strong>${formatNumberPlain(u)}</strong>${l?` \xB7 IGST: <strong>${formatNumberPlain(p)}</strong>`:""}`;return`
    ${T}
    <p class="report-subtitle${o?" muted":""}">${v}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>${g}</tr>
      </thead>
      <tbody>${f||`<tr><td colspan="${N}" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          ${h}
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Taxable: <strong>${formatNumberPlain(y)}</strong> \xB7 ${L} \xB7 Gross: <strong>${formatNumberPlain(b)}</strong></p>${R}`}function slabTotalsHaveActivity(e){return GST_SLABS.some(s=>slabHasActivity(e[s.key]))}function renderFuelSalesMonthTable(e,s){const t=e.map(n=>`<tr class="${fuelRowClass(n.product)}">
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
    </section>`}function renderGstSalesSummary(e,s){const t=isBillingIncludedInGstReports(),r=buildFuelSalesMonthLines(e.dsrRows,s),n=fuelSalesToSlabTotals(r),o=t?aggregateInvoiceGst(e.invoices,e.invoiceItems):null,a=o?mergeSlabTotals(n,o):n,i=renderFuelSalesMonthTable(r,"Fuel sales \u2014 month-wise"),l=t?renderGstSummaryTable(o,"Billing \u2014 GST slab summary",s,!1,{sectionOnly:!0,sectionTitle:"Billing \u2014 GST slab summary"}):'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing \u2192 Include billing in GST sales reports).</p>',m=renderGstSummaryTable(a,"Combined outward supply \u2014 GST summary",s,!1,{sectionOnly:!0,sectionTitle:"Combined outward supply \u2014 GST summary"});return`
    ${reportHeader("Outward supply \u2014 GST summary",s.start,s.end)}
    ${i}
    ${l}
    ${m}`}function renderGstSalesDetail(e,s){const t=isBillingIncludedInGstReports(),r=buildFuelSalesDailyInvoices(e.dsrRows,s),n=r.map(u=>({sortDate:u.date,sortKey:`0-${u.invoiceNumber}`,html:`<tr class="${fuelRowClass(u.product)}">
        <td>${formatNumericDate(u.date)}</td>
        <td>Fuel \xB7 ${escapeHtml(u.productLabel)}</td>
        <td>${escapeHtml(u.invoiceNumber)} \xB7 ${escapeHtml(u.partyName)}</td>
        <td>\u2014</td>
        <td class="num">${formatNumberPlain(u.litres)}</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">\u2014</td>
        <td class="num">${formatNumberPlain(u.nilValue??u.gross)}</td>
        <td class="num">${formatNumberPlain(u.gross)}</td>
      </tr>`})),o=new Map;e.invoiceItems.forEach(u=>{o.has(u.invoice_id)||o.set(u.invoice_id,[]),o.get(u.invoice_id).push(u)});const a=t?e.invoices.map(u=>{const p=o.get(u.id)||[],d=Number(u.cgst_total??0),b=Number(u.sgst_total??0),g=Number(u.igst_total??0),h=d+b+g>0,N=(u.party_gstin||"").trim().toUpperCase()||"\u2014";let S=0,v=0,T=0;if(p.length){const R=sumInvoiceLineAmounts(p);S=R.taxable,v=R.nonGst,T=R.nilRate}else v=Number(u.non_gst_total??0),T=Number(u.nil_rate_total??0),S=invoiceHeaderTaxable(u);return{sortDate:u.invoice_date,sortKey:`1-${u.invoice_number}`,html:`<tr class="report-billing-row">
        <td>${formatNumericDate(u.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(u.invoice_number)} \xB7 ${escapeHtml(u.party_name)}</td>
        <td>${escapeHtml(N)}</td>
        <td class="num">\u2014</td>
        <td class="num">${h||S>0?formatNumberPlain(S):"\u2014"}</td>
        <td class="num">${formatNumberPlain(d)}</td>
        <td class="num">${formatNumberPlain(b)}</td>
        <td class="num">${formatNumberPlain(g)}</td>
        <td class="num">${formatNumberPlain(v+T)}</td>
        <td class="num">${formatNumberPlain(u.total_amount)}</td>
      </tr>`}}):[],i=[...n,...a].sort((u,p)=>u.sortDate.localeCompare(p.sortDate)||u.sortKey.localeCompare(p.sortKey)).map(u=>u.html).join(""),l=sumFuelSalesLines(r),m=r.length>0,f=t&&e.invoices.length>0,y=!m&&!f?`<tr><td colspan="11" class="muted">${t?"No fuel sales or billing in this period":"No fuel sales in this period"}</td></tr>`:"",c=t?"":'<p class="report-note muted">Billing invoices are excluded (enable in Settings \u2192 Billing).</p>';return`
    ${reportHeader("Outward supply \u2014 GST detail register",s.start,s.end)}
    <p class="report-subtitle muted">Fuel days as NIL invoices (SFC/####) \u2014 one voucher per tank sale day (MS, HSD). Value = net litres \xD7 that day&apos;s selling rate. Billing rows show party GSTIN and IGST when interstate.</p>
    ${c}
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
        ${i}
        ${y}
      </tbody>
      ${m?`<tfoot>
        <tr class="report-total-row">
          <td colspan="4"><strong>Fuel total (${r.length} SFC)</strong></td>
          <td class="num"><strong>${formatNumberPlain(l.litres)}</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>\u2014</strong></td>
          <td class="num"><strong>${formatNumberPlain(l.gross)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(l.gross)}</strong></td>
        </tr>
      </tfoot>`:""}
    </table>`}function collectFuelPurchaseLines(e,s,t){const r=c=>c.date>=s.start&&c.date<=s.end,n=t??createBuyingRateContext(e.receiptRows??[]).getStored,o=e.vaultPurchases??[],a=new Map(o.map(c=>[c.id,c])),i=new Map;o.forEach(c=>{const u=String(c.title||"").trim().toLowerCase();u&&!i.has(u)&&i.set(u,c)});const l=[],m=new Set,f=c=>{if(c.invoiceDocumentId&&a.has(c.invoiceDocumentId))return a.get(c.invoiceDocumentId);const u=String(c.supplierInvoiceNo||"").trim().toLowerCase();return u?i.has(u)?i.get(u):o.find(p=>String(p.title||"").toLowerCase().includes(u))||null:null},y=(c,u,p,d,b={})=>{const g=Number(p),h=Number(d);if(!Number.isFinite(g)||g<=0||!Number.isFinite(h)||h<=0)return;const N=`${c}-${normalizeProduct(u)}`;if(m.has(N))return;m.add(N);const S=f(b);l.push({date:c,product:u,litres:g,rate:h,supplierInvoiceNo:b.supplierInvoiceNo||S?.title||"",supplierGstin:b.supplierGstin||"",invoiceDocumentId:b.invoiceDocumentId||S?.id||null,driveWebViewLink:S?.drive_web_view_link||null})};return(e.receiptRows??[]).filter(r).forEach(c=>{y(c.date,c.product,Number(c.receipts??0),Number(c.buying_price_per_litre),{supplierInvoiceNo:c.supplier_invoice_no,supplierGstin:c.supplier_gstin,invoiceDocumentId:c.invoice_document_id})}),(e.dsrRows??[]).filter(r).forEach(c=>{const u=Number(c.receipts??0);if(u<=0)return;const p=Number(c.buying_price_per_litre);!Number.isFinite(p)||p<=0||y(c.date,c.product,u,p,{supplierInvoiceNo:c.supplier_invoice_no,supplierGstin:c.supplier_gstin,invoiceDocumentId:c.invoice_document_id})}),l.sort((c,u)=>c.date.localeCompare(u.date)||normalizeProduct(c.product).localeCompare(normalizeProduct(u.product)))}function countReceiptsMissingBuying(e,s){const t=r=>r.date>=s.start&&r.date<=s.end;return(e.dsrRows??[]).filter(r=>{if(!t(r)||Number(r.receipts??0)<=0)return!1;const n=Number(r.buying_price_per_litre);return!Number.isFinite(n)||n<=0}).length}function buildFuelPurchaseRows(e,s){const t=createBuyingRateContext(e.receiptRows??[]).getStored,r=collectFuelPurchaseLines(e,s,t),n=countReceiptsMissingBuying(e,s),o=emptySlabTotals(),a=emptySlabTotals();return{detailRows:r.map(({date:l,product:m,litres:f,rate:y,supplierInvoiceNo:c,supplierGstin:u,invoiceDocumentId:p,driveWebViewLink:d})=>{const b=getPurchaseTaxPct(m),g=classifyGstSlab(b),{taxable:h,tax:N,gross:S,cgst:v,sgst:T}=calcPurchaseLineTax(f,y,b),R=resolveSupplierGstin(u),L=isInterstatePartyGstin(R),$=L?a:o;return $[g]&&($[g].taxable+=h,L?$[g].igst+=N:($[g].cgst+=v,$[g].sgst+=T),$[g].gross+=S),{date:l,product:m,litres:f,rate:y,taxPct:b,taxable:h,tax:N,gross:S,cgst:L?0:v,sgst:L?0:T,igst:L?N:0,interstate:L,supplierInvoiceNo:c||"",supplierGstin:R,invoiceDocumentId:p||null,driveWebViewLink:d||null}}),insideSlabs:o,outsideSlabs:a,slabTotals:mergeSlabTotals(o,a),missingBuyingCount:n}}function renderGstPurchaseSummary(e,s){const{insideSlabs:t,outsideSlabs:r,slabTotals:n,detailRows:o,missingBuyingCount:a}=getFuelPurchaseRows(e,s),i=a>0?`<p class="report-note warning">${a} receipt(s) in this period have no buying price \u2014 excluded. Enter buying price on Meter Reading \u2192 Purchase cost.</p>`:"",l=o.length===0?'<p class="report-note muted">No fuel receipts with buying price in this period.</p>':"",m=renderGstSummaryTable(t,"Inside state",s,!0,{sectionOnly:!0,sectionTitle:"Inside state inward supply",place:"inside",showIgst:!1}),f=slabTotalsHaveActivity(r)?renderGstSummaryTable(r,"Outside state",s,!0,{sectionOnly:!0,sectionTitle:"Outside state inward supply",place:"outside",showIgst:!0}):'<section class="report-gst-section"><h3 class="report-section-title">Outside state inward supply</h3><p class="muted">No interstate inward supply in this period (supplier GSTIN state matches station, or GSTIN blank).</p></section>',y=renderGstSummaryTable(n,"Combined",s,!0,{sectionOnly:!0,sectionTitle:"Total inward supply summary",place:"all",showIgst:!0});return`
    ${reportHeader("Inward supply \u2014 GST summary (Fuel receipts)",s.start,s.end)}
    ${l}
    ${m}
    ${f}
    ${y}
    ${i}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())} Place of supply uses supplier GSTIN vs station GSTIN.</p>`}function renderGstPurchaseDetail(e,s){const{detailRows:t,missingBuyingCount:r}=getFuelPurchaseRows(e,s),n=t.map(o=>{const a=normalizeProduct(o.product),i=a==="petrol"?"MS":a==="diesel"?"HSD":String(o.product).toUpperCase(),l=o.supplierInvoiceNo?escapeHtml(o.supplierInvoiceNo):"\u2014",m=o.supplierGstin?escapeHtml(o.supplierGstin):"\u2014",f=o.driveWebViewLink?`<a href="${escapeHtml(o.driveWebViewLink)}" target="_blank" rel="noopener">View PDF</a>`:o.invoiceDocumentId?"Linked":"\u2014";return`<tr class="${fuelRowClass(a)}">
      <td>${formatNumericDate(o.date)}</td>
      <td>${formatFuelBadge(i)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td>${l}</td>
      <td>${m}</td>
      <td class="num">${f}</td>
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
    <p class="report-note muted">Vault PDF links match DSR receipt \u2192 Invoices (purchase) by document id or invoice title. Enter invoice no with buying price on Meter Reading \u2192 Purchase cost. ${escapeHtml(getPurchaseGstDetailNote())}</p>`}function computeTradingAndPl(e,s){const t=createBuyingRateContext(e.receiptRows),r=DsrQueries.mergeDsrStock(e.dsrRows,e.stockRows),n={petrol:{label:"Petrol (MS)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},diesel:{label:"Diesel (HSD)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},lube:{label:"Lubricant / Billing",sales:0,purchase:0,openingStockVal:0,closingStockVal:0}},o={petrol:{first:null,last:null},diesel:{first:null,last:null}};r.forEach(d=>{const b=normalizeProduct(d.product);if(!n[b])return;const g=getDsrNetSaleLitres(d),h=getDsrSaleRate(d),N=Number(d.receipts??0);if(N>0){const S=getEffectiveBuyingRate(d,t);S!=null&&(n[b].purchase+=N*S)}n[b].sales+=g*h,o[b]&&(o[b].first||(o[b].first=d),o[b].last=d)}),["petrol","diesel"].forEach(d=>{const b=o[d].first,g=o[d].last;if(!b||!g)return;n[d].openingL=Number(b.opening_stock??0),n[d].closingL=Number(g.dip_stock??g.stock??0);const h=getLandedBuyingRateForDate(d,b.date,t)??0,N=getLandedBuyingRateForDate(d,g.date,t)??h;n[d].openingStockVal=n[d].openingL*h,n[d].closingStockVal=n[d].closingL*N}),n.lube.sales=e.invoices.reduce((d,b)=>d+Number(b.total_amount??0),0);const a=(e.vaultPurchases??[]).reduce((d,b)=>{const g=Number(b.amount??0);return g>0?d+g:d},0);n.lube.purchase=a;const i=Object.values(n).reduce((d,b)=>d+b.sales,0),l=Object.values(n).reduce((d,b)=>d+b.purchase,0),m=Object.values(n).reduce((d,b)=>d+b.openingStockVal,0),f=Object.values(n).reduce((d,b)=>d+b.closingStockVal,0),y=i+f-m-l,c=computeProfitLossSummary({dsrRows:r,receiptRows:e.receiptRows,expenseRows:e.expenseRows,lubeSales:n.lube.sales,lubeCogs:a,requireAllBuying:!0,buyingContext:t,categoryMap:e.categoryMap}),u=new Map,p=new Map;return e.expenseRows.forEach(d=>{const b=d.category||"misc",g=getExpenseCategoryLabel(d,e.categoryMap),h=Number(d.amount??0),N=isTestingExpenseRow(d,e.categoryMap)?p:u;N.has(b)||N.set(b,{label:g,amount:0}),N.get(b).amount+=h}),{products:n,grossSales:i,totalPurchase:l,openingStock:m,closingStock:f,grossIncome:y,vaultPurchaseTotal:a,fuelGrossProfit:c.canCalculate?c.fuelGrossProfit??0:null,lubeGrossProfit:c.canCalculate?c.lubeGrossProfit??0:null,lubeCogs:a,grossProfit:c.canCalculate?c.grossProfit??0:null,expensesByCategory:u,testingExpensesByCategory:p,totalExpenses:c.totalExpenses,testingExpenses:c.testingExpenses,netProfit:c.canCalculate?c.netProfit:null,canCalculate:c.canCalculate,missingBuyingPrice:c.missingBuyingPrice,unresolvedBuying:c.unresolvedBuying,usingProvisionalBuying:c.usingProvisionalBuying}}function renderProfitGuide(e){return e==="trading"?`
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
    </aside>`}function renderTradingAccount(e,s){const t=getTradingAndPl(e,s),r=[["Sales \u2014 Petrol (MS)",t.products.petrol.sales,"petrol"],["Sales \u2014 Diesel (HSD)",t.products.diesel.sales,"diesel"],["Sales \u2014 Lube / Billing",t.products.lube.sales,null],["Closing stock \u2014 Petrol",t.products.petrol.closingStockVal,"petrol"],["Closing stock \u2014 Diesel",t.products.diesel.closingStockVal,"diesel"]],n=[["Opening stock \u2014 Petrol",t.products.petrol.openingStockVal,"petrol"],["Opening stock \u2014 Diesel",t.products.diesel.openingStockVal,"diesel"],["Purchases \u2014 Petrol",t.products.petrol.purchase,"petrol"],["Purchases \u2014 Diesel",t.products.diesel.purchase,"diesel"]];t.vaultPurchaseTotal>0&&n.push(["Purchases \u2014 Lube / other (vault)",t.vaultPurchaseTotal,null]),n.push(["Gross income c/d",t.grossIncome,null]);const o=(m,f)=>{const y=f.map(([u,p,d])=>`<tr class="${fuelRowClass(d)}"><td>${escapeHtml(u)}</td><td class="num">${formatNumberPlain(p)}</td></tr>`).join(""),c=f.reduce((u,[,p])=>u+Number(p),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(m)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${y}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(c)}</strong></td></tr></tfoot>
        </table>
      </div>`},a=t.usingProvisionalBuying&&t.missingBuyingPrice?.length?`<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) use the previous buying rate for stock/purchases \u2014 enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on Meter Reading \u2192 Purchase cost to lock the correct rate.</p>`:t.canCalculate?"":formatUnresolvedBuyingWarning(t),i=t.fuelGrossProfit!=null?`<p class="report-note muted">Dealer Margin (ops check, not a trading credit) = net litres \xD7 (selling \u2212 landed buying): <strong>${formatCurrency(t.fuelGrossProfit)}</strong> \u2014 same as Dashboard / P&amp;L fuel gross.</p>`:"",l=t.vaultPurchaseTotal>0?'<p class="report-note muted">Lube / other purchases = sum of vault <strong>Purchase invoice</strong> amounts in this period (Invoices page). Fuel inward remains on MS/HSD purchase lines from DSR.</p>':'<p class="report-note muted">No vault purchase amounts in this period \u2014 lube stock/COGS is not tracked separately. Add purchase PDFs with amounts on Invoices to populate Lube purchases.</p>';return`
    ${reportHeader("Trading account",s.start,s.end)}
    ${renderProfitGuide("trading")}
    <div class="report-pl-grid report-trading-grid">
      ${o("Debit",n)}
      ${o("Credit",r)}
    </div>
    <p class="report-note muted">Debit and credit totals match via Gross income c/d (stock-based: Sales + Closing \u2212 Opening \u2212 Purchases). This is not Nett Profit.</p>
    ${a}
    ${i}
    ${l}
    <p class="report-summary-line">Gross income c/d: <strong>${formatCurrency(t.grossIncome)}</strong> <span class="muted">(trading balance \u2014 see P&amp;L for real profit)</span></p>`}function formatUnresolvedBuyingWarning(e){const s=escapeHtml(getBuyingPriceUnitLabel()),t=e.unresolvedBuying?.length??0,r=e.missingBuyingPrice?.length??0;if(!e.canCalculate){const n=t>0?`${t} sale/receipt day(s) have no resolvable buying rate (no prior receipt rate in history)`:"Some days have no resolvable buying rate",o=r>0?` (${r} receipt day(s) also have no entered \u20B9/KL yet)`:"";return`<p class="report-note warning">${n}${o}. Enter pre-VAT ${s} on Meter Reading \u2192 Purchase cost before net profit can be calculated.</p>`}return e.usingProvisionalBuying&&r>0?`<p class="report-note warning">${r} receipt day(s) still need an entered buying price \u2014 figures below use the previous receipt rate until you save ${s} on Meter Reading \u2192 Purchase cost.</p>`:""}function renderProfitLoss(e,s){const t=getTradingAndPl(e,s),r=Array.from(t.expensesByCategory.values()).sort((p,d)=>p.label.localeCompare(d.label)),n=Array.from(t.testingExpensesByCategory.values()).sort((p,d)=>p.label.localeCompare(d.label)),o=formatUnresolvedBuyingWarning(t),a=Number(t.totalExpenses??0),i=n.length?`<p class="report-note muted">Testing expenses excluded from net profit (day closing): ${n.map(p=>`${escapeHtml(p.label)} \u20B9${formatNumberPlain(p.amount)}`).join("; ")}.</p>`:"";if(!t.canCalculate){const p=r.length>0?`<table class="report-table">
            <thead><tr><th>Expense head</th><th class="num">Amount (\u20B9)</th></tr></thead>
            <tbody>${r.map(d=>`<tr><td>${escapeHtml(d.label)}</td><td class="num">${formatNumberPlain(d.amount)}</td></tr>`).join("")}</tbody>
            <tfoot><tr class="report-total-row"><td><strong>Total (excl. testing)</strong></td><td class="num"><strong>${formatNumberPlain(a)}</strong></td></tr></tfoot>
          </table>`:'<p class="muted">No operating expenses in this period.</p>';return`
      ${reportHeader("Profit & loss account",s.start,s.end)}
      ${o}
      <p class="report-summary-line">Gross profit: <strong>\u2014</strong> \xB7 Expenses: <strong>${formatCurrency(a)}</strong> \xB7 Nett profit: <strong>\u2014</strong></p>
      <h3>Operating expenses</h3>
      ${p}
      ${i}
      <p class="report-note muted">Books debit/credit layout is hidden until every sale/receipt day can resolve a buying rate (entered or prior receipt).</p>`}const l=Number(t.grossProfit??0),m=Number(t.netProfit??0),f=[["Gross Profit",l]],y=r.map(p=>[p.label,p.amount]);y.push(["Nett Profit",m]);const c=(p,d,{boldLast:b=!1}={})=>{const g=d.map(([N,S],v)=>{const T=b&&v===d.length-1,R=T?' class="report-total-row"':"",L=T?`<strong>${escapeHtml(N)}</strong>`:escapeHtml(N),$=T?`<strong>${formatNumberPlain(S)}</strong>`:formatNumberPlain(S);return`<tr${R}><td>${L}</td><td class="num">${$}</td></tr>`}).join(""),h=d.reduce((N,[,S])=>N+Number(S),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(p)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${g||'<tr><td colspan="2" class="muted">No entries</td></tr>'}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(h)}</strong></td></tr></tfoot>
        </table>
      </div>`},u=`<p class="report-note muted">Gross profit = fuel gross <strong>${formatCurrency(t.fuelGrossProfit)}</strong>${t.lubeCogs>0||t.products.lube.sales>0?` + lube gross <strong>${formatCurrency(t.lubeGrossProfit)}</strong> (sales \u2212 vault purchases)`:""}. Same formula as Analysis and the Dashboard Net profit glance.</p>`;return`
    ${reportHeader("Profit & loss account",s.start,s.end)}
    ${renderProfitGuide("pl")}
    ${o}
    <div class="report-pl-grid report-trading-grid">
      ${c("Debit (indirect expenses)",y,{boldLast:!0})}
      ${c("Credit",f,{boldLast:!0})}
    </div>
    <p class="report-summary-line">Gross profit: <strong>${formatCurrency(l)}</strong> \xB7 Expenses: <strong>${formatCurrency(a)}</strong> \xB7 Nett profit (real profit): <strong>${formatCurrency(m)}</strong></p>
    ${i}
    ${u}`}function buildGstr1Sections(e,s){const t=isBillingIncludedInGstReports(),n=buildFuelSalesDailyInvoices(e.dsrRows,s).map(l=>({date:l.date,invoiceNumber:l.invoiceNumber,party:l.partyName,gstin:"",taxable:0,cgst:0,sgst:0,igst:0,nilValue:Number(l.nilValue??l.gross??0),gross:Number(l.gross??0),product:l.productLabel})),o=[],a=[];t&&e.invoices.forEach(l=>{const m=(l.party_gstin||"").trim().toUpperCase(),f=Number(l.cgst_total??0),y=Number(l.sgst_total??0),c=Number(l.igst_total??0),u=Number(l.non_gst_total??0),p=Number(l.nil_rate_total??0),d=invoiceHeaderTaxable(l),b={date:l.invoice_date,invoiceNumber:l.invoice_number,party:l.party_name,gstin:m,taxable:d,cgst:f,sgst:y,igst:c,nilValue:u+p,gross:Number(l.total_amount??0)};m.length>=15?o.push(b):a.push(b)});const i=(l,m)=>l.reduce((f,y)=>(m.forEach(c=>{f[c]=(f[c]||0)+Number(y[c]||0)}),f),{});return{includeBilling:t,nilRows:n,b2b:o,b2cs:a,nilTotals:i(n,["nilValue","gross"]),b2bTotals:i(o,["taxable","cgst","sgst","igst","gross"]),b2csTotals:i(a,["taxable","cgst","sgst","igst","nilValue","gross"])}}let reportDerivedCache={dataRef:null,rangeKey:"",gstr1:null,purchases:null,gstr3b:null,tradingPl:null};function clearReportDerivedCache(){reportDerivedCache={dataRef:null,rangeKey:"",gstr1:null,purchases:null,gstr3b:null,tradingPl:null}}function reportDerivedSlot(e,s){const t=`${s?.start||""}|${s?.end||""}`;return(reportDerivedCache.dataRef!==e||reportDerivedCache.rangeKey!==t)&&(clearReportDerivedCache(),reportDerivedCache.dataRef=e,reportDerivedCache.rangeKey=t),reportDerivedCache}function getGstr1Sections(e,s){const t=reportDerivedSlot(e,s);return t.gstr1||(t.gstr1=buildGstr1Sections(e,s)),t.gstr1}function getFuelPurchaseRows(e,s){const t=reportDerivedSlot(e,s);return t.purchases||(t.purchases=buildFuelPurchaseRows(e,s)),t.purchases}function getGstr3bSummary(e,s){const t=reportDerivedSlot(e,s);return t.gstr3b||(t.gstr3b=buildGstr3bSummary(e,s)),t.gstr3b}function getTradingAndPl(e,s){const t=reportDerivedSlot(e,s);return t.tradingPl||(t.tradingPl=computeTradingAndPl(e,s)),t.tradingPl}function renderGstr1Table(e,s,t,r,n){return`
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(e)}</h3>
      <p class="report-subtitle muted">${s}</p>
      <table class="report-table report-gst-detail">
        <thead><tr>${t}</tr></thead>
        <tbody>${r}</tbody>
        ${n||""}
      </table>
    </section>`}function renderGstr1Register(e,s){const t=getGstr1Sections(e,s),r=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL section still included.</p>',n=t.nilRows.map(m=>{const f=String(m.product||"").toLowerCase().includes("diesel")?"diesel":"petrol";return`<tr class="${fuelRowClass(f)}">
      <td>${formatNumericDate(m.date)}</td>
      <td>${escapeHtml(m.invoiceNumber)}</td>
      <td>${escapeHtml(m.product||"Fuel")}</td>
      <td class="num">${formatNumberPlain(m.nilValue)}</td>
      <td class="num">${formatNumberPlain(m.gross)}</td>
    </tr>`}).join("")||'<tr><td colspan="5" class="muted">No fuel sales in this period</td></tr>',o=t.nilRows.length?`<tfoot><tr class="report-total-row">
        <td colspan="3"><strong>NIL total (${t.nilRows.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(t.nilTotals.nilValue)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(t.nilTotals.gross)}</strong></td>
      </tr></tfoot>`:"",a=`
    <th>Date</th><th>Invoice</th><th>Party</th><th>GSTIN</th>
    <th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th>
    <th class="num">IGST</th><th class="num">Exempt/NIL</th><th class="num">Gross</th>`,i=m=>m.map(f=>`<tr>
      <td>${formatNumericDate(f.date)}</td>
      <td>${escapeHtml(f.invoiceNumber)}</td>
      <td>${escapeHtml(f.party)}</td>
      <td>${escapeHtml(f.gstin||"\u2014")}</td>
      <td class="num">${formatNumberPlain(f.taxable)}</td>
      <td class="num">${formatNumberPlain(f.cgst)}</td>
      <td class="num">${formatNumberPlain(f.sgst)}</td>
      <td class="num">${formatNumberPlain(f.igst)}</td>
      <td class="num">${formatNumberPlain(f.nilValue)}</td>
      <td class="num">${formatNumberPlain(f.gross)}</td>
    </tr>`).join("")||'<tr><td colspan="10" class="muted">No invoices in this section</td></tr>',l=(m,f)=>m.length?`<tfoot><tr class="report-total-row">
        <td colspan="4"><strong>Total (${m.length})</strong></td>
        <td class="num"><strong>${formatNumberPlain(f.taxable)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(f.cgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(f.sgst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(f.igst)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(f.nilValue||0)}</strong></td>
        <td class="num"><strong>${formatNumberPlain(f.gross)}</strong></td>
      </tr></tfoot>`:"";return`
    ${reportHeader("GSTR-1 style outward register",s.start,s.end)}
    <p class="report-subtitle muted">Internal aid for GSTR-1 \u2014 not a GST portal JSON upload. Sections mirror B2B, B2CS and NIL rated fuel (SFC).</p>
    ${r}
    ${renderGstr1Table("4A/4B \u2014 B2B (registered party GSTIN)","Billing invoices with a 15-character party GSTIN.",a,i(t.b2b),l(t.b2b,t.b2bTotals))}
    ${renderGstr1Table("7 \u2014 B2CS (unregistered / Cash)","Billing invoices without a party GSTIN.",a,i(t.b2cs),l(t.b2cs,t.b2csTotals))}
    ${renderGstr1Table("8 \u2014 NIL rated (fuel SFC)","Daily fuel outward vouchers from DSR (NIL rate).",'<th>Date</th><th>Invoice</th><th>Product</th><th class="num">NIL value</th><th class="num">Gross</th>',n,o)}
    <p class="report-note muted">Use <strong>Download CSV</strong> for a flat file you can reconcile in Excel. Portal filing still requires the official GST offline tool / API.</p>`}function buildGstr1Csv(e,s){const t=getGstr1Sections(e,s),r=[["section","date","invoice","party","gstin","product","taxable","cgst","sgst","igst","nil_value","gross"].join(",")],n=a=>{const i=String(a??"");return/[",\n]/.test(i)?`"${i.replace(/"/g,'""')}"`:i},o=(a,i)=>{r.push([a,i.date,i.invoiceNumber,i.party||"",i.gstin||"",i.product||"",i.taxable??"",i.cgst??"",i.sgst??"",i.igst??"",i.nilValue??"",i.gross??""].map(n).join(","))};return t.b2b.forEach(a=>o("B2B",a)),t.b2cs.forEach(a=>o("B2CS",a)),t.nilRows.forEach(a=>o("NIL",a)),r.join(`
`)}function downloadGstr1Csv(){if(!cachedData||!cachedRange)return;const e=buildGstr1Csv(cachedData,cachedRange),s=new Blob([e],{type:"text/csv;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr1-register_${n}_${o}.csv`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function formatGstr1PortalDate(e){if(!e||String(e).length<10)return"";const[s,t,r]=String(e).slice(0,10).split("-");return`${r}-${t}-${s}`}function gstr1FilingPeriod(e){const s=String(e?.end||"").slice(0,10);if(s.length<7)return"";const[t,r]=s.split("-");return`${r}${t}`}function gstr1StateCodeFromGstin(e){const s=String(e||"").trim().toUpperCase();return s.length>=2?s.slice(0,2):""}function gstr1InvoiceRate(e){const s=Number(e.taxable||0);if(s<=0)return 0;const r=(Number(e.cgst||0)+Number(e.sgst||0)+Number(e.igst||0))/s*100;return r<3?0:r<8?5:r<15?12:r<21?18:r<26?24:28}function buildGstr1Json(e,s){const t=getGstr1Sections(e,s),r=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),n=gstr1StateCodeFromGstin(r)||"21",o=gstr1FilingPeriod(s),a=new Map;t.b2b.forEach(g=>{const h=String(g.gstin||"").trim().toUpperCase();a.has(h)||a.set(h,[]);const N=gstr1InvoiceRate(g),S={txval:Number(Number(g.taxable||0).toFixed(2)),rt:N};Number(g.igst||0)>0?S.iamt=Number(Number(g.igst).toFixed(2)):(S.camt=Number(Number(g.cgst||0).toFixed(2)),S.samt=Number(Number(g.sgst||0).toFixed(2))),a.get(h).push({inum:g.invoiceNumber,idt:formatGstr1PortalDate(g.date),val:Number(Number(g.gross||0).toFixed(2)),pos:gstr1StateCodeFromGstin(h)||n,rchrg:"N",inv_typ:"R",itms:[{num:1,itm_det:S}]})});const i=Array.from(a.entries()).map(([g,h])=>({ctin:g,inv:h})),l=new Map;t.b2cs.forEach(g=>{const h=gstr1InvoiceRate(g),N=Number(g.igst||0)>0,S=`${N?"INTER":"INTRA"}|${n}|${h}`;l.has(S)||l.set(S,{sply_ty:N?"INTER":"INTRA",pos:n,typ:"OE",txval:0,rt:h,iamt:0,camt:0,samt:0,csamt:0});const v=l.get(S);v.txval+=Number(g.taxable||0),v.iamt+=Number(g.igst||0),v.camt+=Number(g.cgst||0),v.samt+=Number(g.sgst||0)});const m=Array.from(l.values()).map(g=>({...g,txval:Number(g.txval.toFixed(2)),iamt:Number(g.iamt.toFixed(2)),camt:Number(g.camt.toFixed(2)),samt:Number(g.samt.toFixed(2))})),y={inv:[{sply_ty:"INTRB2C",expt_amt:0,nil_amt:Number((t.nilTotals.nilValue||0).toFixed(2)),ngsup_amt:0}]},c=(g,h)=>{if(!g.length)return null;const N=g.map(S=>String(S.invoiceNumber||"")).filter(Boolean).sort();return{doc_num:h,docs:[{num:1,from:N[0],to:N[N.length-1],totnum:N.length,cancel:0,net_issue:N.length}]}},u=[],p=[...t.b2b,...t.b2cs],d=c(p,1);d&&u.push(d);const b=c(t.nilRows,4);return b&&u.push(b),{gstin:r||null,fp:o,version:"GST3.1.6",hash:"hash",b2b:i,b2cs:m,nil:y,doc_issue:{doc_det:u},_meta:{note:"Internal aid for GSTR-1 filing tools. Verify every figure before portal upload.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),fuelNilCount:t.nilRows.length,b2bCount:t.b2b.length,b2csCount:t.b2cs.length}}}function downloadGstr1Json(){if(!cachedData||!cachedRange)return;const e=buildGstr1Json(cachedData,cachedRange),s=new Blob([JSON.stringify(e,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr1_${e.fp||`${n}_${o}`}.json`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function gstrMoney(e){return Number(Number(e||0).toFixed(2))}function gstrTaxBucket(e=0,s=0,t=0,r=0,n=0){return{txval:gstrMoney(e),iamt:gstrMoney(s),camt:gstrMoney(t),samt:gstrMoney(r),csamt:gstrMoney(n)}}function buildGstr3bSummary(e,s){const t=getGstr1Sections(e,s),r=getFuelPurchaseRows(e,s);let n=0,o=0;t.includeBilling&&(e.invoices||[]).forEach(h=>{n+=Number(h.nil_rate_total??0),o+=Number(h.non_gst_total??0)});const a=gstrTaxBucket((t.b2bTotals.taxable||0)+(t.b2csTotals.taxable||0),(t.b2bTotals.igst||0)+(t.b2csTotals.igst||0),(t.b2bTotals.cgst||0)+(t.b2csTotals.cgst||0),(t.b2bTotals.sgst||0)+(t.b2csTotals.sgst||0),0),i={txval:gstrMoney((t.nilTotals.nilValue||0)+n)},l={txval:gstrMoney(o)},m=gstrTaxBucket(0,0,0,0,0),f=gstrTaxBucket(0,0,0,0,0);let y=0,c=0;t.b2cs.forEach(h=>{const N=Number(h.igst||0);N<=0||(y+=Number(h.taxable||0),c+=N)});let u=0,p=0,d=0;(r.detailRows||[]).forEach(h=>{u+=Number(h.igst||0),p+=Number(h.cgst||0),d+=Number(h.sgst||0)});const b={ty:"OTH",iamt:gstrMoney(u),camt:gstrMoney(p),samt:gstrMoney(d),csamt:0},g={iamt:0,camt:0,samt:0,csamt:0};return{includeBilling:t.includeBilling,retPeriod:gstr1FilingPeriod(s),osupDet:a,osupZero:m,osupNil:i,osupNongst:l,isupRev:f,interUnregTaxable:gstrMoney(y),interUnregIgst:gstrMoney(c),itcOth:b,itcNet:{iamt:b.iamt,camt:b.camt,samt:b.samt,csamt:0},itcZero:g,purchaseMissingBuying:r.missingBuyingCount||0,purchaseLineCount:(r.detailRows||[]).length,g1:t}}function renderGstr3bRegister(e,s){const t=getGstr3bSummary(e,s),r=t.includeBilling?"":'<p class="report-note muted">Billing invoices excluded (enable in Settings \u2192 Billing). Fuel NIL still included in 3.1(c).</p>',n=t.purchaseMissingBuying>0?`<p class="report-note warning">${t.purchaseMissingBuying} fuel receipt(s) missing buying price \u2014 excluded from Table 4 ITC.</p>`:"",o=(i,l,m,f=!0)=>f?`<tr>
        <td>${escapeHtml(i)}</td>
        <td>${escapeHtml(l)}</td>
        <td class="num">${formatNumberPlain(m.txval)}</td>
        <td class="num">${formatNumberPlain(m.iamt)}</td>
        <td class="num">${formatNumberPlain(m.camt)}</td>
        <td class="num">${formatNumberPlain(m.samt)}</td>
        <td class="num">${formatNumberPlain(m.csamt||0)}</td>
      </tr>`:`<tr>
      <td>${escapeHtml(i)}</td>
      <td>${escapeHtml(l)}</td>
      <td class="num">${formatNumberPlain(m.txval)}</td>
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
    <p class="report-note muted">Use <strong>Download GSTR-3B JSON</strong> for an offline-utility-style summary file. Verify every figure before portal upload.</p>`}function buildGstr3bJson(e,s){const t=getGstr3bSummary(e,s),r=(PumpSettings.getStationGstin?.()||PumpSettings.getCachedSync().station?.gstin||"").trim().toUpperCase(),n=o=>({ty:o,...t.itcZero});return{gstin:r||null,ret_period:t.retPeriod,sup_details:{osup_det:t.osupDet,osup_zero:{txval:t.osupZero.txval,iamt:t.osupZero.iamt,csamt:t.osupZero.csamt},osup_nil_exmp:t.osupNil,isup_rev:t.isupRev,osup_nongst:t.osupNongst},inter_sup:{unreg_details:[],comp_details:[],uin_details:[]},eco_dtls:{eco_sup:gstrTaxBucket(0),eco_reg_sup:{txval:0}},itc_elg:{itc_avl:[n("IMPG"),n("IMPS"),n("ISRC"),n("ISD"),{...t.itcOth}],itc_rev:[n("RUL"),n("OTH")],itc_net:t.itcNet,itc_inelg:[n("RUL"),n("OTH")]},inward_sup:{isup_details:[{ty:"GST",inter:0,intra:0},{ty:"NONGST",inter:0,intra:0}]},intr_ltfee:{intr_details:{iamt:0,camt:0,samt:0,csamt:0},ltfee_details:{camt:0,samt:0}},_meta:{note:"Internal aid for GSTR-3B filing tools. Verify every figure before portal upload. Table 3.2 POS omitted when unknown.",range:{start:s.start,end:s.end},generatedAt:new Date().toISOString(),interUnregTaxable:t.interUnregTaxable,interUnregIgst:t.interUnregIgst,purchaseLineCount:t.purchaseLineCount,purchaseMissingBuying:t.purchaseMissingBuying,includeBilling:t.includeBilling}}}function downloadGstr3bJson(){if(!cachedData||!cachedRange)return;const e=buildGstr3bJson(cachedData,cachedRange),s=new Blob([JSON.stringify(e,null,2)],{type:"application/json;charset=utf-8"}),t=URL.createObjectURL(s),r=document.createElement("a"),n=cachedRange.start.replace(/-/g,""),o=cachedRange.end.replace(/-/g,"");r.href=t,r.download=`gstr3b_${e.ret_period||`${n}_${o}`}.json`,document.body.appendChild(r),r.click(),r.remove(),URL.revokeObjectURL(t)}function updateReportsCsvButtonVisibility(){const e=document.getElementById("reports-csv-btn"),s=document.getElementById("reports-json-btn"),t=!!(cachedData&&cachedRange),r=activeReport==="gstr1"&&t,n=(activeReport==="gstr1"||activeReport==="gstr3b")&&t;e&&(e.classList.toggle("hidden",!r),e.disabled=!r),s&&(s.classList.toggle("hidden",!n),s.disabled=!n,s.textContent=activeReport==="gstr3b"?"Download GSTR-3B JSON":"Download GSTR-1 JSON")}function renderReportHtml(e,s,t){switch(e){case"gst-sales-summary":return renderGstSalesSummary(s,t);case"gst-sales-detail":return renderGstSalesDetail(s,t);case"gst-purchase-summary":return renderGstPurchaseSummary(s,t);case"gst-purchase-detail":return renderGstPurchaseDetail(s,t);case"trading":return renderTradingAccount(s,t);case"pl":return renderProfitLoss(s,t);case"gstr1":return renderGstr1Register(s,t);case"gstr3b":return renderGstr3bRegister(s,t);case"fuel-income":return renderFuelIncome(s,t);case"dsr":default:return renderTankWiseDsr(s,t)}}function sanitizeReportHtmlForPrint(e){return PrintUtils.applyPrintLogos(e).replace(/<a\b[^>]*>/gi,"").replace(/<\/a>/gi,"")}function buildPrintSheetWrapped(e,s,t){const n=findReportMeta(s)?.title||"Report",o=t?t.start===t.end?formatNumericDate(t.start):`${formatNumericDate(t.start)} \u2013 ${formatNumericDate(t.end)}`:"";return`
    <div class="report-print-sheet" data-report="${escapeHtml(s)}">
      ${e}
      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>${escapeHtml(n)}${o?` \xB7 ${escapeHtml(o)}`:""}</span>
      </footer>
    </div>`}async function handleReportPrintClick(){if(reportPrintBusy)return;const e=document.getElementById("reports-print-btn"),s=e?.textContent||"Print this report";reportPrintBusy=!0,e&&(e.disabled=!0,e.textContent="Preparing\u2026");try{await runReportPrint()}catch(t){AppError?.report?.(t,{context:"runReportPrint"}),alert(AppError?.getUserMessage?.(t)||"Could not open the print dialog.")}finally{reportPrintBusy=!1,e&&(e.disabled=!1,e.textContent=s)}}async function runReportPrint(){if(!cachedData||!cachedRange){alert("Load report data first (pick dates and click Load data).");return}const e=renderReportHtml(activeReport,cachedData,cachedRange);if(!e?.trim()){alert("No report content to print.");return}const s=sanitizeReportHtmlForPrint(e),t=buildPrintSheetWrapped(s,activeReport,cachedRange),r=await PrintUtils.getReportPrintCssText(),n=PrintUtils.buildPrintFilename(activeReport||"report",cachedRange?.start,cachedRange?.start!==cachedRange?.end?cachedRange?.end:null);await PrintUtils.printInIframe({title:n,bodyHtml:t,cssText:r,bodyClass:"report-print-body",containerClass:"report-print-container",iframeTitle:"Report print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}function renderActiveReport(){const e=document.getElementById("reports-preview"),s=document.getElementById("reports-print-root"),t=findReportMeta(activeReport);if(!cachedData||!cachedRange){if(e&&e.textContent!=="Loading\u2026"&&e.textContent!=="Loading report data\u2026"){const o=t?.title?escapeHtml(t.title):"this report";e.innerHTML=`<p class="muted">Select dates and click <strong>Load data</strong> to preview <strong>${o}</strong>.</p>`,e.classList.add("muted")}s&&(s.innerHTML="",s.setAttribute("aria-hidden","true")),setReportPrintButtonWaiting();return}const r=renderReportHtml(activeReport,cachedData,cachedRange);e&&(e.innerHTML=`<div class="report-preview-inner">${r}</div>`,e.classList.remove("muted")),s&&(s.innerHTML=`<div class="report-print-sheet">${r}</div>`,s.removeAttribute("aria-hidden"));const n=document.getElementById("reports-print-btn");n&&!reportPrintBusy&&(n.disabled=!1,n.title=""),updateReportsCsvButtonVisibility()}function setReportPrintButtonWaiting(){const e=document.getElementById("reports-print-btn");e&&!reportPrintBusy&&(e.disabled=!0,e.title="Load report data first"),updateReportsCsvButtonVisibility()}
