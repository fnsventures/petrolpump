(function(d){const y=new Set(["credit_followup","payment","call"]),g={high:0,normal:1,low:2};function f(t){return t?y.has(t.reminder_type)||!!t.credit_customer_id:!1}function T(t){const e=String(t||"").trim();return e?`Call ${e}`:"Call customer"}function v(t){return t?`credit.html?${new URLSearchParams({name:t}).toString()}`:"reminders.html"}function D(t){return(t?.credit_customers?.customer_name||t?.customer_name||"").trim()}function h(t){const e=String(t||"").replace(/\D/g,"");return e?e.length===10?`91${e}`:e.startsWith("0")&&e.length===11?`91${e.slice(1)}`:e:""}function k(t){const e=h(t);return e?`tel:+${e}`:""}function S(t,e){const a=h(t);if(!a)return"";const n=new URLSearchParams;e&&n.set("text",e);const r=n.toString();return`https://wa.me/${a}${r?`?${r}`:""}`}function N(t){const e=t?.credit_customers?.amount_due??t?.amount_due,a=Number(e);return Number.isFinite(a)?a:null}function b(t,e){return t.due_date&&t.due_date<e?0:t.due_date===e?1:!t.due_date&&t.priority==="high"?2:t.due_date&&t.due_date>e?3:4}function A(t,e){return[...t].sort((a,n)=>{const r=b(a,e)-b(n,e);if(r)return r;const s=f(a)?0:1,o=f(n)?0:1;if(s!==o)return s-o;const i=a.due_date||"9999-12-31",c=n.due_date||"9999-12-31";return i!==c?i<c?-1:1:(g[a.priority]??1)-(g[n.priority]??1)})}function I(t){const e=[],a=[];for(const n of t||[])(f(n)?e:a).push(n);return{credit:e,todo:a}}function O(){try{localStorage.setItem("reminders-updated",String(Date.now()))}catch{}typeof d.CacheInvalidation<"u"&&d.CacheInvalidation.invalidate("operational")}function E(t,e){if(typeof d.addDaysToDateString=="function")return d.addDaysToDateString(t,e);const a=String(t||"").slice(0,10),[n,r,s]=a.split("-").map(Number);if(!n||!r||!s)return a;const o=new Date(n,r-1,s);o.setDate(o.getDate()+(Number(e)||0));const i=o.getFullYear(),c=String(o.getMonth()+1).padStart(2,"0"),l=String(o.getDate()).padStart(2,"0");return`${i}-${c}-${l}`}function C(t,e,a){if(typeof d.appendDatedNote=="function")return d.appendDatedNote(t,e,a);const n=String(e||"").trim();if(!n)return null;const r=String(a||"").trim(),s=r?`[${r}] ${n}`:n,o=String(t||"").trim();let i=o?`${o}
${s}`:s;return i.length>2e3&&(i=i.slice(i.length-2e3)),i}async function F(t,{id:e,dueDate:a,note:n,dateLabel:r}={}){if(!t||!e||!a)return{error:new Error("Missing reschedule fields")};const s={due_date:a,updated_at:new Date().toISOString()},o=String(n||"").trim();if(o){const{data:l,error:u}=await t.from("reminders").select("notes").eq("id",e).eq("status","open").maybeSingle();if(u)return{error:u};const p=C(l?.notes,o,r);p!=null&&(s.notes=p)}const{data:i,error:c}=await t.from("reminders").update(s).eq("id",e).eq("status","open").select("id").maybeSingle();return c?{error:c}:i?.id?{error:null}:{error:new Error("Could not update task \u2014 it may already be done.")}}function L(t,e,a,{escapeHtml:n,allHref:r="reminders.html"}={}){if(!e||a<=0)return t;const s=n,o=a===1?"1 more task":`${a} more tasks`;return`${t}
<details class="tasks-more-expand">
  <summary>
    <span class="tasks-more-expand-closed">Show ${s(o)}</span>
    <span class="tasks-more-expand-open">Show less</span>
  </summary>
  <div class="tasks-more-list">${e}</div>
  <p class="tasks-more-footer muted">
    <a href="${s(r)}">Open all tasks</a>
  </p>
</details>`}function U(t,e){const a=Number(e),n=Number.isFinite(a)?Math.max(0,a):0,r=typeof formatCurrency=="function"?formatCurrency(n):String(n),s=typeof getLocalDateString=="function"?getLocalDateString():"",o=s&&typeof formatDisplayDate=="function"&&formatDisplayDate(s)!=="\u2014"?formatDisplayDate(s):s;return["Hello,","",`This is ${typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||typeof AppConfig<"u"&&AppConfig.DEFAULT_STATION?.legalName||"BISHNU PRIYA FUELS"}. As on ${o}, your outstanding balance is ${r}.`,"","Please clear this at the earliest.","","Thank you."].join(`
`)}const H='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.24.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/></svg>',M='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3a9 9 0 0 0-7.74 13.61L3 21l4.52-1.19A9 9 0 1 0 12 3zm0 2a7 7 0 1 1-3.57 13.03l-.3-.18-2.11.56.56-2.06-.2-.32A7 7 0 0 1 12 5zm3.15 9.64c-.17-.08-1-.49-1.16-.54-.16-.06-.27-.08-.39.08-.12.17-.45.54-.55.65-.1.11-.2.12-.37.04-.17-.08-.71-.26-1.35-.82-.5-.45-.83-1-.93-1.17-.1-.17-.01-.27.07-.35.08-.08.17-.2.25-.3.08-.1.11-.17.17-.28.06-.11.03-.21-.01-.3-.04-.08-.39-.94-.53-1.29-.14-.35-.28-.3-.39-.3h-.33c-.11 0-.3.04-.46.21-.16.17-.6.59-.6 1.45 0 .86.62 1.7.7 1.82.08.11 1.22 1.86 2.96 2.61.41.18.73.29.98.37.41.13.79.11 1.08.07.33-.05 1-.41 1.14-.81.14-.4.14-.74.1-.81-.04-.07-.15-.11-.32-.19z"/></svg>';function q(t,e){const a=escapeHtml,n=String(t||"").trim(),r=k(n),s=S(n,e);return!r&&!s?"":`<span class="contact-line">
      ${r?`<a class="contact-line-number" href="${a(r)}" aria-label="Call ${a(n)}">${a(n)}</a>`:`<span class="contact-line-number">${a(n)}</span>`}
      <span class="contact-line-actions">
        ${r?`<a class="contact-line-btn contact-line-btn--call" href="${a(r)}" aria-label="Call ${a(n)}">${H}</a>`:""}
        ${s?`<a class="contact-line-btn contact-line-btn--whatsapp" href="${a(s)}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp ${a(n)}">${M}</a>`:""}
      </span>
    </span>`}function w(t,{credit:e=!1,escapeHtml:a,forRemindersPage:n=!1}={}){const r=a,s=r(t),o=n?"button-secondary reminder-later-choice":"button-secondary task-later-choice reminder-later-btn",i=(u,p,$,m)=>{const z=n?`data-reminder-action="reschedule" data-id="${s}" data-days="${u}"${m?` data-note="${r(m)}"`:""}`:`data-reminder-later="reschedule" data-reminder-id="${s}" data-days="${u}"${m?` data-note="${r(m)}"`:""}`;return`<button type="button" class="${o}" ${z}>
        <span class="${n?"reminder-later-choice-title":"task-later-choice-title"}">${r(p)}</span>${$?`<span class="${n?"reminder-later-choice-sub":"task-later-choice-sub"}">${r($)}</span>`:""}
      </button>`},c=e?i(1,"No answer","Tomorrow","No answer"):i(1,"Tomorrow","","");return`<div class="${n?"reminder-later-grid":"task-later-grid"}" role="group" aria-label="Follow up">
      ${c}
      ${i(3,"+3 days","","")}
      ${i(7,"+7 days","","")}
    </div>`}function _(t,{escapeHtml:e,forRemindersPage:a=!1,today:n=""}={}){const r=e,s=r(t),o=r(n||""),i=a?`reminder-later-date-${s}`:`later-date-${s}`,c=a?"reminder-later-pick":"task-later-pick",l=a?"reminder-later-custom-label":"task-later-custom-label",u=a?"reminder-later-custom":"task-later-custom",p=a?"":' class="task-later-date"',$=a?`data-reminder-action="reschedule-pick" data-id="${s}"`:`data-reminder-later="reschedule-pick" data-reminder-id="${s}"`,m=a?"button-secondary button-small":"button-secondary button-small reminder-later-btn";return`<div class="${u}">
      <label class="${l}" for="${i}">Or pick a date</label>
      <div class="${c}">
        <input id="${i}" type="date"${p} data-later-date${o?` min="${o}"`:""} />
        <button type="button" class="${m}" ${$}>Set</button>
      </div>
    </div>`}function x(t,{credit:e=!1,escapeHtml:a,forRemindersPage:n=!1,today:r=""}={}){const o=a(t),i=e?"Follow up":"Push follow-up",c=w(t,{credit:e,escapeHtml:a,forRemindersPage:n}),l=_(t,{escapeHtml:a,forRemindersPage:n,today:r});return n?`<div class="reminder-later-panel" data-later-for="${o}" hidden>
        <p class="reminder-later-heading">${i}</p>
        ${c}
        ${l}
        <p class="reminder-later-error" data-later-error hidden></p>
        <div class="reminder-later-footer">
          <button type="button" class="button-secondary button-small" data-reminder-action="later-cancel" data-id="${o}">Cancel</button>
        </div>
      </div>`:`<div class="task-later-panel" data-later-for="${o}" hidden>
      <p class="task-later-heading">${i}</p>
      ${c}
      ${l}
      <p class="task-later-error" data-later-error hidden></p>
      <div class="task-later-footer">
        <button type="button" class="button-secondary button-small reminder-later-btn" data-reminder-later="cancel" data-reminder-id="${o}">Cancel</button>
      </div>
    </div>`}function Y(t){d.AppError?.showToast(t,"success",2800)}d.TaskUtils={isCreditTask:f,creditTitle:T,customerHref:v,customerNameOf:D,phoneE164:h,telHref:k,waHref:S,waMessageForCustomer:U,contactRowHtml:q,amountDueOf:N,urgencyRank:b,sortTasks:A,splitCreditTodo:I,notifyTasksUpdated:O,addDaysYmd:E,appendFollowUpNote:C,rescheduleOpenTask:F,laterChoicesHtml:w,laterCustomPickHtml:_,laterPanelHtml:x,wrapMoreCollapse:L,showTaskToast:Y,CREDIT_TYPES:y}})(typeof window<"u"?window:globalThis);
