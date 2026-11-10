import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

const config = {
  lossOfPayEnabled: true,
  paidLeaveDaysPerMonth: 2,
  overDutyEnabled: true,
  dayRateBasis: "calendar",
  fixedDaysInMonth: 30,
};

function payroll() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/payrollRules.js"]);
  return sandbox.PayrollRules;
}

test("February pay deducts leave past the allowance and half-days, and adds over duty", () => {
  const pay = payroll().computeMonthPay(
    28000,
    [
      { date: "2026-02-02", status: "leave" },
      { date: "2026-02-03", status: "leave" },
      { date: "2026-02-04", status: "absent" },
      { date: "2026-02-05", status: "half_day" },
      { date: "2026-02-06", status: "present", over_duty: true },
      { date: "2026-02-07", status: "present", over_duty: false },
    ],
    "2026-02",
    config
  );
  assert.equal(pay.calendarDays, 28);
  assert.equal(pay.perDay, 1000);
  assert.equal(pay.counts.leave, 3);
  assert.equal(pay.excessLeave, 1);
  assert.equal(pay.halfLopDays, 0.5);
  assert.equal(pay.lopDays, 1.5);
  assert.equal(pay.lopAmount, 1500);
  assert.equal(pay.overDutyDays, 1);
  assert.equal(pay.overDutyAmount, 1000);
});

test("take-home caps employee PF so net pay is never negative", () => {
  const rules = payroll();
  const settled = rules.settleTakeHome(28000, 1500, 1000, 1800);
  assert.equal(settled.earnings, 29000);
  assert.equal(settled.beforePf, 27500);
  assert.equal(settled.employeePf, 1800);
  assert.equal(settled.net, 25700);

  const capped = rules.settleTakeHome(1000, 800, 0, 5000);
  assert.equal(capped.employeePf, 200);
  assert.equal(capped.net, 0);
});

test("an admin exclusion removes the calculated loss of pay from payable salary", () => {
  const rules = payroll();
  const pay = rules.computeMonthPay(28000, [{ date: "2026-02-04", status: "leave" }, { date: "2026-02-05", status: "leave" }, { date: "2026-02-06", status: "leave" }], "2026-02", config);
  const excluded = rules.applyLopExclusion(pay, true);
  assert.equal(pay.lopAmount, 1000);
  assert.equal(excluded.lopAmount, 0);
  assert.equal(excluded.suggestedLopAmount, 1000);
  assert.equal(excluded.lopExcluded, true);
});
