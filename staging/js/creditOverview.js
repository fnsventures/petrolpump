(function(){const E=()=>window.CreditPage;let f=0,h=!1,y=!1,u=null,P="";const S=Object.freeze({credit_taken:0,settled:0,overdue:0,customers:[]});function b(){return readDateRangeFromControls(document.getElementById("credit-overview-range"),document.getElementById("credit-overview-start"),document.getElementById("credit-overview-end"))}function $(){const e=b();return e?{period:e.modeInfo?.mode||"custom",from:e.start,to:e.end}:null}function k(){const e=b();if(e)return{start:e.start,end:e.end};const r=getRangeForSelection("all-time");return{start:r.start,end:r.end}}function A(){const e=b();return e?formatDateRangeLabel(e,e.modeInfo,{style:"dashboard"}):"All time"}function L(){PrintUtils?.preloadCreditSummaryPrintCss?.(),createDateRangeFilter({storageKey:"credit_overview_period",ranges:["today","this-week","this-month","all-time","custom"],defaultRange:"all-time",rangeSelect:"credit-overview-range",startInput:"credit-overview-start",endInput:"credit-overview-end",customRange:"credit-overview-custom-range",applyBtn:"credit-overview-apply-filter",trigger:"apply",runOnInit:!0,onApply:()=>C()}),document.getElementById("credit-overview-print-btn")?.addEventListener("click",()=>{D()}),typeof bindLiveRefresh=="function"&&bindLiveRefresh(()=>void C(),{match:()=>!!document.getElementById("credit-overview-body")})}function O(e,r){return(Number(e)||0)-(Number(r)||0)}function N(e){if(!e||typeof e!="object")return{...S,customers:[]};const r=Number(e.credit_taken)||0,i=Number(e.settled)||0,t=Array.isArray(e.customers)?e.customers.map(s=>{const n=Number(s.credit_taken)||0,a=Number(s.settled)||0;return{...s,credit_taken:n,settled:a,overdue:O(n,a)}}):[];return{credit_taken:r,settled:i,overdue:O(r,i),customers:t}}function _(e,r){return`credit_overview_${e||"all"}_${r}`}function g(){const e=document.getElementById("credit-overview-print-btn");e&&(e.disabled=y||!u?.customers?.length)}function w(e,r=$()){const i=document.getElementById("credit-overview-body"),t=document.getElementById("credit-overview-empty"),s=i?.closest("table");if(!i)return;const n=N(e);if(u=n,P=A(),B(n.credit_taken,n.settled,n.overdue),g(),!n.customers.length){i.innerHTML="",s?.classList.add("hidden"),t?.classList.remove("hidden");return}I(i,n.customers,r),s?.classList.remove("hidden"),t?.classList.add("hidden")}function I(e,r,i){e.innerHTML=r.map(t=>{const s=E().customerSummaryUrl(t.customer_name,i),n=t.overdue<-.009,a=n?Math.abs(t.overdue):t.overdue;return`<tr${n?' class="credit-overview-row--overpaid"':""}>
        <td><a class="customer-link" href="${s}">${escapeHtml(t.customer_name)}</a>${n?' <span class="credit-advance-tag">Advance</span>':""}</td>
        <td class="num">${formatCurrency(t.credit_taken)}</td>
        <td class="num${n?" credit-overview-settled":""}">${formatCurrency(t.settled)}</td>
        <td class="num credit-overview-outstanding">${n?`+ ${formatCurrency(a)}`:formatCurrency(a)}</td>
      </tr>`}).join("")}function B(e,r,i){const t=Number(i)||0,s=t<-.009,n=s?Math.abs(t):Math.max(0,t),a=(o,c)=>{const d=document.getElementById(o);d&&(d.textContent=c)};a("credit-overview-credit-taken",formatCurrency(e)),a("credit-overview-settled",formatCurrency(r)),a("credit-overview-overdue",s?`+ ${formatCurrency(n)}`:formatCurrency(n)),a("credit-overview-balance-label",s?"Advance payment":"Outstanding")}async function C(){const e=document.getElementById("credit-overview-body"),r=document.getElementById("credit-overview-empty"),i=e?.closest("table");if(!e)return;const{start:t,end:s}=k(),n=$(),a=++f,o=_(t,s),c=typeof AppCache<"u"&&AppCache?.get?AppCache.get(o):null,d=c&&!c.isMiss&&c.data;d?w(c.data,n):(u=null,g(),e.innerHTML="<tr><td colspan='4' class='muted'>Loading\u2026</td></tr>",r?.classList.add("hidden"),i?.classList.remove("hidden"));try{const l=async()=>{const{data:p,error:v}=await window.supabaseClient.rpc("get_credit_overview_period",{p_from:t||null,p_to:s});if(v)throw v;return p};let m;if(typeof AppCache<"u"&&AppCache?.getWithSWR?m=await AppCache.getWithSWR(o,l,"credit_overview",p=>{a===f&&w(p,n)}):m=await l(),a!==f)return;d||w(m,n)}catch(l){if(a!==f)return;u=null,g(),e.innerHTML=`<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(l))}</td></tr>`,AppError.report(l,{context:"loadOverviewPeriodActivity"})}}function H(e,r){const i=PumpSettings.getStationGstin(),t=(r||[]).filter(Boolean).map(s=>`<p class="report-subtitle">${s}</p>`).join("");return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
          <p class="report-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
          ${i?`<p class="report-gstin">GSTIN: ${escapeHtml(i)}</p>`:""}
          <p class="report-title">${escapeHtml(e)}</p>
          ${t}
        </div>
      </div>
    </header>`}function R(e){return e.length?e.map((r,i)=>{const t=Number(r.overdue)||0,s=t<-.009,n=Math.abs(t),a=s?' class="num credit-overview-print-overpaid"':' class="num"';return`
        <tr>
          <td>${i+1}</td>
          <td>${escapeHtml(r.customer_name)}${s?' <span class="credit-overview-print-advance-tag">Advance</span>':""}</td>
          <td class="num">\u20B9 ${formatNumberPlain(r.credit_taken)}</td>
          <td class="num">\u20B9 ${formatNumberPlain(r.settled)}</td>
          <td${a}>\u20B9 ${formatNumberPlain(n)}${s?" adv.":""}</td>
        </tr>`}).join(""):'<tr><td colspan="5" class="muted" style="text-align:center">No credit activity for this period</td></tr>'}function x(e,r){const i=formatDisplayDate(getLocalDateString()),t=r||"All time",s=Number(e.credit_taken)||0,n=Number(e.settled)||0,a=Number(e.overdue)||0,o=a<-.009,c=Math.max(0,a),d=Math.max(0,-a),l=o?"Advance payment":"Outstanding",m=o?d:c,p=Array.isArray(e.customers)?e.customers:[],v=p.length;return`
    <article class="credit-summary-sheet report-print-sheet credit-overview-print-sheet">
      ${H("Credit overview \u2014 customer list",[`Period: <strong>${escapeHtml(t)}</strong>`,`Generated: ${escapeHtml(i)} \xB7 ${v} customer${v===1?"":"s"}`])}

      <div class="credit-summary-title-band">
        <h2 class="credit-summary-doc-title">Period activity by customer</h2>
        <p class="credit-summary-doc-meta">
          Credit taken, settlements received, and net balance for sales in the selected period.
        </p>
      </div>

      <div class="credit-summary-kpis">
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Credit taken</span>
          <span class="credit-summary-kpi-value">\u20B9 ${formatNumberPlain(s)}</span>
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Settled</span>
          <span class="credit-summary-kpi-value">\u20B9 ${formatNumberPlain(n)}</span>
        </div>
        <div class="credit-summary-kpi credit-summary-kpi--outstanding${o?" is-advance":""}">
          <span class="credit-summary-kpi-label">${l}</span>
          <span class="credit-summary-kpi-value">\u20B9 ${formatNumberPlain(m)}</span>
          <span class="credit-summary-kpi-meta">${o?"Settlements exceed credit in this period":"Credit taken minus settled"}</span>
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
              <th class="num">Net (\u20B9)</th>
            </tr>
          </thead>
          <tbody>${R(p)}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td colspan="2">Total</td>
              <td class="num">\u20B9 ${formatNumberPlain(s)}</td>
              <td class="num">\u20B9 ${formatNumberPlain(n)}</td>
              <td class="num">\u20B9 ${formatNumberPlain(m)}${o?" adv.":""}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      <p class="credit-summary-note">
        Computer-generated credit overview. Net = credit taken minus settlements for the selected period
        (not the live portfolio due). Advance means settlements exceeded credit in this period.
      </p>

      <footer class="report-print-foot">
        <span>${escapeHtml(PumpSettings.getStationLegalName())}</span>
        <span>Credit overview \xB7 ${escapeHtml(t)}</span>
      </footer>
    </article>`}async function M(){typeof PrintUtils>"u"&&await loadScript("js/printUtils.js?v=12"),typeof loadPumpSettings=="function"&&await loadPumpSettings()}async function T(){if(!u?.customers?.length){const a="Load period activity first, then print.";typeof AppError?.showGlobalBanner=="function"?AppError.showGlobalBanner(a):alert(a);return}await M();const e=P||A(),r=x(u,e),{start:i,end:t}=k(),s=PrintUtils.buildPrintFilename("credit-overview",e,i||null,i!==t?t:null),n=await PrintUtils.getCreditSummaryPrintCssText();await PrintUtils.printInIframe({title:s,bodyHtml:r,cssText:n,bodyClass:"report-print-body",containerClass:"report-print-container",iframeTitle:"Credit overview print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}async function D(){if(y)return;const e=document.getElementById("credit-overview-print-btn"),r=e?.textContent||"Print report";y=!0,e&&(e.disabled=!0,e.textContent="Preparing\u2026");try{await T()}catch(i){AppError?.report?.(i,{context:"runOverviewPrint"});const t=AppError?.getUserMessage?.(i)||"Could not open the print dialog.";typeof AppError?.showGlobalBanner=="function"?AppError.showGlobalBanner(t):alert(t)}finally{y=!1,e&&(e.textContent=r),g()}}function U(){h||(L(),h=!0)}window.CreditOverview={init:U,isReady:()=>h,refresh:()=>{C()}}})();
