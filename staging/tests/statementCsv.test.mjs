import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

// Arrays built inside the vm sandbox have another realm's prototype; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

function csv() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/statementCsv.js"]);
  const api = sandbox.StatementCsv;
  return { ...api, parseCsv: (t) => plain(api.parseCsv(t)), mapStatementRows: (r, m) => plain(api.mapStatementRows(r, m)) };
}

test("parseCsv handles quotes, escaped quotes, CRLF and semicolons", () => {
  const { parseCsv } = csv();
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(parseCsv("d;amt\n01/10/2026;1.234,00\n"), [["d", "amt"], ["01/10/2026", "1.234,00"]]);
  assert.deepEqual(parseCsv("﻿a,b\n\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("findHeaderRow skips bank account preamble", () => {
  const { parseCsv, findHeaderRow } = csv();
  const rows = parseCsv("Account,1234\nBranch,Main\nTxn Date,Description,Credit,Ref No\n01/10/2026,UPI,500,U1");
  assert.equal(findHeaderRow(rows), 2);
});

test("parseStatementDate supports dmy, mdy, ymd and month names", () => {
  const { parseStatementDate } = csv();
  assert.equal(parseStatementDate("05/10/2026"), "2026-10-05");
  assert.equal(parseStatementDate("05/10/2026", "mdy"), "2026-05-10");
  assert.equal(parseStatementDate("2026-10-05 13:45:00", "dmy"), "2026-10-05");
  assert.equal(parseStatementDate("5-Oct-26"), "2026-10-05");
  assert.equal(parseStatementDate("31/02/2026"), null);
  assert.equal(parseStatementDate("garbage"), null);
});

test("parseStatementAmount strips currency, Indian grouping and debit markers", () => {
  const { parseStatementAmount } = csv();
  assert.equal(parseStatementAmount("₹1,23,456.50"), 123456.5);
  assert.equal(parseStatementAmount("500.00 Cr"), 500);
  assert.equal(parseStatementAmount("500 Dr"), -500);
  assert.equal(parseStatementAmount("(75)"), -75);
  assert.equal(parseStatementAmount(""), null);
});

test("mapStatementRows keeps positive credits and counts the rest as skipped", () => {
  const { mapStatementRows, guessColumns } = csv();
  const header = ["Txn Date", "Narration", "Debit", "Credit", "UTR"];
  const map = { ...guessColumns(header), dateOrder: "dmy" };
  assert.deepEqual(plain({ date: map.date, amount: map.amount, reference: map.reference, description: map.description }),
    { date: 0, amount: 3, reference: 4, description: 1 });
  const out = mapStatementRows(
    [
      ["01/10/2026", "UPI/abc", "", "1,200.00", "U1"],
      ["01/10/2026", "ATM", "500", "", ""],
      ["bad", "x", "", "10", ""],
    ],
    map
  );
  assert.equal(out.skipped, 2);
  assert.deepEqual(out.lines, [
    { date: "2026-10-01", amount: 1200, reference: "U1", description: "UPI/abc" },
  ]);
});
