import { describe, expect, test } from "bun:test";
import type { Account, CashFlowMonth, CategoryGroup, NetWorthPoint, SpendingRow } from "@fd/shared";
import { Client, fakePrices, owner, testApp } from "./helpers";

async function setUp() {
  const prices = fakePrices({ VTI: [{ date: "2026-02-27", close: 220_000_000 }] });
  const { app } = testApp({ priceProvider: prices.provider });
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
  // Money into the brokerage, then shares.
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
  return { c };
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

  test("cash flow counts categorized income and spending per month", async () => {
    const { c } = await setUp();
    const months = (await c.get("/api/reports/cash-flow?from=2025-12&to=2026-03")).json as CashFlowMonth[];
    expect(months).toEqual([
      { month: "2025-12", income: 0, expenses: 0, net: 0 },
      // The account's opening balance isn't counted as income.
      { month: "2026-01", income: 0, expenses: 12_000, net: -12_000 },
      // Dining $200 less a $20 refund, plus $1,000 moved to the brokerage under Emergency Fund.
      { month: "2026-02", income: 300_000, expenses: 18_000 + 100_000, net: 182_000 },
      { month: "2026-03", income: 0, expenses: 0, net: 0 },
    ]);
  });

  test("spending by category, largest first, with uncategorized spending", async () => {
    const { c } = await setUp();
    const rows = (await c.get("/api/reports/spending?from=2026-01&to=2026-02")).json as SpendingRow[];
    expect(rows.map((r) => [r.name, r.groupName, r.amount])).toEqual([
      ["Emergency Fund", "Savings", 100_000],
      ["Dining Out", "Everyday", 18_000],
      ["Groceries", "Everyday", 12_000],
      ["Uncategorized", "", 3_000],
    ]);
    const feb = (await c.get("/api/reports/spending?from=2026-02&to=2026-02")).json as SpendingRow[];
    expect(feb.map((r) => r.name)).not.toContain("Groceries");
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
    expect(feb).toEqual([{ month: "2026-02", income: 300_000, expenses: 100_000, net: 200_000 }]);
    const rows = (await c.get("/api/reports/spending?from=2026-01&to=2026-02")).json as SpendingRow[];
    expect(rows.map((r) => r.name)).not.toContain("Dining Out");
  });
});
