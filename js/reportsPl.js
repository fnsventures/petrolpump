/* global escapeHtml, formatCurrency, formatNumberPlain, reportHeader, computeProfitLossSummary, createBuyingRateContext, getDsrNetSaleLitres, getDsrSaleRate, normalizeProduct, findUnresolvedBuyingRateRows, getExpenseCategoryLabel, isTestingExpenseCategory, DsrQueries */
/**
 * Trading account and profit & loss reports.
 */


/** Trading account (stock-based) + P&L figures via shared computeProfitLossSummary. */
function computeTradingAndPl(data, range) {
  const buyingContext = createBuyingRateContext(data.receiptRows);
  const merged = DsrQueries.mergeDsrStock(data.dsrRows, data.stockRows);

  const products = {
    petrol: { label: "Petrol (MS)", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0, openingL: 0, closingL: 0 },
    diesel: { label: "Diesel (HSD)", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0, openingL: 0, closingL: 0 },
    lube: { label: "Lubricant / Billing", sales: 0, purchase: 0, openingStockVal: 0, closingStockVal: 0 },
  };

  const productBounds = {
    petrol: { first: null, last: null },
    diesel: { first: null, last: null },
  };

  merged.forEach((row) => {
    const p = normalizeProduct(row.product);
    if (!products[p]) return;
    const netL = getDsrNetSaleLitres(row);
    const rate = getDsrSaleRate(row);
    const receiptL = Number(row.receipts ?? 0);
    if (receiptL > 0) {
      // Prefer entered rate; else previous receipt rate (same as P&L carry-forward).
      const landedRate = getEffectiveBuyingRate(row, buyingContext);
      if (landedRate != null) products[p].purchase += receiptL * landedRate;
    }
    products[p].sales += netL * rate;
    if (productBounds[p]) {
      if (!productBounds[p].first) productBounds[p].first = row;
      productBounds[p].last = row;
    }
  });

  ["petrol", "diesel"].forEach((p) => {
    const first = productBounds[p].first;
    const last = productBounds[p].last;
    if (!first || !last) return;
    products[p].openingL = Number(first.opening_stock ?? 0);
    products[p].closingL = Number(last.dip_stock ?? last.stock ?? 0);
    const openBuy = getLandedBuyingRateForDate(p, first.date, buyingContext) ?? 0;
    const closeBuy = getLandedBuyingRateForDate(p, last.date, buyingContext) ?? openBuy;
    products[p].openingStockVal = products[p].openingL * openBuy;
    products[p].closingStockVal = products[p].closingL * closeBuy;
  });

  products.lube.sales = data.invoices.reduce((s, i) => s + Number(i.total_amount ?? 0), 0);
  // Vault purchase PDFs with amounts (lube / other inward — fuel purchases stay on DSR lines).
  const vaultPurchaseTotal = (data.vaultPurchases ?? []).reduce((s, row) => {
    const amt = Number(row.amount ?? 0);
    return amt > 0 ? s + amt : s;
  }, 0);
  products.lube.purchase = vaultPurchaseTotal;

  const grossSales = Object.values(products).reduce((s, x) => s + x.sales, 0);
  const totalPurchase = Object.values(products).reduce((s, x) => s + x.purchase, 0);
  const openingStock = Object.values(products).reduce((s, x) => s + x.openingStockVal, 0);
  const closingStock = Object.values(products).reduce((s, x) => s + x.closingStockVal, 0);

  // Stock-based balancing figure only (Dealer Margin is margin P&L, not a trading credit).
  const grossIncome = grossSales + closingStock - openingStock - totalPurchase;
  const pl = computeProfitLossSummary({
    dsrRows: merged,
    receiptRows: data.receiptRows,
    expenseRows: data.expenseRows,
    lubeSales: products.lube.sales,
    lubeCogs: vaultPurchaseTotal,
    requireAllBuying: true,
    buyingContext,
    categoryMap: data.categoryMap,
  });

  const expensesByCategory = new Map();
  const testingExpensesByCategory = new Map();
  data.expenseRows.forEach((e) => {
    const key = e.category || "misc";
    const label = getExpenseCategoryLabel(e, data.categoryMap);
    const amount = Number(e.amount ?? 0);
    const bucket = isTestingExpenseRow(e, data.categoryMap)
      ? testingExpensesByCategory
      : expensesByCategory;
    if (!bucket.has(key)) bucket.set(key, { label, amount: 0 });
    bucket.get(key).amount += amount;
  });

  return {
    products,
    grossSales,
    totalPurchase,
    openingStock,
    closingStock,
    grossIncome,
    vaultPurchaseTotal,
    fuelGrossProfit: pl.canCalculate ? (pl.fuelGrossProfit ?? 0) : null,
    lubeGrossProfit: pl.canCalculate ? (pl.lubeGrossProfit ?? 0) : null,
    lubeCogs: vaultPurchaseTotal,
    grossProfit: pl.canCalculate ? (pl.grossProfit ?? 0) : null,
    expensesByCategory,
    testingExpensesByCategory,
    totalExpenses: pl.totalExpenses,
    testingExpenses: pl.testingExpenses,
    netProfit: pl.canCalculate ? pl.netProfit : null,
    canCalculate: pl.canCalculate,
    missingBuyingPrice: pl.missingBuyingPrice,
    unresolvedBuying: pl.unresolvedBuying,
    usingProvisionalBuying: pl.usingProvisionalBuying,
  };
}

function renderProfitGuide(kind) {
  if (kind === "trading") {
    return `
      <aside class="report-profit-guide no-print" aria-label="How to read Gross income">
        <p class="report-profit-guide-title">Quick reference</p>
        <ul class="report-profit-guide-list">
          <li><strong>Gross income c/d</strong> — balances the trading account using stock. Useful for books, <em>not</em> your take-home profit.</li>
          <li><strong>Do not compare</strong> this to Gross profit / Nett profit on P&amp;L — different formula (stock vs per-litre margin).</li>
          <li><strong>Your real profit</strong> — open <strong>Profit &amp; Loss</strong> and use <strong>Nett Profit</strong> (or Dashboard → P&amp;L).</li>
        </ul>
      </aside>`;
  }
  return `
    <aside class="report-profit-guide no-print" aria-label="How to read profit figures">
      <p class="report-profit-guide-title">Quick reference</p>
      <ul class="report-profit-guide-list">
        <li><strong>Nett Profit</strong> — your <em>real profit</em> after expenses for this period. Use this number.</li>
        <li><strong>Gross Profit</strong> — margin before rent, salary, electricity, etc. (not take-home yet).</li>
        <li><strong>Gross income c/d</strong> (Trading account) — different figure; stock-based, not the same as Gross / Nett profit.</li>
      </ul>
    </aside>`;
}

function renderTradingAccount(data, range) {
  const t = getTradingAndPl(data, range);

  const creditRows = [
    ["Sales — Petrol (MS)", t.products.petrol.sales, "petrol"],
    ["Sales — Diesel (HSD)", t.products.diesel.sales, "diesel"],
    ["Sales — Lube / Billing", t.products.lube.sales, null],
    ["Closing stock — Petrol", t.products.petrol.closingStockVal, "petrol"],
    ["Closing stock — Diesel", t.products.diesel.closingStockVal, "diesel"],
  ];

  const debitRows = [
    ["Opening stock — Petrol", t.products.petrol.openingStockVal, "petrol"],
    ["Opening stock — Diesel", t.products.diesel.openingStockVal, "diesel"],
    ["Purchases — Petrol", t.products.petrol.purchase, "petrol"],
    ["Purchases — Diesel", t.products.diesel.purchase, "diesel"],
  ];
  if (t.vaultPurchaseTotal > 0) {
    debitRows.push(["Purchases — Lube / other (vault)", t.vaultPurchaseTotal, null]);
  }
  debitRows.push(["Gross income c/d", t.grossIncome, null]);

  const renderSide = (title, rows) => {
    const body = rows
      .map(
        ([label, amt, product]) =>
          `<tr class="${fuelRowClass(product)}"><td>${escapeHtml(label)}</td><td class="num">${formatNumberPlain(amt)}</td></tr>`
      )
      .join("");
    const total = rows.reduce((s, [, a]) => s + Number(a), 0);
    return `
      <div class="report-pl-column">
        <h3>${escapeHtml(title)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (₹)</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(total)}</strong></td></tr></tfoot>
        </table>
      </div>`;
  };

  const provisionalNote =
    t.usingProvisionalBuying && t.missingBuyingPrice?.length
      ? `<p class="report-note warning">${t.missingBuyingPrice.length} receipt day(s) use the previous buying rate for stock/purchases — enter pre-VAT ${escapeHtml(getBuyingPriceUnitLabel())} on Meter Reading → Purchase cost to lock the correct rate.</p>`
      : !t.canCalculate
        ? formatUnresolvedBuyingWarning(t)
        : "";

  const marginNote =
    t.fuelGrossProfit != null
      ? `<p class="report-note muted">Dealer Margin (ops check, not a trading credit) = net litres × (selling − landed buying): <strong>${formatCurrency(t.fuelGrossProfit)}</strong> — same as Dashboard / P&amp;L fuel gross.</p>`
      : "";

  const vaultNote =
    t.vaultPurchaseTotal > 0
      ? `<p class="report-note muted">Lube / other purchases = sum of vault <strong>Purchase invoice</strong> amounts in this period (Invoices page). Fuel inward remains on MS/HSD purchase lines from DSR.</p>`
      : `<p class="report-note muted">No vault purchase amounts in this period — lube stock/COGS is not tracked separately. Add purchase PDFs with amounts on Invoices to populate Lube purchases.</p>`;

  return `
    ${reportHeader("Trading account", range.start, range.end)}
    ${renderProfitGuide("trading")}
    <div class="report-pl-grid report-trading-grid">
      ${renderSide("Debit", debitRows)}
      ${renderSide("Credit", creditRows)}
    </div>
    <p class="report-note muted">Debit and credit totals match via Gross income c/d (stock-based: Sales + Closing − Opening − Purchases). This is not Nett Profit.</p>
    ${provisionalNote}
    ${marginNote}
    ${vaultNote}
    <p class="report-summary-line">Gross income c/d: <strong>${formatCurrency(t.grossIncome)}</strong> <span class="muted">(trading balance — see P&amp;L for real profit)</span></p>`;
}

function formatUnresolvedBuyingWarning(t) {
  const unit = escapeHtml(getBuyingPriceUnitLabel());
  const unresolved = t.unresolvedBuying?.length ?? 0;
  const missingOwn = t.missingBuyingPrice?.length ?? 0;
  if (!t.canCalculate) {
    const dayNote =
      unresolved > 0
        ? `${unresolved} sale/receipt day(s) have no resolvable buying rate (no prior receipt rate in history)`
        : "Some days have no resolvable buying rate";
    const ownNote =
      missingOwn > 0 ? ` (${missingOwn} receipt day(s) also have no entered ₹/KL yet)` : "";
    return `<p class="report-note warning">${dayNote}${ownNote}. Enter pre-VAT ${unit} on Meter Reading → Purchase cost before net profit can be calculated.</p>`;
  }
  if (t.usingProvisionalBuying && missingOwn > 0) {
    return `<p class="report-note warning">${missingOwn} receipt day(s) still need an entered buying price — figures below use the previous receipt rate until you save ${unit} on Meter Reading → Purchase cost.</p>`;
  }
  return "";
}

function renderProfitLoss(data, range) {
  const t = getTradingAndPl(data, range);
  const expenseRows = Array.from(t.expensesByCategory.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );
  const testingExpenseRows = Array.from(t.testingExpensesByCategory.values()).sort(
    (a, b) => a.label.localeCompare(b.label)
  );

  const buyingWarning = formatUnresolvedBuyingWarning(t);
  const expensesTotal = Number(t.totalExpenses ?? 0);

  const testingNote = testingExpenseRows.length
    ? `<p class="report-note muted">Testing expenses excluded from net profit (day closing): ${testingExpenseRows
        .map((e) => `${escapeHtml(e.label)} ₹${formatNumberPlain(e.amount)}`)
        .join("; ")}.</p>`
    : "";

  // When buying rates cannot be resolved, do not render a partial books layout
  // (credit GP=0 vs debit expenses would not balance).
  if (!t.canCalculate) {
    const expenseList =
      expenseRows.length > 0
        ? `<table class="report-table">
            <thead><tr><th>Expense head</th><th class="num">Amount (₹)</th></tr></thead>
            <tbody>${expenseRows
              .map(
                (e) =>
                  `<tr><td>${escapeHtml(e.label)}</td><td class="num">${formatNumberPlain(e.amount)}</td></tr>`
              )
              .join("")}</tbody>
            <tfoot><tr class="report-total-row"><td><strong>Total (excl. testing)</strong></td><td class="num"><strong>${formatNumberPlain(expensesTotal)}</strong></td></tr></tfoot>
          </table>`
        : `<p class="muted">No operating expenses in this period.</p>`;
    return `
      ${reportHeader("Profit & loss account", range.start, range.end)}
      ${buyingWarning}
      <p class="report-summary-line">Gross profit: <strong>—</strong> · Expenses: <strong>${formatCurrency(expensesTotal)}</strong> · Nett profit: <strong>—</strong></p>
      <h3>Operating expenses</h3>
      ${expenseList}
      ${testingNote}
      <p class="report-note muted">Books debit/credit layout is hidden until every sale/receipt day can resolve a buying rate (entered or prior receipt).</p>`;
  }

  // Margin-based books layout (same formula as Dashboard / Analysis).
  const grossProfit = Number(t.grossProfit ?? 0);
  const nettProfit = Number(t.netProfit ?? 0);

  const creditRows = [["Gross Profit", grossProfit]];
  const debitRows = expenseRows.map((e) => [e.label, e.amount]);
  debitRows.push(["Nett Profit", nettProfit]);

  const renderBooksSide = (title, rows, { boldLast = false } = {}) => {
    const body = rows
      .map(([label, amt], idx) => {
        const isLast = boldLast && idx === rows.length - 1;
        const cls = isLast ? ' class="report-total-row"' : "";
        const lab = isLast ? `<strong>${escapeHtml(label)}</strong>` : escapeHtml(label);
        const val = isLast ? `<strong>${formatNumberPlain(amt)}</strong>` : formatNumberPlain(amt);
        return `<tr${cls}><td>${lab}</td><td class="num">${val}</td></tr>`;
      })
      .join("");
    const total = rows.reduce((s, [, a]) => s + Number(a), 0);
    return `
      <div class="report-pl-column">
        <h3>${escapeHtml(title)}</h3>
        <table class="report-table report-trading-table">
          <thead><tr><th>Particulars</th><th class="num">Amount (₹)</th></tr></thead>
          <tbody>${body || `<tr><td colspan="2" class="muted">No entries</td></tr>`}</tbody>
          <tfoot><tr class="report-total-row"><td><strong>Total</strong></td><td class="num"><strong>${formatNumberPlain(total)}</strong></td></tr></tfoot>
        </table>
      </div>`;
  };

  const breakdownNote = `<p class="report-note muted">Gross profit = fuel gross <strong>${formatCurrency(t.fuelGrossProfit)}</strong>${
    t.lubeCogs > 0 || t.products.lube.sales > 0
      ? ` + lube gross <strong>${formatCurrency(t.lubeGrossProfit)}</strong> (sales − vault purchases)`
      : ""
  }. Same formula as Analysis and the Dashboard Net profit glance.</p>`;

  return `
    ${reportHeader("Profit & loss account", range.start, range.end)}
    ${renderProfitGuide("pl")}
    ${buyingWarning}
    <div class="report-pl-grid report-trading-grid">
      ${renderBooksSide("Debit (indirect expenses)", debitRows, { boldLast: true })}
      ${renderBooksSide("Credit", creditRows, { boldLast: true })}
    </div>
    <p class="report-summary-line">Gross profit: <strong>${formatCurrency(grossProfit)}</strong> · Expenses: <strong>${formatCurrency(expensesTotal)}</strong> · Nett profit (real profit): <strong>${formatCurrency(nettProfit)}</strong></p>
    ${testingNote}
    ${breakdownNote}`;
}
