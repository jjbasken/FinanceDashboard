import { z } from "zod";
import { ACCOUNT_TYPES } from "./ledger";

const id = z.number().int().positive();
const name = z.string().trim().min(1, "Name is required").max(100);

/** What one GnuCash account becomes here. */
export const gnucashMappingSchema = z.discriminatedUnion("kind", [
  /** An account: an existing one (accountId), or a new one with this name, type and budget status. */
  z.object({
    kind: z.literal("account"),
    accountId: id.nullable(),
    name,
    type: z.enum(ACCOUNT_TYPES),
    onBudget: z.boolean(),
  }),
  /** A category: an existing one (categoryId), or a new one in the named group. */
  z.object({
    kind: z.literal("category"),
    categoryId: id.nullable(),
    groupName: name,
    name,
    isIncome: z.boolean(),
  }),
  /** Equity: money here is an opening balance. */
  z.object({ kind: z.literal("opening") }),
  /** Ignore this account. Its share of a transaction is imported as uncategorized. */
  z.object({ kind: z.literal("skip") }),
]);
export type GnucashMapping = z.infer<typeof gnucashMappingSchema>;

export const gnucashImportInput = z.object({
  /** Keyed by GnuCash account GUID. Accounts left out use the suggested mapping. */
  mappings: z.record(z.string().regex(/^[0-9a-f]{32}$/), gnucashMappingSchema),
});
export type GnucashImportInput = z.infer<typeof gnucashImportInput>;

export interface GnucashAccountInfo {
  guid: string;
  /** Full path, e.g. "Expenses:Auto:Fuel". */
  path: string;
  /** GnuCash account type, e.g. BANK, EXPENSE, STOCK. */
  type: string;
  placeholder: boolean;
  hidden: boolean;
  /** Commodity mnemonic, e.g. USD or AAPL. */
  commodity: string;
  splitCount: number;
  /** Sum of the account's own splits in its commodity, in cents. */
  balance: number;
  /** Our suggestion, or the mapping used last time this book was imported. */
  suggested: GnucashMapping;
  /** True when `suggested` comes from a previous import. */
  remembered: boolean;
}

export interface GnucashUpload {
  uploadId: string;
  fileName: string;
  /** The book's main currency. */
  currency: string;
  transactionCount: number;
  firstDate: string | null;
  lastDate: string | null;
  accounts: GnucashAccountInfo[];
}

export interface GnucashBalanceCheck {
  /** Our account name (new or existing). */
  name: string;
  accountId: number | null;
  /** GnuCash's balance for the accounts mapped here. */
  gnucash: number;
  /** This account's balance once the import is done. */
  afterImport: number;
}

export interface GnucashPreview {
  /** GnuCash transactions that will be imported now. */
  transactions: number;
  /** Skipped because an earlier import already brought them in. */
  alreadyImported: number;
  /** Skipped because none of their splits land in an account here (e.g. moves between categories). */
  noAccount: number;
  /** Skipped because every split is zero (voided). */
  voided: number;
  /** Rows that will be written. */
  rows: { transactions: number; transfers: number; splits: number };
  newAccounts: string[];
  newCategories: string[];
  warnings: string[];
  balances: GnucashBalanceCheck[];
}

export interface ImportBatch {
  id: number;
  source: string;
  fileName: string;
  createdAt: string;
  createdBy: string | null;
  transactionCount: number;
  undoneAt: string | null;
}
