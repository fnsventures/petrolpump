/* global PumpSettings, AppConfig, formatMonthLabel, normalizeProduct, computeFuelRowMargin, GST_SLABS, escapeHtml, formatNumberPlain, formatNumericDate, formatCurrency, formatBuyingRatePerKl, fuelRowClass, getPetrolPurchaseVatPct, getDieselPurchaseVatPct, getPurchaseTaxPct, getPurchaseGstSummaryNote, getPurchaseGstDetailNote, calcPurchaseLineTax, createBuyingRateContext, resolveStoredBuyingRate, getEffectiveBuyingRate, getLandedBuyingRateForDate, reportHeader */
/**
 * GST sales and purchase reports: slab totals, fuel NIL lines, inward VAT.
 * Loaded before reports.js. Functions stay global.
 */


function getFuelGstPct() {
  return Number(PumpSettings.getCachedSync().reports?.fuelGstPct) || AppConfig.DEFAULT_REPORTS.fuelGstPct;
}

function isBillingIncludedInGstReports() {
  const billing = PumpSettings.getCachedSync().billing || {};
  const reports = PumpSettings.getCachedSync().reports || {};
  if (typeof billing.includeInGstReports === "boolean") return billing.includeInGstReports;
  if (typeof reports.includeBillingInGst === "boolean") return reports.includeBillingInGst;
  return AppConfig.DEFAULT_BILLING.includeInGstReports !== false;
}

/** Outward supply of MS/HSD is nil-rated (no CGST/SGST on fuel sales). */
const FUEL_OUTWARD_GST_PCT = 0;

/**
 * Daily fuel sale value: net litres × that day's selling rate.
 * @returns {{ litres: number, gross: number }}
 */
function calcDailyFuelSale(row) {
  const { revenue, litres } = computeFuelRowMargin(row, null);
  return { litres, gross: revenue };
}

/**
 * Aggregate net fuel sales by calendar month and product.
 * Each DSR day uses its own selling price before rolling up to the month.
 * @returns {Map<string, { petrol: { litres: number, gross: number }, diesel: { litres: number, gross: number } }>}
 */
function aggregateFuelSalesByMonth(dsrRows, range) {
  const months = new Map();
  (dsrRows ?? []).forEach((row) => {
    if (row.date < range.start || row.date > range.end) return;
    const product = normalizeProduct(row.product);
    if (product !== "petrol" && product !== "diesel") return;

    const { litres, gross } = calcDailyFuelSale(row);
    if (litres <= 0 && gross <= 0) return;

    const monthKey = row.date.slice(0, 7);
    if (!months.has(monthKey)) {
      months.set(monthKey, {
        petrol: { litres: 0, gross: 0 },
        diesel: { litres: 0, gross: 0 },
      });
    }
    const bucket = months.get(monthKey)[product];
    bucket.litres += litres;
    bucket.gross += gross;
  });
  return months;
}

/** Flat month × product lines (nil GST), sorted by month then product. */
function buildFuelSalesMonthLines(dsrRows, range) {
  const gstPct = FUEL_OUTWARD_GST_PCT;
  const slabKey = classifyGstSlab(gstPct);
  const lines = [];

  [...aggregateFuelSalesByMonth(dsrRows, range).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([monthKey, data]) => {
      ["petrol", "diesel"].forEach((product) => {
        const { litres, gross } = data[product];
        if (litres <= 0 && gross <= 0) return;
        lines.push({
          monthKey,
          monthLabel: formatMonthLabel(monthKey),
          product,
          productLabel: product === "petrol" ? "Petrol (MS)" : "Diesel (HSD)",
          litres,
          gstPct,
          slabKey,
          taxable: 0,
          cgst: 0,
          sgst: 0,
          gross,
          nilValue: gross,
        });
      });
    });

  return lines;
}

/**
 * Daily fuel outward invoices for GST detail (SFC-style).
 * One NIL-rated voucher per product per day with sale — MS tank then HSD tank.
 * Numbers are sequential within the selected report range (SFC/0001 …).
 */
function buildFuelSalesDailyInvoices(dsrRows, range) {
  const gstPct = FUEL_OUTWARD_GST_PCT;
  const slabKey = classifyGstSlab(gstPct);
  const productOrder = { petrol: 0, diesel: 1 };

  const daily = (dsrRows ?? [])
    .filter((row) => row.date >= range.start && row.date <= range.end)
    .map((row) => {
      const product = normalizeProduct(row.product);
      if (product !== "petrol" && product !== "diesel") return null;
      const { litres, gross } = calcDailyFuelSale(row);
      if (litres <= 0 && gross <= 0) return null;
      return {
        date: row.date,
        product,
        productLabel: product === "petrol" ? "Petrol (MS)" : "Diesel (HSD)",
        litres,
        gross,
        nilValue: gross,
        gstPct,
        slabKey,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        partyName: "Cash A/c",
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (productOrder[a.product] ?? 9) - (productOrder[b.product] ?? 9)
    );

  return daily.map((line, index) => ({
    ...line,
    invoiceNumber: `SFC/${String(index + 1).padStart(4, "0")}`,
  }));
}

function sumFuelSalesLines(lines) {
  return lines.reduce(
    (acc, line) => ({
      litres: acc.litres + line.litres,
      taxable: acc.taxable + line.taxable,
      cgst: acc.cgst + line.cgst,
      sgst: acc.sgst + line.sgst,
      gross: acc.gross + line.gross,
    }),
    { litres: 0, taxable: 0, cgst: 0, sgst: 0, gross: 0 }
  );
}

function mergeSlabTotals(base, addition) {
  const out = {};
  GST_SLABS.forEach((s) => {
    const b = base[s.key] || emptySlabBucket();
    const a = addition[s.key] || emptySlabBucket();
    out[s.key] = {
      taxable: b.taxable + a.taxable,
      cgst: b.cgst + a.cgst,
      sgst: b.sgst + a.sgst,
      igst: (b.igst || 0) + (a.igst || 0),
      gross: b.gross + a.gross,
    };
  });
  return out;
}

function emptySlabBucket() {
  return { taxable: 0, cgst: 0, sgst: 0, igst: 0, gross: 0 };
}

function emptySlabTotals() {
  const slabTotals = {};
  GST_SLABS.forEach((s) => {
    slabTotals[s.key] = emptySlabBucket();
  });
  return slabTotals;
}

function fuelSalesToSlabTotals(lines) {
  const slabTotals = emptySlabTotals();
  lines.forEach((line) => {
    const key = line.slabKey || classifyGstSlab(line.gstPct);
    if (!slabTotals[key]) return;
    const nilValue = Number(line.nilValue ?? line.gross ?? 0);
    if (key === "nil") {
      slabTotals[key].taxable += nilValue;
      slabTotals[key].gross += nilValue;
    } else {
      slabTotals[key].taxable += line.taxable;
      slabTotals[key].cgst += line.cgst;
      slabTotals[key].sgst += line.sgst;
      slabTotals[key].igst += Number(line.igst || 0);
      slabTotals[key].gross += line.gross;
    }
  });
  return slabTotals;
}

/** First two chars of GSTIN = Indian state code. */
function gstinStateCode(gstin) {
  const g = String(gstin || "")
    .trim()
    .toUpperCase();
  return g.length >= 2 ? g.slice(0, 2) : "";
}

function getStationGstinStateCode() {
  return gstinStateCode(typeof PumpSettings !== "undefined" ? PumpSettings.getStationGstin() : "");
}

/** True when party GSTIN state differs from station GSTIN state. Missing party GSTIN → intra-state. */
function isInterstatePartyGstin(partyGstin) {
  const partyState = gstinStateCode(partyGstin);
  const stationState = getStationGstinStateCode();
  if (!partyState || !stationState) return false;
  return partyState !== stationState;
}

function getFuelSupplierLabel() {
  return PumpSettings.getCachedSync().reports?.fuelSupplierLabel || AppConfig.DEFAULT_REPORTS.fuelSupplierLabel;
}

function getFuelSupplierGstin() {
  const fromSettings = PumpSettings.getCachedSync().reports?.fuelSupplierGstin;
  if (fromSettings != null && String(fromSettings).trim()) return String(fromSettings).trim().toUpperCase();
  return AppConfig.DEFAULT_REPORTS.fuelSupplierGstin || "";
}

/** Prefer receipt-row GSTIN, else Settings default. */
function resolveSupplierGstin(rowGstin) {
  const fromRow = rowGstin != null ? String(rowGstin).trim() : "";
  if (fromRow) return fromRow.toUpperCase();
  return getFuelSupplierGstin();
}

function classifyGstSlab(pct) {
  const n = Number(pct);
  if (n < 0) return "non_gst";
  if (n === 0) return "nil";
  if (n === 5) return "r5";
  if (n === 12) return "r12";
  if (n === 18) return "r18";
  if (n === 24) return "r24";
  if (n === 28) return "r28";
  return "r18";
}

function slabHasActivity(totals) {
  if (!totals) return false;
  return (
    Math.abs(Number(totals.taxable ?? 0)) > 0.005 ||
    Math.abs(Number(totals.gross ?? 0)) > 0.005
  );
}

/** Sum line-item amounts into taxable / non-GST / NIL buckets. */
function sumInvoiceLineAmounts(items) {
  let taxable = 0;
  let nonGst = 0;
  let nilRate = 0;
  items.forEach((item) => {
    const amt = Number(item.amount ?? 0);
    const pct = Number(item.gst_percent ?? 0);
    if (pct > 0) {
      taxable += amt / (1 + pct / 100);
    } else if (pct === 0) {
      nilRate += amt;
    } else {
      nonGst += amt;
    }
  });
  return { taxable, nonGst, nilRate };
}

/** Taxable value from invoice header when line items are missing. */
function invoiceHeaderTaxable(inv) {
  const cgst = Number(inv.cgst_total ?? 0);
  const sgst = Number(inv.sgst_total ?? 0);
  const igst = Number(inv.igst_total ?? 0);
  const nonGst = Number(inv.non_gst_total ?? 0);
  const nilRate = Number(inv.nil_rate_total ?? 0);
  const gross = Number(inv.total_amount ?? 0);
  const derived = gross - cgst - sgst - igst - nonGst - nilRate;
  if (Number.isFinite(derived) && derived >= 0) return derived;
  const sub = Number(inv.subtotal ?? 0) - Number(inv.discount ?? 0);
  return Number.isFinite(sub) && sub >= 0 ? sub : 0;
}

/**
 * Aggregate billing invoices into GST slabs.
 * When an invoice has IGST, tax is treated as interstate (igst bucket); otherwise CGST+SGST.
 */
function aggregateInvoiceGst(invoices, invoiceItems) {
  return aggregateInvoiceGstByPlace(invoices, invoiceItems).combined;
}

/** Split billing GST into inside-state (CGST+SGST) vs outside-state (IGST). */
function aggregateInvoiceGstByPlace(invoices, invoiceItems) {
  const itemsByInvoice = new Map();
  invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const inside = emptySlabTotals();
  const outside = emptySlabTotals();

  const addTo = (target, key, { taxable = 0, cgst = 0, sgst = 0, igst = 0, gross = 0 }) => {
    if (!target[key]) return;
    target[key].taxable += taxable;
    target[key].cgst += cgst;
    target[key].sgst += sgst;
    target[key].igst += igst;
    target[key].gross += gross;
  };

  invoices.forEach((inv) => {
    const items = itemsByInvoice.get(inv.id) || [];
    const headerIgst = Number(inv.igst_total ?? 0);
    const headerCgst = Number(inv.cgst_total ?? 0);
    const headerSgst = Number(inv.sgst_total ?? 0);
    const interstate =
      headerIgst > 0 || (headerCgst + headerSgst <= 0 && isInterstatePartyGstin(inv.party_gstin));
    const target = interstate ? outside : inside;

    if (items.length) {
      items.forEach((item) => {
        const amt = Number(item.amount ?? 0);
        const pct = Number(item.gst_percent ?? 0);
        const key = classifyGstSlab(pct);
        if (pct > 0) {
          const taxable = amt / (1 + pct / 100);
          const gst = amt - taxable;
          if (interstate) {
            addTo(target, key, { taxable, igst: gst, gross: amt });
          } else {
            addTo(target, key, { taxable, cgst: gst / 2, sgst: gst / 2, gross: amt });
          }
        } else if (pct === 0) {
          addTo(target, "nil", { taxable: amt, gross: amt });
        } else {
          addTo(target, "non_gst", { taxable: amt, gross: amt });
        }
      });
    } else {
      const nonGst = Number(inv.non_gst_total ?? 0);
      const nilRate = Number(inv.nil_rate_total ?? 0);
      const gross = Number(inv.total_amount ?? 0);
      const taxable = invoiceHeaderTaxable(inv);

      if (headerCgst > 0 || headerSgst > 0 || headerIgst > 0) {
        const key = classifyGstSlab(18);
        if (interstate) {
          addTo(target, key, {
            taxable,
            igst: headerIgst > 0 ? headerIgst : headerCgst + headerSgst,
            gross: taxable + headerCgst + headerSgst + headerIgst,
          });
        } else {
          addTo(target, key, {
            taxable,
            cgst: headerCgst,
            sgst: headerSgst,
            gross: taxable + headerCgst + headerSgst + headerIgst,
          });
        }
      } else if (nilRate > 0) {
        addTo(target, "nil", { taxable: nilRate, gross: nilRate });
      } else if (nonGst > 0) {
        addTo(target, "non_gst", { taxable: nonGst, gross: nonGst });
      } else if (gross > 0) {
        addTo(target, "non_gst", { taxable: gross, gross });
      }
    }
  });

  return {
    inside,
    outside,
    combined: mergeSlabTotals(inside, outside),
  };
}

function renderGstSummaryTable(slabTotals, title, range, inward, options = {}) {
  const {
    sectionOnly = false,
    sectionTitle = title,
    place = "inside", // inside | outside | all
    showIgst = place === "outside" || place === "all",
  } = options;
  const activeSlabs = GST_SLABS.filter((s) => slabHasActivity(slabTotals[s.key]));
  const rows = activeSlabs
    .map((s) => {
      const t = slabTotals[s.key] || emptySlabBucket();
      const lineTax = t.cgst + t.sgst;
      if (place === "outside") {
        return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${formatNumberPlain(t.igst || 0)}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
      }
      if (inward) {
        return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${formatNumberPlain(lineTax)}</td>
      <td class="num">${showIgst ? formatNumberPlain(t.igst || 0) : "—"}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
      }
      return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${formatNumberPlain(t.taxable)}</td>
      <td class="num">${formatNumberPlain(t.cgst)}</td>
      <td class="num">${formatNumberPlain(t.sgst)}</td>
      <td class="num">${showIgst ? formatNumberPlain(t.igst || 0) : "—"}</td>
      <td class="num">${formatNumberPlain(t.gross)}</td>
    </tr>`;
    })
    .join("");

  const totalTaxable = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.taxable || 0), 0);
  const totalCgst = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.cgst || 0), 0);
  const totalSgst = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.sgst || 0), 0);
  const totalIgst = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.igst || 0), 0);
  const totalVat = totalCgst + totalSgst;
  const totalGross = GST_SLABS.reduce((s, x) => s + (slabTotals[x.key]?.gross || 0), 0);

  let headCols;
  let footCols;
  let colSpanEmpty;
  if (place === "outside") {
    headCols = `<th>Slab</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">Total</th>`;
    footCols = `<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalIgst)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>`;
    colSpanEmpty = 4;
  } else if (inward) {
    headCols = `<th>Slab</th><th class="num">Taxable</th><th class="num">VAT/LST</th><th class="num">${showIgst ? "IGST" : "—"}</th><th class="num">Total</th>`;
    footCols = `<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalVat)}</strong></td>
          <td class="num"><strong>${showIgst ? formatNumberPlain(totalIgst) : "—"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>`;
    colSpanEmpty = 5;
  } else {
    headCols = `<th>Slab</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">${showIgst ? "IGST" : "—"}</th><th class="num">Total</th>`;
    footCols = `<td><strong>Total</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalTaxable)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalCgst)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalSgst)}</strong></td>
          <td class="num"><strong>${showIgst ? formatNumberPlain(totalIgst) : "—"}</strong></td>
          <td class="num"><strong>${formatNumberPlain(totalGross)}</strong></td>`;
    colSpanEmpty = 6;
  }

  const placeLabel =
    place === "outside"
      ? "Outside state (IGST)"
      : place === "all"
        ? inward
          ? "Combined inward supply"
          : "Combined outward supply"
        : inward
          ? "Inside state inward supply"
          : "Inside state outward supply (CGST + SGST)";
  const subtitle = inward
    ? `${placeLabel} · ${escapeHtml(getPurchaseTaxPctLabel())} · ${
        isPurchaseTaxInclusive() ? "tax-inclusive rate" : "pre-tax rate (BPCL)"
      }`
    : placeLabel;

  const lead = sectionOnly
    ? `<section class="report-gst-section"><h3 class="report-section-title">${escapeHtml(sectionTitle)}</h3>`
    : reportHeader(title, range.start, range.end);
  const tail = sectionOnly ? "</section>" : "";

  const taxSummaryBits = inward
    ? `VAT/LST: <strong>${formatNumberPlain(totalVat)}</strong>${
        showIgst ? ` · IGST: <strong>${formatNumberPlain(totalIgst)}</strong>` : ""
      }`
    : `CGST: <strong>${formatNumberPlain(totalCgst)}</strong> · SGST: <strong>${formatNumberPlain(
        totalSgst
      )}</strong>${showIgst ? ` · IGST: <strong>${formatNumberPlain(totalIgst)}</strong>` : ""}`;

  return `
    ${lead}
    <p class="report-subtitle${sectionOnly ? " muted" : ""}">${subtitle}</p>
    <table class="report-table report-gst-summary">
      <thead>
        <tr>${headCols}</tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="${colSpanEmpty}" class="muted">No transactions in this period</td></tr>`}</tbody>
      <tfoot>
        <tr class="report-total-row">
          ${footCols}
        </tr>
      </tfoot>
    </table>
    <p class="report-summary-line">Taxable: <strong>${formatNumberPlain(totalTaxable)}</strong> · ${taxSummaryBits} · Gross: <strong>${formatNumberPlain(totalGross)}</strong></p>${tail}`;
}

function slabTotalsHaveActivity(slabTotals) {
  return GST_SLABS.some((s) => slabHasActivity(slabTotals[s.key]));
}

function renderFuelSalesMonthTable(lines, title) {
  const rows = lines
    .map(
      (line) => `<tr class="${fuelRowClass(line.product)}">
        <td>${escapeHtml(line.monthLabel)}</td>
        <td>${escapeHtml(line.productLabel)}</td>
        <td class="num">${formatNumberPlain(line.litres)}</td>
        <td class="num">${formatNumberPlain(line.nilValue ?? line.gross)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${formatNumberPlain(line.gross)}</td>
      </tr>`
    )
    .join("");
  const totals = sumFuelSalesLines(lines);

  return `
    <section class="report-gst-section">
      <h3 class="report-section-title">${escapeHtml(title)}</h3>
      <p class="report-subtitle muted">Outward fuel supply · NIL rate · Value = daily qty (L) × that day&apos;s selling price from DSR</p>
      <table class="report-table report-gst-fuel-month">
        <thead>
          <tr>
            <th>Month</th>
            <th>Product</th>
            <th class="num">Qty (L)</th>
            <th class="num">Nil value</th>
            <th class="num">CGST</th>
            <th class="num">SGST</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="7" class="muted">No fuel sales in this period</td></tr>`}</tbody>
        ${
          lines.length
            ? `<tfoot>
          <tr class="report-total-row">
            <td colspan="2"><strong>Fuel total</strong></td>
            <td class="num"><strong>${formatNumberPlain(totals.litres)}</strong></td>
            <td class="num"><strong>${formatNumberPlain(totals.gross)}</strong></td>
            <td class="num"><strong>—</strong></td>
            <td class="num"><strong>—</strong></td>
            <td class="num"><strong>${formatNumberPlain(totals.gross)}</strong></td>
          </tr>
        </tfoot>`
            : ""
        }
      </table>
    </section>`;
}

function renderGstSalesSummary(data, range) {
  const includeBilling = isBillingIncludedInGstReports();
  const fuelLines = buildFuelSalesMonthLines(data.dsrRows, range);
  const fuelSlabs = fuelSalesToSlabTotals(fuelLines);
  const billingSlabs = includeBilling ? aggregateInvoiceGst(data.invoices, data.invoiceItems) : null;
  const combinedSlabs = billingSlabs ? mergeSlabTotals(fuelSlabs, billingSlabs) : fuelSlabs;

  const fuelSection = renderFuelSalesMonthTable(fuelLines, "Fuel sales — month-wise");
  const billingSection = includeBilling
    ? renderGstSummaryTable(billingSlabs, "Billing — GST slab summary", range, false, {
        sectionOnly: true,
        sectionTitle: "Billing — GST slab summary",
      })
    : `<p class="report-note muted">Billing invoices are excluded (enable in Settings → Billing → Include billing in GST sales reports).</p>`;
  const grandTotal = renderGstSummaryTable(
    combinedSlabs,
    "Combined outward supply — GST summary",
    range,
    false,
    { sectionOnly: true, sectionTitle: "Combined outward supply — GST summary" }
  );

  return `
    ${reportHeader("Outward supply — GST summary", range.start, range.end)}
    ${fuelSection}
    ${billingSection}
    ${grandTotal}`;
}

function renderGstSalesDetail(data, range) {
  const includeBilling = isBillingIncludedInGstReports();
  const fuelInvoices = buildFuelSalesDailyInvoices(data.dsrRows, range);

  const fuelEntries = fuelInvoices.map((line) => ({
    sortDate: line.date,
    sortKey: `0-${line.invoiceNumber}`,
    html: `<tr class="${fuelRowClass(line.product)}">
        <td>${formatNumericDate(line.date)}</td>
        <td>Fuel · ${escapeHtml(line.productLabel)}</td>
        <td>${escapeHtml(line.invoiceNumber)} · ${escapeHtml(line.partyName)}</td>
        <td>—</td>
        <td class="num">${formatNumberPlain(line.litres)}</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${formatNumberPlain(line.nilValue ?? line.gross)}</td>
        <td class="num">${formatNumberPlain(line.gross)}</td>
      </tr>`,
  }));

  const itemsByInvoice = new Map();
  data.invoiceItems.forEach((item) => {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  });

  const billingEntries = includeBilling
    ? data.invoices.map((inv) => {
        const items = itemsByInvoice.get(inv.id) || [];
        const cgst = Number(inv.cgst_total ?? 0);
        const sgst = Number(inv.sgst_total ?? 0);
        const igst = Number(inv.igst_total ?? 0);
        const hasGst = cgst + sgst + igst > 0;
        const gstin = (inv.party_gstin || "").trim().toUpperCase() || "—";

        let taxable = 0;
        let nonGst = 0;
        let nilRate = 0;

        if (items.length) {
          const sums = sumInvoiceLineAmounts(items);
          taxable = sums.taxable;
          nonGst = sums.nonGst;
          nilRate = sums.nilRate;
        } else {
          nonGst = Number(inv.non_gst_total ?? 0);
          nilRate = Number(inv.nil_rate_total ?? 0);
          taxable = invoiceHeaderTaxable(inv);
        }

        return {
          sortDate: inv.invoice_date,
          sortKey: `1-${inv.invoice_number}`,
          html: `<tr class="report-billing-row">
        <td>${formatNumericDate(inv.invoice_date)}</td>
        <td>Billing</td>
        <td>${escapeHtml(inv.invoice_number)} · ${escapeHtml(inv.party_name)}</td>
        <td>${escapeHtml(gstin)}</td>
        <td class="num">—</td>
        <td class="num">${hasGst || taxable > 0 ? formatNumberPlain(taxable) : "—"}</td>
        <td class="num">${formatNumberPlain(cgst)}</td>
        <td class="num">${formatNumberPlain(sgst)}</td>
        <td class="num">${formatNumberPlain(igst)}</td>
        <td class="num">${formatNumberPlain(nonGst + nilRate)}</td>
        <td class="num">${formatNumberPlain(inv.total_amount)}</td>
      </tr>`,
        };
      })
    : [];

  const bodyRows = [...fuelEntries, ...billingEntries]
    .sort(
      (a, b) => a.sortDate.localeCompare(b.sortDate) || a.sortKey.localeCompare(b.sortKey)
    )
    .map((e) => e.html)
    .join("");

  const fuelTotals = sumFuelSalesLines(fuelInvoices);
  const hasFuel = fuelInvoices.length > 0;
  const hasBilling = includeBilling && data.invoices.length > 0;
  const emptyMessage =
    !hasFuel && !hasBilling
      ? `<tr><td colspan="11" class="muted">${
          includeBilling ? "No fuel sales or billing in this period" : "No fuel sales in this period"
        }</td></tr>`
      : "";

  const billingNote = includeBilling
    ? ""
    : `<p class="report-note muted">Billing invoices are excluded (enable in Settings → Billing).</p>`;

  return `
    ${reportHeader("Outward supply — GST detail register", range.start, range.end)}
    <p class="report-subtitle muted">Fuel days as NIL invoices (SFC/####) — one voucher per tank sale day (MS, HSD). Value = net litres × that day&apos;s selling rate. Billing rows show party GSTIN and IGST when interstate.</p>
    ${billingNote}
    <table class="report-table report-gst-detail">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Invoice / Party</th>
          <th>GSTIN</th>
          <th class="num">Qty (L)</th>
          <th class="num">Taxable</th>
          <th class="num">CGST</th>
          <th class="num">SGST</th>
          <th class="num">IGST</th>
          <th class="num">Exempt / NIL</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
        ${emptyMessage}
      </tbody>
      ${
        hasFuel
          ? `<tfoot>
        <tr class="report-total-row">
          <td colspan="4"><strong>Fuel total (${fuelInvoices.length} SFC)</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.litres)}</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>—</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.gross)}</strong></td>
          <td class="num"><strong>${formatNumberPlain(fuelTotals.gross)}</strong></td>
        </tr>
      </tfoot>`
          : ""
      }
    </table>`;
}

/**
 * Collect fuel receipt lines in range with a resolvable pre-VAT buying rate.
 * GST inward reports apply VAT + delivery via calcPurchaseLineTax.
 * P&L landed cost also adds LFR (separate GST invoice; not in fuel VAT lines).
 * Margin/P&amp;L/trading use getEffectiveBuyingRate instead (landed rate directly).
 */
function collectFuelPurchaseLines(data, range, getStored) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  const resolveStored = getStored ?? createBuyingRateContext(data.receiptRows ?? []).getStored;
  const vaultDocs = data.vaultPurchases ?? [];
  const vaultById = new Map(vaultDocs.map((d) => [d.id, d]));
  const vaultByExactTitle = new Map();
  vaultDocs.forEach((d) => {
    const key = String(d.title || "")
      .trim()
      .toLowerCase();
    if (key && !vaultByExactTitle.has(key)) vaultByExactTitle.set(key, d);
  });
  const lines = [];
  const seen = new Set();

  const matchVaultDoc = (meta) => {
    if (meta.invoiceDocumentId && vaultById.has(meta.invoiceDocumentId)) {
      return vaultById.get(meta.invoiceDocumentId);
    }
    const invNo = String(meta.supplierInvoiceNo || "")
      .trim()
      .toLowerCase();
    if (!invNo) return null;
    if (vaultByExactTitle.has(invNo)) return vaultByExactTitle.get(invNo);
    return vaultDocs.find((d) => String(d.title || "").toLowerCase().includes(invNo)) || null;
  };

  const addLine = (date, product, litres, rate, meta = {}) => {
    const l = Number(litres);
    const rt = Number(rate);
    if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(rt) || rt <= 0) return;
    const key = `${date}-${normalizeProduct(product)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const vault = matchVaultDoc(meta);
    lines.push({
      date,
      product,
      litres: l,
      rate: rt,
      deliveryPerKl: meta.deliveryPerKl ?? null,
      supplierInvoiceNo: meta.supplierInvoiceNo || vault?.title || "",
      supplierGstin: meta.supplierGstin || "",
      invoiceDocumentId: meta.invoiceDocumentId || vault?.id || null,
    });
  };

  (data.receiptRows ?? []).filter(inRange).forEach((r) => {
    addLine(r.date, r.product, Number(r.receipts ?? 0), Number(r.buying_price_per_litre), {
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierGstin: r.supplier_gstin,
      invoiceDocumentId: r.invoice_document_id,
      deliveryPerKl: r.purchase_delivery_per_kl,
    });
  });

  (data.dsrRows ?? []).filter(inRange).forEach((r) => {
    const litres = Number(r.receipts ?? 0);
    if (litres <= 0) return;
    // GST purchase register requires an entered rate on the receipt day (no provisional carry-forward).
    const ownRate = Number(r.buying_price_per_litre);
    if (!Number.isFinite(ownRate) || ownRate <= 0) return;
    addLine(r.date, r.product, litres, ownRate, {
      supplierInvoiceNo: r.supplier_invoice_no,
      supplierGstin: r.supplier_gstin,
      invoiceDocumentId: r.invoice_document_id,
      deliveryPerKl: r.purchase_delivery_per_kl,
    });
  });

  return lines.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      normalizeProduct(a.product).localeCompare(normalizeProduct(b.product))
  );
}

function countReceiptsMissingBuying(data, range) {
  const inRange = (r) => r.date >= range.start && r.date <= range.end;
  return (data.dsrRows ?? []).filter((r) => {
    if (!inRange(r) || Number(r.receipts ?? 0) <= 0) return false;
    const rate = Number(r.buying_price_per_litre);
    return !Number.isFinite(rate) || rate <= 0;
  }).length;
}

function buildFuelPurchaseRows(data, range) {
  const getStored = createBuyingRateContext(data.receiptRows ?? []).getStored;
  const purchaseLines = collectFuelPurchaseLines(data, range, getStored);
  const missingBuyingCount = countReceiptsMissingBuying(data, range);
  const insideSlabs = emptySlabTotals();
  const outsideSlabs = emptySlabTotals();

  const detailRows = purchaseLines.map(
    ({
      date,
      product,
      litres,
      rate,
      deliveryPerKl,
      supplierInvoiceNo,
      supplierGstin,
      invoiceDocumentId,
    }) => {
    const taxPct = getPurchaseTaxPct(product);
    const slabKey = classifyGstSlab(taxPct);
    const { taxable, tax, gross, cgst, sgst } = calcPurchaseLineTax(litres, rate, taxPct, {
      product,
      date,
      deliveryPerKl,
    });
    const gstin = resolveSupplierGstin(supplierGstin);
    const interstate = isInterstatePartyGstin(gstin);
    const target = interstate ? outsideSlabs : insideSlabs;

    if (target[slabKey]) {
      target[slabKey].taxable += taxable;
      if (interstate) {
        target[slabKey].igst += tax;
      } else {
        target[slabKey].cgst += cgst;
        target[slabKey].sgst += sgst;
      }
      target[slabKey].gross += gross;
    }

    return {
      date,
      product,
      litres,
      rate,
      taxPct,
      taxable,
      tax,
      gross,
      cgst: interstate ? 0 : cgst,
      sgst: interstate ? 0 : sgst,
      igst: interstate ? tax : 0,
      interstate,
      supplierInvoiceNo: supplierInvoiceNo || "",
      supplierGstin: gstin,
      invoiceDocumentId: invoiceDocumentId || null,
    };
  });

  return {
    detailRows,
    insideSlabs,
    outsideSlabs,
    slabTotals: mergeSlabTotals(insideSlabs, outsideSlabs),
    missingBuyingCount,
  };
}

function renderGstPurchaseSummary(data, range) {
  const { insideSlabs, outsideSlabs, slabTotals, detailRows, missingBuyingCount } =
    getFuelPurchaseRows(data, range);
  const missingNote =
    missingBuyingCount > 0
      ? `<p class="report-note warning">${missingBuyingCount} receipt(s) in this period have no buying price — excluded. Enter buying price on Meter Reading → Purchase cost.</p>`
      : "";
  const emptyNote =
    detailRows.length === 0
      ? `<p class="report-note muted">No fuel receipts with buying price in this period.</p>`
      : "";

  const insideSection = renderGstSummaryTable(insideSlabs, "Inside state", range, true, {
    sectionOnly: true,
    sectionTitle: "Inside state inward supply",
    place: "inside",
    showIgst: false,
  });
  const outsideSection = slabTotalsHaveActivity(outsideSlabs)
    ? renderGstSummaryTable(outsideSlabs, "Outside state", range, true, {
        sectionOnly: true,
        sectionTitle: "Outside state inward supply",
        place: "outside",
        showIgst: true,
      })
    : `<section class="report-gst-section"><h3 class="report-section-title">Outside state inward supply</h3><p class="muted">No interstate inward supply in this period (supplier GSTIN state matches station, or GSTIN blank).</p></section>`;
  const combined = renderGstSummaryTable(slabTotals, "Combined", range, true, {
    sectionOnly: true,
    sectionTitle: "Total inward supply summary",
    place: "all",
    showIgst: true,
  });

  return `
    ${reportHeader("Inward supply — GST summary (Fuel receipts)", range.start, range.end)}
    ${emptyNote}
    ${insideSection}
    ${outsideSection}
    ${combined}
    ${missingNote}
    <p class="report-note muted">${escapeHtml(getPurchaseGstSummaryNote())} Place of supply uses supplier GSTIN vs station GSTIN.</p>`;
}

function renderGstPurchaseDetail(data, range) {
  const { detailRows, missingBuyingCount } = getFuelPurchaseRows(data, range);

  const rows = detailRows
    .map(
      (r) => {
        const prod = normalizeProduct(r.product);
        const ref = prod === "petrol" ? "MS" : prod === "diesel" ? "HSD" : String(r.product).toUpperCase();
        const invNo = r.supplierInvoiceNo ? escapeHtml(r.supplierInvoiceNo) : "—";
        const gstin = r.supplierGstin ? escapeHtml(r.supplierGstin) : "—";
        const vaultCell = r.invoiceDocumentId
          ? `<button type="button" class="link" data-vault-document="${escapeHtml(r.invoiceDocumentId)}">View PDF</button>`
          : "—";
        return `<tr class="${fuelRowClass(prod)}">
      <td>${formatNumericDate(r.date)}</td>
      <td>${formatFuelBadge(ref)}</td>
      <td>${escapeHtml(getFuelSupplierLabel())}</td>
      <td>${invNo}</td>
      <td>${gstin}</td>
      <td class="num">${vaultCell}</td>
      <td class="num">${formatNumberPlain(r.litres)}</td>
      <td class="num">${formatBuyingRatePerKl(r.rate)}</td>
      <td class="num">${formatNumberPlain(r.taxable)}</td>
      <td class="num">${r.taxPct}%</td>
      <td class="num">${formatNumberPlain(r.tax)}</td>
      <td class="num">${formatNumberPlain(r.gross)}</td>
    </tr>`;
      }
    )
    .join("");

  return `
    ${reportHeader("Inward supply — GST detail (Fuel receipts)", range.start, range.end)}
    <table class="report-table report-gst-detail report-gst-detail--purchase">
      <thead>
        <tr>
          <th>Date</th>
          <th>Prod</th>
          <th>Party</th>
          <th>Invoice No</th>
          <th>GSTIN</th>
          <th>Vault</th>
          <th class="num">Qty (L)</th>
          <th class="num">Rate (${escapeHtml(getBuyingPriceUnitLabel())})</th>
          <th class="num">Taxable</th>
          <th class="num">VAT%</th>
          <th class="num">VAT</th>
          <th class="num">Gross</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="12" class="muted">No receipts with buying price in period</td></tr>`}</tbody>
    </table>
    ${
      missingBuyingCount > 0
        ? `<p class="report-note warning">${missingBuyingCount} receipt(s) excluded — buying price not set on Meter Reading → Purchase cost.</p>`
        : ""
    }
    <p class="report-note muted">Vault PDF links match DSR receipt → Invoices (purchase) by document id or invoice title. Enter invoice no with buying price on Meter Reading → Purchase cost. ${escapeHtml(getPurchaseGstDetailNote())}</p>`;
}
