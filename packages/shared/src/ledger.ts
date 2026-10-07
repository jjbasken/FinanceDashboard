import { z } from "zod";

export const ACCOUNT_TYPES = ["checking", "savings", "credit", "cash", "investment", "loan", "asset"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  cash: "Cash",
  investment: "Investment",
  loan: "Loan",
  asset: "Other asset",
};

/** Whether a new account of this type is on-budget unless the user says otherwise. */
export function defaultOnBudget(type: AccountType) {
  return type === "checking" || type === "savings" || type === "credit" || type === "cash";
}

/** Amounts are integer cents; keep them inside the range where doubles are exact. */
const MAX_CENTS = 1e13;
export const centsSchema = z
  .number()
  .int("Amount must be whole cents")
  .min(-MAX_CENTS, "Amount is too large")
  .max(MAX_CENTS, "Amount is too large");

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Invalid date");

const idSchema = z.number().int().positive();
const nameSchema = z.string().trim().min(1, "Name is required").max(100);
const notesSchema = z.string().trim().max(1000);

// --- Accounts ---

export const createAccountInput = z.object({
  name: nameSchema,
  type: z.enum(ACCOUNT_TYPES),
  onBudget: z.boolean().optional(),
  startingBalance: centsSchema.optional(),
  startingDate: dateSchema.optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const updateAccountInput = z
  .object({
    name: nameSchema,
    type: z.enum(ACCOUNT_TYPES),
    onBudget: z.boolean(),
    closed: z.boolean(),
    sortOrder: z.number().int(),
    /** A folder in the account's sidebar section, or null for the top of the section. */
    folderId: idSchema.nullable(),
  })
  .partial();
export type UpdateAccountInput = z.infer<typeof updateAccountInput>;

export const reconcileInput = z.object({
  /** The statement balance the user is reconciling to; must equal the cleared balance. */
  statementBalance: centsSchema,
});
export type ReconcileInput = z.infer<typeof reconcileInput>;

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  onBudget: boolean;
  closed: boolean;
  sortOrder: number;
  folderId: number | null;
  /** Sum of all transactions, in cents. */
  balance: number;
  /** Sum of cleared and reconciled transactions, in cents. */
  clearedBalance: number;
  /** Market value of investments held in this account, in cents (on top of `balance`, which is cash). */
  holdingsValue: number;
  /** The payee that represents a transfer into this account. */
  transferPayeeId: number;
}

// --- Account folders ---

/**
 * The sidebar sections accounts are listed in. An account's section follows from whether it's
 * on budget and its type; folders belong to one section and only hold that section's accounts.
 */
export const ACCOUNT_SECTIONS = ["budget", "offbudget", "investment"] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

export function accountSection(a: { onBudget: boolean; type: AccountType }): AccountSection {
  if (a.onBudget) return "budget";
  return a.type === "investment" ? "investment" : "offbudget";
}

export const createAccountFolderInput = z.object({
  name: nameSchema,
  section: z.enum(ACCOUNT_SECTIONS),
  /** Create it inside another folder of the same section. */
  parentId: idSchema.nullable().optional(),
});
export type CreateAccountFolderInput = z.infer<typeof createAccountFolderInput>;

export const updateAccountFolderInput = z.object({ name: nameSchema });
export type UpdateAccountFolderInput = z.infer<typeof updateAccountFolderInput>;

const sidebarItem = z.object({ kind: z.enum(["account", "folder"]), id: idSchema });
export type SidebarItem = z.infer<typeof sidebarItem>;

/** Move an account or folder into a folder (or the top of its section), before a sibling or to the end. */
export const moveSidebarItemInput = z.object({
  item: sidebarItem,
  parentId: idSchema.nullable(),
  before: sidebarItem.nullable(),
});
export type MoveSidebarItemInput = z.infer<typeof moveSidebarItemInput>;

export interface AccountFolder {
  id: number;
  name: string;
  section: AccountSection;
  parentId: number | null;
  sortOrder: number;
}

/**
 * The order of a folder's (or section's) children: accounts and folders share one sort order,
 * with folders first on a tie.
 */
export function compareSidebarItems(
  a: { kind: SidebarItem["kind"]; id: number; sortOrder: number },
  b: { kind: SidebarItem["kind"]; id: number; sortOrder: number },
) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.id - b.id;
}

// --- Payees ---

export const updatePayeeInput = z.object({ name: nameSchema });

/** Move every transaction from the source payees to the target, then delete the sources. */
export const mergePayeesInput = z.object({
  sourceIds: z.array(idSchema).min(1).max(1000),
  targetId: idSchema,
});
export type UpdatePayeeInput = z.infer<typeof updatePayeeInput>;

export interface Payee {
  id: number;
  name: string;
  /** Set when this payee stands for a transfer to that account. */
  transferAccountId: number | null;
  /** How many transactions use this payee. */
  transactionCount: number;
}

// --- Categories ---

export const createCategoryGroupInput = z.object({
  name: nameSchema,
  isIncome: z.boolean().optional(),
});
export const updateCategoryGroupInput = z
  .object({ name: nameSchema, hidden: z.boolean(), sortOrder: z.number().int() })
  .partial();

export const createCategoryInput = z.object({
  groupId: idSchema,
  name: nameSchema,
});
export const updateCategoryInput = z
  .object({
    name: nameSchema,
    groupId: idSchema,
    hidden: z.boolean(),
    sortOrder: z.number().int(),
    /** Income categories only: count this income toward the following month's budget. */
    forNextMonth: z.boolean(),
  })
  .partial();

export type CreateCategoryGroupInput = z.infer<typeof createCategoryGroupInput>;
export type UpdateCategoryGroupInput = z.infer<typeof updateCategoryGroupInput>;
export type CreateCategoryInput = z.infer<typeof createCategoryInput>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryInput>;

export interface Category {
  id: number;
  groupId: number;
  name: string;
  hidden: boolean;
  sortOrder: number;
  /** Income received in this category is budgeted in the following month (e.g. end-of-month pay). */
  forNextMonth: boolean;
}

export interface CategoryGroup {
  id: number;
  name: string;
  isIncome: boolean;
  hidden: boolean;
  sortOrder: number;
  categories: Category[];
}

// --- Transactions ---

export const splitInput = z.object({
  amount: centsSchema,
  categoryId: idSchema.nullable().optional(),
  notes: notesSchema.optional(),
});
export type SplitInput = z.infer<typeof splitInput>;

const transactionFields = {
  date: dateSchema,
  amount: centsSchema,
  /** An existing payee. A transfer payee turns the transaction into a transfer. */
  payeeId: idSchema.nullable(),
  /** Find or create a payee by name; ignored when payeeId is given. */
  payeeName: z.string().trim().max(100),
  categoryId: idSchema.nullable(),
  notes: notesSchema,
  cleared: z.boolean(),
  /** Replaces the transaction's splits. An empty array turns a split back into a plain transaction. */
  splits: z.array(splitInput).max(100),
};

export const createTransactionInput = z
  .object(transactionFields)
  .partial()
  .extend({ accountId: idSchema, date: dateSchema, amount: centsSchema });
export type CreateTransactionInput = z.infer<typeof createTransactionInput>;

export const updateTransactionInput = z.object(transactionFields).partial();
export type UpdateTransactionInput = z.infer<typeof updateTransactionInput>;

export interface TransactionSplit {
  id: number;
  amount: number;
  categoryId: number | null;
  notes: string;
}

export interface Transaction {
  id: number;
  accountId: number;
  date: string;
  amount: number;
  payeeId: number | null;
  categoryId: number | null;
  notes: string;
  cleared: boolean;
  reconciled: boolean;
  /** The other side of a transfer. */
  transferId: number | null;
  /** Set when this row is the cash side of an investment transaction; edit it there. */
  investmentTxnId: number | null;
  /** Empty unless this is a split transaction. */
  splits: TransactionSplit[];
  /** Account balance after this transaction, in register order (date, then id). */
  runningBalance: number;
  createdBy: number | null;
  updatedBy: number | null;
}
