function normalizeSalaryMonth(t){if(!t)return"";const[a,s]=String(t).split("-");if(!a||!s)return"";const d=String(s).padStart(2,"0").slice(0,2);return`${a}-${d}-01`}function salaryMonthKey(t){const a=normalizeSalaryMonth(t);return a?a.slice(0,7):""}function suggestPaymentDate(t){const a=getLocalDateString(),s=salaryMonthKey(t),d=a.slice(0,7);if(!s||s===d)return a;if(s<d){const[l,u]=s.split("-").map(Number);return toLocalDateString(new Date(l,u,0))}return a}function isMissingSalaryMonthColumn(t){const a=String(t?.message||"");return/salary_month/i.test(a)||t?.code==="PGRST204"}function isMissingSalaryPaymentIdColumn(t){const a=String(t?.message||"");return/salary_payment_id/i.test(a)||t?.code==="PGRST204"}function isMissingSalaryMonthExclusionsTable(t){const a=String(t?.message||"");return/salary_month_exclusions/i.test(a)||t?.code==="PGRST204"||t?.code==="42P01"}const SALARY_NA_STATUS={label:"Not applicable",className:"salary-status--na"};function getStaffSalaryMonthContext(t,a,s){if(s)return{isNa:!0,label:SALARY_NA_STATUS.label,className:SALARY_NA_STATUS.className,payable:null,pending:null,advance:0,paid:Number(a??0),exclusion:s};const d=salaryStatusInfo(t.monthly_salary,a,t),{salary:l,pending:u}=computeSalaryBalance(t.monthly_salary,a,t);return{isNa:!1,label:d.label,className:d.className,payable:l,pending:d.pending,advance:d.advance,paid:Number(a??0),exclusion:null}}function formatSalaryAmount(t){return t==null?"\u2014":formatCurrency(t)}function formatMonthLabel(t){if(!t)return"\u2014";const[a,s]=t.split("-").map(Number);return new Date(a,s-1,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"})}const SALARY_SLIP_PRINT_CSS="css/salary-slip-print.css?v=2";function slipAssetUrl(t){return new URL(t,window.location.href).href}function getPfSettings(){const t=PumpSettings.getStation(),a=AppConfig.DEFAULT_STATION;return{establishmentCode:(t.pfEstablishmentCode||a.pfEstablishmentCode||"").trim()}}function roundMoney(t){return Math.round(Number(t)*100)/100}function computePfBreakdown(t,a){const s=roundMoney(Math.max(0,Number(t??0))),d=roundMoney(Math.max(0,Number(a?.pf_contribution??0))),l=s>0?Math.min(d,s):0,u=d,f=roundMoney(Math.max(0,s-l));return{gross:s,employeePf:l,employerPf:u,netSalary:f,fixedAmount:d}}function getPayPeriodLabel(t){if(!t)return"\u2014";const[a,s]=t.split("-").map(Number),d=new Date(a,s-1,1),l=new Date(a,s,0),u=f=>f.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});return`${u(d)} \u2013 ${u(l)}`}const AMOUNT_WORDS_ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"],AMOUNT_WORDS_TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];function amountWordsUnder100(t){if(t<20)return AMOUNT_WORDS_ONES[t];const a=Math.floor(t/10),s=t%10;return`${AMOUNT_WORDS_TENS[a]}${s?` ${AMOUNT_WORDS_ONES[s]}`:""}`.trim()}function amountWordsUnder1000(t){if(t<100)return amountWordsUnder100(t);const a=Math.floor(t/100),s=t%100;return`${AMOUNT_WORDS_ONES[a]} Hundred${s?` ${amountWordsUnder100(s)}`:""}`.trim()}function amountWordsIndian(t){if(t===0)return"";if(t<1e3)return amountWordsUnder1000(t);if(t<1e5){const d=Math.floor(t/1e3),l=t%1e3;return`${amountWordsUnder1000(d)} Thousand${l?` ${amountWordsUnder1000(l)}`:""}`.trim()}if(t<1e7){const d=Math.floor(t/1e5),l=t%1e5;return`${amountWordsIndian(d)} Lakh${l?` ${amountWordsIndian(l)}`:""}`.trim()}const a=Math.floor(t/1e7),s=t%1e7;return`${amountWordsIndian(a)} Crore${s?` ${amountWordsIndian(s)}`:""}`.trim()}function amountInWordsINR(t){const a=roundMoney(Math.abs(Number(t)||0)),s=Math.floor(a),d=Math.round((a-s)*100);if(s===0&&d===0)return"Zero Rupees Only";let l=amountWordsIndian(s);return l=l?`${l} Rupees`:"Zero Rupees",d>0&&(l+=` and ${amountWordsIndian(d)} Paise`),`${l} Only`}function computeSalaryBalance(t,a,s){const d=Number(t??0),l=s?computePfBreakdown(d,s).netSalary:d,u=Number(a??0),f=Math.max(0,l-u),N=Math.max(0,u-l);return{salary:l,gross:d,totalPaid:u,pending:f,advance:N}}function salaryStatusInfo(t,a,s){const{salary:d,totalPaid:l,pending:u,advance:f}=computeSalaryBalance(t,a,s);return d<=0?{label:"No salary set",className:"salary-status--none",pending:u,advance:f}:f>.009?{label:"Advance paid",className:"salary-status--advance",pending:u,advance:f}:u<=.009?{label:"Fully paid",className:"salary-status--paid",pending:u,advance:f}:l>0?{label:"Partial",className:"salary-status--partial",pending:u,advance:f}:{label:"Unpaid",className:"salary-status--unpaid",pending:u,advance:f}}function paymentsForEmployee(t,a){return(t||[]).filter(s=>s.employee_id===a).sort((s,d)=>String(s.date).localeCompare(String(d.date)))}function salaryExpenseDescription(t,a){if(!t)return"Salary";const s=a!=null&&String(a).trim()!==""?String(a).trim():null;return`Salary: ${t.name}${s?` - ${s}`:""}`}function salaryDeleteButtonHtml(t,a,s){if(!s||!t?.id)return"";const d=a?.name||"staff";return AdminDelete.buttonHtml({selector:"salary-delete-btn",data:{paymentId:t.id,staffName:d,date:t.date,amount:t.amount},title:"Delete payment (admin)"})}function getStaffBalanceForMonth(t,a,s){const d=(s||[]).find(N=>N.id===t);if(!d)return null;const u=paidByStaffInRange(a).get(t)||0,f=computeSalaryBalance(d.monthly_salary,u,d);return{staff:d,paid:u,...f,status:salaryStatusInfo(d.monthly_salary,u,d)}}function paidByStaffInRange(t){const a=new Map;return(t||[]).forEach(s=>{const d=s.employee_id;a.set(d,(a.get(d)||0)+Number(s.amount??0))}),a}function buildSlipRef(t,a){const s=String(t||"").replace(/-/g,"").slice(0,8).toUpperCase();return`SAL-${a.replace("-","")}-${s}`}function buildSalarySlipHtml(t,a,s){const d=formatMonthLabel(s),l=getPayPeriodLabel(s),u=a.reduce((I,G)=>I+Number(G.amount??0),0),f=computePfBreakdown(t.monthly_salary,t),{pending:N,advance:at}=computeSalaryBalance(t.monthly_salary,u,t),L=PumpSettings.getStationGstin(),_=getPfSettings(),k=PumpSettings.getStationAddress(),F=PumpSettings.getStationContactLine(),U=buildSlipRef(t.id,s),q=formatDisplayDate(getLocalDateString()),D=t.pf_number?.trim()||"",R=t.pan_number?.trim()||"",nt=t.phone_number?.trim()||"",st=t.address?.trim()||"",O=[];L&&O.push(`<span>GSTIN: ${escapeHtml(L)}</span>`),_.establishmentCode&&O.push(`<span>PF Est. code: ${escapeHtml(_.establishmentCode)}</span>`);const Y=a.length?a.map((I,G)=>`
        <tr>
          <td>${G+1}</td>
          <td>${escapeHtml(formatDisplayDate(I.date))}</td>
          <td class="num">\u20B9 ${formatNumberPlain(I.amount)}</td>
          <td>${escapeHtml(I.note||"\u2014")}</td>
        </tr>`).join(""):'<tr><td colspan="4" style="text-align:center;color:#64748b">No salary disbursements recorded for this month</td></tr>',j=at>.009?`<tr class="salary-slip-summary-balance"><td>Advance paid (over net salary)</td><td>\u20B9 ${formatNumberPlain(at)}</td></tr>`:N>.009?`<tr class="salary-slip-summary-balance"><td>Balance payable (net)</td><td>\u20B9 ${formatNumberPlain(N)}</td></tr>`:'<tr class="salary-slip-summary-paid"><td>Balance payable (net)</td><td>\u20B9 0.00 \u2014 Settled</td></tr>',W=f.employerPf>0?`
      <div class="salary-slip-employer">
        <p class="salary-slip-employer-title">Employer contribution (statutory)</p>
        <table>
          <tr>
            <td>Employer PF (fixed monthly)</td>
            <td>\u20B9 ${formatNumberPlain(f.employerPf)}</td>
          </tr>
        </table>
        <p style="margin:3pt 0 0;font-size:6.8pt;color:#64748b">Employer PF is deposited to EPFO separately and is not deducted from employee take-home pay.</p>
      </div>`:"";return`
    <article class="salary-slip-sheet" data-slip-ref="${escapeHtml(U)}">
      <header class="salary-slip-head">
        <div class="salary-slip-letterhead">
          <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo salary-slip-logo" width="128" height="128" />
          <div class="salary-slip-letterhead-text">
            <h1 class="salary-slip-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
            <p class="salary-slip-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
            ${k?`<p class="salary-slip-address">${escapeHtml(k)}</p>`:""}
            ${F?`<p class="salary-slip-contact">${escapeHtml(F)}</p>`:""}
            ${O.length?`<p class="salary-slip-statutory">${O.join("")}</p>`:""}
          </div>
        </div>
      </header>

      <div class="salary-slip-title-band">
        <h2 class="salary-slip-doc-title">Salary slip</h2>
        <p class="salary-slip-doc-meta">
          <strong>Slip no.</strong> ${escapeHtml(U)} &nbsp;\xB7&nbsp;
          <strong>Pay period</strong> ${escapeHtml(l)} &nbsp;\xB7&nbsp;
          <strong>Generated</strong> ${escapeHtml(q)}
        </p>
      </div>

      <dl class="salary-slip-employee">
        <div>
          <dt>Employee name</dt>
          <dd>${escapeHtml(t.name)}</dd>
        </div>
        <div>
          <dt>Designation</dt>
          <dd>${escapeHtml(t.role_display||"\u2014")}</dd>
        </div>
        <div>
          <dt>Salary month</dt>
          <dd>${escapeHtml(d)}</dd>
        </div>
        <div>
          <dt>PF / UAN no.</dt>
          <dd class="salary-slip-mono">${D?escapeHtml(D):"\u2014"}</dd>
        </div>
        <div>
          <dt>PAN</dt>
          <dd class="salary-slip-mono">${R?escapeHtml(R):"\u2014"}</dd>
        </div>
        <div>
          <dt>Mobile</dt>
          <dd>${nt?escapeHtml(nt):"\u2014"}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>${st?escapeHtml(st):"\u2014"}</dd>
        </div>
        <div>
          <dt>PF wage (gross)</dt>
          <dd>\u20B9 ${formatNumberPlain(f.gross)}</dd>
        </div>
      </dl>

      <div class="salary-slip-pay-grid">
        <div class="salary-slip-pay-col">
          <p class="salary-slip-pay-col-title">Earnings</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Gross salary</td>
              <td>\u20B9 ${formatNumberPlain(f.gross)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total earnings</td>
              <td>\u20B9 ${formatNumberPlain(f.gross)}</td>
            </tr>
          </table>
        </div>
        <div class="salary-slip-pay-col salary-slip-pay-col--deductions">
          <p class="salary-slip-pay-col-title">Deductions</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Employee PF (fixed monthly)</td>
              <td>\u20B9 ${formatNumberPlain(f.employeePf)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total deductions</td>
              <td>\u20B9 ${formatNumberPlain(f.employeePf)}</td>
            </tr>
          </table>
        </div>
      </div>

      ${W}

      <div class="salary-slip-net-box">
        <span class="salary-slip-net-label">Net salary (take-home)</span>
        <span class="salary-slip-net-amount">\u20B9 ${formatNumberPlain(f.netSalary)}</span>
      </div>
      <p class="salary-slip-words"><strong>In words:</strong> ${escapeHtml(amountInWordsINR(f.netSalary))}</p>

      <p class="salary-slip-section-title">Salary disbursements (${escapeHtml(d)})</p>
      <table class="salary-slip-payments">
        <thead>
          <tr>
            <th style="width:7%">#</th>
            <th style="width:24%">Payment date</th>
            <th class="num" style="width:22%">Amount (\u20B9)</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>${Y}</tbody>
        <tfoot>
          <tr>
            <td colspan="2">Total disbursed</td>
            <td class="num">\u20B9 ${formatNumberPlain(u)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <table class="salary-slip-summary">
        <tr class="salary-slip-summary-net">
          <td>Net salary for month</td>
          <td>\u20B9 ${formatNumberPlain(f.netSalary)}</td>
        </tr>
        <tr class="salary-slip-summary-total">
          <td>Total disbursed this month</td>
          <td>\u20B9 ${formatNumberPlain(u)}</td>
        </tr>
        ${j}
      </table>

      <footer class="salary-slip-foot">
        <div class="salary-slip-sign">
          <span class="salary-slip-sign-line"></span>
          <span class="salary-slip-sign-label">Employee signature</span>
        </div>
        <div class="salary-slip-sign">
          <span class="salary-slip-sign-line"></span>
          <span class="salary-slip-sign-label">For ${escapeHtml(PumpSettings.getStationLegalName())}<br />Authorised signatory</span>
        </div>
      </footer>
      <p class="salary-slip-note">Computer-generated salary slip. PF amounts are fixed per employee (set in HR \u2192 Staff). Disbursement rows reflect actual payments recorded for ${escapeHtml(d)}.</p>
    </article>`}let salarySlipPrintCssCache=null;async function getSalarySlipPrintCssText(){if(salarySlipPrintCssCache)return salarySlipPrintCssCache;const t=slipAssetUrl(SALARY_SLIP_PRINT_CSS),a=await fetch(t,{cache:"default"});if(!a.ok)throw new Error("Could not load salary slip print styles.");return salarySlipPrintCssCache=await a.text(),salarySlipPrintCssCache}async function runSalarySlipPrint(t,a,s){const[d,l]=await Promise.all([Promise.resolve(buildSalarySlipHtml(t,a,s)),getSalarySlipPrintCssText()]);await PrintUtils.printInIframe({title:PrintUtils.buildPrintFilename("salary-slip",t.name||"staff",s),bodyHtml:d,cssText:l,iframeTitle:"Salary slip print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}document.addEventListener("DOMContentLoaded",async()=>{const t=await requireAuth({allowedRoles:["admin","supervisor"],onDenied:"dashboard.html",pageName:"salary"});if(!t)return;applyRoleVisibility(t.role);const a=t.role==="admin";typeof loadPumpSettings=="function"&&await loadPumpSettings(),typeof initPageSections=="function"&&initPageSections({defaultSection:"summary",validSections:["summary","record","recent"]});const s=document.getElementById("salary-payment-form"),d=document.getElementById("salary-payment-success"),l=document.getElementById("salary-payment-error"),u=document.getElementById("payment-staff"),f=document.getElementById("payment-date"),N=document.getElementById("payment-amount"),at=document.getElementById("payment-fill-remaining"),L=document.getElementById("payment-salary-month-month"),_=document.getElementById("payment-salary-month-year"),k=document.getElementById("payment-month-hint"),F=document.getElementById("salary-month-month"),U=document.getElementById("salary-month-year"),q=document.getElementById("salary-history-month-month"),D=document.getElementById("salary-history-month-year"),R=document.getElementById("salary-detail-overlay"),nt=document.getElementById("salary-detail-backdrop"),st=document.getElementById("salary-detail-close"),O=document.getElementById("salary-detail-dismiss"),Y=document.getElementById("salary-detail-print-slip"),j=document.getElementById("salary-detail-add-payment"),W=document.getElementById("salary-detail-na-banner"),I=document.getElementById("salary-detail-na-banner-text"),G=document.getElementById("salary-detail-admin-na"),rt=document.getElementById("salary-na-note"),K=document.getElementById("salary-detail-mark-na"),z=document.getElementById("salary-detail-restore-na");f&&initPersistedDateInput(f,RECORD_DATE_KEYS.salaryPayment);const mt=new Date,it=`${mt.getFullYear()}-${String(mt.getMonth()+1).padStart(2,"0")}`;populateMonthYearSelects(F,U),populateMonthYearSelects(q,D),populateMonthYearSelects(L,_),writeMonthYearValue(F,U,it),writeMonthYearValue(q,D,it),writeMonthYearValue(L,_,it);let P=[],B=[],H=new Map,V=!0,x=null;const yt=document.getElementById("salary-history-actions-head"),pt=document.getElementById("salary-detail-actions-head");yt&&(yt.textContent=a?"Actions":"Slip"),pt&&(pt.hidden=!a);async function Ct(e,n){if(e?.id){const{data:c,error:h}=await supabaseClient.from("expenses").select("id").eq("salary_payment_id",e.id).limit(1);if(!h&&c?.length){const{error:p}=await supabaseClient.from("expenses").delete().eq("id",c[0].id);p&&AppError.report(p,{context:"deleteLinkedSalaryExpenseById"});return}h&&!isMissingSalaryPaymentIdColumn(h)&&AppError.report(h,{context:"deleteLinkedSalaryExpenseLookupById"})}const r=salaryExpenseDescription(n,e.note),{data:o,error:i}=await supabaseClient.from("expenses").select("id").eq("category","salary").eq("date",e.date).eq("amount",e.amount).eq("description",r).limit(1);if(i){AppError.report(i,{context:"deleteLinkedSalaryExpenseLookup"});return}if(!o?.length)return;const{error:y}=await supabaseClient.from("expenses").delete().eq("id",o[0].id);y&&AppError.report(y,{context:"deleteLinkedSalaryExpense"})}async function xt(e,n){if(!a){alert("Only an admin can delete salary payments.");return}if(!e?.id)return;const r=n?.name||"this staff member";if(!confirm(`Delete salary payment of ${formatCurrency(e.amount)} for ${r} on ${formatDisplayDate(e.date)}?

The linked expense entry will also be removed. This cannot be undone.`))return;const{error:i}=await supabaseClient.from("salary_payments").delete().eq("id",e.id);if(i){alert(AppError.getUserMessage(i)),AppError.report(i,{context:"deleteSalaryPayment",id:e.id});return}await Ct(e,n),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational"),await tt()}function ut(e){!a||!e||e.dataset.salaryDeleteBound==="1"||(e.dataset.salaryDeleteBound="1",e.addEventListener("click",async n=>{const r=n.target.closest(".salary-delete-btn");if(!r)return;n.stopPropagation(),n.preventDefault();const o=r.getAttribute("data-payment-id"),i=B.find(c=>c.id===o)||await(async()=>{const c=ft();return(await $t(c)).find(p=>p.id===o)})();if(!i){alert("Payment not found. Refresh the page and try again.");return}const y=P.find(c=>c.id===i.employee_id);r.disabled=!0;try{await xt(i,y)}finally{r.disabled=!1}}))}function A(){return readMonthYearValue(F,U)||it}function ot(){return readMonthYearValue(L,_)||A()}function ft(){return readMonthYearValue(q,D)||A()}function wt(){writeMonthYearValue(q,D,A())}function Z(e){R&&(x=e,ht(e,A()),R.setAttribute("aria-hidden","false"),document.body.classList.add("modal-open"))}function Q(){R&&(R.setAttribute("aria-hidden","true"),document.body.classList.remove("modal-open"),x=null,document.querySelectorAll(".salary-summary-table tbody tr.is-selected").forEach(e=>{e.classList.remove("is-selected")}))}function ht(e,n){const r=P.find(b=>b.id===e);if(!r)return;const i=paidByStaffInRange(B).get(e)||0,y=H.get(e)||null,c=getStaffSalaryMonthContext(r,i,y),h=paymentsForEmployee(B,e),p=formatMonthLabel(n),g=document.getElementById("salary-detail-title"),M=document.getElementById("salary-detail-subtitle"),E=document.getElementById("salary-detail-stats"),m=document.getElementById("salary-detail-payments-body");if(g&&(g.textContent=r.name),M&&(M.textContent=`${r.role_display||"Staff"} \xB7 ${p}`),W)if(c.isNa){const b=y?.note?.trim();I&&(I.textContent=b?`Not applicable for ${p} \u2014 ${b}`:`Not applicable for ${p}. Excluded from payroll totals.`),W.classList.remove("hidden")}else W.classList.add("hidden"),I&&(I.textContent="");G&&G.classList.toggle("hidden",!a||!V||c.isNa),rt&&(rt.value="",rt.disabled=!1),K&&K.classList.remove("hidden"),z&&z.classList.toggle("hidden",!c.isNa||!a);const $=c.isNa?"\u2014":formatCurrency(c.pending),S=c.isNa||c.pending<=.009?"salary-detail-balance is-clear":"salary-detail-balance",v=computePfBreakdown(r.monthly_salary,r),C=r.pf_number?.trim();if(E&&(E.innerHTML=`
        <div><dt>Gross salary</dt><dd>${c.isNa?"\u2014":formatCurrency(r.monthly_salary)}</dd></div>
        <div><dt>Net (after PF)</dt><dd>${c.isNa?"\u2014":formatCurrency(v.netSalary)}</dd></div>
        <div><dt>PF contribution</dt><dd>${c.isNa?"\u2014":v.fixedAmount>0?formatCurrency(v.fixedAmount):'<span class="muted">Not set \u2014 <a href="staff.html">Staff</a></span>'}</dd></div>
        <div><dt>Employer PF</dt><dd>${c.isNa?"\u2014":formatCurrency(v.employerPf)}</dd></div>
        <div><dt>PF / UAN</dt><dd>${C?escapeHtml(C):'<span class="muted">Not set</span>'}</dd></div>
        <div><dt>Mobile</dt><dd>${r.phone_number?escapeHtml(r.phone_number):'<span class="muted">\u2014</span>'}</dd></div>
        <div><dt>Paid this month</dt><dd>${formatCurrency(i)}</dd></div>
        <div><dt>Remaining</dt><dd class="${S}">${$}</dd></div>
        <div><dt>Status</dt><dd><span class="salary-status ${c.className}">${escapeHtml(c.label)}</span></dd></div>
      `),m){const b=a?4:3;h.length?m.innerHTML=h.map(T=>`
          <tr>
            <td>${escapeHtml(formatDisplayDate(T.date))}</td>
            <td class="num">${formatCurrency(T.amount)}</td>
            <td>${escapeHtml(T.note??"\u2014")}</td>
            ${a?`<td class="table-actions">${salaryDeleteButtonHtml(T,r,!0)}</td>`:""}
          </tr>`).join(""):m.innerHTML=`<tr><td colspan="${b}" class="muted">No payments recorded for this month.</td></tr>`}Y&&(Y.disabled=c.isNa,Y.title=c.isNa?"Salary slip is not available for N/A months":"",Y.onclick=async()=>{if(!c.isNa)try{await runSalarySlipPrint(r,h,n)}catch(b){AppError.report(b,{context:"printSalarySlip"}),alert(AppError.getUserMessage(b)||"Could not open the print dialog.")}}),j&&(j.disabled=c.isNa,j.title=c.isNa?"Restore this month before recording payment":"")}async function gt(){try{P=await StaffEmployees.loadActiveEmployees(supabaseClient,{isAdmin:a,useCache:!0})}catch(e){AppError.report(e,{context:"loadStaffMembers"}),P=[]}return P}function At(e,n=!0){if(!e)return;const r=e.value;e.innerHTML=n?'<option value="">Select staff</option>':"",P.forEach(o=>{const i=document.createElement("option");i.value=o.id,i.textContent=`${o.name}${o.role_display?` (${o.role_display})`:""}`,e.appendChild(i)}),r&&P.some(o=>o.id===r)&&(e.value=r)}async function Lt(e,n){const{data:r,error:o}=await supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").gte("date",e).lte("date",n).order("date",{ascending:!1});if(o){if(isMissingSalaryMonthColumn(o)){const{data:i,error:y}=await supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note").gte("date",e).lte("date",n).order("date",{ascending:!1});return y?(AppError.report(y,{context:"loadPaymentsInRange"}),[]):i??[]}return AppError.report(o,{context:"loadPaymentsInRange"}),[]}return r??[]}async function J(e){const n=normalizeSalaryMonth(e);if(!n)return[];const{data:r,error:o}=await supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").eq("salary_month",n).order("date",{ascending:!1});if(o){if(isMissingSalaryMonthColumn(o)){const[i,y]=e.split("-").map(Number),{start:c,end:h}=getMonthRange(i,y-1);return Lt(c,h)}return AppError.report(o,{context:"loadPaymentsForSalaryMonth"}),[]}return r??[]}async function bt(e){if(!V)return new Map;const n=normalizeSalaryMonth(e);if(!n)return new Map;const{data:r,error:o}=await supabaseClient.from("salary_month_exclusions").select("id, employee_id, note, salary_month").eq("salary_month",n);return o?isMissingSalaryMonthExclusionsTable(o)?(V=!1,new Map):(AppError.report(o,{context:"loadSalaryMonthExclusions"}),new Map):new Map((r??[]).map(i=>[i.employee_id,i]))}async function _t(e,n,r){if(!a)return alert("Only an admin can mark a salary month as not applicable."),!1;if(!V)return alert("Salary month exclusions are not available yet. Apply the latest database migration."),!1;const o=P.find(M=>M.id===e);if(!o)return!1;const i=normalizeSalaryMonth(n);if(!i)return!1;const y=paidByStaffInRange(B).get(e)||0,c=formatMonthLabel(n);let h=`Mark ${o.name} as not applicable for ${c}?

They will be excluded from payroll totals for this month.`;if(y>.009&&(h+=`

${formatCurrency(y)} is already recorded for this month. Payments stay in history but the month remains excluded from totals.`),!confirm(h))return!1;const p={employee_id:e,salary_month:i,note:r?.trim()||null};t.session?.user?.id&&(p.created_by=t.session.user.id);const{error:g}=await supabaseClient.from("salary_month_exclusions").upsert(p,{onConflict:"employee_id,salary_month"});return g?(alert(AppError.getUserMessage(g)),AppError.report(g,{context:"markSalaryMonthNa",staffId:e,monthValue:n}),!1):(typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational"),await tt(),!0)}async function It(e,n){if(!a)return alert("Only an admin can restore a salary month."),!1;if(!V)return!1;const r=P.find(c=>c.id===e);if(!r)return!1;const o=normalizeSalaryMonth(n);if(!o)return!1;const i=formatMonthLabel(n);if(!confirm(`Restore ${r.name} for ${i}?

They will rejoin payroll totals for this month based on their configured salary.`))return!1;const{error:y}=await supabaseClient.from("salary_month_exclusions").delete().eq("employee_id",e).eq("salary_month",o);return y?(alert(AppError.getUserMessage(y)),AppError.report(y,{context:"restoreSalaryMonth",staffId:e,monthValue:n}),!1):(typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational"),await tt(),!0)}async function dt(e){return e===A()&&B.length?B:J(e)}async function X(){if(!k)return;const e=u?.value,n=ot();if(!e||!n){k.classList.add("hidden");return}const r=P.find(g=>g.id===e);if(!r)return;const o=H.get(e);if(o){k.textContent=`${formatMonthLabel(n)}: marked not applicable${o.note?.trim()?` (${o.note.trim()})`:""}. Restore the month in salary details before recording payment.`,k.classList.remove("hidden");return}const i=await dt(n),y=getStaffBalanceForMonth(e,i,P);if(!y)return;const c=computePfBreakdown(r.monthly_salary,r),h=formatMonthLabel(n);let p;y.salary<=0?p="no salary configured":y.status.advance>.009?p=`advance ${formatCurrency(y.status.advance)} paid`:y.pending<=.009?p="fully paid":p=`${formatCurrency(y.pending)} remaining`,k.textContent=`${h}: net ${formatCurrency(c.netSalary)} \xB7 ${formatCurrency(y.paid)} paid \xB7 ${p}`,k.classList.remove("hidden")}async function St(){const e=u?.value;if(!e){l&&(l.textContent="Select a staff member first.",l.classList.remove("hidden"));return}l?.classList.add("hidden");const n=ot(),r=await dt(n),o=getStaffBalanceForMonth(e,r,P);if(!o||o.pending<=.009){N&&(N.value="");return}N&&(N.value=o.pending.toFixed(2))}async function vt(e){const n=document.getElementById("salary-summary-body"),r=document.getElementById("salary-kpi-payroll"),o=document.getElementById("salary-kpi-paid"),i=document.getElementById("salary-kpi-pending");if(!n)return;if(!P.length){n.innerHTML='<tr><td colspan="7" class="muted">Add staff in <a href="staff.html">HR \u2192 Staff</a> first.</td></tr>',r&&(r.textContent="\u2014"),o&&(o.textContent="\u2014"),i&&(i.textContent="\u2014");return}B=await J(e),H=await bt(e);const y=paidByStaffInRange(B);let c=0,h=0,p=0,g=0;P.forEach(m=>{if(H.get(m.id)){g+=1;return}const S=Number(m.monthly_salary??0),v=y.get(m.id)||0,{salary:C,pending:b}=computeSalaryBalance(S,v,m);c+=C,h+=v,p+=b}),r&&(r.textContent=formatCurrency(c)),o&&(o.textContent=formatCurrency(h)),i&&(i.textContent=formatCurrency(p));const M=document.querySelector(".salary-kpi-grid");let E=document.getElementById("salary-kpi-note");g>0?(!E&&M&&(E=document.createElement("p"),E.id="salary-kpi-note",E.className="muted salary-kpi-note",M.insertAdjacentElement("afterend",E)),E&&(E.textContent=`${g} staff excluded as not applicable for ${formatMonthLabel(e)}.`,E.classList.remove("hidden"))):E&&(E.classList.add("hidden"),E.textContent=""),n.innerHTML=P.map(m=>{const $=y.get(m.id)||0,S=H.get(m.id)||null,v=getStaffSalaryMonthContext(m,$,S),C=v.isNa?"\u2014":v.advance>.009?`<span class="muted">Advance ${formatCurrency(v.advance)}</span>`:formatCurrency(v.pending),b=escapeHtml(m.name),T=escapeHtml(m.role_display??"\u2014"),lt=v.isNa?"salary-row--na":"",et=v.isNa?' disabled title="Month marked not applicable"':"",w=v.isNa?' disabled title="Salary slip not available for N/A months"':"";return`
          <tr data-staff-id="${escapeHtml(m.id)}" class="${lt}" tabindex="0" role="button" aria-label="View ${b} salary details">
            <td>${b}</td>
            <td>${T}</td>
            <td class="num">${formatSalaryAmount(v.payable)}</td>
            <td class="num">${formatCurrency($)}</td>
            <td class="num">${C}</td>
            <td><span class="salary-status ${v.className}">${escapeHtml(v.label)}</span></td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small salary-view-btn" data-staff-id="${escapeHtml(m.id)}">Details</button>
              <button type="button" class="button-secondary button-small salary-slip-btn" data-staff-id="${escapeHtml(m.id)}"${w}>Slip</button>
              <button type="button" class="button-secondary button-small add-payment-btn" data-staff-id="${escapeHtml(m.id)}"${et}>Pay</button>
            </td>
          </tr>
        `}).join(""),n.querySelectorAll("tr[data-staff-id]").forEach(m=>{const $=m.getAttribute("data-staff-id");m.addEventListener("click",S=>{S.target.closest("button")||(Z($),n.querySelectorAll("tr.is-selected").forEach(v=>v.classList.remove("is-selected")),m.classList.add("is-selected"))}),m.addEventListener("keydown",S=>{(S.key==="Enter"||S.key===" ")&&(S.preventDefault(),Z($))})}),n.querySelectorAll(".salary-view-btn").forEach(m=>{m.addEventListener("click",$=>{$.stopPropagation(),Z(m.getAttribute("data-staff-id"))})}),n.querySelectorAll(".salary-slip-btn").forEach(m=>{m.addEventListener("click",async $=>{if($.stopPropagation(),m.disabled)return;const S=m.getAttribute("data-staff-id"),v=P.find(b=>b.id===S);if(!v||H.has(S))return;const C=paymentsForEmployee(B,S);try{await runSalarySlipPrint(v,C,e)}catch(b){AppError.report(b,{context:"printSalarySlipQuick"}),alert(AppError.getUserMessage(b)||"Could not open the print dialog.")}})}),n.querySelectorAll(".add-payment-btn").forEach(m=>{m.addEventListener("click",$=>{if($.stopPropagation(),m.disabled)return;const S=m.getAttribute("data-staff-id");if(H.has(S)){alert("This month is marked not applicable. Open details and restore the month before recording payment.");return}Et(S)})}),x&&ht(x,e),X()}function Et(e,n={}){const r=n.salaryMonth||A();u&&(u.value=e),writeMonthYearValue(L,_,r),f&&(f.value=suggestPaymentDate(r)),N&&(N.value=""),X().then(()=>St()),document.querySelector('.settings-nav-item[data-section="record"]')?.click(),s?.scrollIntoView({behavior:"smooth"})}async function ct(e){const n=document.getElementById("salary-payments-body");if(!n)return;const r=await J(e);if(!r.length){n.innerHTML=`<tr><td colspan="5" class="muted">No payments for ${escapeHtml(formatMonthLabel(e))} salary.</td></tr>`;return}const o=new Map(P.map(i=>[i.id,i]));n.innerHTML=r.map(i=>{const y=o.get(i.employee_id),c=y?escapeHtml(y.name):"\u2014",h=i.employee_id;return`
          <tr>
            <td>${escapeHtml(formatDisplayDate(i.date))}</td>
            <td>${c}</td>
            <td class="num">${formatCurrency(i.amount)}</td>
            <td>${escapeHtml(i.note??"\u2014")}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small history-slip-btn" data-staff-id="${escapeHtml(h)}">Slip</button>
              ${salaryDeleteButtonHtml(i,y,a)}
            </td>
          </tr>
        `}).join(""),n.querySelectorAll(".history-slip-btn").forEach(i=>{i.addEventListener("click",async()=>{const y=i.getAttribute("data-staff-id"),c=P.find(g=>g.id===y);if(!c)return;const h=await $t(e),p=paymentsForEmployee(h,y);try{await runSalarySlipPrint(c,p,e)}catch(g){AppError.report(g,{context:"printHistorySlip"}),alert(AppError.getUserMessage(g)||"Could not open the print dialog.")}})})}async function $t(e){return J(e)}async function tt(){await gt(),At(u);const e=A(),n=ft();e&&(await vt(e),await ct(n))}s&&s.addEventListener("submit",async e=>{e.preventDefault();const n=s.querySelector('button[type="submit"]');n&&(n.disabled=!0,n.textContent="Saving\u2026"),d?.classList.add("hidden"),l?.classList.add("hidden");const r=u?.value,o=f?.value,i=Number(N?.value||0),y=document.getElementById("payment-note")?.value?.trim()||null,c=ot(),h=normalizeSalaryMonth(c||o?.slice(0,7)),p=()=>{n&&(n.disabled=!1,n.textContent="Save payment")};if(!r){p(),l?.classList.remove("hidden"),l&&(l.textContent="Select a staff member.");return}if(!o){p(),l?.classList.remove("hidden"),l&&(l.textContent="Payment date is required.");return}if(o>getLocalDateString()){p(),l?.classList.remove("hidden"),l&&(l.textContent="Payment date cannot be in the future.");return}if(i<=0){p(),l?.classList.remove("hidden"),l&&(l.textContent="Amount must be greater than 0.");return}if(!h){p(),l?.classList.remove("hidden"),l&&(l.textContent="Select the salary month this payment applies to.");return}const g=P.find(w=>w.id===r);if(H.has(r)){p(),l?.classList.remove("hidden"),l&&(l.textContent=`${g?.name||"This staff member"} is marked not applicable for ${formatMonthLabel(c)}. Restore the month in salary details first.`);return}const M=await dt(c),E=getStaffBalanceForMonth(r,M,P);if(E&&E.salary>0&&i>E.pending+.009){const w=roundMoney(i-E.pending),kt=E.pending<=.009?`Net salary for ${formatMonthLabel(c)} is already settled. Record ${formatCurrency(i)} as advance?`:`Amount exceeds remaining balance (${formatCurrency(E.pending)}). This will overpay by ${formatCurrency(w)}. Continue?`;if(!confirm(kt)){p();return}}const m={employee_id:r,date:o,amount:i,note:y,salary_month:h};t.session?.user?.id&&(m.created_by=t.session.user.id);let $=null,S=null;if({data:$,error:S}=await supabaseClient.from("salary_payments").insert(m).select("id").single(),S&&isMissingSalaryMonthColumn(S)){const w={employee_id:r,date:o,amount:i,note:y};t.session?.user?.id&&(w.created_by=t.session.user.id),{data:$,error:S}=await supabaseClient.from("salary_payments").insert(w).select("id").single()}if(S){p(),AppError.handle(S,{target:l});return}const v=salaryExpenseDescription(g,y),C={date:o,category:"salary",description:v,amount:i};$?.id&&(C.salary_payment_id=$.id),t.session?.user?.id&&(C.created_by=t.session.user.id);let b=null;if({error:b}=await supabaseClient.from("expenses").insert(C),b&&isMissingSalaryPaymentIdColumn(b)&&(delete C.salary_payment_id,{error:b}=await supabaseClient.from("expenses").insert(C)),b){if($?.id){const{error:w}=await supabaseClient.from("salary_payments").delete().eq("id",$.id);w&&AppError.report(w,{context:"rollbackSalaryPaymentAfterExpenseFail",paymentId:$.id})}p(),AppError.handle(b,{target:l});return}p();const T=o,lt=c,et=r;finishRecordFormSave(s,{date:T},{date:RECORD_DATE_KEYS.salaryPayment}),lt&&writeMonthYearValue(L,_,lt),d?.classList.remove("hidden"),await tt(),u&&et&&P.some(w=>w.id===et)&&(u.value=et),X(),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational")}),u?.addEventListener("change",X),at?.addEventListener("click",St);function Pt(){const e=ot();f&&e&&(f.value=suggestPaymentDate(e)),X()}L?.addEventListener("change",Pt),_?.addEventListener("change",Pt);function Nt(e,n,r){if(!e||!n)return;const o=async()=>{const i=readMonthYearValue(e,n);i&&await r(i)};e.addEventListener("change",o),n.addEventListener("change",o)}Nt(F,U,async e=>{wt(),writeMonthYearValue(L,_,e),await vt(e),await ct(e)}),Nt(q,D,async e=>{await ct(e)});const Mt=document.getElementById("salary-download-csv");Mt&&Mt.addEventListener("click",async()=>{const e=A();if(!e)return;await gt();const n=await J(e),r=await bt(e),o=paidByStaffInRange(n),i=["Name","Role","Net monthly (\u20B9)","Paid this month (\u20B9)","Remaining (\u20B9)","Status","N/A reason"],y=P.map(g=>{const M=o.get(g.id)||0,E=r.get(g.id)||null,m=getStaffSalaryMonthContext(g,M,E),$=m.isNa?"N/A":m.advance>.009?`Advance ${m.advance}`:String(m.pending);return[String(g.name??"").replace(/"/g,'""'),String(g.role_display??"").replace(/"/g,'""'),m.isNa?"N/A":String(m.payable),String(M),$,m.label,String(E?.note??"").replace(/"/g,'""')]}),c=[i.join(","),...y.map(g=>g.map(M=>`"${M}"`).join(","))].join(`
`),h=new Blob(["\uFEFF"+c],{type:"text/csv;charset=utf-8"}),p=document.createElement("a");p.href=URL.createObjectURL(h),p.download=`salary-summary-${e}.csv`,p.click(),URL.revokeObjectURL(p.href)}),st?.addEventListener("click",Q),O?.addEventListener("click",Q),nt?.addEventListener("click",Q),j?.addEventListener("click",()=>{if(x){if(H.has(x)){alert("This month is marked not applicable. Restore it before recording payment.");return}Q(),Et(x)}}),K?.addEventListener("click",async()=>{if(x){K.disabled=!0;try{await _t(x,A(),rt?.value||"")&&Z(x,A())}finally{K.disabled=!1}}}),z?.addEventListener("click",async()=>{if(x){z.disabled=!0;try{await It(x,A())&&Z(x,A())}finally{z.disabled=!1}}}),document.addEventListener("keydown",e=>{e.key==="Escape"&&R?.getAttribute("aria-hidden")==="false"&&Q()}),ut(document.getElementById("salary-payments-body")),ut(document.getElementById("salary-detail-payments-body")),await tt()});
