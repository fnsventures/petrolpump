function normalizeSalaryMonth(e){if(!e)return"";const[s,r]=String(e).split("-");if(!s||!r)return"";const u=String(r).padStart(2,"0").slice(0,2);return`${s}-${u}-01`}function salaryMonthKey(e){const s=normalizeSalaryMonth(e);return s?s.slice(0,7):""}function suggestPaymentDate(e){const s=getLocalDateString(),r=salaryMonthKey(e),u=s.slice(0,7);if(!r||r===u)return s;if(r<u){const[y,f]=r.split("-").map(Number);return toLocalDateString(new Date(y,f,0))}return s}function isMissingSalaryMonthColumn(e){const s=String(e?.message||"");return/salary_month/i.test(s)||e?.code==="PGRST204"}function getStaffSalaryMonthContext(e,s,r,u,y){const f=computeSalaryBalance(e.monthly_salary,s,e,r,u,{lopExcluded:y}),d=salaryStatusFromBalance(f);return{label:d.label,className:d.className,payable:f.salary,pending:d.pending,advance:d.advance,paid:Number(s??0),balance:f}}const SALARY_SLIP_PRINT_CSS="css/salary-slip-print.css?v=0825b234aa";function slipAssetUrl(e){return new URL(e,window.location.href).href}function getPfSettings(){const e=PumpSettings.getStation(),s=AppConfig.DEFAULT_STATION;return{establishmentCode:(e.pfEstablishmentCode||s.pfEstablishmentCode||"").trim()}}function roundMoney(e){return PayrollRules.roundMoney(e)}function computePfBreakdown(e,s){const r=roundMoney(Math.max(0,Number(e??0))),u=roundMoney(Math.max(0,Number(s?.pf_contribution??0))),y=r>0?Math.min(u,r):0,f=u,d=roundMoney(Math.max(0,r-y));return{gross:r,employeePf:y,employerPf:f,netSalary:d,fixedAmount:u}}function getPayPeriodLabel(e){if(!e)return"\u2014";const[s,r]=e.split("-").map(Number),u=new Date(s,r-1,1),y=new Date(s,r,0),f=d=>d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});return`${f(u)} \u2013 ${f(y)}`}const AMOUNT_WORDS_ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"],AMOUNT_WORDS_TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];function amountWordsUnder100(e){if(e<20)return AMOUNT_WORDS_ONES[e];const s=Math.floor(e/10),r=e%10;return`${AMOUNT_WORDS_TENS[s]}${r?` ${AMOUNT_WORDS_ONES[r]}`:""}`.trim()}function amountWordsUnder1000(e){if(e<100)return amountWordsUnder100(e);const s=Math.floor(e/100),r=e%100;return`${AMOUNT_WORDS_ONES[s]} Hundred${r?` ${amountWordsUnder100(r)}`:""}`.trim()}function amountWordsIndian(e){if(e===0)return"";if(e<1e3)return amountWordsUnder1000(e);if(e<1e5){const u=Math.floor(e/1e3),y=e%1e3;return`${amountWordsUnder1000(u)} Thousand${y?` ${amountWordsUnder1000(y)}`:""}`.trim()}if(e<1e7){const u=Math.floor(e/1e5),y=e%1e5;return`${amountWordsIndian(u)} Lakh${y?` ${amountWordsIndian(y)}`:""}`.trim()}const s=Math.floor(e/1e7),r=e%1e7;return`${amountWordsIndian(s)} Crore${r?` ${amountWordsIndian(r)}`:""}`.trim()}function amountInWordsINR(e){const s=roundMoney(Math.abs(Number(e)||0)),r=Math.floor(s),u=Math.round((s-r)*100);if(r===0&&u===0)return"Zero Rupees Only";let y=amountWordsIndian(r);return y=y?`${y} Rupees`:"Zero Rupees",u>0&&(y+=` and ${amountWordsIndian(u)} Paise`),`${y} Only`}function monthPayFor(e,s,r){return typeof PayrollRules>"u"?null:PayrollRules.computeMonthPay(e,r||[],s)}function computeSalaryBalance(e,s,r,u,y,f){const d=Number(e??0),P=r?computePfBreakdown(d,r):{employeePf:0,employerPf:0,netSalary:d,gross:d,fixedAmount:0},C=monthPayFor(d,u,y),A=C&&typeof PayrollRules<"u"?PayrollRules.applyLopExclusion(C,f?.lopExcluded===!0):C,H=typeof PayrollRules<"u"?PayrollRules.settleTakeHome(d,A?.lopAmount||0,A?.overDutyAmount||0,P.employeePf):{gross:d,earnings:d,lopAmount:0,overDutyAmount:0,beforePf:d,employeePf:P.employeePf,net:P.netSalary},M=H.net,$=Number(s??0),_=Math.max(0,M-$),I=Math.max(0,$-M);return{salary:M,gross:d,totalPaid:$,pending:_,advance:I,pf:P,pay:A,settled:H}}function salaryStatusFromBalance(e){const{salary:s,gross:r,totalPaid:u,pending:y,advance:f,settled:d}=e;return r>0||(d?.overDutyAmount||0)>0?s<=.009&&u<=.009?{label:"Nothing payable",className:"salary-status--none",pending:y,advance:f}:f>.009?{label:"Advance paid",className:"salary-status--advance",pending:y,advance:f}:y<=.009?{label:"Fully paid",className:"salary-status--paid",pending:y,advance:f}:u>0?{label:"Partial",className:"salary-status--partial",pending:y,advance:f}:{label:"Unpaid",className:"salary-status--unpaid",pending:y,advance:f}:{label:"No salary set",className:"salary-status--none",pending:y,advance:f}}function paymentsForEmployee(e,s){return(e||[]).filter(r=>r.employee_id===s).sort((r,u)=>String(r.date).localeCompare(String(u.date)))}function salaryDeleteButtonHtml(e,s,r){if(!r||!e?.id)return"";const u=s?.name||"staff";return AdminDelete.buttonHtml({selector:"salary-delete-btn",data:{paymentId:e.id,staffName:u,date:e.date,amount:e.amount},title:"Delete payment (admin)"})}function getStaffBalanceForMonth(e,s,r,u,y,f){const d=(r||[]).find(H=>H.id===e);if(!d)return null;const C=paidByStaffInRange(s).get(e)||0,A=computeSalaryBalance(d.monthly_salary,C,d,u,y,{lopExcluded:f});return{staff:d,paid:C,...A,status:salaryStatusFromBalance(A)}}function paidByStaffInRange(e){const s=new Map;return(e||[]).forEach(r=>{const u=r.employee_id;s.set(u,(s.get(u)||0)+Number(r.amount??0))}),s}function buildSlipRef(e,s){const r=String(e||"").replace(/-/g,"").slice(0,8).toUpperCase();return`SAL-${s.replace("-","")}-${r}`}function slipAttendanceBlock(e){if(!e||typeof PayrollRules>"u"||!e.lossOfPayEnabled&&!e.overDutyEnabled)return"";const s=e.counts||{},r=e.lossOfPayEnabled?`Leave ${PayrollRules.leaveUsageLabel(e)}`:`Leave ${PayrollRules.formatDayCount(s.leave)}`,u=[`Present ${s.present}`,`Half-day ${s.half}`,r];e.overDutyEnabled&&u.push(`Over duty ${PayrollRules.formatDayCount(e.overDutyDays)}`);const y=e.config?.dayRateBasis==="fixed"?"fixed":"calendar";u.push(`Day rate ${formatCurrency(e.perDay)} (${e.divisor} ${y} days)`);const f=e.lossOfPayEnabled?PayrollRules.lopBreakdownLabel(e):"";return`<div class="salary-slip-attendance"><strong>Attendance.</strong> ${escapeHtml(u.join(" \xB7 "))}.${f?` ${escapeHtml(f)}.`:""}</div>`}function buildSalarySlipHtml(e,s,r,u,y){const f=formatMonthLabel(r),d=getPayPeriodLabel(r),P=s.reduce((F,B)=>F+Number(B.amount??0),0),C=computeSalaryBalance(e.monthly_salary,P,e,r,u,y),A=C.pf,{pending:H,advance:M,pay:$,settled:_}=C,I=_.net,G=PumpSettings.getStationGstin(),N=getPfSettings(),O=PumpSettings.getStationAddress(),U=PumpSettings.getStationContactLine(),ot=buildSlipRef(e.id,r),ut=formatDisplayDate(getLocalDateString()),rt=e.pf_number?.trim()||"",Z=e.pan_number?.trim()||"",J=e.phone_number?.trim()||"",tt=e.address?.trim()||"",k=[];G&&k.push(`<span>GSTIN: ${escapeHtml(G)}</span>`),N.establishmentCode&&k.push(`<span>PF Est. code: ${escapeHtml(N.establishmentCode)}</span>`);const L=s.length?s.map((F,B)=>`
        <tr>
          <td>${B+1}</td>
          <td>${escapeHtml(formatDisplayDate(F.date))}</td>
          <td class="num">${formatCurrency(F.amount)}</td>
          <td>${escapeHtml(F.note||"\u2014")}</td>
        </tr>`).join(""):'<tr><td colspan="4" style="text-align:center;color:#64748b">No salary disbursements recorded for this month</td></tr>',T=M>.009?`<tr class="salary-slip-summary-balance"><td>Advance paid (over net salary)</td><td>${formatCurrency(M)}</td></tr>`:H>.009?`<tr class="salary-slip-summary-balance"><td>Balance payable (net)</td><td>${formatCurrency(H)}</td></tr>`:'<tr class="salary-slip-summary-paid"><td>Balance payable (net)</td><td>\u20B9 0.00 \u2014 Settled</td></tr>',W=A.employerPf>0?`
      <div class="salary-slip-employer">
        <p class="salary-slip-employer-title">Employer contribution (statutory)</p>
        <table>
          <tr>
            <td>Employer PF (fixed monthly)</td>
            <td>${formatCurrency(A.employerPf)}</td>
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
            ${O?`<p class="salary-slip-address">${escapeHtml(O)}</p>`:""}
            ${U?`<p class="salary-slip-contact">${escapeHtml(U)}</p>`:""}
            ${k.length?`<p class="salary-slip-statutory">${k.join("")}</p>`:""}
          </div>
        </div>
      </header>

      <div class="salary-slip-title-band">
        <h2 class="salary-slip-doc-title">Salary slip</h2>
        <p class="salary-slip-doc-meta">
          <strong>Slip no.</strong> ${escapeHtml(ot)} &nbsp;\xB7&nbsp;
          <strong>Pay period</strong> ${escapeHtml(d)} &nbsp;\xB7&nbsp;
          <strong>Generated</strong> ${escapeHtml(ut)}
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
          <dd>${escapeHtml(f)}</dd>
        </div>
        <div>
          <dt>PF / UAN no.</dt>
          <dd class="salary-slip-mono">${rt?escapeHtml(rt):"\u2014"}</dd>
        </div>
        <div>
          <dt>PAN</dt>
          <dd class="salary-slip-mono">${Z?escapeHtml(Z):"\u2014"}</dd>
        </div>
        <div>
          <dt>Mobile</dt>
          <dd>${J?escapeHtml(J):"\u2014"}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>${tt?escapeHtml(tt):"\u2014"}</dd>
        </div>
        <div>
          <dt>PF wage (gross)</dt>
          <dd>${formatCurrency(A.gross)}</dd>
        </div>
      </dl>

      ${slipAttendanceBlock($)}

      <div class="salary-slip-pay-grid">
        <div class="salary-slip-pay-col">
          <p class="salary-slip-pay-col-title">Earnings</p>
          <table class="salary-slip-pay-table">
            <tr>
              <td>Gross salary</td>
              <td>${formatCurrency(A.gross)}</td>
            </tr>
            ${$?.overDutyAmount>0?`<tr><td>Over duty (${escapeHtml(PayrollRules.formatDayCount($.overDutyDays))} day \xD7 ${formatCurrency($.perDay)})</td><td>${formatCurrency($.overDutyAmount)}</td></tr>`:""}
            <tr class="salary-slip-pay-total">
              <td>Total earnings</td>
              <td>${formatCurrency(_.earnings)}</td>
            </tr>
          </table>
        </div>
        <div class="salary-slip-pay-col salary-slip-pay-col--deductions">
          <p class="salary-slip-pay-col-title">Deductions</p>
          <table class="salary-slip-pay-table">
            ${$?.lopExcluded?`<tr><td>Loss of pay excluded (${escapeHtml(PayrollRules.formatDayCount($.lopDays))} day, not deducted)</td><td>\u20B9 0.00</td></tr>`:$?.lopAmount>0?`<tr><td>Loss of pay (${escapeHtml(PayrollRules.formatDayCount($.lopDays))} day \xD7 ${formatCurrency($.perDay)})</td><td>${formatCurrency($.lopAmount)}</td></tr>`:""}
            <tr>
              <td>Employee PF (fixed monthly)</td>
              <td>${formatCurrency(_.employeePf)}</td>
            </tr>
            <tr class="salary-slip-pay-total">
              <td>Total deductions</td>
              <td>${formatCurrency(roundMoney(($?.lopAmount||0)+_.employeePf))}</td>
            </tr>
          </table>
        </div>
      </div>

      ${W}

      <div class="salary-slip-net-box">
        <span class="salary-slip-net-label">Net salary (take-home)</span>
        <span class="salary-slip-net-amount">${formatCurrency(I)}</span>
      </div>
      <p class="salary-slip-words"><strong>In words:</strong> ${escapeHtml(amountInWordsINR(I))}</p>

      <p class="salary-slip-section-title">Salary disbursements (${escapeHtml(f)})</p>
      <table class="salary-slip-payments">
        <thead>
          <tr>
            <th style="width:7%">#</th>
            <th style="width:24%">Payment date</th>
            <th class="num" style="width:22%">Amount (\u20B9)</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>${L}</tbody>
        <tfoot>
          <tr>
            <td colspan="2">Total disbursed</td>
            <td class="num">${formatCurrency(P)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <table class="salary-slip-summary">
        <tr class="salary-slip-summary-net">
          <td>Net salary for month</td>
          <td>${formatCurrency(I)}</td>
        </tr>
        <tr class="salary-slip-summary-total">
          <td>Total disbursed this month</td>
          <td>${formatCurrency(P)}</td>
        </tr>
        ${T}
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
      <p class="salary-slip-note">Computer-generated salary slip. PF is the fixed monthly amount, capped so take-home is not negative. Loss of pay and over duty use marked attendance only; unmarked days are ignored.${$?.lopExcluded?` Calculated loss of pay (${escapeHtml(formatCurrency($.suggestedLopAmount))}) was excluded from this month's salary.`:""} Disbursement rows are payments recorded for ${escapeHtml(f)}.</p>
    </article>`}let salarySlipPrintCssCache=null;async function getSalarySlipPrintCssText(){if(salarySlipPrintCssCache)return salarySlipPrintCssCache;const e=slipAssetUrl(SALARY_SLIP_PRINT_CSS),s=await fetch(e,{cache:"default"});if(!s.ok)throw new Error("Could not load salary slip print styles.");return salarySlipPrintCssCache=await s.text(),salarySlipPrintCssCache}async function runSalarySlipPrint(e,s,r,u){let y=u,f=!1;if(typeof PayrollRules<"u"){const C=PayrollRules.fetchLopExclusions(window.supabaseClient,r).catch(M=>(AppError.report(M,{context:"printSalarySlipExclusions"}),{ids:new Set,ready:!0})),[A,H]=await Promise.all([y?Promise.resolve(null):PayrollRules.fetchMonthAttendance(window.supabaseClient,r),C]);y||(y=A?.byEmployee.get(e.id)||[]),f=H.ids.has(e.id)}const[d,P]=await Promise.all([Promise.resolve(buildSalarySlipHtml(e,s,r,y||[],{lopExcluded:f})),getSalarySlipPrintCssText()]);await PrintUtils.printInIframe({title:PrintUtils.buildPrintFilename("salary-slip",e.name||"staff",r),bodyHtml:d,cssText:P,iframeTitle:"Salary slip print",imageSelectors:PrintUtils.PRINT_LOGO_IMAGE_SELECTORS})}document.addEventListener("DOMContentLoaded",async()=>{await window.configPromise;const e=await requireAuth({allowedRoles:["admin","supervisor"],onDenied:"dashboard.html",pageName:"salary"});if(!e)return;applyRoleVisibility(e.role);const s=e.role==="admin";async function r(t){if(!t||!window.supabaseClient)return null;const{data:a,error:n}=await window.supabaseClient.from("day_closing").select("certified, night_cash_collection_id").eq("date",t).maybeSingle();return n||!a?null:a.certified?"certified":!s&&a.night_cash_collection_id?"collected":null}function u(t,a){const n=formatDisplayDate(a);return t==="collected"?`Night cash for ${n} is already collected, so that day is closed.`:`Day closing for ${n} is certified and locked.`}typeof loadPumpSettings=="function"&&await loadPumpSettings(),typeof initPageSections=="function"&&initPageSections({defaultSection:"summary",validSections:["summary","record","recent"]});const y=document.getElementById("salary-payment-form"),f=document.getElementById("salary-payment-success"),d=document.getElementById("salary-payment-error"),P=document.getElementById("payment-staff"),C=document.getElementById("payment-date"),A=document.getElementById("payment-amount"),H=document.getElementById("payment-fill-remaining"),M=document.getElementById("payment-salary-month-month"),$=document.getElementById("payment-salary-month-year"),_=document.getElementById("payment-month-hint"),I=document.getElementById("salary-month-month"),G=document.getElementById("salary-month-year"),N=document.getElementById("salary-history-month-month"),O=document.getElementById("salary-history-month-year"),U=document.getElementById("salary-detail-overlay"),ot=document.getElementById("salary-detail-backdrop"),ut=document.getElementById("salary-detail-close"),rt=document.getElementById("salary-detail-dismiss"),Z=document.getElementById("salary-detail-print-slip"),J=document.getElementById("salary-detail-add-payment");C&&initPersistedDateInput(C,RECORD_DATE_KEYS.salaryPayment);const tt=new Date,k=`${tt.getFullYear()}-${String(tt.getMonth()+1).padStart(2,"0")}`;if(populateMonthYearSelects(I,G),populateMonthYearSelects(N,O),populateMonthYearSelects(M,$),writeMonthYearValue(I,G,k),writeMonthYearValue(N,O,k),writeMonthYearValue(M,$,k),typeof mountMonthStepper=="function"){const t=()=>typeof getLocalDateString=="function"?getLocalDateString().slice(0,7):k;mountMonthStepper(I,G,{max:t}),mountMonthStepper(N,O,{max:t})}let L=[],T=[],W=new Map,F="",B="",X=null,Y=new Set,pt="",et=!0;function mt(t){return Y.has(t)}function Et(t,a){if(!s||!a?.lossOfPayEnabled)return"";const n=Number(a.suggestedLopAmount??a.lopAmount)||0;if(n<=0||!et)return"";const o=a.lopExcluded?"0":"1",l=a.lopExcluded?"Include in salary":"Exclude from salary";return`<div class="salary-lop-actions"><button type="button" class="button-secondary button-small salary-lop-toggle" data-staff-id="${escapeHtml(t)}" data-exclude="${o}" data-amount="${n}">${l}</button></div>`}function $t(){if(et)return;const t="Loss-of-pay exclusions need the latest database update. Calculated loss of pay is still deducted.";B=B?`${B} ${t}`:t}async function wt(t,a){if(pt=salaryMonthKey(t),et=!0,typeof PayrollRules>"u"||!PayrollRules.getPayrollConfig().lossOfPayEnabled)return Y=new Set,Y;try{const n=await PayrollRules.fetchLopExclusions(window.supabaseClient,t,a);Y=n.ids,et=n.ready!==!1}catch(n){Y=new Set,et=!1,AppError.report(n,{context:"loadLopExclusions"})}return Y}async function ft(t,a){if(salaryMonthKey(a)===pt)return Y.has(t);if(typeof PayrollRules>"u")return!1;try{return(await PayrollRules.fetchLopExclusions(window.supabaseClient,a)).ids.has(t)}catch(n){return AppError.report(n,{context:"excludedForStaff"}),!1}}async function kt(t,a,n){const o=normalizeSalaryMonth(a),l=e.session?.user?.id;if(!o||!t||!l)throw new Error("Could not save the loss-of-pay exclusion.");if(n){const{error:p}=await window.supabaseClient.from("salary_lop_exclusions").insert({employee_id:t,salary_month:o,created_by:l});if(p&&p.code!=="23505")throw p;return}const{error:i}=await window.supabaseClient.from("salary_lop_exclusions").delete().eq("employee_id",t).eq("salary_month",o);if(i)throw i}async function Pt(t,a,n,o){const l=L.find(b=>b.id===t),i=Number(o)||0,p=formatMonthLabel(a),E=l?.name||"this employee";if(n?await AppDialog.confirm(`Exclude ${formatCurrency(i)} loss of pay from ${E}'s ${p} salary? Payable will not be reduced by that amount.`,{title:"Loss of pay",confirmLabel:"Exclude"}):await AppDialog.confirm(`Include loss of pay in ${E}'s ${p} salary again?`,{title:"Loss of pay",confirmLabel:"Include"}))try{await kt(t,a,n),n?Y.add(t):Y.delete(t),PayrollRules.setCachedLopExclusion(a,t,n);const b=q();salaryMonthKey(b)===salaryMonthKey(a)?await dt(b,{refresh:!1}):await dt(b)}catch(b){AppError.report(b,{context:"toggleLopExclusion"}),AppError.showToast(AppError.getUserMessage(b)||"Could not update loss of pay.","error")}}async function St(t){if(B="",typeof PayrollRules>"u")return W=new Map,W;try{const a=await PayrollRules.fetchMonthAttendance(window.supabaseClient,t,{force:!0});W=a.byEmployee,F=t,a.overDutyColumnReady===!1&&PayrollRules.getPayrollConfig().overDutyEnabled&&(B="Over duty is turned on, but the database update for over duty is not applied yet. Loss of pay still uses attendance.")}catch(a){W=new Map,F=t,B="Attendance could not be loaded, so loss of pay and over duty are not included.",AppError.report(a,{context:"loadMonthAttendanceMap"})}return W}function lt(t){return W.get(t)||[]}async function gt(t,a){if(F===a)return lt(t);if(typeof PayrollRules>"u")return[];try{return(await PayrollRules.fetchMonthAttendance(window.supabaseClient,a)).byEmployee.get(t)||[]}catch(n){return AppError.report(n,{context:"attendanceRecordsFor"}),[]}}const Ct=document.getElementById("salary-history-actions-head"),At=document.getElementById("salary-detail-actions-head");Ct&&(Ct.textContent=s?"Actions":"Slip"),At&&(At.hidden=!s);async function Tt(t,a){if(!s){AppError.showToast("Only an admin can delete salary payments.","warning");return}if(!t?.id)return;const n=a?.name||"this staff member";if(await AppDialog.confirm(`Delete salary payment of ${formatCurrency(t.amount)} for ${n} on ${formatDisplayDate(t.date)}?

The linked expense entry will also be removed. This cannot be undone.`,{title:"Delete payment",confirmLabel:"Delete",danger:!0}))try{await ActionProgress.track({title:"Deleting",status:"Removing this salary payment\u2026",doneStatus:"Deleted"},async()=>{const{error:l}=await window.supabaseClient.rpc("delete_salary_payment",{p_payment_id:t.id});if(l)throw l;typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational"),await ct()})}catch(l){AppError.showToast(AppError.getUserMessage(l),"error"),AppError.report(l,{context:"deleteSalaryPayment",id:t.id})}}function Lt(t){!s||!t||t.dataset.salaryDeleteBound==="1"||(t.dataset.salaryDeleteBound="1",t.addEventListener("click",async a=>{const n=a.target.closest(".salary-delete-btn");if(!n)return;a.stopPropagation(),a.preventDefault();const o=n.getAttribute("data-payment-id"),l=T.find(p=>p.id===o)||await(async()=>{const p=xt();return(await _t(p)).find(g=>g.id===o)})();if(!l){AppError.showToast("Payment not found. Refresh the page and try again.","error");return}const i=L.find(p=>p.id===l.employee_id);n.disabled=!0;try{await Tt(l,i)}finally{n.disabled=!1}}))}function q(){return readMonthYearValue(I,G)||k}function it(){return readMonthYearValue(M,$)||q()}function xt(){return readMonthYearValue(N,O)||q()}function Ft(){writeMonthYearValue(N,O,q()),N?._monthStepper?.sync()}function ht(t){U&&(X=t,Mt(t,q()),AppDialog.show(U,{focus:"#salary-detail-close",onDismiss:V}))}function V(){!U||U.getAttribute("aria-hidden")==="true"||(AppDialog.hide(U),X=null,document.querySelectorAll(".salary-summary-table tbody tr.is-selected").forEach(t=>{t.classList.remove("is-selected")}))}function Mt(t,a){const n=L.find(c=>c.id===t);if(!n)return;const l=paidByStaffInRange(T).get(t)||0,i=getStaffSalaryMonthContext(n,l,a,lt(t),mt(t)),p=paymentsForEmployee(T,t),E=formatMonthLabel(a),g=document.getElementById("salary-detail-title"),b=document.getElementById("salary-detail-subtitle"),x=document.getElementById("salary-detail-stats"),S=document.getElementById("salary-detail-payments-body");g&&(g.textContent=n.name),b&&(b.textContent=`${n.role_display||"Staff"} \xB7 ${E}`);const D=formatCurrency(i.pending),j=i.pending<=.009?"salary-detail-balance is-clear":"salary-detail-balance",K=i.balance.pf,z=n.pf_number?.trim(),v=i.balance?.pay,st=i.balance?.settled;x&&(x.innerHTML=`
        <div><dt>Gross salary</dt><dd>${formatCurrency(n.monthly_salary)}</dd></div>
        <div><dt>Payable</dt><dd>${formatCurrency(i.payable)}</dd></div>
        <div><dt>PF contribution</dt><dd>${K.fixedAmount>0?formatCurrency(st?.employeePf??K.employeePf):'<span class="muted">Not set \u2014 <a href="staff.html">Staff</a></span>'}</dd></div>
        <div><dt>Employer PF</dt><dd>${formatCurrency(K.employerPf)}</dd></div>
        <div><dt>PF / UAN</dt><dd>${z?escapeHtml(z):'<span class="muted">Not set</span>'}</dd></div>
        <div><dt>Mobile</dt><dd>${n.phone_number?escapeHtml(n.phone_number):'<span class="muted">\u2014</span>'}</dd></div>
        <div><dt>Paid this month</dt><dd>${formatCurrency(l)}</dd></div>
        <div><dt>Remaining</dt><dd class="${j}">${D}</dd></div>
        <div><dt>Status</dt><dd><span class="salary-status ${i.className}">${escapeHtml(i.label)}</span></dd></div>
      `);const R=document.getElementById("salary-detail-adjust");if(R)if(!v||!v.lossOfPayEnabled&&!v.overDutyEnabled)R.hidden=!0,R.innerHTML="";else{const c=v.counts||{};R.hidden=!1,R.innerHTML=`
          <div class="salary-adjust-head">
            <h3>Attendance this month</h3>
            <span class="muted">${escapeHtml(PayrollRules.dayRateLabel(v))} \xB7 ${escapeHtml(formatCurrency(v.perDay))} / day</span>
          </div>
          <dl class="salary-adjust-grid">
            <div><dt>Present</dt><dd>${c.present}</dd></div>
            <div><dt>Half-day</dt><dd>${c.half}</dd></div>
            <div><dt>Leave</dt><dd>${escapeHtml(PayrollRules.leaveUsageLabel(v))}</dd></div>
            <div><dt>Loss of pay</dt><dd class="${v.lopExcluded?"salary-lop-excluded":v.lopAmount>0?"salary-money-deduct":""}">${v.lossOfPayEnabled?v.lopExcluded?`Excluded \xB7 ${escapeHtml(formatCurrency(v.suggestedLopAmount))}`:v.lopAmount>0?`${escapeHtml(PayrollRules.formatDayCount(v.lopDays))} \xB7 ${escapeHtml(formatCurrency(v.lopAmount))}`:"\u2014":"Off"}</dd></div>
            <div><dt>Over duty</dt><dd class="${v.overDutyAmount>0?"salary-money-earn":""}">${v.overDutyEnabled?`${escapeHtml(PayrollRules.formatDayCount(v.overDutyDays))} \xB7 ${escapeHtml(formatCurrency(v.overDutyAmount))}`:"Off"}</dd></div>
          </dl>
          <p class="salary-adjust-note">${escapeHtml(v.lossOfPayEnabled?PayrollRules.lopBreakdownLabel(v):"Loss of pay is off.")} Unmarked days are ignored.</p>
          ${Et(t,v)}
        `,R.querySelector(".salary-lop-toggle")?.addEventListener("click",m=>{m.stopPropagation();const h=m.currentTarget;Pt(t,a,h.getAttribute("data-exclude")==="1",h.getAttribute("data-amount"))})}if(S){const c=s?4:3;p.length?S.innerHTML=p.map(m=>`
          <tr>
            <td>${escapeHtml(formatDisplayDate(m.date))}</td>
            <td class="num">${formatCurrency(m.amount)}</td>
            <td>${escapeHtml(m.note??"\u2014")}</td>
            ${s?`<td class="table-actions">${salaryDeleteButtonHtml(m,n,!0)}</td>`:""}
          </tr>`).join(""):S.innerHTML=`<tr><td colspan="${c}" class="muted">No payments recorded for this month.</td></tr>`}Z&&(Z.disabled=!1,Z.title="",Z.onclick=async()=>{try{await runSalarySlipPrint(n,p,a)}catch(c){AppError.report(c,{context:"printSalarySlip"}),AppError.showToast(AppError.getUserMessage(c)||"Could not open the print dialog.","error")}}),J&&(J.disabled=!1,J.title="")}async function Dt(){try{L=await StaffEmployees.loadActiveEmployees(window.supabaseClient,{isAdmin:s,useCache:!0})}catch(t){AppError.report(t,{context:"loadStaffMembers"}),L=[]}return L}async function Ot(t){const a=new Map(L.map(o=>[o.id,o])),n=[...new Set((t||[]).filter(o=>o&&!a.has(o)))];if(!n.length)return a;try{(await StaffEmployees.resolveEmployeesByIds(window.supabaseClient,n)).forEach((l,i)=>a.set(i,l))}catch(o){AppError.report(o,{context:"staffMapForIds"})}return a}function Ut(t,a=!0){if(!t)return;const n=t.value;t.innerHTML=a?'<option value="">Select staff</option>':"",L.forEach(o=>{const l=document.createElement("option");l.value=o.id,l.textContent=`${o.name}${o.role_display?` (${o.role_display})`:""}`,t.appendChild(l)}),n&&L.some(o=>o.id===n)&&(t.value=n)}async function Yt(t,a){const{data:n,error:o}=await fetchAllRows(()=>window.supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").gte("date",t).lte("date",a).order("date",{ascending:!1}).order("id",{ascending:!0}));if(o){if(isMissingSalaryMonthColumn(o)){const{data:l,error:i}=await fetchAllRows(()=>window.supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note").gte("date",t).lte("date",a).order("date",{ascending:!1}).order("id",{ascending:!0}));return i?(AppError.report(i,{context:"loadPaymentsInRange"}),[]):l??[]}return AppError.report(o,{context:"loadPaymentsInRange"}),[]}return n??[]}async function at(t){const a=normalizeSalaryMonth(t);if(!a)return[];const{data:n,error:o}=await fetchAllRows(()=>window.supabaseClient.from("salary_payments").select("id, employee_id, date, amount, note, salary_month").eq("salary_month",a).order("date",{ascending:!1}).order("id",{ascending:!0}));if(o){if(isMissingSalaryMonthColumn(o)){const[l,i]=t.split("-").map(Number),{start:p,end:E}=getMonthRange(l,i-1);return Yt(p,E)}return AppError.report(o,{context:"loadPaymentsForSalaryMonth"}),[]}return n??[]}async function bt(t){return t===q()&&T.length?T:at(t)}async function nt(){if(!_)return;const t=P?.value,a=it();if(!t||!a){_.classList.add("hidden");return}if(!L.find(x=>x.id===t))return;const o=await bt(a),l=await gt(t,a),i=getStaffBalanceForMonth(t,o,L,a,l,await ft(t,a));if(!i)return;const p=formatMonthLabel(a);let E;(i.gross||0)<=0&&!(i.pay?.overDutyAmount>0)?E="no salary configured":i.status.advance>.009?E=`advance ${formatCurrency(i.status.advance)} paid`:i.pending<=.009?E="fully paid":E=`${formatCurrency(i.pending)} remaining`;const g=[];i.pay?.lopExcluded?g.push(`loss of pay excluded ${formatCurrency(i.pay.suggestedLopAmount)}`):i.pay?.lossOfPayEnabled&&i.pay.lopAmount>0&&g.push(`loss of pay ${formatCurrency(i.pay.lopAmount)}`),i.pay?.overDutyEnabled&&g.push(`over duty ${formatCurrency(i.pay.overDutyAmount)}`);const b=g.length?` \xB7 ${g.join(" \xB7 ")}`:"";_.textContent=`${p}: payable ${formatCurrency(i.salary)}${b} \xB7 ${formatCurrency(i.paid)} paid \xB7 ${E}`,_.classList.remove("hidden")}async function Rt(){const t=P?.value;if(!t){d&&(d.textContent="Select a staff member first.",d.classList.remove("hidden"));return}d?.classList.add("hidden");const a=it(),n=await bt(a),o=await gt(t,a),l=getStaffBalanceForMonth(t,n,L,a,o,await ft(t,a));if(!l||l.pending<=.009){A&&(A.value="");return}A&&(A.value=l.pending.toFixed(2))}async function dt(t,a){const n=document.getElementById("salary-summary-body"),o=document.getElementById("salary-kpi-payroll"),l=document.getElementById("salary-kpi-paid"),i=document.getElementById("salary-kpi-pending");if(!n)return;const p=document.getElementById("salary-kpi-lop"),E=document.getElementById("salary-kpi-od"),g=document.getElementById("salary-summary-table"),b=document.getElementById("salary-payroll-note"),x=typeof PayrollRules<"u"?PayrollRules.getPayrollConfig():null;if(g?.classList.toggle("show-lop",!!x?.lossOfPayEnabled),g?.classList.toggle("show-od",!!x?.overDutyEnabled),document.getElementById("salary-kpi-lop-card")?.classList.toggle("hidden",!x?.lossOfPayEnabled),document.getElementById("salary-kpi-od-card")?.classList.toggle("hidden",!x?.overDutyEnabled),!L.length){n.innerHTML='<tr><td colspan="9" class="muted">Add staff in <a href="staff.html">HR \u2192 Staff</a> first.</td></tr>',o&&(o.textContent="\u2014"),l&&(l.textContent="\u2014"),i&&(i.textContent="\u2014"),p&&(p.textContent="\u2014"),E&&(E.textContent="\u2014");return}if(a?.refresh!==!1){const[c]=await Promise.all([at(t),St(t),wt(t,{force:!0})]);T=c,$t()}const S=paidByStaffInRange(T);let D=0,j=0,K=0,z=0,v=0;const st=L.map(c=>{const m=S.get(c.id)||0,h=getStaffSalaryMonthContext(c,m,t,lt(c.id),mt(c.id)),w=h.balance?.pay;D+=h.payable,j+=m,K+=h.pending,z+=w?.lopAmount||0,v+=w?.overDutyAmount||0;const yt=h.advance>.009?`<span class="muted">Advance ${formatCurrency(h.advance)}</span>`:formatCurrency(h.pending),Q=escapeHtml(c.name),qt=escapeHtml(c.role_display??"\u2014"),jt=Number(w?.suggestedLopAmount??w?.lopAmount)||0,Gt=w?.lossOfPayEnabled?w.lopExcluded?`<span class="salary-lop-excluded">Excluded</span> <span class="muted">${escapeHtml(formatCurrency(jt))}</span>`:w.lopAmount>0?escapeHtml(formatCurrency(w.lopAmount)):"\u2014":"Off",Wt=Et(c.id,w),Kt=w?.overDutyEnabled?formatCurrency(w.overDutyAmount):"Off";return`
          <tr data-staff-id="${escapeHtml(c.id)}" tabindex="0" role="button" aria-label="View ${Q} salary details">
            <td>${Q}</td>
            <td>${qt}</td>
            <td class="num">${formatCurrency(h.payable)}</td>
            <td class="num salary-col-lop${w?.lopAmount>0?" salary-money-deduct":""}"><div class="salary-lop-cell">${Gt}${Wt}</div></td>
            <td class="num salary-col-od${w?.overDutyAmount>0?" salary-money-earn":""}">${Kt}</td>
            <td class="num">${formatCurrency(m)}</td>
            <td class="num">${yt}</td>
            <td><span class="salary-status ${h.className}">${escapeHtml(h.label)}</span></td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small salary-view-btn" data-staff-id="${escapeHtml(c.id)}">Details</button>
              <button type="button" class="button-secondary button-small salary-slip-btn" data-staff-id="${escapeHtml(c.id)}">Slip</button>
              <button type="button" class="button-secondary button-small add-payment-btn" data-staff-id="${escapeHtml(c.id)}">Pay</button>
            </td>
          </tr>
        `});if(o&&(o.textContent=formatCurrency(D)),l&&(l.textContent=formatCurrency(j)),i&&(i.textContent=formatCurrency(K)),p&&(p.textContent=formatCurrency(z)),E&&(E.textContent=formatCurrency(v)),b){const c=x&&PayrollRules.rulesAffectPay(x)?PayrollRules.policySummary(x):null,m=[B,c?.rate].filter(Boolean).join(" ");b.textContent=m,b.classList.toggle("hidden",!m)}const R=document.getElementById("salary-kpi-note");R&&(R.classList.add("hidden"),R.textContent=""),n.innerHTML=st.join(""),n.querySelectorAll("tr[data-staff-id]").forEach(c=>{const m=c.getAttribute("data-staff-id");c.addEventListener("click",h=>{h.target.closest("button")||(ht(m),n.querySelectorAll("tr.is-selected").forEach(w=>w.classList.remove("is-selected")),c.classList.add("is-selected"))}),c.addEventListener("keydown",h=>{(h.key==="Enter"||h.key===" ")&&(h.preventDefault(),ht(m))})}),n.querySelectorAll(".salary-view-btn").forEach(c=>{c.addEventListener("click",m=>{m.stopPropagation(),ht(c.getAttribute("data-staff-id"))})}),n.querySelectorAll(".salary-slip-btn").forEach(c=>{c.addEventListener("click",async m=>{if(m.stopPropagation(),c.disabled)return;const h=c.getAttribute("data-staff-id"),w=L.find(Q=>Q.id===h);if(!w)return;const yt=paymentsForEmployee(T,h);try{await runSalarySlipPrint(w,yt,t)}catch(Q){AppError.report(Q,{context:"printSalarySlipQuick"}),AppError.showToast(AppError.getUserMessage(Q)||"Could not open the print dialog.","error")}})}),n.querySelectorAll(".salary-lop-toggle").forEach(c=>{c.addEventListener("click",m=>{m.stopPropagation();const h=c.getAttribute("data-staff-id"),w=c.getAttribute("data-exclude")==="1";Pt(h,t,w,c.getAttribute("data-amount"))})}),n.querySelectorAll(".add-payment-btn").forEach(c=>{c.addEventListener("click",m=>{if(m.stopPropagation(),c.disabled)return;const h=c.getAttribute("data-staff-id");Ht(h)})}),X&&Mt(X,t),nt()}function Ht(t,a={}){const n=a.salaryMonth||q();P&&(P.value=t),writeMonthYearValue(M,$,n),C&&(C.value=suggestPaymentDate(n)),A&&(A.value=""),nt().then(()=>Rt()),document.querySelector('.settings-nav-item[data-section="record"]')?.click(),y?.scrollIntoView({behavior:"smooth"})}async function vt(t){const a=document.getElementById("salary-payments-body");if(!a)return;const n=await at(t);if(!n.length){a.innerHTML=`<tr><td colspan="5" class="muted">No payments for ${escapeHtml(formatMonthLabel(t))} salary.</td></tr>`;return}const o=await Ot(n.map(l=>l.employee_id));a.innerHTML=n.map(l=>{const i=o.get(l.employee_id),p=escapeHtml(StaffEmployees.displayName(i)),E=l.employee_id,g=i?"":' disabled title="Staff record not found"';return`
          <tr>
            <td>${escapeHtml(formatDisplayDate(l.date))}</td>
            <td>${p}</td>
            <td class="num">${formatCurrency(l.amount)}</td>
            <td>${escapeHtml(l.note??"\u2014")}</td>
            <td class="table-actions">
              <button type="button" class="button-secondary button-small history-slip-btn" data-staff-id="${escapeHtml(E)}"${g}>Slip</button>
              ${salaryDeleteButtonHtml(l,i,s)}
            </td>
          </tr>
        `}).join(""),a.querySelectorAll(".history-slip-btn").forEach(l=>{l.addEventListener("click",async()=>{const i=l.getAttribute("data-staff-id"),p=o.get(i);if(!p)return;const E=await _t(t),g=paymentsForEmployee(E,i);try{await runSalarySlipPrint(p,g,t)}catch(b){AppError.report(b,{context:"printHistorySlip"}),AppError.showToast(AppError.getUserMessage(b)||"Could not open the print dialog.","error")}})})}async function _t(t){return at(t)}async function ct(){await Dt(),Ut(P);const t=q(),a=xt();t&&(await dt(t),await vt(a))}y&&y.addEventListener("submit",async t=>{t.preventDefault();const a=y.querySelector('button[type="submit"]');a&&(a.disabled=!0,a.textContent="Saving\u2026"),f?.classList.add("hidden"),d?.classList.add("hidden");const n=P?.value;let o=C?.value;const l=Number(A?.value||0),i=document.getElementById("payment-note")?.value?.trim()||null,p=it(),E=normalizeSalaryMonth(p||o?.slice(0,7)),g=()=>{a&&(a.disabled=!1,a.textContent="Save payment")};if(!n){g(),d?.classList.remove("hidden"),d&&(d.textContent="Select a staff member.");return}if(!o){g(),d?.classList.remove("hidden"),d&&(d.textContent="Payment date is required.");return}if(o>getLocalDateString()){g(),d?.classList.remove("hidden"),d&&(d.textContent="Payment date cannot be in the future.");return}if(l<=0){g(),d?.classList.remove("hidden"),d&&(d.textContent="Amount must be greater than 0.");return}if(!E){g(),d?.classList.remove("hidden"),d&&(d.textContent="Select the salary month this payment applies to.");return}const b=await bt(p),x=await gt(n,p),S=getStaffBalanceForMonth(n,b,L,p,x,await ft(n,p)),D=await r(o);if(D){const m=getLocalDateString(),h=S&&S.pending>.009&&l<=S.pending+.009,w=o===m?D:await r(m);if(h&&o!==m&&!w){if(!await AppDialog.confirm(`${u(D,o)} Record ${formatCurrency(l)} on ${formatDisplayDate(m)} instead? The salary month stays ${formatMonthLabel(p)}.`,{title:"Record payment",confirmLabel:"Record on today"})){g();return}o=m,C&&(C.value=m)}else{g(),d?.classList.remove("hidden"),d&&(d.textContent=h?`${u(D,o)} Today is locked too, so record this salary on the next open day.`:`${u(D,o)} Remaining salary can be recorded on an open day. This day stays locked.`);return}}let j=!1;if(S&&S.salary>0&&l>S.pending+.009){const m=roundMoney(l-S.pending),h=S.pending<=.009?`Net salary for ${formatMonthLabel(p)} is already settled. Record ${formatCurrency(l)} as advance?`:`Amount exceeds remaining balance (${formatCurrency(S.pending)}). This will overpay by ${formatCurrency(m)}. Continue?`;if(!await AppDialog.confirm(h,{title:"Record payment",confirmLabel:"Record"})){g();return}j=!0}const K=formRequestId(y,[n,o,E,l,i]),z=m=>window.supabaseClient.rpc("record_salary_payment",{p_employee_id:n,p_date:o,p_salary_month:E,p_amount:l,p_note:i,p_allow_overpay:m,p_request_id:K});let{error:v}=await z(j);if(v?.hint==="salary_overpay"){let m=null;try{m=Number(JSON.parse(v.details||"{}").pending)}catch{m=null}const h=Number.isFinite(m)?`Remaining salary for ${formatMonthLabel(p)} is now ${formatCurrency(m)} (another payment was recorded). Record ${formatCurrency(l)} anyway?`:`This amount exceeds the remaining salary for ${formatMonthLabel(p)}. Record it anyway?`;if(!await AppDialog.confirm(h,{title:"Record payment",confirmLabel:"Record anyway"})){g(),await ct();return}({error:v}=await z(!0))}if(v){g(),AppError.handle(v,{target:d});return}clearFormRequestId(y),g();const st=o,R=p,c=n;finishRecordFormSave(y,{date:st},{date:RECORD_DATE_KEYS.salaryPayment}),R&&writeMonthYearValue(M,$,R),f?.classList.remove("hidden"),await ct(),P&&c&&L.some(m=>m.id===c)&&(P.value=c),nt(),typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("operational")}),P?.addEventListener("change",nt),H?.addEventListener("click",Rt);async function It(){const t=it();if(C&&t){let a=suggestPaymentDate(t);if(await r(a)){const n=getLocalDateString();await r(n)||(a=n)}C.value=a}nt()}M?.addEventListener("change",It),$?.addEventListener("change",It);function Bt(t,a,n){if(!t||!a)return;const o=async()=>{const l=readMonthYearValue(t,a);l&&await n(l)};t.addEventListener("change",o),a.addEventListener("change",o)}Bt(I,G,async t=>{Ft(),writeMonthYearValue(M,$,t),await dt(t),await vt(t)}),Bt(N,O,async t=>{await vt(t)});const Nt=document.getElementById("salary-download-csv");Nt&&Nt.addEventListener("click",async()=>{const t=q();if(!t)return;await Dt();const a=F===t&&pt===salaryMonthKey(t),[n]=await Promise.all([at(t),a?Promise.resolve():St(t),a?Promise.resolve():wt(t)]);a||$t();const o=paidByStaffInRange(n),l=["Name","Role","Payable (\u20B9)","Loss of pay (\u20B9)","Loss of pay days","Loss of pay excluded","Over duty (\u20B9)","Over duty days","Paid this month (\u20B9)","Remaining (\u20B9)","Status"],i=L.map(b=>{const x=o.get(b.id)||0,S=getStaffSalaryMonthContext(b,x,t,lt(b.id),mt(b.id)),D=S.balance?.pay,j=S.advance>.009?`Advance ${S.advance}`:String(S.pending);return[String(b.name??"").replace(/"/g,'""'),String(b.role_display??"").replace(/"/g,'""'),String(S.payable),String(D?.lopAmount??0),String(D?.lopDays??0),D?.lopExcluded?"Yes":"No",String(D?.overDutyAmount??0),String(D?.overDutyDays??0),String(x),j,S.label]}),p=[l.join(","),...i.map(b=>b.map(x=>`"${x}"`).join(","))].join(`
`),E=new Blob(["\uFEFF"+p],{type:"text/csv;charset=utf-8"}),g=document.createElement("a");g.href=URL.createObjectURL(E),g.download=`salary-summary-${t}.csv`,g.click(),URL.revokeObjectURL(g.href)}),ut?.addEventListener("click",V),rt?.addEventListener("click",V),ot?.addEventListener("click",V),J?.addEventListener("click",()=>{X&&(V(),Ht(X))}),document.addEventListener("keydown",t=>{t.key==="Escape"&&U?.getAttribute("aria-hidden")==="false"&&V()}),Lt(document.getElementById("salary-payments-body")),Lt(document.getElementById("salary-detail-payments-body")),await ct()});
