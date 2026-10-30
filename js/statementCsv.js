/**
 * Bank / UPI statement CSV parsing for DSR → Settlement. Pure functions, no DOM.
 * The page maps columns; import_settlement_lines stores the result.
 */
(function (global) {
  /** RFC 4180-ish: quoted fields, "" escapes, CRLF or LF, comma / semicolon / tab delimiter. */
  function parseCsv(text) {
    const src = String(text || "").replace(/^﻿/, "");
    const firstLine = src.split(/\r?\n/, 1)[0] || "";
    const delim = [",", ";", "\t"]
      .map((d) => [d, firstLine.split(d).length])
      .sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === delim) {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && src[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows
      .map((r) => r.map((v) => v.trim()))
      .filter((r) => r.some((v) => v !== ""));
  }

  /**
   * Bank exports often start with account details. The header is the first row that has
   * a date-like and an amount-like column name.
   */
  function findHeaderRow(rows) {
    const isDate = (h) => /date/i.test(h);
    const isAmount = (h) => /amount|credit|deposit|cr\b/i.test(h);
    const idx = rows.findIndex((r) => r.some(isDate) && r.some(isAmount));
    return idx >= 0 ? idx : 0;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  /** Returns YYYY-MM-DD or null. order: "dmy" | "mdy" | "ymd". Accepts 01-Oct-2026 too. */
  function parseStatementDate(raw, order = "dmy") {
    const s = String(raw || "").trim().split(/[ T]/)[0];
    if (!s) return null;
    let y;
    let m;
    let d;
    const named = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})$/);
    if (named) {
      d = Number(named[1]);
      m = MONTHS[named[2].toLowerCase()];
      y = Number(named[3]);
    } else {
      const parts = s.split(/[-/.]/).map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null;
      if (String(s.split(/[-/.]/)[0]).length === 4 || order === "ymd") [y, m, d] = parts;
      else if (order === "mdy") [m, d, y] = parts;
      else [d, m, y] = parts;
    }
    if (y < 100) y += 2000;
    if (!m || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  /** "₹1,23,456.50 Cr" → 123456.5; "(500)" or "500 Dr" → -500; blank → null. */
  function parseStatementAmount(raw) {
    let s = String(raw || "").trim();
    if (!s) return null;
    let sign = 1;
    if (/^\(.*\)$/.test(s) || /\bdr\.?$/i.test(s) || /^-/.test(s)) sign = -1;
    s = s.replace(/[^0-9.]/g, "");
    if (!s || !/^\d*\.?\d*$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? sign * n : null;
  }

  /**
   * @param {string[][]} dataRows rows after the header
   * @param {{date:number, amount:number, reference?:number, description?:number, dateOrder?:string}} map column indexes (-1 = none)
   * @returns {{lines: {date:string, amount:number, reference:string|null, description:string|null}[], skipped:number}}
   */
  function mapStatementRows(dataRows, map) {
    const lines = [];
    let skipped = 0;
    for (const r of dataRows) {
      const date = parseStatementDate(r[map.date], map.dateOrder);
      const amount = parseStatementAmount(r[map.amount]);
      if (!date || amount == null || amount <= 0) {
        skipped++;
        continue;
      }
      const pick = (i) => (i != null && i >= 0 && r[i] ? String(r[i]).trim() || null : null);
      lines.push({
        date,
        amount: Math.round(amount * 100) / 100,
        reference: pick(map.reference),
        description: pick(map.description),
      });
    }
    return { lines, skipped };
  }

  /** Best guess of column indexes from header names. */
  function guessColumns(header) {
    const find = (re) => header.findIndex((h) => re.test(h));
    return {
      date: find(/(txn|transaction|value|posting)?\s*date/i),
      amount: (() => {
        const credit = find(/credit|deposit|\bcr\b/i);
        return credit >= 0 ? credit : find(/amount/i);
      })(),
      reference: find(/utr|ref|rrn|cheque|transaction id/i),
      description: find(/desc|narration|particular|remark/i),
    };
  }

  global.StatementCsv = { parseCsv, findHeaderRow, parseStatementDate, parseStatementAmount, mapStatementRows, guessColumns };
})(typeof window !== "undefined" ? window : globalThis);
