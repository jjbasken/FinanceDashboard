import { describe, expect, test } from "bun:test";
import type { CategoryGroup } from "@fd/shared";
import { computeBudgetMonth, type CategoryAmount } from "../src/services/budget";

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

const row = (categoryId: number, amount: number): CategoryAmount => ({ categoryId, amount });
const cat = (m: ReturnType<typeof computeBudgetMonth>, id: number) =>
  m.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;

describe("computeBudgetMonth", () => {
  test("an empty month is all zeros", () => {
    const m = computeBudgetMonth(groups, [], [], "2026-01");
    expect(m).toMatchObject({ month: "2026-01", toBudget: 0, income: 0, budgeted: 0, spent: 0 });
    expect(cat(m, GROCERIES)).toMatchObject({ budgeted: 0, activity: 0, balance: 0 });
  });

  test("To Budget is income minus budgeted; a category's balance is budgeted plus activity", () => {
    const m = computeBudgetMonth(
      groups,
      [row(GROCERIES, 50000), row(RENT, 150000)],
      [row(SALARY, 300000), row(GROCERIES, -62000), row(RENT, -150000)],
      "2026-01",
    );
    expect(m).toMatchObject({ income: 300000, budgeted: 200000, toBudget: 100000, spent: -212000 });
    expect(cat(m, GROCERIES)).toMatchObject({ budgeted: 50000, activity: -62000, balance: -12000 });
    // Hidden categories still count.
    expect(cat(m, RENT)).toMatchObject({ budgeted: 150000, activity: -150000, balance: 0 });
    expect(cat(m, SALARY)).toMatchObject({ budgeted: 0, activity: 300000, balance: 0 });

    const everyday = m.groups.find((g) => g.id === 1)!;
    expect(everyday).toMatchObject({ budgeted: 200000, activity: -212000, balance: -12000 });
    expect(m.groups.find((g) => g.isIncome)!.activity).toBe(300000);
  });

  test("budgeting more than this month's income goes negative", () => {
    const m = computeBudgetMonth(groups, [row(GROCERIES, 70000)], [row(SALARY, 50000)], "2026-01");
    expect(m.toBudget).toBe(-20000);
  });

  test("budgets on income categories are ignored", () => {
    const m = computeBudgetMonth(groups, [row(SALARY, 99999)], [row(SALARY, 1000)], "2026-01");
    expect(m).toMatchObject({ income: 1000, budgeted: 0, toBudget: 1000 });
  });

  test("amounts for unknown categories are ignored", () => {
    const m = computeBudgetMonth(groups, [row(999, 500)], [row(999, -500)], "2026-01");
    expect(m).toMatchObject({ budgeted: 0, spent: 0, toBudget: 0 });
  });
});
