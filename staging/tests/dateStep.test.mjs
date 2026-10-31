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

test("resolveDateRange last-month is the previous calendar month", () => {
  const { resolveDateRange } = dates();
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(prev.getFullYear(), prev.getMonth() + 1, 0);
  const pad = (n) => String(n).padStart(2, "0");
  const range = resolveDateRange("last-month");
  assert.equal(range.modeInfo.mode, "last-month");
  assert.equal(range.start, `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-01`);
  assert.equal(range.end, `${lastDay.getFullYear()}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}`);
});

test("entry dates from an earlier day open on today", () => {
  const { persistedDateIfCurrent } = dates();
  assert.equal(
    persistedDateIfCurrent({ range: "date", start: "2026-10-18", savedOn: "2026-10-18" }, "2026-10-21"),
    null
  );
  assert.equal(
    persistedDateIfCurrent({ range: "date", start: "2026-10-20", savedOn: "2026-10-21" }, "2026-10-21"),
    "2026-10-20"
  );
  assert.equal(persistedDateIfCurrent({ range: "date", start: "2026-10-21" }, "2026-10-21"), null);
  assert.equal(persistedDateIfCurrent(null, "2026-10-21"), null);
});

test("login return path stays inside the app", () => {
  const { safeAppReturnPath } = dates();
  assert.equal(safeAppReturnPath("meter-reading.html?date=2026-10-21#shift"), "meter-reading.html?date=2026-10-21#shift");
  assert.equal(safeAppReturnPath("login.html"), "");
  assert.equal(safeAppReturnPath("https://evil.example/dashboard.html"), "");
  assert.equal(safeAppReturnPath("//evil.example/dashboard.html"), "");
  assert.equal(safeAppReturnPath("../dashboard.html"), "");
});

test("addMonthsToMonthValue moves one month across year ends", () => {
  const { addMonthsToMonthValue } = dates();
  assert.equal(addMonthsToMonthValue("2026-10", 1), "2026-11");
  assert.equal(addMonthsToMonthValue("2026-10", -1), "2026-09");
  assert.equal(addMonthsToMonthValue("2026-01", -1), "2025-12");
  assert.equal(addMonthsToMonthValue("2026-12", 1), "2027-01");
});
