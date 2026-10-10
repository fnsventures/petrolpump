function computeTradingAndPl(o,i){const t=createBuyingRateContext(o.receiptRows),c=DsrQueries.mergeDsrStock(o.dsrRows,o.stockRows),r={petrol:{label:"Petrol (MS)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},diesel:{label:"Diesel (HSD)",sales:0,purchase:0,openingStockVal:0,closingStockVal:0,openingL:0,closingL:0},lube:{label:"Lubricant / Billing",sales:0,purchase:0,openingStockVal:0,closingStockVal:0}},l={petrol:{first:null,last:null},diesel:{first:null,last:null}};c.forEach(e=>{const s=normalizeProduct(e.product);if(!r[s])return;const u=getDsrNetSaleLitres(e),m=getDsrSaleRate(e),p=Number(e.receipts??0);if(p>0){const P=getEffectiveBuyingRate(e,t);P!=null&&(r[s].purchase+=p*P)}r[s].sales+=u*m,l[s]&&(l[s].first||(l[s].first=e),l[s].last=e)}),["petrol","diesel"].forEach(e=>{const s=l[e].first,u=l[e].last;if(!s||!u)return;r[e].openingL=Number(s.opening_stock??0),r[e].closingL=Number(u.dip_stock??u.stock??0);const m=getLandedBuyingRateForDate(e,s.date,t)??0,p=getLandedBuyingRateForDate(e,u.date,t)??m;r[e].openingStockVal=r[e].openingL*m,r[e].closingStockVal=r[e].closingL*p}),r.lube.sales=o.invoices.reduce((e,s)=>e+Number(s.total_amount??0),0);const g=(o.vaultPurchases??[]).reduce((e,s)=>{const u=Number(s.amount??0);return u>0?e+u:e},0);r.lube.purchase=g;const f=Object.values(r).reduce((e,s)=>e+s.sales,0),b=Object.values(r).reduce((e,s)=>e+s.purchase,0),h=Object.values(r).reduce((e,s)=>e+s.openingStockVal,0),y=Object.values(r).reduce((e,s)=>e+s.closingStockVal,0),$=f+y-h-b,a=computeProfitLossSummary({dsrRows:c,receiptRows:o.receiptRows,expenseRows:o.expenseRows,lubeSales:r.lube.sales,lubeCogs:g,requireAllBuying:!0,buyingContext:t,categoryMap:o.categoryMap}),d=new Map,n=new Map;return o.expenseRows.forEach(e=>{const s=e.category||"misc",u=getExpenseCategoryLabel(e,o.categoryMap),m=Number(e.amount??0),p=isTestingExpenseRow(e,o.categoryMap)?n:d;p.has(s)||p.set(s,{label:u,amount:0}),p.get(s).amount+=m}),{products:r,grossSales:f,totalPurchase:b,openingStock:h,closingStock:y,grossIncome:$,vaultPurchaseTotal:g,fuelGrossProfit:a.canCalculate?a.fuelGrossProfit??0:null,lubeGrossProfit:a.canCalculate?a.lubeGrossProfit??0:null,lubeCogs:g,grossProfit:a.canCalculate?a.grossProfit??0:null,expensesByCategory:d,testingExpensesByCategory:n,totalExpenses:a.totalExpenses,testingExpenses:a.testingExpenses,netProfit:a.canCalculate?a.netProfit:null,canCalculate:a.canCalculate,missingBuyingPrice:a.missingBuyingPrice,unresolvedBuying:a.unresolvedBuying,usingProvisionalBuying:a.usingProvisionalBuying}}function renderProfitGuide(o){return o==="trading"?`
      <aside class="report-profit-guide no-print" aria-label="How to read Gross income">
        <p class="report-profit-guide-title">Quick reference</p>
        <ul class="report-profit-guide-list">
          <li><strong>Gross income c/d</strong> \u2014 balances the trading account using stock. Useful for books, <em>not</em> your take-home profit.</li>
          <li><strong>Do not compare</strong> this to Gross profit / Nett profit on P&amp;L \u2014 different formula (stock vs per-litre margin).</li>
          <li><strong>Your real profit</strong> \u2014 open <strong>Profit &amp; Loss</strong> and use <strong>Nett Profit</strong> (or Dashboard \u2192 P&amp;L).</li>
        </ul>
      </aside>`:`
    <aside class="report-profit-guide no-print" aria-label="How to read profit figures">
      <p class="report-profit-guide-title">Quick reference</p>
      <ul class="report-profit-guide-list">
        <li><strong>Nett Profit</strong> \u2014 your <em>real profit</em> after expenses for this period. Use this number.</li>
        <li><strong>Gross Profit</strong> \u2014 margin before rent, salary, electricity, etc. (not take-home yet).</li>
        <li><strong>Gross income c/d</strong> (Trading account) \u2014 different figure; stock-based, not the same as Gross / Nett profit.</li>
      </ul>
    </aside>`}function renderTradingAccount(o,i){const t=getTradingAndPl(o,i),c=[["Sales \u2014 Petrol (MS)",t.products.petrol.sales,"petrol"],["Sales \u2014 Diesel (HSD)",t.products.diesel.sales,"diesel"],["Sales \u2014 Lube / Billing",t.products.lube.sales,null],["Closing stock \u2014 Petrol",t.products.petrol.closingStockVal,"petrol"],["Closing stock \u2014 Diesel",t.products.diesel.closingStockVal,"diesel"]],r=[["Opening stock \u2014 Petrol",t.products.petrol.openingStockVal,"petrol"],["Opening stock \u2014 Diesel",t.products.diesel.openingStockVal,"diesel"],["Purchases \u2014 Petrol",t.products.petrol.purchase,"petrol"],["Purchases \u2014 Diesel",t.products.diesel.purchase,"diesel"]];t.vaultPurchaseTotal>0&&r.push(["Purchases \u2014 Lube / other (vault)",t.vaultPurchaseTotal,null]),r.push(["Gross income c/d",t.grossIncome,null]);const l=(h,y)=>{const $=y.map(([d,n,e])=>`<tr class="${fuelRowClass(e)}"><td>${escapeHtml(d)}</td><td class="num">${formatNumberPlain(n)}</td></tr>`).join(""),a=y.reduce((d,[,n])=>d+Number(n),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(h)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${$}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(a)}</strong></td></tr></tfoot>
        </table>
      </div>`},g=t.usingProvisionalBuying&&t.missingBuyingPrice?.length?`<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) use the previous buying rate for stock/purchases \u2014 enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on Meter Reading \u2192 Purchase cost to lock the correct rate.</p>`:t.canCalculate?"":formatUnresolvedBuyingWarning(t),f=t.fuelGrossProfit!=null?`<p class="report-note muted">Dealer Margin (ops check, not a trading credit) = net litres \xD7 (selling \u2212 landed buying): <strong>${formatCurrency(t.fuelGrossProfit)}</strong> \u2014 same as Dashboard / P&amp;L fuel gross.</p>`:"",b=t.vaultPurchaseTotal>0?'<p class="report-note muted">Lube / other purchases = sum of vault <strong>Purchase invoice</strong> amounts in this period (Invoices page). Fuel inward remains on MS/HSD purchase lines from DSR.</p>':'<p class="report-note muted">No vault purchase amounts in this period \u2014 lube stock/COGS is not tracked separately. Add purchase PDFs with amounts on Invoices to populate Lube purchases.</p>';return`
    ${reportHeader("Trading account",i.start,i.end)}
    ${renderProfitGuide("trading")}
    <div class="report-pl-grid report-trading-grid">
      ${l("Debit",r)}
      ${l("Credit",c)}
    </div>
    <p class="report-note muted">Debit and credit totals match via Gross income c/d (stock-based: Sales + Closing \u2212 Opening \u2212 Purchases). This is not Nett Profit.</p>
    ${g}
    ${f}
    ${b}
    <p class="report-summary-line">Gross income c/d: <strong>${formatCurrency(t.grossIncome)}</strong> <span class="muted">(trading balance \u2014 see P&amp;L for real profit)</span></p>`}function formatUnresolvedBuyingWarning(o){const i=escapeHtml(getBuyingPriceUnitLabel()),t=o.unresolvedBuying?.length??0,c=o.missingBuyingPrice?.length??0;if(!o.canCalculate){const r=t>0?`${t} sale/receipt day(s) have no resolvable buying rate (no prior receipt rate in history)`:"Some days have no resolvable buying rate",l=c>0?` (${c} receipt day(s) also have no entered \u20B9/KL yet)`:"";return`<p class="report-note warning">${r}${l}. Enter pre-VAT ${i} on Meter Reading \u2192 Purchase cost before net profit can be calculated.</p>`}return o.usingProvisionalBuying&&c>0?`<p class="report-note warning">${c} receipt day(s) still need an entered buying price \u2014 figures below use the previous receipt rate until you save ${i} on Meter Reading \u2192 Purchase cost.</p>`:""}function renderProfitLoss(o,i){const t=getTradingAndPl(o,i),c=Array.from(t.expensesByCategory.values()).sort((n,e)=>n.label.localeCompare(e.label)),r=Array.from(t.testingExpensesByCategory.values()).sort((n,e)=>n.label.localeCompare(e.label)),l=formatUnresolvedBuyingWarning(t),g=Number(t.totalExpenses??0),f=r.length?`<p class="report-note muted">Testing expenses excluded from net profit (day closing): ${r.map(n=>`${escapeHtml(n.label)} \u20B9${formatNumberPlain(n.amount)}`).join("; ")}.</p>`:"";if(!t.canCalculate){const n=c.length>0?`<table class="report-table">
            <thead><tr><th>Expense head</th><th class="num">Amount (\u20B9)</th></tr></thead>
            <tbody>${c.map(e=>`<tr><td>${escapeHtml(e.label)}</td><td class="num">${formatNumberPlain(e.amount)}</td></tr>`).join("")}</tbody>
            <tfoot><tr class="report-total-row"><td><strong>Total (excl. testing)</strong></td><td class="num"><strong>${formatNumberPlain(g)}</strong></td></tr></tfoot>
          </table>`:'<p class="muted">No operating expenses in this period.</p>';return`
      ${reportHeader("Profit & loss account",i.start,i.end)}
      ${l}
      <p class="report-summary-line">Gross profit: <strong>\u2014</strong> \xB7 Expenses: <strong>${formatCurrency(g)}</strong> \xB7 Nett profit: <strong>\u2014</strong></p>
      <h3>Operating expenses</h3>
      ${n}
      ${f}
      <p class="report-note muted">Books debit/credit layout is hidden until every sale/receipt day can resolve a buying rate (entered or prior receipt).</p>`}const b=Number(t.grossProfit??0),h=Number(t.netProfit??0),y=[["Gross Profit",b]],$=c.map(n=>[n.label,n.amount]);$.push(["Nett Profit",h]);const a=(n,e,{boldLast:s=!1}={})=>{const u=e.map(([p,P],k)=>{const v=s&&k===e.length-1,N=v?' class="report-total-row"':"",S=v?`<strong>${escapeHtml(p)}</strong>`:escapeHtml(p),C=v?`<strong>${formatNumberPlain(P)}</strong>`:formatNumberPlain(P);return`<tr${N}><td>${S}</td><td class="num">${C}</td></tr>`}).join(""),m=e.reduce((p,[,P])=>p+Number(P),0);return`
      <div class="report-pl-column">
        <h3>${escapeHtml(n)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (\u20B9)</th></tr></thead>
          <tbody>${u||'<tr><td colspan="2" class="muted">No entries</td></tr>'}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(m)}</strong></td></tr></tfoot>
        </table>
      </div>`},d=`<p class="report-note muted">Gross profit = fuel gross <strong>${formatCurrency(t.fuelGrossProfit)}</strong>${t.lubeCogs>0||t.products.lube.sales>0?` + lube gross <strong>${formatCurrency(t.lubeGrossProfit)}</strong> (sales \u2212 vault purchases)`:""}. Same formula as Analysis and the Dashboard Net profit glance.</p>`;return`
    ${reportHeader("Profit & loss account",i.start,i.end)}
    ${renderProfitGuide("pl")}
    ${l}
    <div class="report-pl-grid report-trading-grid">
      ${a("Debit (indirect expenses)",$,{boldLast:!0})}
      ${a("Credit",y,{boldLast:!0})}
    </div>
    <p class="report-summary-line">Gross profit: <strong>${formatCurrency(b)}</strong> \xB7 Expenses: <strong>${formatCurrency(g)}</strong> \xB7 Nett profit (real profit): <strong>${formatCurrency(h)}</strong></p>
    ${f}
    ${d}`}
