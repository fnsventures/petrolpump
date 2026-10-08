/**
 * Month folders on Drive, and which of them to keep.
 *
 * Month folders stay until that calendar year has a full backup in Yearly/YYYY.
 * After that full copy exists, the twelve month folders are redundant and are dropped.
 */

const MONTH_NAME = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** @param {string} todayIso YYYY-MM-DD */
export function previousMonth(todayIso) {
  assertDate(todayIso);
  return formatMonth(monthIndex(todayIso.slice(0, 7)) - 1);
}

/** @param {string} monthName YYYY-MM @returns {{ start: string, end: string }} start inclusive, end exclusive */
export function monthBounds(monthName) {
  if (!MONTH_NAME.test(monthName)) {
    throw new Error(`month must be YYYY-MM, got ${monthName}`);
  }
  return {
    start: `${monthName}-01`,
    end: `${formatMonth(monthIndex(monthName) + 1)}-01`,
  };
}

/**
 * Month folders whose calendar year already has a full backup.
 * @param {string[]} monthNames folder names such as "2026-10"
 * @param {string[]} completedYears years that have Drive Yearly/YYYY, such as ["2026"]
 * @returns {{ keep: string[], drop: string[] }}
 */
export function redundantMonthFolders(monthNames, completedYears) {
  const done = new Set(
    (completedYears ?? []).map((year) => String(year).trim()).filter((year) => /^\d{4}$/.test(year)),
  );
  const present = [...new Set(monthNames.filter((name) => MONTH_NAME.test(name)))].sort();
  return {
    keep: present.filter((name) => !done.has(name.slice(0, 4))),
    drop: present.filter((name) => done.has(name.slice(0, 4))),
  };
}

function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`today must be YYYY-MM-DD, got ${value}`);
  }
}

function monthIndex(name) {
  const match = MONTH_NAME.exec(name);
  if (!match) throw new Error(`not a month folder: ${name}`);
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

function formatMonth(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`missing ${flag}`);
  }
  return process.argv[index + 1];
}

if (process.argv[1]?.endsWith("backup-retention.mjs")) {
  const months = argValue("--months")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const years = (process.argv.includes("--completed-years") ? argValue("--completed-years") : "")
    .split(",")
    .map((year) => year.trim())
    .filter(Boolean);
  const decision = redundantMonthFolders(months, years);
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
