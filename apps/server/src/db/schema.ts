import { ACCOUNT_SECTIONS, ACCOUNT_TYPES, INVESTMENT_ACTIONS, SECURITY_TYPES } from "@fd/shared";
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

const updatedAt = () =>
  text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .$onUpdate(() => new Date().toISOString());

const flag = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);

export const households = sqliteTable("households", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** ISO 4217 code that amounts are shown in. */
  currency: text("currency").notNull().default("USD"),
  createdAt: createdAt(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  householdId: integer("household_id")
    .notNull()
    .references(() => households.id),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  /** Set when the owner removes a member: they can't sign in, but their name stays on their entries. */
  disabledAt: text("disabled_at"),
  createdAt: createdAt(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256 of the cookie token; the raw token is never stored.
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const invites = sqliteTable("invites", {
  // SHA-256 of the invite token.
  id: text("id").primaryKey(),
  householdId: integer("household_id")
    .notNull()
    .references(() => households.id),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
  usedBy: integer("used_by").references(() => users.id),
  createdAt: createdAt(),
});

/** Sidebar folders for grouping accounts. They nest, and each belongs to one sidebar section. */
export const accountFolders = sqliteTable(
  "account_folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
    section: text("section", { enum: ACCOUNT_SECTIONS }).notNull(),
    parentId: integer("parent_id").references((): AnySQLiteColumn => accountFolders.id, { onDelete: "cascade" }),
    /** Shared with the accounts beside it, so folders and accounts can be interleaved. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("account_folders_household_idx").on(t.householdId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    onBudget: flag("on_budget"),
    closed: flag("closed"),
    sortOrder: integer("sort_order").notNull().default(0),
    folderId: integer("folder_id").references(() => accountFolders.id, { onDelete: "set null" }),
    gnucashGuid: text("gnucash_guid"),
    /** Set when an import created this row, so the import can be undone. */
    importBatchId: integer("import_batch_id").references((): AnySQLiteColumn => importBatches.id, {
      onDelete: "set null",
    }),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("accounts_household_idx").on(t.householdId),
    uniqueIndex("accounts_gnucash_guid_unique").on(t.householdId, t.gnucashGuid),
  ],
);

export const payees = sqliteTable(
  "payees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
    /** Set for the one payee per account that represents "Transfer: <account>". */
    transferAccountId: integer("transfer_account_id").references(() => accounts.id, { onDelete: "cascade" }),
    /** Set when an import created this row, so the import can be undone. */
    importBatchId: integer("import_batch_id").references((): AnySQLiteColumn => importBatches.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index("payees_household_idx").on(t.householdId),
    uniqueIndex("payees_transfer_account_unique").on(t.transferAccountId),
  ],
);

export const categoryGroups = sqliteTable(
  "category_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    name: text("name").notNull(),
    isIncome: flag("is_income"),
    hidden: flag("hidden"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Set when an import created this row, so the import can be undone. */
    importBatchId: integer("import_batch_id").references((): AnySQLiteColumn => importBatches.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("category_groups_household_idx").on(t.householdId)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    groupId: integer("group_id")
      .notNull()
      .references(() => categoryGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hidden: flag("hidden"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Income in this category counts toward the following month's budget (e.g. pay at month end). */
    forNextMonth: flag("for_next_month"),
    /** Set when an import created this row, so the import can be undone. */
    importBatchId: integer("import_batch_id").references((): AnySQLiteColumn => importBatches.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [index("categories_group_idx").on(t.groupId)],
);

/**
 * A split transaction is a parent row (isParent, holding the total) plus child rows
 * (parentId set) that carry the categories. Balances sum rows with no parent; category
 * activity sums rows that aren't parents. Both sides of a transfer point at each other
 * through transferId.
 */
export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD */
    date: text("date").notNull(),
    /** Integer cents; negative is money leaving the account. */
    amount: integer("amount").notNull(),
    payeeId: integer("payee_id").references(() => payees.id, { onDelete: "set null" }),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    cleared: flag("cleared"),
    reconciled: flag("reconciled"),
    isParent: flag("is_parent"),
    parentId: integer("parent_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
    transferId: integer("transfer_id").references((): AnySQLiteColumn => transactions.id, { onDelete: "set null" }),
    /** Stable id from an import source (e.g. a GnuCash GUID) so re-imports are idempotent. */
    importedId: text("imported_id"),
    /** Set when an import created this row; undoing the import deletes it. */
    importBatchId: integer("import_batch_id").references((): AnySQLiteColumn => importBatches.id, {
      onDelete: "cascade",
    }),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("transactions_account_date_idx").on(t.accountId, t.date),
    index("transactions_parent_idx").on(t.parentId),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_payee_idx").on(t.payeeId),
    uniqueIndex("transactions_imported_id_unique").on(t.householdId, t.importedId),
    index("transactions_import_batch_idx").on(t.importBatchId),
  ],
);

/** The amount assigned to an expense category in a month ("YYYY-MM"). Missing rows mean 0. */
export const budgetMonths = sqliteTable(
  "budget_months",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    amount: integer("amount").notNull(),
    updatedBy: integer("updated_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budget_months_category_month_unique").on(t.categoryId, t.month),
    index("budget_months_household_month_idx").on(t.householdId, t.month),
  ],
);

/** One run of an importer. Undoing it deletes what it created and lets it be imported again. */
export const importBatches = sqliteTable(
  "import_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    source: text("source", { enum: ["gnucash", "ofx", "csv"] }).notNull(),
    fileName: text("file_name").notNull(),
    transactionCount: integer("transaction_count").notNull().default(0),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: createdAt(),
    undoneAt: text("undone_at"),
  },
  (t) => [index("import_batches_household_idx").on(t.householdId)],
);

/**
 * Source records (e.g. GnuCash transaction GUIDs) that an import has already brought in, so a
 * re-import skips them even if the user has since edited or deleted the result.
 */
export const importedRecords = sqliteTable(
  "imported_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    batchId: integer("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
  },
  (t) => [uniqueIndex("imported_records_external_unique").on(t.householdId, t.externalId)],
);

/** How each source account was mapped last time, so re-imports suggest the same thing. */
export const importMappings = sqliteTable(
  "import_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    externalId: text("external_id").notNull(),
    /** A GnucashMapping, with new accounts and categories resolved to their ids. */
    mapping: text("mapping", { mode: "json" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("import_mappings_external_unique").on(t.householdId, t.externalId)],
);

export const securities = sqliteTable(
  "securities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: SECURITY_TYPES }).notNull(),
    currency: text("currency").notNull().default("USD"),
    /** Fetch daily prices from the price provider. */
    autoPrice: flag("auto_price"),
    importBatchId: integer("import_batch_id").references(() => importBatches.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("securities_household_symbol_unique").on(t.householdId, t.symbol)],
);

/**
 * Buys, sells, dividends, splits and share transfers. Shares are signed micro-shares, prices
 * micro-dollars, amounts cents. When cash moves, `transactionId` links the matching row in the
 * account's register, which can only be changed through this record.
 */
export const investmentTxns = sqliteTable(
  "investment_txns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: integer("security_id")
      .notNull()
      .references(() => securities.id),
    date: text("date").notNull(),
    action: text("action", { enum: INVESTMENT_ACTIONS }).notNull(),
    shares: integer("shares").notNull(),
    /** For splits entered here: the ratio (new for old), so the share change can be recomputed. */
    splitNew: integer("split_new"),
    splitOld: integer("split_old"),
    price: integer("price").notNull().default(0),
    fees: integer("fees").notNull().default(0),
    amount: integer("amount").notNull().default(0),
    transactionId: integer("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    importedId: text("imported_id"),
    importBatchId: integer("import_batch_id").references(() => importBatches.id, { onDelete: "cascade" }),
    createdBy: integer("created_by").references(() => users.id),
    updatedBy: integer("updated_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("investment_txns_account_idx").on(t.accountId, t.date),
    index("investment_txns_security_idx").on(t.securityId, t.date),
    uniqueIndex("investment_txns_transaction_unique").on(t.transactionId),
    uniqueIndex("investment_txns_imported_id_unique").on(t.householdId, t.importedId),
  ],
);

/** Daily closing prices in micro-dollars. */
export const prices = sqliteTable(
  "prices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    securityId: integer("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    close: integer("close").notNull(),
    source: text("source", { enum: ["yahoo", "gnucash", "manual"] }).notNull(),
  },
  (t) => [uniqueIndex("prices_security_date_unique").on(t.securityId, t.date)],
);

/**
 * Existing transactions a bank import linked to instead of duplicating, with what they looked like
 * before, so undoing the import can put them back.
 */
export const importMatches = sqliteTable(
  "import_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    batchId: integer("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    previousImportedId: text("previous_imported_id"),
    previousCleared: integer("previous_cleared", { mode: "boolean" }).notNull(),
  },
  (t) => [index("import_matches_batch_idx").on(t.batchId)],
);
