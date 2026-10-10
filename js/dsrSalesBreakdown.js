(function(Q){const v={petrol:"MS",diesel:"HSD"},k={"by-pump":"pump","by-shift":"shift","by-salesman":"salesman"};let H="",m=null,M=null,b="salesman",C=0,D=!1;const i={shift:"",staff:"",short:"",pump:""};function d(t){return document.getElementById(t)}function N(t){const e=PumpSettings.getShiftConfig?.()||{};return t==="morning"?e.morningName||"Morning":t==="afternoon"?e.afternoonName||"Afternoon":t||"\u2014"}function c(t){return t==null||Number.isNaN(Number(t))?"\u2014":Number(t).toLocaleString("en-IN",{minimumFractionDigits:0,maximumFractionDigits:0})}function P(t){const e=d("dsr-breakdown-error");e&&(e.textContent=t||"",e.classList.toggle("hidden",!t))}function T(t){d("dsr-breakdown-loading")?.classList.toggle("hidden",!t)}function A(){i.shift=d("dsr-filter-shift")?.value||"",i.staff=d("dsr-filter-staff")?.value||"",i.short=d("dsr-filter-short")?.value||"",i.pump=d("dsr-filter-pump")?.value||""}function B(t){d("dsr-filter-staff-wrap")?.toggleAttribute("hidden",t!=="salesman"),d("dsr-filter-short-wrap")?.toggleAttribute("hidden",t!=="salesman"),d("dsr-filter-pump-wrap")?.toggleAttribute("hidden",t!=="pump")}function j(){const t=d("dsr-filter-shift");if(!t)return;const e=t.querySelector('option[value="morning"]'),n=t.querySelector('option[value="afternoon"]');e&&(e.textContent=N("morning")),n&&(n.textContent=N("afternoon"))}function I(t){const e=d("dsr-filter-staff");if(!e)return;const n=i.staff||e.value||"",a=new Map;(t||[]).forEach(s=>{const o=s.employee_id!=null?String(s.employee_id):"";o&&a.set(o,s.employee_name||"Staff")});const r=['<option value="">All staff</option>'];[...a.entries()].sort((s,o)=>s[1].localeCompare(o[1],void 0,{sensitivity:"base"})).forEach(([s,o])=>{r.push(`<option value="${escapeHtml(s)}">${escapeHtml(o)}</option>`)}),e.innerHTML=r.join(""),n&&a.has(n)?(e.value=n,i.staff=n):(e.value="",i.staff="")}function y(t){const e=d("dsr-breakdown-meta");if(e){if(!t){e.hidden=!0,e.innerHTML="";return}e.hidden=!1,e.innerHTML=t}}function _(t,e){return y(""),`<div class="dsr-breakdown-empty">
      <p class="dsr-breakdown-empty-title">${escapeHtml(t)}</p>
      <p class="muted">${e}</p>
    </div>`}function E(t,e){const n=e?.get(t.reading_date)||{},a=t.petrol_net_litres!=null?Number(t.petrol_net_litres):Number(t.petrol_litres)||0,r=t.diesel_net_litres!=null?Number(t.diesel_net_litres):Number(t.diesel_litres)||0,s=a*(n.petrol||0)+r*(n.diesel||0),o=Number(t.cash_collected)||0,l=Number(t.phone_pay)||0,u=Number(t.credit_amount)||0,L=Number(t.expense_amount)||0,$=t.total_collected!=null?Number(t.total_collected)||0:o+l+u+L,S=!!(n.petrol||n.diesel),h=S?s-$:null;let w="";return h!=null&&(h>.5?w="shortage":h<-.5?w="surplus":w="ok"),{cash:o,phonePay:l,credit:u,expense:L,collected:$,short:h,kind:w,hasRates:S}}function O(t,e){return(t||[]).flatMap(n=>{const a=n.date,r=n.product,s=[];for(const o of[1,2]){const l=`${a}|${r}|${o}`;if(e.has(l))continue;const u=o===1?n.sales_pump1:n.sales_pump2;s.push({reading_date:a,shift:null,product:r,pump_no:o,litres:Number(u)||0,net_litres:null,from_daily:!0})}return s})}function V(t,e){const n=t||[],a=new Set(n.map(r=>`${r.reading_date}|${r.product}|${r.pump_no}`));return[...n,...O(e,a)].sort((r,s)=>{const o=String(s.reading_date).localeCompare(String(r.reading_date));if(o)return o;const l=String(r.shift||"").localeCompare(String(s.shift||""));if(l)return l;const u=String(r.product).localeCompare(String(s.product));return u||(r.pump_no||0)-(s.pump_no||0)})}function K(t){return t.filter(e=>!(i.shift&&(e.from_daily||e.shift!==i.shift)||i.pump&&String(e.pump_no)!==i.pump))}function U(t){return(t||[]).filter(e=>!i.shift||e.shift===i.shift)}function q(t,e){return(t||[]).filter(n=>{if(i.shift&&n.shift!==i.shift||i.staff&&String(n.employee_id)!==i.staff)return!1;if(i.short){const{kind:a}=E(n,e);if(a!==i.short)return!1}return!0})}function p(t,e,n){return`<span class="dsr-sd-pill${n?` dsr-sd-pill--${n}`:""}"><span class="dsr-sd-pill-label">${escapeHtml(t)}</span><strong>${e}</strong></span>`}function G(t,e){const n=d("dsr-breakdown-body");if(!n)return;const a=V(t,e);if(!a.length){n.innerHTML=_("No pump sales",'Add meters in <a href="meter-reading.html">Meter Reading</a>.');return}const r=K(a);if(!r.length){n.innerHTML=_("No matching rows","Change Shift or Pump, or widen the dates.");return}let s=0;const o=r.map(l=>(s+=Number(l.litres)||0,`<tr>
          <td>${escapeHtml(formatDisplayDate?.(l.reading_date)||l.reading_date)}</td>
          <td>${l.from_daily?'<span class="muted">Daily</span>':escapeHtml(N(l.shift))}</td>
          <td>${formatFuelBadge(v[l.product]||l.product)}</td>
          <td>P${l.pump_no}</td>
          <td class="num">${formatQuantity(l.litres)}</td>
        </tr>`)).join("");y([p("Rows",String(r.length)),p("Sale",`${formatQuantity(s)} L`,"accent")].join("")),n.innerHTML=`
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
          <tbody>${o}</tbody>
          <tfoot>
            <tr>
              <td colspan="4">Period total</td>
              <td class="num">${formatQuantity(s)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}function W(t){const e=d("dsr-breakdown-body");if(!e)return;if(!t?.length){e.innerHTML=_("No shift sales",'Enter data in <a href="meter-reading.html#shift-readings">Shift register</a>.');return}const n=U(t);if(!n.length){e.innerHTML=_("No matching rows","Change Shift, or widen the dates.");return}let a=0;const r=n.map(s=>(a+=Number(s.litres)||0,`<tr>
          <td>${escapeHtml(formatDisplayDate?.(s.reading_date)||s.reading_date)}</td>
          <td>${escapeHtml(N(s.shift))}</td>
          <td>${formatFuelBadge(v[s.product]||s.product)}</td>
          <td class="num">${formatQuantity(s.litres)}</td>
          <td class="num">${s.staff_count??"\u2014"}</td>
        </tr>`)).join("");y([p("Rows",String(n.length)),p("Sale",`${formatQuantity(a)} L`,"accent")].join("")),e.innerHTML=`
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
          <tbody>${r}</tbody>
          <tfoot>
            <tr>
              <td colspan="3">Period total</td>
              <td class="num">${formatQuantity(a)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`}function Y(t,e){const n=d("dsr-breakdown-body");if(!n)return;if(!t?.length){n.innerHTML=_("No staff sales",'Assign staff in <a href="meter-reading.html#shift-readings">Shift register</a>.');return}const a=q(t,e);if(!a.length){n.innerHTML=_("No matching rows","Clear filters, or widen the date range.");return}let r=0,s=0,o=0,l=0,u=0,L=0,$=0,S=0,h=0;const w=a.map(g=>{const f=E(g,e),x=Number(g.petrol_litres)||0,F=Number(g.diesel_litres)||0;r+=x,s+=F,o+=f.cash,l+=f.phonePay,u+=f.credit,L+=f.expense,f.kind==="shortage"&&(h+=1),f.short!=null&&($+=f.short,S+=1);const nt=f.kind==="shortage"?"dsr-short--shortage":f.kind==="surplus"?"dsr-short--surplus":"";return`<tr class="${f.kind==="shortage"?"dsr-row--shortage":""}">
          <td>${escapeHtml(formatDisplayDate?.(g.reading_date)||g.reading_date)}</td>
          <td>${escapeHtml(N(g.shift))}</td>
          <td class="dsr-staff-name">${escapeHtml(g.employee_name||"Staff")}</td>
          <td class="num">${formatQuantity(x)}</td>
          <td class="num">${formatQuantity(F)}</td>
          <td class="num">${c(f.cash)}</td>
          <td class="num">${c(f.phonePay)}</td>
          <td class="num">${c(f.credit)}</td>
          <td class="num">${c(f.expense)}</td>
          <td class="num ${nt}">${f.short==null?"\u2014":c(f.short)}</td>
        </tr>`}).join("");y([p("Rows",String(a.length)),p("MS",`${formatQuantity(r)} L`,"petrol"),p("HSD",`${formatQuantity(s)} L`,"diesel"),p("Short",S?`\u20B9${c($)}`:"\u2014",h?"danger":"")].join("")),n.innerHTML=`
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
              <td class="num">${formatQuantity(r)}</td>
              <td class="num">${formatQuantity(s)}</td>
              <td class="num">${c(o)}</td>
              <td class="num">${c(l)}</td>
              <td class="num">${c(u)}</td>
              <td class="num">${c(L)}</td>
              <td class="num">${S?c($):"\u2014"}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}function R(t){if(b=t||b,j(),B(b),A(),!m){y("");const e=d("dsr-breakdown-body");e&&(e.innerHTML='<p class="muted">Select a date range above.</p>');return}I(m.by_salesman||[]),b==="pump"?G(m.by_pump||[],m.daily_pump||[]):b==="shift"?W(m.by_shift||[]):Y(m.by_salesman||[],M)}function z(){D||(D=!0,["dsr-filter-shift","dsr-filter-staff","dsr-filter-short","dsr-filter-pump"].forEach(t=>{d(t)?.addEventListener("change",()=>R(b))}))}async function J(t,e){const n=new Map,{data:a,error:r}=await fetchAllRows(()=>supabaseClient.from("dsr").select("date, product, petrol_rate, diesel_rate").gte("date",t).lte("date",e).order("date",{ascending:!0}).order("product",{ascending:!0}));return r?(AppError.report(r,{context:"DsrSalesBreakdown.loadRates"}),n):((a||[]).forEach(s=>{const o=n.get(s.date)||{petrol:0,diesel:0};s.product==="petrol"&&(o.petrol=Number(s.petrol_rate)||0),s.product==="diesel"&&(o.diesel=Number(s.diesel_rate)||0),n.set(s.date,o)}),n)}function X(t,e,n){const a=d("dsr-breakdown-reports-link");if(!a)return;const r=n==="pump"?"pump-sales":n==="shift"?"shift-sales":"salesman-sales";a.href=`reports.html?tab=${r}&start=${encodeURIComponent(t)}&end=${encodeURIComponent(e)}`}async function Z(t,e,n,{force:a=!1}={}){const r=k[n]||"salesman";if(!t||!e)return;z();const s=`${t}|${e}`,o=++C;if(P(""),X(t,e,r),!a&&m&&H===s){R(r);return}T(!0);try{const{data:l,error:u}=await window.supabaseClient.rpc("get_meter_sales_breakdown",{p_start:t,p_end:e});if(u)throw u;if(o!==C||(m=l||{},H=s,M=await J(t,e),o!==C))return;R(r)}catch(l){AppError.report(l,{context:"DsrSalesBreakdown.loadForRange"}),P(l.message||"Could not load sales detail."),m=null,H="",y("");const u=d("dsr-breakdown-body");u&&(u.innerHTML="")}finally{T(!1)}}function tt(){m=null,H="",M=null}function et(t){return!!k[t]}Q.DsrSalesBreakdown={loadForRange:Z,invalidate:tt,isBreakdownSection:et,VIEW_BY_SECTION:k}})(typeof window<"u"?window:globalThis);
