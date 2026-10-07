import { describe, expect, test } from "bun:test";
import type {
  Account,
  BudgetMonth,
  CashFlowMonth,
  CategoryActivityItem,
  CategoryGroup,
  HoldingsSummary,
  NetWorthPoint,
  Payee,
  Transaction,
} from "@fd/shared";
import { Client, owner, testApp } from "./helpers";

/** A household with two members: the owner (Jeremy) and Sam, who has a private credit card. */
async function setUp() {
  const { app } = testApp();
  const jeremy = new Client(app);
  await jeremy.post("/api/auth/setup", owner);
  const invite = await jeremy.post("/api/household/invites");
  const sam = new Client(app);
  await sam.post("/api/auth/accept-invite", {
    token: invite.json.token,
    displayName: "Sam",
    username: "sam",
    password: "another good password",
  });

  const account = async (c: Client, body: Record<string, unknown>) => {
    const res = await c.post("/api/accounts", body);
    expect(res.status).toBe(201);
    return res.json as Account;
  };
  const txn = async (c: Client, body: Record<string, unknown>) => {
    const res = await c.post("/api/transactions", { date: "2026-10-05", ...body });
    expect(res.status).toBe(201);
    return res.json as Transaction;
  };
  const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
  const cat = (name: string) => groups.flatMap((g) => g.categories).find((x) => x.name === name)!.id;
  const accounts = async (c: Client) => ((await c.get("/api/accounts")).json as Account[]).map((a) => a.name);
  const budgetLine = async (c: Client, name: string) =>
    ((await c.get("/api/budget/2026-10")).json as BudgetMonth).groups
      .flatMap((g) => g.categories)
      .find((x) => x.name === name)!;

  const checking = await account(jeremy, { name: "Checking", type: "checking" });
  const card = await account(sam, { name: "Sam's Visa", type: "credit", private: true });
  return { app, jeremy, sam, account, txn, cat, accounts, budgetLine, checking, card };
}

describe("private accounts", () => {
  test("only their owner sees them, their registers and their transactions", async () => {
    const { jeremy, sam, txn, accounts, card } = await setUp();
    expect(card.private).toBe(true);
    expect(await accounts(sam)).toEqual(["Checking", "Sam's Visa"]);
    expect(await accounts(jeremy)).toEqual(["Checking"]);

    const gift = await txn(sam, { accountId: card.id, amount: -8000, payeeName: "Jewelry Store" });
    expect((await jeremy.get(`/api/accounts/${card.id}/transactions`)).status).toBe(404);
    expect((await jeremy.get(`/api/transactions/${gift.id}`)).status).toBe(404);
    expect((await jeremy.patch(`/api/transactions/${gift.id}`, { amount: -1 })).status).toBe(404);
    expect((await jeremy.delete(`/api/transactions/${gift.id}`)).status).toBe(404);
    expect((await jeremy.patch(`/api/accounts/${card.id}`, { name: "Mine" })).status).toBe(404);
    expect((await jeremy.delete(`/api/accounts/${card.id}`)).status).toBe(404);
    expect((await jeremy.post("/api/transactions", { accountId: card.id, date: "2026-10-01", amount: -1 })).status).toBe(
      404,
    );
  });

  test("transactions count in the family budget only when their owner includes them", async () => {
    const { jeremy, sam, txn, cat, budgetLine, card } = await setUp();
    await txn(sam, { accountId: card.id, amount: -8000, payeeName: "Jewelry Store", categoryId: cat("Personal") });
    const groceries = await txn(sam, {
      accountId: card.id,
      amount: -6000,
      payeeName: "Corner Grocer",
      categoryId: cat("Groceries"),
      inBudget: true,
    });
    expect(groceries.inBudget).toBe(true);
    for (const c of [jeremy, sam]) {
      expect((await budgetLine(c, "Groceries")).activity).toBe(-6000);
      expect((await budgetLine(c, "Personal")).activity).toBe(0);
    }
    // Included transactions show in full to everyone, but there's no register to open for others.
    const items = (await jeremy.get(`/api/budget/2026-10/categories/${cat("Groceries")}/transactions`))
      .json as CategoryActivityItem[];
    expect(items).toMatchObject([{ payeeName: "Corner Grocer", accountName: "Sam's Visa", privateAccount: true }]);
    const own = (await sam.get(`/api/budget/2026-10/categories/${cat("Groceries")}/transactions`))
      .json as CategoryActivityItem[];
    expect(own[0]!.privateAccount).toBe(false);

    // Taking it back out of the budget.
    await sam.patch(`/api/transactions/${groceries.id}`, { inBudget: false });
    expect((await budgetLine(jeremy, "Groceries")).activity).toBe(0);
    const [october] = (await jeremy.get("/api/reports/cash-flow?from=2026-10&to=2026-10")).json as CashFlowMonth[];
    expect(october!.expenses).toBe(0);
  });

  test("an included split counts each line; an uncategorized included purchase needs a category", async () => {
    const { jeremy, sam, txn, cat, budgetLine, card } = await setUp();
    await txn(sam, {
      accountId: card.id,
      amount: -10000,
      payeeName: "Big Box Store",
      inBudget: true,
      splits: [
        { amount: -7000, categoryId: cat("Groceries") },
        { amount: -3000, categoryId: cat("Household") },
      ],
    });
    expect((await budgetLine(jeremy, "Groceries")).activity).toBe(-7000);
    expect((await budgetLine(jeremy, "Household")).activity).toBe(-3000);
    await txn(sam, { accountId: card.id, amount: -500, payeeName: "Somewhere" });
    await txn(sam, { accountId: card.id, amount: -700, payeeName: "Somewhere", inBudget: true });
    expect(((await jeremy.get("/api/budget/2026-10")).json as BudgetMonth).uncategorized).toBe(1);
  });

  test("paying the card from family checking is a transfer, not spending, and only its owner can change it", async () => {
    const { jeremy, sam, txn, cat, budgetLine, checking, card } = await setUp();
    await txn(sam, { accountId: card.id, amount: -6000, categoryId: cat("Groceries"), inBudget: true });
    const payment = await txn(sam, { accountId: checking.id, amount: -6000, payeeId: card.transferPayeeId });
    expect(payment.categoryId).toBeNull();
    expect((await budgetLine(jeremy, "Groceries")).activity).toBe(-6000);
    expect(((await jeremy.get("/api/budget/2026-10")).json as BudgetMonth).uncategorized).toBe(0);

    // Jeremy sees the payment in checking, to "Private account", but can only clear it.
    const [seen] = (await jeremy.get(`/api/accounts/${checking.id}/transactions`)).json as Transaction[];
    expect(seen).toMatchObject({ id: payment.id, otherSidePrivate: true });
    const payees = (await jeremy.get("/api/payees")).json as Payee[];
    expect(payees.find((p) => p.id === card.transferPayeeId)!.name).toBe("Private account");
    expect((await jeremy.patch(`/api/transactions/${payment.id}`, { amount: -1 })).status).toBe(400);
    expect((await jeremy.delete(`/api/transactions/${payment.id}`)).status).toBe(400);
    expect((await jeremy.patch(`/api/transactions/${payment.id}`, { cleared: true })).status).toBe(200);
    // Nor can Jeremy start a transfer into Sam's card.
    const sneaky = await jeremy.post("/api/transactions", {
      accountId: checking.id,
      date: "2026-10-01",
      amount: -1,
      payeeId: card.transferPayeeId,
    });
    expect(sneaky.status).toBe(404);

    const [mine] = (await sam.get(`/api/accounts/${checking.id}/transactions`)).json as Transaction[];
    expect(mine!.otherSidePrivate).toBe(false);
    expect((await sam.patch(`/api/transactions/${payment.id}`, { amount: -5000 })).status).toBe(200);
  });

  test("net worth and investments only include what the viewer can see", async () => {
    const { jeremy, sam, txn, account, checking } = await setUp();
    await txn(jeremy, { accountId: checking.id, amount: 100_000 });
    const brokerage = await account(sam, { name: "Sam's Brokerage", type: "investment", private: true });
    await txn(sam, { accountId: brokerage.id, amount: 50_000 });
    const worth = async (c: Client) =>
      ((await c.get("/api/reports/net-worth?range=all")).json as NetWorthPoint[]).at(-1)!.netWorth;
    expect(await worth(jeremy)).toBe(100_000);
    expect(await worth(sam)).toBe(150_000);
    const holdings = async (c: Client) =>
      ((await c.get("/api/investments/holdings")).json as HoldingsSummary).accounts.map((a) => a.accountName);
    expect(await holdings(jeremy)).toEqual([]);
    expect(await holdings(sam)).toEqual(["Sam's Brokerage"]);
  });

  test("sharing and making private", async () => {
    const { jeremy, sam, accounts, card, checking } = await setUp();
    // Only the member who added a shared account can hide it.
    expect((await sam.patch(`/api/accounts/${checking.id}`, { private: true })).status).toBe(403);
    expect((await sam.patch(`/api/accounts/${card.id}`, { private: false })).status).toBe(200);
    expect(await accounts(jeremy)).toEqual(["Checking", "Sam's Visa"]);
    expect((await jeremy.patch(`/api/accounts/${checking.id}`, { private: true })).status).toBe(200);
    expect(await accounts(sam)).toEqual(["Sam's Visa"]);
  });

  test("another member can't undo an import into a private account", async () => {
    const { jeremy, sam, card } = await setUp();
    const up = await sam.upload(
      `/api/import/bank?accountId=${card.id}&name=visa.csv`,
      new TextEncoder().encode("Date,Description,Amount\n2026-10-01,Coffee,-4.50\n"),
    );
    expect(up.status).toBe(201);
    const commit = await sam.post(`/api/import/bank/${up.json.uploadId}/commit`, {
      csv: up.json.csv.suggested,
      include: [0],
    });
    expect(commit.status).toBe(201);
    expect((await jeremy.upload(`/api/import/bank?accountId=${card.id}&name=x.csv`, new Uint8Array([65]))).status).toBe(
      404,
    );
    const [batch] = (await jeremy.get("/api/import/batches")).json as { id: number }[];
    expect((await jeremy.post(`/api/import/batches/${batch!.id}/undo`, {})).status).toBe(403);
    expect((await sam.post(`/api/import/batches/${batch!.id}/undo`, {})).status).toBe(200);
  });
});
