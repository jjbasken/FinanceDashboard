import {
  accountSection,
  defaultOnBudget,
  type Account,
  type CreateAccountInput,
  type CreateTransactionInput,
  type SplitInput,
  type Transaction,
  type TransactionSplit,
  type UpdateAccountInput,
  type UpdateTransactionInput,
} from "@fd/shared";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db";
import { accounts, categories, categoryGroups, investmentTxns, payees, transactions } from "../db/schema";
import { assertParent, getFolder, nextSidebarOrder } from "./folders";
import { holdingsValueByAccount } from "./holdings";
import { STARTING_BALANCES } from "./household";

/** Who is making a change, and in which household. Every query is scoped by householdId. */
export interface Actor {
  householdId: number;
  userId: number;
}

const notFound = (what: string) => new HTTPException(404, { message: `${what} not found` });
const badRequest = (message: string) => new HTTPException(400, { message });

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw notFound(what);
  return row;
}

export function getAccount(db: DbOrTx, householdId: number, id: number) {
  return found(
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.householdId, householdId)))
      .get(),
    "Account",
  );
}

function getPayee(db: DbOrTx, householdId: number, id: number) {
  return found(
    db
      .select()
      .from(payees)
      .where(and(eq(payees.id, id), eq(payees.householdId, householdId)))
      .get(),
    "Payee",
  );
}

function assertCategory(db: DbOrTx, householdId: number, id: number | null | undefined) {
  if (id == null) return;
  found(
    db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.householdId, householdId)))
      .get(),
    "Category",
  );
}

function getTransactionRow(db: DbOrTx, householdId: number, id: number) {
  return found(
    db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.householdId, householdId)))
      .get(),
    "Transaction",
  );
}

/** Find a regular (non-transfer) payee by name, case-insensitively, creating it if needed. */
export function findOrCreatePayee(db: DbOrTx, householdId: number, name: string, importBatchId?: number) {
  const existing = db
    .select()
    .from(payees)
    .where(
      and(
        eq(payees.householdId, householdId),
        isNull(payees.transferAccountId),
        sql`lower(${payees.name}) = lower(${name})`,
      ),
    )
    .get();
  return existing ?? db.insert(payees).values({ householdId, name, importBatchId }).returning().get();
}

function transferPayeeFor(db: DbOrTx, accountId: number) {
  return found(db.select().from(payees).where(eq(payees.transferAccountId, accountId)).get(), "Transfer payee");
}

function findStartingBalancesCategory(db: DbOrTx, householdId: number) {
  return db
    .select({ id: categories.id })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(
      and(
        eq(categories.householdId, householdId),
        eq(categoryGroups.isIncome, true),
        eq(categories.name, STARTING_BALANCES),
      ),
    )
    .get();
}

// --- Accounts ---

export function listAccounts(db: DbOrTx, householdId: number): Account[] {
  const rows = db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      onBudget: accounts.onBudget,
      closed: accounts.closed,
      sortOrder: accounts.sortOrder,
      folderId: accounts.folderId,
      transferPayeeId: payees.id,
    })
    .from(accounts)
    .innerJoin(payees, eq(payees.transferAccountId, accounts.id))
    .where(eq(accounts.householdId, householdId))
    .orderBy(asc(accounts.sortOrder), asc(accounts.id))
    .all();

  const totals = db
    .select({
      accountId: transactions.accountId,
      balance: sql<number>`coalesce(sum(${transactions.amount}), 0)`,
      cleared: sql<number>`coalesce(sum(case when ${transactions.cleared} then ${transactions.amount} else 0 end), 0)`,
    })
    .from(transactions)
    .where(and(eq(transactions.householdId, householdId), isNull(transactions.parentId)))
    .groupBy(transactions.accountId)
    .all();
  const byAccount = new Map(totals.map((t) => [t.accountId, t]));
  const holdings = holdingsValueByAccount(db, householdId);

  return rows.map((r) => ({
    ...r,
    balance: byAccount.get(r.id)?.balance ?? 0,
    clearedBalance: byAccount.get(r.id)?.cleared ?? 0,
    holdingsValue: holdings.get(r.id) ?? 0,
  }));
}

export function accountSummary(db: DbOrTx, householdId: number, id: number) {
  return found(
    listAccounts(db, householdId).find((a) => a.id === id),
    "Account",
  );
}

export function createAccount(db: DbOrTx, actor: Actor, input: CreateAccountInput, today: string) {
  const { householdId, userId } = actor;
  const next = nextSidebarOrder(db, householdId);
  const onBudget = input.onBudget ?? defaultOnBudget(input.type);
  const account = db
    .insert(accounts)
    .values({
      householdId,
      name: input.name,
      type: input.type,
      onBudget,
      sortOrder: next,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning()
    .get();
  db.insert(payees).values({ householdId, name: account.name, transferAccountId: account.id }).run();

  if (input.startingBalance) {
    const payee = findOrCreatePayee(db, householdId, "Starting Balance");
    db.insert(transactions)
      .values({
        householdId,
        accountId: account.id,
        date: input.startingDate ?? today,
        amount: input.startingBalance,
        payeeId: payee.id,
        categoryId: onBudget ? (findStartingBalancesCategory(db, householdId)?.id ?? null) : null,
        cleared: true,
        createdBy: userId,
        updatedBy: userId,
      })
      .run();
  }
  return account;
}

export function updateAccount(db: DbOrTx, actor: Actor, id: number, input: UpdateAccountInput) {
  const account = getAccount(db, actor.householdId, id);
  if (input.closed && !account.closed) {
    const { balance } = accountSummary(db, actor.householdId, id);
    if (balance !== 0) throw badRequest("Move the remaining balance out of this account before closing it");
    const held = db.all<{ n: number }>(sql`
      select 1 as n from investment_txns where account_id = ${id}
      group by security_id having sum(shares) != 0 limit 1
    `);
    if (held.length) throw badRequest("Sell or move out this account's investments before closing it");
  }
  // Folders belong to one sidebar section. Moving into a folder puts the account at its end;
  // moving to another section takes it out of a folder that no longer fits.
  const section = accountSection({ type: input.type ?? account.type, onBudget: input.onBudget ?? account.onBudget });
  let placement: { folderId?: number | null; sortOrder?: number } = {};
  if (input.folderId !== undefined && input.folderId !== account.folderId) {
    assertParent(db, actor.householdId, input.folderId, section);
    placement = { folderId: input.folderId, sortOrder: nextSidebarOrder(db, actor.householdId) };
  } else if (account.folderId !== null && getFolder(db, actor.householdId, account.folderId).section !== section) {
    placement = { folderId: null, sortOrder: nextSidebarOrder(db, actor.householdId) };
  }
  db.update(accounts)
    .set({ ...input, ...placement, updatedBy: actor.userId })
    .where(eq(accounts.id, id))
    .run();
  if (input.name !== undefined) {
    db.update(payees).set({ name: input.name }).where(eq(payees.transferAccountId, id)).run();
  }
}

/**
 * Delete an account and its transactions. The other side of any transfer survives as an
 * ordinary transaction (its transfer link and payee are cleared by the foreign keys).
 */
export function deleteAccount(db: DbOrTx, householdId: number, id: number) {
  getAccount(db, householdId, id);
  db.delete(accounts).where(eq(accounts.id, id)).run();
}

/** Lock in every cleared transaction once the cleared balance matches the bank statement. */
export function reconcileAccount(db: DbOrTx, actor: Actor, id: number, statementBalance: number) {
  const { clearedBalance } = accountSummary(db, actor.householdId, id);
  if (clearedBalance !== statementBalance) {
    throw badRequest("The cleared balance doesn't match the statement balance yet");
  }
  db.update(transactions)
    .set({ reconciled: true })
    .where(and(eq(transactions.accountId, id), isNull(transactions.parentId), eq(transactions.cleared, true)))
    .run();
}

// --- Transactions ---

function linkedToInvestment(db: DbOrTx, transactionId: number) {
  return !!db
    .select({ id: investmentTxns.id })
    .from(investmentTxns)
    .where(eq(investmentTxns.transactionId, transactionId))
    .get();
}

type TxRow = typeof transactions.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

const splitLineMessage = (verb: string) =>
  `This is one line of a split transaction in another account. ${verb} it there.`;

/** The other side of a transfer that's one line of a split, or null. */
function splitPartner(db: DbOrTx, householdId: number, row: TxRow) {
  if (!row.transferId) return null;
  const partner = getTransactionRow(db, householdId, row.transferId);
  return partner.parentId ? partner : null;
}

export function listTransactions(db: DbOrTx, householdId: number, accountId: number): Transaction[] {
  getAccount(db, householdId, accountId);
  const partner = alias(transactions, "partner");
  const running = sql<number>`sum(${transactions.amount}) over (order by ${transactions.date}, ${transactions.id})`;
  const rows = db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: transactions.date,
      amount: transactions.amount,
      payeeId: transactions.payeeId,
      categoryId: transactions.categoryId,
      notes: transactions.notes,
      cleared: transactions.cleared,
      reconciled: transactions.reconciled,
      isParent: transactions.isParent,
      transferId: transactions.transferId,
      investmentTxnId: investmentTxns.id,
      fromSplit: sql<boolean>`${partner.parentId} is not null`.mapWith(Boolean),
      createdBy: transactions.createdBy,
      updatedBy: transactions.updatedBy,
      runningBalance: running,
    })
    .from(transactions)
    .leftJoin(investmentTxns, eq(investmentTxns.transactionId, transactions.id))
    .leftJoin(partner, eq(partner.id, transactions.transferId))
    .where(and(eq(transactions.accountId, accountId), isNull(transactions.parentId)))
    .orderBy(sql`${transactions.date} desc`, sql`${transactions.id} desc`)
    .all();

  const children = db
    .select({
      id: transactions.id,
      parentId: transactions.parentId,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
      notes: transactions.notes,
      transferAccountId: sql<
        number | null
      >`case when ${transactions.transferId} is not null then ${payees.transferAccountId} end`,
    })
    .from(transactions)
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.parentId)))
    .orderBy(asc(transactions.id))
    .all();
  const splitsByParent = new Map<number, TransactionSplit[]>();
  for (const { parentId, ...split } of children) {
    const list = splitsByParent.get(parentId!) ?? [];
    list.push(split);
    splitsByParent.set(parentId!, list);
  }

  return rows.map(({ isParent, ...r }) => ({ ...r, splits: isParent ? (splitsByParent.get(r.id) ?? []) : [] }));
}

export function getTransaction(db: DbOrTx, householdId: number, id: number): Transaction {
  const row = getTransactionRow(db, householdId, id);
  const parentId = row.parentId ?? row.id;
  return found(
    listTransactions(db, householdId, row.accountId).find((t) => t.id === parentId),
    "Transaction",
  );
}

function resolvePayee(db: DbOrTx, householdId: number, input: { payeeId?: number | null; payeeName?: string }) {
  if (input.payeeId != null) return getPayee(db, householdId, input.payeeId);
  if (input.payeeName) return findOrCreatePayee(db, householdId, input.payeeName);
  return null;
}

function checkSplits(db: DbOrTx, householdId: number, account: AccountRow, amount: number, splits: SplitInput[]) {
  const total = splits.reduce((sum, s) => sum + s.amount, 0);
  if (total !== amount) throw badRequest("Split amounts must add up to the transaction amount");
  for (const s of splits) {
    assertCategory(db, householdId, s.categoryId);
    if (s.transferAccountId == null) continue;
    getAccount(db, householdId, s.transferAccountId);
    if (s.transferAccountId === account.id) throw badRequest("An account can't transfer to itself");
  }
}

/**
 * Write a parent's split lines. A line with a transfer account becomes one side of a transfer,
 * taking that account's transfer payee instead of the parent's.
 */
function insertSplits(db: DbOrTx, actor: Actor, parent: TxRow, account: AccountRow, splits: SplitInput[]) {
  for (const s of splits) {
    const target = s.transferAccountId != null ? getAccount(db, actor.householdId, s.transferAccountId) : null;
    const categoryId = s.categoryId ?? null;
    const child = db
      .insert(transactions)
      .values({
        householdId: actor.householdId,
        accountId: parent.accountId,
        date: parent.date,
        amount: s.amount,
        payeeId: target ? transferPayeeFor(db, target.id).id : parent.payeeId,
        categoryId: target ? transferCategory(account, target, categoryId) : categoryId,
        notes: s.notes ?? "",
        cleared: parent.cleared,
        parentId: parent.id,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning()
      .get();
    if (target) insertTransferSide(db, actor, child, account, target, categoryId);
  }
}

/** The other sides of a parent's transfer split lines. */
function splitTransferIds(db: DbOrTx, parentId: number) {
  return db
    .select({ id: transactions.transferId })
    .from(transactions)
    .where(and(eq(transactions.parentId, parentId), isNotNull(transactions.transferId)))
    .all()
    .map((r) => r.id!);
}

/** Delete a parent's split lines along with the other sides of any transfers among them. */
function deleteSplits(db: DbOrTx, parentId: number) {
  const others = splitTransferIds(db, parentId);
  db.delete(transactions).where(eq(transactions.parentId, parentId)).run();
  if (others.length) db.delete(transactions).where(inArray(transactions.id, others)).run();
}

/**
 * A category only belongs on a transfer when money crosses the budget boundary, and then
 * only on the on-budget side. Transfers between two on-budget accounts are uncategorised.
 */
function transferCategory(side: { onBudget: boolean }, other: { onBudget: boolean }, categoryId: number | null) {
  return side.onBudget && !other.onBudget ? categoryId : null;
}

function insertTransferSide(
  db: DbOrTx,
  actor: Actor,
  source: TxRow,
  sourceAccount: { id: number; onBudget: boolean },
  target: { id: number; onBudget: boolean },
  categoryId: number | null,
) {
  const other = db
    .insert(transactions)
    .values({
      householdId: actor.householdId,
      accountId: target.id,
      date: source.date,
      amount: -source.amount,
      payeeId: transferPayeeFor(db, sourceAccount.id).id,
      categoryId: transferCategory(target, sourceAccount, categoryId),
      notes: source.notes,
      transferId: source.id,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning()
    .get();
  db.update(transactions).set({ transferId: other.id }).where(eq(transactions.id, source.id)).run();
  return other;
}

export function createTransaction(db: DbOrTx, actor: Actor, input: CreateTransactionInput) {
  const { householdId, userId } = actor;
  const account = getAccount(db, householdId, input.accountId);
  const payee = resolvePayee(db, householdId, input);
  const splits = input.splits ?? [];
  const categoryId = splits.length ? null : (input.categoryId ?? null);
  assertCategory(db, householdId, categoryId);
  if (splits.length) checkSplits(db, householdId, account, input.amount, splits);

  const target = payee?.transferAccountId ? getAccount(db, householdId, payee.transferAccountId) : null;
  if (target) {
    if (target.id === account.id) throw badRequest("An account can't transfer to itself");
    if (splits.length) throw badRequest("A transfer can't be split");
  }

  const row = db
    .insert(transactions)
    .values({
      householdId,
      accountId: account.id,
      date: input.date,
      amount: input.amount,
      payeeId: payee?.id ?? null,
      categoryId: target ? transferCategory(account, target, categoryId) : categoryId,
      notes: input.notes ?? "",
      cleared: input.cleared ?? false,
      isParent: splits.length > 0,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning()
    .get();
  if (splits.length) insertSplits(db, actor, row, account, splits);
  if (target) insertTransferSide(db, actor, row, account, target, categoryId);
  return row.id;
}

export function updateTransaction(db: DbOrTx, actor: Actor, id: number, input: UpdateTransactionInput) {
  const { householdId, userId } = actor;
  const row = getTransactionRow(db, householdId, id);
  if (row.parentId) throw badRequest("Edit the split through its parent transaction");
  if (linkedToInvestment(db, id) && Object.keys(input).some((k) => k !== "cleared")) {
    throw badRequest("This is the cash side of an investment transaction. Edit it on the Investments page.");
  }
  // The other side of a split line follows the split; only its cleared state is its own.
  if (splitPartner(db, householdId, row)) {
    if (Object.keys(input).some((k) => k !== "cleared")) throw badRequest(splitLineMessage("Edit"));
    const cleared = input.cleared ?? row.cleared;
    db.update(transactions)
      .set({ cleared, reconciled: cleared ? row.reconciled : false, updatedBy: userId })
      .where(eq(transactions.id, id))
      .run();
    return;
  }
  const account = getAccount(db, householdId, row.accountId);

  const payeeChanged = input.payeeId !== undefined || input.payeeName !== undefined;
  const payee = payeeChanged
    ? resolvePayee(db, householdId, input)
    : row.payeeId
      ? getPayee(db, householdId, row.payeeId)
      : null;
  const amount = input.amount ?? row.amount;
  const date = input.date ?? row.date;
  const notes = input.notes ?? row.notes;

  // Splits: an explicit array replaces them; otherwise the existing ones must still add up.
  const splits = input.splits;
  const willBeSplit = splits ? splits.length > 0 : row.isParent;
  if (splits?.length) checkSplits(db, householdId, account, amount, splits);
  else if (!splits && row.isParent && input.amount !== undefined && input.amount !== row.amount) {
    throw badRequest("Update the splits along with the amount");
  }

  let categoryId = willBeSplit ? null : input.categoryId !== undefined ? input.categoryId : row.categoryId;
  assertCategory(db, householdId, categoryId);

  const target = payee?.transferAccountId ? getAccount(db, householdId, payee.transferAccountId) : null;
  if (target) {
    if (target.id === account.id) throw badRequest("An account can't transfer to itself");
    if (willBeSplit) throw badRequest("A transfer can't be split");
    categoryId = transferCategory(account, target, categoryId);
  }

  // Unchecking "cleared" also undoes reconciliation.
  const cleared = input.cleared ?? row.cleared;
  db.update(transactions)
    .set({
      date,
      amount,
      notes,
      payeeId: payee?.id ?? null,
      categoryId,
      cleared,
      reconciled: cleared ? row.reconciled : false,
      isParent: willBeSplit,
      updatedBy: userId,
    })
    .where(eq(transactions.id, id))
    .run();
  const updated = getTransactionRow(db, householdId, id);

  if (splits) {
    deleteSplits(db, id);
    if (splits.length) insertSplits(db, actor, updated, account, splits);
  } else if (row.isParent) {
    db.update(transactions).set({ date, cleared, updatedBy: userId }).where(eq(transactions.parentId, id)).run();
    // Transfer lines keep their transfer payee, and the other sides move with the date.
    db.update(transactions)
      .set({ payeeId: updated.payeeId })
      .where(and(eq(transactions.parentId, id), isNull(transactions.transferId)))
      .run();
    const others = splitTransferIds(db, id);
    if (others.length) {
      db.update(transactions).set({ date, updatedBy: userId }).where(inArray(transactions.id, others)).run();
    }
  }

  // Keep the other side of a transfer in step, creating, moving or removing it as needed.
  const other = row.transferId ? getTransactionRow(db, householdId, row.transferId) : null;
  if (other && (!target || other.accountId !== target.id)) {
    db.delete(transactions).where(eq(transactions.id, other.id)).run();
    if (target) insertTransferSide(db, actor, updated, account, target, input.categoryId ?? null);
  } else if (other && target) {
    db.update(transactions)
      .set({
        date,
        amount: -amount,
        notes,
        categoryId: transferCategory(
          target,
          account,
          input.categoryId !== undefined ? input.categoryId : other.categoryId,
        ),
        updatedBy: userId,
      })
      .where(eq(transactions.id, other.id))
      .run();
  } else if (!other && target) {
    insertTransferSide(db, actor, updated, account, target, input.categoryId ?? null);
  }
}

export function deleteTransaction(db: DbOrTx, householdId: number, id: number) {
  const row = getTransactionRow(db, householdId, id);
  if (row.parentId) throw badRequest("Delete the split through its parent transaction");
  if (linkedToInvestment(db, id)) {
    throw badRequest("This is the cash side of an investment transaction. Delete it on the Investments page.");
  }
  if (splitPartner(db, householdId, row)) throw badRequest(splitLineMessage("Delete"));
  if (row.isParent) deleteSplits(db, id);
  const ids = row.transferId ? [row.id, row.transferId] : [row.id];
  db.delete(transactions).where(inArray(transactions.id, ids)).run();
}
