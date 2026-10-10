(function(F){const U="salary";let g=null,f=null,A=null,$=null,y=null,o=null,v=[],x=[],R=[],E=[],I=0,m=[],u=-1,D=null,T=!1,_="credit";function i(e){return document.getElementById(e)}function N(){return g=i("shift-ledger-overlay"),f=i("shift-ledger-body"),A=i("shift-ledger-title"),$=i("shift-ledger-subtitle"),!!(g&&f)}async function B(){const{data:e,error:t}=await window.supabaseClient.from("expense_categories").select("name, label, sort_order").order("sort_order",{ascending:!0}).order("label",{ascending:!0}).limit(LOOKUP_ROW_LIMIT);if(t)throw t;R=(e||[]).filter(s=>s.name!==U)}async function G(e){const t=++I,s=await searchCreditCustomers(e);if(t!==I)return null;const l=new Map;return s.forEach(c=>{const a=(c.customer_name||"").trim();if(!a)return;const r=typeof normCustomerName=="function"?normCustomerName(a):a.toLowerCase();l.has(r)||l.set(r,{name:a,nameNorm:r})}),E=Array.from(l.values()),E}async function C(){if(!o)return;const{data:e,error:t}=await window.supabaseClient.rpc("get_shift_staff_ledger",{p_date:o.date,p_shift:o.shift});if(t)throw t;const s=o.employeeId;v=(e?.credit||[]).filter(l=>l.employee_id===s),x=(e?.expenses||[]).filter(l=>l.employee_id===s)}function j(e){return R.find(s=>s.name===e)?.label||e||"\u2014"}function M(){return v.reduce((e,t)=>e+(Number(t.amount)||0),0)}function k(){return x.reduce((e,t)=>e+(Number(t.amount)||0),0)}function w(){typeof o?.onChange=="function"&&o.onChange({employeeId:o.employeeId,credit:M(),expense:k(),creditRows:v.slice(),expenseRows:x.slice()})}function d(e,t){const s=i("shift-ledger-msg");if(s){if(!e){s.textContent="",s.classList.add("hidden"),s.classList.remove("error","success");return}s.textContent=e,s.classList.remove("hidden","error","success"),s.classList.add(t?"error":"success")}}function P(e){const t=typeof normCustomerName=="function"?normCustomerName(e):String(e||"").toLowerCase();return t?E.filter(s=>s.nameNorm.includes(t)).slice(0,CREDIT_CUSTOMER_SUGGEST_LIMIT):E.slice(0,CREDIT_CUSTOMER_SUGGEST_LIMIT)}function S(e){const t=i("shift-ledger-customer"),s=i("shift-ledger-customer-list");!t||!s||(t.setAttribute("aria-expanded",e?"true":"false"),s.classList.toggle("hidden",!e),s.hidden=!e,e||(u=-1))}async function H(e){if(i("shift-ledger-customer-list"))try{if(!await G(e)||i("shift-ledger-customer")?.value!==e&&String(e||"")!=="")return;Y(e)}catch(s){AppError.report(s,{context:"ShiftStaffLedger.searchCustomers"})}}function Y(e){const t=i("shift-ledger-customer-list");if(t){if(m=P(e),u=-1,!m.length){t.innerHTML='<li class="combobox-empty" role="presentation">No matching customers \u2014 new name will be created</li>',S(!!String(e||"").trim());return}t.innerHTML=m.map((s,l)=>`<li class="combobox-option" role="option" data-index="${l}">${escapeHtml(s.name)}</li>`).join(""),t.querySelectorAll(".combobox-option").forEach((s,l)=>{s.addEventListener("mousedown",c=>{c.preventDefault(),q(m[l])})}),S(!0)}}function q(e){const t=i("shift-ledger-customer");t&&e&&(t.value=e.name),S(!1),i("shift-ledger-credit-amount")?.focus()}function K(e){return o?.readonly||Number(e.amount_settled)>0?!1:T||e.created_by&&e.created_by===D}function W(e){return o?.readonly?!1:T||e.created_by&&e.created_by===D}function h(){if(!f||!o)return;const e=!!o.readonly,t=R.map(n=>`<option value="${escapeHtml(n.name)}">${escapeHtml(n.label)}</option>`).join(""),s=_==="expense"?"expense":"credit",l=v.length?`<ul class="shift-ledger-list">${v.map(n=>{const p=K(n)?`<button type="button" class="shift-ledger-remove shift-ledger-del-credit" data-id="${escapeHtml(n.id)}" aria-label="Remove">\xD7</button>`:"";return`<li>
              <div class="shift-ledger-item-main">
                <strong>${escapeHtml(n.customer_name||"Customer")}</strong>
                <span class="muted">${escapeHtml(n.fuel_type||"HSD")}</span>
              </div>
              <div class="shift-ledger-row-amt">
                <strong>${formatCurrency(n.amount)}</strong>
                ${p}
              </div>
            </li>`}).join("")}</ul>`:'<p class="muted shift-ledger-empty">No credit added yet.</p>',c=x.length?`<ul class="shift-ledger-list">${x.map(n=>{const p=W(n)?`<button type="button" class="shift-ledger-remove shift-ledger-del-expense" data-id="${escapeHtml(n.id)}" aria-label="Remove">\xD7</button>`:"";return`<li>
              <div class="shift-ledger-item-main">
                <strong>${escapeHtml(j(n.category))}</strong>
                ${n.description?`<span class="muted">${escapeHtml(n.description)}</span>`:""}
              </div>
              <div class="shift-ledger-row-amt">
                <strong>${formatCurrency(n.amount)}</strong>
                ${p}
              </div>
            </li>`}).join("")}</ul>`:'<p class="muted shift-ledger-empty">No expenses added yet.</p>',a=e?"":`<form id="shift-ledger-credit-form" class="shift-ledger-form">
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
        </form>`;f.innerHTML=`
      <div class="shift-ledger-summary" aria-live="polite">
        <div class="shift-ledger-summary-item">
          <span class="muted">Credit</span>
          <strong>${formatCurrency(M())}</strong>
        </div>
        <div class="shift-ledger-summary-item">
          <span class="muted">Expenses</span>
          <strong>${formatCurrency(k())}</strong>
        </div>
      </div>
      <div class="shift-ledger-tabs" role="tablist">
        <button type="button" class="shift-ledger-tab${s==="credit"?" is-active":""}" data-tab="credit" role="tab" aria-selected="${s==="credit"}">Credit</button>
        <button type="button" class="shift-ledger-tab${s==="expense"?" is-active":""}" data-tab="expense" role="tab" aria-selected="${s==="expense"}">Expenses</button>
      </div>
      <p id="shift-ledger-msg" class="hidden" role="status"></p>
      <div class="shift-ledger-panel" data-panel="credit" ${s==="credit"?"":"hidden"}>
        ${a}
        ${l}
      </div>
      <div class="shift-ledger-panel" data-panel="expense" ${s==="expense"?"":"hidden"}>
        ${r}
        ${c}
      </div>`,f.querySelectorAll(".shift-ledger-tab").forEach(n=>{n.addEventListener("click",()=>{_=n.dataset.tab==="expense"?"expense":"credit",h(),_==="credit"?i("shift-ledger-customer")?.focus():i("shift-ledger-expense-cat")?.focus()})}),e||(J(),s==="credit"&&z()),Q()}function z(){const e=i("shift-ledger-customer");if(!e)return;const t=typeof debounce=="function"?debounce(s=>void H(s),180):s=>void H(s);e.addEventListener("input",()=>t(e.value)),e.addEventListener("focus",()=>void H(e.value)),e.addEventListener("blur",()=>setTimeout(()=>S(!1),150)),e.addEventListener("keydown",s=>{s.key==="ArrowDown"&&m.length?(s.preventDefault(),u=Math.min(u+1,m.length-1),O()):s.key==="ArrowUp"&&m.length?(s.preventDefault(),u=Math.max(u-1,0),O()):s.key==="Enter"&&u>=0?(s.preventDefault(),q(m[u])):s.key==="Escape"&&S(!1)})}function O(){i("shift-ledger-customer-list")?.querySelectorAll(".combobox-option").forEach((t,s)=>{t.classList.toggle("is-active",s===u)})}function J(){i("shift-ledger-credit-form")?.addEventListener("submit",e=>{e.preventDefault(),V(e.currentTarget)}),i("shift-ledger-expense-form")?.addEventListener("submit",e=>{e.preventDefault(),X(e.currentTarget)})}function Q(){f?.querySelectorAll(".shift-ledger-del-credit").forEach(e=>{e.addEventListener("click",()=>void Z(e.dataset.id))}),f?.querySelectorAll(".shift-ledger-del-expense").forEach(e=>{e.addEventListener("click",()=>void ee(e.dataset.id))})}async function V(e){d("");const t=new FormData(e),s=String(t.get("customer_name")||"").trim(),l=Number(t.get("amount")||0),c=String(t.get("fuel_type")||"HSD").trim()||"HSD";if(!s||l<=0){d("Customer and amount are required.",!0);return}const a=e.querySelector('button[type="submit"]');a&&(a.disabled=!0,a.textContent="\u2026");try{const r={p_customer_name:s,p_transaction_date:o.date,p_amount:l,p_fuel_type:c,p_employee_id:o.employeeId,p_shift:o.shift};r.p_request_id=formRequestId(e,r);const{error:n}=await window.supabaseClient.rpc("add_credit_entry",r);if(n)throw n;clearFormRequestId(e),e.reset();const p=i("shift-ledger-fuel");p&&(p.value="HSD"),await C(),h(),w(),d("Credit added."),i("shift-ledger-customer")?.focus()}catch(r){AppError.report(r,{context:"ShiftStaffLedger.submitCredit"}),d(r?.message||"Could not save credit.",!0),a&&(a.disabled=!1,a.textContent="Add")}}async function X(e){d("");const t=new FormData(e),s=String(t.get("category")||"").trim(),l=Number(t.get("amount")||0),c=String(t.get("description")||"").trim();if(!s||l<=0){d("Category and amount are required.",!0);return}const a=e.querySelector('button[type="submit"]');a&&(a.disabled=!0,a.textContent="\u2026");try{const r={p_date:o.date,p_shift:o.shift,p_employee_id:o.employeeId,p_category:s,p_amount:l,p_description:c||null};r.p_request_id=formRequestId(e,r);const{error:n}=await window.supabaseClient.rpc("add_shift_expense",r);if(n)throw n;clearFormRequestId(e),e.reset(),await C(),h(),w(),d("Expense added."),i("shift-ledger-expense-cat")?.focus()}catch(r){AppError.report(r,{context:"ShiftStaffLedger.submitExpense"}),d(r?.message||"Could not save expense.",!0),a&&(a.disabled=!1,a.textContent="Add")}}async function Z(e){if(!(!e||!await AppDialog.confirm("Remove this credit sale from the shift?",{title:"Remove credit sale",confirmLabel:"Remove",danger:!0}))){d("");try{await ActionProgress.track({title:"Removing",status:"Removing this credit sale\u2026",doneStatus:"Removed"},async()=>{const{error:t}=await window.supabaseClient.rpc("delete_shift_credit_entry",{p_entry_id:e});if(t)throw t;await C(),h(),w(),d("Credit sale removed.")})}catch(t){AppError.report(t,{context:"ShiftStaffLedger.deleteCredit"}),d(t?.message||"Could not remove credit sale.",!0)}}}async function ee(e){if(!(!e||!await AppDialog.confirm("Remove this expense from the shift?",{title:"Remove expense",confirmLabel:"Remove",danger:!0}))){d("");try{await ActionProgress.track({title:"Removing",status:"Removing this expense\u2026",doneStatus:"Removed"},async()=>{const{error:t}=await window.supabaseClient.rpc("delete_shift_expense",{p_expense_id:e});if(t)throw t;await C(),h(),w(),d("Expense removed.")})}catch(t){AppError.report(t,{context:"ShiftStaffLedger.deleteExpense"}),d(t?.message||"Could not remove expense.",!0)}}}function b(){if(!(!g||g.getAttribute("aria-hidden")==="true")){if(AppDialog.hide(g),o=null,y&&typeof y.focus=="function")try{y.focus()}catch{}y=null}}async function te(e){if(N()){if(y=document.activeElement,o={date:e.date,shift:e.shift,employeeId:e.employeeId,employeeName:e.employeeName||"Staff",readonly:!!e.readonly,onChange:e.onChange},_=e.focusTab==="expense"?"expense":"credit",D=e.userId||null,T=!!e.isAdmin,A&&(A.textContent=o.employeeName),$){const t=o.shift==="afternoon"?"Afternoon":"Morning";$.textContent=`${formatDisplayDate?.(o.date)||o.date} \xB7 ${t} \xB7 Credit & expenses`}f.innerHTML='<p class="muted">Loading\u2026</p>',AppDialog.show(g,{focus:!1,onDismiss:b});try{await Promise.all([B(),C()]),h(),w(),_==="credit"?i("shift-ledger-customer")?.focus():i("shift-ledger-expense-cat")?.focus()}catch(t){AppError.report(t,{context:"ShiftStaffLedger.open"}),f.innerHTML=`<p class="error">${escapeHtml(t?.message||"Could not load.")}</p>`}}}function se(){N()&&(i("shift-ledger-close")?.addEventListener("click",b),i("shift-ledger-dismiss")?.addEventListener("click",b),i("shift-ledger-backdrop")?.addEventListener("click",b),document.addEventListener("keydown",e=>{e.key==="Escape"&&g?.getAttribute("aria-hidden")==="false"&&b()}))}async function re(e,t){const{data:s,error:l}=await window.supabaseClient.rpc("get_shift_staff_ledger",{p_date:e,p_shift:t});if(l)throw l;const c=new Map;function a(r,n,p){if(!r)return;let L=c.get(r);L||(L={credit:0,expense:0},c.set(r,L)),L[n]+=Number(p)||0}return(s?.credit||[]).forEach(r=>a(r.employee_id,"credit",r.amount)),(s?.expenses||[]).forEach(r=>a(r.employee_id,"expense",r.amount)),c}F.ShiftStaffLedger={init:se,open:te,close:b,fetchTotalsByEmployee:re}})(typeof window<"u"?window:globalThis);
