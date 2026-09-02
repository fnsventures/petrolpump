(function(Q){const D={petrol:"MS",diesel:"HSD"},k={"by-pump":"pump","by-shift":"shift","by-salesman":"salesman"};let H="",m=null,C=null,b="salesman",M=0,v=!1;const d={shift:"",staff:"",short:"",pump:""};function u(t){return document.getElementById(t)}function N(t){const e=PumpSettings.getShiftConfig?.()||{};return t==="morning"?e.morningName||"Morning":t==="afternoon"?e.afternoonName||"Afternoon":t||"\u2014"}function c(t){return t==null||Number.isNaN(Number(t))?"\u2014":Number(t).toLocaleString("en-IN",{minimumFractionDigits:0,maximumFractionDigits:0})}function P(t){const e=u("dsr-breakdown-error");e&&(e.textContent=t||"",e.classList.toggle("hidden",!t))}function T(t){u("dsr-breakdown-loading")?.classList.toggle("hidden",!t)}function B(){d.shift=u("dsr-filter-shift")?.value||"",d.staff=u("dsr-filter-staff")?.value||"",d.short=u("dsr-filter-short")?.value||"",d.pump=u("dsr-filter-pump")?.value||""}function A(t){u("dsr-filter-staff-wrap")?.toggleAttribute("hidden",t!=="salesman"),u("dsr-filter-short-wrap")?.toggleAttribute("hidden",t!=="salesman"),u("dsr-filter-pump-wrap")?.toggleAttribute("hidden",t!=="pump")}function j(){const t=u("dsr-filter-shift");if(!t)return;const e=t.querySelector('option[value="morning"]'),s=t.querySelector('option[value="afternoon"]');e&&(e.textContent=N("morning")),s&&(s.textContent=N("afternoon"))}function I(t){const e=u("dsr-filter-staff");if(!e)return;const s=d.staff||e.value||"",o=new Map;(t||[]).forEach(n=>{const l=n.employee_id!=null?String(n.employee_id):"";l&&o.set(l,n.employee_name||"Staff")});const a=['<option value="">All staff</option>'];[...o.entries()].sort((n,l)=>n[1].localeCompare(l[1],void 0,{sensitivity:"base"})).forEach(([n,l])=>{a.push(`<option value="${escapeHtml(n)}">${escapeHtml(l)}</option>`)}),e.innerHTML=a.join(""),s&&o.has(s)?(e.value=s,d.staff=s):(e.value="",d.staff="")}function y(t){const e=u("dsr-breakdown-meta");if(e){if(!t){e.hidden=!0,e.innerHTML="";return}e.hidden=!1,e.innerHTML=t}}function _(t,e){return y(""),`<div class="dsr-breakdown-empty">
      <p class="dsr-breakdown-empty-title">${escapeHtml(t)}</p>
      <p class="muted">${e}</p>
    </div>`}function E(t,e){const s=e?.get(t.reading_date)||{},o=t.petrol_net_litres!=null?Number(t.petrol_net_litres):Number(t.petrol_litres)||0,a=t.diesel_net_litres!=null?Number(t.diesel_net_litres):Number(t.diesel_litres)||0,n=o*(s.petrol||0)+a*(s.diesel||0),l=Number(t.cash_collected)||0,r=Number(t.phone_pay)||0,i=Number(t.credit_amount)||0,L=Number(t.expense_amount)||0,S=t.total_collected!=null?Number(t.total_collected)||0:l+r+i+L,$=!!(s.petrol||s.diesel),h=$?n-S:null;let w="";return h!=null&&(h>.5?w="shortage":h<-.5?w="surplus":w="ok"),{cash:l,phonePay:r,credit:i,expense:L,collected:S,short:h,kind:w,hasRates:$}}function O(t,e){return(t||[]).flatMap(s=>{const o=s.date,a=s.product,n=[];for(const l of[1,2]){const r=`${o}|${a}|${l}`;if(e.has(r))continue;const i=l===1?s.sales_pump1:s.sales_pump2;n.push({reading_date:o,shift:null,product:a,pump_no:l,litres:Number(i)||0,net_litres:null,from_daily:!0})}return n})}function V(t,e){const s=t||[],o=new Set(s.map(a=>`${a.reading_date}|${a.product}|${a.pump_no}`));return[...s,...O(e,o)].sort((a,n)=>{const l=String(n.reading_date).localeCompare(String(a.reading_date));if(l)return l;const r=String(a.shift||"").localeCompare(String(n.shift||""));if(r)return r;const i=String(a.product).localeCompare(String(n.product));return i||(a.pump_no||0)-(n.pump_no||0)})}function K(t){return t.filter(e=>!(d.shift&&(e.from_daily||e.shift!==d.shift)||d.pump&&String(e.pump_no)!==d.pump))}function U(t){return(t||[]).filter(e=>!d.shift||e.shift===d.shift)}function q(t,e){return(t||[]).filter(s=>{if(d.shift&&s.shift!==d.shift||d.staff&&String(s.employee_id)!==d.staff)return!1;if(d.short){const{kind:o}=E(s,e);if(o!==d.short)return!1}return!0})}function p(t,e,s){return`<span class="dsr-sd-pill${s?` dsr-sd-pill--${s}`:""}"><span class="dsr-sd-pill-label">${escapeHtml(t)}</span><strong>${e}</strong></span>`}function G(t,e){const s=u("dsr-breakdown-body");if(!s)return;const o=V(t,e);if(!o.length){s.innerHTML=_("No pump sales",'Add meters in <a href="meter-reading.html">Meter Reading</a>.');return}const a=K(o);if(!a.length){s.innerHTML=_("No matching rows","Change Shift or Pump, or widen the dates.");return}let n=0;const l=a.map(r=>(n+=Number(r.litres)||0,`<tr>
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date)||r.reading_date)}</td>
          <td>${r.from_daily?'<span class="muted">Daily</span>':escapeHtml(N(r.shift))}</td>
          <td>${formatFuelBadge(D[r.product]||r.product)}</td>
          <td>P${r.pump_no}</td>
          <td class="num">${formatQuantity(r.litres)}</td>
        </tr>`)).join("");y([p("Rows",String(a.length)),p("Sale",`${formatQuantity(n)} L`,"accent")].join("")),s.innerHTML=`
      <div class="table-scroll dsr-sd-table-wrap">
        <table class="dsr-sd-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Fuel</th>
              <th>Pump</th>
              <th class="num">Sale (L)</th>
            </tr>
          </thead>
          <tbody>${l}</tbody>
          <tfoot>
            <tr>
              <td colspan="4">Period total</td>
              <td class="num">${formatQuantity(n)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}function W(t){const e=u("dsr-breakdown-body");if(!e)return;if(!t?.length){e.innerHTML=_("No shift sales",'Enter data in <a href="meter-reading.html#shift-readings">Shift register</a>.');return}const s=U(t);if(!s.length){e.innerHTML=_("No matching rows","Change Shift, or widen the dates.");return}let o=0;const a=s.map(n=>(o+=Number(n.litres)||0,`<tr>
          <td>${escapeHtml(formatDisplayDate?.(n.reading_date)||n.reading_date)}</td>
          <td>${escapeHtml(N(n.shift))}</td>
          <td>${formatFuelBadge(D[n.product]||n.product)}</td>
          <td class="num">${formatQuantity(n.litres)}</td>
          <td class="num">${n.staff_count??"\u2014"}</td>
        </tr>`)).join("");y([p("Rows",String(s.length)),p("Sale",`${formatQuantity(o)} L`,"accent")].join("")),e.innerHTML=`
      <div class="table-scroll dsr-sd-table-wrap">
        <table class="dsr-sd-table dsr-breakdown-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Fuel</th>
              <th class="num">Sale (L)</th>
              <th class="num">Staff</th>
            </tr>
          </thead>
          <tbody>${a}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Period total</td>
              <td class="num">${formatQuantity(o)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`}function Y(t,e){const s=u("dsr-breakdown-body");if(!s)return;if(!t?.length){s.innerHTML=_("No staff sales",'Assign staff in <a href="meter-reading.html#shift-readings">Shift register</a>.');return}const o=q(t,e);if(!o.length){s.innerHTML=_("No matching rows","Clear filters, or widen the date range.");return}let a=0,n=0,l=0,r=0,i=0,L=0,S=0,$=0,h=0;const w=o.map(g=>{const f=E(g,e),x=Number(g.petrol_litres)||0,F=Number(g.diesel_litres)||0;a+=x,n+=F,l+=f.cash,r+=f.phonePay,i+=f.credit,L+=f.expense,f.kind==="shortage"&&(h+=1),f.short!=null&&(S+=f.short,$+=1);const st=f.kind==="shortage"?"dsr-short--shortage":f.kind==="surplus"?"dsr-short--surplus":"";return`<tr class="${f.kind==="shortage"?"dsr-row--shortage":""}">
          <td>${escapeHtml(formatDisplayDate?.(g.reading_date)||g.reading_date)}</td>
          <td>${escapeHtml(N(g.shift))}</td>
          <td class="dsr-staff-name">${escapeHtml(g.employee_name||"Staff")}</td>
          <td class="num">${formatQuantity(x)}</td>
          <td class="num">${formatQuantity(F)}</td>
          <td class="num">${c(f.cash)}</td>
          <td class="num">${c(f.phonePay)}</td>
          <td class="num">${c(f.credit)}</td>
          <td class="num">${c(f.expense)}</td>
          <td class="num ${st}">${f.short==null?"\u2014":c(f.short)}</td>
        </tr>`}).join("");y([p("Rows",String(o.length)),p("MS",`${formatQuantity(a)} L`,"petrol"),p("HSD",`${formatQuantity(n)} L`,"diesel"),p("Short",$?`\u20B9${c(S)}`:"\u2014",h?"danger":"")].join("")),s.innerHTML=`
      <div class="table-scroll dsr-sd-table-wrap">
        <table class="dsr-sd-table dsr-breakdown-table dsr-staff-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>Staff</th>
              <th class="num">MS (L)</th>
              <th class="num">HSD (L)</th>
              <th class="num">Cash \u20B9</th>
              <th class="num">Phone \u20B9</th>
              <th class="num">Credit \u20B9</th>
              <th class="num">Exp \u20B9</th>
              <th class="num">Short \u20B9</th>
            </tr>
          </thead>
          <tbody>${w}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Period total</td>
              <td class="num">${formatQuantity(a)}</td>
              <td class="num">${formatQuantity(n)}</td>
              <td class="num">${c(l)}</td>
              <td class="num">${c(r)}</td>
              <td class="num">${c(i)}</td>
              <td class="num">${c(L)}</td>
              <td class="num">${$?c(S):"\u2014"}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}function R(t){if(b=t||b,j(),A(b),B(),!m){y("");const e=u("dsr-breakdown-body");e&&(e.innerHTML='<p class="muted">Select a date range above.</p>');return}I(m.by_salesman||[]),b==="pump"?G(m.by_pump||[],m.daily_pump||[]):b==="shift"?W(m.by_shift||[]):Y(m.by_salesman||[],C)}function z(){v||(v=!0,["dsr-filter-shift","dsr-filter-staff","dsr-filter-short","dsr-filter-pump"].forEach(t=>{u(t)?.addEventListener("change",()=>R(b))}))}async function J(t,e){const s=new Map;try{const[o,a]=await Promise.all([supabaseClient.from("dsr_petrol").select("date, petrol_rate, created_at").gte("date",t).lte("date",e).order("created_at",{ascending:!1}),supabaseClient.from("dsr_diesel").select("date, diesel_rate, created_at").gte("date",t).lte("date",e).order("created_at",{ascending:!1})]),n=new Set,l=new Set;(o.data||[]).forEach(r=>{if(n.has(r.date))return;n.add(r.date);const i=s.get(r.date)||{};i.petrol=Number(r.petrol_rate)||0,s.set(r.date,i)}),(a.data||[]).forEach(r=>{if(l.has(r.date))return;l.add(r.date);const i=s.get(r.date)||{};i.diesel=Number(r.diesel_rate)||0,s.set(r.date,i)})}catch(o){AppError.report(o,{context:"DsrSalesBreakdown.loadRates"})}return s}function X(t,e,s){const o=u("dsr-breakdown-reports-link");if(!o)return;const a=s==="pump"?"pump-sales":s==="shift"?"shift-sales":"salesman-sales";o.href=`reports.html?tab=${a}&start=${encodeURIComponent(t)}&end=${encodeURIComponent(e)}`}async function Z(t,e,s,{force:o=!1}={}){const a=k[s]||"salesman";if(!t||!e)return;z();const n=`${t}|${e}`,l=++M;if(P(""),X(t,e,a),!o&&m&&H===n){R(a);return}T(!0);try{const{data:r,error:i}=await window.supabaseClient.rpc("get_meter_sales_breakdown",{p_start:t,p_end:e});if(i)throw i;if(l!==M||(m=r||{},H=n,C=await J(t,e),l!==M))return;R(a)}catch(r){AppError.report(r,{context:"DsrSalesBreakdown.loadForRange"}),P(r.message||"Could not load sales detail."),m=null,H="",y("");const i=u("dsr-breakdown-body");i&&(i.innerHTML="")}finally{T(!1)}}function tt(){m=null,H="",C=null}function et(t){return!!k[t]}Q.DsrSalesBreakdown={loadForRange:Z,invalidate:tt,isBreakdownSection:et,VIEW_BY_SECTION:k}})(typeof window<"u"?window:globalThis);
