/**
 * Fund statements: CSV downloads from a 529 plan (or a similar fund company) with a holdings
 * section (fund, price, shares, value) and a transaction history section.
 */

/** What a statement transaction does to the account. */
export const FUND_ACTIVITY_KINDS = [
  "contribution",
  "withdrawal",
  "reinvest",
  "exchange_in",
  "exchange_out",
  "fee",
] as const;
export type FundActivityKind = (typeof FUND_ACTIVITY_KINDS)[number];

export const FUND_ACTIVITY_LABELS: Record<FundActivityKind, string> = {
  contribution: "Contribution",
  withdrawal: "Withdrawal",
  reinvest: "Reinvested earnings",
  exchange_in: "Exchange in",
  exchange_out: "Exchange out",
  fee: "Fee",
};

/** One fund on the statement, and how the import lines it up with the account. */
export interface FundStatementFund {
  name: string;
  /** The security it will be recorded as: an existing one, or one the import creates. */
  securityId: number | null;
  symbol: string;
  /** Price per share on the statement, in micro-dollars; null if the fund isn't in the holdings section. */
  price: number | null;
  /** Shares held per the statement (micro-shares); null if the fund isn't in the holdings section. */
  statementShares: number | null;
  /** Shares the account already holds. */
  currentShares: number;
  /** Shares the new transactions add (negative when they remove shares). */
  importShares: number;
  /** Shares added as opening shares so the account matches the statement. */
  openingShares: number;
  /** What still won't match the statement after the import (statement minus result). */
  difference: number;
}

export interface FundStatementItem {
  /** 1-based line in the file. */
  line: number;
  date: string;
  /** The statement's transaction type, e.g. "Recurring Contribution". */
  type: string;
  fund: string;
  kind: FundActivityKind;
  /** Micro-shares, unsigned. */
  shares: number;
  /** Micro-dollars per share. */
  price: number;
  /** Cents, unsigned. */
  amount: number;
  status: "new" | "duplicate";
}

export interface FundStatementPreview {
  uploadId: string;
  fileName: string;
  accountId: number;
  /** Opening shares are dated the day before the first transaction in the file. */
  openingDate: string;
  funds: FundStatementFund[];
  items: FundStatementItem[];
  counts: { new: number; duplicate: number };
  /** Rows that couldn't be read, 1-based line numbers. */
  errors: { line: number; message: string }[];
}

export interface FundImportResult {
  batchId: number | null;
  /** Investment transactions added, including opening shares. */
  created: number;
}
