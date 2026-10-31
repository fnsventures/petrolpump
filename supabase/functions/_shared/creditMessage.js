// Credit reminder text: one wording for every send path.
//   whatsapp: staff tap the WhatsApp icon (js/taskUtils.js)
//   sms:      staff tap the SMS icon (js/taskUtils.js) and the weekly-credit-sms job
// js/taskUtils.js keeps a copy (classic script, cannot import this). tests/creditMessage.test.mjs
// fails if the two drift.
//
// No customer name or phone number in the text; the statement link carries the account details.
//
// SMS stays GSM-7 ("Rs", plain ASCII): one "₹" makes the whole message UCS-2, which halves the
// characters per part and roughly doubles the cost.

/**
 * @typedef {{ name?: string, tagline?: string }} Station
 * @typedef {{ station?: Station, amount?: number, asOn: string,
 *             url?: string, linkDays?: number }} CreditMessageInput
 */

function amountText(amount, symbol) {
  const n = Number(amount);
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  return symbol + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stationName(station) {
  return String(station?.name || "").trim() || "BISHNU PRIYA FUELS";
}

/** @param {CreditMessageInput} m */
export function creditWhatsAppText(m) {
  const station = stationName(m.station);
  const tagline = String(m.station?.tagline || "").trim();
  const due = Number(m.amount) > 0.004;
  return [
    `*${station}*`,
    ...(tagline ? [tagline] : []),
    "",
    "Dear Customer,",
    "",
    due
      ? "This is a reminder about your credit account with us."
      : "Here is the latest statement of your credit account with us.",
    "",
    `*Amount due:* ${amountText(m.amount, "₹")}`,
    `*As on:* ${m.asOn}`,
    ...(m.url
      ? ["", "*Statement (view / download PDF):*", m.url, `_Link valid for ${m.linkDays || 30} days._`]
      : []),
    "",
    ...(due ? ["Kindly clear the dues at the earliest. If you have already paid, please ignore this message.", ""] : []),
    "Thank you,",
    station,
  ].join("\n");
}

/** @param {CreditMessageInput} m */
export function creditSmsText(m) {
  const due = Number(m.amount) > 0.004;
  return [
    `${stationName(m.station)} (BPCL): Dear Customer, your credit a/c amount due as on ${m.asOn} is ${amountText(m.amount, "Rs ")}.`,
    due ? "Kindly pay at the earliest." : "",
    m.url ? `Statement (PDF): ${m.url}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
