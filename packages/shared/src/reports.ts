export interface NetWorthPoint {
  date: string;
  /** Sum of accounts worth more than zero (cash plus investments), in cents. */
  assets: number;
  /** Sum of accounts worth less than zero (cards, loans), in cents; zero or negative. */
  liabilities: number;
  netWorth: number;
}

export interface CashFlowMonth {
  month: string;
  income: number;
  /** Spending as a positive number (refunds reduce it). */
  expenses: number;
  net: number;
}

export interface SpendingRow {
  categoryId: number | null;
  name: string;
  groupName: string;
  /** Spending as a positive number. */
  amount: number;
}
