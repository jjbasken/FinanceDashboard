import type { GnucashMapping, ImportBatch } from "@fd/shared";
import { and, desc, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import type { Db, DbOrTx } from "../../db";
import {
  accounts,
  categories,
  categoryGroups,
  importBatches,
  importedRecords,
  importMappings,
  investmentTxns,
  payees,
  prices,
  securities,
  transactions,
  users,
} from "../../db/schema";
import { STARTING_BALANCES } from "../../services/household";
import { listAccounts } from "../../services/ledger";
import { listCategories } from "../../services/categories";
import type { Actor } from "../../services/ledger";
import type { GncBook } from "./read";
import type { AccountRef, CategoryRef, ImportContext, Plan, PlannedRow, SecurityRef } from "./plan";

const lower = (s: string) => s.trim().toLowerCase();

/** Everything the planner needs to know about the household. */
export function loadContext(db: DbOrTx, householdId: number): ImportContext {
  const accts = listAccounts(db, householdId).map((a) => ({
    id: a.id,
    name: a.name,
    onBudget: a.onBudget,
    balance: a.balance,
  }));
  const cats = listCategories(db, householdId).flatMap((g) =>
    g.categories.map((c) => ({ id: c.id, name: c.name, groupName: g.name, isIncome: g.isIncome })),
  );
  const imported = new Set(
    db
      .select({ id: importedRecords.externalId })
      .from(importedRecords)
      .where(eq(importedRecords.householdId, householdId))
      .all()
      .map((r) => r.id),
  );
  const remembered = new Map(
    db
      .select({ id: importMappings.externalId, mapping: importMappings.mapping })
      .from(importMappings)
      .where(eq(importMappings.householdId, householdId))
      .all()
      .map((r) => [r.id, r.mapping as GnucashMapping]),
  );
  const secs = db
    .select({ id: securities.id, symbol: securities.symbol })
    .from(securities)
    .where(eq(securities.householdId, householdId))
    .all();
  const importedInvestments = new Set(
    db
      .select({ id: investmentTxns.importedId })
      .from(investmentTxns)
      .where(and(eq(investmentTxns.householdId, householdId), isNotNull(investmentTxns.importedId)))
      .all()
      .map((r) => r.id!),
  );
  return { accounts: accts, categories: cats, imported, remembered, securities: secs, importedInvestments };
}

/**
 * Write a plan to the database. Run inside a transaction. `mappings` is the full effective
 * mapping (every account in the book), which is remembered for the next import.
 */
export function commitPlan(
  db: DbOrTx,
  actor: Actor,
  book: GncBook,
  plan: Plan,
  mappings: Record<string, GnucashMapping>,
  fileName: string,
) {
  const { householdId, userId } = actor;
  const batch = db
    .insert(importBatches)
    .values({
      householdId,
      source: "gnucash",
      fileName,
      transactionCount: plan.transactions.length,
      createdBy: userId,
    })
    .returning()
    .get();
  const stamp = { createdBy: userId, updatedBy: userId, importBatchId: batch.id };

  // Accounts, each with its transfer payee.
  const newAccountIds = new Map<string, number>();
  let sortOrder =
    db
      .select({ n: sql<number>`coalesce(max(${accounts.sortOrder}), -1) + 1` })
      .from(accounts)
      .where(eq(accounts.householdId, householdId))
      .get()?.n ?? 0;
  for (const a of plan.newAccounts) {
    const row = db
      .insert(accounts)
      .values({
        householdId,
        name: a.name,
        type: a.type,
        onBudget: a.onBudget,
        sortOrder: sortOrder++,
        gnucashGuid: a.gnucashGuid,
        ...stamp,
      })
      .returning({ id: accounts.id })
      .get();
    db.insert(payees).values({ householdId, name: a.name, transferAccountId: row.id, importBatchId: batch.id }).run();
    newAccountIds.set(a.key, row.id);
  }
  const accountId = (ref: AccountRef) => (ref.kind === "existing" ? ref.id : newAccountIds.get(ref.key)!);

  // Categories, reusing a group with the same name and kind.
  const groups = listCategories(db, householdId);
  const groupIds = new Map(groups.map((g) => [`${g.isIncome ? 1 : 0}|${lower(g.name)}`, g.id]));
  let groupOrder = groups.length;
  const ensureGroup = (name: string, isIncome: boolean) => {
    const key = `${isIncome ? 1 : 0}|${lower(name)}`;
    let id = groupIds.get(key);
    if (!id) {
      id = db
        .insert(categoryGroups)
        .values({ householdId, name, isIncome, sortOrder: groupOrder++, importBatchId: batch.id })
        .returning({ id: categoryGroups.id })
        .get().id;
      groupIds.set(key, id);
    }
    return id;
  };
  const newCategoryIds = new Map<string, number>();
  const createCategory = (groupName: string, name: string, isIncome: boolean) => {
    const groupId = ensureGroup(groupName, isIncome);
    const next =
      db
        .select({ n: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
        .from(categories)
        .where(eq(categories.groupId, groupId))
        .get()?.n ?? 0;
    return db
      .insert(categories)
      .values({ householdId, groupId, name, sortOrder: next, importBatchId: batch.id })
      .returning({ id: categories.id })
      .get().id;
  };
  for (const c of plan.newCategories) newCategoryIds.set(c.key, createCategory(c.groupName, c.name, c.isIncome));

  let startingBalances: number | undefined = groups
    .find((g) => g.isIncome && g.categories.some((c) => c.name === STARTING_BALANCES))
    ?.categories.find((c) => c.name === STARTING_BALANCES)?.id;
  const categoryId = (ref: CategoryRef | null) => {
    if (!ref) return null;
    if (ref.kind === "existing") return ref.id;
    if (ref.kind === "new") return newCategoryIds.get(ref.key)!;
    startingBalances ??= createCategory("Income", STARTING_BALANCES, true);
    return startingBalances;
  };

  // Payees, found or created by name.
  const payeeIds = new Map(
    db
      .select({ id: payees.id, name: payees.name })
      .from(payees)
      .where(and(eq(payees.householdId, householdId), isNull(payees.transferAccountId)))
      .all()
      .map((p) => [lower(p.name), p.id]),
  );
  const payeeId = (name: string | null) => {
    if (!name) return null;
    let id = payeeIds.get(lower(name));
    if (!id) {
      id = db
        .insert(payees)
        .values({ householdId, name, importBatchId: batch.id })
        .returning({ id: payees.id })
        .get().id;
      payeeIds.set(lower(name), id);
    }
    return id;
  };
  const transferPayees = new Map(
    db
      .select({ id: payees.id, accountId: payees.transferAccountId })
      .from(payees)
      .where(eq(payees.householdId, householdId))
      .all()
      .filter((p) => p.accountId !== null)
      .map((p) => [p.accountId!, p.id]),
  );

  const insertRow = (row: PlannedRow, extra: { payeeId: number | null; categoryId: number | null }) =>
    db
      .insert(transactions)
      .values({
        householdId,
        accountId: accountId(row.account),
        date: row.date,
        amount: row.amount,
        notes: row.notes,
        cleared: row.cleared,
        reconciled: row.reconciled,
        isParent: row.children.length > 0,
        importedId: row.importedId,
        ...extra,
        ...stamp,
      })
      .returning({ id: transactions.id })
      .get().id;

  // Securities, then their price history (keeping any prices already there).
  const newSecurityIds = new Map<string, number>();
  for (const sec of plan.newSecurities) {
    const row = db
      .insert(securities)
      .values({
        householdId,
        symbol: sec.symbol,
        name: sec.name,
        type: sec.type,
        autoPrice: true,
        importBatchId: batch.id,
      })
      .returning({ id: securities.id })
      .get();
    newSecurityIds.set(sec.key, row.id);
  }
  const securityId = (ref: SecurityRef) => (ref.kind === "existing" ? ref.id : newSecurityIds.get(ref.key)!);
  for (const p of plan.prices) {
    db.insert(prices)
      .values({ securityId: securityId(p.security), date: p.date, close: p.close, source: "gnucash" })
      .onConflictDoNothing()
      .run();
  }

  for (const tx of plan.transactions) {
    for (const row of tx.rows) {
      const parentId = insertRow(row, { payeeId: payeeId(row.payeeName), categoryId: categoryId(row.category) });
      if (row.children.length) {
        db.insert(transactions)
          .values(
            row.children.map((c) => ({
              householdId,
              accountId: accountId(row.account),
              date: row.date,
              amount: c.amount,
              payeeId: payeeId(row.payeeName),
              categoryId: categoryId(c.category),
              notes: c.notes,
              cleared: row.cleared,
              parentId,
              importedId: c.importedId,
              ...stamp,
            })),
          )
          .run();
      }
    }
    for (const [from, to] of tx.transfers) {
      const fromAccount = accountId(from.account);
      const toAccount = accountId(to.account);
      const a = insertRow(from, { payeeId: transferPayees.get(toAccount)!, categoryId: null });
      const b = insertRow(to, { payeeId: transferPayees.get(fromAccount)!, categoryId: null });
      db.update(transactions).set({ transferId: b }).where(eq(transactions.id, a)).run();
      db.update(transactions).set({ transferId: a }).where(eq(transactions.id, b)).run();
    }
    for (const inv of tx.investments) {
      const account = accountId(inv.account);
      const cashId =
        inv.cash === 0
          ? null
          : db
              .insert(transactions)
              .values({
                householdId,
                accountId: account,
                date: inv.date,
                amount: inv.cash,
                payeeId: payeeId(inv.payeeName),
                notes: inv.notes,
                cleared: inv.cleared,
                importedId: `${inv.importedId}:cash`,
                ...stamp,
              })
              .returning({ id: transactions.id })
              .get().id;
      db.insert(investmentTxns)
        .values({
          householdId,
          accountId: account,
          securityId: securityId(inv.security),
          date: inv.date,
          action: inv.action,
          shares: inv.shares,
          price: inv.price,
          amount: inv.amount,
          notes: inv.notes,
          transactionId: cashId,
          importedId: inv.importedId,
          ...stamp,
        })
        .run();
    }
    db.insert(importedRecords).values({ householdId, batchId: batch.id, externalId: tx.guid }).run();
  }

  for (const account of book.accounts) {
    let m = mappings[account.guid];
    if (!m) continue;
    // Remember what was used, with new accounts and categories resolved to their ids.
    if (m.kind === "account" && m.accountId === null) m = { ...m, accountId: newAccountIds.get(account.guid) ?? null };
    if (m.kind === "holding" && m.securityId === null) {
      m = { ...m, securityId: newSecurityIds.get(m.symbol) ?? null };
    }
    if (m.kind === "category" && m.categoryId === null) {
      const key = `${m.isIncome ? 1 : 0}|${lower(m.groupName)}|${lower(m.name)}`;
      m = { ...m, categoryId: newCategoryIds.get(key) ?? null };
    }
    db.insert(importMappings)
      .values({ householdId, externalId: account.guid, mapping: m })
      .onConflictDoUpdate({
        target: [importMappings.householdId, importMappings.externalId],
        set: { mapping: m, updatedAt: new Date().toISOString() },
      })
      .run();
  }

  return batch.id;
}

export function listBatches(db: DbOrTx, householdId: number): ImportBatch[] {
  return db
    .select({
      id: importBatches.id,
      source: importBatches.source,
      fileName: importBatches.fileName,
      createdAt: importBatches.createdAt,
      createdBy: users.displayName,
      transactionCount: importBatches.transactionCount,
      undoneAt: importBatches.undoneAt,
    })
    .from(importBatches)
    .leftJoin(users, eq(users.id, importBatches.createdBy))
    .where(eq(importBatches.householdId, householdId))
    .orderBy(desc(importBatches.id))
    .all();
}

/**
 * Undo an import: delete its transactions, then whatever accounts, categories, groups and payees
 * it created that nothing else uses now. Its records are forgotten so it can be imported again.
 */
export function undoBatch(db: Db, householdId: number, batchId: number) {
  db.transaction((tx) => {
    const batch = tx
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.id, batchId), eq(importBatches.householdId, householdId)))
      .get();
    if (!batch) throw new HTTPException(404, { message: "Import not found" });
    if (batch.undoneAt) throw new HTTPException(409, { message: "That import was already undone" });

    // Parents first is fine: children cascade.
    tx.delete(investmentTxns).where(eq(investmentTxns.importBatchId, batchId)).run();
    tx.delete(transactions).where(eq(transactions.importBatchId, batchId)).run();
    tx.delete(securities)
      .where(
        and(
          eq(securities.importBatchId, batchId),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(investmentTxns)
              .where(eq(investmentTxns.securityId, securities.id)),
          ),
        ),
      )
      .run();

    const used = (column: SQLiteColumn, id: SQLiteColumn) =>
      tx
        .select({ x: sql`1` })
        .from(transactions)
        .where(eq(column, id));
    tx.delete(accounts)
      .where(and(eq(accounts.importBatchId, batchId), notExists(used(transactions.accountId, accounts.id))))
      .run();
    tx.delete(categories)
      .where(and(eq(categories.importBatchId, batchId), notExists(used(transactions.categoryId, categories.id))))
      .run();
    tx.delete(categoryGroups)
      .where(
        and(
          eq(categoryGroups.importBatchId, batchId),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(categories)
              .where(eq(categories.groupId, categoryGroups.id)),
          ),
        ),
      )
      .run();
    tx.delete(payees)
      .where(
        and(
          eq(payees.importBatchId, batchId),
          isNull(payees.transferAccountId),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(transactions)
              .where(eq(transactions.payeeId, payees.id)),
          ),
        ),
      )
      .run();

    tx.delete(importedRecords).where(eq(importedRecords.batchId, batchId)).run();
    tx.update(importBatches).set({ undoneAt: new Date().toISOString() }).where(eq(importBatches.id, batchId)).run();
  });
}
