import { z } from "zod";
import { centsSchema } from "./ledger";

/** Budget months are "YYYY-MM" strings. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a YYYY-MM month");

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** e.g. "2026-10" -> "October 2026" */
export function formatMonth(month: string, locale = "en-US"): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** e.g. "2026-10" -> "October" */
export function monthName(month: string, locale = "en-US"): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale, { month: "long", timeZone: "UTC" });
}

// --- Usual months: a 12-bit mask, bit 0 = January. 0 means every month (nothing set). ---

/** The highest valid mask: all twelve months. */
export const ALL_MONTHS = 0xfff;

/** Whether a "YYYY-MM" month is one of the mask's months. Always false for an empty mask. */
export function monthInMask(mask: number, month: string): boolean {
  const m = Number(month.slice(5, 7));
  return (mask & (1 << (m - 1))) !== 0;
}

/** The mask's months as numbers 1-12, in calendar order. */
export function maskMonths(mask: number): number[] {
  return Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => mask & (1 << (m - 1)));
}

function shortMonth(m: number, locale: string, style: "short" | "long") {
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString(locale, { month: style, timeZone: "UTC" });
}

/** A short label for a badge: "Mar", "Jan · Jul", or "8 months" when there are more than four. */
export function formatMonthMask(mask: number, locale = "en-US"): string {
  const months = maskMonths(mask);
  if (months.length > 4) return `${months.length} months`;
  return months.map((m) => shortMonth(m, locale, "short")).join(" · ");
}

/** The full list, e.g. "January, July", for a tooltip. */
export function describeMonthMask(mask: number, locale = "en-US"): string {
  return maskMonths(mask)
    .map((m) => shortMonth(m, locale, "long"))
    .join(", ");
}

export const setBudgetInput = z.object({ amount: centsSchema });
export type SetBudgetInput = z.infer<typeof setBudgetInput>;

const id = z.number().int().positive();

/** Move a category into a group, before another category (or to the end when beforeId is null). */
export const moveCategoryInput = z.object({ groupId: id, beforeId: id.nullable() });
export type MoveCategoryInput = z.infer<typeof moveCategoryInput>;

/** Move a group before another group of the same kind (or to the end). */
export const moveGroupInput = z.object({ beforeId: id.nullable() });
export type MoveGroupInput = z.infer<typeof moveGroupInput>;

export interface BudgetCategory {
  id: number;
  name: string;
  hidden: boolean;
  /** Income category whose activity comes from the month before (pay received at the end of last month). */
  forNextMonth: boolean;
  /**
   * Kept out of the budget: never budgeted, and its activity (still shown) doesn't count toward
   * any total. Its balance is 0.
   */
  excludeFromBudget: boolean;
  /** Months this usually comes up (bit 0 = January); 0 means every month. */
  months: number;
  /** It has usual months and this is one of them. */
  due: boolean;
  /** Assigned this month. Always 0 for income categories. */
  budgeted: number;
  /** Net transactions this month (last month for a forNextMonth category); spending is negative. */
  activity: number;
  /** budgeted + activity. Each month starts from zero; nothing carries over. */
  balance: number;
}

export interface BudgetGroup {
  id: number;
  name: string;
  isIncome: boolean;
  hidden: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  categories: BudgetCategory[];
}

/** One month's plan. Months are independent: nothing carries over from the month before. */
export interface BudgetMonth {
  month: string;
  /** Income to budget this month: what came in this month, plus last month's forNextMonth income. */
  income: number;
  /** The part of `income` received last month in forNextMonth categories. */
  incomeFromLastMonth: number;
  /** Total assigned to expense categories this month. */
  budgeted: number;
  /** income - budgeted */
  toBudget: number;
  /** Total expense activity this month (negative when spending). */
  spent: number;
  /** On-budget transactions this month that still need a category. */
  uncategorized: number;
  groups: BudgetGroup[];
}

export interface CategoryActivityItem {
  id: number;
  /** The transaction to open in the register (the parent, for a split). */
  transactionId: number;
  accountId: number;
  /** In another member's private account (included in the budget), so there's no register to open. */
  privateAccount: boolean;
  accountName: string;
  date: string;
  payeeName: string;
  notes: string;
  amount: number;
}
