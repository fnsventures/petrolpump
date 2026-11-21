import test from "node:test";
import assert from "node:assert/strict";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";
import { creditSmsText, creditWhatsAppText } from "../supabase/functions/_shared/creditMessage.js";

function taskUtils() {
  const sandbox = createSandbox({ escapeHtml: (s) => String(s) });
  loadScripts(sandbox, ["js/taskUtils.js"]);
  return sandbox.TaskUtils;
}

const station = { name: "BISHNU PRIYA FUELS", tagline: "Authorized Dealer — BPCL", mobile: "+91 96689 13299" };
const cases = [
  { station, customerName: "Acme Transport", amount: 12345.5, asOn: "31 Oct 2026", url: "https://x/statement.html#t=ab", linkDays: 14 },
  { station, customerName: "", amount: 0, asOn: "31 Oct 2026" },
  { station: {}, customerName: "Ravi", amount: -50, asOn: "1 Nov 2026", url: "https://x/s" },
];

test("app and weekly SMS job build the same reminder text", () => {
  const T = taskUtils();
  for (const m of cases) {
    assert.equal(T.creditWhatsAppText(m), creditWhatsAppText(m));
    assert.equal(T.creditSmsText(m), creditSmsText(m));
  }
});

test("SMS stays GSM-7 so it is not billed as Unicode", () => {
  for (const m of cases) {
    // eslint-disable-next-line no-control-regex
    assert.match(creditSmsText(m), /^[\x20-\x7E]*$/);
  }
});

test("messages leave out the customer name and phone number", () => {
  for (const build of [creditWhatsAppText, creditSmsText]) {
    const text = build(cases[0]);
    assert.doesNotMatch(text, /Acme/);
    assert.doesNotMatch(text, /96689|Ph:/);
    assert.match(text, /Dear Customer,/);
  }
});

test("WhatsApp text has the amount and statement link", () => {
  const text = creditWhatsAppText(cases[0]);
  assert.match(text, /\*Amount due:\* ₹12,345\.50/);
  assert.match(text, /https:\/\/x\/statement\.html#t=ab/);
  assert.match(text, /valid for 14 days/);
});
