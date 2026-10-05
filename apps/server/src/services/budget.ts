import {
  addMonths,
  type BudgetGroup,
  type BudgetMonth,
  type CategoryActivityItem,
  type CategoryGroup,
} from "@fd/shared";
import { and, eq, lt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db";
import { budgetMonths, categories, categoryGroups } from "../db/schema";
import { listCategories } from "./categories";

export interface MonthAmount {
  categoryId: number;
  month: string;
  amount: number;
}

/**
 * Envelope budgeting, computed month by month from the first month with any data up to `target`:
 *
 * - Most categories start each month from zero: balance = budgeted + activity. Whatever was left
 *   unspent goes back to To Budget the next month.
 * - Categories with `rollover` keep a positive balance: balance = last month's balance + budgeted
 *   + activity. This is for money saved up over time.
 * - Overspending (a negative balance) never carries forward in a category; it comes out of next
 *   month's To Budget instead.
 * - To Budget = last month's To Budget + this month's income + last month's unspent (non-rollover)
 *   money + last month's overspending - this month's budgeted total. Over-budgeting carries forward.
 *
 * Income categories aren't budgeted; their activity is income.
 */
export function computeBudgetMonth(
  groups: CategoryGroup[],
  budgets: MonthAmount[],
  activity: MonthAmount[],
  target: string,
  uncategorized = 0,
): BudgetMonth {
  const incomeIds = new Set(groups.filter((g) => g.isIncome).flatMap((g) => g.categories.map((c) => c.id)));
  const expenseIds = groups.filter((g) => !g.isIncome).flatMap((g) => g.categories.map((c) => c.id));
  const rolloverIds = new Set(
    groups.filter((g) => !g.isIncome).flatMap((g) => g.categories.filter((c) => c.rollover).map((c) => c.id)),
  );

  const byMonth = (rows: MonthAmount[]) => {
    const map = new Map<string, Map<number, number>>();
    for (const r of rows) {
      if (r.month > target) continue;
      const m = map.get(r.month) ?? new Map<number, number>();
      m.set(r.categoryId, (m.get(r.categoryId) ?? 0) + r.amount);
      map.set(r.month, m);
    }
    return map;
  };
  const budgetsByMonth = byMonth(budgets);
  const activityByMonth = byMonth(activity);

  const months = [...budgetsByMonth.keys(), ...activityByMonth.keys()];
  let month = months.length ? months.reduce((a, b) => (a < b ? a : b)) : target;
  if (month > target) month = target;

  let prevBalance = new Map<number, number>();
  let prevToBudget = 0;
  const empty = new Map<number, number>();

  for (;;) {
    const budgeted = budgetsByMonth.get(month) ?? empty;
    const acts = activityByMonth.get(month) ?? empty;

    let income = 0;
    for (const [id, amount] of acts) if (incomeIds.has(id)) income += amount;

    let lastMonthOverspent = 0;
    let lastMonthLeftover = 0;
    for (const id of expenseIds) {
      const prev = prevBalance.get(id) ?? 0;
      if (prev < 0) lastMonthOverspent += prev;
      else if (!rolloverIds.has(id)) lastMonthLeftover += prev;
    }

    let budgetedTotal = 0;
    const carryIn = new Map<number, number>();
    const balance = new Map<number, number>();
    for (const id of expenseIds) {
      const b = budgeted.get(id) ?? 0;
      const c = rolloverIds.has(id) ? Math.max(0, prevBalance.get(id) ?? 0) : 0;
      budgetedTotal += b;
      carryIn.set(id, c);
      balance.set(id, c + b + (acts.get(id) ?? 0));
    }

    const fromLastMonth = prevToBudget;
    const toBudget = fromLastMonth + income + lastMonthLeftover + lastMonthOverspent - budgetedTotal;

    if (month === target) {
      let spent = 0;
      const outGroups: BudgetGroup[] = groups.map((g) => {
        const cats = g.categories.map((c) => {
          const act = acts.get(c.id) ?? 0;
          if (g.isIncome) {
            return { id: c.id, name: c.name, hidden: c.hidden, rollover: false, budgeted: 0, activity: act, carryIn: 0, balance: 0 };
          }
          spent += act;
          return {
            id: c.id,
            name: c.name,
            hidden: c.hidden,
            rollover: c.rollover,
            budgeted: budgeted.get(c.id) ?? 0,
            activity: act,
            carryIn: carryIn.get(c.id) ?? 0,
            balance: balance.get(c.id) ?? 0,
          };
        });
        const sum = (k: "budgeted" | "activity" | "balance") => cats.reduce((s, c) => s + c[k], 0);
        return {
          id: g.id,
          name: g.name,
          isIncome: g.isIncome,
          hidden: g.hidden,
          budgeted: sum("budgeted"),
          activity: sum("activity"),
          balance: sum("balance"),
          categories: cats,
        };
      });
      return {
        month,
        fromLastMonth,
        income,
        lastMonthLeftover,
        lastMonthOverspent,
        budgeted: budgetedTotal,
        toBudget,
        spent,
        uncategorized,
        groups: outGroups,
      };
    }

    prevBalance = balance;
    prevToBudget = toBudget;
    month = addMonths(month, 1);
  }
}

const monthStart = (month: string) => `${month}-01`;

/** Category activity per month from on-budget accounts, up to the end of `target`. */
function loadActivity(db: DbOrTx, householdId: number, target: string): MonthAmount[] {
  return db.all<MonthAmount>(sql`
    select t.category_id as categoryId, substr(t.date, 1, 7) as month, sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    where t.household_id = ${householdId}
      and a.on_budget = 1
      and t.is_parent = 0
      and t.category_id is not null
      and t.date < ${monthStart(addMonths(target, 1))}
    group by t.category_id, substr(t.date, 1, 7)
  `);
}

function loadBudgets(db: DbOrTx, householdId: number, target: string): MonthAmount[] {
  return db
    .select({ categoryId: budgetMonths.categoryId, month: budgetMonths.month, amount: budgetMonths.amount })
    .from(budgetMonths)
    .where(and(eq(budgetMonths.householdId, householdId), lt(budgetMonths.month, addMonths(target, 1))))
    .all();
}

/**
 * On-budget transactions in the month that have no category and need one. Transfers between
 * two on-budget accounts are deliberately uncategorised, so they don't count.
 */
function countUncategorized(db: DbOrTx, householdId: number, month: string) {
  const [row] = db.all<{ n: number }>(sql`
    select count(*) as n
    from transactions t
    join accounts a on a.id = t.account_id
    left join transactions o on o.id = t.transfer_id
    left join accounts oa on oa.id = o.account_id
    where t.household_id = ${householdId}
      and a.on_budget = 1
      and t.is_parent = 0
      and t.category_id is null
      and t.date >= ${monthStart(month)}
      and t.date < ${monthStart(addMonths(month, 1))}
      and (t.transfer_id is null or oa.on_budget = 0)
  `);
  return row?.n ?? 0;
}

export function getBudgetMonth(db: DbOrTx, householdId: number, month: string): BudgetMonth {
  return computeBudgetMonth(
    listCategories(db, householdId),
    loadBudgets(db, householdId, month),
    loadActivity(db, householdId, month),
    month,
    countUncategorized(db, householdId, month),
  );
}

function expenseCategory(db: DbOrTx, householdId: number, categoryId: number) {
  const row = db
    .select({ isIncome: categoryGroups.isIncome })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(and(eq(categories.id, categoryId), eq(categories.householdId, householdId)))
    .get();
  if (!row) throw new HTTPException(404, { message: "Category not found" });
  if (row.isIncome) throw new HTTPException(400, { message: "Income categories aren't budgeted" });
}

export function setBudget(
  db: DbOrTx,
  actor: { householdId: number; userId: number },
  month: string,
  categoryId: number,
  amount: number,
) {
  expenseCategory(db, actor.householdId, categoryId);
  if (amount === 0) {
    db.delete(budgetMonths)
      .where(and(eq(budgetMonths.categoryId, categoryId), eq(budgetMonths.month, month)))
      .run();
    return;
  }
  db.insert(budgetMonths)
    .values({ householdId: actor.householdId, categoryId, month, amount, updatedBy: actor.userId })
    .onConflictDoUpdate({
      target: [budgetMonths.categoryId, budgetMonths.month],
      set: { amount, updatedBy: actor.userId, updatedAt: new Date().toISOString() },
    })
    .run();
}

/** Set every expense category's budget for `month` to what it was the month before. */
export function copyLastMonth(db: DbOrTx, actor: { householdId: number; userId: number }, month: string) {
  const previous = db
    .select({ categoryId: budgetMonths.categoryId, amount: budgetMonths.amount })
    .from(budgetMonths)
    .where(and(eq(budgetMonths.householdId, actor.householdId), eq(budgetMonths.month, addMonths(month, -1))))
    .all();
  db.delete(budgetMonths)
    .where(and(eq(budgetMonths.householdId, actor.householdId), eq(budgetMonths.month, month)))
    .run();
  if (previous.length) {
    db.insert(budgetMonths)
      .values(previous.map((p) => ({ ...p, householdId: actor.householdId, month, updatedBy: actor.userId })))
      .run();
  }
}

/** The transactions behind a category's activity for one month, newest first. */
export function categoryActivity(
  db: DbOrTx,
  householdId: number,
  month: string,
  categoryId: number,
): CategoryActivityItem[] {
  return db.all<CategoryActivityItem>(sql`
    select t.id as id,
           coalesce(t.parent_id, t.id) as transactionId,
           t.account_id as accountId,
           a.name as accountName,
           t.date as date,
           case when p.transfer_account_id is not null then 'Transfer: ' || p.name else coalesce(p.name, '') end as payeeName,
           t.notes as notes,
           t.amount as amount
    from transactions t
    join accounts a on a.id = t.account_id
    left join payees p on p.id = t.payee_id
    where t.household_id = ${householdId}
      and a.on_budget = 1
      and t.is_parent = 0
      and t.category_id = ${categoryId}
      and t.date >= ${monthStart(month)}
      and t.date < ${monthStart(addMonths(month, 1))}
    order by t.date desc, t.id desc
  `);
}
