/**
 * Day-closing figures that must match save_day_closing.
 * Kept separate so the formulas can be unit-tested without the page.
 */

function dcMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Open shift credit = gross shift-attributed credit − same-day settled (floored at 0).
 * Falls back to the RPC's credit_shift when neither part is present.
 */
function computeOpenShiftCredit(shiftGross, sameDay, fallback = 0) {
  const gross = dcMoney(shiftGross);
  const same = dcMoney(sameDay);
  if (gross > 0.005 || same > 0.005) {
    return Math.max(0, gross - same);
  }
  return dcMoney(fallback);
}

/**
 * Today's short = (Total sale + Collection + Short previous) − (Night cash + Phone pay + Credit + Expenses).
 * Positive = money unaccounted (shortage); negative = surplus.
 * No rounding here; display goes through formatCurrency.
 */
function computeDayClosingShort({
  totalSale = 0,
  collection = 0,
  shortPrevious = 0,
  nightCash = 0,
  phonePay = 0,
  creditToday = 0,
  expensesToday = 0,
} = {}) {
  return totalSale + collection + shortPrevious - (nightCash + phonePay + creditToday + expensesToday);
}
