import type { BankItem, BankPreview } from "@fd/shared";
import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db";
import { importBatches, importMatches, payees, transactions } from "../../db/schema";
import { findOrCreatePayee, type Actor } from "../../services/ledger";
import type { BankTxn } from "./parse";

/** How far apart (in days) a file row and a hand-entered transaction can be and still match. */
const MATCH_WINDOW_DAYS = 3;

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const lower = (s: string) => s.trim().toLowerCase();

/**
 * A stable id per row, so importing an overlapping file again skips what's already in. OFX rows
 * carry the bank's FITID. CSV rows use their contents, numbered when a file repeats the same row
 * (two identical coffees on one day are two purchases).
 */
export function importedIds(accountId: number, txns: BankTxn[]) {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    if (t.externalId) return `ofx:${accountId}:${t.externalId}`;
    const digest = createHash("sha1").update(lower(t.payee)).digest("hex").slice(0, 12);
    const base = `csv:${accountId}:${t.date}:${t.amount}:${digest}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}:${n}`;
  });
}

const isStatementId = (id: string | null) => !!id && (id.startsWith("ofx:") || id.startsWith("csv:"));

/**
 * Sort each row into new, duplicate (already imported) or match (an existing transaction with the
 * same amount within a few days, which gets linked instead of duplicated).
 *
 * Transactions entered by hand or brought in from GnuCash are matched first. Ones an earlier file
 * brought in can match too, for when a row's id changed between downloads (a reworded CSV payee, a
 * bank that reissued its OFX ids, or switching between OFX and CSV), but only when they're dated
 * within this file's range: a file that covers the date and doesn't carry the row's old id is
 * presumably showing it under a new one, while one outside the range is a separate purchase.
 */
export function planBankImport(
  db: DbOrTx,
  householdId: number,
  account: { id: number; onBudget: boolean },
  txns: BankTxn[],
): BankPreview & { ids: string[] } {
  const ids = importedIds(account.id, txns);
  const existing = new Map(
    db
      .select({ id: transactions.id, importedId: transactions.importedId })
      .from(transactions)
      .where(and(eq(transactions.householdId, householdId), isNotNull(transactions.importedId)))
      .all()
      .map((r) => [r.importedId!, r.id]),
  );

  const dates = txns.map((t) => t.date).sort();
  const [firstDate, lastDate] = [dates[0] ?? "", dates.at(-1) ?? ""];
  const candidates = db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      payee: payees.name,
      importedId: transactions.importedId,
    })
    .from(transactions)
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(and(eq(transactions.accountId, account.id), isNull(transactions.parentId)))
    .all()
    .filter((c) => !isStatementId(c.importedId) || (c.date >= firstDate && c.date <= lastDate));
  // Transactions this file already brought in can't also match one of its other rows.
  const claimed = new Set(ids.flatMap((id) => (existing.has(id) ? [existing.get(id)!] : [])));

  // Category suggestions: what the payee was last categorised as.
  const lastCategory = new Map(
    db
      .all<{ name: string; categoryId: number }>(
        sql`
        select lower(p.name) as name, t.category_id as categoryId
        from transactions t join payees p on p.id = t.payee_id
        where t.household_id = ${householdId} and t.category_id is not null and t.parent_id is null
        order by t.date asc, t.id asc
      `,
      )
      .map((r) => [r.name, r.categoryId]),
  );

  const items: BankItem[] = txns.map((t, index) => {
    const base = {
      index,
      date: t.date,
      amount: t.amount,
      payee: t.payee,
      notes: t.notes,
      matchId: null,
      matchPayee: null,
      matchDate: null,
      suggestedCategoryId: null,
    };
    if (existing.has(ids[index]!)) return { ...base, status: "duplicate" as const };
    const match = candidates
      .filter(
        (c) =>
          !claimed.has(c.id) &&
          c.amount === t.amount &&
          Math.abs(dayNumber(c.date) - dayNumber(t.date)) <= MATCH_WINDOW_DAYS,
      )
      .sort(
        (a, b) =>
          Number(isStatementId(a.importedId)) - Number(isStatementId(b.importedId)) ||
          Math.abs(dayNumber(a.date) - dayNumber(t.date)) - Math.abs(dayNumber(b.date) - dayNumber(t.date)),
      )[0];
    if (match) {
      claimed.add(match.id);
      return { ...base, status: "match" as const, matchId: match.id, matchPayee: match.payee, matchDate: match.date };
    }
    return {
      ...base,
      status: "new" as const,
      suggestedCategoryId: account.onBudget ? (lastCategory.get(lower(t.payee)) ?? null) : null,
    };
  });

  const counts = { new: 0, duplicate: 0, match: 0 };
  for (const i of items) counts[i.status]++;
  return { items, counts, errors: [], ids };
}

/** Create the new rows and link the matches, as one undoable batch. */
export function commitBankImport(
  db: DbOrTx,
  actor: Actor,
  args: {
    account: { id: number; onBudget: boolean };
    format: "ofx" | "csv";
    fileName: string;
    plan: ReturnType<typeof planBankImport>;
    include: Set<number>;
    categories: Record<string, number | null>;
    validCategory: (id: number) => boolean;
  },
) {
  const { householdId, userId } = actor;
  const chosen = args.plan.items.filter((i) => args.include.has(i.index) && i.status !== "duplicate");
  const batch = db
    .insert(importBatches)
    .values({
      householdId,
      source: args.format,
      fileName: args.fileName,
      transactionCount: chosen.length,
      createdBy: userId,
    })
    .returning({ id: importBatches.id })
    .get();

  let created = 0;
  let matched = 0;
  for (const item of chosen) {
    const importedId = args.plan.ids[item.index]!;
    if (item.status === "match") {
      // Remember the transaction as it was, so undoing the import can put it back.
      const before = db
        .select({ importedId: transactions.importedId, cleared: transactions.cleared })
        .from(transactions)
        .where(eq(transactions.id, item.matchId!))
        .get()!;
      db.insert(importMatches)
        .values({
          batchId: batch.id,
          transactionId: item.matchId!,
          previousImportedId: before.importedId,
          previousCleared: before.cleared,
        })
        .run();
      db.update(transactions)
        .set({ importedId, cleared: true, updatedBy: userId })
        .where(eq(transactions.id, item.matchId!))
        .run();
      matched++;
      continue;
    }
    const chosenCategory =
      String(item.index) in args.categories ? args.categories[String(item.index)]! : item.suggestedCategoryId;
    const categoryId =
      args.account.onBudget && chosenCategory && args.validCategory(chosenCategory) ? chosenCategory : null;
    db.insert(transactions)
      .values({
        householdId,
        accountId: args.account.id,
        date: item.date,
        amount: item.amount,
        payeeId: item.payee ? findOrCreatePayee(db, householdId, item.payee, batch.id).id : null,
        categoryId,
        notes: item.notes,
        cleared: true,
        importedId,
        importBatchId: batch.id,
        createdBy: userId,
        updatedBy: userId,
      })
      .run();
    created++;
  }
  return { batchId: batch.id, created, matched };
}
