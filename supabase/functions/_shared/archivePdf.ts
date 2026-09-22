import { PDFDocument, PDFPage, StandardFonts, rgb, type PDFFont, type PDFImage } from "https://esm.sh/pdf-lib@1.17.1?target=deno";
import type { StationBranding } from "./googleDrive.ts";
import { STATION_LOGO_PNG_B64 } from "./logoPng.ts";

const BLUE = rgb(0, 112 / 255, 192 / 255);
const BLUE_DARK = rgb(0, 90 / 255, 156 / 255);
const DARK = rgb(26 / 255, 35 / 255, 50 / 255);
const MUTED = rgb(74 / 255, 95 / 255, 122 / 255);
const LINE = rgb(184 / 255, 212 / 255, 232 / 255);
const ROW_ALT = rgb(248 / 255, 250 / 255, 252 / 255);
const WHITE = rgb(1, 1, 1);
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 34;
const GST_PCTS = [5, 12, 18, 24, 28];
const INVOICE_LOGO_PT = 45;
const LETTER_LOGO_PT = 79;

export interface InvoicePdfItem {
  sl_no?: number;
  item_name?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  rate?: number | string | null;
  gst_percent?: number | string | null;
  amount?: number | string | null;
}

export interface InvoicePdfData {
  invoice_number?: string | null;
  invoice_date?: string | null;
  invoice_type?: string | null;
  party_name?: string | null;
  party_address?: string | null;
  party_gstin?: string | null;
  vehicle_no?: string | null;
  mobile?: string | null;
  km_reading?: string | null;
  subtotal?: number | string | null;
  discount?: number | string | null;
  round_off?: number | string | null;
  total_amount?: number | string | null;
}

export interface LetterPdfData {
  letter_date?: string | null;
  subject?: string | null;
  body?: string | null;
  include_sign?: boolean | null;
}

export interface StaffAttachmentPdfData {
  title: string;
  personName?: string | null;
  caption?: string | null;
  imageBytes: Uint8Array;
  imageMime: string;
}

type Fonts = { regular: PDFFont; bold: PDFFont };

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const LOGO_BYTES = decodeB64(STATION_LOGO_PNG_B64);

function pdfSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/₹/g, "Rs ")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\n\r\t]/g, "")
    .trim();
}

function money(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function gstLabel(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "Non-GST";
  if (n === 0) return "NIL";
  return `${n}%`;
}

function formatDate(value: unknown): string {
  const raw = String(value ?? "").slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return pdfSafe(value);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const clean = pdfSafe(text);
  if (!clean) return [""];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
      } else {
        let chunk = "";
        for (const ch of word) {
          const trial = chunk + ch;
          if (font.widthOfTextAtSize(trial, size) <= maxWidth) chunk = trial;
          else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function stationTitle(station: StationBranding): string {
  const short = pdfSafe(station.brandShort) || "Bishnu Priya";
  const accent = pdfSafe(station.brandAccent) || "Fuels";
  return `${short} ${accent}`.trim();
}

function innerWidth(): number {
  return PAGE_W - MARGIN * 2;
}

function drawRight(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  size: number,
  font: PDFFont,
  color = DARK
): void {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, size, font, color });
}

function drawBox(page: PDFPage, x: number, y: number, w: number, h: number, thickness = 1): void {
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    borderColor: LINE,
    borderWidth: thickness,
    color: WHITE,
  });
}

async function embedLogo(pdf: PDFDocument): Promise<PDFImage | null> {
  try {
    return await pdf.embedPng(LOGO_BYTES);
  } catch {
    return null;
  }
}

async function embedRaster(pdf: PDFDocument, bytes: Uint8Array, mime: string): Promise<PDFImage | null> {
  try {
    if (mime === "image/png") return await pdf.embedPng(bytes);
    if (mime === "image/jpeg" || mime === "image/jpg") return await pdf.embedJpg(bytes);
  } catch {
    return null;
  }
  return null;
}

function drawWatermark(page: PDFPage, logo: PDFImage | null): void {
  if (!logo) return;
  const size = 283;
  page.drawImage(logo, {
    x: (PAGE_W - size) / 2,
    y: (PAGE_H - size) / 2,
    width: size,
    height: size,
    opacity: 0.08,
  });
}

function drawLetterhead(
  page: PDFPage,
  fonts: Fonts,
  station: StationBranding,
  logo: PDFImage | null,
  logoSize: number
): number {
  const yTop = PAGE_H - MARGIN;
  const textX = logo ? MARGIN + logoSize + 12 : MARGIN;
  const textW = PAGE_W - MARGIN - textX;
  let y = yTop - 16;

  if (logo) {
    page.drawImage(logo, {
      x: MARGIN,
      y: yTop - logoSize,
      width: logoSize,
      height: logoSize,
    });
  }

  const short = pdfSafe(station.brandShort) || "Bishnu Priya";
  const accent = pdfSafe(station.brandAccent) || "Fuels";
  page.drawText(short, { x: textX, y, size: 18, font: fonts.bold, color: BLUE_DARK });
  const shortW = fonts.bold.widthOfTextAtSize(short + " ", 18);
  page.drawText(accent, { x: textX + shortW, y, size: 18, font: fonts.bold, color: BLUE });
  y -= 14;

  if (station.tagline) {
    page.drawText(pdfSafe(station.tagline), { x: textX, y, size: 8.5, font: fonts.bold, color: BLUE });
    y -= 12;
  }

  const addressLines = wrap(fonts.regular, station.address || "", 8, textW);
  for (const line of addressLines) {
    if (!line) continue;
    page.drawText(line, { x: textX, y, size: 8, font: fonts.regular, color: MUTED });
    y -= 11;
  }
  y -= 2;

  const contacts: [string, string][] = [
    ["Email", pdfSafe(station.email)],
    ["Mobile", pdfSafe(station.mobile)],
    ["GSTIN", pdfSafe(station.gstin)],
    ["License", pdfSafe(station.license)],
  ].filter(([, value]) => value) as [string, string][];
  const colW = textW / 2;
  for (let i = 0; i < contacts.length; i += 2) {
    const left = contacts[i];
    const right = contacts[i + 1];
    if (left) {
      page.drawText(left[0], { x: textX, y, size: 7.5, font: fonts.bold, color: MUTED });
      const labelW = fonts.bold.widthOfTextAtSize(left[0] + " ", 7.5);
      page.drawText(left[1], { x: textX + labelW, y, size: 7.5, font: fonts.regular, color: DARK });
    }
    if (right) {
      page.drawText(right[0], { x: textX + colW, y, size: 7.5, font: fonts.bold, color: MUTED });
      const labelW = fonts.bold.widthOfTextAtSize(right[0] + " ", 7.5);
      page.drawText(right[1], {
        x: textX + colW + labelW,
        y,
        size: 7.5,
        font: fonts.regular,
        color: DARK,
      });
    }
    y -= 11;
  }

  const headerBottom = Math.min(y, yTop - logoSize) - 8;
  page.drawLine({
    start: { x: MARGIN, y: headerBottom },
    end: { x: PAGE_W - MARGIN, y: headerBottom },
    thickness: 3,
    color: BLUE,
  });
  return headerBottom - 12;
}

function taxBreakdown(items: InvoicePdfItem[]) {
  const gstSlabs: Record<number, { goods: number; tax: number }> = {};
  let totalNonGst = 0;
  let totalNilRate = 0;
  for (const item of items || []) {
    const pct = Number(item.gst_percent);
    const amt = Number(item.amount);
    if (!Number.isFinite(amt)) continue;
    if (!Number.isFinite(pct) || pct < 0) {
      totalNonGst += amt;
    } else if (pct === 0) {
      totalNilRate += amt;
    } else {
      if (!gstSlabs[pct]) gstSlabs[pct] = { goods: 0, tax: 0 };
      const taxable = amt / (1 + pct / 100);
      gstSlabs[pct].goods += taxable;
      gstSlabs[pct].tax += amt - taxable;
    }
  }
  return { gstSlabs, totalNonGst, totalNilRate };
}

function drawDlRow(
  page: PDFPage,
  fonts: Fonts,
  x: number,
  y: number,
  labelW: number,
  valueW: number,
  label: string,
  value: string
): number {
  const lines = wrap(fonts.regular, value || " ", 8.5, valueW);
  page.drawText(label, { x, y, size: 7.5, font: fonts.bold, color: MUTED });
  let cy = y;
  for (const line of lines) {
    page.drawText(line || " ", { x: x + labelW, y: cy, size: 8.5, font: fonts.regular, color: DARK });
    cy -= 11;
  }
  return Math.max(lines.length, 1) * 11;
}

export async function buildInvoicePdf(
  invoice: InvoicePdfData,
  items: InvoicePdfItem[],
  station: StationBranding
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const logo = await embedLogo(pdf);
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  const startPage = () => {
    drawWatermark(page, logo);
    return drawLetterhead(page, fonts, station, logo, INVOICE_LOGO_PT);
  };
  let y = startPage();

  const isCredit = String(invoice.invoice_type || "").toUpperCase() === "CREDIT";
  const barH = 36;
  const barY = y - barH;
  drawBox(page, MARGIN, barY, innerWidth(), barH);
  page.drawRectangle({
    x: MARGIN,
    y: barY,
    width: 4,
    height: barH,
    color: BLUE,
  });
  page.drawText("TAX INVOICE", {
    x: MARGIN + 12,
    y: barY + 20,
    size: 12,
    font: fonts.bold,
    color: BLUE_DARK,
  });
  page.drawText(isCredit ? "CREDIT INVOICE" : "CASH MEMO", {
    x: MARGIN + 12,
    y: barY + 8,
    size: 8,
    font: fonts.bold,
    color: MUTED,
  });
  const refLabelX = PAGE_W - MARGIN - 170;
  const refValueX = PAGE_W - MARGIN - 12;
  page.drawText("Invoice No.", { x: refLabelX, y: barY + 20, size: 7.5, font: fonts.bold, color: MUTED });
  drawRight(page, pdfSafe(invoice.invoice_number), refValueX, barY + 20, 10, fonts.bold);
  page.drawText("Date", { x: refLabelX, y: barY + 8, size: 7.5, font: fonts.bold, color: MUTED });
  drawRight(page, formatDate(invoice.invoice_date), refValueX, barY + 8, 10, fonts.regular);
  y = barY - 10;

  const gap = 10;
  const leftW = innerWidth() * 0.62;
  const rightW = innerWidth() - leftW - gap;
  const leftX = MARGIN;
  const rightX = MARGIN + leftW + gap;
  const cardTop = y;
  const leftRows: [string, string][] = [
    ["Party Name", pdfSafe(invoice.party_name) || "Cash A/c"],
    ["Address", pdfSafe(invoice.party_address) || " "],
    ["GSTIN", pdfSafe(invoice.party_gstin) || " "],
  ];
  const rightRows: [string, string][] = [
    ["Vehicle No.", pdfSafe(invoice.vehicle_no) || " "],
    ["Mobile", pdfSafe(invoice.mobile) || " "],
    ["KM Reading", pdfSafe(invoice.km_reading) || " "],
  ];
  let leftH = 22;
  let rightH = 22;
  leftRows.forEach(([, value]) => {
    leftH += Math.max(wrap(fonts.regular, value, 8.5, leftW - 86).length, 1) * 11 + 2;
  });
  rightRows.forEach(([, value]) => {
    rightH += Math.max(wrap(fonts.regular, value, 8.5, rightW - 78).length, 1) * 11 + 2;
  });
  const cardH = Math.max(leftH, rightH, 70);
  const cardY = cardTop - cardH;
  drawBox(page, leftX, cardY, leftW, cardH);
  drawBox(page, rightX, cardY, rightW, cardH);
  page.drawText("CUSTOMER DETAILS", {
    x: leftX + 8,
    y: cardTop - 14,
    size: 8,
    font: fonts.bold,
    color: MUTED,
  });
  page.drawText("OTHER DETAILS", {
    x: rightX + 8,
    y: cardTop - 14,
    size: 8,
    font: fonts.bold,
    color: MUTED,
  });
  let ly = cardTop - 28;
  for (const [label, value] of leftRows) {
    ly -= drawDlRow(page, fonts, leftX + 8, ly, 70, leftW - 86, label, value);
  }
  let ry = cardTop - 28;
  for (const [label, value] of rightRows) {
    ry -= drawDlRow(page, fonts, rightX + 8, ry, 62, rightW - 78, label, value);
  }
  y = cardY - 14;

  page.drawText("LINE ITEMS", { x: MARGIN, y, size: 8, font: fonts.bold, color: MUTED });
  y -= 8;

  const tableW = innerWidth();
  const cols = [
    { w: tableW * 0.06, label: "#", align: "center" as const },
    { w: tableW * 0.34, label: "Description", align: "left" as const },
    { w: tableW * 0.1, label: "Qty", align: "right" as const },
    { w: tableW * 0.08, label: "Unit", align: "center" as const },
    { w: tableW * 0.12, label: "Rate (Rs)", align: "right" as const },
    { w: tableW * 0.1, label: "GST", align: "center" as const },
    { w: tableW * 0.2, label: "Amount (Rs)", align: "right" as const },
  ];
  const colX: number[] = [];
  let cx = MARGIN;
  for (const col of cols) {
    colX.push(cx);
    cx += col.w;
  }

  const headerH = 16;
  const drawTableHeader = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - headerH,
      width: tableW,
      height: headerH,
      borderColor: BLUE,
      borderWidth: 1.5,
      color: WHITE,
    });
    cols.forEach((col, i) => {
      const tx = col.align === "left" ? colX[i] + 4 : colX[i] + col.w - 4;
      if (col.align === "left") {
        page.drawText(col.label, { x: tx, y: y - 11, size: 7, font: fonts.bold, color: BLUE_DARK });
      } else {
        drawRight(page, col.label, tx, y - 11, 7, fonts.bold, BLUE_DARK);
      }
    });
    y -= headerH;
  };
  drawTableHeader();

  const rows = items || [];
  let totalQty = 0;
  rows.forEach((item, index) => {
    totalQty += Number(item.quantity) || 0;
    const nameLines = wrap(fonts.regular, String(item.item_name || "Item"), 8, cols[1].w - 8).slice(0, 2);
    const rowH = Math.max(16, nameLines.length * 11 + 6);
    if (y - rowH < 210) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = startPage();
      page.drawText("LINE ITEMS (continued)", { x: MARGIN, y, size: 8, font: fonts.bold, color: MUTED });
      y -= 8;
      drawTableHeader();
    }
    if (index % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - rowH, width: tableW, height: rowH, color: ROW_ALT });
    }
    page.drawRectangle({
      x: MARGIN,
      y: y - rowH,
      width: tableW,
      height: rowH,
      borderColor: LINE,
      borderWidth: 0.8,
    });
    const mid = y - 11;
    const values = [
      String(item.sl_no || index + 1),
      nameLines[0] || "",
      String(item.quantity ?? ""),
      pdfSafe(item.unit || "Pcs"),
      money(item.rate),
      gstLabel(item.gst_percent),
      money(item.amount),
    ];
    values.forEach((value, i) => {
      if (i === 1) {
        page.drawText(value, { x: colX[i] + 4, y: mid, size: 8, font: fonts.regular, color: DARK });
        if (nameLines[1]) {
          page.drawText(nameLines[1], {
            x: colX[i] + 4,
            y: mid - 11,
            size: 8,
            font: fonts.regular,
            color: DARK,
          });
        }
        return;
      }
      if (cols[i].align === "left") {
        page.drawText(value, { x: colX[i] + 4, y: mid, size: 8, font: fonts.regular, color: DARK });
      } else if (cols[i].align === "center") {
        const tw = fonts.regular.widthOfTextAtSize(value, 8);
        page.drawText(value, {
          x: colX[i] + (cols[i].w - tw) / 2,
          y: mid,
          size: 8,
          font: fonts.regular,
          color: DARK,
        });
      } else {
        drawRight(page, value, colX[i] + cols[i].w - 4, mid, 8, fonts.regular);
      }
    });
    y -= rowH;
  });

  const footH = 16;
  page.drawRectangle({
    x: MARGIN,
    y: y - footH,
    width: tableW,
    height: footH,
    color: ROW_ALT,
    borderColor: LINE,
    borderWidth: 0.8,
  });
  drawRight(page, "Total Quantity", colX[1] + cols[1].w - 4, y - 11, 8, fonts.bold, MUTED);
  const qtyText = String(totalQty);
  const qtyW = fonts.bold.widthOfTextAtSize(qtyText, 8);
  page.drawText(qtyText, {
    x: colX[2] + (cols[2].w - qtyW) / 2,
    y: y - 11,
    size: 8,
    font: fonts.bold,
    color: DARK,
  });
  y -= footH + 12;

  const { gstSlabs, totalNonGst, totalNilRate } = taxBreakdown(rows);
  const taxRows: [string, string, string][] = [];
  if (totalNonGst > 0) taxRows.push(["Non-GST", money(totalNonGst), "-"]);
  if (totalNilRate > 0) taxRows.push(["Nil Rated", money(totalNilRate), "-"]);
  for (const pct of GST_PCTS) {
    if (gstSlabs[pct]) {
      taxRows.push([`GST @ ${pct}%`, money(gstSlabs[pct].goods), money(gstSlabs[pct].tax)]);
    }
  }
  if (!taxRows.length) taxRows.push(["Nil Rated", "-", "-"]);

  const payRows: [string, string, boolean][] = [
    ["Subtotal", money(invoice.subtotal), false],
  ];
  if (Number(invoice.discount) > 0) payRows.push(["Less Discount", money(invoice.discount), false]);
  payRows.push(["Round Off", money(invoice.round_off), false]);
  payRows.push(["Total Payable", money(invoice.total_amount), true]);

  const taxW = innerWidth() * 0.62;
  const payW = innerWidth() - taxW - gap;
  const taxX = MARGIN;
  const payX = MARGIN + taxW + gap;
  const taxH = 22 + (taxRows.length + 1) * 14 + 8;
  const payH = 22 + payRows.length * 14 + 8;
  const panelH = Math.max(taxH, payH);
  if (y - panelH < 90) {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = startPage();
  }
  const panelY = y - panelH;
  drawBox(page, taxX, panelY, taxW, panelH);
  drawBox(page, payX, panelY, payW, panelH);
  page.drawText("TAX SUMMARY", { x: taxX + 8, y: y - 14, size: 8, font: fonts.bold, color: MUTED });
  page.drawText("PAYMENT SUMMARY", { x: payX + 8, y: y - 14, size: 8, font: fonts.bold, color: MUTED });

  const taxCols = [taxX + 8, taxX + taxW * 0.48, taxX + taxW - 8];
  let ty = y - 30;
  page.drawText("Category", { x: taxCols[0], y: ty, size: 7, font: fonts.bold, color: MUTED });
  drawRight(page, "Taxable / Goods (Rs)", taxCols[1] + 70, ty, 7, fonts.bold, MUTED);
  drawRight(page, "Tax (Rs)", taxCols[2], ty, 7, fonts.bold, MUTED);
  ty -= 14;
  for (const [cat, goods, tax] of taxRows) {
    page.drawText(cat, { x: taxCols[0], y: ty, size: 8, font: fonts.regular, color: DARK });
    drawRight(page, goods, taxCols[1] + 70, ty, 8, fonts.regular);
    drawRight(page, tax, taxCols[2], ty, 8, fonts.regular);
    ty -= 14;
  }

  let py = y - 30;
  for (const [label, value, strong] of payRows) {
    const font = strong ? fonts.bold : fonts.regular;
    const size = strong ? 9 : 8.5;
    page.drawText(label, { x: payX + 8, y: py, size, font, color: DARK });
    drawRight(page, `Rs ${value}`, payX + payW - 8, py, size, font);
    py -= 14;
  }
  y = panelY - 12;

  const notes = [
    "Instructions :",
    "1. All disputes are subject to Jajpur jurisdiction.",
    "E. & O.E.",
    "Wish you a happy journey.",
    "Thank you. Visit again.",
  ];
  let ny = y;
  notes.forEach((line, i) => {
    page.drawText(line, {
      x: MARGIN,
      y: ny,
      size: i === 0 ? 8 : 8,
      font: i === 0 ? fonts.bold : fonts.regular,
      color: i === 0 ? DARK : MUTED,
    });
    ny -= 11;
  });

  const signX = PAGE_W - MARGIN - 180;
  page.drawText(`FOR ${pdfSafe(station.legalName || stationTitle(station)).toUpperCase()}`, {
    x: signX,
    y,
    size: 8,
    font: fonts.bold,
    color: BLUE_DARK,
  });
  page.drawText("MANAGER", { x: signX, y: y - 36, size: 8, font: fonts.bold, color: MUTED });

  return pdf.save();
}

export async function buildLetterPdf(letter: LetterPdfData, station: StationBranding): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const logo = await embedLogo(pdf);

  const addStyledPage = (): { page: PDFPage; y: number } => {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    drawWatermark(page, logo);
    return { page, y: drawLetterhead(page, fonts, station, logo, LETTER_LOGO_PT) };
  };

  let { page, y } = addStyledPage();

  if (letter.letter_date) {
    drawRight(page, formatDate(letter.letter_date), PAGE_W - MARGIN, y, 10, fonts.regular);
    y -= 22;
  }

  if (letter.subject) {
    page.drawText("Subject:", { x: MARGIN, y, size: 11, font: fonts.bold, color: DARK });
    const labelW = fonts.bold.widthOfTextAtSize("Subject: ", 11);
    const subjectLines = wrap(fonts.regular, String(letter.subject), 11, innerWidth() - labelW);
    page.drawText(subjectLines[0] || "", {
      x: MARGIN + labelW,
      y,
      size: 11,
      font: fonts.regular,
      color: DARK,
    });
    y -= 16;
    for (const extra of subjectLines.slice(1)) {
      page.drawText(extra, { x: MARGIN, y, size: 11, font: fonts.regular, color: DARK });
      y -= 15;
    }
    y -= 8;
  }

  const paragraphs = String(letter.body || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const para of paragraphs) {
    const lines = String(para)
      .split("\n")
      .flatMap((line) => wrap(fonts.regular, line, 11, innerWidth()));
    for (const line of lines) {
      if (y < 90) {
        ({ page, y } = addStyledPage());
      }
      if (line) page.drawText(line, { x: MARGIN, y, size: 11, font: fonts.regular, color: DARK });
      y -= 15;
    }
    y -= 8;
  }

  if (letter.include_sign !== false) {
    if (y < 90) ({ page, y } = addStyledPage());
    y -= 18;
    const signX = PAGE_W - MARGIN - 200;
    page.drawText(`FROM ${pdfSafe(station.legalName || stationTitle(station)).toUpperCase()}`, {
      x: signX,
      y,
      size: 9,
      font: fonts.bold,
      color: BLUE_DARK,
    });
    page.drawText("Authorised Signatory", {
      x: signX,
      y: y - 40,
      size: 9,
      font: fonts.regular,
      color: MUTED,
    });
  }

  return pdf.save();
}

export async function buildStaffAttachmentPdf(
  data: StaffAttachmentPdfData,
  station: StationBranding
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const logo = await embedLogo(pdf);
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  drawWatermark(page, logo);
  let y = drawLetterhead(page, fonts, station, logo, LETTER_LOGO_PT);

  const barH = 32;
  const barY = y - barH;
  drawBox(page, MARGIN, barY, innerWidth(), barH);
  page.drawRectangle({ x: MARGIN, y: barY, width: 4, height: barH, color: BLUE });
  page.drawText(pdfSafe(data.title).toUpperCase() || "STAFF DOCUMENT", {
    x: MARGIN + 12,
    y: barY + 12,
    size: 12,
    font: fonts.bold,
    color: BLUE_DARK,
  });
  y = barY - 16;

  if (data.personName) {
    page.drawText("Name", { x: MARGIN, y, size: 8, font: fonts.bold, color: MUTED });
    page.drawText(pdfSafe(data.personName), {
      x: MARGIN + 40,
      y,
      size: 11,
      font: fonts.bold,
      color: DARK,
    });
    y -= 16;
  }
  if (data.caption) {
    for (const line of wrap(fonts.regular, data.caption, 9, innerWidth())) {
      page.drawText(line, { x: MARGIN, y, size: 9, font: fonts.regular, color: MUTED });
      y -= 12;
    }
    y -= 4;
  }

  const image = await embedRaster(pdf, data.imageBytes, data.imageMime);
  if (image) {
    const maxW = innerWidth();
    const maxH = y - MARGIN - 20;
    const scale = Math.min(maxW / image.width, maxH / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawRectangle({
      x: MARGIN,
      y: y - h - 8,
      width: maxW,
      height: h + 16,
      borderColor: LINE,
      borderWidth: 1,
    });
    page.drawImage(image, {
      x: MARGIN + (maxW - w) / 2,
      y: y - h - 4,
      width: w,
      height: h,
    });
  } else {
    page.drawText("Attachment could not be rendered. Original file is stored in Drive.", {
      x: MARGIN,
      y,
      size: 9,
      font: fonts.regular,
      color: MUTED,
    });
  }

  return pdf.save();
}

export function canEmbedRaster(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png";
}
