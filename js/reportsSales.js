function parseReportTankCapacityLiters(s){if(!s)return null;const e=String(s).trim().toUpperCase().replace(/\s/g,""),r=e.match(/^([\d.]+)KL$/);if(r)return Number(r[1])*1e3;const l=e.match(/^([\d.]+)L$/);if(l)return Number(l[1]);const o=Number(e.replace(/[^\d.]/g,""));return Number.isFinite(o)&&o>0?o:null}function buildTankDsrSection(s,e,r,l,o){let c=0,i=0,p=0,h=0,f=0,n=0,u=0,g=0,d=null;const t=parseReportTankCapacityLiters(r),a=l.map(b=>{const N=Number(b.opening_stock??0),P=Number(b.receipts??0),_=Number(b.testing??0),L=Number(b.total_sales??0),y=getDsrNetSaleLitres(b);c+=y;const $=Number(b.dip_stock??b.stock??0),S=Math.max(0,Number(b.variation??0)),k=Math.max(N+P-S,0),D=Math.max(N+P-$,0);g=$;const T=y-D;i+=T;const R=t!=null&&Number.isFinite($)?Math.max(0,t-$):null;d=R,p+=P,h+=S,f+=_,n+=L,u+=y;const C=Number(b[o]??0);return`<tr>
        <td>${formatNumericDate(b.date)}</td>
        <td class="num">${formatNumberPlain(N)}</td>
        <td class="num">${formatNumberPlain(P)}</td>
        <td class="num">${formatNumberPlain(S)}</td>
        <td class="num">${formatNumberPlain(k)}</td>
        <td class="num">${formatNumberPlain(_)}</td>
        <td class="num">${formatNumberPlain(L)}</td>
        <td class="num">${formatNumberPlain(y)}</td>
        <td class="num">${formatNumberPlain(c)}</td>
        <td class="num">${formatNumberPlain(D)}</td>
        <td class="num">${formatNumberPlain($)}</td>
        <td class="num">${formatNumberPlain(T)}</td>
        <td class="num">${formatNumberPlain(i)}</td>
        <td class="num">${formatNumberPlain(C)}</td>
        <td class="num">${R==null?"\u2014":formatNumberPlain(R)}</td>
      </tr>`}).join(""),m=s==="diesel"?"Diesel":"Petrol";return`
    <section class="report-tank-section report-tank-section--${s}">
      <h3 class="report-tank-title">Tank: ${escapeHtml(e)} \xB7 ${escapeHtml(r)} \xB7 ${escapeHtml(m)}</h3>
      <table class="report-table report-dsr-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" class="num" title="Opening dip (L)">Open</th>
            <th scope="col" class="num" title="Purchase / receipts (L)">Buy</th>
            <th scope="col" class="num" title="Physical shortage (L): max(0, book \u2212 dip)">Short</th>
            <th scope="col" class="num" title="Book total = open + buy \u2212 short (L)">Total</th>
            <th scope="col" class="num" title="Testing (L)">Test</th>
            <th scope="col" class="num" title="Sale by meter (L)">Meter</th>
            <th scope="col" class="num" title="Actual sale (L)">Actual</th>
            <th scope="col" class="num" title="Cumulative sale (L)">Cum</th>
            <th scope="col" class="num" title="Sale by dip (L)">Dip</th>
            <th scope="col" class="num" title="Closing dip (L)">Close</th>
            <th scope="col" class="num" title="Variance = actual \u2212 sale by dip (L)">Var</th>
            <th scope="col" class="num" title="Cumulative variance (L)">CumV</th>
            <th scope="col" class="num" title="Selling rate (\u20B9/L)">Rate</th>
            <th scope="col" class="num" title="Tank volume available = capacity \u2212 closing dip (L)">TVA</th>
          </tr>
        </thead>
        <tbody>${a||'<tr><td colspan="15" class="muted">No entries</td></tr>'}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(f)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(n)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(g)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
            <td></td>
            <td class="num"><strong>${d==null?"\u2014":formatNumberPlain(d)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </section>`}function renderTankWiseDsr(s,e){const r=DsrQueries.mergeDsrStock(s.dsrRows,s.stockRows),l=PumpSettings.getCachedSync().reports?.tanks||AppConfig.DEFAULT_REPORT_TANKS;let o=reportHeader("Tank-wise DSR report",e.start,e.end),c=!1;return l.forEach(i=>{const p=r.filter(f=>normalizeProduct(f.product)===i.product);if(!p.length)return;c=!0;const h=i.product==="petrol"?"petrol_rate":"diesel_rate";o+=buildTankDsrSection(i.product,i.label,i.capacity,p,h)}),c?o+='<p class="report-note muted">One section per physical tank (HSD and MS). Short = max(0, book \u2212 dip); Total = open + buy \u2212 short; Actual = meter \u2212 testing; Var = actual \u2212 sale by dip (open + buy \u2212 close); TVA = tank capacity \u2212 closing dip.</p>':o+='<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>',o}function fuelIncomeMetrics(s,e){if(!s)return{litres:0,saleRate:0,buyRate:null,income:null,missingBuy:!1};const r=getDsrNetSaleLitres(s),l=getDsrSaleRate(s),o=getEffectiveBuyingRate(s,e),c=r>0&&o==null,i=o!=null&&r>0?r*(l-o):null;return{litres:r,saleRate:l,buyRate:o,income:i,missingBuy:c}}function formatFuelIncomeCell(s,{empty:e="\u2014"}={}){return s==null||!Number.isFinite(s)?e:formatNumberPlain(s)}function renderFuelIncome(s,e){const r=createBuyingRateContext(s.receiptRows),l=new Map;(s.dsrRows??[]).forEach(d=>{const t=d.date;if(!t)return;l.has(t)||l.set(t,{petrol:null,diesel:null});const a=normalizeProduct(d.product);(a==="petrol"||a==="diesel")&&(l.get(t)[a]=d)});const o=[...l.keys()].sort();let c=0,i=0,p=0,h=0,f=0;const n=o.map(d=>{const t=l.get(d),a=fuelIncomeMetrics(t.petrol,r),m=fuelIncomeMetrics(t.diesel,r);(a.missingBuy||m.missingBuy)&&(f+=1),c+=a.litres,i+=m.litres,a.income!=null&&(p+=a.income),m.income!=null&&(h+=m.income);const b=(a.income!=null?a.income:0)+(m.income!=null?m.income:0),N=a.income==null&&m.income==null&&(a.litres>0||m.litres>0)?"\u2014":formatNumberPlain(b);return`<tr>
        <td>${formatNumericDate(d)}</td>
        <td class="num">${formatFuelIncomeCell(a.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(a.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(a.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(a.income)}</td>
        <td class="num">${formatFuelIncomeCell(m.litres||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(m.saleRate||null,{empty:""})}</td>
        <td class="num">${formatFuelIncomeCell(m.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(m.income)}</td>
        <td class="num"><strong>${N}</strong></td>
      </tr>`}).join(""),u=p+h,g=f>0?`<p class="report-note warning">${f} day(s) have sale litres but no landed buying rate \u2014 P.Rate / P.Income blank for those products. Enter buying price on Meter Reading \u2192 Purchase cost for receipt days.</p>`:"";return`
    ${reportHeader("Fuel Sale Income Report",e.start,e.end)}
    <table class="report-table report-fuel-income-table">
      <thead>
        <tr>
          <th rowspan="2" scope="col">Date</th>
          <th colspan="4" scope="colgroup">Petrol (MS)</th>
          <th colspan="4" scope="colgroup">Diesel (HSD)</th>
          <th rowspan="2" scope="col" class="num">Total Income</th>
        </tr>
        <tr>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate \u20B9/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate \u20B9/L">P.Rate</th>
          <th scope="col" class="num" title="Margin \u20B9">P.Income</th>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate \u20B9/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate \u20B9/L">P.Rate</th>
          <th scope="col" class="num" title="Margin \u20B9">P.Income</th>
        </tr>
      </thead>
      <tbody>${n||'<tr><td colspan="10" class="muted">No meter readings in this period.</td></tr>'}</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${formatNumberPlain(c)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(u)}</strong></td>
        </tr>
      </tfoot>
    </table>
    ${g}
    <p class="report-note muted">P.Income = net litres (meter \u2212 testing) \xD7 (selling rate \u2212 landed buying rate incl. VAT + delivery + LFR). Same fuel-margin basis as Analysis and Reports P&amp;L.</p>`}function productFuelLabel(s){const e=normalizeProduct(s);return e==="petrol"?"MS":e==="diesel"?"HSD":s||"\u2014"}function shiftReportLabel(s){const e=PumpSettings.getShiftConfig?.()||{};return s==="morning"?e.morningName||"Morning":s==="afternoon"?e.afternoonName||"Afternoon":s||"\u2014"}function renderPumpSalesReport(s,e){const r=s.meterBreakdown,l=r?.by_pump||[],o=r?.daily_pump||[],c=new Set(l.map(n=>`${n.reading_date}|${normalizeProduct(n.product)}|${n.pump_no}`)),i=(o||[]).flatMap(n=>{const u=n.date||n.reading_date,g=normalizeProduct(n.product),d=[];for(const t of[1,2]){const a=`${u}|${g}|${t}`;c.has(a)||d.push({reading_date:u,shift:null,product:g,pump_no:t,litres:t===1?Number(n.sales_pump1)||0:Number(n.sales_pump2)||0,net_litres:null,from_daily:!0})}return d}),p=[...l,...i].sort((n,u)=>{const g=String(u.reading_date).localeCompare(String(n.reading_date));if(g)return g;const d=String(n.shift||"").localeCompare(String(u.shift||""));if(d)return d;const t=String(n.product).localeCompare(String(u.product));return t||(n.pump_no||0)-(u.pump_no||0)});let h=0;const f=p.map(n=>(h+=Number(n.litres)||0,`<tr>
          <td>${formatNumericDate(n.reading_date)}</td>
          <td>${n.from_daily?"Daily":escapeHtml(shiftReportLabel(n.shift))}</td>
          <td>${formatFuelBadge(productFuelLabel(n.product))}</td>
          <td>Pump ${escapeHtml(String(n.pump_no))}</td>
          <td class="num">${formatNumberPlain(n.litres)}</td>
          <td class="num">${n.net_litres==null?"\u2014":formatNumberPlain(n.net_litres)}</td>
        </tr>`)).join("");return f?`
    ${reportHeader("Pump-wise sales",e.start,e.end)}
    <p class="muted report-note">Shift nozzle rollups when available; days without shift data fall back to daily P1/P2.</p>
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Fuel</th>
          <th>Pump</th>
          <th class="num">Sale (L)</th>
          <th class="num">Net (L)</th>
        </tr>
      </thead>
      <tbody>${f}</tbody>
      <tfoot>
        <tr>
          <td colspan="4"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
          <td></td>
        </tr>
      </tfoot>
    </table>`:`${reportHeader("Pump-wise sales",e.start,e.end)}
      <p class="muted">No pump sales in this period.</p>
      <p class="muted">Enter meters on <a href="meter-reading.html">Meter Reading</a> or shift nozzle assignments.</p>`}function renderShiftSalesReport(s,e){const r=s.meterBreakdown?.by_shift||[];if(!r.length)return`${reportHeader("Shift-wise sales",e.start,e.end)}
      <p class="muted">No shift register entries in this period.</p>
      <p class="muted">Enter data under <a href="meter-reading.html#shift-readings">Meter Reading \u2192 Shift register</a>.</p>`;let l=0;const o=r.map(c=>(l+=Number(c.litres)||0,`<tr>
        <td>${formatNumericDate(c.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(c.shift))}</td>
        <td>${formatFuelBadge(productFuelLabel(c.product))}</td>
        <td class="num">${formatNumberPlain(c.litres)}</td>
        <td class="num">${formatNumberPlain(c.net_litres)}</td>
        <td class="num">${c.staff_count??"\u2014"}</td>
      </tr>`)).join("");return`
    ${reportHeader("Shift-wise sales",e.start,e.end)}
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Fuel</th>
          <th class="num">Sale (L)</th>
          <th class="num">Net (L)</th>
          <th class="num">Staff</th>
        </tr>
      </thead>
      <tbody>${o}</tbody>
      <tfoot>
        <tr>
          <td colspan="3"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(l)}</strong></td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>`}function renderSalesmanSalesReport(s,e){const r=s.meterBreakdown?.by_salesman||[];if(!r.length)return`${reportHeader("Salesman sales",e.start,e.end)}
      <p class="muted">No salesman assignments in this period.</p>
      <p class="muted">Assign staff to nozzles under <a href="meter-reading.html#shift-readings">Shift register</a>.</p>`;const l=new Map;(s.dsrRows||[]).forEach(t=>{const a=l.get(t.date)||{petrol:0,diesel:0},m=normalizeProduct(t.product);m==="petrol"&&(a.petrol=Number(t.petrol_rate)||a.petrol),m==="diesel"&&(a.diesel=Number(t.diesel_rate)||a.diesel),l.set(t.date,a)});let o=0,c=0,i=0,p=0,h=0,f=0,n=0,u=0,g=!1;const d=r.map(t=>{const a=l.get(t.reading_date)||{},m=t.petrol_net_litres!=null?Number(t.petrol_net_litres):Number(t.petrol_litres)||0,b=t.diesel_net_litres!=null?Number(t.diesel_net_litres):Number(t.diesel_litres)||0,N=m*(a.petrol||0)+b*(a.diesel||0),P=Number(t.cash_collected)||0,_=Number(t.phone_pay)||0,L=Number(t.credit_amount)||0,y=Number(t.expense_amount)||0,$=t.total_collected!=null?Number(t.total_collected)||0:P+_+L+y,S=a.petrol||a.diesel;return S&&(g=!0,c+=N,u+=N-$),o+=Number(t.total_litres)||0,i+=P,p+=_,h+=L,f+=y,n+=$,`<tr>
        <td>${formatNumericDate(t.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(t.shift))}</td>
        <td>${escapeHtml(t.employee_name||"Staff")}</td>
        <td class="num">${formatNumberPlain(t.petrol_litres)}</td>
        <td class="num">${formatNumberPlain(t.diesel_litres)}</td>
        <td class="num">${formatNumberPlain(t.total_litres)}</td>
        <td class="num">${S?formatNumberPlain(N):"\u2014"}</td>
        <td class="num">${formatNumberPlain(P)}</td>
        <td class="num">${formatNumberPlain(_)}</td>
        <td class="num">${formatNumberPlain(L)}</td>
        <td class="num">${formatNumberPlain(y)}</td>
        <td class="num">${formatNumberPlain($)}</td>
        <td class="num">${S?formatNumberPlain(N-$):"\u2014"}</td>
      </tr>`}).join("");return`
    ${reportHeader("Salesman sales",e.start,e.end)}
    <p class="muted report-note">Short = expected \u2212 (cash + phone + credit + expenses). Expected = net litres (sale \u2212 testing) \xD7 daily selling rates.</p>
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Salesman</th>
          <th class="num">MS (L)</th>
          <th class="num">HSD (L)</th>
          <th class="num">Total (L)</th>
          <th class="num">Expected \u20B9</th>
          <th class="num">Cash \u20B9</th>
          <th class="num">Phone \u20B9</th>
          <th class="num">Credit \u20B9</th>
          <th class="num">Exp \u20B9</th>
          <th class="num">Total \u20B9</th>
          <th class="num">Short \u20B9</th>
        </tr>
      </thead>
      <tbody>${d}</tbody>
      <tfoot>
        <tr>
          <td colspan="5"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(o)}</strong></td>
          <td class="num"><strong>${g?formatNumberPlain(c):"\u2014"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(i)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(p)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(h)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(f)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(n)}</strong></td>
          <td class="num"><strong>${g?formatNumberPlain(u):"\u2014"}</strong></td>
        </tr>
      </tfoot>
    </table>`}
