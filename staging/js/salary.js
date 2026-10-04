function normalizeSalaryMonth(e){if(!e)return"";const[s,r]=String(e).split("-");if(!s||!r)return"";const u=String(r).padStart(2,"0").slice(0,2);return`${s}-${u}-01`}function salaryMonthKey(e){const s=normalizeSalaryMonth(e);return s?s.slice(0,7):""}function suggestPaymentDate(e){const s=getLocalDateString(),r=salaryMonthKey(e),u=s.slice(0,7);if(!r||r===u)return s;if(r<u){const[i,p]=r.split("-").map(Number);return toLocalDateString(new Date(i,p,0))}return s}function isMissingSalaryMonthColumn(e){const s=String(e?.message||"");return/salary_month/i.test(s)||e?.code==="PGRST204"}function isMissingSalaryPaymentIdColumn(e){const s=String(e?.message||"");return/salary_payment_id/i.test(s)||e?.code==="PGRST204"}function getStaffSalaryMonthContext(e,s,r,u,i){const p=computeSalaryBalance(e.monthly_salary,s,e,r,u,{lopExcluded:i}),m=salaryStatusFromBalance(p);return{label:m.label,className:m.className,payable:p.salary,pending:m.pending,advance:m.advance,paid:Number(s??0),balance:p}}function formatSalaryAmount(e){return e==null?"\u2014":formatCurrency(e)}function formatMonthLabel(e){if(!e)return"\u2014";const[s,r]=e.split("-").map(Number);return new Date(s,r-1,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"})}const SALARY_SLIP_PRINT_CSS="css/salary-slip-print.css?v=3";function slipAssetUrl(e){return new URL(e,window.location.href).href}function getPfSettings(){const e=PumpSettings.getStation(),s=AppConfig.DEFAULT_STATION;return{establishmentCode:(e.pfEstablishmentCode||s.pfEstablishmentCode||"").trim()}}function roundMoney(e){return PayrollRules.roundMoney(e)}function computePfBreakdown(e,s){const r=roundMoney(Math.max(0,Number(e??0))),u=roundMoney(Math.max(0,Number(s?.pf_contribution??0))),i=r>0?Math.min(u,r):0,p=u,m=roundMoney(Math.max(0,r-i));return{gross:r,employeePf:i,employerPf:p,netSalary:m,fixedAmount:u}}function getPayPeriodLabel(e){if(!e)return"\u2014";const[s,r]=e.split("-").map(Number),u=new Date(s,r-1,1),i=new Date(s,r,0),p=m=>m.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});return`${p(u)} \u2013 ${p(i)}`}const AMOUNT_WORDS_ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"],AMOUNT_WORDS_TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];function amountWordsUnder100(e){if(e<20)return AMOUNT_WORDS_ONES[e];const s=Math.floor(e/10),r=e%10;return`${AMOUNT_WORDS_TENS[s]}${r?` ${AMOUNT_WORDS_ONES[r]}`:""}`.trim()}function amountWordsUnder1000(e){if(e<100)return amountWordsUnder100(e);const s=Math.floor(e/100),r=e%100;return`${AMOUNT_WORDS_ONES[s]} Hundred${r?` ${amountWordsUnder100(r)}`:""}`.trim()}function amountWordsIndian(e){if(e===0)return"";if(e<1e3)return amountWordsUnder1000(e);if(e<1e5){const u=Math.floor(e/1e3),i=e%1e3;return`${amountWordsUnder1000(u)} Thousand${i?` ${amountWordsUnder1000(i)}`:""}`.trim()}if(e<1e7){const u=Math.floor(e/1e5),i=e%1e5;return`${amountWordsIndian(u)} Lakh${i?` ${amountWordsIndian(i)}`:""}`.trim()}const s=Math.floor(e/1e7),r=e%1e7;return`${amountWordsIndian(s)} Crore${r?` ${amountWordsIndian(r)}`:""}`.trim()}function amountInWordsINR(e){const s=roundMoney(Math.abs(Number(e)||0)),r=Math.floor(s),u=Math.round((s-r)*100);if(r===0&&u===0)return"Zero Rupees Only";let i=amountWordsIndian(r);return i=i?`${i} Rupees`:"Zero Rupees",u>0&&(i+=` and ${amountWordsIndian(u)} Paise`),`${i} Only`}function monthPayFor(e,s,r){return typeof PayrollRules>"u"?null:PayrollRules.computeMonthPay(e,r||[],s)}function computeSalaryBalance(e,s,r,u,i,p){const m=Number(e??0),x=r?computePfBreakdown(m,r):{employeePf:0,employerPf:0,netSalary:m,gross:m,fixedAmount:0},N=monthPayFor(m,u,i),w=N&&typeof PayrollRules<"u"?PayrollRules.applyLopExclusion(N,p?.lopExcluded===!0):N,C=typeof PayrollRules<"u"?PayrollRules.settleTakeHome(m,w?.lopAmount||0,w?.overDutyAmount||0,x.employeePf):{gross:m,earnings:m,lopAmount:0,overDutyAmount:0,beforePf:m,employeePf:x.employeePf,net:x.netSalary},H=C.net,$=Number(s??0),T=Math.max(0,H-$),F=Math.max(0,$-H);return{salary:H,gross:m,totalPaid:$,pending:T,advance:F,pf:x,pay:w,settled:C}}function salaryStatusFromBalance(e){const{salary:s,gross:r,totalPaid:u,pending:i,advance:p,settled:m}=e;return r>0||(m?.overDutyAmount||0)>0?s<=.009&&u<=.009?{label:"Nothing payable",className:"salary-status--none",pending:i,advance:p}:p>.009?{label:"Advance paid",className:"salary-status--advance",pending:i,advance:p}:i<=.009?{label:"Fully paid",className:"salary-status--paid",pending:i,advance:p}:u>0?{label:"Partial",className:"salary-status--partial",pending:i,advance:p}:{label:"Unpaid",className:"salary-status--unpaid",pending:i,advance:p}:{label:"No salary set",className:"salary-status--none",pending:i,advance:p}}function paymentsForEmployee(e,s){return(e||[]).filter(r=>r.employee_id===s).sort((r,u)=>String(r.date).localeCompare(String(u.date)))}function salaryExpenseDescription(e,s){if(!e)return"Salary";const r=s!=null&&String(s).trim()!==""?String(s).trim():null;return`Salary: ${e.name}${r?` - ${r}`:""}`}function salaryDeleteButtonHtml(e,s,r){if(!r||!e?.id)return"";const u=s?.name||"staff";return AdminDelete.buttonHtml({selector:"salary-delete-btn",data:{paymentId:e.id,staffName:u,date:e.date,amount:e.amount},title:"Delete payment (admin)"})}function getStaffBalanceForMonth(e,s,r,u,i,p){const m=(r||[]).find(C=>C.id===e);if(!m)return null;const N=paidByStaffInRange(s).get(e)||0,w=computeSalaryBalance(m.monthly_salary,N,m,u,i,{lopExcluded:p});return{staff:m,paid:N,...w,status:salaryStatusFromBalance(w)}}function paidByStaffInRange(e){const s=new Map;return(e||[]).forEach(r=>{const u=r.employee_id;s.set(u,(s.get(u)||0)+Number(r.amount??0))}),s}function buildSlipRef(e,s){const r=String(e||"").replace(/-/g,"").slice(0,8).toUpperCase();return`SAL-${s.replace("-","")}-${r}`}function slipAttendanceBlock(e){if(!e||typeof PayrollRules>"u"||!e.lossOfPayEnabled&&!e.overDutyEnabled)return"";const s=e.counts||{},r=e.lossOfPayEnabled?`Leave ${PayrollRules.leaveUsageLabel(e)}`:`Leave ${PayrollRules.formatDayCount(s.leave)}`,u=[`Present ${s.present}`,`Half-day ${s.half}`,r];e.overDutyEnabled&&u.push(`Over duty ${PayrollRules.formatDayCount(e.overDutyDays)}`);const i=e.config?.dayRateBasis==="fixed"?"fixed":"calendar";u.push(`Day rate \u20B9 ${formatNumberPlain(e.perDay)} (${e.divisor} ${i} days)`);const p=e.lossOfPayEnabled?PayrollRules.lopBreakdownLabel(e):"";return`<div class="salary-slip-attendance"><strong>Attendance.</strong> ${escapeHtml(u.join(" \xB7 "))}.${p?` ${escapeHtml(p)}.`:""}</div>`}function buildSalarySlipHtml(e,s,r,u,i){const p=formatMonthLabel(r),m=getPayPeriodLabel(r),x=s.reduce((_,I)=>_+Number(I.amount??0),0),N=computeSalaryBalance(e.monthly_salary,x,e,r,u,i),w=N.pf,{pending:C,advance:H,pay:$,settled:T}=N,F=T.net,j=PumpSettings.getStationGstin(),G=getPfSettings(),st=PumpSettings.getStationAddress(),rt=PumpSettings.getStationContactLine(),ot=buildSlipRef(e.id,r),Q=formatDisplayDate(getLocalDateString()),K=e.pf_number?.trim()||"",X=e.pan_number?.trim()||"",z=e.phone_number?.trim()||"",S=e.address?.trim()||"",B=[];j&&B.push(`<span>GSTIN: ${escapeHtml(j)}</span>`),G.establishmentCode&&B.push(`<span>PF Est. code: ${escapeHtml(G.establishmentCode)}</span>`);const W=s.length?s.map((_,I)=>`
        <tr>
          <td>${I+1}</td>
          <td>${escapeHtml(formatDisplayDate(_.date))}</td>
          <td class="num">\u20B9 ${formatNumberPlain(_.amount)}</td>
          <td>${escapeHtml(_.note||"\u2014")}</td>
        </tr>`).join(""):'<tr><td colspan="4" style="text-align:center;color:#64748b">No salary disbursements recorded for this month</td></tr>',J=H>.009?`<tr class="salary-slip-summary-balance"><td>Advance paid (over net salary)</td><td>\u20B9 ${formatNumberPlain(H)}</td></tr>`:C>.009?`<tr class="salary-slip-summary-balance"><td>Balance payable (net)</td><td>\u20B9 ${formatNumberPlain(C)}</td></tr>`:'<tr class="salary-slip-summary-paid"><td>Balance payable (net)</td><td>\u20B9 0.00 \u2014 Settled</td></tr>',O=w.employerPf>0?`
      <div class="salary-slip-employer">
        <p class="salary-slip-employer-title">Employer contribution (statutory)</p>
        <table>
          <tr>
            <td>Employer PF (fixed monthly)</td>
            <td>\u20B9 ${formatNumberPlain(w.employerPf)}</td>
          </tr>
        </table>
        <p style="margin:3pt 0 0;font-size:6.8pt;color:#64748b">Employer PF is deposited to EPFO separately and is not deducted from employee take-home pay.</p>
      </div>`:"";return`
    <article class="salary-slip-sheet" data-slip-ref="${escapeHtml(ot)}">
      <header class="salary-slip-head">
        <div class="salary-slip-letterhead">
          <img src="${PrintUtils.getStationLogoPrintUrl()}" alt="Bishnupriya Fuels" class="station-logo salary-slip-logo" width="128" height="128" />
          <div class="salary-slip-letterhead-text">
            <h1 class="salary-slip-station">${escapeHtml(PumpSettings.getStationLegalName())}</h1>
            <p class="salary-slip-dealer">${escapeHtml(PumpSettings.getStationTagline())}</p>
            ${st?`<p class="salary-slip-address">${escapeHtml(st)}</p>`:""}
            ${rt?`<p class="salary-slip-contact">${escapeHtml(rt)}</p>`:""}
            ${B.length?`<p class="salary-slip-statutory">${B.join("")}</p>`:""}
          </div>
        </div>
      </header>

      <div class="salary-slip-title-band">
        <h2 class="salary-slip-doc-title">Salary slip</h2>
        <p class="salary-slip-doc-meta">
          <strong>Slip no.</strong> ${escapeHtml(ot)} &nbsp;\xB7&nbsp;
          <strong>Pay period</strong> ${escapeHtml(m)} &nbsp;\xB7&nbsp;
          <strong>Generated</strong> ${escapeHtml(Q)}
        </p>
      </div>

      <dl class="salary-slip-employee">
        <div>
          <dt>Employee name</dt>
          <dd>${escapeHtml(e.name)}</dd>
        </div>
        <div>
          <dt>Designation</dt>
          <dd>${escapeHtml(e.role_display||"\u2014")}</dd>
        </div>
        <div>
          <dt>Salary month</dt>
          <dd>${escapeHtml(p)}</dd>
        </div>
        <div>
          <dt>PF / UAN no.</dt>
          <dd class="salary-slip-mono">${K?escapeHtml(K):"\u2014"}</dd>
        </div>
        <div>
          <dt>PAN</dt>
          <dd class="salary-slip-mono">${X?escapeHtml(X):"\u2014"}</dd>
        </div>
        <div>
          <dt>Mobile</dt>
          <dd>${z?escapeHtml(z):"\u2014"}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>${S?escapeHtml(S):"\u2014"}</dd>
        </div>
        <div>
          <dt>PF wage (gross)</dt>
          <dd>\u20B9 ${formatNumberPlain(w.gross)}</dd>
        </div>
      </dl>

      ${slipAttendanceBlock($)}

      <div class="salary-slip-pay-grid">
        <div class="salary-slip-pay-col">
          <p class="salary-slip-pay-col-title">Earnings</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Gross salary</td>
              <td>\u20B9 ${formatNumberPlain(w.gross)}</td>
            </tr>
            ${$?.overDutyAmount>0?`<tr><td>Over duty (${escapeHtml(PayrollRules.formatDayCount($.overDutyDays))} day \xD7 \u20B9 ${formatNumberPlain($.perDay)})</td><td>\u20B9 ${formatNumberPlain($.overDutyAmount)}</td></tr>`:""}
            <tr class="salary-slip-pay-total">
              <td>Total earnings</td>
              <td>\u20B9 ${formatNumberPlain(T.earnings)}</td>
            </tr>
          </table>
        </div>
        <div class="salary-slip-pay-col salary-slip-pay-col--deductions">
          <p class="salary-slip-pay-col-title">Deductions</p>
          <table class="salary-slip-pay-table">
            ${$?.lopExcluded?`<tr><td>Loss of pay excluded (${escapeHtml(PayrollRules.formatDayCount($.lopDays))} day, not deducted)</td><td>\u20B9 0.00</td></tr>`:$?.lopAmount>0?`<tr><td>Loss of pay (${escapeHtml(PayrollRules.formatDayCount($.lopDays))} day \xD7 \u20B9 ${formatNumberPlain($.perDay)})</td><td>\u20B9 ${formatNumberPlain($.lopAmount)}</td></tr>`:""}
            <tr>
              <td>Employee PF (fixed monthly)</td>
              <td>\u20B9 ${formatNumberPlain(T.employeePf)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total deductions</td>
              <td>\u20B9 ${formatNumberPlain(roundMoney(($?.lopAmount||0)+T.employeePf))}</td>
            </tr>
          </table>
        </div>
      </div>

      ${O}

      <div class="salary-slip-net-box">
        <span class="salary-slip-net-label">Net salary (take-home)</span>
        <span class="salary-slip-net-amount">\u20B9 ${formatNumberPlain(F)}</span>
      </div>
      <p class="salary-slip-words"><strong>In words:</strong> ${escapeHtml(amountInWordsINR(F))}</p>

      <p class="salary-slip-section-title">Salary disbursements (${escapeHtml(p)})</p>
      <table class="salary-slip-payments">
        <thead>
          <tr>
            <th style="width:7%">#</th>
            <th style="width:24%">Payment date</th>
            <th class="num" style="width:22%">Amount (\u20B9)</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>${W}</tbody>
        <tfoot>
          <tr>
            <td colspan="2">Total disbursed</td>
            <td class="num">\u20B9 ${formatNumberPlain(x)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <table class="salary-slip-summary">
        <tr class="salary-slip-summary-net">
          <td>Net salary for month</td>
          <td>\u20B9 ${formatNumberPlain(F)}</td>
        </tr>
        <tr class="salary-slip-summary-total">
          <td>Total disbursed this month</td>
          <td>\u20B9 ${formatNumberPlain(x)}</td>
        </tr>
        ${J}
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
      <p class="salary-slip-note">Computer-generated salary slip. PF is the fixed monthly amount, capped so take-home is not negative. Loss of pay and over duty use marked attendance only; unmarked days are ignored.${$?.lopExcluded?` Calculated loss of pay (${escapeHtml(formatCurrency($.suggestedLopAmount))}) was excluded from this month's salary.`:""} Disbursement rows are payments recorded for ${escapeHtml(p)}.</p>
    </article>`}let salarySlipPrintCssCache=null;async function getSalarySlipPrintCssText(){if(salarySlipPrintCssCache)return salarySlipPrintCssCache;const e=slipAssetUrl(SALARY_SLIP_PRINT_CSS),s=await fetch(e,{cache:"default"});if(!s.ok)throw new Error("Could not load salary slip print styles.");return salarySlipPrintCssCache=await s.text(),salarySlipPrintCssCache}async function runSalarySlipPrint(e,s,r,u){let i=u,p=!1;if(typeof PayrollRules<"u"){const N=PayrollRules.fetchLopExclusions(window.supabaseClient,r).catch(H=>(AppError.report(H,{context:"printSalarySlipExclusions"}),{ids:new Set,ready:!0})),[w,C]=await Promise.all([i?Promise.resolve(null):PayrollRules.fetchMonthAttendance(window.supabaseClient,r),N]);i||(i=w?.byEmployee.get(e.id)||[]),p=C.ids.has(e.id)}const[m,x]=await Promise.all([Promise.resolve(buildSalarySlipHtml(e,s,r,i||[],{lopExcluded:p})),getSalarySlipPrintCssText()]);await PrintUtils.printInIframe({title:PrintUtils.buildPrintFilename("salary-slip",e.name||"staff",r),bodyHtml:m,cssText:x,iframeTitle:"Salary slip print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}document.addEventListener("DOMContentLoaded",async()=>{await window.configPromise;const e=await requireAuth({allowedRoles:["admin","supervisor"],onDenied:"dashboard.html",pageName:"salary"});if(!e)return;applyRoleVisibility(e.role);const s=e.role==="admin";typeof loadPumpSettings=="function"&&await loadPumpSettings(),typeof initPageSections=="function"&&initPageSections({defaultSection:"summary",validSections:["summary","record","recent"]});const r=document.getElementById("salary-payment-form"),u=document.getElementById("salary-payment-success"),i=document.getElementById("salary-payment-error"),p=document.getElementById("payment-staff"),m=document.getElementById("payment-date"),x=document.getElementById("payment-amount"),N=document.getElementById("payment-fill-remaining"),w=document.getElementById("payment-salary-month-month"),C=document.getElementById("payment-salary-month-year"),H=document.getElementById("payment-month-hint"),$=document.getElementById("salary-month-month"),T=document.getElementById("salary-month-year"),F=document.getElementById("salary-history-month-month"),j=document.getElementById("salary-history-month-year"),G=document.getElementById("salary-detail-overlay"),st=document.getElementById("salary-detail-backdrop"),rt=document.getElementById("salary-detail-close"),ot=document.getElementById("salary-detail-dismiss"),Q=document.getElementById("salary-detail-print-slip"),K=document.getElementById("salary-detail-add-payment");m&&initPersistedDateInput(m,RECORD_DATE_KEYS.salaryPayment);const X=new Date,z=`${X.getFullYear()}-${String(X.getMonth()+1).padStart(2,"0")}`;populateMonthYearSelects($,T),populateMonthYearSelects(F,j),populateMonthYearSelects(w,C),writeMonthYearValue($,T,z),writeMonthYearValue(F,j,z),writeMonthYearValue(w,C,z);let S=[],B=[],W=new Map,J="",O="",_=null,I=new Set,ct="",V=!0;function ut(t){return I.has(t)}function ht(t,a){if(!s||!a?.lossOfPayEnabled)return"";const n=Number(a.suggestedLopAmount??a.lopAmount)||0;if(n<=0||!V)return"";const l=a.lopExcluded?"0":"1",o=a.lopExcluded?"Include in salary":"Exclude from salary";return`<div class="salary-lop-actions"><button type="button" class="button-secondary button-small salary-lop-toggle" data-staff-id="${escapeHtml(t)}" data-exclude="${l}" data-amount="${n}">${o}</button></div>`}function vt(){if(V)return;const t="Loss-of-pay exclusions need the latest database update. Calculated loss of pay is still deducted.";O=O?`${O} ${t}`:t}async function Et(t,a){if(ct=salaryMonthKey(t),V=!0,typeof PayrollRules>"u"||!PayrollRules.getPayrollConfig().lossOfPayEnabled)return I=new Set,I;try{const n=await PayrollRules.fetchLopExclusions(window.supabaseClient,t,a);I=n.ids,V=n.ready!==!1}catch(n){I=new Set,V=!1,AppError.report(n,{context:"loadLopExclusions"})}return I}async function yt(t,a){if(salaryMonthKey(a)===ct)return I.has(t);if(typeof PayrollRules>"u")return!1;try{return(await PayrollRules.fetchLopExclusions(window.supabaseClient,a)).ids.has(t)}catch(n){return AppError.report(n,{context:"excludedForStaff"}),!1}}async function It(t,a,n){const l=normalizeSalaryMonth(a),o=e.session?.user?.id;if(!l||!t||!o)throw new Error("Could not save the loss-of-pay exclusion.");if(n){const{error:y}=await window.supabaseClient.from("salary_lop_exclusions").insert({employee_id:t,salary_month:l,created_by:o});if(y&&y.code!=="23505")throw y;return}const{error:d}=await window.supabaseClient.from("salary_lop_exclusions").delete().eq("employee_id",t).eq("salary_month",l);if(d)throw d}async function Pt(t,a,n,l){const o=S.find(h=>h.id===t),d=Number(l)||0,y=formatMonthLabel(a),g=o?.name||"this employee";if(confirm(n?`Exclude ${formatCurrency(d)} loss of pay from ${g}'s ${y} salary? Payable will not be reduced by that amount.`:`Include loss of pay in ${g}'s ${y} salary again?`))try{await It(t,a,n),n?I.add(t):I.delete(t),PayrollRules.setCachedLopExclusion(a,t,n);const h=U();salaryMonthKey(h)===salaryMonthKey(a)?await dt(h,{refresh:!1}):await dt(h)}catch(h){AppError.report(h,{context:"toggleLopExclusion"}),alert(AppError.getUserMessage(h)||"Could not update loss of pay.")}}async function $t(t){if(O="",typeof PayrollRules>"u")return W=new Map,W;try{const a=await PayrollRules.fetchMonthAttendance(window.supabaseClient,t,{force:!0});W=a.byEmployee,J=t,a.overDutyColumnReady===!1&&PayrollRules.getPayrollConfig().overDutyEnabled&&(O="Over duty is turned on, but the database update for over duty is not applied yet. Loss of pay still uses attendance.")}catch(a){W=new Map,J=t,O="Attendance could not be loaded, so loss of pay and over duty are not included.",AppError.report(a,{context:"loadMonthAttendanceMap"})}return W}function lt(t){return W.get(t)||[]}async function pt(t,a){if(J===a)return lt(t);if(typeof PayrollRules>"u")return[];try{return(await PayrollRules.fetchMonthAttendance(window.supabaseClient,a)).byEmployee.get(t)||[]}catch(n){return AppError.report(n,{context:"attendanceRecordsFor"}),[]}}const St=document.getElementById("salary-history-actions-head"),wt=document.getElementById("salary-detail-actions-head");St&&(St.textContent=s?"Actions":"Slip"),wt&&(wt.hidden=!s);async function _t(t,a){if(t?.id){const{data:y,error:g}=await window.supabaseClient.from("expenses").select("id").eq("salary_payment_id",t.id).limit(1);if(!g&&y?.length){const{error:f}=await window.supabaseClient.from("expenses").delete().eq("id",y[0].id);f&&AppError.report(f,{context:"deleteLinkedSalaryExpenseById"});return}g&&!isMissingSalaryPaymentIdColumn(g)&&AppError.report(g,{context:"deleteLinkedSalaryExpenseLookupById"})}const n=salaryExpenseDescription(a,t.note),{data:l,error:o}=await window.supabaseClient.from("expenses").select("id").eq("category","salary").eq("date",t.date).eq("amount",t.amount).eq("description",n).limit(1);if(o){AppError.report(o,{context:"deleteLinkedSalaryExpenseLookup"});return}if(!l?.length)return;const{error:d}=await window.supabaseClient.from("expenses").delete().eq("id",l[0].id);d&&AppError.report(d,{context:"deleteLinkedSalaryExpense"})}async function kt(t,a){if(!s){alert("Only an admin can delete salary payments.");return}if(!t?.id)return;const n=a?.name||"this staff member";if(!confirm(`Delete salary payment of ${formatCurrency(t.amount)} for ${n} on ${formatDisplayDate(t.date)}?

The linked expense entry will also be removed. This cannot be undone.`))return;const{error:o}=await window.supabaseClient.from("salary_payments").delete().eq("id",t.id);if(o){alert(AppError.getUserMessage(o)),AppError.report(o,{context:"deleteSalaryPayment",id:t.id});return}await _t(t,a),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational"),await bt()}function xt(t){!s||!t||t.dataset.salaryDeleteBound==="1"||(t.dataset.salaryDeleteBound="1",t.addEventListener("click",async a=>{const n=a.target.closest(".salary-delete-btn");if(!n)return;a.stopPropagation(),a.preventDefault();const l=n.getAttribute("data-payment-id"),o=B.find(y=>y.id===l)||await(async()=>{const y=At();return(await Rt(y)).find(f=>f.id===l)})();if(!o){alert("Payment not found. Refresh the page and try again.");return}const d=S.find(y=>y.id===o.employee_id);n.disabled=!0;try{await kt(o,d)}finally{n.disabled=!1}}))}function U(){return readMonthYearValue($,T)||z}function it(){return readMonthYearValue(w,C)||U()}function At(){return readMonthYearValue(F,j)||U()}function Tt(){writeMonthYearValue(F,j,U())}function mt(t){G&&(_=t,Ct(t,U()),G.setAttribute("aria-hidden","false"),document.body.classList.add("modal-open"))}function tt(){G&&(G.setAttribute("aria-hidden","true"),document.body.classList.remove("modal-open"),_=null,document.querySelectorAll(".salary-summary-table tbody tr.is-selected").forEach(t=>{t.classList.remove("is-selected")}))}function Ct(t,a){const n=S.find(c=>c.id===t);if(!n)return;const o=paidByStaffInRange(B).get(t)||0,d=getStaffSalaryMonthContext(n,o,a,lt(t),ut(t)),y=paymentsForEmployee(B,t),g=formatMonthLabel(a),f=document.getElementById("salary-detail-title"),h=document.getElementById("salary-detail-subtitle"),A=document.getElementById("salary-detail-stats"),D=document.getElementById("salary-detail-payments-body");f&&(f.textContent=n.name),h&&(h.textContent=`${n.role_display||"Staff"} \xB7 ${g}`);const L=formatCurrency(d.pending),q=d.pending<=.009?"salary-detail-balance is-clear":"salary-detail-balance",R=d.balance.pf,k=n.pf_number?.trim(),P=d.balance?.pay,Y=d.balance?.settled;A&&(A.innerHTML=`
        <div><dt>Gross salary</dt><dd>${formatCurrency(n.monthly_salary)}</dd></div>
        <div><dt>Payable</dt><dd>${formatCurrency(d.payable)}</dd></div>
        <div><dt>PF contribution</dt><dd>${R.fixedAmount>0?formatCurrency(Y?.employeePf??R.employeePf):'<span class="muted">Not set \u2014 <a href="staff.html">Staff</a></span>'}</dd></div>
        <div><dt>Employer PF</dt><dd>${formatCurrency(R.employerPf)}</dd></div>
        <div><dt>PF / UAN</dt><dd>${k?escapeHtml(k):'<span class="muted">Not set</span>'}</dd></div>
        <div><dt>Mobile</dt><dd>${n.phone_number?escapeHtml(n.phone_number):'<span class="muted">\u2014</span>'}</dd></div>
        <div><dt>Paid this month</dt><dd>${formatCurrency(o)}</dd></div>
        <div><dt>Remaining</dt><dd class="${q}">${L}</dd></div>
        <div><dt>Status</dt><dd><span class="salary-status ${d.className}">${escapeHtml(d.label)}</span></dd></div>
      `);const M=document.getElementById("salary-detail-adjust");if(M)if(!P||!P.lossOfPayEnabled&&!P.overDutyEnabled)M.hidden=!0,M.innerHTML="";else{const c=P.counts||{};M.hidden=!1,M.innerHTML=`
          <div class="salary-adjust-head">
            <h3>Attendance this month</h3>
            <span class="muted">${escapeHtml(PayrollRules.dayRateLabel(P))} \xB7 ${escapeHtml(formatCurrency(P.perDay))} / day</span>
          </div>
          <dl class="salary-adjust-grid">
            <div><dt>Present</dt><dd>${c.present}</dd></div>
            <div><dt>Half-day</dt><dd>${c.half}</dd></div>
            <div><dt>Leave</dt><dd>${escapeHtml(PayrollRules.leaveUsageLabel(P))}</dd></div>
            <div><dt>Loss of pay</dt><dd class="${P.lopExcluded?"salary-lop-excluded":P.lopAmount>0?"salary-money-deduct":""}">${P.lossOfPayEnabled?P.lopExcluded?`Excluded \xB7 ${escapeHtml(formatCurrency(P.suggestedLopAmount))}`:P.lopAmount>0?`${escapeHtml(PayrollRules.formatDayCount(P.lopDays))} \xB7 ${escapeHtml(formatCurrency(P.lopAmount))}`:"\u2014":"Off"}</dd></div>
            <div><dt>Over duty</dt><dd class="${P.overDutyAmount>0?"salary-money-earn":""}">${P.overDutyEnabled?`${escapeHtml(PayrollRules.formatDayCount(P.overDutyDays))} \xB7 ${escapeHtml(formatCurrency(P.overDutyAmount))}`:"Off"}</dd></div>
          </dl>
          <p class="salary-adjust-note">${escapeHtml(P.lossOfPayEnabled?PayrollRules.lopBreakdownLabel(P):"Loss of pay is off.")} Unmarked days are ignored.</p>
          ${ht(t,P)}
        `,M.querySelector(".salary-lop-toggle")?.addEventListener("click",E=>{E.stopPropagation();const v=E.currentTarget;Pt(t,a,v.getAttribute("data-exclude")==="1",v.getAttribute("data-amount"))})}if(D){const c=s?4:3;y.length?D.innerHTML=y.map(E=>`
          <tr>
            <td>${escapeHtml(formatDisplayDate(E.date))}</td>
            <td class="num">${formatCurrency(E.amount)}</td>
            <td>${escapeHtml(E.note??"\u2014")}</td>
            ${s?`<td class="table-actions">${salaryDeleteButtonHtml(E,n,!0)}</td>`:""}
          </tr>`).join(""):D.innerHTML=`<tr><td colspan="${c}" class="muted">No payments recorded for this month.</td></tr>`}Q&&(Q.disabled=!1,Q.title="",Q.onclick=async()=>{try{await runSalarySlipPrint(n,y,a)}catch(c){AppError.report(c,{context:"printSalarySlip"}),alert(AppError.getUserMessage(c)||"Could not open the print dialog.")}}),K&&(K.disabled=!1,K.title="")}async function Lt(){try{S=await StaffEmployees.loadActiveEmployees(window.supabaseClient,{isAdmin:s,useCache:!0})}catch(t){AppError.report(t,{context:"loadStaffMembers"}),S=[]}return S}async function Ft(t){const a=new Map(S.map(l=>[l.id,l])),n=[...new Set((t||[]).filter(l=>l&&!a.has(l)))];if(!n.length)return a;try{(await StaffEmployees.resolveEmployeesByIds(window.supabaseClient,n)).forEach((o,d)=>a.set(d,o))}catch(l){AppError.report(l,{context:"staffMapForIds"})}return a}function Ot(t,a=!0){if(!t)return;const n=t.value;t.innerHTML=a?'<option value="">Select staff</option>':"",S.forEach(l=>{const o=document.createElement("option");o.value=l.id,o.textContent=`${l.name}${l.role_display?` (${l.role_display})`:""}`,t.appendChild(o)}),n&&S.some(l=>l.id===n)&&(t.value=n)}async function Ut(t,a){const{data:n,error:l}=await window.supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").gte("date",t).lte("date",a).order("date",{ascending:!1});if(l){if(isMissingSalaryMonthColumn(l)){const{data:o,error:d}=await window.supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note").gte("date",t).lte("date",a).order("date",{ascending:!1});return d?(AppError.report(d,{context:"loadPaymentsInRange"}),[]):o??[]}return AppError.report(l,{context:"loadPaymentsInRange"}),[]}return n??[]}async function et(t){const a=normalizeSalaryMonth(t);if(!a)return[];const{data:n,error:l}=await window.supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").eq("salary_month",a).order("date",{ascending:!1});if(l){if(isMissingSalaryMonthColumn(l)){const[o,d]=t.split("-").map(Number),{start:y,end:g}=getMonthRange(o,d-1);return Ut(y,g)}return AppError.report(l,{context:"loadPaymentsForSalaryMonth"}),[]}return n??[]}async function ft(t){return t===U()&&B.length?B:et(t)}async function at(){if(!H)return;const t=p?.value,a=it();if(!t||!a){H.classList.add("hidden");return}if(!S.find(A=>A.id===t))return;const l=await ft(a),o=await pt(t,a),d=getStaffBalanceForMonth(t,l,S,a,o,await yt(t,a));if(!d)return;const y=formatMonthLabel(a);let g;(d.gross||0)<=0&&!(d.pay?.overDutyAmount>0)?g="no salary configured":d.status.advance>.009?g=`advance ${formatCurrency(d.status.advance)} paid`:d.pending<=.009?g="fully paid":g=`${formatCurrency(d.pending)} remaining`;const f=[];d.pay?.lopExcluded?f.push(`loss of pay excluded ${formatCurrency(d.pay.suggestedLopAmount)}`):d.pay?.lossOfPayEnabled&&d.pay.lopAmount>0&&f.push(`loss of pay ${formatCurrency(d.pay.lopAmount)}`),d.pay?.overDutyEnabled&&f.push(`over duty ${formatCurrency(d.pay.overDutyAmount)}`);const h=f.length?` \xB7 ${f.join(" \xB7 ")}`:"";H.textContent=`${y}: payable ${formatCurrency(d.salary)}${h} \xB7 ${formatCurrency(d.paid)} paid \xB7 ${g}`,H.classList.remove("hidden")}async function Mt(){const t=p?.value;if(!t){i&&(i.textContent="Select a staff member first.",i.classList.remove("hidden"));return}i?.classList.add("hidden");const a=it(),n=await ft(a),l=await pt(t,a),o=getStaffBalanceForMonth(t,n,S,a,l,await yt(t,a));if(!o||o.pending<=.009){x&&(x.value="");return}x&&(x.value=o.pending.toFixed(2))}async function dt(t,a){const n=document.getElementById("salary-summary-body"),l=document.getElementById("salary-kpi-payroll"),o=document.getElementById("salary-kpi-paid"),d=document.getElementById("salary-kpi-pending");if(!n)return;const y=document.getElementById("salary-kpi-lop"),g=document.getElementById("salary-kpi-od"),f=document.getElementById("salary-summary-table"),h=document.getElementById("salary-payroll-note"),A=typeof PayrollRules<"u"?PayrollRules.getPayrollConfig():null;if(f?.classList.toggle("show-lop",!!A?.lossOfPayEnabled),f?.classList.toggle("show-od",!!A?.overDutyEnabled),document.getElementById("salary-kpi-lop-card")?.classList.toggle("hidden",!A?.lossOfPayEnabled),document.getElementById("salary-kpi-od-card")?.classList.toggle("hidden",!A?.overDutyEnabled),!S.length){n.innerHTML='<tr><td colspan="9" class="muted">Add staff in <a href="staff.html">HR \u2192 Staff</a> first.</td></tr>',l&&(l.textContent="\u2014"),o&&(o.textContent="\u2014"),d&&(d.textContent="\u2014"),y&&(y.textContent="\u2014"),g&&(g.textContent="\u2014");return}if(a?.refresh!==!1){const[c]=await Promise.all([et(t),$t(t),Et(t,{force:!0})]);B=c,vt()}const D=paidByStaffInRange(B);let L=0,q=0,R=0,k=0,P=0;const Y=S.map(c=>{const E=D.get(c.id)||0,v=getStaffSalaryMonthContext(c,E,t,lt(c.id),ut(c.id)),b=v.balance?.pay;L+=v.payable,q+=E,R+=v.pending,k+=b?.lopAmount||0,P+=b?.overDutyAmount||0;const nt=v.advance>.009?`<span class="muted">Advance ${formatCurrency(v.advance)}</span>`:formatCurrency(v.pending),Z=escapeHtml(c.name),qt=escapeHtml(c.role_display??"\u2014"),Yt=Number(b?.suggestedLopAmount??b?.lopAmount)||0,jt=b?.lossOfPayEnabled?b.lopExcluded?`<span class="salary-lop-excluded">Excluded</span> <span class="muted">${escapeHtml(formatCurrency(Yt))}</span>`:b.lopAmount>0?escapeHtml(formatCurrency(b.lopAmount)):"\u2014":"Off",Gt=ht(c.id,b),Wt=b?.overDutyEnabled?formatCurrency(b.overDutyAmount):"Off";return`
          <tr data-staff-id="${escapeHtml(c.id)}" tabindex="0" role="button" aria-label="View ${Z} salary details">
            <td>${Z}</td>
            <td>${qt}</td>
            <td class="num">${formatSalaryAmount(v.payable)}</td>
            <td class="num salary-col-lop${b?.lopAmount>0?" salary-money-deduct":""}"><div class="salary-lop-cell">${jt}${Gt}</div></td>
            <td class="num salary-col-od${b?.overDutyAmount>0?" salary-money-earn":""}">${Wt}</td>
            <td class="num">${formatCurrency(E)}</td>
            <td class="num">${nt}</td>
            <td><span class="salary-status ${v.className}">${escapeHtml(v.label)}</span></td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small salary-view-btn" data-staff-id="${escapeHtml(c.id)}">Details</button>
              <button type="button" class="button-secondary button-small salary-slip-btn" data-staff-id="${escapeHtml(c.id)}">Slip</button>
              <button type="button" class="button-secondary button-small add-payment-btn" data-staff-id="${escapeHtml(c.id)}">Pay</button>
            </td>
          </tr>
        `});if(l&&(l.textContent=formatCurrency(L)),o&&(o.textContent=formatCurrency(q)),d&&(d.textContent=formatCurrency(R)),y&&(y.textContent=formatCurrency(k)),g&&(g.textContent=formatCurrency(P)),h){const c=A&&PayrollRules.rulesAffectPay(A)?PayrollRules.policySummary(A):null,E=[O,c?.rate].filter(Boolean).join(" ");h.textContent=E,h.classList.toggle("hidden",!E)}const M=document.getElementById("salary-kpi-note");M&&(M.classList.add("hidden"),M.textContent=""),n.innerHTML=Y.join(""),n.querySelectorAll("tr[data-staff-id]").forEach(c=>{const E=c.getAttribute("data-staff-id");c.addEventListener("click",v=>{v.target.closest("button")||(mt(E),n.querySelectorAll("tr.is-selected").forEach(b=>b.classList.remove("is-selected")),c.classList.add("is-selected"))}),c.addEventListener("keydown",v=>{(v.key==="Enter"||v.key===" ")&&(v.preventDefault(),mt(E))})}),n.querySelectorAll(".salary-view-btn").forEach(c=>{c.addEventListener("click",E=>{E.stopPropagation(),mt(c.getAttribute("data-staff-id"))})}),n.querySelectorAll(".salary-slip-btn").forEach(c=>{c.addEventListener("click",async E=>{if(E.stopPropagation(),c.disabled)return;const v=c.getAttribute("data-staff-id"),b=S.find(Z=>Z.id===v);if(!b)return;const nt=paymentsForEmployee(B,v);try{await runSalarySlipPrint(b,nt,t)}catch(Z){AppError.report(Z,{context:"printSalarySlipQuick"}),alert(AppError.getUserMessage(Z)||"Could not open the print dialog.")}})}),n.querySelectorAll(".salary-lop-toggle").forEach(c=>{c.addEventListener("click",E=>{E.stopPropagation();const v=c.getAttribute("data-staff-id"),b=c.getAttribute("data-exclude")==="1";Pt(v,t,b,c.getAttribute("data-amount"))})}),n.querySelectorAll(".add-payment-btn").forEach(c=>{c.addEventListener("click",E=>{if(E.stopPropagation(),c.disabled)return;const v=c.getAttribute("data-staff-id");Dt(v)})}),_&&Ct(_,t),at()}function Dt(t,a={}){const n=a.salaryMonth||U();p&&(p.value=t),writeMonthYearValue(w,C,n),m&&(m.value=suggestPaymentDate(n)),x&&(x.value=""),at().then(()=>Mt()),document.querySelector('.settings-nav-item[data-section="record"]')?.click(),r?.scrollIntoView({behavior:"smooth"})}async function gt(t){const a=document.getElementById("salary-payments-body");if(!a)return;const n=await et(t);if(!n.length){a.innerHTML=`<tr><td colspan="5" class="muted">No payments for ${escapeHtml(formatMonthLabel(t))} salary.</td></tr>`;return}const l=await Ft(n.map(o=>o.employee_id));a.innerHTML=n.map(o=>{const d=l.get(o.employee_id),y=escapeHtml(StaffEmployees.displayName(d)),g=o.employee_id,f=d?"":' disabled title="Staff record not found"';return`
          <tr>
            <td>${escapeHtml(formatDisplayDate(o.date))}</td>
            <td>${y}</td>
            <td class="num">${formatCurrency(o.amount)}</td>
            <td>${escapeHtml(o.note??"\u2014")}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small history-slip-btn" data-staff-id="${escapeHtml(g)}"${f}>Slip</button>
              ${salaryDeleteButtonHtml(o,d,s)}
            </td>
          </tr>
        `}).join(""),a.querySelectorAll(".history-slip-btn").forEach(o=>{o.addEventListener("click",async()=>{const d=o.getAttribute("data-staff-id"),y=l.get(d);if(!y)return;const g=await Rt(t),f=paymentsForEmployee(g,d);try{await runSalarySlipPrint(y,f,t)}catch(h){AppError.report(h,{context:"printHistorySlip"}),alert(AppError.getUserMessage(h)||"Could not open the print dialog.")}})})}async function Rt(t){return et(t)}async function bt(){await Lt(),Ot(p);const t=U(),a=At();t&&(await dt(t),await gt(a))}r&&r.addEventListener("submit",async t=>{t.preventDefault();const a=r.querySelector('button[type="submit"]');a&&(a.disabled=!0,a.textContent="Saving\u2026"),u?.classList.add("hidden"),i?.classList.add("hidden");const n=p?.value,l=m?.value,o=Number(x?.value||0),d=document.getElementById("payment-note")?.value?.trim()||null,y=it(),g=normalizeSalaryMonth(y||l?.slice(0,7)),f=()=>{a&&(a.disabled=!1,a.textContent="Save payment")};if(!n){f(),i?.classList.remove("hidden"),i&&(i.textContent="Select a staff member.");return}if(!l){f(),i?.classList.remove("hidden"),i&&(i.textContent="Payment date is required.");return}if(l>getLocalDateString()){f(),i?.classList.remove("hidden"),i&&(i.textContent="Payment date cannot be in the future.");return}if(o<=0){f(),i?.classList.remove("hidden"),i&&(i.textContent="Amount must be greater than 0.");return}if(!g){f(),i?.classList.remove("hidden"),i&&(i.textContent="Select the salary month this payment applies to.");return}const h=S.find(b=>b.id===n),A=await ft(y),D=await pt(n,y),L=getStaffBalanceForMonth(n,A,S,y,D,await yt(n,y));if(L&&L.salary>0&&o>L.pending+.009){const b=roundMoney(o-L.pending),nt=L.pending<=.009?`Net salary for ${formatMonthLabel(y)} is already settled. Record ${formatCurrency(o)} as advance?`:`Amount exceeds remaining balance (${formatCurrency(L.pending)}). This will overpay by ${formatCurrency(b)}. Continue?`;if(!confirm(nt)){f();return}}const q={employee_id:n,date:l,amount:o,note:d,salary_month:g};e.session?.user?.id&&(q.created_by=e.session.user.id);let R=null,k=null;if({data:R,error:k}=await window.supabaseClient.from("salary_payments").insert(q).select("id").single(),k&&isMissingSalaryMonthColumn(k)){const b={employee_id:n,date:l,amount:o,note:d};e.session?.user?.id&&(b.created_by=e.session.user.id),{data:R,error:k}=await window.supabaseClient.from("salary_payments").insert(b).select("id").single()}if(k){f(),AppError.handle(k,{target:i});return}const P=salaryExpenseDescription(h,d),Y={date:l,category:"salary",description:P,amount:o};R?.id&&(Y.salary_payment_id=R.id),e.session?.user?.id&&(Y.created_by=e.session.user.id);let M=null;if({error:M}=await window.supabaseClient.from("expenses").insert(Y),M&&isMissingSalaryPaymentIdColumn(M)&&(delete Y.salary_payment_id,{error:M}=await window.supabaseClient.from("expenses").insert(Y)),M){if(R?.id){const{error:b}=await window.supabaseClient.from("salary_payments").delete().eq("id",R.id);b&&AppError.report(b,{context:"rollbackSalaryPaymentAfterExpenseFail",paymentId:R.id})}f(),AppError.handle(M,{target:i});return}f();const c=l,E=y,v=n;finishRecordFormSave(r,{date:c},{date:RECORD_DATE_KEYS.salaryPayment}),E&&writeMonthYearValue(w,C,E),u?.classList.remove("hidden"),await bt(),p&&v&&S.some(b=>b.id===v)&&(p.value=v),at(),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational")}),p?.addEventListener("change",at),N?.addEventListener("click",Mt);function Nt(){const t=it();m&&t&&(m.value=suggestPaymentDate(t)),at()}w?.addEventListener("change",Nt),C?.addEventListener("change",Nt);function Ht(t,a,n){if(!t||!a)return;const l=async()=>{const o=readMonthYearValue(t,a);o&&await n(o)};t.addEventListener("change",l),a.addEventListener("change",l)}Ht($,T,async t=>{Tt(),writeMonthYearValue(w,C,t),await dt(t),await gt(t)}),Ht(F,j,async t=>{await gt(t)});const Bt=document.getElementById("salary-download-csv");Bt&&Bt.addEventListener("click",async()=>{const t=U();if(!t)return;await Lt();const a=J===t&&ct===salaryMonthKey(t),[n]=await Promise.all([et(t),a?Promise.resolve():$t(t),a?Promise.resolve():Et(t)]);a||vt();const l=paidByStaffInRange(n),o=["Name","Role","Payable (\u20B9)","Loss of pay (\u20B9)","Loss of pay days","Loss of pay excluded","Over duty (\u20B9)","Over duty days","Paid this month (\u20B9)","Remaining (\u20B9)","Status"],d=S.map(h=>{const A=l.get(h.id)||0,D=getStaffSalaryMonthContext(h,A,t,lt(h.id),ut(h.id)),L=D.balance?.pay,q=D.advance>.009?`Advance ${D.advance}`:String(D.pending);return[String(h.name??"").replace(/"/g,'""'),String(h.role_display??"").replace(/"/g,'""'),String(D.payable),String(L?.lopAmount??0),String(L?.lopDays??0),L?.lopExcluded?"Yes":"No",String(L?.overDutyAmount??0),String(L?.overDutyDays??0),String(A),q,D.label]}),y=[o.join(","),...d.map(h=>h.map(A=>`"${A}"`).join(","))].join(`
`),g=new Blob(["\uFEFF"+y],{type:"text/csv;charset=utf-8"}),f=document.createElement("a");f.href=URL.createObjectURL(g),f.download=`salary-summary-${t}.csv`,f.click(),URL.revokeObjectURL(f.href)}),rt?.addEventListener("click",tt),ot?.addEventListener("click",tt),st?.addEventListener("click",tt),K?.addEventListener("click",()=>{_&&(tt(),Dt(_))}),document.addEventListener("keydown",t=>{t.key==="Escape"&&G?.getAttribute("aria-hidden")==="false"&&tt()}),xt(document.getElementById("salary-payments-body")),xt(document.getElementById("salary-detail-payments-body")),await bt()});
