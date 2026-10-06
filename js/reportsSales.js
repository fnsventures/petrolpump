/* global PumpSettings, AppConfig, escapeHtml, formatNumberPlain, formatNumericDate, formatCurrency, formatFuelBadge, normalizeProduct, computeFuelRowMargin, createBuyingRateContext, getEffectiveBuyingRate, reportHeader */
/**
 * Operations reports: tank-wise DSR, fuel income, pump, shift, and salesman sales.
 */


/** Parse tank capacity strings like "20KL" / "15 Kl" / "15000L" to litres. */
function parseReportTankCapacityLiters(capacityStr) {
  if (!capacityStr) return null;
  const s = String(capacityStr).trim().toUpperCase().replace(/\s/g, "");
  const kl = s.match(/^([\d.]+)KL$/);
  if (kl) return Number(kl[1]) * 1000;
  const l = s.match(/^([\d.]+)L$/);
  if (l) return Number(l[1]);
  const num = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function buildTankDsrSection(product, tankLabel, capacity, rows, rateField) {
  let cumSale = 0;
  let cumVariance = 0;
  let totalPurchase = 0;
  let totalShortage = 0;
  let totalTesting = 0;
  let totalMeter = 0;
  let totalActual = 0;
  let lastClosing = 0;
  let lastTva = null;
  const capacityL = parseReportTankCapacityLiters(capacity);

  const bodyRows = rows
    .map((row) => {
      const openingDip = Number(row.opening_stock ?? 0);
      const purchase = Number(row.receipts ?? 0);
      const testing = Number(row.testing ?? 0);
      const saleMeter = Number(row.total_sales ?? 0);
      const actualSale = getDsrNetSaleLitres(row);
      cumSale += actualSale;
      const closingDip = Number(row.dip_stock ?? row.stock ?? 0);
      // Physical shortage (L): book closing − dip when books are higher than dip.
      const shortage = Math.max(0, Number(row.variation ?? 0));
      const bookTotal = Math.max(openingDip + purchase - shortage, 0);
      // Sale by dip uses full open+buy−close (shortage is a separate stock signal).
      const saleByDip = Math.max(openingDip + purchase - closingDip, 0);
      lastClosing = closingDip;
      const variance = actualSale - saleByDip;
      cumVariance += variance;
      const tva =
        capacityL != null && Number.isFinite(closingDip)
          ? Math.max(0, capacityL - closingDip)
          : null;
      lastTva = tva;

      totalPurchase += purchase;
      totalShortage += shortage;
      totalTesting += testing;
      totalMeter += saleMeter;
      totalActual += actualSale;

      const rate = Number(row[rateField] ?? 0);

      return `<tr>
        <td>${formatNumericDate(row.date)}</td>
        <td class="num">${formatNumberPlain(openingDip)}</td>
        <td class="num">${formatNumberPlain(purchase)}</td>
        <td class="num">${formatNumberPlain(shortage)}</td>
        <td class="num">${formatNumberPlain(bookTotal)}</td>
        <td class="num">${formatNumberPlain(testing)}</td>
        <td class="num">${formatNumberPlain(saleMeter)}</td>
        <td class="num">${formatNumberPlain(actualSale)}</td>
        <td class="num">${formatNumberPlain(cumSale)}</td>
        <td class="num">${formatNumberPlain(saleByDip)}</td>
        <td class="num">${formatNumberPlain(closingDip)}</td>
        <td class="num">${formatNumberPlain(variance)}</td>
        <td class="num">${formatNumberPlain(cumVariance)}</td>
        <td class="num">${formatNumberPlain(rate)}</td>
        <td class="num">${tva == null ? "—" : formatNumberPlain(tva)}</td>
      </tr>`;
    })
    .join("");

  const productLabel = product === "diesel" ? "Diesel" : "Petrol";

  return `
    <section class="report-tank-section report-tank-section--${product}">
      <h3 class="report-tank-title">Tank: ${escapeHtml(tankLabel)} · ${escapeHtml(capacity)} · ${escapeHtml(productLabel)}</h3>
      <table class="report-table report-dsr-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" class="num" title="Opening dip (L)">Open</th>
            <th scope="col" class="num" title="Purchase / receipts (L)">Buy</th>
            <th scope="col" class="num" title="Physical shortage (L): max(0, book − dip)">Short</th>
            <th scope="col" class="num" title="Book total = open + buy − short (L)">Total</th>
            <th scope="col" class="num" title="Testing (L)">Test</th>
            <th scope="col" class="num" title="Sale by meter (L)">Meter</th>
            <th scope="col" class="num" title="Actual sale (L)">Actual</th>
            <th scope="col" class="num" title="Cumulative sale (L)">Cum</th>
            <th scope="col" class="num" title="Sale by dip (L)">Dip</th>
            <th scope="col" class="num" title="Closing dip (L)">Close</th>
            <th scope="col" class="num" title="Variance = actual − sale by dip (L)">Var</th>
            <th scope="col" class="num" title="Cumulative variance (L)">CumV</th>
            <th scope="col" class="num" title="Selling rate (₹/L)">Rate</th>
            <th scope="col" class="num" title="Tank volume available = capacity − closing dip (L)">TVA</th>
          </tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="15" class="muted">No entries</td></tr>`}</tbody>
        <tfoot>
          <tr class="report-total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(totalPurchase)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalShortage)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(totalTesting)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalMeter)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totalActual)}</strong></td>
            <td></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(lastClosing)}</strong></td>
            <td></td>
            <td class="num"><strong>${formatNumberPlain(cumVariance)}</strong></td>
            <td></td>
            <td class="num"><strong>${lastTva == null ? "—" : formatNumberPlain(lastTva)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </section>`;
}

function renderTankWiseDsr(data, range) {
  const merged = DsrQueries.mergeDsrStock(data.dsrRows, data.stockRows);
  const tanks = PumpSettings.getCachedSync().reports?.tanks || AppConfig.DEFAULT_REPORT_TANKS;

  let sections = reportHeader("Tank-wise DSR report", range.start, range.end);
  let any = false;
  tanks.forEach((tank) => {
    const rows = merged.filter((r) => normalizeProduct(r.product) === tank.product);
    if (!rows.length) return;
    any = true;
    const rateField = tank.product === "petrol" ? "petrol_rate" : "diesel_rate";
    sections += buildTankDsrSection(tank.product, tank.label, tank.capacity, rows, rateField);
  });
  if (!any) {
    sections += `<p class="muted">No meter readings in this period. Enter data on Meter Reading.</p>`;
  } else {
    sections += `<p class="report-note muted">One section per physical tank (HSD and MS). Short = max(0, book − dip); Total = open + buy − short; Actual = meter − testing; Var = actual − sale by dip (open + buy − close); TVA = tank capacity − closing dip.</p>`;
  }
  return sections;
}

/** Per-product Fuel Income metrics for one DSR day. */
function fuelIncomeMetrics(row, buyingCtx) {
  if (!row) {
    return { litres: 0, saleRate: 0, buyRate: null, income: null, missingBuy: false };
  }
  const litres = getDsrNetSaleLitres(row);
  const saleRate = getDsrSaleRate(row);
  const buyRate = getEffectiveBuyingRate(row, buyingCtx);
  const missingBuy = litres > 0 && buyRate == null;
  const income =
    buyRate != null && litres > 0 ? litres * (saleRate - buyRate) : null;
  return { litres, saleRate, buyRate, income, missingBuy };
}

function formatFuelIncomeCell(value, { empty = "—" } = {}) {
  if (value == null || !Number.isFinite(value)) return empty;
  return formatNumberPlain(value);
}

function renderFuelIncome(data, range) {
  const buyingContext = createBuyingRateContext(data.receiptRows);
  const byDate = new Map();

  (data.dsrRows ?? []).forEach((row) => {
    const date = row.date;
    if (!date) return;
    if (!byDate.has(date)) byDate.set(date, { petrol: null, diesel: null });
    const product = normalizeProduct(row.product);
    if (product === "petrol" || product === "diesel") {
      byDate.get(date)[product] = row;
    }
  });

  const dates = [...byDate.keys()].sort();
  let totalPetrolL = 0;
  let totalDieselL = 0;
  let totalPetrolInc = 0;
  let totalDieselInc = 0;
  let missingBuyDays = 0;

  const bodyRows = dates
    .map((date) => {
      const day = byDate.get(date);
      const petrol = fuelIncomeMetrics(day.petrol, buyingContext);
      const diesel = fuelIncomeMetrics(day.diesel, buyingContext);
      if (petrol.missingBuy || diesel.missingBuy) missingBuyDays += 1;

      totalPetrolL += petrol.litres;
      totalDieselL += diesel.litres;
      if (petrol.income != null) totalPetrolInc += petrol.income;
      if (diesel.income != null) totalDieselInc += diesel.income;

      const dayIncome =
        (petrol.income != null ? petrol.income : 0) + (diesel.income != null ? diesel.income : 0);
      const dayIncomeDisplay =
        petrol.income == null && diesel.income == null && (petrol.litres > 0 || diesel.litres > 0)
          ? "—"
          : formatNumberPlain(dayIncome);

      return `<tr>
        <td>${formatNumericDate(date)}</td>
        <td class="num">${formatFuelIncomeCell(petrol.litres || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(petrol.saleRate || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(petrol.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(petrol.income)}</td>
        <td class="num">${formatFuelIncomeCell(diesel.litres || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(diesel.saleRate || null, { empty: "" })}</td>
        <td class="num">${formatFuelIncomeCell(diesel.buyRate)}</td>
        <td class="num">${formatFuelIncomeCell(diesel.income)}</td>
        <td class="num"><strong>${dayIncomeDisplay}</strong></td>
      </tr>`;
    })
    .join("");

  const totalIncome = totalPetrolInc + totalDieselInc;
  const missingNote =
    missingBuyDays > 0
      ? `<p class="report-note warning">${missingBuyDays} day(s) have sale litres but no landed buying rate — P.Rate / P.Income blank for those products. Enter buying price on Meter Reading → Purchase cost for receipt days.</p>`
      : "";

  return `
    ${reportHeader("Fuel Sale Income Report", range.start, range.end)}
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
          <th scope="col" class="num" title="Selling rate ₹/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate ₹/L">P.Rate</th>
          <th scope="col" class="num" title="Margin ₹">P.Income</th>
          <th scope="col" class="num" title="Net sale litres">Sale (L)</th>
          <th scope="col" class="num" title="Selling rate ₹/L">Sale Rate</th>
          <th scope="col" class="num" title="Landed buying rate ₹/L">P.Rate</th>
          <th scope="col" class="num" title="Margin ₹">P.Income</th>
        </tr>
      </thead>
      <tbody>${
        bodyRows ||
        `<tr><td colspan="10" class="muted">No meter readings in this period.</td></tr>`
      }</tbody>
      <tfoot>
        <tr class="report-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalPetrolL)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(totalPetrolInc)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalDieselL)}</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${formatNumberPlain(totalDieselInc)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalIncome)}</strong></td>
        </tr>
      </tfoot>
    </table>
    ${missingNote}
    <p class="report-note muted">P.Income = net litres (meter − testing) × (selling rate − landed buying rate incl. VAT + delivery + LFR). Same fuel-margin basis as Analysis and Reports P&amp;L.</p>`;
}

function productFuelLabel(product) {
  const p = normalizeProduct(product);
  if (p === "petrol") return "MS";
  if (p === "diesel") return "HSD";
  return product || "—";
}

function shiftReportLabel(key) {
  const cfg = PumpSettings.getShiftConfig?.() || {};
  if (key === "morning") return cfg.morningName || "Morning";
  if (key === "afternoon") return cfg.afternoonName || "Afternoon";
  return key || "—";
}

function renderPumpSalesReport(data, range) {
  const br = data.meterBreakdown;
  const shiftRows = br?.by_pump || [];
  const dailyRows = br?.daily_pump || [];

  const shiftKeys = new Set(
    shiftRows.map((r) => `${r.reading_date}|${normalizeProduct(r.product)}|${r.pump_no}`)
  );
  const fallback = (dailyRows || []).flatMap((r) => {
    const date = r.date || r.reading_date;
    const product = normalizeProduct(r.product);
    const out = [];
    for (const pumpNo of [1, 2]) {
      const key = `${date}|${product}|${pumpNo}`;
      if (shiftKeys.has(key)) continue;
      out.push({
        reading_date: date,
        shift: null,
        product,
        pump_no: pumpNo,
        litres: pumpNo === 1 ? Number(r.sales_pump1) || 0 : Number(r.sales_pump2) || 0,
        net_litres: null,
        from_daily: true,
      });
    }
    return out;
  });

  const merged = [...shiftRows, ...fallback].sort((a, b) => {
    const d = String(b.reading_date).localeCompare(String(a.reading_date));
    if (d) return d;
    const s = String(a.shift || "").localeCompare(String(b.shift || ""));
    if (s) return s;
    const p = String(a.product).localeCompare(String(b.product));
    if (p) return p;
    return (a.pump_no || 0) - (b.pump_no || 0);
  });

  let total = 0;
  const body = merged
    .map((r) => {
      total += Number(r.litres) || 0;
      return `<tr>
          <td>${formatNumericDate(r.reading_date)}</td>
          <td>${r.from_daily ? "Daily" : escapeHtml(shiftReportLabel(r.shift))}</td>
          <td>${formatFuelBadge(productFuelLabel(r.product))}</td>
          <td>Pump ${escapeHtml(String(r.pump_no))}</td>
          <td class="num">${formatNumberPlain(r.litres)}</td>
          <td class="num">${r.net_litres == null ? "—" : formatNumberPlain(r.net_litres)}</td>
        </tr>`;
    })
    .join("");

  if (!body) {
    return `${reportHeader("Pump-wise sales", range.start, range.end)}
      <p class="muted">No pump sales in this period.</p>
      <p class="muted">Enter meters on <a href="meter-reading.html">Meter Reading</a> or shift nozzle assignments.</p>`;
  }

  return `
    ${reportHeader("Pump-wise sales", range.start, range.end)}
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
      <tbody>${body}</tbody>
      <tfoot>
        <tr>
          <td colspan="4"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(total)}</strong></td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
}

function renderShiftSalesReport(data, range) {
  const rows = data.meterBreakdown?.by_shift || [];
  if (!rows.length) {
    return `${reportHeader("Shift-wise sales", range.start, range.end)}
      <p class="muted">No shift register entries in this period.</p>
      <p class="muted">Enter data under <a href="meter-reading.html#shift-readings">Meter Reading → Shift register</a>.</p>`;
  }

  let total = 0;
  const body = rows
    .map((r) => {
      total += Number(r.litres) || 0;
      return `<tr>
        <td>${formatNumericDate(r.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(r.shift))}</td>
        <td>${formatFuelBadge(productFuelLabel(r.product))}</td>
        <td class="num">${formatNumberPlain(r.litres)}</td>
        <td class="num">${formatNumberPlain(r.net_litres)}</td>
        <td class="num">${r.staff_count ?? "—"}</td>
      </tr>`;
    })
    .join("");

  return `
    ${reportHeader("Shift-wise sales", range.start, range.end)}
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
      <tbody>${body}</tbody>
      <tfoot>
        <tr>
          <td colspan="3"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(total)}</strong></td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>`;
}

function renderSalesmanSalesReport(data, range) {
  const rows = data.meterBreakdown?.by_salesman || [];
  if (!rows.length) {
    return `${reportHeader("Salesman sales", range.start, range.end)}
      <p class="muted">No salesman assignments in this period.</p>
      <p class="muted">Assign staff to nozzles under <a href="meter-reading.html#shift-readings">Shift register</a>.</p>`;
  }

  const rateByDate = new Map();
  (data.dsrRows || []).forEach((r) => {
    const cur = rateByDate.get(r.date) || { petrol: 0, diesel: 0 };
    const p = normalizeProduct(r.product);
    if (p === "petrol") cur.petrol = Number(r.petrol_rate) || cur.petrol;
    if (p === "diesel") cur.diesel = Number(r.diesel_rate) || cur.diesel;
    rateByDate.set(r.date, cur);
  });

  let totL = 0;
  let totExpected = 0;
  let totCashHard = 0;
  let totPhonePay = 0;
  let totCredit = 0;
  let totExpense = 0;
  let totCash = 0;
  let totShort = 0;
  let hasExpected = false;

  const body = rows
    .map((r) => {
      const rates = rateByDate.get(r.reading_date) || {};
      const petrolNet =
        r.petrol_net_litres != null ? Number(r.petrol_net_litres) : Number(r.petrol_litres) || 0;
      const dieselNet =
        r.diesel_net_litres != null ? Number(r.diesel_net_litres) : Number(r.diesel_litres) || 0;
      const expected = petrolNet * (rates.petrol || 0) + dieselNet * (rates.diesel || 0);
      const cash = Number(r.cash_collected) || 0;
      const phonePay = Number(r.phone_pay) || 0;
      const credit = Number(r.credit_amount) || 0;
      const expense = Number(r.expense_amount) || 0;
      const collected =
        r.total_collected != null
          ? Number(r.total_collected) || 0
          : cash + phonePay + credit + expense;
      const canExpect = rates.petrol || rates.diesel;
      if (canExpect) {
        hasExpected = true;
        totExpected += expected;
        totShort += expected - collected;
      }
      totL += Number(r.total_litres) || 0;
      totCashHard += cash;
      totPhonePay += phonePay;
      totCredit += credit;
      totExpense += expense;
      totCash += collected;
      return `<tr>
        <td>${formatNumericDate(r.reading_date)}</td>
        <td>${escapeHtml(shiftReportLabel(r.shift))}</td>
        <td>${escapeHtml(r.employee_name || "Staff")}</td>
        <td class="num">${formatNumberPlain(r.petrol_litres)}</td>
        <td class="num">${formatNumberPlain(r.diesel_litres)}</td>
        <td class="num">${formatNumberPlain(r.total_litres)}</td>
        <td class="num">${canExpect ? formatNumberPlain(expected) : "—"}</td>
        <td class="num">${formatNumberPlain(cash)}</td>
        <td class="num">${formatNumberPlain(phonePay)}</td>
        <td class="num">${formatNumberPlain(credit)}</td>
        <td class="num">${formatNumberPlain(expense)}</td>
        <td class="num">${formatNumberPlain(collected)}</td>
        <td class="num">${canExpect ? formatNumberPlain(expected - collected) : "—"}</td>
      </tr>`;
    })
    .join("");

  return `
    ${reportHeader("Salesman sales", range.start, range.end)}
    <p class="muted report-note">Short = expected − (cash + phone + credit + expenses). Expected = net litres (sale − testing) × daily selling rates.</p>
    <table class="report-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Shift</th>
          <th>Salesman</th>
          <th class="num">MS (L)</th>
          <th class="num">HSD (L)</th>
          <th class="num">Total (L)</th>
          <th class="num">Expected ₹</th>
          <th class="num">Cash ₹</th>
          <th class="num">Phone ₹</th>
          <th class="num">Credit ₹</th>
          <th class="num">Exp ₹</th>
          <th class="num">Total ₹</th>
          <th class="num">Short ₹</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot>
        <tr>
          <td colspan="5"><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totL)}</strong></td>
          <td class="num"><strong>${hasExpected ? formatNumberPlain(totExpected) : "—"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totCashHard)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totPhonePay)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totCredit)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totExpense)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totCash)}</strong></td>
          <td class="num"><strong>${hasExpected ? formatNumberPlain(totShort) : "—"}</strong></td>
        </tr>
      </tfoot>
    </table>`;
}
