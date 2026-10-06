import type { PriceRefreshResult, SecurityLookup, SecurityType } from "@fd/shared";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { prices } from "../db/schema";

export interface PriceQuote {
  date: string;
  /** Micro-dollars. */
  close: number;
}

/** Where daily prices come from. Swappable so tests (and future providers) don't hit the network. */
export interface PriceProvider {
  readonly name: "yahoo";
  history(symbol: string, from: string, to: string): Promise<PriceQuote[]>;
  lookup(symbol: string): Promise<SecurityLookup | null>;
}

const YAHOO_TYPES: Record<string, SecurityType> = {
  EQUITY: "stock",
  ETF: "etf",
  MUTUALFUND: "mutual_fund",
  CRYPTOCURRENCY: "crypto",
  BOND: "bond",
};

/** Round a float quote to 4 decimal places and express it in micros. */
const toMicros = (price: number) => Math.round(price * 10_000) * 100;

interface YahooChart {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        currency?: string;
        instrumentType?: string;
        longName?: string;
        shortName?: string;
        gmtoffset?: number;
        regularMarketPrice?: number;
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

/**
 * Yahoo Finance's public chart endpoint: no API key, daily closes for stocks, ETFs and mutual
 * funds. Unofficial, so failures are reported per security rather than breaking anything.
 */
export function yahooProvider(fetchImpl: typeof fetch = fetch): PriceProvider {
  async function chart(symbol: string, query: string) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
    const res = await fetchImpl(url, {
      headers: { "user-agent": "Mozilla/5.0 (FinanceDashboard price refresh)" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as YahooChart | null;
    const result = body?.chart?.result?.[0];
    if (!res.ok || !result) {
      const reason = body?.chart?.error?.description ?? `HTTP ${res.status}`;
      throw new Error(reason.includes("No data found") ? `Unknown symbol ${symbol}` : reason);
    }
    return result;
  }

  return {
    name: "yahoo",
    async history(symbol, from, to) {
      const p1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
      const p2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
      const r = await chart(symbol, `period1=${p1}&period2=${p2}&interval=1d&events=history`);
      const offset = r.meta?.gmtoffset ?? 0;
      const closes = r.indicators?.quote?.[0]?.close ?? [];
      const out: PriceQuote[] = [];
      (r.timestamp ?? []).forEach((ts, i) => {
        const close = closes[i];
        if (close == null || !Number.isFinite(close) || close <= 0) return;
        // Timestamps are market open in UTC; shift to the exchange's local date.
        const date = new Date((ts + offset) * 1000).toISOString().slice(0, 10);
        if (date >= from && date <= to) out.push({ date, close: toMicros(close) });
      });
      return out;
    },
    async lookup(symbol) {
      try {
        const r = await chart(symbol, "interval=1d&range=5d");
        const m = r.meta ?? {};
        return {
          symbol: (m.symbol ?? symbol).toUpperCase(),
          name: m.longName ?? m.shortName ?? symbol,
          type: YAHOO_TYPES[m.instrumentType ?? ""] ?? "other",
          currency: m.currency ?? "USD",
          price: m.regularMarketPrice ? toMicros(m.regularMarketPrice) : null,
        };
      } catch {
        return null;
      }
    },
  };
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Fetch any missing daily prices for securities with automatic pricing, from the day after the
 * last price we have (or the first transaction, up to ten years back) until today. Existing
 * prices, including manual ones, are never overwritten.
 */
export async function refreshPrices(
  db: DbOrTx,
  provider: PriceProvider,
  today: string,
  householdId?: number,
): Promise<PriceRefreshResult> {
  // Plain SQL: drizzle drops table qualifiers in single-table selects, which would make the
  // correlated subqueries compare against the wrong table's id.
  const list = db.all<{ id: number; symbol: string; lastPrice: string | null; firstTxn: string | null }>(sql`
    select s.id as id, s.symbol as symbol,
           (select max(p.date) from prices p where p.security_id = s.id) as lastPrice,
           (select min(t.date) from investment_txns t where t.security_id = s.id) as firstTxn
    from securities s
    where s.auto_price = 1
      -- Skip securities that were held and are now all sold; ones never traded still get prices.
      and not (
        exists (select 1 from investment_txns t where t.security_id = s.id)
        and (select sum(t.shares) from investment_txns t where t.security_id = s.id) = 0
      )
      ${householdId === undefined ? sql`` : sql`and s.household_id = ${householdId}`}
  `);

  const result: PriceRefreshResult = { updated: 0, errors: [] };
  const floor = addDays(today, -3653);
  for (const s of list) {
    let from = s.lastPrice ? addDays(s.lastPrice, 1) : (s.firstTxn ?? addDays(today, -30));
    if (from < floor) from = floor;
    if (from > today) continue;
    try {
      const quotes = await provider.history(s.symbol, from, today);
      for (const q of quotes) {
        const inserted = db
          .insert(prices)
          .values({ securityId: s.id, date: q.date, close: q.close, source: provider.name })
          .onConflictDoNothing()
          .returning({ id: prices.id })
          .all();
        result.updated += inserted.length;
      }
    } catch (err) {
      result.errors.push({ symbol: s.symbol, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
