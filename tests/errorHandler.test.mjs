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
