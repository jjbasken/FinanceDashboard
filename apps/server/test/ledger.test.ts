import { describe, expect, test } from "bun:test";
import type { Account, CategoryGroup, Payee, Transaction } from "@fd/shared";
import { createSession } from "../src/auth/sessions";
import { users } from "../src/db/schema";
import { createHousehold } from "../src/services/household";
import { SESSION_COOKIE } from "../src/middleware";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  expect((await jeremy.post("/api/auth/setup", owner)).status).toBe(201);
  return { app, db, jeremy };
}

async function newAccount(c: Client, body: Record<string, unknown>) {
  const res = await c.post("/api/accounts", body);
  expect(res.status).toBe(201);
  return res.json as Account;
}

async function addTxn(c: Client, body: Record<string, unknown>) {
  const res = await c.post("/api/transactions", { date: "2026-01-15", ...body });
  expect(res.status).toBe(201);
  return res.json as Transaction;
}

async function accounts(c: Client) {
  return (await c.get("/api/accounts")).json as Account[];
}

async function balanceOf(c: Client, id: number) {
  return (await accounts(c)).find((a) => a.id === id)!.balance;
}

async function register(c: Client, accountId: number) {
  return (await c.get(`/api/accounts/${accountId}/transactions`)).json as Transaction[];
}

async function categoryId(c: Client, name: string) {
  const groups = (await c.get("/api/categories")).json as CategoryGroup[];
  return groups.flatMap((g) => g.categories).find((cat) => cat.name === name)!.id;
}

describe("access control", () => {
  test("ledger endpoints require a session", async () => {
    const { app } = await setUp();
    const anon = new Client(app);
    for (const path of ["/api/accounts", "/api/categories", "/api/payees", "/api/transactions/1"]) {
      expect((await anon.get(path)).status).toBe(401);
    }
    expect((await anon.post("/api/accounts", { name: "x", type: "cash" })).status).toBe(401);
  });

  test("another household can't see or change our data", async () => {
    const { app, db, jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking", startingBalance: 1000 });
    const [txn] = await register(jeremy, checking.id);

    // A second household can't be created through the API, so build one directly.
    const other = createHousehold(db, "Neighbours");
    const user = db
      .insert(users)
      .values({ householdId: other.id, username: "neighbour", displayName: "N", passwordHash: "x", role: "owner" })
      .returning()
      .get();
    const intruder = new Client(app);
    intruder.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;

    expect(await accounts(intruder)).toEqual([]);
    expect((await intruder.get(`/api/accounts/${checking.id}/transactions`)).status).toBe(404);
    expect((await intruder.get(`/api/transactions/${txn!.id}`)).status).toBe(404);
    expect((await intruder.patch(`/api/accounts/${checking.id}`, { name: "Mine" })).status).toBe(404);
    expect((await intruder.patch(`/api/transactions/${txn!.id}`, { amount: 1 })).status).toBe(404);
    expect((await intruder.delete(`/api/transactions/${txn!.id}`)).status).toBe(404);
    expect((await intruder.post("/api/transactions", { accountId: checking.id, date: "2026-01-01", amount: 5 })).status).toBe(404);

    // Nor point their own transactions at our categories or payees.
    const theirs = await newAccount(intruder, { name: "Theirs", type: "cash" });
    const ourCategory = await categoryId(jeremy, "Groceries");
    const bad = await intruder.post("/api/transactions", {
      accountId: theirs.id,
      date: "2026-01-01",
      amount: -5,
      categoryId: ourCategory,
    });
    expect(bad.status).toBe(404);
    const transferToUs = await intruder.post("/api/transactions", {
      accountId: theirs.id,
      date: "2026-01-01",
      amount: -5,
      payeeId: checking.transferPayeeId,
    });
    expect(transferToUs.status).toBe(404);
    expect(await balanceOf(jeremy, checking.id)).toBe(1000);
  });

  test("both members of a household see and edit the same ledger", async () => {
    const { app, jeremy } = await setUp();
    const invite = await jeremy.post("/api/household/invites");
    const spouse = new Client(app);
    await spouse.post("/api/auth/accept-invite", {
      token: invite.json.token,
      displayName: "Sam",
      username: "sam",
      password: "another good password",
    });

    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const txn = await addTxn(spouse, { accountId: checking.id, amount: -2500, payeeName: "Grocer" });
    expect((await accounts(spouse)).map((a) => a.name)).toEqual(["Checking"]);

    const seen = await register(jeremy, checking.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.createdBy).toBe(seen[0]!.updatedBy!);

    await jeremy.patch(`/api/transactions/${txn.id}`, { notes: "weekly shop" });
    const after = (await spouse.get(`/api/transactions/${txn.id}`)).json as Transaction;
    expect(after.notes).toBe("weekly shop");
    expect(after.createdBy).not.toBe(after.updatedBy);
  });
});

describe("accounts", () => {
  test("a new household starts with default categories", async () => {
    const { jeremy } = await setUp();
    const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
    expect(groups.map((g) => g.name)).toContain("Everyday");
    const income = groups.find((g) => g.isIncome)!;
    expect(income.categories.map((c) => c.name)).toEqual(["Income", "Starting Balances"]);
    // Income groups sort last.
    expect(groups.at(-1)!.isIncome).toBe(true);
  });

  test("creating an account with a starting balance", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, {
      name: "Checking",
      type: "checking",
      startingBalance: 123456,
      startingDate: "2026-01-01",
    });
    expect(checking).toMatchObject({ name: "Checking", onBudget: true, closed: false, balance: 123456, clearedBalance: 123456 });

    const [start] = await register(jeremy, checking.id);
    expect(start).toMatchObject({ date: "2026-01-01", amount: 123456, cleared: true });
    expect(start!.categoryId).toBe(await categoryId(jeremy, "Starting Balances"));

    const brokerage = await newAccount(jeremy, { name: "Brokerage", type: "investment", startingBalance: 500 });
    expect(brokerage.onBudget).toBe(false);
    expect((await register(jeremy, brokerage.id))[0]!.categoryId).toBeNull();
  });

  test("validates input", async () => {
    const { jeremy } = await setUp();
    expect((await jeremy.post("/api/accounts", { name: "", type: "checking" })).status).toBe(400);
    expect((await jeremy.post("/api/accounts", { name: "X", type: "bitcoin" })).status).toBe(400);
    expect((await jeremy.post("/api/accounts", { name: "X", type: "cash", startingBalance: 1.5 })).status).toBe(400);
    expect((await jeremy.post("/api/accounts", { name: "X", type: "cash", startingDate: "2026-02-30" })).status).toBe(400);
  });

  test("renaming an account renames its transfer payee", async () => {
    const { jeremy } = await setUp();
    const savings = await newAccount(jeremy, { name: "Savings", type: "savings" });
    await jeremy.patch(`/api/accounts/${savings.id}`, { name: "Rainy Day" });
    const payees = (await jeremy.get("/api/payees")).json as Payee[];
    expect(payees.find((p) => p.transferAccountId === savings.id)!.name).toBe("Rainy Day");
    expect((await jeremy.patch(`/api/payees/${savings.transferPayeeId}`, { name: "x" })).status).toBe(400);
  });

  test("an account can only be closed once its balance is zero", async () => {
    const { jeremy } = await setUp();
    const cash = await newAccount(jeremy, { name: "Wallet", type: "cash", startingBalance: 2000 });
    const res = await jeremy.patch(`/api/accounts/${cash.id}`, { closed: true });
    expect(res.status).toBe(400);
    await addTxn(jeremy, { accountId: cash.id, amount: -2000 });
    expect((await jeremy.patch(`/api/accounts/${cash.id}`, { closed: true })).json.closed).toBe(true);
  });

  test("reconciling locks cleared transactions when the statement matches", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking", startingBalance: 10000 });
    const a = await addTxn(jeremy, { accountId: checking.id, amount: -1500, cleared: true });
    const b = await addTxn(jeremy, { accountId: checking.id, amount: -700 });

    expect((await jeremy.post(`/api/accounts/${checking.id}/reconcile`, { statementBalance: 9000 })).status).toBe(400);
    const ok = await jeremy.post(`/api/accounts/${checking.id}/reconcile`, { statementBalance: 8500 });
    expect(ok.json).toMatchObject({ clearedBalance: 8500, balance: 7800 });

    const rows = await register(jeremy, checking.id);
    expect(rows.find((t) => t.id === a.id)!.reconciled).toBe(true);
    expect(rows.find((t) => t.id === b.id)!.reconciled).toBe(false);

    // Un-clearing a reconciled transaction un-reconciles it.
    const edited = (await jeremy.patch(`/api/transactions/${a.id}`, { cleared: false })).json as Transaction;
    expect(edited.reconciled).toBe(false);
  });

  test("deleting an account keeps the other side of its transfers", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const savings = await newAccount(jeremy, { name: "Savings", type: "savings" });
    await addTxn(jeremy, { accountId: checking.id, amount: -5000, payeeId: savings.transferPayeeId });

    expect((await jeremy.delete(`/api/accounts/${savings.id}`)).status).toBe(200);
    const [left] = await register(jeremy, checking.id);
    expect(left).toMatchObject({ amount: -5000, transferId: null, payeeId: null });
    expect((await accounts(jeremy)).map((a) => a.name)).toEqual(["Checking"]);
  });
});

describe("transactions", () => {
  test("running balance follows date order, newest first", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    await addTxn(jeremy, { accountId: checking.id, date: "2026-01-10", amount: 10000 });
    await addTxn(jeremy, { accountId: checking.id, date: "2026-01-05", amount: -2000 });
    await addTxn(jeremy, { accountId: checking.id, date: "2026-01-20", amount: -500 });

    const rows = await register(jeremy, checking.id);
    expect(rows.map((t) => [t.date, t.runningBalance])).toEqual([
      ["2026-01-20", 7500],
      ["2026-01-10", 8000],
      ["2026-01-05", -2000],
    ]);
  });

  test("payees are found or created by name, case-insensitively", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const a = await addTxn(jeremy, { accountId: checking.id, amount: -100, payeeName: "Corner Shop" });
    const b = await addTxn(jeremy, { accountId: checking.id, amount: -200, payeeName: "corner shop" });
    expect(a.payeeId).toBe(b.payeeId!);
    const regular = ((await jeremy.get("/api/payees")).json as Payee[]).filter((p) => !p.transferAccountId);
    expect(regular.map((p) => p.name)).toEqual(["Corner Shop"]);
  });

  test("edits and deletes", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const groceries = await categoryId(jeremy, "Groceries");
    const txn = await addTxn(jeremy, { accountId: checking.id, amount: -100, categoryId: groceries });

    const edited = await jeremy.patch(`/api/transactions/${txn.id}`, { amount: -250, date: "2026-02-01", categoryId: null });
    expect(edited.json).toMatchObject({ amount: -250, date: "2026-02-01", categoryId: null });
    expect((await jeremy.patch(`/api/transactions/${txn.id}`, { date: "yesterday" })).status).toBe(400);

    expect((await jeremy.delete(`/api/transactions/${txn.id}`)).status).toBe(200);
    expect(await register(jeremy, checking.id)).toEqual([]);
    expect((await jeremy.delete(`/api/transactions/${txn.id}`)).status).toBe(404);
  });

  test("deleting a category can move its transactions to another", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const dining = await categoryId(jeremy, "Dining Out");
    const groceries = await categoryId(jeremy, "Groceries");
    const a = await addTxn(jeremy, { accountId: checking.id, amount: -100, categoryId: dining });

    expect((await jeremy.delete(`/api/categories/${dining}?transferTo=${dining}`)).status).toBe(400);
    expect((await jeremy.delete(`/api/categories/${dining}?transferTo=${groceries}`)).status).toBe(200);
    expect(((await jeremy.get(`/api/transactions/${a.id}`)).json as Transaction).categoryId).toBe(groceries);

    expect((await jeremy.delete(`/api/categories/${groceries}`)).status).toBe(200);
    expect(((await jeremy.get(`/api/transactions/${a.id}`)).json as Transaction).categoryId).toBeNull();
  });
});

describe("transfers", () => {
  async function twoAccounts() {
    const ctx = await setUp();
    const checking = await newAccount(ctx.jeremy, { name: "Checking", type: "checking", startingBalance: 100000 });
    const savings = await newAccount(ctx.jeremy, { name: "Savings", type: "savings" });
    const brokerage = await newAccount(ctx.jeremy, { name: "Brokerage", type: "investment" });
    return { ...ctx, checking, savings, brokerage };
  }

  test("creating a transfer writes both sides", async () => {
    const { jeremy, checking, savings } = await twoAccounts();
    const out = await addTxn(jeremy, {
      accountId: checking.id,
      amount: -25000,
      payeeId: savings.transferPayeeId,
      notes: "monthly",
      categoryId: await categoryId(jeremy, "Groceries"),
    });
    expect(out.transferId).not.toBeNull();
    // On-budget to on-budget transfers aren't categorised.
    expect(out.categoryId).toBeNull();

    const [into] = await register(jeremy, savings.id);
    expect(into).toMatchObject({ amount: 25000, transferId: out.id, payeeId: checking.transferPayeeId, notes: "monthly" });
    expect(await balanceOf(jeremy, checking.id)).toBe(75000);
    expect(await balanceOf(jeremy, savings.id)).toBe(25000);
  });

  test("a transfer to an off-budget account keeps its category on the budget side", async () => {
    const { jeremy, checking, brokerage } = await twoAccounts();
    const savingsCat = await categoryId(jeremy, "Emergency Fund");
    const out = await addTxn(jeremy, {
      accountId: checking.id,
      amount: -1000,
      payeeId: brokerage.transferPayeeId,
      categoryId: savingsCat,
    });
    expect(out.categoryId).toBe(savingsCat);
    expect((await register(jeremy, brokerage.id))[0]!.categoryId).toBeNull();
  });

  test("edits to either side stay mirrored", async () => {
    const { jeremy, checking, savings } = await twoAccounts();
    const out = await addTxn(jeremy, { accountId: checking.id, amount: -1000, payeeId: savings.transferPayeeId });

    await jeremy.patch(`/api/transactions/${out.id}`, { amount: -1500, date: "2026-03-01" });
    let into = (await register(jeremy, savings.id))[0]!;
    expect(into).toMatchObject({ amount: 1500, date: "2026-03-01" });

    await jeremy.patch(`/api/transactions/${into.id}`, { amount: 2000, notes: "edited from savings" });
    const mirrored = (await jeremy.get(`/api/transactions/${out.id}`)).json as Transaction;
    expect(mirrored).toMatchObject({ amount: -2000, notes: "edited from savings" });
    into = (await register(jeremy, savings.id))[0]!;
    expect(into.amount).toBe(2000);
  });

  test("changing the payee moves or removes the other side", async () => {
    const { jeremy, checking, savings, brokerage } = await twoAccounts();
    const out = await addTxn(jeremy, { accountId: checking.id, amount: -1000, payeeId: savings.transferPayeeId });

    await jeremy.patch(`/api/transactions/${out.id}`, { payeeId: brokerage.transferPayeeId });
    expect(await register(jeremy, savings.id)).toEqual([]);
    expect((await register(jeremy, brokerage.id))[0]!.amount).toBe(1000);

    const plain = (await jeremy.patch(`/api/transactions/${out.id}`, { payeeName: "Landlord" })).json as Transaction;
    expect(plain.transferId).toBeNull();
    expect(await register(jeremy, brokerage.id)).toEqual([]);

    // And a plain transaction can become a transfer.
    const again = (await jeremy.patch(`/api/transactions/${out.id}`, { payeeId: savings.transferPayeeId })).json as Transaction;
    expect(again.transferId).not.toBeNull();
    expect((await register(jeremy, savings.id))[0]!.amount).toBe(1000);
  });

  test("deleting one side deletes both", async () => {
    const { jeremy, checking, savings } = await twoAccounts();
    const out = await addTxn(jeremy, { accountId: checking.id, amount: -1000, payeeId: savings.transferPayeeId });
    const [into] = await register(jeremy, savings.id);
    await jeremy.delete(`/api/transactions/${into!.id}`);
    expect((await jeremy.get(`/api/transactions/${out.id}`)).status).toBe(404);
    expect(await balanceOf(jeremy, checking.id)).toBe(100000);
  });

  test("rejects transfers to the same account and split transfers", async () => {
    const { jeremy, checking, savings } = await twoAccounts();
    const self = await jeremy.post("/api/transactions", {
      accountId: checking.id,
      date: "2026-01-01",
      amount: -1,
      payeeId: checking.transferPayeeId,
    });
    expect(self.status).toBe(400);
    const split = await jeremy.post("/api/transactions", {
      accountId: checking.id,
      date: "2026-01-01",
      amount: -2,
      payeeId: savings.transferPayeeId,
      splits: [{ amount: -1 }, { amount: -1 }],
    });
    expect(split.status).toBe(400);
  });
});

describe("split transactions", () => {
  test("splits must add up, and only the parent counts toward the balance", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const groceries = await categoryId(jeremy, "Groceries");
    const household = await categoryId(jeremy, "Household");

    const bad = await jeremy.post("/api/transactions", {
      accountId: checking.id,
      date: "2026-01-01",
      amount: -10000,
      splits: [{ amount: -6000, categoryId: groceries }, { amount: -3000, categoryId: household }],
    });
    expect(bad.status).toBe(400);

    const txn = await addTxn(jeremy, {
      accountId: checking.id,
      amount: -10000,
      payeeName: "Big Box Store",
      categoryId: groceries,
      splits: [
        { amount: -6000, categoryId: groceries, notes: "food" },
        { amount: -4000, categoryId: household },
      ],
    });
    expect(txn.categoryId).toBeNull();
    expect(txn.splits.map((s) => [s.amount, s.categoryId, s.notes])).toEqual([
      [-6000, groceries, "food"],
      [-4000, household, ""],
    ]);
    expect(await balanceOf(jeremy, checking.id)).toBe(-10000);
    expect(await register(jeremy, checking.id)).toHaveLength(1);

    // Children can't be edited or deleted on their own.
    const childId = txn.splits[0]!.id;
    expect((await jeremy.patch(`/api/transactions/${childId}`, { amount: 1 })).status).toBe(400);
    expect((await jeremy.delete(`/api/transactions/${childId}`)).status).toBe(400);
    // GET on a child returns the whole parent.
    expect(((await jeremy.get(`/api/transactions/${childId}`)).json as Transaction).id).toBe(txn.id);
  });

  test("editing replaces splits, and an empty list removes them", async () => {
    const { jeremy } = await setUp();
    const checking = await newAccount(jeremy, { name: "Checking", type: "checking" });
    const groceries = await categoryId(jeremy, "Groceries");
    const txn = await addTxn(jeremy, {
      accountId: checking.id,
      amount: -300,
      splits: [{ amount: -100 }, { amount: -200 }],
    });

    expect((await jeremy.patch(`/api/transactions/${txn.id}`, { amount: -500 })).status).toBe(400);

    const resplit = (await jeremy.patch(`/api/transactions/${txn.id}`, {
      amount: -500,
      splits: [{ amount: -250 }, { amount: -125 }, { amount: -125, categoryId: groceries }],
    })).json as Transaction;
    expect(resplit.splits.map((s) => s.amount)).toEqual([-250, -125, -125]);

    // Changing the date carries over to the children.
    await jeremy.patch(`/api/transactions/${txn.id}`, { date: "2026-04-01" });
    const unsplit = (await jeremy.patch(`/api/transactions/${txn.id}`, { splits: [], categoryId: groceries }))
      .json as Transaction;
    expect(unsplit).toMatchObject({ splits: [], categoryId: groceries, amount: -500, date: "2026-04-01" });
  });
});
