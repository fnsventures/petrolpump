function normalizeSalaryMonth(t){if(!t)return"";const[a,n]=String(t).split("-");if(!a||!n)return"";const d=String(n).padStart(2,"0").slice(0,2);return`${a}-${d}-01`}function salaryMonthKey(t){const a=normalizeSalaryMonth(t);return a?a.slice(0,7):""}function suggestPaymentDate(t){const a=getLocalDateString(),n=salaryMonthKey(t),d=a.slice(0,7);if(!n||n===d)return a;if(n<d){const[i,m]=n.split("-").map(Number);return toLocalDateString(new Date(i,m,0))}return a}function isMissingSalaryMonthColumn(t){const a=String(t?.message||"");return/salary_month/i.test(a)||t?.code==="PGRST204"}function isMissingSalaryPaymentIdColumn(t){const a=String(t?.message||"");return/salary_payment_id/i.test(a)||t?.code==="PGRST204"}function getStaffSalaryMonthContext(t,a){const n=salaryStatusInfo(t.monthly_salary,a,t),{salary:d,pending:i}=computeSalaryBalance(t.monthly_salary,a,t);return{label:n.label,className:n.className,payable:d,pending:n.pending,advance:n.advance,paid:Number(a??0)}}function formatSalaryAmount(t){return t==null?"\u2014":formatCurrency(t)}function formatMonthLabel(t){if(!t)return"\u2014";const[a,n]=t.split("-").map(Number);return new Date(a,n-1,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"})}const SALARY_SLIP_PRINT_CSS="css/salary-slip-print.css?v=2";function slipAssetUrl(t){return new URL(t,window.location.href).href}function getPfSettings(){const t=PumpSettings.getStation(),a=AppConfig.DEFAULT_STATION;return{establishmentCode:(t.pfEstablishmentCode||a.pfEstablishmentCode||"").trim()}}function roundMoney(t){return Math.round(Number(t)*100)/100}function computePfBreakdown(t,a){const n=roundMoney(Math.max(0,Number(t??0))),d=roundMoney(Math.max(0,Number(a?.pf_contribution??0))),i=n>0?Math.min(d,n):0,m=d,p=roundMoney(Math.max(0,n-i));return{gross:n,employeePf:i,employerPf:m,netSalary:p,fixedAmount:d}}function getPayPeriodLabel(t){if(!t)return"\u2014";const[a,n]=t.split("-").map(Number),d=new Date(a,n-1,1),i=new Date(a,n,0),m=p=>p.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});return`${m(d)} \u2013 ${m(i)}`}const AMOUNT_WORDS_ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"],AMOUNT_WORDS_TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];function amountWordsUnder100(t){if(t<20)return AMOUNT_WORDS_ONES[t];const a=Math.floor(t/10),n=t%10;return`${AMOUNT_WORDS_TENS[a]}${n?` ${AMOUNT_WORDS_ONES[n]}`:""}`.trim()}function amountWordsUnder1000(t){if(t<100)return amountWordsUnder100(t);const a=Math.floor(t/100),n=t%100;return`${AMOUNT_WORDS_ONES[a]} Hundred${n?` ${amountWordsUnder100(n)}`:""}`.trim()}function amountWordsIndian(t){if(t===0)return"";if(t<1e3)return amountWordsUnder1000(t);if(t<1e5){const d=Math.floor(t/1e3),i=t%1e3;return`${amountWordsUnder1000(d)} Thousand${i?` ${amountWordsUnder1000(i)}`:""}`.trim()}if(t<1e7){const d=Math.floor(t/1e5),i=t%1e5;return`${amountWordsIndian(d)} Lakh${i?` ${amountWordsIndian(i)}`:""}`.trim()}const a=Math.floor(t/1e7),n=t%1e7;return`${amountWordsIndian(a)} Crore${n?` ${amountWordsIndian(n)}`:""}`.trim()}function amountInWordsINR(t){const a=roundMoney(Math.abs(Number(t)||0)),n=Math.floor(a),d=Math.round((a-n)*100);if(n===0&&d===0)return"Zero Rupees Only";let i=amountWordsIndian(n);return i=i?`${i} Rupees`:"Zero Rupees",d>0&&(i+=` and ${amountWordsIndian(d)} Paise`),`${i} Only`}function computeSalaryBalance(t,a,n){const d=Number(t??0),i=n?computePfBreakdown(d,n).netSalary:d,m=Number(a??0),p=Math.max(0,i-m),P=Math.max(0,m-i);return{salary:i,gross:d,totalPaid:m,pending:p,advance:P}}function salaryStatusInfo(t,a,n){const{salary:d,totalPaid:i,pending:m,advance:p}=computeSalaryBalance(t,a,n);return d<=0?{label:"No salary set",className:"salary-status--none",pending:m,advance:p}:p>.009?{label:"Advance paid",className:"salary-status--advance",pending:m,advance:p}:m<=.009?{label:"Fully paid",className:"salary-status--paid",pending:m,advance:p}:i>0?{label:"Partial",className:"salary-status--partial",pending:m,advance:p}:{label:"Unpaid",className:"salary-status--unpaid",pending:m,advance:p}}function paymentsForEmployee(t,a){return(t||[]).filter(n=>n.employee_id===a).sort((n,d)=>String(n.date).localeCompare(String(d.date)))}function salaryExpenseDescription(t,a){if(!t)return"Salary";const n=a!=null&&String(a).trim()!==""?String(a).trim():null;return`Salary: ${t.name}${n?` - ${n}`:""}`}function salaryDeleteButtonHtml(t,a,n){if(!n||!t?.id)return"";const d=a?.name||"staff";return AdminDelete.buttonHtml({selector:"salary-delete-btn",data:{paymentId:t.id,staffName:d,date:t.date,amount:t.amount},title:"Delete payment (admin)"})}function getStaffBalanceForMonth(t,a,n){const d=(n||[]).find(P=>P.id===t);if(!d)return null;const m=paidByStaffInRange(a).get(t)||0,p=computeSalaryBalance(d.monthly_salary,m,d);return{staff:d,paid:m,...p,status:salaryStatusInfo(d.monthly_salary,m,d)}}function paidByStaffInRange(t){const a=new Map;return(t||[]).forEach(n=>{const d=n.employee_id;a.set(d,(a.get(d)||0)+Number(n.amount??0))}),a}function buildSlipRef(t,a){const n=String(t||"").replace(/-/g,"").slice(0,8).toUpperCase();return`SAL-${a.replace("-","")}-${n}`}function buildSalarySlipHtml(t,a,n){const d=formatMonthLabel(n),i=getPayPeriodLabel(n),m=a.reduce((I,S)=>I+Number(S.amount??0),0),p=computePfBreakdown(t.monthly_salary,t),{pending:P,advance:V}=computeSalaryBalance(t.monthly_salary,m,t),L=PumpSettings.getStationGstin(),x=getPfSettings(),D=PumpSettings.getStationAddress(),k=PumpSettings.getStationContactLine(),R=buildSlipRef(t.id,n),T=formatDisplayDate(getLocalDateString()),N=t.pf_number?.trim()||"",_=t.pan_number?.trim()||"",W=t.phone_number?.trim()||"",K=t.address?.trim()||"",F=[];L&&F.push(`<span>GSTIN: ${escapeHtml(L)}</span>`),x.establishmentCode&&F.push(`<span>PF Est. code: ${escapeHtml(x.establishmentCode)}</span>`);const U=a.length?a.map((I,S)=>`
        <tr>
          <td>${S+1}</td>
          <td>${escapeHtml(formatDisplayDate(I.date))}</td>
          <td class="num">\u20B9 ${formatNumberPlain(I.amount)}</td>
          <td>${escapeHtml(I.note||"\u2014")}</td>
        </tr>`).join(""):'<tr><td colspan="4" style="text-align:center;color:#64748b">No salary disbursements recorded for this month</td></tr>',Y=V>.009?`<tr class="salary-slip-summary-balance"><td>Advance paid (over net salary)</td><td>\u20B9 ${formatNumberPlain(V)}</td></tr>`:P>.009?`<tr class="salary-slip-summary-balance"><td>Balance payable (net)</td><td>\u20B9 ${formatNumberPlain(P)}</td></tr>`:'<tr class="salary-slip-summary-paid"><td>Balance payable (net)</td><td>\u20B9 0.00 \u2014 Settled</td></tr>',z=p.employerPf>0?`
      <div class="salary-slip-employer">
        <p class="salary-slip-employer-title">Employer contribution (statutory)</p>
        <table>
          <tr>
            <td>Employer PF (fixed monthly)</td>
            <td>\u20B9 ${formatNumberPlain(p.employerPf)}</td>
          </tr>
        </table>
        <p style="margin:3pt 0 0;font-size:6.8pt;color:#64748b">Employer PF is deposited to EPFO separately and is not deducted from employee take-home pay.</p>
      </div>`:"";return`
    <article class="salary-slip-sheet" data-slip-ref="${escapeHtml(R)}">
      <header class="salary-slip-head">
        <div class="salary-slip-letterhead">
          <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo salary-slip-logo" width="128" height="128" />
          <div class="salary-slip-letterhead-text">
            <h1 class="salary-slip-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
            <p class="salary-slip-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
            ${D?`<p class="salary-slip-address">${escapeHtml(D)}</p>`:""}
            ${k?`<p class="salary-slip-contact">${escapeHtml(k)}</p>`:""}
            ${F.length?`<p class="salary-slip-statutory">${F.join("")}</p>`:""}
          </div>
        </div>
      </header>

      <div class="salary-slip-title-band">
        <h2 class="salary-slip-doc-title">Salary slip</h2>
        <p class="salary-slip-doc-meta">
          <strong>Slip no.</strong> ${escapeHtml(R)} &nbsp;\xB7&nbsp;
          <strong>Pay period</strong> ${escapeHtml(i)} &nbsp;\xB7&nbsp;
          <strong>Generated</strong> ${escapeHtml(T)}
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
          <dd class="salary-slip-mono">${N?escapeHtml(N):"\u2014"}</dd>
        </div>
        <div>
          <dt>PAN</dt>
          <dd class="salary-slip-mono">${_?escapeHtml(_):"\u2014"}</dd>
        </div>
        <div>
          <dt>Mobile</dt>
          <dd>${W?escapeHtml(W):"\u2014"}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>${K?escapeHtml(K):"\u2014"}</dd>
        </div>
        <div>
          <dt>PF wage (gross)</dt>
          <dd>\u20B9 ${formatNumberPlain(p.gross)}</dd>
        </div>
      </dl>

      <div class="salary-slip-pay-grid">
        <div class="salary-slip-pay-col">
          <p class="salary-slip-pay-col-title">Earnings</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Gross salary</td>
              <td>\u20B9 ${formatNumberPlain(p.gross)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total earnings</td>
              <td>\u20B9 ${formatNumberPlain(p.gross)}</td>
            </tr>
          </table>
        </div>
        <div class="salary-slip-pay-col salary-slip-pay-col--deductions">
          <p class="salary-slip-pay-col-title">Deductions</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Employee PF (fixed monthly)</td>
              <td>\u20B9 ${formatNumberPlain(p.employeePf)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total deductions</td>
              <td>\u20B9 ${formatNumberPlain(p.employeePf)}</td>
            </tr>
          </table>
        </div>
      </div>

      ${z}

      <div class="salary-slip-net-box">
        <span class="salary-slip-net-label">Net salary (take-home)</span>
        <span class="salary-slip-net-amount">\u20B9 ${formatNumberPlain(p.netSalary)}</span>
      </div>
      <p class="salary-slip-words"><strong>In words:</strong> ${escapeHtml(amountInWordsINR(p.netSalary))}</p>

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
        <tbody>${U}</tbody>
        <tfoot>
          <tr>
            <td colspan="2">Total disbursed</td>
            <td class="num">\u20B9 ${formatNumberPlain(m)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <table class="salary-slip-summary">
        <tr class="salary-slip-summary-net">
          <td>Net salary for month</td>
          <td>\u20B9 ${formatNumberPlain(p.netSalary)}</td>
        </tr>
        <tr class="salary-slip-summary-total">
          <td>Total disbursed this month</td>
          <td>\u20B9 ${formatNumberPlain(m)}</td>
        </tr>
        ${Y}
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
    </article>`}let salarySlipPrintCssCache=null;async function getSalarySlipPrintCssText(){if(salarySlipPrintCssCache)return salarySlipPrintCssCache;const t=slipAssetUrl(SALARY_SLIP_PRINT_CSS),a=await fetch(t,{cache:"default"});if(!a.ok)throw new Error("Could not load salary slip print styles.");return salarySlipPrintCssCache=await a.text(),salarySlipPrintCssCache}async function runSalarySlipPrint(t,a,n){const[d,i]=await Promise.all([Promise.resolve(buildSalarySlipHtml(t,a,n)),getSalarySlipPrintCssText()]);await PrintUtils.printInIframe({title:PrintUtils.buildPrintFilename("salary-slip",t.name||"staff",n),bodyHtml:d,cssText:i,iframeTitle:"Salary slip print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}document.addEventListener("DOMContentLoaded",async()=>{const t=await requireAuth({allowedRoles:["admin","supervisor"],onDenied:"dashboard.html",pageName:"salary"});if(!t)return;applyRoleVisibility(t.role);const a=t.role==="admin";typeof loadPumpSettings=="function"&&await loadPumpSettings(),typeof initPageSections=="function"&&initPageSections({defaultSection:"summary",validSections:["summary","record","recent"]});const n=document.getElementById("salary-payment-form"),d=document.getElementById("salary-payment-success"),i=document.getElementById("salary-payment-error"),m=document.getElementById("payment-staff"),p=document.getElementById("payment-date"),P=document.getElementById("payment-amount"),V=document.getElementById("payment-fill-remaining"),L=document.getElementById("payment-salary-month-month"),x=document.getElementById("payment-salary-month-year"),D=document.getElementById("payment-month-hint"),k=document.getElementById("salary-month-month"),R=document.getElementById("salary-month-year"),T=document.getElementById("salary-history-month-month"),N=document.getElementById("salary-history-month-year"),_=document.getElementById("salary-detail-overlay"),W=document.getElementById("salary-detail-backdrop"),K=document.getElementById("salary-detail-close"),F=document.getElementById("salary-detail-dismiss"),U=document.getElementById("salary-detail-print-slip"),Y=document.getElementById("salary-detail-add-payment");p&&initPersistedDateInput(p,RECORD_DATE_KEYS.salaryPayment);const z=new Date,I=`${z.getFullYear()}-${String(z.getMonth()+1).padStart(2,"0")}`;populateMonthYearSelects(k,R),populateMonthYearSelects(T,N),populateMonthYearSelects(L,x),writeMonthYearValue(k,R,I),writeMonthYearValue(T,N,I),writeMonthYearValue(L,x,I);let S=[],H=[],q=null;const at=document.getElementById("salary-history-actions-head"),nt=document.getElementById("salary-detail-actions-head");at&&(at.textContent=a?"Actions":"Slip"),nt&&(nt.hidden=!a);async function ht(e,s){if(e?.id){const{data:f,error:h}=await supabaseClient.from("expenses").select("id").eq("salary_payment_id",e.id).limit(1);if(!h&&f?.length){const{error:u}=await supabaseClient.from("expenses").delete().eq("id",f[0].id);u&&AppError.report(u,{context:"deleteLinkedSalaryExpenseById"});return}h&&!isMissingSalaryPaymentIdColumn(h)&&AppError.report(h,{context:"deleteLinkedSalaryExpenseLookupById"})}const r=salaryExpenseDescription(s,e.note),{data:l,error:o}=await supabaseClient.from("expenses").select("id").eq("category","salary").eq("date",e.date).eq("amount",e.amount).eq("description",r).limit(1);if(o){AppError.report(o,{context:"deleteLinkedSalaryExpenseLookup"});return}if(!l?.length)return;const{error:y}=await supabaseClient.from("expenses").delete().eq("id",l[0].id);y&&AppError.report(y,{context:"deleteLinkedSalaryExpense"})}async function gt(e,s){if(!a){alert("Only an admin can delete salary payments.");return}if(!e?.id)return;const r=s?.name||"this staff member";if(!confirm(`Delete salary payment of ${formatCurrency(e.amount)} for ${r} on ${formatDisplayDate(e.date)}?

The linked expense entry will also be removed. This cannot be undone.`))return;const{error:o}=await supabaseClient.from("salary_payments").delete().eq("id",e.id);if(o){alert(AppError.getUserMessage(o)),AppError.report(o,{context:"deleteSalaryPayment",id:e.id});return}await ht(e,s),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational"),await tt()}function st(e){!a||!e||e.dataset.salaryDeleteBound==="1"||(e.dataset.salaryDeleteBound="1",e.addEventListener("click",async s=>{const r=s.target.closest(".salary-delete-btn");if(!r)return;s.stopPropagation(),s.preventDefault();const l=r.getAttribute("data-payment-id"),o=H.find(f=>f.id===l)||await(async()=>{const f=rt();return(await mt(f)).find(u=>u.id===l)})();if(!o){alert("Payment not found. Refresh the page and try again.");return}const y=S.find(f=>f.id===o.employee_id);r.disabled=!0;try{await gt(o,y)}finally{r.disabled=!1}}))}function B(){return readMonthYearValue(k,R)||I}function Z(){return readMonthYearValue(L,x)||B()}function rt(){return readMonthYearValue(T,N)||B()}function bt(){writeMonthYearValue(T,N,B())}function Q(e){_&&(q=e,ot(e,B()),_.setAttribute("aria-hidden","false"),document.body.classList.add("modal-open"))}function O(){_&&(_.setAttribute("aria-hidden","true"),document.body.classList.remove("modal-open"),q=null,document.querySelectorAll(".salary-summary-table tbody tr.is-selected").forEach(e=>{e.classList.remove("is-selected")}))}function ot(e,s){const r=S.find(C=>C.id===e);if(!r)return;const o=paidByStaffInRange(H).get(e)||0,y=getStaffSalaryMonthContext(r,o),f=paymentsForEmployee(H,e),h=formatMonthLabel(s),u=document.getElementById("salary-detail-title"),$=document.getElementById("salary-detail-subtitle"),c=document.getElementById("salary-detail-stats"),g=document.getElementById("salary-detail-payments-body");u&&(u.textContent=r.name),$&&($.textContent=`${r.role_display||"Staff"} \xB7 ${h}`);const b=formatCurrency(y.pending),v=y.pending<=.009?"salary-detail-balance is-clear":"salary-detail-balance",E=computePfBreakdown(r.monthly_salary,r),M=r.pf_number?.trim();if(c&&(c.innerHTML=`
        <div><dt>Gross salary</dt><dd>${formatCurrency(r.monthly_salary)}</dd></div>
        <div><dt>Net (after PF)</dt><dd>${formatCurrency(E.netSalary)}</dd></div>
        <div><dt>PF contribution</dt><dd>${E.fixedAmount>0?formatCurrency(E.fixedAmount):'<span class="muted">Not set \u2014 <a href="staff.html">Staff</a></span>'}</dd></div>
        <div><dt>Employer PF</dt><dd>${formatCurrency(E.employerPf)}</dd></div>
        <div><dt>PF / UAN</dt><dd>${M?escapeHtml(M):'<span class="muted">Not set</span>'}</dd></div>
        <div><dt>Mobile</dt><dd>${r.phone_number?escapeHtml(r.phone_number):'<span class="muted">\u2014</span>'}</dd></div>
        <div><dt>Paid this month</dt><dd>${formatCurrency(o)}</dd></div>
        <div><dt>Remaining</dt><dd class="${v}">${b}</dd></div>
        <div><dt>Status</dt><dd><span class="salary-status ${y.className}">${escapeHtml(y.label)}</span></dd></div>
      `),g){const C=a?4:3;f.length?g.innerHTML=f.map(w=>`
          <tr>
            <td>${escapeHtml(formatDisplayDate(w.date))}</td>
            <td class="num">${formatCurrency(w.amount)}</td>
            <td>${escapeHtml(w.note??"\u2014")}</td>
            ${a?`<td class="table-actions">${salaryDeleteButtonHtml(w,r,!0)}</td>`:""}
          </tr>`).join(""):g.innerHTML=`<tr><td colspan="${C}" class="muted">No payments recorded for this month.</td></tr>`}U&&(U.disabled=!1,U.title="",U.onclick=async()=>{try{await runSalarySlipPrint(r,f,s)}catch(C){AppError.report(C,{context:"printSalarySlip"}),alert(AppError.getUserMessage(C)||"Could not open the print dialog.")}}),Y&&(Y.disabled=!1,Y.title="")}async function lt(){try{S=await StaffEmployees.loadActiveEmployees(supabaseClient,{isAdmin:a,useCache:!0})}catch(e){AppError.report(e,{context:"loadStaffMembers"}),S=[]}return S}async function St(e){const s=new Map(S.map(l=>[l.id,l])),r=[...new Set((e||[]).filter(l=>l&&!s.has(l)))];if(!r.length)return s;try{(await StaffEmployees.resolveEmployeesByIds(supabaseClient,r)).forEach((o,y)=>s.set(y,o))}catch(l){AppError.report(l,{context:"staffMapForIds"})}return s}function vt(e,s=!0){if(!e)return;const r=e.value;e.innerHTML=s?'<option value="">Select staff</option>':"",S.forEach(l=>{const o=document.createElement("option");o.value=l.id,o.textContent=`${l.name}${l.role_display?` (${l.role_display})`:""}`,e.appendChild(o)}),r&&S.some(l=>l.id===r)&&(e.value=r)}async function Et(e,s){const{data:r,error:l}=await supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").gte("date",e).lte("date",s).order("date",{ascending:!1});if(l){if(isMissingSalaryMonthColumn(l)){const{data:o,error:y}=await supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note").gte("date",e).lte("date",s).order("date",{ascending:!1});return y?(AppError.report(y,{context:"loadPaymentsInRange"}),[]):o??[]}return AppError.report(l,{context:"loadPaymentsInRange"}),[]}return r??[]}async function j(e){const s=normalizeSalaryMonth(e);if(!s)return[];const{data:r,error:l}=await supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").eq("salary_month",s).order("date",{ascending:!1});if(l){if(isMissingSalaryMonthColumn(l)){const[o,y]=e.split("-").map(Number),{start:f,end:h}=getMonthRange(o,y-1);return Et(f,h)}return AppError.report(l,{context:"loadPaymentsForSalaryMonth"}),[]}return r??[]}async function J(e){return e===B()&&H.length?H:j(e)}async function G(){if(!D)return;const e=m?.value,s=Z();if(!e||!s){D.classList.add("hidden");return}const r=S.find(u=>u.id===e);if(!r)return;const l=await J(s),o=getStaffBalanceForMonth(e,l,S);if(!o)return;const y=computePfBreakdown(r.monthly_salary,r),f=formatMonthLabel(s);let h;o.salary<=0?h="no salary configured":o.status.advance>.009?h=`advance ${formatCurrency(o.status.advance)} paid`:o.pending<=.009?h="fully paid":h=`${formatCurrency(o.pending)} remaining`,D.textContent=`${f}: net ${formatCurrency(y.netSalary)} \xB7 ${formatCurrency(o.paid)} paid \xB7 ${h}`,D.classList.remove("hidden")}async function it(){const e=m?.value;if(!e){i&&(i.textContent="Select a staff member first.",i.classList.remove("hidden"));return}i?.classList.add("hidden");const s=Z(),r=await J(s),l=getStaffBalanceForMonth(e,r,S);if(!l||l.pending<=.009){P&&(P.value="");return}P&&(P.value=l.pending.toFixed(2))}async function dt(e){const s=document.getElementById("salary-summary-body"),r=document.getElementById("salary-kpi-payroll"),l=document.getElementById("salary-kpi-paid"),o=document.getElementById("salary-kpi-pending");if(!s)return;if(!S.length){s.innerHTML='<tr><td colspan="7" class="muted">Add staff in <a href="staff.html">HR \u2192 Staff</a> first.</td></tr>',r&&(r.textContent="\u2014"),l&&(l.textContent="\u2014"),o&&(o.textContent="\u2014");return}H=await j(e);const y=paidByStaffInRange(H);let f=0,h=0,u=0;S.forEach(c=>{const g=Number(c.monthly_salary??0),b=y.get(c.id)||0,{salary:v,pending:E}=computeSalaryBalance(g,b,c);f+=v,h+=b,u+=E}),r&&(r.textContent=formatCurrency(f)),l&&(l.textContent=formatCurrency(h)),o&&(o.textContent=formatCurrency(u));const $=document.getElementById("salary-kpi-note");$&&($.classList.add("hidden"),$.textContent=""),s.innerHTML=S.map(c=>{const g=y.get(c.id)||0,b=getStaffSalaryMonthContext(c,g),v=b.advance>.009?`<span class="muted">Advance ${formatCurrency(b.advance)}</span>`:formatCurrency(b.pending),E=escapeHtml(c.name),M=escapeHtml(c.role_display??"\u2014");return`
          <tr data-staff-id="${escapeHtml(c.id)}" tabindex="0" role="button" aria-label="View ${E} salary details">
            <td>${E}</td>
            <td>${M}</td>
            <td class="num">${formatSalaryAmount(b.payable)}</td>
            <td class="num">${formatCurrency(g)}</td>
            <td class="num">${v}</td>
            <td><span class="salary-status ${b.className}">${escapeHtml(b.label)}</span></td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small salary-view-btn" data-staff-id="${escapeHtml(c.id)}">Details</button>
              <button type="button" class="button-secondary button-small salary-slip-btn" data-staff-id="${escapeHtml(c.id)}">Slip</button>
              <button type="button" class="button-secondary button-small add-payment-btn" data-staff-id="${escapeHtml(c.id)}">Pay</button>
            </td>
          </tr>
        `}).join(""),s.querySelectorAll("tr[data-staff-id]").forEach(c=>{const g=c.getAttribute("data-staff-id");c.addEventListener("click",b=>{b.target.closest("button")||(Q(g),s.querySelectorAll("tr.is-selected").forEach(v=>v.classList.remove("is-selected")),c.classList.add("is-selected"))}),c.addEventListener("keydown",b=>{(b.key==="Enter"||b.key===" ")&&(b.preventDefault(),Q(g))})}),s.querySelectorAll(".salary-view-btn").forEach(c=>{c.addEventListener("click",g=>{g.stopPropagation(),Q(c.getAttribute("data-staff-id"))})}),s.querySelectorAll(".salary-slip-btn").forEach(c=>{c.addEventListener("click",async g=>{if(g.stopPropagation(),c.disabled)return;const b=c.getAttribute("data-staff-id"),v=S.find(M=>M.id===b);if(!v)return;const E=paymentsForEmployee(H,b);try{await runSalarySlipPrint(v,E,e)}catch(M){AppError.report(M,{context:"printSalarySlipQuick"}),alert(AppError.getUserMessage(M)||"Could not open the print dialog.")}})}),s.querySelectorAll(".add-payment-btn").forEach(c=>{c.addEventListener("click",g=>{if(g.stopPropagation(),c.disabled)return;const b=c.getAttribute("data-staff-id");ct(b)})}),q&&ot(q,e),G()}function ct(e,s={}){const r=s.salaryMonth||B();m&&(m.value=e),writeMonthYearValue(L,x,r),p&&(p.value=suggestPaymentDate(r)),P&&(P.value=""),G().then(()=>it()),document.querySelector('.settings-nav-item[data-section="record"]')?.click(),n?.scrollIntoView({behavior:"smooth"})}async function X(e){const s=document.getElementById("salary-payments-body");if(!s)return;const r=await j(e);if(!r.length){s.innerHTML=`<tr><td colspan="5" class="muted">No payments for ${escapeHtml(formatMonthLabel(e))} salary.</td></tr>`;return}const l=await St(r.map(o=>o.employee_id));s.innerHTML=r.map(o=>{const y=l.get(o.employee_id),f=escapeHtml(StaffEmployees.displayName(y)),h=o.employee_id,u=y?"":' disabled title="Staff record not found"';return`
          <tr>
            <td>${escapeHtml(formatDisplayDate(o.date))}</td>
            <td>${f}</td>
            <td class="num">${formatCurrency(o.amount)}</td>
            <td>${escapeHtml(o.note??"\u2014")}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small history-slip-btn" data-staff-id="${escapeHtml(h)}"${u}>Slip</button>
              ${salaryDeleteButtonHtml(o,y,a)}
            </td>
          </tr>
        `}).join(""),s.querySelectorAll(".history-slip-btn").forEach(o=>{o.addEventListener("click",async()=>{const y=o.getAttribute("data-staff-id"),f=l.get(y);if(!f)return;const h=await mt(e),u=paymentsForEmployee(h,y);try{await runSalarySlipPrint(f,u,e)}catch($){AppError.report($,{context:"printHistorySlip"}),alert(AppError.getUserMessage($)||"Could not open the print dialog.")}})})}async function mt(e){return j(e)}async function tt(){await lt(),vt(m);const e=B(),s=rt();e&&(await dt(e),await X(s))}n&&n.addEventListener("submit",async e=>{e.preventDefault();const s=n.querySelector('button[type="submit"]');s&&(s.disabled=!0,s.textContent="Saving\u2026"),d?.classList.add("hidden"),i?.classList.add("hidden");const r=m?.value,l=p?.value,o=Number(P?.value||0),y=document.getElementById("payment-note")?.value?.trim()||null,f=Z(),h=normalizeSalaryMonth(f||l?.slice(0,7)),u=()=>{s&&(s.disabled=!1,s.textContent="Save payment")};if(!r){u(),i?.classList.remove("hidden"),i&&(i.textContent="Select a staff member.");return}if(!l){u(),i?.classList.remove("hidden"),i&&(i.textContent="Payment date is required.");return}if(l>getLocalDateString()){u(),i?.classList.remove("hidden"),i&&(i.textContent="Payment date cannot be in the future.");return}if(o<=0){u(),i?.classList.remove("hidden"),i&&(i.textContent="Amount must be greater than 0.");return}if(!h){u(),i?.classList.remove("hidden"),i&&(i.textContent="Select the salary month this payment applies to.");return}const $=S.find(A=>A.id===r),c=await J(f),g=getStaffBalanceForMonth(r,c,S);if(g&&g.salary>0&&o>g.pending+.009){const A=roundMoney(o-g.pending),Pt=g.pending<=.009?`Net salary for ${formatMonthLabel(f)} is already settled. Record ${formatCurrency(o)} as advance?`:`Amount exceeds remaining balance (${formatCurrency(g.pending)}). This will overpay by ${formatCurrency(A)}. Continue?`;if(!confirm(Pt)){u();return}}const b={employee_id:r,date:l,amount:o,note:y,salary_month:h};t.session?.user?.id&&(b.created_by=t.session.user.id);let v=null,E=null;if({data:v,error:E}=await supabaseClient.from("salary_payments").insert(b).select("id").single(),E&&isMissingSalaryMonthColumn(E)){const A={employee_id:r,date:l,amount:o,note:y};t.session?.user?.id&&(A.created_by=t.session.user.id),{data:v,error:E}=await supabaseClient.from("salary_payments").insert(A).select("id").single()}if(E){u(),AppError.handle(E,{target:i});return}const M=salaryExpenseDescription($,y),C={date:l,category:"salary",description:M,amount:o};v?.id&&(C.salary_payment_id=v.id),t.session?.user?.id&&(C.created_by=t.session.user.id);let w=null;if({error:w}=await supabaseClient.from("expenses").insert(C),w&&isMissingSalaryPaymentIdColumn(w)&&(delete C.salary_payment_id,{error:w}=await supabaseClient.from("expenses").insert(C)),w){if(v?.id){const{error:A}=await supabaseClient.from("salary_payments").delete().eq("id",v.id);A&&AppError.report(A,{context:"rollbackSalaryPaymentAfterExpenseFail",paymentId:v.id})}u(),AppError.handle(w,{target:i});return}u();const $t=l,ft=f,et=r;finishRecordFormSave(n,{date:$t},{date:RECORD_DATE_KEYS.salaryPayment}),ft&&writeMonthYearValue(L,x,ft),d?.classList.remove("hidden"),await tt(),m&&et&&S.some(A=>A.id===et)&&(m.value=et),G(),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational")}),m?.addEventListener("change",G),V?.addEventListener("click",it);function yt(){const e=Z();p&&e&&(p.value=suggestPaymentDate(e)),G()}L?.addEventListener("change",yt),x?.addEventListener("change",yt);function pt(e,s,r){if(!e||!s)return;const l=async()=>{const o=readMonthYearValue(e,s);o&&await r(o)};e.addEventListener("change",l),s.addEventListener("change",l)}pt(k,R,async e=>{bt(),writeMonthYearValue(L,x,e),await dt(e),await X(e)}),pt(T,N,async e=>{await X(e)});const ut=document.getElementById("salary-download-csv");ut&&ut.addEventListener("click",async()=>{const e=B();if(!e)return;await lt();const s=await j(e),r=paidByStaffInRange(s),l=["Name","Role","Net monthly (\u20B9)","Paid this month (\u20B9)","Remaining (\u20B9)","Status"],o=S.map(u=>{const $=r.get(u.id)||0,c=getStaffSalaryMonthContext(u,$),g=c.advance>.009?`Advance ${c.advance}`:String(c.pending);return[String(u.name??"").replace(/"/g,'""'),String(u.role_display??"").replace(/"/g,'""'),String(c.payable),String($),g,c.label]}),y=[l.join(","),...o.map(u=>u.map($=>`"${$}"`).join(","))].join(`
`),f=new Blob(["\uFEFF"+y],{type:"text/csv;charset=utf-8"}),h=document.createElement("a");h.href=URL.createObjectURL(f),h.download=`salary-summary-${e}.csv`,h.click(),URL.revokeObjectURL(h.href)}),K?.addEventListener("click",O),F?.addEventListener("click",O),W?.addEventListener("click",O),Y?.addEventListener("click",()=>{q&&(O(),ct(q))}),document.addEventListener("keydown",e=>{e.key==="Escape"&&_?.getAttribute("aria-hidden")==="false"&&O()}),st(document.getElementById("salary-payments-body")),st(document.getElementById("salary-detail-payments-body")),await tt()});
