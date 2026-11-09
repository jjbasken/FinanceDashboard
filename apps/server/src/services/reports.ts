import {
  addMonths,
  sharesValueCents,
  type CashFlowMonth,
  type CategoryBreakdown,
  type CategoryComparison,
  type CategoryTotal,
  type NetWorthPoint,
  type SpendingRow,
  type YearComparison,
} from "@fd/shared";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { accounts, transactions } from "../db/schema";
import { STARTING_BALANCES } from "./household";
import { inFamilyBudget, type Actor } from "./ledger";
import { type HistoryRange, loadPriceSeries, loadTxns, Position, priceOn, sampleDates } from "./holdings";

/**
 * The value of every account the viewer can see (cash plus holdings at that day's price) at each
 * sample date, except accounts excluded from net worth.
 */
export function netWorthHistory(db: DbOrTx, viewer: Actor, range: HistoryRange, today: string): NetWorthPoint[] {
  const { householdId } = viewer;
  const cash = db
    .select({
      accountId: transactions.accountId,
      date: transactions.date,
      amount: sql<number>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(transactions.householdId, householdId),
        isNull(transactions.parentId),
        or(isNull(accounts.ownerId), eq(accounts.ownerId, viewer.userId)),
        eq(accounts.excludeFromNetWorth, false),
      ),
    )
    .groupBy(transactions.accountId, transactions.date)
    .orderBy(asc(transactions.date))
    .all();
  const excluded = new Set(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.householdId, householdId), eq(accounts.excludeFromNetWorth, true)))
      .all()
      .map((a) => a.id),
  );
  const txns = loadTxns(db, householdId, viewer.userId).filter((t) => !excluded.has(t.accountId));
  const first = [cash[0]?.date, txns[0]?.date].filter((d): d is string => !!d).sort()[0];
  if (!first) return [];
  const series = loadPriceSeries(db, householdId, txns);

  const balances = new Map<number, number>();
  const positions = new Map<string, Position>();
  let ci = 0;
  let ti = 0;
  return sampleDates(range, first, today).map((date) => {
    while (ci < cash.length && cash[ci]!.date <= date) {
      const r = cash[ci++]!;
      balances.set(r.accountId, (balances.get(r.accountId) ?? 0) + r.amount);
    }
    while (ti < txns.length && txns[ti]!.date <= date) {
      const t = txns[ti++]!;
      const key = `${t.accountId}:${t.securityId}`;
      const p = positions.get(key) ?? new Position();
      p.apply(t);
      positions.set(key, p);
    }
    const value = new Map(balances);
    for (const [key, p] of positions) {
      if (!p.shares) continue;
      const [accountId, securityId] = key.split(":").map(Number) as [number, number];
      const price = priceOn(series.get(securityId), date);
      if (price) value.set(accountId, (value.get(accountId) ?? 0) + sharesValueCents(p.shares, price.close));
    }
    let assets = 0;
    let liabilities = 0;
    for (const v of value.values()) {
      if (v > 0) assets += v;
      else liabilities += v;
    }
    return { date, assets, liabilities, netWorth: assets + liabilities };
  });
}

const monthStart = (m: string) => `${m}-01`;

/**
 * Income and spending per month, by category, from what counts in the family budget: shared
 * on-budget accounts and private transactions their owner included. Unlike the budget page,
 * transfers are left out even when categorised: paying down a loan's principal or moving money
 * to a brokerage doesn't change net worth, so it isn't spending. Opening balances aren't income
 * earned in their month, so they're left out too, as are categories excluded from the budget.
 */
export function cashFlow(db: DbOrTx, householdId: number, from: string, to: string): CashFlowMonth[] {
  const rows = db.all<{ month: string; isIncome: number; amount: number }>(sql`
    select substr(t.date, 1, 7) as month, g.is_income as isIncome, sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    join categories c on c.id = t.category_id
    join category_groups g on g.id = c.group_id
    where t.household_id = ${householdId}
      and ${inFamilyBudget}
      and t.is_parent = 0
      and t.transfer_id is null
      and c.exclude_from_budget = 0
      and not (g.is_income = 1 and c.name = ${STARTING_BALANCES})
      and t.date >= ${monthStart(from)}
      and t.date < ${monthStart(addMonths(to, 1))}
    group by substr(t.date, 1, 7), g.is_income
  `);
  const out: CashFlowMonth[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) {
    const income = rows.find((r) => r.month === m && r.isIncome)?.amount ?? 0;
    const expenses = -(rows.find((r) => r.month === m && !r.isIncome)?.amount ?? 0);
    out.push({ month: m, income, expenses, net: income - expenses });
  }
  return out;
}

/**
 * Income and spending per category over a range of months, each largest first. Counts the same
 * money as cashFlow, except that uncategorized outflows are included as their own spending row.
 */
export function categoryBreakdown(db: DbOrTx, householdId: number, from: string, to: string): CategoryBreakdown {
  const range = sql`t.date >= ${monthStart(from)} and t.date < ${monthStart(addMonths(to, 1))}`;
  const rows = db.all<CategoryTotal & { isIncome: number }>(sql`
    select c.id as categoryId, c.name as name, g.name as groupName, g.is_income as isIncome,
      sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    join categories c on c.id = t.category_id
    join category_groups g on g.id = c.group_id
    where t.household_id = ${householdId} and ${inFamilyBudget} and t.is_parent = 0
      and t.transfer_id is null and c.exclude_from_budget = 0
      and not (g.is_income = 1 and c.name = ${STARTING_BALANCES})
      and ${range}
    group by c.id
  `);
  const income: CategoryTotal[] = [];
  const expenses: CategoryTotal[] = [];
  for (const { isIncome, ...r } of rows) {
    if (isIncome) income.push(r);
    else expenses.push({ ...r, amount: -r.amount });
  }
  const [uncategorized] = db.all<{ amount: number | null }>(sql`
    select -sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    where t.household_id = ${householdId} and ${inFamilyBudget} and t.is_parent = 0 and t.category_id is null
      and t.amount < 0 and t.transfer_id is null and ${range}
  `);
  if (uncategorized?.amount) {
    expenses.push({ categoryId: null, name: "Uncategorized", groupName: "", amount: uncategorized.amount });
  }
  const tidy = (list: CategoryTotal[]) => list.filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
  return { income: tidy(income), expenses: tidy(expenses) };
}

/** Spending per expense category over a range of months, largest first. */
export function spendingByCategory(db: DbOrTx, householdId: number, from: string, to: string): SpendingRow[] {
  return categoryBreakdown(db, householdId, from, to).expenses;
}

/** The latest year with at least one whole month behind it. */
export function latestComparableYear(today: string) {
  const year = Number(today.slice(0, 4));
  return today.slice(5, 7) === "01" ? year - 1 : year;
}

/**
 * One year against the year before, in whole months: a past year in full, and the current year
 * from January through last month, against the same months a year earlier.
 */
export function yearComparison(db: DbOrTx, householdId: number, year: number, today: string): YearComparison {
  const thisYear = Number(today.slice(0, 4));
  const through = year < thisYear ? `${year}-12` : addMonths(today.slice(0, 7), -1);
  const prior = year - 1;
  const priorThrough = `${prior}-${through.slice(5)}`;

  const now = categoryBreakdown(db, householdId, `${year}-01`, through);
  const then = categoryBreakdown(db, householdId, `${prior}-01`, priorThrough);
  const merged = new Map<string, CategoryComparison>();
  const add = (rows: CategoryTotal[], isIncome: boolean, field: "current" | "previous") => {
    for (const r of rows) {
      const key = `${isIncome}:${r.categoryId}`;
      const row = merged.get(key) ?? { ...r, isIncome, current: 0, previous: 0 };
      row[field] = r.amount;
      merged.set(key, row);
    }
  };
  add(now.income, true, "current");
  add(now.expenses, false, "current");
  add(then.income, true, "previous");
  add(then.expenses, false, "previous");
  const categories = [...merged.values()]
    .map(({ categoryId, name, groupName, isIncome, current, previous }) => ({
      categoryId,
      name,
      groupName,
      isIncome,
      current,
      previous,
    }))
    .sort((a, b) => b.current - a.current || b.previous - a.previous);

  const [first] = db.all<{ date: string | null }>(sql`
    select min(t.date) as date
    from transactions t
    join accounts a on a.id = t.account_id
    where t.household_id = ${householdId} and ${inFamilyBudget} and t.is_parent = 0
  `);
  const firstYear = Math.min(first?.date ? Number(first.date.slice(0, 4)) : year, year);

  return {
    year,
    through,
    firstYear,
    current: cashFlow(db, householdId, `${year}-01`, through),
    previous: cashFlow(db, householdId, `${prior}-01`, `${prior}-12`),
    categories,
  };
}
