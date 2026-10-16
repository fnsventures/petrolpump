import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function dates() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/utils.js"]);
  return sandbox;
}

test("addDaysToDateString moves one calendar day across month ends", () => {
  const { addDaysToDateString } = dates();
  assert.equal(addDaysToDateString("2026-10-10", 1), "2026-10-11");
  assert.equal(addDaysToDateString("2026-10-10", -1), "2026-10-09");
  assert.equal(addDaysToDateString("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysToDateString("2024-02-28", 1), "2024-02-29");
  assert.equal(addDaysToDateString("2026-12-31", 1), "2027-01-01");
});

test("addMonthsToMonthValue moves one month across year ends", () => {
  const { addMonthsToMonthValue } = dates();
  assert.equal(addMonthsToMonthValue("2026-10", 1), "2026-11");
  assert.equal(addMonthsToMonthValue("2026-10", -1), "2026-09");
  assert.equal(addMonthsToMonthValue("2026-01", -1), "2025-12");
  assert.equal(addMonthsToMonthValue("2026-12", 1), "2027-01");
});
