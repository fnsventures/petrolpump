import assert from "node:assert/strict";
import test from "node:test";
import { monthBounds, previousMonth, redundantMonthFolders } from "../scripts/lib/backup-retention.mjs";

test("1 November archives October, and January closes the previous year", () => {
  assert.equal(previousMonth("2026-11-01"), "2026-10");
  assert.equal(previousMonth("2027-01-01"), "2026-12");
  assert.deepEqual(monthBounds("2026-10"), { start: "2026-10-01", end: "2026-11-01" });
  assert.equal(previousMonth("2026-01-01"), "2025-12");
});

test("drops a year only after that year has a full backup", () => {
  const months = ["2025-11", "2025-12", "2026-01", "2026-06", "2026-12", "2027-01"];
  const decision = redundantMonthFolders(months, ["2026"]);
  assert.deepEqual(decision.drop, ["2026-01", "2026-06", "2026-12"]);
  assert.deepEqual(decision.keep, ["2025-11", "2025-12", "2027-01"]);
});

test("keeps every month folder when no year is closed", () => {
  const decision = redundantMonthFolders(["2026-01", "2026-10"], []);
  assert.deepEqual(decision.keep, ["2026-01", "2026-10"]);
  assert.deepEqual(decision.drop, []);
});

test("ignores names that are not month folders", () => {
  const decision = redundantMonthFolders(["notes", "2026-13", "2026-10"], ["2026"]);
  assert.deepEqual(decision.drop, ["2026-10"]);
  assert.deepEqual(decision.keep, []);
});
