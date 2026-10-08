import {
  addMonths,
  monthOf,
  nextOccurrence,
  occurrencesInMonth,
  type CreateScheduledBillInput,
  type ScheduledBill,
  type UpdateScheduledBillInput,
} from "@fd/shared";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Db, DbOrTx } from "../db";
import { accounts, scheduledBills, transactions } from "../db/schema";
import {
  assertCategory,
  canSee,
  createTransaction,
  getAccount,
  resolvePayee,
  visibleAccount,
  type Actor,
} from "./ledger";

type BillRow = typeof scheduledBills.$inferSelect;

const notFound = () => new HTTPException(404, { message: "Recurring bill not found" });
const badRequest = (message: string) => new HTTPException(400, { message });

function toApi(row: BillRow, today: string): ScheduledBill {
  return {
    id: row.id,
    accountId: row.accountId,
    amount: row.amount,
    payeeId: row.payeeId,
    categoryId: row.categoryId,
    notes: row.notes,
    frequency: row.frequency,
    startDate: row.startDate,
    endDate: row.endDate,
    paused: row.paused,
    postedThrough: row.postedThrough,
    nextDue: nextOccurrence(row, today),
  };
}

/** The recurring bills on accounts the member can see, in due-date order. */
export function listScheduledBills(db: DbOrTx, viewer: Actor, today: string): ScheduledBill[] {
  return db
    .select({ bill: scheduledBills, ownerId: accounts.ownerId })
    .from(scheduledBills)
    .innerJoin(accounts, eq(accounts.id, scheduledBills.accountId))
    .where(eq(scheduledBills.householdId, viewer.householdId))
    .orderBy(asc(scheduledBills.id))
    .all()
    .filter((r) => canSee(r, viewer.userId))
    .map((r) => toApi(r.bill, today))
    .sort((a, b) => (a.nextDue ?? "9999").localeCompare(b.nextDue ?? "9999") || a.id - b.id);
}

function getBill(db: DbOrTx, actor: Actor, id: number) {
  const row = db
    .select()
    .from(scheduledBills)
    .where(and(eq(scheduledBills.id, id), eq(scheduledBills.householdId, actor.householdId)))
    .get();
  if (!row) throw notFound();
  const account = getAccount(db, actor.householdId, row.accountId);
  if (!canSee(account, actor.userId)) throw notFound();
  return row;
}

export function getScheduledBill(db: DbOrTx, viewer: Actor, id: number, today: string) {
  return toApi(getBill(db, viewer, id), today);
}

/** Resolve and check the account, payee and category a bill will post with. */
function checkBill(
  db: DbOrTx,
  actor: Actor,
  input: { accountId: number; payeeId?: number | null; payeeName?: string; categoryId?: number | null },
) {
  const account = visibleAccount(db, actor, input.accountId);
  const payee = resolvePayee(db, actor.householdId, input);
  if (payee?.transferAccountId) {
    if (payee.transferAccountId === account.id) throw badRequest("An account can't transfer to itself");
    visibleAccount(db, actor, payee.transferAccountId);
  }
  assertCategory(db, actor.householdId, input.categoryId);
  return { payeeId: payee?.id ?? null };
}

export function createScheduledBill(db: DbOrTx, actor: Actor, input: CreateScheduledBillInput, today: string) {
  const { payeeId } = checkBill(db, actor, input);
  const row = db
    .insert(scheduledBills)
    .values({
      householdId: actor.householdId,
      accountId: input.accountId,
      amount: input.amount,
      payeeId,
      categoryId: input.categoryId ?? null,
      notes: input.notes ?? "",
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      paused: input.paused ?? false,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning()
    .get();
  // Don't wait for the 1st: this month's remaining occurrences show up straight away.
  if (!row.paused) postBill(db, row, today);
  return row.id;
}

/**
 * Change a bill. Rows it already posted stay as they are; the change applies to what it posts
 * from now on. Resuming a paused bill skips the months it was paused for.
 */
export function updateScheduledBill(
  db: DbOrTx,
  actor: Actor,
  id: number,
  input: UpdateScheduledBillInput,
  today: string,
) {
  const row = getBill(db, actor, id);
  const merged = {
    accountId: input.accountId ?? row.accountId,
    payeeId: input.payeeId !== undefined || input.payeeName !== undefined ? input.payeeId : row.payeeId,
    payeeName: input.payeeName,
    categoryId: input.categoryId !== undefined ? input.categoryId : row.categoryId,
  };
  const { payeeId } = checkBill(db, actor, merged);
  const startDate = input.startDate ?? row.startDate;
  const endDate = input.endDate !== undefined ? input.endDate : row.endDate;
  if (endDate && endDate < startDate) throw badRequest("The end date must be on or after the first due date");

  const resuming = row.paused && input.paused === false;
  const lastMonth = addMonths(monthOf(today), -1);
  const postedThrough =
    resuming && (row.postedThrough === null || row.postedThrough < lastMonth) ? lastMonth : row.postedThrough;

  const updated = db
    .update(scheduledBills)
    .set({
      accountId: merged.accountId,
      amount: input.amount ?? row.amount,
      payeeId,
      categoryId: merged.categoryId ?? null,
      notes: input.notes ?? row.notes,
      frequency: input.frequency ?? row.frequency,
      startDate,
      endDate,
      paused: input.paused ?? row.paused,
      postedThrough,
      updatedBy: actor.userId,
    })
    .where(eq(scheduledBills.id, id))
    .returning()
    .get();
  // A bill that hasn't posted this month yet (it was paused, or now starts sooner) catches up,
  // but a resumed bill doesn't post what fell due while it was paused.
  if (!updated.paused) postBill(db, updated, today, resuming ? today : undefined);
}

/** Delete a bill. What it already posted stays in the register. */
export function deleteScheduledBill(db: DbOrTx, actor: Actor, id: number) {
  getBill(db, actor, id);
  db.delete(scheduledBills).where(eq(scheduledBills.id, id)).run();
}

/**
 * Post each month the bill hasn't posted yet, up to and including this one: every occurrence in
 * the month becomes an uncleared transaction. Months missed while the server was down are caught
 * up. Returns how many transactions it created.
 */
function postBill(db: DbOrTx, bill: BillRow, today: string, notBefore?: string) {
  const thisMonth = monthOf(today);
  const startMonth = monthOf(bill.startDate);
  let month = bill.postedThrough ? addMonths(bill.postedThrough, 1) : startMonth;
  if (month < startMonth) month = startMonth;
  if (month > thisMonth) return 0;

  const account = getAccount(db, bill.householdId, bill.accountId);
  // Post as the account's owner for a private account, so the account is always visible to them.
  const userId = account.ownerId ?? bill.createdBy ?? bill.updatedBy;
  let created = 0;
  for (; month <= thisMonth; month = addMonths(month, 1)) {
    if (account.closed || userId === null) continue;
    for (const date of occurrencesInMonth(bill, month)) {
      if (notBefore && date < notBefore) continue;
      const id = createTransaction(
        db,
        { householdId: bill.householdId, userId },
        {
          accountId: bill.accountId,
          date,
          amount: bill.amount,
          payeeId: bill.payeeId,
          categoryId: bill.categoryId,
          notes: bill.notes,
        },
      );
      db.update(transactions).set({ scheduledBillId: bill.id }).where(eq(transactions.id, id)).run();
      created++;
    }
  }
  db.update(scheduledBills).set({ postedThrough: thisMonth }).where(eq(scheduledBills.id, bill.id)).run();
  return created;
}

/**
 * The scheduler's job, run at start-up and hourly: post every active bill's occurrences for each
 * month it hasn't posted yet. Each bill is its own transaction, so one bad bill can't block the
 * rest. Returns the households that got new transactions.
 */
export function postScheduledBills(db: Db, today: string) {
  const changed = new Set<number>();
  const thisMonth = monthOf(today);
  for (const bill of db.select().from(scheduledBills).where(eq(scheduledBills.paused, false)).all()) {
    if (bill.postedThrough !== null && bill.postedThrough >= thisMonth) continue;
    try {
      const created = db.transaction((tx) => postBill(tx, bill, today));
      if (created) changed.add(bill.householdId);
    } catch (err) {
      console.error(`Couldn't post recurring bill ${bill.id}:`, err);
    }
  }
  return changed;
}
