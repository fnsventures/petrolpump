(function(l){const k=new Set(["credit_followup","payment","call"]),S={high:0,normal:1,low:2};function p(t){return t?k.has(t.reminder_type)||!!t.credit_customer_id:!1}function w(t){const n=String(t||"").trim();return n?`Call ${n}`:"Call customer"}function C(t){return t?`credit.html?${new URLSearchParams({name:t}).toString()}`:"reminders.html"}function T(t){return(t?.credit_customers?.customer_name||t?.customer_name||"").trim()}function h(t){const n=String(t||"").replace(/\D/g,"");return n?n.length===10?`91${n}`:n.startsWith("0")&&n.length===11?`91${n.slice(1)}`:n:""}function D(t){const n=h(t);return n?`tel:+${n}`:""}function I(t,n){const e=h(t);if(!e)return"";const r=new URLSearchParams;n&&r.set("text",n);const s=r.toString();return`https://wa.me/${e}${s?`?${s}`:""}`}function N(t){const n=t?.credit_customers?.amount_due??t?.amount_due,e=Number(n);return Number.isFinite(e)?e:null}function y(t,n){return t.due_date&&t.due_date<n?0:t.due_date===n?1:!t.due_date&&t.priority==="high"?2:t.due_date&&t.due_date>n?3:4}function E(t,n){return[...t].sort((e,r)=>{const s=y(e,n)-y(r,n);if(s)return s;const o=p(e)?0:1,a=p(r)?0:1;if(o!==a)return o-a;const i=e.due_date||"9999-12-31",c=r.due_date||"9999-12-31";return i!==c?i<c?-1:1:(S[e.priority]??1)-(S[r.priority]??1)})}function F(t){const n=[],e=[];for(const r of t||[])(p(r)?n:e).push(r);return{credit:n,todo:e}}function O(){try{localStorage.setItem("reminders-updated",String(Date.now()))}catch{}typeof l.CacheInvalidation<"u"&&l.CacheInvalidation.invalidate("operational")}function q(t,n){if(typeof l.addDaysToDateString=="function")return l.addDaysToDateString(t,n);const e=String(t||"").slice(0,10),[r,s,o]=e.split("-").map(Number);if(!r||!s||!o)return e;const a=new Date(r,s-1,o);if(a.setDate(a.getDate()+(Number(n)||0)),typeof l.toLocalDateString=="function")return l.toLocalDateString(a);const i=a.getFullYear(),c=String(a.getMonth()+1).padStart(2,"0"),u=String(a.getDate()).padStart(2,"0");return`${i}-${c}-${u}`}function g(t,n,e){if(typeof l.appendDatedNote=="function")return l.appendDatedNote(t,n,e);const r=String(n||"").trim();if(!r)return null;const s=String(e||"").trim(),o=s?`[${s}] ${r}`:r,a=String(t||"").trim();let i=a?`${a}
${o}`:o;return i.length>2e3&&(i=i.slice(i.length-2e3)),i}async function L(t,{id:n,dueDate:e,note:r,dateLabel:s}={}){if(!t||!n||!e)return{error:new Error("Missing reschedule fields")};const o={due_date:e,updated_at:new Date().toISOString()},a=String(r||"").trim();if(a){const{data:u,error:d}=await t.from("reminders").select("notes").eq("id",n).eq("status","open").maybeSingle();if(d)return{error:d};const m=g(u?.notes,a,s);m!=null&&(o.notes=m)}const{data:i,error:c}=await t.from("reminders").update(o).eq("id",n).eq("status","open").select("id").maybeSingle();return c?{error:c}:i?.id?{error:null}:{error:new Error("Could not update task \u2014 it may already be done.")}}function U(t,n,e,{escapeHtml:r,allHref:s="reminders.html"}={}){if(!n||e<=0)return t;const o=typeof r=="function"?r:i=>String(i),a=e===1?"1 more task":`${e} more tasks`;return`${t}
<details class="tasks-more-expand">
  <summary>
    <span class="tasks-more-expand-closed">Show ${o(a)}</span>
    <span class="tasks-more-expand-open">Show less</span>
  </summary>
  <div class="tasks-more-list">${n}</div>
  <p class="tasks-more-footer muted">
    <a href="${o(s)}">Open all tasks</a>
  </p>
</details>`}function x(t){return t?`Hello ${t}, this is Bishnupriya Fuels regarding your credit balance.`:"Hello, this is Bishnupriya Fuels regarding your credit balance."}function _(t,{credit:n=!1,escapeHtml:e,forRemindersPage:r=!1}={}){const s=typeof e=="function"?e:d=>String(d??""),o=s(t),a=r?"button-secondary reminder-later-choice":"button-secondary task-later-choice reminder-later-btn",i=(d,m,$,f)=>{const b=r?`data-reminder-action="reschedule" data-id="${o}" data-days="${d}"${f?` data-note="${s(f)}"`:""}`:`data-reminder-later="reschedule" data-reminder-id="${o}" data-days="${d}"${f?` data-note="${s(f)}"`:""}`;return`<button type="button" class="${a}" ${b}>
        <span class="${r?"reminder-later-choice-title":"task-later-choice-title"}">${s(m)}</span>${$?`<span class="${r?"reminder-later-choice-sub":"task-later-choice-sub"}">${s($)}</span>`:""}
      </button>`},c=n?i(1,"No answer","Tomorrow","No answer"):i(1,"Tomorrow","","");return`<div class="${r?"reminder-later-grid":"task-later-grid"}" role="group" aria-label="Follow up">
      ${c}
      ${i(3,"+3 days","","")}
      ${i(7,"+7 days","","")}
    </div>`}function v(t,{escapeHtml:n,forRemindersPage:e=!1,today:r=""}={}){const s=typeof n=="function"?n:b=>String(b??""),o=s(t),a=s(r||""),i=e?`reminder-later-date-${o}`:`later-date-${o}`,c=e?"reminder-later-pick":"task-later-pick",u=e?"reminder-later-custom-label":"task-later-custom-label",d=e?"reminder-later-custom":"task-later-custom",m=e?"":' class="task-later-date"',$=e?`data-reminder-action="reschedule-pick" data-id="${o}"`:`data-reminder-later="reschedule-pick" data-reminder-id="${o}"`,f=e?"button-secondary button-small":"button-secondary button-small reminder-later-btn";return`<div class="${d}">
      <label class="${u}" for="${i}">Or pick a date</label>
      <div class="${c}">
        <input id="${i}" type="date"${m} data-later-date${a?` min="${a}"`:""} />
        <button type="button" class="${f}" ${$}>Set</button>
      </div>
    </div>`}function A(t,{credit:n=!1,escapeHtml:e,forRemindersPage:r=!1,today:s=""}={}){const a=(typeof e=="function"?e:d=>String(d??""))(t),i=n?"Follow up":"Push follow-up",c=_(t,{credit:n,escapeHtml:e,forRemindersPage:r}),u=v(t,{escapeHtml:e,forRemindersPage:r,today:s});return r?`<div class="reminder-later-panel" data-later-for="${a}" hidden>
        <p class="reminder-later-heading">${i}</p>
        ${c}
        ${u}
        <p class="reminder-later-error" data-later-error hidden></p>
        <div class="reminder-later-footer">
          <button type="button" class="button-secondary button-small" data-reminder-action="later-cancel" data-id="${a}">Cancel</button>
        </div>
      </div>`:`<div class="task-later-panel" data-later-for="${a}" hidden>
      <p class="task-later-heading">${i}</p>
      ${c}
      ${u}
      <p class="task-later-error" data-later-error hidden></p>
      <div class="task-later-footer">
        <button type="button" class="button-secondary button-small reminder-later-btn" data-reminder-later="cancel" data-reminder-id="${a}">Cancel</button>
      </div>
    </div>`}function B(t){if(typeof document>"u"||!document.body)return;const n=String(t||"").trim();if(!n)return;let e=document.getElementById("task-toast");e||(e=document.createElement("div"),e.id="task-toast",e.className="task-toast",e.setAttribute("role","status"),e.setAttribute("aria-live","polite"),document.body.appendChild(e)),e.textContent=n,e.classList.add("is-visible"),clearTimeout(e._hideTimer),e._hideTimer=setTimeout(()=>{e.classList.remove("is-visible")},2800)}l.TaskUtils={isCreditTask:p,creditTitle:w,customerHref:C,customerNameOf:T,phoneE164:h,telHref:D,waHref:I,waMessageForCustomer:x,amountDueOf:N,urgencyRank:y,sortTasks:E,splitCreditTodo:F,notifyTasksUpdated:O,addDaysYmd:q,appendFollowUpNote:g,rescheduleOpenTask:L,laterChoicesHtml:_,laterCustomPickHtml:v,laterPanelHtml:A,wrapMoreCollapse:U,showTaskToast:B,CREDIT_TYPES:k}})(typeof window<"u"?window:globalThis);
