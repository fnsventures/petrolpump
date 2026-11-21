import test from "node:test";
import assert from "node:assert/strict";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function appError() {
  const sandbox = createSandbox({
    addEventListener() {},
    removeEventListener() {},
  });
  loadScripts(sandbox, ["js/errorHandler.js"]);
  return sandbox.AppError;
}

test("application server messages are shown unchanged", () => {
  const AppError = appError();
  assert.equal(
    AppError.getUserMessage({ message: "Access denied: Admin role required", code: "P0001" }),
    "Access denied: Admin role required"
  );
  assert.equal(
    AppError.getUserMessage({ message: "Closing reading is below opening.", code: "23514" }),
    "Closing reading is below opening."
  );
  assert.equal(
    AppError.getUserMessage(new Error("Amount must be greater than 0.")),
    "Amount must be greater than 0."
  );
});

test("raw JavaScript failures ask the user to reload", () => {
  const AppError = appError();
  assert.equal(
    AppError.getUserMessage({
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'id')",
    }),
    "Something went wrong. Reload the page and try again."
  );
  assert.equal(
    AppError.getUserMessage(new ReferenceError("customer is not defined")),
    "Something went wrong. Reload the page and try again."
  );
});

test("expected empty reads and connection failures stay specific", () => {
  const AppError = appError();
  assert.equal(
    AppError.getUserMessage({
      message: "JSON object requested, multiple (or no) rows returned",
      code: "PGRST116",
    }),
    ""
  );
  assert.match(AppError.getUserMessage(new Error("Failed to fetch")), /internet/i);
  assert.match(
    AppError.getUserMessage({ message: "duplicate key value violates unique constraint", code: "23505" }),
    /already exists/i
  );
});

test("a recorded payment names the amount, person, and remaining balance", () => {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/utils.js"]);
  assert.equal(
    sandbox.formatRecordedBalance({ amount: 1200, person: "Ravi", remaining: 800, direction: "from" }),
    "Recorded ₹1,200.00 from Ravi. Remaining ₹800.00."
  );
  assert.equal(
    sandbox.formatRecordedBalance({
      amount: 5000,
      person: "Anita",
      remaining: -500,
      direction: "for",
      surplus: "advance",
    }),
    "Recorded ₹5,000.00 for Anita. Remaining advance ₹500.00."
  );
});

function reportingSandbox({ session = { user: { id: "u1" } } } = {}) {
  const store = new Map();
  const inserts = [];
  const timers = [];
  const sandbox = createSandbox({
    addEventListener() {},
    removeEventListener() {},
    setTimeout(fn) { timers.push(fn); return timers.length; },
    location: { pathname: "/staging/dsr.html", href: "https://x/staging/dsr.html" },
    navigator: { userAgent: "TestAgent", onLine: true },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    supabaseClient: {
      auth: { getSession: async () => ({ data: { session } }) },
      from: (table) => ({
        insert: async (rows) => { inserts.push({ table, rows }); return { error: null }; },
      }),
    },
  });
  loadScripts(sandbox, ["js/errorHandler.js"]);
  const runTimers = async () => { while (timers.length) timers.shift()(); await new Promise((r) => setImmediate(r)); };
  return { AppError: sandbox.AppError, inserts, store, runTimers };
}

test("report batches errors into client_errors with page and browser", async () => {
  const { AppError, inserts, store, runTimers } = reportingSandbox();
  AppError.report(new Error("first"), { context: "loadDsr" });
  AppError.report({ message: "second", code: "P0001" }, {});
  AppError.report(new Error("first"), { context: "loadDsr" }); // duplicate within 10s is dropped
  await runTimers();
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].table, "client_errors");
  assert.equal(inserts[0].rows.map((r) => r.message).join(","), "first,second");
  assert.equal(inserts[0].rows[0].page, "dsr.html");
  assert.equal(inserts[0].rows[0].user_agent, "TestAgent");
  assert.equal(inserts[0].rows[0].context.context, "loadDsr");
  assert.equal(inserts[0].rows[1].code, "P0001");
  assert.equal(store.size, 0, "queue is cleared after a successful send");
});

test("report keeps the queue until there is a session", async () => {
  const { AppError, inserts, store, runTimers } = reportingSandbox({ session: null });
  AppError.report(new Error("before login"), {});
  await runTimers();
  assert.equal(inserts.length, 0);
  assert.match(store.get("bpf_client_error_queue"), /before login/);
});
