import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function gstrSandbox() {
  const sandbox = createSandbox({
    PumpSettings: {
      getCachedSync() {
        return {
          reports: { fuelGstPct: 0 },
          billing: { includeInGstReports: true },
          station: { gstin: "21AAAAA0000A1Z5" },
        };
      },
      getStationGstin() {
        return "21AAAAA0000A1Z5";
      },
    },
    AppConfig: {
      DEFAULT_REPORTS: { fuelGstPct: 0 },
      DEFAULT_BILLING: { includeInGstReports: true },
    },
    normalizeProduct(product) {
      return String(product || "").toLowerCase();
    },
    computeFuelRowMargin(row) {
      const litres = Number(row.total_sales) || 0;
      const rate = Number(row.petrol_rate || row.diesel_rate) || 0;
      return { litres, revenue: litres * rate };
    },
    formatMonthLabel(key) {
      return key;
    },
  });
  loadScripts(sandbox, ["js/appConfig.js", "js/reportsGst.js", "js/reportsGstr1.js", "js/reportsGstr3b.js"]);
  sandbox.getGstr1Sections = (data, range) => sandbox.buildGstr1Sections(data, range);
  sandbox.getFuelPurchaseRows = () => ({
    detailRows: [{ cgst: 90, sgst: 90, igst: 0 }],
    missingBuyingCount: 1,
  });
  return sandbox;
}

const range = { start: "2026-04-01", end: "2026-04-30" };

function sampleData() {
  return {
    dsrRows: [{ date: "2026-04-02", product: "petrol", total_sales: 10, petrol_rate: 100 }],
    invoices: [
      {
        invoice_date: "2026-04-03",
        invoice_number: "B-1",
        party_name: "Registered Oils",
        party_gstin: "21BBBBB0000B1Z5",
        total_amount: 118,
        cgst_total: 9,
        sgst_total: 9,
        igst_total: 0,
        non_gst_total: 0,
        nil_rate_total: 0,
      },
      {
        invoice_date: "2026-04-04",
        invoice_number: "C-1",
        party_name: "Cash counter",
        party_gstin: "",
        total_amount: 236,
        cgst_total: 0,
        sgst_total: 0,
        igst_total: 36,
        non_gst_total: 0,
        nil_rate_total: 0,
      },
    ],
  };
}

test("GSTR-1 splits fuel NIL, B2B, and B2CS", () => {
  const sandbox = gstrSandbox();
  const sections = sandbox.buildGstr1Sections(sampleData(), range);
  assert.equal(sections.nilRows.length, 1);
  assert.equal(sections.nilRows[0].invoiceNumber, "SFC/0001");
  assert.equal(sections.nilRows[0].nilValue, 1000);
  assert.equal(sections.b2b.length, 1);
  assert.equal(sections.b2b[0].taxable, 100);
  assert.equal(sections.b2cs.length, 1);
  assert.equal(sections.b2cs[0].igst, 36);
  assert.equal(sandbox.gstr1InvoiceRate(sections.b2b[0]), 18);
  assert.equal(sandbox.gstr1FilingPeriod(range), "042026");
});

test("GSTR-1 JSON groups B2B by GSTIN and rates B2CS", () => {
  const sandbox = gstrSandbox();
  const json = sandbox.buildGstr1Json(sampleData(), range);
  assert.equal(json.fp, "042026");
  assert.equal(json.gstin, "21AAAAA0000A1Z5");
  assert.equal(json.b2b.length, 1);
  assert.equal(json.b2b[0].ctin, "21BBBBB0000B1Z5");
  assert.equal(json.b2b[0].inv[0].itms[0].itm_det.rt, 18);
  assert.equal(json.b2b[0].inv[0].itms[0].itm_det.camt, 9);
  assert.equal(json.b2cs[0].sply_ty, "INTER");
  assert.equal(json.b2cs[0].iamt, 36);
  assert.equal(json.nil.inv[0].nil_amt, 1000);
});

test("GSTR-3B outward tax and fuel ITC come from the same registers", () => {
  const sandbox = gstrSandbox();
  const summary = sandbox.buildGstr3bSummary(sampleData(), range);
  assert.equal(summary.osupDet.txval, 300);
  assert.equal(summary.osupDet.camt, 9);
  assert.equal(summary.osupDet.samt, 9);
  assert.equal(summary.osupDet.iamt, 36);
  assert.equal(summary.osupNil.txval, 1000);
  assert.equal(summary.interUnregIgst, 36);
  assert.equal(summary.itcOth.camt, 90);
  assert.equal(summary.itcOth.samt, 90);
  assert.equal(summary.purchaseMissingBuying, 1);
  assert.equal(summary.retPeriod, "042026");
});
