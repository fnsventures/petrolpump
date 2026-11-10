import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function money() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/utils.js"]);
  return sandbox;
}

test("formatMoneyInput rounds float dust to a 0.01 step", () => {
  const { formatMoneyInput } = money();
  assert.equal(formatMoneyInput(1234.5600000001), "1234.56");
  assert.equal(formatMoneyInput(10.005), "10.01");
  assert.equal(formatMoneyInput(1234.567), "1234.57");
  assert.equal(formatMoneyInput(99.1), "99.10");
  assert.equal(formatMoneyInput(0), "0.00");
  assert.equal(formatMoneyInput(Number.NaN), "");

  const value = formatMoneyInput(1234.5600000001);
  const cents = Number(value) * 100;
  assert.equal(Math.abs(cents - Math.round(cents)) < 1e-8, true);
});
