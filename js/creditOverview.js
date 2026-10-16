(function(){const E=()=>window.CreditPage;let y=0,h=!1,f=!1,u=null,$="";const S=Object.freeze({credit_taken:0,settled:0,overdue:0,customers:[]});function w(){return readDateRangeFromControls(document.getElementById("credit-overview-range"),document.getElementById("credit-overview-start"),document.getElementById("credit-overview-end"))}function P(){const e=w();return e?{period:e.modeInfo?.mode||"custom",from:e.start,to:e.end}:null}function k(){const e=w();if(e)return{start:e.start,end:e.end};const r=getRangeForSelection("all-time");return{start:r.start,end:r.end}}function A(){const e=w();return e?formatDateRangeLabel(e,e.modeInfo,{style:"dashboard"}):"All time"}function L(){PrintUtils?.preloadCreditSummaryPrintCss?.(),createDateRangeFilter({storageKey:"credit_overview_period",ranges:["today","this-week","this-month","all-time","custom"],defaultRange:"all-time",rangeSelect:"credit-overview-range",startInput:"credit-overview-start",endInput:"credit-overview-end",customRange:"credit-overview-custom-range",applyBtn:"credit-overview-apply-filter",trigger:"apply",runOnInit:!0,onApply:()=>C()}),document.getElementById("credit-overview-print-btn")?.addEventListener("click",()=>{T()}),typeof bindLiveRefresh=="function"&&bindLiveRefresh(()=>void C(),{match:()=>!!document.getElementById("credit-overview-body")})}function O(e,r){return(Number(e)||0)-(Number(r)||0)}function _(e){if(!e||typeof e!="object")return{...S,customers:[]};const r=Number(e.credit_taken)||0,i=Number(e.settled)||0,t=Array.isArray(e.customers)?e.customers.map(s=>{const n=Number(s.credit_taken)||0,a=Number(s.settled)||0;return{...s,credit_taken:n,settled:a,overdue:O(n,a)}}):[];return{credit_taken:r,settled:i,overdue:O(r,i),customers:t}}function I(e,r){return`credit_overview_${e||"all"}_${r}`}function g(){const e=document.getElementById("credit-overview-print-btn");e&&(e.disabled=f||!u?.customers?.length)}function b(e,r=P()){const i=document.getElementById("credit-overview-body"),t=document.getElementById("credit-overview-empty"),s=i?.closest("table");if(!i)return;const n=_(e);if(u=n,$=A(),H(n.credit_taken,n.settled,n.overdue),g(),!n.customers.length){i.innerHTML="",s?.classList.add("hidden"),t?.classList.remove("hidden");return}B(i,n.customers,r),s?.classList.remove("hidden"),t?.classList.add("hidden")}function B(e,r,i){e.innerHTML=r.map(t=>{const s=E().customerSummaryUrl(t.customer_name,i),n=t.overdue<-.009,a=n?Math.abs(t.overdue):t.overdue;return`<tr${n?' class="credit-overview-row--overpaid"':""}>
        <td><a class="customer-link" href="${s}">${escapeHtml(t.customer_name)}</a>${n?' <span class="credit-advance-tag">Advance</span>':""}</td>
        <td class="num">${formatCurrency(t.credit_taken)}</td>
        <td class="num${n?" credit-overview-settled":""}">${formatCurrency(t.settled)}</td>
        <td class="num credit-overview-outstanding">${n?`+ ${formatCurrency(a)}`:formatCurrency(a)}</td>
      </tr>`}).join("")}function H(e,r,i){const t=Number(i)||0,s=t<-.009,n=s?Math.abs(t):Math.max(0,t),a=(o,c)=>{const d=document.getElementById(o);d&&(d.textContent=c)};a("credit-overview-credit-taken",formatCurrency(e)),a("credit-overview-settled",formatCurrency(r)),a("credit-overview-overdue",s?`+ ${formatCurrency(n)}`:formatCurrency(n)),a("credit-overview-balance-label",s?"Advance payment":"Outstanding")}async function C(){const e=document.getElementById("credit-overview-body"),r=document.getElementById("credit-overview-empty"),i=e?.closest("table");if(!e)return;const{start:t,end:s}=k(),n=P(),a=++y,o=I(t,s),c=typeof AppCache<"u"&&AppCache?.get?AppCache.get(o):null,d=c&&!c.isMiss&&c.data;d?b(c.data,n):(u=null,g(),e.innerHTML="<tr><td colspan='4' class='muted'>Loading\u2026</td></tr>",r?.classList.add("hidden"),i?.classList.remove("hidden"));try{const l=async()=>{const{data:p,error:v}=await window.supabaseClient.rpc("get_credit_overview_period",{p_from:t||null,p_to:s});if(v)throw v;return p};let m;if(typeof AppCache<"u"&&AppCache?.getWithSWR?m=await AppCache.getWithSWR(o,l,"credit_overview",p=>{a===y&&b(p,n)}):m=await l(),a!==y)return;d||b(m,n)}catch(l){if(a!==y)return;u=null,g(),e.innerHTML=`<tr><td colspan="4" class="error">${escapeHtml(AppError.getUserMessage(l))}</td></tr>`,AppError.report(l,{context:"loadOverviewPeriodActivity"})}}function R(e,r){const i=PumpSettings.getStationGstin(),t=(r||[]).filter(Boolean).map(s=>`<p class="report-subtitle">${s}</p>`).join("");return`
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
    </header>`}function N(e){return e.length?e.map((r,i)=>{const t=Number(r.overdue)||0,s=t<-.009,n=Math.abs(t),a=s?' class="num credit-overview-print-overpaid"':' class="num"';return`
        <tr>
          <td>${i+1}</td>
          <td>${escapeHtml(r.customer_name)}${s?' <span class="credit-overview-print-advance-tag">Advance</span>':""}</td>
          <td class="num">${formatCurrency(r.credit_taken)}</td>
          <td class="num">${formatCurrency(r.settled)}</td>
          <td${a}>${formatCurrency(n)}${s?" adv.":""}</td>
        </tr>`}).join(""):'<tr><td colspan="5" class="muted" style="text-align:center">No credit activity for this period</td></tr>'}function x(e,r){const i=formatDisplayDate(getLocalDateString()),t=r||"All time",s=Number(e.credit_taken)||0,n=Number(e.settled)||0,a=Number(e.overdue)||0,o=a<-.009,c=Math.max(0,a),d=Math.max(0,-a),l=o?"Advance payment":"Outstanding",m=o?d:c,p=Array.isArray(e.customers)?e.customers:[],v=p.length;return`
    <article class="credit-summary-sheet report-print-sheet credit-overview-print-sheet">
      ${R("Credit overview \u2014 customer list",[`Period: <strong>${escapeHtml(t)}</strong>`,`Generated: ${escapeHtml(i)} \xB7 ${v} customer${v===1?"":"s"}`])}

      <div class="credit-summary-title-band">
        <h2 class="credit-summary-doc-title">Period activity by customer</h2>
        <p class="credit-summary-doc-meta">
          Credit taken, settlements received, and net balance for sales in the selected period.
        </p>
      </div>

      <div class="credit-summary-kpis">
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Credit taken</span>
          <span class="credit-summary-kpi-value">${formatCurrency(s)}</span>
        </div>
        <div class="credit-summary-kpi">
          <span class="credit-summary-kpi-label">Settled</span>
          <span class="credit-summary-kpi-value">${formatCurrency(n)}</span>
        </div>
        <div class="credit-summary-kpi credit-summary-kpi--outstanding${o?" is-advance":""}">
          <span class="credit-summary-kpi-label">${l}</span>
          <span class="credit-summary-kpi-value">${formatCurrency(m)}</span>
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
          <tbody>${N(p)}</tbody>
          <tfoot>
            <tr class="report-total-row">
              <td colspan="2">Total</td>
              <td class="num">${formatCurrency(s)}</td>
              <td class="num">${formatCurrency(n)}</td>
              <td class="num">${formatCurrency(m)}${o?" adv.":""}</td>
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
    </article>`}async function D(){typeof PrintUtils>"u"&&await loadScript("js/printUtils.js?v=e97c39c085"),typeof loadPumpSettings=="function"&&await loadPumpSettings()}async function M(){if(!u?.customers?.length){const a="Load period activity first, then print.";typeof AppError?.showGlobalBanner=="function"?AppError.showGlobalBanner(a):AppDialog.alert(a);return}await D();const e=$||A(),r=x(u,e),{start:i,end:t}=k(),s=PrintUtils.buildPrintFilename("credit-overview",e,i||null,i!==t?t:null),n=await PrintUtils.getCreditSummaryPrintCssText();await PrintUtils.printInIframe({title:s,bodyHtml:r,cssText:n,bodyClass:"report-print-body",containerClass:"report-print-container",iframeTitle:"Credit overview print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}async function T(){if(f)return;const e=document.getElementById("credit-overview-print-btn"),r=e?.textContent||"Print report";f=!0,e&&(e.disabled=!0,e.textContent="Preparing\u2026");try{await M()}catch(i){AppError?.report?.(i,{context:"runOverviewPrint"});const t=AppError?.getUserMessage?.(i)||"Could not open the print dialog.";typeof AppError?.showGlobalBanner=="function"?AppError.showGlobalBanner(t):AppDialog.alert(t)}finally{f=!1,e&&(e.textContent=r),g()}}function U(){h||(L(),h=!0)}window.CreditOverview={init:U,isReady:()=>h,refresh:()=>{C()}}})();
