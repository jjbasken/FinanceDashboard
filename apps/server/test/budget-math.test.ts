import { describe, expect, test } from "bun:test";
import type { CategoryGroup } from "@fd/shared";
import { computeBudgetMonth, type MonthAmount } from "../src/services/budget";

const GROCERIES = 1;
const RENT = 2;
const SALARY = 10;

const groups: CategoryGroup[] = [
  {
    id: 1,
    name: "Everyday",
    isIncome: false,
    hidden: false,
    sortOrder: 0,
    categories: [
      { id: GROCERIES, groupId: 1, name: "Groceries", hidden: false, sortOrder: 0 },
      { id: RENT, groupId: 1, name: "Rent", hidden: true, sortOrder: 1 },
    ],
  },
  {
    id: 2,
    name: "Income",
    isIncome: true,
    hidden: false,
    sortOrder: 0,
    categories: [{ id: SALARY, groupId: 2, name: "Salary", hidden: false, sortOrder: 0 }],
  },
];

const row = (categoryId: number, month: string, amount: number): MonthAmount => ({ categoryId, month, amount });
const cat = (m: ReturnType<typeof computeBudgetMonth>, id: number) =>
  m.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;

describe("computeBudgetMonth", () => {
  test("an empty month is all zeros", () => {
    const m = computeBudgetMonth(groups, [], [], "2026-01");
    expect(m).toMatchObject({ month: "2026-01", toBudget: 0, income: 0, budgeted: 0, fromLastMonth: 0, lastMonthOverspent: 0 });
    expect(cat(m, GROCERIES)).toMatchObject({ budgeted: 0, activity: 0, balance: 0, carryIn: 0 });
  });

  test("income minus budgeted is To Budget; spending comes out of the category", () => {
    const m = computeBudgetMonth(
      groups,
      [row(GROCERIES, "2026-01", 50000)],
      [row(SALARY, "2026-01", 300000), row(GROCERIES, "2026-01", -30000)],
      "2026-01",
    );
    expect(m).toMatchObject({ income: 300000, budgeted: 50000, toBudget: 250000, spent: -30000 });
    expect(cat(m, GROCERIES)).toMatchObject({ budgeted: 50000, activity: -30000, balance: 20000 });
    expect(cat(m, SALARY)).toMatchObject({ budgeted: 0, activity: 300000, balance: 0 });
    const income = m.groups.find((g) => g.isIncome)!;
    expect(income.activity).toBe(300000);
  });

  test("positive balances roll over; overspending comes out of next month's To Budget", () => {
    const budgets = [row(GROCERIES, "2026-01", 50000), row(GROCERIES, "2026-02", 50000)];
    const activity = [
      row(SALARY, "2026-01", 300000),
      row(GROCERIES, "2026-01", -30000), // 200 left over
      row(GROCERIES, "2026-02", -80000), // 200 + 500 - 800 = -100 overspent
    ];

    const feb = computeBudgetMonth(groups, budgets, activity, "2026-02");
    expect(cat(feb, GROCERIES)).toMatchObject({ carryIn: 20000, budgeted: 50000, activity: -80000, balance: -10000 });
    expect(feb).toMatchObject({ fromLastMonth: 250000, income: 0, lastMonthOverspent: 0, budgeted: 50000, toBudget: 200000 });

    const mar = computeBudgetMonth(groups, budgets, activity, "2026-03");
    expect(cat(mar, GROCERIES)).toMatchObject({ carryIn: 0, balance: 0 });
    expect(mar).toMatchObject({ fromLastMonth: 200000, lastMonthOverspent: -10000, toBudget: 190000 });
  });

  test("budgeting more than you have goes negative and carries forward", () => {
    const m = computeBudgetMonth(
      groups,
      [row(GROCERIES, "2026-01", 70000)],
      [row(SALARY, "2026-01", 50000)],
      "2026-02",
    );
    expect(m.fromLastMonth).toBe(-20000);
    expect(m.toBudget).toBe(-20000);
    expect(cat(m, GROCERIES).balance).toBe(70000);
  });

  test("walks across gaps and years", () => {
    const m = computeBudgetMonth(
      groups,
      [row(RENT, "2025-11", 100000)],
      [row(SALARY, "2025-11", 100000), row(RENT, "2026-03", -40000)],
      "2026-03",
    );
    // Hidden categories still count.
    expect(cat(m, RENT)).toMatchObject({ carryIn: 100000, activity: -40000, balance: 60000 });
    expect(m.toBudget).toBe(0);
  });

  test("ignores data after the target month and budgets on income categories", () => {
    const m = computeBudgetMonth(
      groups,
      [row(SALARY, "2026-01", 99999), row(GROCERIES, "2026-02", 100)],
      [row(SALARY, "2026-01", 1000), row(SALARY, "2026-05", 5000)],
      "2026-01",
    );
    expect(m).toMatchObject({ income: 1000, budgeted: 0, toBudget: 1000 });
  });

  test("a month before any data is empty", () => {
    const m = computeBudgetMonth(groups, [], [row(SALARY, "2026-05", 5000)], "2026-01");
    expect(m.toBudget).toBe(0);
  });
});
