/* global AppError, escapeHtml, formatCurrency, formatQuantity, formatDisplayDate, supabaseClient */

/**
 * Short / excess per attendant, from get_attendant_short_excess (server figure; same formula
 * as the shift register). Shared by salary.html (monthly table) and staff.html (profile card).
 *   short_excess = cash + UPI + shift credit + shift expenses − net litres × rate
 *   negative = short, positive = excess, null = a rate was missing that day.
 */
(function (global) {
  /** Within ₹0.50 counts as balanced (same as the shift register). */
  const EPSILON = 0.5;

  async function load(start, end, employeeId = null) {
    const { data, error } = await supabaseClient.rpc("get_attendant_short_excess", {
      p_start: start,
      p_end: end,
      p_employee_id: employeeId,
    });
    if (error) throw error;
    return data ?? [];
  }

  /** Group shift rows by employee. */
  function summarise(rows) {
    const byEmp = new Map();
    for (const r of rows) {
      let s = byEmp.get(r.employee_id);
      if (!s) {
        s = {
          employee_id: r.employee_id,
          name: r.employee_name || "Staff",
          shifts: 0,
          unpriced: 0,
          expected: 0,
          handed_over: 0,
          short: 0,
          excess: 0,
          net: 0,
          rows: [],
        };
        byEmp.set(r.employee_id, s);
      }
      s.shifts += 1;
      s.rows.push(r);
      if (r.short_excess == null) {
        s.unpriced += 1;
        continue;
      }
      const v = Number(r.short_excess);
      s.expected += Number(r.expected) || 0;
      s.handed_over += Number(r.handed_over) || 0;
      s.net += v;
      if (v < -EPSILON) s.short += v;
      else if (v > EPSILON) s.excess += v;
    }
    return [...byEmp.values()].sort((a, b) => a.net - b.net);
  }

  function toneClass(v) {
    if (v == null) return "";
    if (v < -EPSILON) return "stat-negative";
    if (v > EPSILON) return "stat-positive";
    return "";
  }

  function signed(v) {
    if (v == null) return "—";
    return `${v > 0 ? "+" : ""}${formatCurrency(v)}`;
  }

  /** Shift-by-shift table for one attendant. */
  function shiftRowsHtml(rows) {
    if (!rows.length) return '<p class="muted">No shifts recorded.</p>';
    return `<div class="table-wrap"><table class="attendant-short-shifts">
      <thead><tr><th>Date</th><th>Shift</th><th class="num">Litres</th><th class="num">Expected</th><th class="num">Handed over</th><th class="num">Short / excess</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
          <td>${escapeHtml(formatDisplayDate(r.reading_date))}</td>
          <td>${escapeHtml(r.shift)}</td>
          <td class="num">${formatQuantity(Number(r.petrol_litres) + Number(r.diesel_litres))}</td>
          <td class="num">${r.expected == null ? '<span class="muted">No rate</span>' : formatCurrency(r.expected)}</td>
          <td class="num">${formatCurrency(r.handed_over)}</td>
          <td class="num ${toneClass(r.short_excess == null ? null : Number(r.short_excess))}">${signed(
            r.short_excess == null ? null : Number(r.short_excess)
          )}</td>
        </tr>`
        )
        .join("")}</tbody></table></div>`;
  }

  function reportError(err, context) {
    AppError.report(err, { context });
    return escapeHtml(AppError.getUserMessage(err));
  }

  global.AttendantShort = { EPSILON, load, summarise, toneClass, signed, shiftRowsHtml, reportError };
})(typeof window !== "undefined" ? window : globalThis);
