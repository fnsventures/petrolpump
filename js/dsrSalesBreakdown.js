(function(F){const R={petrol:"MS",diesel:"HSD"},N={"by-pump":"pump","by-shift":"shift","by-salesman":"salesman"};let L="",c=null,H=null,b="salesman",k=0,C=!1;const d={shift:"",staff:"",short:"",pump:""};function f(t){return document.getElementById(t)}function $(t){const e=PumpSettings.getShiftConfig?.()||{};return t==="morning"?e.morningName||"Morning":t==="afternoon"?e.afternoonName||"Afternoon":t||"\u2014"}function p(t){return t==null||Number.isNaN(Number(t))?"\u2014":Number(t).toLocaleString("en-IN",{minimumFractionDigits:0,maximumFractionDigits:0})}function D(t){const e=f("dsr-breakdown-error");e&&(e.textContent=t||"",e.classList.toggle("hidden",!t))}function v(t){f("dsr-breakdown-loading")?.classList.toggle("hidden",!t)}function Q(){d.shift=f("dsr-filter-shift")?.value||"",d.staff=f("dsr-filter-staff")?.value||"",d.short=f("dsr-filter-short")?.value||"",d.pump=f("dsr-filter-pump")?.value||""}function B(t){f("dsr-filter-staff-wrap")?.toggleAttribute("hidden",t!=="salesman"),f("dsr-filter-short-wrap")?.toggleAttribute("hidden",t!=="salesman"),f("dsr-filter-pump-wrap")?.toggleAttribute("hidden",t!=="pump")}function A(){const t=f("dsr-filter-shift");if(!t)return;const e=t.querySelector('option[value="morning"]'),s=t.querySelector('option[value="afternoon"]');e&&(e.textContent=$("morning")),s&&(s.textContent=$("afternoon"))}function j(t){const e=f("dsr-filter-staff");if(!e)return;const s=d.staff||e.value||"",o=new Map;(t||[]).forEach(n=>{const l=n.employee_id!=null?String(n.employee_id):"";l&&o.set(l,n.employee_name||"Staff")});const a=['<option value="">All staff</option>'];[...o.entries()].sort((n,l)=>n[1].localeCompare(l[1],void 0,{sensitivity:"base"})).forEach(([n,l])=>{a.push(`<option value="${escapeHtml(n)}">${escapeHtml(l)}</option>`)}),e.innerHTML=a.join(""),s&&o.has(s)?(e.value=s,d.staff=s):(e.value="",d.staff="")}function y(t){const e=f("dsr-breakdown-meta");if(e){if(!t){e.hidden=!0,e.innerHTML="";return}e.hidden=!1,e.innerHTML=t}}function _(t,e){return y(""),`<div class="dsr-breakdown-empty">
      <p class="dsr-breakdown-empty-title">${escapeHtml(t)}</p>
      <p class="muted">${e}</p>
    </div>`}function P(t,e){const s=e?.get(t.reading_date)||{},o=t.petrol_net_litres!=null?Number(t.petrol_net_litres):Number(t.petrol_litres)||0,a=t.diesel_net_litres!=null?Number(t.diesel_net_litres):Number(t.diesel_litres)||0,n=o*(s.petrol||0)+a*(s.diesel||0),l=Number(t.cash_collected)||0,r=Number(t.phone_pay)||0,i=t.total_collected!=null?Number(t.total_collected)||0:l+r,S=!!(s.petrol||s.diesel),h=S?n-i:null;let w="";return h!=null&&(h>.5?w="shortage":h<-.5?w="surplus":w="ok"),{cash:l,phonePay:r,collected:i,short:h,kind:w,hasRates:S}}function x(t,e){return(t||[]).flatMap(s=>{const o=s.date,a=s.product,n=[];for(const l of[1,2]){const r=`${o}|${a}|${l}`;if(e.has(r))continue;const i=l===1?s.sales_pump1:s.sales_pump2;n.push({reading_date:o,shift:null,product:a,pump_no:l,litres:Number(i)||0,net_litres:null,from_daily:!0})}return n})}function I(t,e){const s=t||[],o=new Set(s.map(a=>`${a.reading_date}|${a.product}|${a.pump_no}`));return[...s,...x(e,o)].sort((a,n)=>{const l=String(n.reading_date).localeCompare(String(a.reading_date));if(l)return l;const r=String(a.shift||"").localeCompare(String(n.shift||""));if(r)return r;const i=String(a.product).localeCompare(String(n.product));return i||(a.pump_no||0)-(n.pump_no||0)})}function O(t){return t.filter(e=>!(d.shift&&(e.from_daily||e.shift!==d.shift)||d.pump&&String(e.pump_no)!==d.pump))}function V(t){return(t||[]).filter(e=>!d.shift||e.shift===d.shift)}function K(t,e){return(t||[]).filter(s=>{if(d.shift&&s.shift!==d.shift||d.staff&&String(s.employee_id)!==d.staff)return!1;if(d.short){const{kind:o}=P(s,e);if(o!==d.short)return!1}return!0})}function m(t,e,s){return`<span class="dsr-sd-pill${s?` dsr-sd-pill--${s}`:""}"><span class="dsr-sd-pill-label">${escapeHtml(t)}</span><strong>${e}</strong></span>`}function U(t,e){const s=f("dsr-breakdown-body");if(!s)return;const o=I(t,e);if(!o.length){s.innerHTML=_("No pump sales",'Add meters in <a href="meter-reading.html">Meter Reading</a>.');return}const a=O(o);if(!a.length){s.innerHTML=_("No matching rows","Change Shift or Pump, or widen the dates.");return}let n=0;const l=a.map(r=>(n+=Number(r.litres)||0,`<tr>
          <td>${escapeHtml(formatDisplayDate?.(r.reading_date)||r.reading_date)}</td>
          <td>${r.from_daily?'<span class="muted">Daily</span>':escapeHtml($(r.shift))}</td>
          <td>${formatFuelBadge(R[r.product]||r.product)}</td>
          <td>P${r.pump_no}</td>
          <td class="num">${formatQuantity(r.litres)}</td>
        </tr>`)).join("");y([m("Rows",String(a.length)),m("Sale",`${formatQuantity(n)} L`,"accent")].join("")),s.innerHTML=`
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
      </div>`}function q(t){const e=f("dsr-breakdown-body");if(!e)return;if(!t?.length){e.innerHTML=_("No shift sales",'Enter data in <a href="meter-reading.html#shift-readings">Shift register</a>.');return}const s=V(t);if(!s.length){e.innerHTML=_("No matching rows","Change Shift, or widen the dates.");return}let o=0;const a=s.map(n=>(o+=Number(n.litres)||0,`<tr>
          <td>${escapeHtml(formatDisplayDate?.(n.reading_date)||n.reading_date)}</td>
          <td>${escapeHtml($(n.shift))}</td>
          <td>${formatFuelBadge(R[n.product]||n.product)}</td>
          <td class="num">${formatQuantity(n.litres)}</td>
          <td class="num">${n.staff_count??"\u2014"}</td>
        </tr>`)).join("");y([m("Rows",String(s.length)),m("Sale",`${formatQuantity(o)} L`,"accent")].join("")),e.innerHTML=`
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
      </div>`}function G(t,e){const s=f("dsr-breakdown-body");if(!s)return;if(!t?.length){s.innerHTML=_("No staff sales",'Assign staff in <a href="meter-reading.html#shift-readings">Shift register</a>.');return}const o=K(t,e);if(!o.length){s.innerHTML=_("No matching rows","Clear filters, or widen the date range.");return}let a=0,n=0,l=0,r=0,i=0,S=0,h=0;const w=o.map(g=>{const u=P(g,e),T=Number(g.petrol_litres)||0,E=Number(g.diesel_litres)||0;a+=T,n+=E,l+=u.cash,r+=u.phonePay,u.kind==="shortage"&&(h+=1),u.short!=null&&(i+=u.short,S+=1);const tt=u.kind==="shortage"?"dsr-short--shortage":u.kind==="surplus"?"dsr-short--surplus":"";return`<tr class="${u.kind==="shortage"?"dsr-row--shortage":""}">
          <td>${escapeHtml(formatDisplayDate?.(g.reading_date)||g.reading_date)}</td>
          <td>${escapeHtml($(g.shift))}</td>
          <td class="dsr-staff-name">${escapeHtml(g.employee_name||"Staff")}</td>
          <td class="num">${formatQuantity(T)}</td>
          <td class="num">${formatQuantity(E)}</td>
          <td class="num">${p(u.cash)}</td>
          <td class="num">${p(u.phonePay)}</td>
          <td class="num ${tt}">${u.short==null?"\u2014":p(u.short)}</td>
        </tr>`}).join("");y([m("Rows",String(o.length)),m("MS",`${formatQuantity(a)} L`,"petrol"),m("HSD",`${formatQuantity(n)} L`,"diesel"),m("Short",S?`\u20B9${p(i)}`:"\u2014",h?"danger":"")].join("")),s.innerHTML=`
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
              <th class="num">Short \u20B9</th>
            </tr>
          </thead>
          <tbody>${w}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Period total</td>
              <td class="num">${formatQuantity(a)}</td>
              <td class="num">${formatQuantity(n)}</td>
              <td class="num">${p(l)}</td>
              <td class="num">${p(r)}</td>
              <td class="num">${S?p(i):"\u2014"}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}function M(t){if(b=t||b,A(),B(b),Q(),!c){y("");const e=f("dsr-breakdown-body");e&&(e.innerHTML='<p class="muted">Select a date range above.</p>');return}j(c.by_salesman||[]),b==="pump"?U(c.by_pump||[],c.daily_pump||[]):b==="shift"?q(c.by_shift||[]):G(c.by_salesman||[],H)}function W(){C||(C=!0,["dsr-filter-shift","dsr-filter-staff","dsr-filter-short","dsr-filter-pump"].forEach(t=>{f(t)?.addEventListener("change",()=>M(b))}))}async function Y(t,e){const s=new Map;try{const[o,a]=await Promise.all([supabaseClient.from("dsr_petrol").select("date, petrol_rate, created_at").gte("date",t).lte("date",e).order("created_at",{ascending:!1}),supabaseClient.from("dsr_diesel").select("date, diesel_rate, created_at").gte("date",t).lte("date",e).order("created_at",{ascending:!1})]),n=new Set,l=new Set;(o.data||[]).forEach(r=>{if(n.has(r.date))return;n.add(r.date);const i=s.get(r.date)||{};i.petrol=Number(r.petrol_rate)||0,s.set(r.date,i)}),(a.data||[]).forEach(r=>{if(l.has(r.date))return;l.add(r.date);const i=s.get(r.date)||{};i.diesel=Number(r.diesel_rate)||0,s.set(r.date,i)})}catch(o){AppError.report(o,{context:"DsrSalesBreakdown.loadRates"})}return s}function z(t,e,s){const o=f("dsr-breakdown-reports-link");if(!o)return;const a=s==="pump"?"pump-sales":s==="shift"?"shift-sales":"salesman-sales";o.href=`reports.html?tab=${a}&start=${encodeURIComponent(t)}&end=${encodeURIComponent(e)}`}async function J(t,e,s,{force:o=!1}={}){const a=N[s]||"salesman";if(!t||!e)return;W();const n=`${t}|${e}`,l=++k;if(D(""),z(t,e,a),!o&&c&&L===n){M(a);return}v(!0);try{const{data:r,error:i}=await supabaseClient.rpc("get_meter_sales_breakdown",{p_start:t,p_end:e});if(i)throw i;if(l!==k||(c=r||{},L=n,H=await Y(t,e),l!==k))return;M(a)}catch(r){AppError.report(r,{context:"DsrSalesBreakdown.loadForRange"}),D(r.message||"Could not load sales detail."),c=null,L="",y("");const i=f("dsr-breakdown-body");i&&(i.innerHTML="")}finally{v(!1)}}function X(){c=null,L="",H=null}function Z(t){return!!N[t]}F.DsrSalesBreakdown={loadForRange:J,invalidate:X,isBreakdownSection:Z,VIEW_BY_SECTION:N}})(typeof window<"u"?window:globalThis);
