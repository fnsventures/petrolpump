import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function taxSandbox(purchaseTaxInclusive = false) {
  const sandbox = createSandbox({
    PumpSettings: {
      getCachedSync() {
        return { reports: { purchaseTaxInclusive } };
      },
    },
    AppConfig: { DEFAULT_REPORTS: { purchaseTaxInclusive: false } },
  });
  loadScripts(sandbox, ["js/appConfig.js", "js/purchaseTaxUtils.js", "js/reportsGst.js"]);
  return sandbox;
}

test("pre-VAT purchase line adds delivery then VAT", () => {
  const { calcPurchaseLineTax } = taxSandbox();
  const line = calcPurchaseLineTax(1000, 90, 18, { storedPreVat: true, deliveryPerKl: 600 });
  assert.equal(line.taxable, 90000);
  assert.equal(line.delivery, 600);
  assert.equal(line.tax, 16308);
  assert.equal(line.gross, 106908);
  assert.equal(line.cgst, 8154);
  assert.equal(line.sgst, 8154);
});

test("tax-inclusive purchase line backs out VAT", () => {
  const { calcPurchaseLineTax } = taxSandbox(true);
  const line = calcPurchaseLineTax(10, 118, 18, { storedPreVat: false });
  assert.equal(Math.round(line.taxable), 1000);
  assert.equal(Math.round(line.tax), 180);
  assert.equal(line.gross, 1180);
});

test("GST slabs and an intra-state invoice split CGST and SGST", () => {
  const sandbox = taxSandbox();
  sandbox.PumpSettings.getStationGstin = () => "21AAAAA0000A1Z5";
  assert.equal(sandbox.classifyGstSlab(0), "nil");
  assert.equal(sandbox.classifyGstSlab(18), "r18");
  assert.equal(sandbox.classifyGstSlab(7), "r18");

  const invoice = {
    id: "inv-1",
    party_gstin: "21BBBBB0000B1Z5",
    total_amount: 118,
    cgst_total: 0,
    sgst_total: 0,
    igst_total: 0,
  };
  const place = sandbox.aggregateInvoiceGstByPlace(
    [invoice],
    [{ invoice_id: "inv-1", amount: 118, gst_percent: 18 }]
  );
  assert.ok(Math.abs(place.inside.r18.taxable - 100) < 0.001);
  assert.ok(Math.abs(place.inside.r18.cgst - 9) < 0.001);
  assert.ok(Math.abs(place.inside.r18.sgst - 9) < 0.001);
  assert.equal(place.outside.r18.igst, 0);
});

test("a party GSTIN from another state is IGST", () => {
  const sandbox = taxSandbox();
  sandbox.PumpSettings.getStationGstin = () => "21AAAAA0000A1Z5";
  const place = sandbox.aggregateInvoiceGstByPlace(
    [
      {
        id: "inv-2",
        party_gstin: "27CCCCC0000C1Z5",
        total_amount: 118,
        cgst_total: 0,
        sgst_total: 0,
        igst_total: 0,
      },
    ],
    [{ invoice_id: "inv-2", amount: 118, gst_percent: 18 }]
  );
  assert.ok(Math.abs(place.outside.r18.igst - 18) < 0.001);
  assert.equal(place.inside.r18.cgst, 0);
});
