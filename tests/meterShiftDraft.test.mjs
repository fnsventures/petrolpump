import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function shift() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/meterShiftReading.js"]);
  return sandbox.MeterShiftReading;
}

test("a date or shift change does not store the visible meters under the new shift", () => {
  const { draftCaptureKey } = shift();
  const visible = { date: "2026-10-18", shift: "morning" };
  assert.equal(draftCaptureKey(visible, "shift-meter-shift"), null);
  assert.equal(draftCaptureKey(visible, "shift-meter-date"), null);
  assert.equal(
    draftCaptureKey(visible, "shift-close-petrol-p1-n1"),
    "bpf.meterDraft.v2.2026-10-18.morning"
  );
  assert.equal(draftCaptureKey({ date: "", shift: "" }, "shift-close-petrol-p1-n1"), null);
});

test("saved nozzle readings stay on screen instead of suggested meters", () => {
  const { resolveNozzleInputs } = shift();
  const saved = resolveNozzleInputs(
    { opening_meter: 1500, closing_meter: 1800, employee_id: "emp-1" },
    9999
  );
  assert.equal(saved.opening, "1500");
  assert.equal(saved.closing, "1800");
  assert.equal(saved.employeeId, "emp-1");

  const blank = resolveNozzleInputs(null, 1500);
  assert.equal(blank.opening, "1500");
  assert.equal(blank.closing, "");
  assert.equal(blank.employeeId, "");

  const savedZero = resolveNozzleInputs(
    { opening_meter: 0, closing_meter: 0, employee_id: "emp-1" },
    1500
  );
  assert.equal(savedZero.opening, "0");
  assert.equal(savedZero.closing, "0");
});
