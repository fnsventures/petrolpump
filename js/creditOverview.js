(function(){const _=()=>window.CreditPage;let u=0,v=!1,m=!1,c=null,w="";const S=Object.freeze({credit_taken:0,settled:0,overdue:0,customers:[]}),I="css/credit-summary-print.css?v=2";function f(){return readDateRangeFromControls(document.getElementById("credit-overview-range"),document.getElementById("credit-overview-start"),document.getElementById("credit-overview-end"))}function b(){const e=f();return e?{period:e.modeInfo?.mode||"custom",from:e.start,to:e.end}:null}function P(){const e=f();if(e)return{start:e.start,end:e.end};const r=getRangeForSelection("all-time");return{start:r.start,end:r.end}}function C(){const e=f();return e?formatDateRangeLabel(e,e.modeInfo,{style:"dashboard"}):"All time"}function N(){createDateRangeFilter({storageKey:"credit_overview_period",ranges:["today","this-week","this-month","all-time","custom"],defaultRange:"all-time",rangeSelect:"credit-overview-range",startInput:"credit-overview-start",endInput:"credit-overview-end",customRange:"credit-overview-custom-range",applyBtn:"credit-overview-apply-filter",trigger:"apply",runOnInit:!0,onApply:()=>k()}),document.getElementById("credit-overview-print-btn")?.addEventListener("click",()=>{F()})}function $(e,r){return(Number(e)||0)-(Number(r)||0)}function A(e){if(!e||typeof e!="object")return{...S,customers:[]};const r=Number(e.credit_taken)||0,n=Number(e.settled)||0,t=Array.isArray(e.customers)?e.customers.map(s=>{const i=Number(s.credit_taken)||0,a=Number(s.settled)||0;return{...s,credit_taken:i,settled:a,overdue:$(i,a)}}):[];return{credit_taken:r,settled:n,overdue:$(r,n),customers:t}}function L(e,r){return`credit_overview_${e||"all"}_${r}`}function p(){const e=document.getElementById("credit-overview-print-btn");e&&(e.disabled=m||!c?.customers?.length)}function g(e,r=b()){const n=document.getElementById("credit-overview-body"),t=document.getElementById("credit-overview-empty"),s=n?.closest("table");if(!n)return;const i=A(e);if(c=i,w=C(),B(i.credit_taken,i.settled,i.overdue),p(),!i.customers.length){n.innerHTML="",s?.classList.add("hidden"),t?.classList.remove("hidden");return}H(n,i.customers,r),s?.classList.remove("hidden"),t?.classList.add("hidden")}function H(e,r,n){e.innerHTML=r.map(t=>{const s=_().customerSummaryUrl(t.customer_name,n),i=t.overdue<0;return`<tr${i?' class="credit-overview-row--overpaid"':""}>
        <td><a class="customer-link" href="${s}">${escapeHtml(t.customer_name)}</a></td>
        <td class="num">${formatCurrency(t.credit_taken)}</td>
        <td class="num${i?" credit-overview-settled":""}">${formatCurrency(t.settled)}</td>
        <td class="num credit-overview-outstanding">${formatCurrency(t.overdue)}</td>
      </tr>`}).join("")}function B(e,r,n){const t=(s,i)=>{const a=document.getElementById(s);a&&(a.textContent=formatCurrency(i))};t("credit-overview-credit-taken",e),t("credit-overview-settled",r),t("credit-overview-overdue",n)}async function k(){const e=document.getElementById("credit-overview-body"),r=document.getElementById("credit-overview-empty"),n=e?.closest("table");if(!e)return;const{start:t,end:s}=P(),i=b(),a=++u,d=L(t,s),o=typeof AppCache<"u"&&AppCache?.get?AppCache.get(d):null,O=o&&!o.isMiss&&o.data;O?g(o.data,i):(c=null,p(),e.innerHTML="<tr><td colspan='4' class='muted'>Loading\u2026</td></tr>",r?.classList.add("hidden"),n?.classList.remove("hidden"));try{const l=async()=>{const{data:h,error:E}=await supabaseClient.rpc("get_credit_overview_period",{p_from:t||null,p_to:s});if(E)throw E;return h};let y;if(typeof AppCache<"u"&&AppCache?.getWithSWR?y=await AppCache.getWithSWR(d,l,"credit_overview",h=>{a===u&&g(h,i)}):y=await l(),a!==u)return;O||g(y,i)}catch(l){if(a!==u)return;c=null,p(),e.innerHTML=`<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(l))}</td></tr>`,AppError.report(l,{context:"loadOverviewPeriodActivity"})}}function R(e,r){const n=PumpSettings.getStationGstin(),t=(r||[]).filter(Boolean).map(s=>`<p class="report-subtitle">${s}</p>`).join("");return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
          ${n?`<p class="report-gstin">GSTIN: ${escapeHtml(n)}</p>`:""}
          <p class="report-title">${escapeHtml(e)}</p>
          ${t}
        </div>
      </div>
    </header>`}function T(e){return e.length?e.map((r,n)=>{const t=Number(r.overdue)||0,s=t<0?' class="num credit-overview-print-overpaid"':' class="num"';return`
        <tr>
          <td>${n+1}</td>
          <td>${escapeHtml(r.customer_name)}</td>
          <td class="num">\u20B9 ${formatNumberPlain(r.credit_taken)}</td>
          <td class="num">\u20B9 ${formatNumberPlain(r.settled)}</td>
          <td${s}>\u20B9 ${formatNumberPlain(t)}</td>
        </tr>`}).join(""):'<tr><td colspan="5" class="muted" style="text-align:center">No credit activity for this period</td></tr>'}function D(e,r){const n=formatDisplayDate(getLocalDateString()),t=r||"All time",s=Number(e.credit_taken)||0,i=Number(e.settled)||0,a=Number(e.overdue)||0,d=Array.isArray(e.customers)?e.customers:[],o=d.length;return`
    <article class="credit-summary-sheet report-print-sheet credit-overview-print-sheet">
      ${R("Credit overview \u2014 customer list",[`Period: <strong>${escapeHtml(t)}</strong>`,`Generated: ${escapeHtml(n)} \xB7 ${o} customer${o===1?"":"s"}`])}

      <div class="credit-summary-title-band">
        <h2 class="credit-summary-doc-title">Period activity by customer</h2>
        <p class="credit-summary-doc-meta">
          Credit taken, settlements received, and outstanding for sales in the selected period.
        </p>
      </div>

      <div class="credit-summary-kpis">
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Credit taken</span>
          <span class="credit-summary-kpi-value">\u20B9 ${formatNumberPlain(s)}</span>
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Settled</span>
          <span class="credit-summary-kpi-value">\u20B9 ${formatNumberPlain(i)}</span>
        </div>
        <div class="credit-summary-kpi credit-summary-kpi--outstanding">
          <span class="credit-summary-kpi-label">Outstanding</span>
          <span class="credit-summary-kpi-value">\u20B9 ${formatNumberPlain(a)}</span>
          <span class="credit-summary-kpi-meta">Credit taken minus settled</span>
        </div>
      </div>

      <section class="credit-summary-block">
        <h3 class="credit-summary-block-title">By customer</h3>
        <p class="credit-summary-block-lead">All customers with credit activity in ${escapeHtml(t)}.</p>
        <table class="report-table credit-overview-print-table">
          <thead>
            <tr>
              <th style="width:6%">#</th>
              <th>Customer</th>
              <th class="num">Credit taken (\u20B9)</th>
              <th class="num">Settled (\u20B9)</th>
              <th class="num">Outstanding (\u20B9)</th>
            </tr>
          </thead>
          <tbody>${T(d)}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td colspan="2">Total</td>
              <td class="num">\u20B9 ${formatNumberPlain(s)}</td>
              <td class="num">\u20B9 ${formatNumberPlain(i)}</td>
              <td class="num">\u20B9 ${formatNumberPlain(a)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <p class="credit-summary-note">
        Computer-generated credit overview. Outstanding = credit taken minus settlements for the selected period
        (not the live portfolio due). Negative outstanding means settlements exceeded credit in this period.
      </p>

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>Credit overview \xB7 ${escapeHtml(t)}</span>
      </footer>
    </article>`}async function U(){typeof PrintUtils>"u"&&await loadScript("js/printUtils.js?v=10"),typeof loadPumpSettings=="function"&&await loadPumpSettings()}async function x(){if(!c?.customers?.length){const i="Load period activity first, then print.";typeof AppError?.showGlobalBanner=="function"?AppError.showGlobalBanner(i):alert(i);return}await U();const e=w||C(),r=D(c,e),{start:n,end:t}=P(),s=PrintUtils.buildPrintFilename("credit-overview",e,n||null,n!==t?t:null);await PrintUtils.printInIframe({title:s,bodyHtml:r,cssHref:I,bodyClass:"report-print-body",containerClass:"report-print-container",iframeTitle:"Credit overview print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}async function F(){if(m)return;const e=document.getElementById("credit-overview-print-btn"),r=e?.textContent||"Print report";m=!0,e&&(e.disabled=!0,e.textContent="Preparing\u2026");try{await x()}catch(n){AppError?.report?.(n,{context:"runOverviewPrint"});const t=AppError?.getUserMessage?.(n)||"Could not open the print dialog.";typeof AppError?.showGlobalBanner=="function"?AppError.showGlobalBanner(t):alert(t)}finally{m=!1,e&&(e.textContent=r),p()}}function G(){v||(N(),v=!0)}window.CreditOverview={init:G,isReady:()=>v,refresh:()=>{k()}}})();
