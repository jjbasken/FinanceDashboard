import { addMonths, sharesValueCents, type AccountHoldings, type HoldingsSummary, type ValuePoint } from "@fd/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { accounts, investmentTxns, prices, securities, transactions } from "../db/schema";
import { listAccounts } from "./ledger";

type TxnRow = {
  accountId: number;
  securityId: number;
  date: string;
  action: string;
  shares: number;
  price: number;
  amount: number;
};

export function loadTxns(db: DbOrTx, householdId: number): TxnRow[] {
  return db
    .select({
      accountId: investmentTxns.accountId,
      securityId: investmentTxns.securityId,
      date: investmentTxns.date,
      action: investmentTxns.action,
      shares: investmentTxns.shares,
      price: investmentTxns.price,
      amount: investmentTxns.amount,
    })
    .from(investmentTxns)
    .where(eq(investmentTxns.householdId, householdId))
    .orderBy(asc(investmentTxns.date), asc(investmentTxns.id))
    .all();
}

/** Running position for one account and security, using average cost. */
export class Position {
  shares = 0;
  cost = 0;

  apply(t: TxnRow) {
    if (t.action === "buy" || t.action === "reinvest" || t.action === "transfer_in") {
      this.shares += t.shares;
      this.cost += t.amount;
    } else if (t.action === "sell" || t.action === "transfer_out") {
      // Selling some shares removes their share of the cost basis.
      if (this.shares > 0) this.cost -= Math.round((this.cost * -t.shares) / this.shares);
      this.shares += t.shares;
      if (this.shares === 0) this.cost = 0;
    } else if (t.action === "split") {
      this.shares += t.shares;
    }
  }
}

/** Price history for each security, oldest first, with trade prices filling in where there are no quotes. */
export function loadPriceSeries(db: DbOrTx, householdId: number, txns: TxnRow[]) {
  const rows = db
    .select({ securityId: prices.securityId, date: prices.date, close: prices.close })
    .from(prices)
    .innerJoin(securities, eq(securities.id, prices.securityId))
    .where(eq(securities.householdId, householdId))
    .orderBy(asc(prices.date))
    .all();
  const series = new Map<number, { date: string; close: number }[]>();
  for (const r of rows) {
    const list = series.get(r.securityId) ?? [];
    list.push({ date: r.date, close: r.close });
    series.set(r.securityId, list);
  }
  // Trade prices are used only for securities with no quotes at all, so a fresh import or a
  // security without a ticker still shows a sensible value.
  const quoted = new Set(series.keys());
  for (const t of txns) {
    if (t.price <= 0 || quoted.has(t.securityId)) continue;
    const list = series.get(t.securityId) ?? [];
    list.push({ date: t.date, close: t.price });
    series.set(t.securityId, list);
  }
  for (const list of series.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return series;
}

/** The last price on or before a date, by binary search. */
export function priceOn(series: { date: string; close: number }[] | undefined, date: string) {
  if (!series?.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : series[found]!;
}

export function getHoldings(db: DbOrTx, householdId: number): HoldingsSummary {
  const txns = loadTxns(db, householdId);
  const positions = new Map<string, Position>();
  for (const t of txns) {
    const key = `${t.accountId}:${t.securityId}`;
    const p = positions.get(key) ?? new Position();
    p.apply(t);
    positions.set(key, p);
  }
  const series = loadPriceSeries(db, householdId, txns);
  const secs = new Map(
    db
      .select({ id: securities.id, symbol: securities.symbol, name: securities.name, type: securities.type })
      .from(securities)
      .where(eq(securities.householdId, householdId))
      .all()
      .map((s) => [s.id, s]),
  );

  const withHoldings = new Set(txns.map((t) => t.accountId));
  const accts = listAccounts(db, householdId).filter(
    (a) => !a.closed && (a.type === "investment" || withHoldings.has(a.id)),
  );
  const result: AccountHoldings[] = accts.map((a) => {
    const holdings = [...positions]
      .filter(([key, p]) => key.startsWith(`${a.id}:`) && p.shares !== 0)
      .map(([key, p]) => {
        const securityId = Number(key.split(":")[1]);
        const s = secs.get(securityId)!;
        const last = series.get(securityId)?.at(-1) ?? null;
        const value = last ? sharesValueCents(p.shares, last.close) : 0;
        return {
          securityId,
          symbol: s.symbol,
          name: s.name,
          type: s.type,
          shares: p.shares,
          price: last?.close ?? null,
          priceDate: last?.date ?? null,
          value,
          cost: p.cost,
          gain: value - p.cost,
        };
      })
      .sort((x, y) => y.value - x.value);
    const holdingsValue = holdings.reduce((s, h) => s + h.value, 0);
    return { accountId: a.id, accountName: a.name, cash: a.balance, holdings, value: a.balance + holdingsValue };
  });

  const all = result.flatMap((r) => r.holdings);
  const holdingsValue = all.reduce((s, h) => s + h.value, 0);
  const cost = all.reduce((s, h) => s + h.cost, 0);
  const cash = result.reduce((s, r) => s + r.cash, 0);
  return {
    accounts: result,
    totals: { cash, holdingsValue, value: cash + holdingsValue, cost, gain: holdingsValue - cost },
  };
}

/** Market value of each account's holdings (not its cash), in cents. */
export function holdingsValueByAccount(db: DbOrTx, householdId: number) {
  const txns = loadTxns(db, householdId);
  if (txns.length === 0) return new Map<number, number>();
  const shares = new Map<string, number>();
  for (const t of txns) {
    const key = `${t.accountId}:${t.securityId}`;
    shares.set(key, (shares.get(key) ?? 0) + t.shares);
  }
  const series = loadPriceSeries(db, householdId, txns);
  const out = new Map<number, number>();
  for (const [key, n] of shares) {
    const [accountId, securityId] = key.split(":").map(Number) as [number, number];
    const last = series.get(securityId)?.at(-1);
    if (last && n) out.set(accountId, (out.get(accountId) ?? 0) + sharesValueCents(n, last.close));
  }
  return out;
}

export const HISTORY_RANGES = ["3m", "1y", "5y", "all"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

/** Dates to plot: daily for 3 months, weekly for a year, month ends beyond. Always ends today. */
export function sampleDates(range: HistoryRange, first: string, today: string) {
  const dates: string[] = [];
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(`${today}T00:00:00Z`);
  if (range === "3m") start.setUTCMonth(start.getUTCMonth() - 3);
  else if (range === "1y") start.setUTCFullYear(start.getUTCFullYear() - 1);
  else if (range === "5y") start.setUTCFullYear(start.getUTCFullYear() - 5);
  let from = range === "all" ? first : day(start);
  if (from < first) from = first;

  if (range === "3m" || range === "1y") {
    const step = range === "3m" ? 1 : 7;
    for (let d = new Date(`${from}T00:00:00Z`); day(d) < today; d.setUTCDate(d.getUTCDate() + step)) dates.push(day(d));
  } else {
    // Month ends.
    for (let m = from.slice(0, 7); m < today.slice(0, 7); m = addMonths(m, 1)) {
      const end = new Date(`${addMonths(m, 1)}-01T00:00:00Z`);
      end.setUTCDate(0);
      dates.push(day(end));
    }
  }
  dates.push(today);
  return dates;
}

/**
 * Value over time of every account that holds investments: cash plus holdings at each date's
 * price, and the amount invested (cash plus cost basis).
 */
export function valueHistory(db: DbOrTx, householdId: number, range: HistoryRange, today: string): ValuePoint[] {
  const txns = loadTxns(db, householdId);
  const accountIds = new Set([
    ...txns.map((t) => t.accountId),
    ...db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.householdId, householdId), eq(accounts.type, "investment")))
      .all()
      .map((a) => a.id),
  ]);
  if (accountIds.size === 0) return [];

  const cashRows = db
    .select({
      accountId: transactions.accountId,
      date: transactions.date,
      amount: sql<number>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .where(and(eq(transactions.householdId, householdId), isNull(transactions.parentId)))
    .groupBy(transactions.accountId, transactions.date)
    .orderBy(asc(transactions.date))
    .all()
    .filter((r) => accountIds.has(r.accountId));

  const first = [cashRows[0]?.date, txns[0]?.date].filter(Boolean).sort()[0];
  if (!first) return [];
  const series = loadPriceSeries(db, householdId, txns);
  const positions = new Map<string, Position>();
  let cash = 0;
  let ci = 0;
  let ti = 0;
  const points: ValuePoint[] = [];
  for (const date of sampleDates(range, first, today)) {
    while (ci < cashRows.length && cashRows[ci]!.date <= date) cash += cashRows[ci++]!.amount;
    while (ti < txns.length && txns[ti]!.date <= date) {
      const t = txns[ti++]!;
      const key = `${t.accountId}:${t.securityId}`;
      const p = positions.get(key) ?? new Position();
      p.apply(t);
      positions.set(key, p);
    }
    let value = cash;
    let invested = cash;
    for (const [key, p] of positions) {
      if (!p.shares) continue;
      const price = priceOn(series.get(Number(key.split(":")[1])), date);
      value += price ? sharesValueCents(p.shares, price.close) : 0;
      invested += p.cost;
    }
    points.push({ date, value, invested });
  }
  return points;
}
