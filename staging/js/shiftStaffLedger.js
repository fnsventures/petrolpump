(function(B){const F="salary";let g=null,u=null,S=null,$=null,y=null,a=null,v=[],x=[],A=[],N=[],m=[],f=-1,D=null,H=!1,_="credit";function o(e){return document.getElementById(e)}function k(){return g=o("shift-ledger-overlay"),u=o("shift-ledger-body"),S=o("shift-ledger-title"),$=o("shift-ledger-subtitle"),!!(g&&u)}async function O(){const{data:e,error:t}=await window.supabaseClient.from("expense_categories").select("name, label, sort_order").order("sort_order",{ascending:!0}).order("label",{ascending:!0});if(t)throw t;A=(e||[]).filter(i=>i.name!==F)}async function j(){const{data:e,error:t}=await window.supabaseClient.from("credit_customers").select("id, customer_name, vehicle_no, mobile, address, amount_due, prepaid_balance").order("customer_name",{ascending:!0}).limit(500);if(t)throw t;const i=new Map;(e||[]).forEach(s=>{const d=(s.customer_name||"").trim();if(!d)return;const l=typeof normCustomerName=="function"?normCustomerName(d):d.toLowerCase(),r=Number(s.amount_due)||0,n=Number(s.prepaid_balance)||0,p=r-n,h=i.get(l);h?h.netBalance+=p:i.set(l,{name:d,nameNorm:l,vehicleNo:s.vehicle_no||"",mobile:s.mobile||"",address:s.address||"",primaryId:s.id,netBalance:p})}),N=Array.from(i.values()).sort((s,d)=>s.name.localeCompare(d.name,void 0,{sensitivity:"base"}))}async function C(){if(!a)return;const{data:e,error:t}=await window.supabaseClient.rpc("get_shift_staff_ledger",{p_date:a.date,p_shift:a.shift});if(t)throw t;const i=a.employeeId;v=(e?.credit||[]).filter(s=>s.employee_id===i),x=(e?.expenses||[]).filter(s=>s.employee_id===i)}function U(e){return A.find(i=>i.name===e)?.label||e||"\u2014"}function T(){return v.reduce((e,t)=>e+(Number(t.amount)||0),0)}function M(){return x.reduce((e,t)=>e+(Number(t.amount)||0),0)}function w(){typeof a?.onChange=="function"&&a.onChange({employeeId:a.employeeId,credit:T(),expense:M(),creditRows:v.slice(),expenseRows:x.slice()})}function c(e,t){const i=o("shift-ledger-msg");if(i){if(!e){i.textContent="",i.classList.add("hidden"),i.classList.remove("error","success");return}i.textContent=e,i.classList.remove("hidden","error","success"),i.classList.add(t?"error":"success")}}function Y(e){const t=typeof normCustomerName=="function"?normCustomerName(e):String(e||"").toLowerCase();return t?N.filter(i=>i.nameNorm.includes(t)).slice(0,40):N.slice(0,40)}function E(e){const t=o("shift-ledger-customer"),i=o("shift-ledger-customer-list");!t||!i||(t.setAttribute("aria-expanded",e?"true":"false"),i.classList.toggle("hidden",!e),i.hidden=!e,e||(f=-1))}function q(e){const t=o("shift-ledger-customer-list");if(t){if(m=Y(e),f=-1,!m.length){t.innerHTML='<li class="combobox-empty" role="presentation">No matching customers \u2014 new name will be created</li>',E(!!String(e||"").trim());return}t.innerHTML=m.map((i,s)=>`<li class="combobox-option" role="option" data-index="${s}">${escapeHtml(i.name)}</li>`).join(""),t.querySelectorAll(".combobox-option").forEach((i,s)=>{i.addEventListener("mousedown",d=>{d.preventDefault(),R(m[s])})}),E(!0)}}function R(e){const t=o("shift-ledger-customer");t&&e&&(t.value=e.name),E(!1),o("shift-ledger-credit-amount")?.focus()}function G(e){return a?.readonly||Number(e.amount_settled)>0?!1:H||e.created_by&&e.created_by===D}function P(e){return a?.readonly?!1:H||e.created_by&&e.created_by===D}function b(){if(!u||!a)return;const e=!!a.readonly,t=A.map(n=>`<option value="${escapeHtml(n.name)}">${escapeHtml(n.label)}</option>`).join(""),i=_==="expense"?"expense":"credit",s=v.length?`<ul class="shift-ledger-list">${v.map(n=>{const p=G(n)?`<button type="button" class="shift-ledger-remove shift-ledger-del-credit" data-id="${escapeHtml(n.id)}" aria-label="Remove">\xD7</button>`:"";return`<li>
              <div class="shift-ledger-item-main">
                <strong>${escapeHtml(n.customer_name||"Customer")}</strong>
                <span class="muted">${escapeHtml(n.fuel_type||"HSD")}</span>
              </div>
              <div class="shift-ledger-row-amt">
                <strong>${formatCurrency(n.amount)}</strong>
                ${p}
              </div>
            </li>`}).join("")}</ul>`:'<p class="muted shift-ledger-empty">No credit added yet.</p>',d=x.length?`<ul class="shift-ledger-list">${x.map(n=>{const p=P(n)?`<button type="button" class="shift-ledger-remove shift-ledger-del-expense" data-id="${escapeHtml(n.id)}" aria-label="Remove">\xD7</button>`:"";return`<li>
              <div class="shift-ledger-item-main">
                <strong>${escapeHtml(U(n.category))}</strong>
                ${n.description?`<span class="muted">${escapeHtml(n.description)}</span>`:""}
              </div>
              <div class="shift-ledger-row-amt">
                <strong>${formatCurrency(n.amount)}</strong>
                ${p}
              </div>
            </li>`}).join("")}</ul>`:'<p class="muted shift-ledger-empty">No expenses added yet.</p>',l=e?"":`<form id="shift-ledger-credit-form" class="shift-ledger-form">
          <div class="shift-ledger-form-grid">
            <div class="shift-ledger-field shift-ledger-field--grow">
              <label for="shift-ledger-customer">Customer</label>
              <div class="combobox">
                <input id="shift-ledger-customer" name="customer_name" type="text" autocomplete="off"
                  aria-autocomplete="list" aria-expanded="false" aria-controls="shift-ledger-customer-list"
                  placeholder="Name" required />
                <ul id="shift-ledger-customer-list" class="combobox-list hidden" role="listbox" hidden></ul>
              </div>
            </div>
            <div class="shift-ledger-field">
              <label for="shift-ledger-fuel">Fuel</label>
              <select id="shift-ledger-fuel" name="fuel_type">
                <option value="HSD">HSD</option>
                <option value="MS">MS</option>
              </select>
            </div>
            <div class="shift-ledger-field">
              <label for="shift-ledger-credit-amount">Amount</label>
              <input id="shift-ledger-credit-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" required />
            </div>
            <div class="shift-ledger-field shift-ledger-field--action">
              <label class="sr-only" for="shift-ledger-credit-submit">Save</label>
              <button id="shift-ledger-credit-submit" type="submit">Add</button>
            </div>
          </div>
        </form>`,r=e?"":`<form id="shift-ledger-expense-form" class="shift-ledger-form">
          <div class="shift-ledger-form-grid">
            <div class="shift-ledger-field shift-ledger-field--grow">
              <label for="shift-ledger-expense-cat">Category</label>
              <select id="shift-ledger-expense-cat" name="category" required>
                <option value="">Select\u2026</option>
                ${t}
              </select>
            </div>
            <div class="shift-ledger-field">
              <label for="shift-ledger-expense-amount">Amount</label>
              <input id="shift-ledger-expense-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0.00" required />
            </div>
            <div class="shift-ledger-field shift-ledger-field--full">
              <label for="shift-ledger-expense-desc">Description</label>
              <input id="shift-ledger-expense-desc" name="description" type="text" maxlength="500" placeholder="Optional note" autocomplete="off" />
            </div>
            <div class="shift-ledger-field shift-ledger-field--action">
              <label class="sr-only" for="shift-ledger-expense-submit">Save</label>
              <button id="shift-ledger-expense-submit" type="submit">Add</button>
            </div>
          </div>
        </form>`;u.innerHTML=`
      <div class="shift-ledger-summary" aria-live="polite">
        <div class="shift-ledger-summary-item">
          <span class="muted">Credit</span>
          <strong>${formatCurrency(T())}</strong>
        </div>
        <div class="shift-ledger-summary-item">
          <span class="muted">Expenses</span>
          <strong>${formatCurrency(M())}</strong>
        </div>
      </div>
      <div class="shift-ledger-tabs" role="tablist">
        <button type="button" class="shift-ledger-tab${i==="credit"?" is-active":""}" data-tab="credit" role="tab" aria-selected="${i==="credit"}">Credit</button>
        <button type="button" class="shift-ledger-tab${i==="expense"?" is-active":""}" data-tab="expense" role="tab" aria-selected="${i==="expense"}">Expenses</button>
      </div>
      <p id="shift-ledger-msg" class="hidden" role="status"></p>
      <div class="shift-ledger-panel" data-panel="credit" ${i==="credit"?"":"hidden"}>
        ${l}
        ${s}
      </div>
      <div class="shift-ledger-panel" data-panel="expense" ${i==="expense"?"":"hidden"}>
        ${r}
        ${d}
      </div>`,u.querySelectorAll(".shift-ledger-tab").forEach(n=>{n.addEventListener("click",()=>{_=n.dataset.tab==="expense"?"expense":"credit",b(),_==="credit"?o("shift-ledger-customer")?.focus():o("shift-ledger-expense-cat")?.focus()})}),e||(J(),i==="credit"&&z()),K()}function z(){const e=o("shift-ledger-customer");e&&(e.addEventListener("input",()=>q(e.value)),e.addEventListener("focus",()=>q(e.value)),e.addEventListener("blur",()=>setTimeout(()=>E(!1),150)),e.addEventListener("keydown",t=>{t.key==="ArrowDown"&&m.length?(t.preventDefault(),f=Math.min(f+1,m.length-1),I()):t.key==="ArrowUp"&&m.length?(t.preventDefault(),f=Math.max(f-1,0),I()):t.key==="Enter"&&f>=0?(t.preventDefault(),R(m[f])):t.key==="Escape"&&E(!1)}))}function I(){o("shift-ledger-customer-list")?.querySelectorAll(".combobox-option").forEach((t,i)=>{t.classList.toggle("is-active",i===f)})}function J(){o("shift-ledger-credit-form")?.addEventListener("submit",e=>{e.preventDefault(),Q(e.currentTarget)}),o("shift-ledger-expense-form")?.addEventListener("submit",e=>{e.preventDefault(),V(e.currentTarget)})}function K(){u?.querySelectorAll(".shift-ledger-del-credit").forEach(e=>{e.addEventListener("click",()=>void W(e.dataset.id))}),u?.querySelectorAll(".shift-ledger-del-expense").forEach(e=>{e.addEventListener("click",()=>void X(e.dataset.id))})}async function Q(e){c("");const t=new FormData(e),i=String(t.get("customer_name")||"").trim(),s=Number(t.get("amount")||0),d=String(t.get("fuel_type")||"HSD").trim()||"HSD";if(!i||s<=0){c("Customer and amount are required.",!0);return}const l=e.querySelector('button[type="submit"]');l&&(l.disabled=!0,l.textContent="\u2026");try{const{error:r}=await window.supabaseClient.rpc("add_credit_entry",{p_customer_name:i,p_transaction_date:a.date,p_amount:s,p_fuel_type:d,p_employee_id:a.employeeId,p_shift:a.shift});if(r)throw r;e.reset();const n=o("shift-ledger-fuel");n&&(n.value="HSD"),await C(),b(),w(),c("Credit added."),o("shift-ledger-customer")?.focus()}catch(r){AppError.report(r,{context:"ShiftStaffLedger.submitCredit"}),c(r?.message||"Could not save credit.",!0),l&&(l.disabled=!1,l.textContent="Add")}}async function V(e){c("");const t=new FormData(e),i=String(t.get("category")||"").trim(),s=Number(t.get("amount")||0),d=String(t.get("description")||"").trim();if(!i||s<=0){c("Category and amount are required.",!0);return}const l=e.querySelector('button[type="submit"]');l&&(l.disabled=!0,l.textContent="\u2026");try{const{error:r}=await window.supabaseClient.rpc("add_shift_expense",{p_date:a.date,p_shift:a.shift,p_employee_id:a.employeeId,p_category:i,p_amount:s,p_description:d||null});if(r)throw r;e.reset(),await C(),b(),w(),c("Expense added."),o("shift-ledger-expense-cat")?.focus()}catch(r){AppError.report(r,{context:"ShiftStaffLedger.submitExpense"}),c(r?.message||"Could not save expense.",!0),l&&(l.disabled=!1,l.textContent="Add")}}async function W(e){if(!(!e||!confirm("Remove this credit sale from the shift?"))){c("");try{const{error:t}=await window.supabaseClient.rpc("delete_shift_credit_entry",{p_entry_id:e});if(t)throw t;await C(),b(),w(),c("Credit sale removed.")}catch(t){AppError.report(t,{context:"ShiftStaffLedger.deleteCredit"}),c(t?.message||"Could not remove credit sale.",!0)}}}async function X(e){if(!(!e||!confirm("Remove this expense from the shift?"))){c("");try{const{error:t}=await window.supabaseClient.rpc("delete_shift_expense",{p_expense_id:e});if(t)throw t;await C(),b(),w(),c("Expense removed.")}catch(t){AppError.report(t,{context:"ShiftStaffLedger.deleteExpense"}),c(t?.message||"Could not remove expense.",!0)}}}function L(){if(!(!g||g.getAttribute("aria-hidden")==="true")){if(g.setAttribute("aria-hidden","true"),document.body.classList.remove("modal-open"),a=null,y&&typeof y.focus=="function")try{y.focus()}catch{}y=null}}async function Z(e){if(k()){if(y=document.activeElement,a={date:e.date,shift:e.shift,employeeId:e.employeeId,employeeName:e.employeeName||"Staff",readonly:!!e.readonly,onChange:e.onChange},_=e.focusTab==="expense"?"expense":"credit",D=e.userId||null,H=!!e.isAdmin,S&&(S.textContent=a.employeeName),$){const t=a.shift==="afternoon"?"Afternoon":"Morning";$.textContent=`${formatDisplayDate?.(a.date)||a.date} \xB7 ${t} \xB7 Credit & expenses`}u.innerHTML='<p class="muted">Loading\u2026</p>',g.setAttribute("aria-hidden","false"),document.body.classList.add("modal-open");try{await Promise.all([O(),j(),C()]),b(),w(),_==="credit"?o("shift-ledger-customer")?.focus():o("shift-ledger-expense-cat")?.focus()}catch(t){AppError.report(t,{context:"ShiftStaffLedger.open"}),u.innerHTML=`<p class="error">${escapeHtml(t?.message||"Could not load.")}</p>`}}}function ee(){k()&&(o("shift-ledger-close")?.addEventListener("click",L),o("shift-ledger-dismiss")?.addEventListener("click",L),o("shift-ledger-backdrop")?.addEventListener("click",L),document.addEventListener("keydown",e=>{e.key==="Escape"&&g?.getAttribute("aria-hidden")==="false"&&L()}))}async function te(e,t){const{data:i,error:s}=await window.supabaseClient.rpc("get_shift_staff_ledger",{p_date:e,p_shift:t});if(s)throw s;const d=new Map;function l(r,n,p){if(!r)return;let h=d.get(r);h||(h={credit:0,expense:0},d.set(r,h)),h[n]+=Number(p)||0}return(i?.credit||[]).forEach(r=>l(r.employee_id,"credit",r.amount)),(i?.expenses||[]).forEach(r=>l(r.employee_id,"expense",r.amount)),d}B.ShiftStaffLedger={init:ee,open:Z,close:L,fetchTotalsByEmployee:te}})(typeof window<"u"?window:globalThis);
