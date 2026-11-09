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

export interface CategoryTotal {
  /** Null for the "Uncategorized" row. */
  categoryId: number | null;
  name: string;
  /** Null for the "Uncategorized" row. Group names needn't be unique, so group by this. */
  groupId: number | null;
  groupName: string;
  /** Income received or money spent, as a positive number. */
  amount: number;
}

/** A month's expense budget against what was spent, as on the budget page. */
export interface BudgetVsActualMonth {
  month: string;
  /** Total assigned to expense categories. */
  budgeted: number;
  /** Expense activity as a positive number (refunds reduce it). */
  spent: number;
  /** budgeted - spent: positive when under budget, negative when over. */
  remaining: number;
}

/** Spending per category, as on the spending report. */
export type SpendingRow = CategoryTotal;

export interface CategoryBreakdown {
  /** Largest first. */
  income: CategoryTotal[];
  /** Largest first, with uncategorized spending as its own row. */
  expenses: CategoryTotal[];
}

export interface CategoryComparison {
  categoryId: number | null;
  name: string;
  groupId: number | null;
  groupName: string;
  isIncome: boolean;
  /** This year, January through `through`. */
  current: number;
  /** The same months of the year before. */
  previous: number;
}

export interface YearComparison {
  year: number;
  /** The last whole month counted this year (YYYY-MM): December for past years. */
  through: string;
  /** The earliest year with any budget activity, for picking a year. */
  firstYear: number;
  /** January through `through`. Unlike the cash flow report, uncategorized spending counts. */
  current: CashFlowMonth[];
  /** All twelve months of the year before, for context; totals use only the matching months. */
  previous: CashFlowMonth[];
  categories: CategoryComparison[];
}
