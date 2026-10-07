import {
  addMonths,
  type BudgetGroup,
  type BudgetMonth,
  type CategoryActivityItem,
  type CategoryGroup,
} from "@fd/shared";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db";
import { budgetMonths, categories, categoryGroups } from "../db/schema";
import { listCategories } from "./categories";

export interface CategoryAmount {
  categoryId: number;
  amount: number;
}

/**
 * A monthly spending plan. Every month stands on its own; nothing carries over from the month
 * before, whether unspent, overspent or never budgeted:
 *
 * - An expense category's balance is this month's budgeted + this month's activity.
 * - To Budget is this month's income - this month's budgeted total.
 *
 * Income categories aren't budgeted; their activity is income. An income category marked
 * forNextMonth (pay that lands at the end of the month) is budgeted the month after it arrives,
 * so its activity is last month's. A category excluded from the budget (e.g. reimbursable work
 * expenses) shows its activity but adds nothing to any total. `budgets` and `activity` hold this
 * month's totals per category and `lastMonthActivity` last month's.
 */
export function computeBudgetMonth(
  groups: CategoryGroup[],
  budgets: CategoryAmount[],
  activity: CategoryAmount[],
  month: string,
  uncategorized = 0,
  lastMonthActivity: CategoryAmount[] = [],
): BudgetMonth {
  const total = (rows: CategoryAmount[]) => {
    const map = new Map<number, number>();
    for (const r of rows) map.set(r.categoryId, (map.get(r.categoryId) ?? 0) + r.amount);
    return map;
  };
  const budgeted = total(budgets);
  const acts = total(activity);
  const lastActs = total(lastMonthActivity);
  let incomeFromLastMonth = 0;

  const outGroups: BudgetGroup[] = groups.map((g) => {
    const cats = g.categories.map((c) => {
      const excludeFromBudget = c.excludeFromBudget;
      const forNextMonth = g.isIncome && c.forNextMonth && !excludeFromBudget;
      const act = (forNextMonth ? lastActs : acts).get(c.id) ?? 0;
      if (forNextMonth) incomeFromLastMonth += act;
      const b = g.isIncome || excludeFromBudget ? 0 : (budgeted.get(c.id) ?? 0);
      return {
        id: c.id,
        name: c.name,
        hidden: c.hidden,
        forNextMonth,
        excludeFromBudget,
        budgeted: b,
        activity: act,
        balance: g.isIncome || excludeFromBudget ? 0 : b + act,
      };
    });
    const sum = (k: "budgeted" | "activity" | "balance") =>
      cats.reduce((s, c) => (c.excludeFromBudget ? s : s + c[k]), 0);
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

  const sumGroups = (income: boolean, k: "budgeted" | "activity") =>
    outGroups.filter((g) => g.isIncome === income).reduce((s, g) => s + g[k], 0);
  const income = sumGroups(true, "activity");
  const budgetedTotal = sumGroups(false, "budgeted");
  return {
    month,
    income,
    incomeFromLastMonth,
    budgeted: budgetedTotal,
    toBudget: income - budgetedTotal,
    spent: sumGroups(false, "activity"),
    uncategorized,
    groups: outGroups,
  };
}

const monthStart = (month: string) => `${month}-01`;

/** Category activity for the month from on-budget accounts. */
function loadActivity(db: DbOrTx, householdId: number, month: string): CategoryAmount[] {
  return db.all<CategoryAmount>(sql`
    select t.category_id as categoryId, sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    where t.household_id = ${householdId}
      and a.on_budget = 1
      and t.is_parent = 0
      and t.category_id is not null
      and t.date >= ${monthStart(month)}
      and t.date < ${monthStart(addMonths(month, 1))}
    group by t.category_id
  `);
}

function loadBudgets(db: DbOrTx, householdId: number, month: string): CategoryAmount[] {
  return db
    .select({ categoryId: budgetMonths.categoryId, amount: budgetMonths.amount })
    .from(budgetMonths)
    .where(and(eq(budgetMonths.householdId, householdId), eq(budgetMonths.month, month)))
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
    loadActivity(db, householdId, addMonths(month, -1)),
  );
}

/**
 * The month whose transactions make up a category's activity in `month`'s budget: the month
 * before for income that's budgeted the month after it arrives.
 */
function activityMonth(db: DbOrTx, householdId: number, month: string, categoryId: number) {
  const row = db
    .select({
      forNextMonth: categories.forNextMonth,
      excludeFromBudget: categories.excludeFromBudget,
      isIncome: categoryGroups.isIncome,
    })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(and(eq(categories.id, categoryId), eq(categories.householdId, householdId)))
    .get();
  return row?.isIncome && row.forNextMonth && !row.excludeFromBudget ? addMonths(month, -1) : month;
}

function expenseCategory(db: DbOrTx, householdId: number, categoryId: number) {
  const row = db
    .select({ isIncome: categoryGroups.isIncome, excludeFromBudget: categories.excludeFromBudget })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(and(eq(categories.id, categoryId), eq(categories.householdId, householdId)))
    .get();
  if (!row) throw new HTTPException(404, { message: "Category not found" });
  if (row.isIncome) throw new HTTPException(400, { message: "Income categories aren't budgeted" });
  if (row.excludeFromBudget) throw new HTTPException(400, { message: "This category is excluded from the budget" });
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

/** The transactions behind a category's activity in one month's budget, newest first. */
export function categoryActivity(
  db: DbOrTx,
  householdId: number,
  budgetMonth: string,
  categoryId: number,
): CategoryActivityItem[] {
  const month = activityMonth(db, householdId, budgetMonth, categoryId);
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
