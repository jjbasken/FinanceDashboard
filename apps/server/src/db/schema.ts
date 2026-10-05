import { ACCOUNT_TYPES } from "@fd/shared";
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
    gnucashGuid: text("gnucash_guid"),
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
    /** Carry a positive balance into next month instead of returning it to To Budget. */
    rollover: flag("rollover"),
    sortOrder: integer("sort_order").notNull().default(0),
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
