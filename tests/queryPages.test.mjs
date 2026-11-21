import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function sandboxWithRows(rows) {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/queryPages.js"]);
  sandbox.fakeQuery = (allRows) => () => ({
    range(from, to) {
      return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
    },
  });
  sandbox.rows = rows;
  return sandbox;
}

test("fetchAllRows pages past 1000 rows", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
  const sandbox = sandboxWithRows(rows);
  const result = await sandbox.fetchAllRows(sandbox.fakeQuery(rows), { pageSize: 1000 });
  assert.equal(result.error, null);
  assert.equal(result.truncated, false);
  assert.equal(result.data.length, 2500);
  assert.equal(result.data[0].id, 0);
  assert.equal(result.data[2499].id, 2499);
});

test("fetchAllRows stops on a short page", async () => {
  const rows = [{ id: 1 }, { id: 2 }];
  const sandbox = sandboxWithRows(rows);
  const result = await sandbox.fetchAllRows(sandbox.fakeQuery(rows), { pageSize: 1000 });
  assert.equal(result.data.length, 2);
  assert.equal(result.truncated, false);
});

test("fetchAllRows reports a truncated result instead of a silent short list", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
  const sandbox = sandboxWithRows(rows);
  const result = await sandbox.fetchAllRows(sandbox.fakeQuery(rows), { pageSize: 10, maxRows: 25 });
  assert.equal(result.data, null);
  assert.equal(result.truncated, true);
  assert.match(result.error.message, /Narrow the dates/);
});

test("fetchAllByIds merges id chunks", async () => {
  const rows = [
    { invoice_id: "a", amount: 1 },
    { invoice_id: "b", amount: 2 },
    { invoice_id: "a", amount: 3 },
  ];
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/queryPages.js"]);
  const result = await sandbox.fetchAllByIds(
    () => ({
      in(_column, ids) {
        return {
          range(from, to) {
            const matched = rows.filter((row) => ids.includes(row.invoice_id));
            return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
          },
        };
      },
    }),
    ["a", "b"],
    "invoice_id",
    { chunkSize: 1, pageSize: 10 }
  );
  assert.equal(result.error, null);
  assert.equal(result.data.length, 3);
});
