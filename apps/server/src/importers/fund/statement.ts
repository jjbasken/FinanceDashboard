import {
  FUND_ACTIVITY_LABELS,
  parseCents,
  parsePrice,
  parseShares,
  sharesValueCents,
  type FundActivityKind,
  type FundStatementFund,
  type FundStatementItem,
  type InvestmentTxnInput,
} from "@fd/shared";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { importBatches, investmentTxns, prices, securities, transactions } from "../../db/schema";
import { createInvestmentTxn, createSecurity } from "../../services/investments";
import { findOrCreatePayee, type Actor } from "../../services/ledger";
import { BankFileError, parseCsv } from "../bank/parse";

export interface Holding {
  line: number;
  fund: string;
  price: number | null;
  shares: number;
}

export interface StatementTxn {
  line: number;
  accountNumber: string;
  date: string;
  type: string;
  fund: string;
  kind: FundActivityKind;
  shares: number;
  price: number;
  amount: number;
}

export interface Statement {
  holdings: Holding[];
  txns: StatementTxn[];
  errors: { line: number; message: string }[];
}

const lower = (row: string[]) => row.map((c) => c.toLowerCase());
const isHoldingsHeader = (row: string[]) => row.includes("fund name") && row.includes("shares");
const isTxnHeader = (row: string[]) => row.includes("trade date") && row.includes("transaction type");

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "10/01/2026" -> "2026-10-01", or null. */
function usDate(raw: string) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const date = `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(date) ? date : null;
}

/** Shares may be negative ("-2.5", "(2.5)") on the way out; returns signed micro-shares. */
function signedShares(raw: string) {
  const s = raw.trim();
  const negative = s.startsWith("-") || /^\(.*\)$/.test(s);
  const value = parseShares(s.replace(/^-|^\(|\)$/g, ""));
  return value === null ? null : negative ? -value : value;
}

/** Read a statement type like "Recurring Contribution" as what it does to the account. */
export function classify(type: string, shares: number): FundActivityKind | null {
  const t = type.toLowerCase();
  if (/reinvest|dividend|capital gain|interest/.test(t)) return "reinvest";
  if (/\bfee/.test(t)) return "fee";
  if (/exchange|transfer|rebalanc/.test(t)) return shares < 0 || /\bout\b/.test(t) ? "exchange_out" : "exchange_in";
  if (/withdraw|redemption|distribution/.test(t)) return "withdrawal";
  if (/contribution|purchase|deposit|rollover/.test(t)) return "contribution";
  return null;
}

/**
 * Read a fund statement CSV: a holdings section (Fund Name, Price, Shares, ...) and a
 * transaction section (Trade Date, Transaction Type, Investment Name, Share Price, Shares,
 * Gross Amount, Net Amount, ...). Each section starts at its header row; either may be missing.
 */
export function parseFundStatement(text: string): Statement {
  const rows = parseCsv(text);
  // parseCsv drops blank lines; recover each row's line number for messages.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const lineNumbers: number[] = [];
  lines.forEach((l, i) => {
    if (l.split(/[,;\t]/).some((f) => f.trim() !== "")) lineNumbers.push(i + 1);
  });

  const out: Statement = { holdings: [], txns: [], errors: [] };
  let section: "holdings" | "txns" | null = null;
  let cols: Record<string, number> = {};
  const cell = (row: string[], name: string) => (cols[name] === undefined ? "" : (row[cols[name]!] ?? ""));

  rows.forEach((row, i) => {
    const line = lineNumbers[i] ?? i + 1;
    const header = lower(row);
    if (isHoldingsHeader(header) || isTxnHeader(header)) {
      section = isTxnHeader(header) ? "txns" : "holdings";
      cols = Object.fromEntries(header.map((h, j) => [h, j]));
      return;
    }
    if (!section) return;
    const fail = (message: string) => out.errors.push({ line, message });

    if (section === "holdings") {
      const fund = cell(row, "fund name");
      const shares = signedShares(cell(row, "shares"));
      if (!fund || shares === null) return fail("Couldn't read the fund name and shares");
      const price = parsePrice(cell(row, "price"));
      out.holdings.push({ line, fund, price: price || null, shares });
      return;
    }

    const date = usDate(cell(row, "trade date"));
    const type = cell(row, "transaction type") || cell(row, "transaction description");
    const fund = cell(row, "investment name") || cell(row, "fund name");
    const shares = signedShares(cell(row, "shares"));
    const price = parsePrice(cell(row, "share price") || cell(row, "price"));
    if (!date) return fail("Couldn't read the trade date");
    if (!fund) return fail("No investment name");
    if (shares === null || shares === 0) return fail("Couldn't read the shares");
    if (!price) return fail("Couldn't read the share price");
    const kind = classify(type, shares);
    if (!kind) return fail(`Don't know how to import “${type}” transactions`);
    const net = parseCents(cell(row, "net amount"));
    const gross = parseCents(cell(row, "gross amount"));
    const amount = Math.abs(net || gross || sharesValueCents(shares, price));
    out.txns.push({
      line,
      accountNumber: cell(row, "account number") || cell(row, "fund account number"),
      date,
      type,
      fund,
      kind,
      shares: Math.abs(shares),
      price,
      amount,
    });
  });

  if (out.holdings.length === 0 && out.txns.length === 0 && out.errors.length === 0) {
    throw new BankFileError(
      "This doesn't look like a fund statement. It needs a holdings section (Fund Name, Price, Shares) or a transaction history (Trade Date, Transaction Type, Shares).",
    );
  }
  return out;
}

/** A ticker-style symbol for a fund that has none, e.g. "Large-Cap Stock Index Portfolio" -> "LARGE-CAP-STOCK-INDEX". */
export function symbolFor(name: string, taken: Set<string>) {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  let base = "";
  for (const w of words) {
    const next = base ? `${base}-${w}` : w;
    if (next.length > 21) break;
    base = next;
  }
  base ||= (words[0] ?? "FUND").slice(0, 21);
  let symbol = base;
  for (let n = 2; taken.has(symbol); n++) symbol = `${base}-${n}`;
  return symbol;
}

/** Whether each kind of transaction adds shares to the account. */
const ADDS_SHARES: Record<FundActivityKind, boolean> = {
  contribution: true,
  reinvest: true,
  exchange_in: true,
  withdrawal: false,
  exchange_out: false,
  fee: false,
};

export interface PlannedItem extends FundStatementItem {
  importedId: string;
}

export interface FundPlan {
  openingDate: string;
  funds: FundStatementFund[];
  items: PlannedItem[];
  /** Prices to record per fund name: trade-date prices and the statement's current price. */
  prices: { fund: string; date: string; price: number }[];
}

/** Line the statement up with the account: securities, duplicates, and opening shares. */
export function planFundImport(
  db: DbOrTx,
  householdId: number,
  accountId: number,
  statement: Statement,
  today: string,
): FundPlan {
  const existing = db
    .select({ id: securities.id, symbol: securities.symbol, name: securities.name })
    .from(securities)
    .where(eq(securities.householdId, householdId))
    .all();
  const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));
  const taken = new Set(existing.map((s) => s.symbol));

  // Identical rows on the same day are told apart by how many came before them.
  const seen = new Map<string, number>();
  const items: PlannedItem[] = statement.txns.map((t) => {
    const key = [accountId, t.accountNumber, t.date, t.type, t.fund, t.shares, t.amount].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const importedId = `fund:${createHash("sha256").update(`${key}|${n}`).digest("hex").slice(0, 32)}`;
    const { accountNumber: _a, ...rest } = t;
    return { ...rest, importedId, status: "new" };
  });
  const ids = items.map((i) => i.importedId);
  const done = new Set(
    ids.length
      ? db
          .select({ id: investmentTxns.importedId })
          .from(investmentTxns)
          .where(and(eq(investmentTxns.householdId, householdId), inArray(investmentTxns.importedId, ids)))
          .all()
          .map((r) => r.id)
      : [],
  );
  for (const i of items) if (done.has(i.importedId)) i.status = "duplicate";

  const first = items.map((i) => i.date).sort()[0];
  const openingDate = first ? addDays(first, -1) : today;

  const names: string[] = [];
  for (const n of [...statement.holdings.map((h) => h.fund), ...items.map((i) => i.fund)]) {
    if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  const held = (securityId: number) =>
    db.all<{ n: number; c: number }>(sql`
      select coalesce(sum(shares), 0) as n, count(*) as c from investment_txns
      where account_id = ${accountId} and security_id = ${securityId}
    `)[0]!;

  const funds: FundStatementFund[] = names.map((name) => {
    const security = byName.get(name.toLowerCase());
    const symbol = security?.symbol ?? symbolFor(name, taken);
    taken.add(symbol);
    const holding = statement.holdings.find((h) => h.fund.toLowerCase() === name.toLowerCase());
    const current = security ? held(security.id) : { n: 0, c: 0 };
    const importShares = items
      .filter((i) => i.status === "new" && i.fund.toLowerCase() === name.toLowerCase())
      .reduce((sum, i) => sum + (ADDS_SHARES[i.kind] ? i.shares : -i.shares), 0);
    const gap = holding ? holding.shares - current.n - importShares : 0;
    // Opening shares only for a fund the account hasn't recorded before; after that, gaps are reported.
    const openingShares = current.c === 0 && gap > 0 ? gap : 0;
    return {
      name,
      securityId: security?.id ?? null,
      symbol,
      price: holding?.price ?? null,
      statementShares: holding?.shares ?? null,
      currentShares: current.n,
      importShares,
      openingShares,
      difference: holding ? gap - openingShares : 0,
    };
  });

  const planPrices = [
    ...items.filter((i) => i.status === "new").map((i) => ({ fund: i.fund, date: i.date, price: i.price })),
    ...statement.holdings.filter((h) => h.price).map((h) => ({ fund: h.fund, date: today, price: h.price! })),
  ];
  return { openingDate, funds, items, prices: planPrices };
}

/** The investment transaction a statement row becomes. */
function actionFor(kind: FundActivityKind): InvestmentTxnInput["action"] {
  if (kind === "reinvest") return "reinvest";
  return ADDS_SHARES[kind] ? "buy" : "sell";
}

/**
 * Record the plan: securities, opening shares, each new transaction (contributions as a cash
 * deposit that then buys shares; withdrawals and fees as a sale whose cash leaves the account),
 * and the statement's prices. Returns the import batch, or null when there was nothing new.
 */
export function commitFundImport(
  db: DbOrTx,
  actor: Actor,
  accountId: number,
  fileName: string,
  plan: FundPlan,
) {
  const fresh = plan.items.filter((i) => i.status === "new");
  const openings = plan.funds.filter((f) => f.openingShares > 0);
  if (fresh.length === 0 && openings.length === 0) return { batchId: null, created: 0 };

  const batchId = db
    .insert(importBatches)
    .values({
      householdId: actor.householdId,
      source: "fund_csv",
      fileName,
      transactionCount: fresh.length + openings.length,
      createdBy: actor.userId,
    })
    .returning({ id: importBatches.id })
    .get().id;

  const securityIds = new Map<string, number>();
  for (const f of plan.funds) {
    const id =
      f.securityId ??
      createSecurity(db, actor.householdId, { symbol: f.symbol, name: f.name, type: "mutual_fund", autoPrice: false }, batchId)
        .id;
    securityIds.set(f.name.toLowerCase(), id);
  }
  const securityOf = (fund: string) => securityIds.get(fund.toLowerCase())!;

  for (const f of openings) {
    createInvestmentTxn(
      db,
      actor,
      {
        accountId,
        securityId: securityOf(f.name),
        date: plan.openingDate,
        action: "transfer_in",
        shares: f.openingShares,
        amount: 0,
        notes: "Opening shares from statement",
      },
      { importBatchId: batchId },
    );
  }

  const cashRow = (item: PlannedItem, amount: number, payeeName: string, suffix: string) =>
    db
      .insert(transactions)
      .values({
        householdId: actor.householdId,
        accountId,
        date: item.date,
        amount,
        payeeId: findOrCreatePayee(db, actor.householdId, payeeName).id,
        notes: `${item.type} · ${item.fund}`,
        cleared: true,
        importedId: `${item.importedId}:${suffix}`,
        importBatchId: batchId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .run();

  // Oldest first, and shares in before shares out on the same day.
  const ordered = [...fresh].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(ADDS_SHARES[b.kind]) - Number(ADDS_SHARES[a.kind]),
  );
  for (const item of ordered) {
    if (item.kind === "contribution") cashRow(item, item.amount, "Contribution", "deposit");
    createInvestmentTxn(
      db,
      actor,
      {
        accountId,
        securityId: securityOf(item.fund),
        date: item.date,
        action: actionFor(item.kind),
        shares: item.shares,
        price: item.price,
        amount: item.amount,
        notes: item.type,
      },
      { importedId: item.importedId, importBatchId: batchId },
    );
    if (item.kind === "withdrawal" || item.kind === "fee") {
      cashRow(item, -item.amount, FUND_ACTIVITY_LABELS[item.kind], "withdrawal");
    }
  }

  for (const p of plan.prices) {
    db.insert(prices)
      .values({ securityId: securityOf(p.fund), date: p.date, close: p.price, source: "manual" })
      .onConflictDoNothing()
      .run();
  }
  return { batchId, created: fresh.length + openings.length };
}
