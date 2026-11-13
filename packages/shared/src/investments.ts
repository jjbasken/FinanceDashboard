import { z } from "zod";
import { addMonths } from "./budget";
import { centsSchema, dateSchema } from "./ledger";
import { getDisplayCurrency, SHARE_SCALE } from "./money";

/** Prices are integer micro-dollars (1e-6 of the currency unit), like shares are micro-shares. */
export const PRICE_SCALE = 1_000_000;

export const SECURITY_TYPES = ["stock", "etf", "mutual_fund", "bond", "crypto", "other"] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];
export const SECURITY_TYPE_LABELS: Record<SecurityType, string> = {
  stock: "Stock",
  etf: "ETF",
  mutual_fund: "Mutual fund",
  bond: "Bond",
  crypto: "Crypto",
  other: "Other",
};

export const INVESTMENT_ACTIONS = [
  "buy",
  "sell",
  "dividend",
  "reinvest",
  "split",
  "transfer_in",
  "transfer_out",
] as const;
export type InvestmentAction = (typeof INVESTMENT_ACTIONS)[number];
export const INVESTMENT_ACTION_LABELS: Record<InvestmentAction, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  reinvest: "Reinvested dividend",
  split: "Split",
  transfer_in: "Shares in",
  transfer_out: "Shares out",
};

/** Parse "12.5" or "1,000" into micro-units (6 decimal places). Null if invalid. */
function parseMicros(input: string): number | null {
  const s = input.trim().replace(/[$,\s]/g, "");
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const value = Number(m[1] || "0") * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

/** Micro-units to a plain decimal string with up to 6 places, trailing zeros trimmed (min `minDecimals`). */
function microsToString(micros: number, minDecimals = 0): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  let frac = String(abs % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  return `${sign}${Math.trunc(abs / 1_000_000)}${frac ? `.${frac}` : ""}`;
}

export const parseShares = parseMicros;
export const parsePrice = parseMicros;
export const sharesToString = (micro: number) => microsToString(micro);
export const priceToString = (micros: number) => microsToString(micros, 2);

/** A price per share for display, e.g. "$380.27" or "€12.3456", keeping up to 6 decimals. */
export function formatPrice(micros: number, currency = getDisplayCurrency()): string {
  const symbol =
    new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? "";
  return `${micros < 0 ? "-" : ""}${symbol}${priceToString(Math.abs(micros))}`;
}

/** shares × price in cents, rounded half away from zero, computed exactly with BigInt. */
export function sharesValueCents(sharesMicro: number, priceMicros: number): number {
  const product = BigInt(sharesMicro) * BigInt(priceMicros); // in 1e-12 currency units
  const scale = BigInt((SHARE_SCALE * PRICE_SCALE) / 100); // 1e10 -> cents
  const neg = product < 0n;
  const abs = neg ? -product : product;
  const cents = (abs + scale / 2n) / scale;
  return Number(neg ? -cents : cents);
}

/** cents ÷ shares as a price in micros, rounded. */
export function priceFromValue(cents: number, sharesMicro: number): number {
  if (sharesMicro === 0) return 0;
  const num = BigInt(Math.abs(cents)) * BigInt((SHARE_SCALE * PRICE_SCALE) / 100);
  const den = BigInt(Math.abs(sharesMicro));
  return Number((num + den / 2n) / den);
}

const id = z.number().int().positive();
const micro = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const createSecurityInput = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Symbol is required")
    .max(24)
    .regex(/^[A-Z0-9.\-^=]+$/, "Use the ticker symbol, e.g. VTI or BRK-B"),
  name: z.string().trim().min(1, "Name is required").max(120),
  type: z.enum(SECURITY_TYPES),
  /** Fetch daily prices automatically. */
  autoPrice: z.boolean().optional(),
});
export type CreateSecurityInput = z.infer<typeof createSecurityInput>;
export const updateSecurityInput = createSecurityInput.partial();
export type UpdateSecurityInput = z.infer<typeof updateSecurityInput>;

export const manualPriceInput = z.object({ date: dateSchema, price: micro.min(1, "Enter a price") });

/** Actions whose shares can vest over time (a purchase or a grant moved in). */
export const VESTING_ACTIONS: InvestmentAction[] = ["buy", "transfer_in"];

/** One vest date: on `date`, `shares` (micro-shares) of the purchase become vested. */
export const vestingTrancheInput = z.object({ date: dateSchema, shares: micro.min(1, "Enter the shares that vest") });
export type VestingTranche = z.infer<typeof vestingTrancheInput>;

/** A date `n` months later; a day past the end of a shorter month moves to its last day. */
export function addMonthsToDate(date: string, n: number): string {
  const month = addMonths(date.slice(0, 7), n);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${month}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, "0")}`;
}

/**
 * Split `total` micro-shares into `count` equal vests, `everyMonths` apart from `firstDate`.
 * Days past the end of a shorter month move to its last day; the last vest takes any remainder.
 */
export function evenVestingSchedule(
  total: number,
  count: number,
  firstDate: string,
  everyMonths: number,
): VestingTranche[] {
  if (total <= 0 || count < 1) return [];
  const each = Math.floor(total / count);
  const out: VestingTranche[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      date: addMonthsToDate(firstDate, i * everyMonths),
      shares: i === count - 1 ? total - each * (count - 1) : each,
    });
  }
  return out.filter((t) => t.shares > 0);
}

/**
 * One investment transaction. What's required depends on the action:
 * - buy/sell: shares, price; optional fees and an exact cash `amount` from the statement.
 * - dividend: amount (cash received).
 * - reinvest: shares, price (a dividend used to buy shares; no cash moves).
 * - split: splitNew and splitOld, e.g. 2 for 1.
 * - transfer_in: shares and amount (their cost basis); transfer_out: shares.
 */
export const investmentTxnInput = z.object({
  accountId: id,
  securityId: id,
  date: dateSchema,
  action: z.enum(INVESTMENT_ACTIONS),
  shares: micro.optional(),
  price: micro.optional(),
  fees: centsSchema.min(0).optional(),
  amount: centsSchema.min(0).optional(),
  splitNew: z.number().int().positive().max(1_000_000).optional(),
  splitOld: z.number().int().positive().max(1_000_000).optional(),
  notes: z.string().trim().max(1000).optional(),
  /**
   * For a buy or shares moved in: when the shares vest. Shares not listed vest on the
   * transaction date. On an update, leaving it out keeps the existing schedule; [] clears it.
   */
  vesting: z.array(vestingTrancheInput).max(240, "That's too many vest dates").optional(),
});
export type InvestmentTxnInput = z.infer<typeof investmentTxnInput>;

export interface Security {
  id: number;
  symbol: string;
  name: string;
  type: SecurityType;
  currency: string;
  autoPrice: boolean;
  latestPrice: number | null;
  latestPriceDate: string | null;
}

export interface SecurityLookup {
  symbol: string;
  name: string;
  type: SecurityType;
  currency: string;
  price: number | null;
}

export interface InvestmentTxn {
  id: number;
  accountId: number;
  securityId: number;
  date: string;
  action: InvestmentAction;
  /** Signed change in micro-shares. */
  shares: number;
  /** Price per share in micros (0 when not applicable). */
  price: number;
  fees: number;
  /** Cost (buy, reinvest, transfer in), proceeds (sell) or cash received (dividend), in cents. */
  amount: number;
  /** The linked cash transaction in the account's register, if cash moved. */
  transactionId: number | null;
  notes: string;
  /** For splits entered here, the ratio (e.g. 2 for 1). Null for imported splits. */
  splitNew: number | null;
  splitOld: number | null;
  /** Vest dates, oldest first, in micro-shares as entered (before any later splits). Empty if none. */
  vesting: VestingTranche[];
}

export interface Holding {
  securityId: number;
  symbol: string;
  name: string;
  type: SecurityType;
  /** Micro-shares held. */
  shares: number;
  /** Latest price in micros, or null if there's none yet. */
  price: number | null;
  priceDate: string | null;
  /** Market value in cents (0 without a price). */
  value: number;
  /** Average-cost basis of the shares held, in cents. */
  cost: number;
  gain: number;
  /** False when some shares came in with no cost basis (e.g. opening shares from a statement). */
  costKnown: boolean;
  /** Micro-shares that haven't vested yet (included in `shares` and `value`). */
  unvestedShares: number;
  /** The next vest date and its micro-shares, or null when nothing is left to vest. */
  nextVest: VestingTranche | null;
}

/** A vest date still to come, with shares adjusted for any splits since the purchase. */
export interface UpcomingVest {
  investmentTxnId: number;
  accountId: number;
  securityId: number;
  symbol: string;
  date: string;
  shares: number;
  /** At the latest price, in cents (0 without a price). */
  value: number;
}

export interface AccountHoldings {
  accountId: number;
  accountName: string;
  cash: number;
  holdings: Holding[];
  /** cash + holdings value */
  value: number;
}

export interface HoldingsSummary {
  accounts: AccountHoldings[];
  /** cost and gain cover only holdings whose cost is known; costUnknownValue is the value of the rest. */
  totals: {
    cash: number;
    value: number;
    cost: number;
    gain: number;
    holdingsValue: number;
    costUnknownValue: number;
    /** Value of shares not vested yet (already counted in holdingsValue and value). */
    unvestedValue: number;
  };
  /** Vest dates still to come, soonest first. */
  vesting: UpcomingVest[];
}

export interface ValuePoint {
  date: string;
  /** Holdings market value plus investment-account cash, in cents. */
  value: number;
  /** Cost basis of holdings plus cash, in cents. */
  invested: number;
}

export interface PriceRefreshResult {
  updated: number;
  errors: { symbol: string; message: string }[];
}
