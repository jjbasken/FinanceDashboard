import { parseCents, type CsvDateFormat, type CsvMapping } from "@fd/shared";

export interface BankTxn {
  /** The bank's own id for the transaction (OFX FITID), when there is one. */
  externalId: string | null;
  date: string;
  amount: number;
  payee: string;
  notes: string;
}

export class BankFileError extends Error {}

export function detectFormat(text: string): "ofx" | "csv" {
  const head = text.slice(0, 4000).toUpperCase();
  return head.includes("<OFX>") || head.includes("OFXHEADER") ? "ofx" : "csv";
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

/** The value of `<TAG>value` inside a block, for both SGML (unclosed) and XML OFX. */
function tag(block: string, name: string) {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? decodeEntities(m[1]!.trim()) : "";
}

/** OFX dates look like 20260115, 20260115120000 or 20260115120000.000[-5:EST]; keep the calendar date. */
function ofxDate(raw: string) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

export function parseOfx(text: string): BankTxn[] {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0 && !/<BANKTRANLIST>|<STMTRS>|<CCSTMTRS>/i.test(text)) {
    throw new BankFileError("This OFX file has no transactions in it.");
  }
  const out: BankTxn[] = [];
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0]!;
    const date = ofxDate(tag(block, "DTPOSTED"));
    const amount = parseCents(tag(block, "TRNAMT"));
    if (!date || amount === null) continue;
    const name = tag(block, "NAME") || tag(block, "PAYEE");
    const memo = tag(block, "MEMO");
    const check = tag(block, "CHECKNUM");
    out.push({
      externalId: tag(block, "FITID") || null,
      date,
      amount,
      payee: (name || memo).slice(0, 100),
      notes: [check ? `#${check}` : "", name && memo && memo !== name ? memo : ""].filter(Boolean).join(" · "),
    });
  }
  return out;
}

/** RFC 4180-style CSV with quoted fields, auto-detecting comma, semicolon or tab. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field.trim());
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export function parseDate(raw: string, format: CsvDateFormat): string | null {
  const s = raw.trim();
  let y: string | undefined, m: string | undefined, d: string | undefined;
  const parts = s.split(/[-/.\s]/).filter(Boolean);
  if (parts.length < 3) return null;
  if (format === "YYYY-MM-DD" || format === "YYYY/MM/DD") [y, m, d] = parts;
  else if (format === "MM/DD/YYYY") [m, d, y] = parts;
  else [d, m, y] = parts;
  if (!y || !m || !d || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
  const yearFirst = format.startsWith("YYYY");
  if (!(yearFirst ? /^\d{4}$/ : /^(\d{2}|\d{4})$/).test(y)) return null;
  if (y.length === 2) y = `20${y}`;
  const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(date) ? null : date;
}

const isAmount = (s: string) => s.trim() !== "" && parseCents(s) !== null;

/** Guess which columns hold what, from header names first and the values second. */
export function suggestCsvMapping(rows: string[][]): CsvMapping {
  const first = rows[0] ?? [];
  const sample = rows.slice(1, 30);
  const hasHeader = first.length > 0 && !first.some((f) => isAmount(f)) && first.some((f) => /[a-z]/i.test(f));
  const data = hasHeader ? sample : rows.slice(0, 30);
  const names = hasHeader ? first.map((h) => h.toLowerCase()) : [];
  const find = (...patterns: RegExp[]) => {
    for (const p of patterns) {
      const i = names.findIndex((n) => p.test(n));
      if (i >= 0) return i;
    }
    return null;
  };
  const width = Math.max(...data.map((r) => r.length), first.length);

  let date = find(/^(transaction |posted |posting )?date$/, /date/);
  const formats: CsvDateFormat[] = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY", "YYYY/MM/DD"];
  // Separators don't change how a date is read, but matching them picks the label people expect.
  const separator = (f: CsvDateFormat) => f.replace(/[YMD]/g, "")[0]!;
  const fits = (col: number, f: CsvDateFormat) =>
    data.every((r) => !r[col] || (r[col]!.includes(separator(f)) && parseDate(r[col]!, f) !== null));
  if (date === null) {
    for (let c = 0; c < width && date === null; c++)
      if (data.some((r) => r[c]) && formats.some((f) => fits(c, f))) date = c;
  }
  const dateFormat = formats.find((f) => date !== null && fits(date, f) && data.some((r) => r[date!])) ?? "MM/DD/YYYY";

  let amount = find(/^amount$/, /amount/, /^value$/);
  const debit = find(/debit|withdrawal|money out|paid out/);
  const credit = find(/credit|deposit|money in|paid in/);
  if (amount === null && debit === null && credit === null) {
    for (let c = width - 1; c >= 0 && amount === null; c--) {
      if (c !== date && data.every((r) => !r[c] || isAmount(r[c]!)) && data.some((r) => r[c])) amount = c;
    }
  }
  let payee = find(/payee|description|merchant|name|details/);
  if (payee === null) {
    let best = -1;
    for (let c = 0; c < width; c++) {
      if (c === date || c === amount) continue;
      const len = data.reduce((s, r) => s + (r[c] && !isAmount(r[c]!) ? r[c]!.length : 0), 0);
      if (len > best) {
        best = len;
        payee = c;
      }
    }
  }
  const notes = find(/memo|note|reference/);
  return {
    hasHeader,
    date: date ?? 0,
    dateFormat,
    payee,
    notes: notes === payee ? null : notes,
    amount: debit !== null || credit !== null ? null : amount,
    debit,
    credit,
    invert: false,
  };
}

export function csvToTxns(rows: string[][], m: CsvMapping) {
  const txns: (BankTxn & { line: number })[] = [];
  const errors: { line: number; message: string }[] = [];
  rows.forEach((row, i) => {
    if (m.hasHeader && i === 0) return;
    const line = i + 1;
    const date = parseDate(row[m.date] ?? "", m.dateFormat);
    if (!date) return errors.push({ line, message: `Unreadable date "${row[m.date] ?? ""}"` });
    let amount: number | null;
    if (m.amount !== null) amount = parseCents(row[m.amount] ?? "");
    else {
      const debit = m.debit !== null && row[m.debit] ? parseCents(row[m.debit]!) : 0;
      const credit = m.credit !== null && row[m.credit] ? parseCents(row[m.credit]!) : 0;
      amount = debit === null || credit === null ? null : credit - Math.abs(debit);
    }
    if (amount === null) return errors.push({ line, message: "Unreadable amount" });
    if (m.invert) amount = -amount;
    txns.push({
      line,
      externalId: null,
      date,
      amount,
      payee: (m.payee !== null ? (row[m.payee] ?? "") : "").slice(0, 100),
      notes: (m.notes !== null ? (row[m.notes] ?? "") : "").slice(0, 1000),
    });
  });
  return { txns, errors };
}
