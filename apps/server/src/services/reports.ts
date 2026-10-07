import { addMonths, sharesValueCents, type CashFlowMonth, type NetWorthPoint, type SpendingRow } from "@fd/shared";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { accounts, transactions } from "../db/schema";
import { STARTING_BALANCES } from "./household";
import { inFamilyBudget, type Actor } from "./ledger";
import { type HistoryRange, loadPriceSeries, loadTxns, Position, priceOn, sampleDates } from "./holdings";

/** The value of every account the viewer can see (cash plus holdings at that day's price) at each sample date. */
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
      ),
    )
    .groupBy(transactions.accountId, transactions.date)
    .orderBy(asc(transactions.date))
    .all();
  const txns = loadTxns(db, householdId, viewer.userId);
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
 * Spending per expense category over a range of months, largest first. Uncategorized outflows
 * are included as their own row. Transfers are left out, as in cashFlow, and so are categories
 * excluded from the budget.
 */
export function spendingByCategory(db: DbOrTx, householdId: number, from: string, to: string): SpendingRow[] {
  const range = sql`t.date >= ${monthStart(from)} and t.date < ${monthStart(addMonths(to, 1))}`;
  const rows = db.all<SpendingRow>(sql`
    select c.id as categoryId, c.name as name, g.name as groupName, -sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    join categories c on c.id = t.category_id
    join category_groups g on g.id = c.group_id
    where t.household_id = ${householdId} and ${inFamilyBudget} and t.is_parent = 0 and g.is_income = 0
      and t.transfer_id is null and c.exclude_from_budget = 0 and ${range}
    group by c.id
  `);
  const [uncategorized] = db.all<{ amount: number | null }>(sql`
    select -sum(t.amount) as amount
    from transactions t
    join accounts a on a.id = t.account_id
    where t.household_id = ${householdId} and ${inFamilyBudget} and t.is_parent = 0 and t.category_id is null
      and t.amount < 0 and t.transfer_id is null and ${range}
  `);
  if (uncategorized?.amount) {
    rows.push({ categoryId: null, name: "Uncategorized", groupName: "", amount: uncategorized.amount });
  }
  return rows.filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount);
}
