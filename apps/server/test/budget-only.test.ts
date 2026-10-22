import { describe, expect, test } from "bun:test";
import type { Account, BudgetMonth, CategoryActivityItem, CategoryGroup, NetWorthPoint, Payee } from "@fd/shared";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  expect((await jeremy.post("/api/auth/setup", owner)).status).toBe(201);
  const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
  const ids = Object.fromEntries(groups.flatMap((g) => g.categories).map((c) => [c.name, c.id])) as Record<string, number>;
  const noAccount = (await jeremy.get("/api/accounts/budget-only")).json as Account;
  const checking = (await jeremy.post("/api/accounts", { name: "Checking", type: "checking" })).json as Account;
  return { app, db, jeremy, ids, noAccount, checking };
}

describe("the budget-only account", () => {
  test("every household has one, kept out of the account and payee lists", async () => {
    const { jeremy, noAccount } = await setUp();
    expect(noAccount).toMatchObject({ name: "No account", budgetOnly: true, onBudget: true, excludeFromNetWorth: true });
    expect(((await jeremy.get("/api/accounts")).json as Account[]).map((a) => a.name)).toEqual(["Checking"]);
    expect(((await jeremy.get("/api/payees")).json as Payee[]).map((p) => p.name)).toEqual(["Checking"]);
    expect((await jeremy.get(`/api/accounts/${noAccount.id}/transactions`)).status).toBe(200);
  });

  test("a purchase in it counts in the budget but not in net worth", async () => {
    const { jeremy, ids, noAccount, checking } = await setUp();
    await jeremy.post("/api/transactions", { accountId: checking.id, date: "2026-10-01", amount: 10_000 });
    const res = await jeremy.post("/api/transactions", {
      accountId: noAccount.id,
      date: "2026-10-05",
      amount: -4_200,
      payeeName: "Farmers market",
      categoryId: ids.Groceries,
    });
    expect(res.status).toBe(201);

    const oct = (await jeremy.get("/api/budget/2026-10")).json as BudgetMonth;
    expect(oct).toMatchObject({ spent: -4_200, uncategorized: 1 });
    const activity = (await jeremy.get(`/api/budget/2026-10/categories/${ids.Groceries}/transactions`))
      .json as CategoryActivityItem[];
    expect(activity.map((a) => [a.accountName, a.payeeName, a.amount])).toEqual([["No account", "Farmers market", -4_200]]);

    const points = (await jeremy.get("/api/reports/net-worth?range=all")).json as NetWorthPoint[];
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.netWorth === 10_000)).toBe(true);
  });

  test("it can't be changed, deleted, reconciled, transferred with or billed", async () => {
    const { jeremy, ids, noAccount, checking } = await setUp();
    expect((await jeremy.patch(`/api/accounts/${noAccount.id}`, { name: "Cash" })).status).toBe(400);
    expect((await jeremy.patch(`/api/accounts/${noAccount.id}`, { closed: true })).status).toBe(400);
    expect((await jeremy.request("DELETE", `/api/accounts/${noAccount.id}`)).status).toBe(400);
    expect((await jeremy.post(`/api/accounts/${noAccount.id}/reconcile`, { statementBalance: 0 })).status).toBe(400);

    const transfer = { date: "2026-10-05", amount: -1_000 };
    expect(
      (await jeremy.post("/api/transactions", { ...transfer, accountId: checking.id, payeeId: noAccount.transferPayeeId }))
        .status,
    ).toBe(400);
    expect(
      (await jeremy.post("/api/transactions", { ...transfer, accountId: noAccount.id, payeeId: checking.transferPayeeId }))
        .status,
    ).toBe(400);
    expect(
      (
        await jeremy.post("/api/transactions", {
          ...transfer,
          accountId: noAccount.id,
          splits: [
            { amount: -500, categoryId: ids.Groceries },
            { amount: -500, transferAccountId: checking.id },
          ],
        })
      ).status,
    ).toBe(400);

    const bill = { amount: -1_000, payeeName: "Gym", frequency: "monthly", startDate: "2026-11-01" };
    expect((await jeremy.post("/api/scheduled-bills", { ...bill, accountId: noAccount.id })).status).toBe(400);
  });

  test("investment writes and statement imports require a real account", async () => {
    const { jeremy, noAccount, checking } = await setUp();
    const security = await jeremy.post("/api/investments/securities", { symbol: "VTI", name: "Total Market", type: "etf" });
    expect(security.status).toBe(201);
    const investment = {
      securityId: security.json.id, date: "2026-10-05", action: "buy", shares: 1_000_000, price: 100_000_000,
    };
    expect((await jeremy.post("/api/investments/transactions", { ...investment, accountId: noAccount.id })).status).toBe(400);
    const real = await jeremy.post("/api/investments/transactions", { ...investment, accountId: checking.id });
    expect(real.status).toBe(201);
    const moved = await jeremy.request("PUT", `/api/investments/transactions/${real.json.id}`, {
      ...investment, accountId: noAccount.id,
    });
    expect(moved.status).toBe(400);
    expect((await jeremy.get(`/api/accounts/${checking.id}/transactions`)).json).toHaveLength(1);
    expect((await jeremy.get(`/api/accounts/${noAccount.id}/transactions`)).json).toEqual([]);
    const fund = await jeremy.upload(`/api/import/fund?accountId=${noAccount.id}`, new TextEncoder().encode(""));
    expect(fund.status).toBe(400);
    expect(fund.json.error).toContain("real account");
    const bank = await jeremy.upload(`/api/import/bank?accountId=${noAccount.id}`, new TextEncoder().encode(""));
    expect(bank.status).toBe(400);
    expect(bank.json.error).toContain("real account");
  });
});
