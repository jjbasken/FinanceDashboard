import { describe, expect, test } from "bun:test";
import type { Account, BudgetMonth, CategoryActivityItem, CategoryGroup } from "@fd/shared";
import { createSession } from "../src/auth/sessions";
import { users } from "../src/db/schema";
import { createHousehold } from "../src/services/household";
import { SESSION_COOKIE } from "../src/middleware";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  expect((await jeremy.post("/api/auth/setup", owner)).status).toBe(201);
  const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
  const ids = Object.fromEntries(groups.flatMap((g) => g.categories).map((c) => [c.name, c.id])) as Record<string, number>;
  const account = async (body: Record<string, unknown>) => (await jeremy.post("/api/accounts", body)).json as Account;
  const txn = async (body: Record<string, unknown>) => {
    const res = await jeremy.post("/api/transactions", body);
    expect(res.status).toBe(201);
    return res.json;
  };
  const budget = async (month: string) => (await jeremy.get(`/api/budget/${month}`)).json as BudgetMonth;
  return { app, db, jeremy, ids, groups, account, txn, budget };
}

const category = (m: BudgetMonth, id: number) => m.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;

describe("budget API", () => {
  test("requires a session and a valid month", async () => {
    const { app, jeremy } = await setUp();
    expect((await new Client(app).get("/api/budget/2026-10")).status).toBe(401);
    expect((await jeremy.get("/api/budget/2026-13")).status).toBe(404);
    expect((await jeremy.get("/api/budget/october")).status).toBe(404);
  });

  test("starting balances are income; budgeting and spending flow through", async () => {
    const { jeremy, ids, account, txn, budget } = await setUp();
    const checking = await account({ name: "Checking", type: "checking", startingBalance: 300000, startingDate: "2026-10-01" });
    await txn({ accountId: checking.id, date: "2026-10-05", amount: -12000, categoryId: ids.Groceries });

    const set = await jeremy.request("PUT", `/api/budget/2026-10/categories/${ids.Groceries}`, { amount: 40000 });
    expect(set.status).toBe(200);
    const oct = set.json as BudgetMonth;
    expect(oct).toMatchObject({ income: 300000, budgeted: 40000, toBudget: 260000, spent: -12000 });
    expect(category(oct, ids.Groceries!)).toMatchObject({ budgeted: 40000, activity: -12000, balance: 28000 });

    // November starts from scratch: October's leftover, its unbudgeted income and its
    // starting balance don't carry over.
    await txn({ accountId: checking.id, date: "2026-11-02", amount: -5000, categoryId: ids.Groceries });
    const nov = await budget("2026-11");
    expect(nov).toMatchObject({ income: 0, budgeted: 0, toBudget: 0, spent: -5000 });
    expect(category(nov, ids.Groceries!)).toMatchObject({ budgeted: 0, activity: -5000, balance: -5000 });
    // ...and November's overspending doesn't touch December either.
    expect(await budget("2026-12")).toMatchObject({ toBudget: 0, spent: 0 });

    // Setting a budget back to zero removes it.
    await jeremy.request("PUT", `/api/budget/2026-10/categories/${ids.Groceries}`, { amount: 0 });
    expect((await budget("2026-10")).toBudget).toBe(300000);
  });

  test("off-budget accounts and on-budget transfers don't affect the budget", async () => {
    const { ids, account, txn, budget } = await setUp();
    const checking = await account({ name: "Checking", type: "checking", startingBalance: 100000, startingDate: "2026-10-01" });
    const savings = await account({ name: "Savings", type: "savings" });
    const brokerage = await account({ name: "Brokerage", type: "investment", startingBalance: 900000, startingDate: "2026-10-01" });
    await txn({ accountId: brokerage.id, date: "2026-10-02", amount: -5000, payeeName: "Fee" });
    await txn({ accountId: checking.id, date: "2026-10-03", amount: -20000, payeeId: savings.transferPayeeId });
    // Money leaving the budget for an off-budget account needs a category.
    await txn({
      accountId: checking.id,
      date: "2026-10-04",
      amount: -10000,
      payeeId: brokerage.transferPayeeId,
      categoryId: ids["Emergency Fund"],
    });
    await txn({ accountId: checking.id, date: "2026-10-05", amount: -700, payeeName: "Mystery" });
    await txn({ accountId: checking.id, date: "2026-10-06", amount: -300, payeeId: brokerage.transferPayeeId });

    const oct = await budget("2026-10");
    expect(oct.income).toBe(100000);
    expect(category(oct, ids["Emergency Fund"]!).activity).toBe(-10000);
    // The mystery spend and the uncategorized transfer to brokerage.
    expect(oct.uncategorized).toBe(2);
    expect((await budget("2026-11")).uncategorized).toBe(0);
  });

  test("split children count toward their own categories", async () => {
    const { jeremy, ids, account, txn, budget } = await setUp();
    const checking = await account({ name: "Checking", type: "checking" });
    const t = await txn({
      accountId: checking.id,
      date: "2026-10-10",
      amount: -10000,
      payeeName: "Big Box",
      splits: [
        { amount: -7000, categoryId: ids.Groceries },
        { amount: -3000, categoryId: ids.Household },
      ],
    });
    const oct = await budget("2026-10");
    expect(category(oct, ids.Groceries!).activity).toBe(-7000);
    expect(category(oct, ids.Household!).activity).toBe(-3000);
    expect(oct.uncategorized).toBe(0);

    const items = (await jeremy.get(`/api/budget/2026-10/categories/${ids.Household}/transactions`)).json as CategoryActivityItem[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ transactionId: t.id, accountName: "Checking", payeeName: "Big Box", amount: -3000 });
  });

  test("income categories can't be budgeted", async () => {
    const { jeremy, ids } = await setUp();
    const res = await jeremy.request("PUT", `/api/budget/2026-10/categories/${ids.Income}`, { amount: 100 });
    expect(res.status).toBe(400);
    expect((await jeremy.request("PUT", `/api/budget/2026-10/categories/99999`, { amount: 100 })).status).toBe(404);
    expect((await jeremy.request("PUT", `/api/budget/2026-10/categories/${ids.Groceries}`, { amount: 1.5 })).status).toBe(400);
  });

  test("copy last month replaces this month's budgets", async () => {
    const { jeremy, ids, budget } = await setUp();
    await jeremy.request("PUT", `/api/budget/2026-09/categories/${ids.Groceries}`, { amount: 40000 });
    await jeremy.request("PUT", `/api/budget/2026-09/categories/${ids.Housing}`, { amount: 150000 });
    await jeremy.request("PUT", `/api/budget/2026-10/categories/${ids.Vacation}`, { amount: 999 });

    const oct = (await jeremy.post("/api/budget/2026-10/copy-last-month")).json as BudgetMonth;
    expect(category(oct, ids.Groceries!).budgeted).toBe(40000);
    expect(category(oct, ids.Housing!).budgeted).toBe(150000);
    expect(category(oct, ids.Vacation!).budgeted).toBe(0);
    expect((await budget("2026-09")).budgeted).toBe(190000);
  });

  test("another household can't touch our budget", async () => {
    const { app, db, jeremy, ids, budget } = await setUp();
    const other = createHousehold(db, "Neighbours");
    const user = db
      .insert(users)
      .values({ householdId: other.id, username: "n", displayName: "N", passwordHash: "x", role: "owner" })
      .returning()
      .get();
    const intruder = new Client(app);
    intruder.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;

    expect((await intruder.request("PUT", `/api/budget/2026-10/categories/${ids.Groceries}`, { amount: 5 })).status).toBe(404);
    expect((await intruder.get(`/api/budget/2026-10/categories/${ids.Groceries}/transactions`)).json).toEqual([]);
    expect((await intruder.post(`/api/categories/${ids.Groceries}/move`, { groupId: 1, beforeId: null })).status).toBe(404);
    const theirs = (await intruder.get("/api/budget/2026-10")).json as BudgetMonth;
    expect(theirs.groups.flatMap((g) => g.categories).some((c) => c.id === ids.Groceries)).toBe(false);
    expect((await budget("2026-10")).budgeted).toBe(0);
    void jeremy;
  });
});

describe("reordering categories", () => {
  test("moves a category within and between groups", async () => {
    const { jeremy, ids, groups } = await setUp();
    const everyday = groups.find((g) => g.name === "Everyday")!;
    const bills = groups.find((g) => g.name === "Bills")!;

    let after = (await jeremy.post(`/api/categories/${ids.Personal}/move`, { groupId: everyday.id, beforeId: ids.Groceries }))
      .json as CategoryGroup[];
    expect(after.find((g) => g.id === everyday.id)!.categories.map((c) => c.name)).toEqual([
      "Personal",
      "Groceries",
      "Dining Out",
      "Transportation",
      "Household",
    ]);

    after = (await jeremy.post(`/api/categories/${ids.Groceries}/move`, { groupId: bills.id, beforeId: null })).json;
    expect(after.find((g) => g.id === bills.id)!.categories.map((c) => c.name).at(-1)).toBe("Groceries");
    expect(after.find((g) => g.id === everyday.id)!.categories.map((c) => c.name)).not.toContain("Groceries");

    // beforeId must be in the target group.
    expect((await jeremy.post(`/api/categories/${ids.Housing}/move`, { groupId: everyday.id, beforeId: ids.Utilities })).status).toBe(400);
  });

  test("moves groups, keeping income groups separate", async () => {
    const { jeremy, groups } = await setUp();
    const [bills, everyday, savings, income] = ["Bills", "Everyday", "Savings", "Income"].map((n) => groups.find((g) => g.name === n)!);
    const after = (await jeremy.post(`/api/categories/groups/${savings!.id}/move`, { beforeId: bills!.id })).json as CategoryGroup[];
    expect(after.map((g) => g.name)).toEqual(["Savings", "Bills", "Everyday", "Income"]);
    expect((await jeremy.post(`/api/categories/groups/${everyday!.id}/move`, { beforeId: income!.id })).status).toBe(400);
  });
});
