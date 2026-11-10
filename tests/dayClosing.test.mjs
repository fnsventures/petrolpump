import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function math() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/dayClosingMath.js"]);
  return sandbox;
}

test("today's short matches the day-closing formula", () => {
  const { computeDayClosingShort } = math();
  assert.equal(
    computeDayClosingShort({
      totalSale: 100000,
      collection: 5000,
      shortPrevious: 200,
      nightCash: 80000,
      phonePay: 15000,
      creditToday: 7000,
      expensesToday: 2500,
    }),
    700
  );
  assert.equal(
    computeDayClosingShort({
      totalSale: 1000,
      nightCash: 1200,
    }),
    -200
  );
});

test("open shift credit subtracts same-day settlement and falls back when both parts are empty", () => {
  const { computeOpenShiftCredit } = math();
  assert.equal(computeOpenShiftCredit(200, 50, 0), 150);
  assert.equal(computeOpenShiftCredit(10, 80, 5), 0);
  assert.equal(computeOpenShiftCredit(0, 0, 40), 40);
  assert.equal(computeOpenShiftCredit("bad", null, 12), 12);
});
