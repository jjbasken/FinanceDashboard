import { describe, expect, test } from "bun:test";
import type {
  Account,
  BudgetMonth,
  BudgetVsActualMonth,
  CashFlowMonth,
  CategoryBreakdown,
  CategoryGroup,
  NetWorthPoint,
  SpendingRow,
  YearComparison,
} from "@fd/shared";
import { yearComparison } from "../src/services/reports";
import { localDate } from "../src/util";
import { Client, fakePrices, owner, testApp } from "./helpers";

async function setUp() {
  const prices = fakePrices({ VTI: [{ date: "2026-02-27", close: 220_000_000 }] });
  const { app, db } = testApp({ priceProvider: prices.provider });
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const account = async (body: Record<string, unknown>) => (await c.post("/api/accounts", body)).json as Account;
  const txn = async (body: Record<string, unknown>) =>
    expect((await c.post("/api/transactions", body)).status).toBe(201);
  const groups = (await c.get("/api/categories")).json as CategoryGroup[];
  const cat = (name: string) => groups.flatMap((g) => g.categories).find((x) => x.name === name)!.id;

  const checking = await account({
    name: "Checking",
    type: "checking",
    startingBalance: 500_000,
    startingDate: "2026-01-01",
  });
  const visa = await account({ name: "Visa", type: "credit" });
  const savings = await account({ name: "Savings", type: "savings" });
  const brokerage = await account({ name: "Brokerage", type: "investment" });

  await txn({ accountId: checking.id, date: "2026-01-10", amount: -12_000, categoryId: cat("Groceries") });
  await txn({ accountId: visa.id, date: "2026-02-03", amount: -20_000, categoryId: cat("Dining Out") });
  await txn({ accountId: visa.id, date: "2026-02-04", amount: 2_000, categoryId: cat("Dining Out") }); // refund
  await txn({ accountId: checking.id, date: "2026-02-05", amount: -3_000, payeeName: "Mystery" });
  await txn({ accountId: checking.id, date: "2026-02-15", amount: 300_000, categoryId: cat("Income") });
  // Transfers between on-budget accounts are neither income, spending nor uncategorized.
  await txn({ accountId: checking.id, date: "2026-02-20", amount: -50_000, payeeId: savings.transferPayeeId });
  // Money into the brokerage, then shares. Moving money isn't spending, even with a category.
  await txn({
    accountId: checking.id,
    date: "2026-02-21",
    amount: -100_000,
    payeeId: brokerage.transferPayeeId,
    categoryId: cat("Emergency Fund"),
  });
  const vti = (await c.post("/api/investments/securities", { symbol: "VTI", name: "VTI", type: "etf" })).json;
  await c.post("/api/investments/transactions", {
    accountId: brokerage.id,
    securityId: vti.id,
    date: "2026-02-25",
    action: "buy",
    shares: 4_000_000,
    price: 200_000_000,
  });
  await c.post("/api/investments/prices/refresh");
  return { c, db, account, cat, txn, checking, visa };
}

describe("reports", () => {
  test("net worth adds accounts and holdings, with cards as liabilities", async () => {
    const { c } = await setUp();
    const points = (await c.get("/api/reports/net-worth?range=all")).json as NetWorthPoint[];
    const at = (date: string) => points.find((p) => p.date === date)!;
    expect(at("2026-01-31")).toEqual({ date: "2026-01-31", assets: 488_000, liabilities: 0, netWorth: 488_000 });
    // Feb: checking 488,000 - 3,000 + 300,000 - 50,000 - 100,000; savings 50,000; visa -18,000;
    // brokerage 100,000 cash - 80,000 for shares + 4 × $220.
    expect(at("2026-02-28")).toEqual({
      date: "2026-02-28",
      assets: 635_000 + 50_000 + 20_000 + 88_000,
      liabilities: -18_000,
      netWorth: 635_000 + 50_000 + 20_000 + 88_000 - 18_000,
    });
    expect((await c.get("/api/reports/net-worth?range=10y")).status).toBe(400);
  });

  test("net worth leaves out excluded accounts, cash and holdings alike", async () => {
    const { c } = await setUp();
    const worth = async () =>
      ((await c.get("/api/reports/net-worth?range=all")).json as NetWorthPoint[]).find((p) => p.date === "2026-02-28")!;
    const all = (await c.get("/api/accounts")).json as Account[];
    const brokerage = all.find((a) => a.name === "Brokerage")!;
    expect(brokerage.excludeFromNetWorth).toBe(false);

    expect((await c.patch(`/api/accounts/${brokerage.id}`, { excludeFromNetWorth: true })).status).toBe(200);
    // Without the brokerage's 20,000 cash and 88,000 of shares.
    expect(await worth()).toEqual({
      date: "2026-02-28",
      assets: 635_000 + 50_000,
      liabilities: -18_000,
      netWorth: 635_000 + 50_000 - 18_000,
    });
    const after = (await c.get("/api/accounts")).json as Account[];
    expect(after.find((a) => a.id === brokerage.id)!.excludeFromNetWorth).toBe(true);

    expect((await c.patch(`/api/accounts/${brokerage.id}`, { excludeFromNetWorth: false })).status).toBe(200);
    expect((await worth()).netWorth).toBe(635_000 + 50_000 + 20_000 + 88_000 - 18_000);
  });

  test("cash flow counts categorized income and spending per month", async () => {
    const { c } = await setUp();
    const months = (await c.get("/api/reports/cash-flow?from=2025-12&to=2026-03")).json as CashFlowMonth[];
    expect(months).toEqual([
      { month: "2025-12", income: 0, expenses: 0, net: 0 },
      // The account's opening balance isn't counted as income.
      { month: "2026-01", income: 0, expenses: 12_000, net: -12_000 },
      // Dining $200 less a $20 refund; the $1,000 moved to the brokerage isn't spending.
      { month: "2026-02", income: 300_000, expenses: 18_000, net: 282_000 },
      { month: "2026-03", income: 0, expenses: 0, net: 0 },
    ]);
  });

  test("spending by category, largest first, with uncategorized spending", async () => {
    const { c } = await setUp();
    const rows = (await c.get("/api/reports/spending?from=2026-01&to=2026-02")).json as SpendingRow[];
    expect(rows.map((r) => [r.name, r.groupName, r.amount])).toEqual([
      ["Dining Out", "Everyday", 18_000],
      ["Groceries", "Everyday", 12_000],
      ["Uncategorized", "", 3_000],
    ]);
    const feb = (await c.get("/api/reports/spending?from=2026-02&to=2026-02")).json as SpendingRow[];
    expect(feb.map((r) => r.name)).not.toContain("Groceries");
  });

  test("a loan payment's principal isn't spending, but its interest is", async () => {
    const { c, account, cat } = await setUp();
    const checking = (await c.get("/api/accounts")).json as Account[];
    const loan = await account({ name: "Mortgage", type: "loan", startingBalance: -30_000_000, startingDate: "2026-01-01" });
    // Uncategorised principal sent straight to the loan isn't spending either.
    await c.post("/api/transactions", {
      accountId: checking[0]!.id,
      date: "2026-03-02",
      amount: -5_000,
      payeeId: loan.transferPayeeId,
    });
    await c.post("/api/transactions", {
      accountId: checking[0]!.id,
      date: "2026-03-01",
      amount: -200_000,
      payeeName: "Bank",
      splits: [
        { amount: -150_000, categoryId: cat("Housing"), transferAccountId: loan.id },
        { amount: -50_000, categoryId: cat("Housing") },
      ],
    });
    const rows = (await c.get("/api/reports/spending?from=2026-03&to=2026-03")).json as SpendingRow[];
    expect(rows.map((r) => [r.name, r.amount])).toEqual([["Housing", 50_000]]);
    const [march] = (await c.get("/api/reports/cash-flow?from=2026-03&to=2026-03")).json as CashFlowMonth[];
    expect(march!.expenses).toBe(50_000);
    // The budget still counts the whole payment against Housing.
    const budget = (await c.get("/api/budget/2026-03")).json as BudgetMonth;
    expect(budget.groups.flatMap((g) => g.categories).find((x) => x.name === "Housing")!.activity).toBe(-200_000);
  });

  test("budget vs. actual matches the budget page's totals per month", async () => {
    const { c, cat } = await setUp();
    const budget = (month: string, name: string, amount: number) =>
      c.request("PUT", `/api/budget/${month}/categories/${cat(name)}`, { amount });
    await budget("2026-01", "Groceries", 15_000);
    await budget("2026-02", "Dining Out", 15_000);
    await budget("2026-02", "Emergency Fund", 100_000);
    const months = (await c.get("/api/reports/budget?from=2025-12&to=2026-03")).json as BudgetVsActualMonth[];
    expect(months).toEqual([
      { month: "2025-12", budgeted: 0, spent: 0, remaining: 0 },
      { month: "2026-01", budgeted: 15_000, spent: 12_000, remaining: 3_000 },
      // Dining $180 after the refund, plus the categorised $1,000 to the brokerage, as on the budget page.
      { month: "2026-02", budgeted: 115_000, spent: 118_000, remaining: -3_000 },
      { month: "2026-03", budgeted: 0, spent: 0, remaining: 0 },
    ]);
    const feb = (await c.get("/api/budget/2026-02")).json as BudgetMonth;
    expect([feb.budgeted, -feb.spent]).toEqual([115_000, 118_000]);
  });

  test("validates ranges and defaults to the last twelve months", async () => {
    const { c } = await setUp();
    expect((await c.get("/api/reports/cash-flow?from=2026-05&to=2026-01")).status).toBe(400);
    expect((await c.get("/api/reports/spending?from=jan")).status).toBe(400);
    expect((await c.get("/api/reports/cash-flow?from=1990-01&to=2026-01")).status).toBe(400);
    expect(((await c.get("/api/reports/cash-flow")).json as CashFlowMonth[]).length).toBe(12);
  });

  test("categories excluded from the budget are left out", async () => {
    const { c } = await setUp();
    const groups = (await c.get("/api/categories")).json as CategoryGroup[];
    const dining = groups.flatMap((g) => g.categories).find((x) => x.name === "Dining Out")!.id;
    expect((await c.patch(`/api/categories/${dining}`, { excludeFromBudget: true })).status).toBe(200);
    const feb = (await c.get("/api/reports/cash-flow?from=2026-02&to=2026-02")).json as CashFlowMonth[];
    expect(feb).toEqual([{ month: "2026-02", income: 300_000, expenses: 0, net: 300_000 }]);
    const rows = (await c.get("/api/reports/spending?from=2026-01&to=2026-02")).json as SpendingRow[];
    expect(rows.map((r) => r.name)).not.toContain("Dining Out");
  });

  test("breakdown splits income and spending by category, without opening balances or transfers", async () => {
    const { c } = await setUp();
    const b = (await c.get("/api/reports/breakdown?from=2026-01&to=2026-02")).json as CategoryBreakdown;
    expect(b.income.map((r) => [r.name, r.groupName, r.amount])).toEqual([["Income", "Income", 300_000]]);
    const spending = (await c.get("/api/reports/spending?from=2026-01&to=2026-02")).json as SpendingRow[];
    expect(b.expenses).toEqual(spending);
    expect((await c.get("/api/reports/breakdown?from=2026-03&to=2026-01")).status).toBe(400);
  });

  test("a year compares with the same whole months of the year before", async () => {
    const { db, cat, txn, checking, visa } = await setUp();
    await txn({ accountId: checking.id, date: "2025-01-20", amount: -9_000, categoryId: cat("Groceries") });
    await txn({ accountId: visa.id, date: "2025-02-10", amount: -4_000, categoryId: cat("Housing") });
    await txn({ accountId: checking.id, date: "2025-02-15", amount: 250_000, categoryId: cat("Income") });
    // After the comparison window: shown in last year's months, but not in its totals.
    await txn({ accountId: checking.id, date: "2025-03-05", amount: -7_000, categoryId: cat("Groceries") });

    // Mid-March 2026: January and February are whole months; March isn't yet.
    const r = yearComparison(db, 1, 2026, "2026-03-14");
    expect(r.through).toBe("2026-02");
    expect(r.firstYear).toBe(2025);
    expect(r.current.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(r.previous).toHaveLength(12);
    expect(r.previous[2]).toEqual({ month: "2025-03", income: 0, expenses: 7_000, net: -7_000 });
    const row = (name: string) => r.categories.find((x) => x.name === name);
    expect(row("Income")).toMatchObject({ isIncome: true, current: 300_000, previous: 250_000 });
    expect(row("Groceries")).toMatchObject({ isIncome: false, current: 12_000, previous: 9_000 });
    expect(row("Housing")).toMatchObject({ current: 0, previous: 4_000 });
    expect(row("Uncategorized")).toMatchObject({ categoryId: null, current: 3_000, previous: 0 });

    // A past year is compared in full.
    const past = yearComparison(db, 1, 2025, "2026-03-14");
    expect(past.through).toBe("2025-12");
    expect(past.categories.find((x) => x.name === "Groceries")).toMatchObject({ current: 16_000, previous: 0 });
  });

  test("compare validates the year", async () => {
    const { c } = await setUp();
    const today = localDate();
    const latest = today.slice(5, 7) === "01" ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4));
    expect(((await c.get("/api/reports/compare")).json as YearComparison).year).toBe(latest);
    expect((await c.get(`/api/reports/compare?year=${latest + 1}`)).status).toBe(400);
    expect((await c.get("/api/reports/compare?year=26")).status).toBe(400);
    expect((await c.get("/api/reports/compare?year=1990")).status).toBe(400);
  });
});
