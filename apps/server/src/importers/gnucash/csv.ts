import { createHash } from "node:crypto";
import { parseCsv } from "../bank/parse";
import { BookError, type GncAccount, type GncBook, type GncSplit, type GncTransaction } from "./read";

/**
 * GnuCash's "Export Transactions to CSV" (File → Export), full layout: one row per split, with the
 * transaction's date, ID and description repeated on each row (older versions leave them blank on
 * a transaction's later rows). Accounts appear only as full names, so they get stable synthetic
 * IDs, and their types are inferred: an account whose amounts carry a commodity other than the
 * currency is a holding, its ancestors are asset accounts, and anything in another top-level tree
 * is left for the user to map (skipped by default).
 */

const REQUIRED = ["Transaction ID", "Full Account Name", "Amount Num.", "Value Num."];

export function isGnucashCsv(text: string) {
  const header = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  return REQUIRED.every((h) => header.includes(h));
}

/** "1,183.993", "-1.183,993", "(45.10)" -> "-1183.993" style plain decimal, or null. */
function normaliseNumber(raw: string): string | null {
  let s = raw.trim().replace(/\s/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (s === "") return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: whichever comes last is the decimal separator.
    s = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    // Commas only: thousands separators if they group by three, otherwise a decimal comma.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  if (!/^\d*(\.\d*)?$/.test(s) || s === ".") return null;
  return (neg ? "-" : "") + s;
}

/** A plain decimal string to integer units of 10^-places, rounded half away from zero, exactly. */
function toUnits(decimal: string, places: number): number {
  const neg = decimal.startsWith("-");
  const [int = "0", frac = ""] = decimal.replace("-", "").split(".");
  const padded = (frac + "0".repeat(places + 1)).slice(0, places + 1);
  let units = BigInt(int || "0") * 10n ** BigInt(places) + BigInt(padded.slice(0, places) || "0");
  if (Number(padded[places]) >= 5) units += 1n;
  return Number(neg ? -units : units);
}

/** Dates come in the locale's format; work out day/month order from the whole file. */
function dateParser(samples: string[]) {
  let dayFirst = false;
  for (const s of samples) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) {
      dayFirst = false;
      break;
    }
  }
  return (raw: string): string | null => {
    const s = raw.trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    let y: string, mo: string, d: string;
    if (iso) [, y, mo, d] = iso as unknown as [string, string, string, string];
    else {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
      if (!m) return null;
      [mo, d] = dayFirst ? [m[2]!, m[1]!] : [m[1]!, m[2]!];
      y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    }
    const date = `${y.padStart(4, "0")}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const t = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(t.getTime()) || !t.toISOString().startsWith(date) ? null : date;
  };
}

const accountGuid = (path: string) => createHash("md5").update(`gnucash-csv:${path}`).digest("hex");

/**
 * Mutual fund or stock? US fund tickers are five letters ending in X, and a holding without a
 * ticker at all (just a name, as 401k plans often show) is a fund too.
 */
const looksLikeFund = (mnemonic: string, name: string) =>
  /^[A-Z]{4}X$/.test(mnemonic) ||
  !/^[A-Za-z0-9.\-^=]{1,10}$/.test(mnemonic) ||
  /\b(fund|index|indx|idx|inx|portfolio|trust)\b/i.test(name);

export function readGnucashCsv(text: string): GncBook {
  const rows = parseCsv(text);
  const header = rows[0] ?? [];
  const col = (name: string) => header.indexOf(name);
  const idx = {
    date: col("Date"),
    id: col("Transaction ID"),
    num: col("Number"),
    description: col("Description"),
    notes: col("Notes"),
    currency: col("Commodity/Currency"),
    void: col("Void Reason"),
    memo: col("Memo"),
    account: col("Full Account Name"),
    accountName: col("Account Name"),
    amountSym: col("Amount With Sym"),
    amount: col("Amount Num."),
    value: col("Value Num."),
    reconcile: col("Reconcile"),
  };
  if (idx.id < 0 || idx.account < 0 || idx.amount < 0 || idx.value < 0 || idx.date < 0) {
    throw new BookError(
      "This CSV doesn't have GnuCash's transaction columns. In GnuCash use File → Export → Export Transactions to CSV, and leave \"Use simple layout\" unticked.",
    );
  }
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const data = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  const parseDate = dateParser(
    data
      .map((r) => cell(r, idx.date))
      .filter(Boolean)
      .slice(0, 2000),
  );

  // Commodities per account: a holding's "Amount With Sym" reads "751.932 FCNTX".
  const commodityOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  let currency = "USD";
  for (const r of data) {
    const path = cell(r, idx.account);
    if (!path) continue;
    nameOf.set(path, cell(r, idx.accountName) || path.split(":").at(-1)!);
    const cur = /^CURRENCY::(.+)$/.exec(cell(r, idx.currency))?.[1];
    if (cur) currency = cur;
    // A trailing commodity that isn't the currency itself (some locales write "1.234,56 €").
    const sym = /^[-+(]?[\d.,]+\)?\s+(.+)$/.exec(cell(r, idx.amountSym))?.[1]?.trim();
    if (sym && /[A-Za-z0-9]/.test(sym) && sym !== currency && !commodityOf.has(path)) commodityOf.set(path, sym);
  }

  // Build the account tree from the full names, creating parents as needed.
  const paths = new Set<string>();
  for (const path of nameOf.keys()) {
    const parts = path.split(":");
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join(":"));
  }
  const holdings = [...commodityOf.keys()];
  const holdingTops = new Set(holdings.map((p) => p.split(":")[0]));
  const accounts: GncAccount[] = [...paths].sort().map((path) => {
    const parts = path.split(":");
    const commodity = commodityOf.get(path);
    const name = nameOf.get(path) ?? parts.at(-1)!;
    let type: string;
    if (commodity) type = looksLikeFund(commodity, name) ? "MUTUAL" : "STOCK";
    else if (holdingTops.has(parts[0])) type = "ASSET";
    else type = "UNKNOWN";
    return {
      guid: accountGuid(path),
      name: parts.at(-1)!,
      path,
      type,
      parentGuid: parts.length > 1 ? accountGuid(parts.slice(0, -1).join(":")) : null,
      commodity: commodity ?? currency,
      commodityName: commodity ? name : "",
      commodityNamespace: commodity && looksLikeFund(commodity, name) ? "FUND" : "",
      placeholder: !nameOf.has(path),
      hidden: false,
    };
  });
  if (accounts.length === 0) throw new BookError("That CSV has no transactions in it.");

  // Group rows into transactions, carrying transaction fields onto rows that leave them blank.
  const byId = new Map<string, GncTransaction>();
  let last = { id: "", date: "", num: "", description: "", notes: "", void: "" };
  data.forEach((r, i) => {
    const line = i + 2;
    const id = cell(r, idx.id) || last.id;
    if (cell(r, idx.id)) {
      last = {
        id,
        date: cell(r, idx.date),
        num: cell(r, idx.num),
        description: cell(r, idx.description),
        notes: cell(r, idx.notes),
        void: cell(r, idx.void),
      };
    }
    const path = cell(r, idx.account);
    if (!id || !path) return;
    if (!/^[0-9a-f]{32}$/i.test(id)) throw new BookError(`Line ${line}: "${id}" isn't a GnuCash transaction ID`);
    const date = parseDate(last.date);
    if (!date) throw new BookError(`Line ${line}: unreadable date "${last.date}"`);
    const amount = normaliseNumber(cell(r, idx.amount));
    const value = normaliseNumber(cell(r, idx.value));
    if (amount === null || value === null) throw new BookError(`Line ${line}: unreadable amount`);

    let tx = byId.get(id.toLowerCase());
    if (!tx) {
      tx = {
        guid: id.toLowerCase(),
        date,
        num: last.num,
        description: last.description,
        notes: last.notes,
        currency,
        splits: [],
      };
      byId.set(tx.guid, tx);
    }
    // A voided transaction keeps its splits at zero, so it's skipped like in a book import.
    const voided = last.void !== "";
    const split: GncSplit = {
      guid: createHash("md5").update(`${tx.guid}:${tx.splits.length}:${path}`).digest("hex"),
      accountGuid: accountGuid(path),
      memo: cell(r, idx.memo),
      reconcile: (cell(r, idx.reconcile) || "n").slice(0, 1).toLowerCase(),
      value: voided ? 0 : toUnits(value, 2),
      quantity: voided ? 0 : toUnits(amount, 2),
      shares: voided ? 0 : toUnits(amount, 6),
    };
    tx.splits.push(split);
  });

  const transactions = [...byId.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.guid.localeCompare(b.guid),
  );
  return { currency, accounts, transactions, prices: [] };
}
