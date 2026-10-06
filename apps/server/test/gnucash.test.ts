import { describe, expect, test } from "bun:test";
import type {
  Account,
  HoldingsSummary,
  InvestmentTxn,
  BudgetMonth,
  CategoryGroup,
  GnucashMapping,
  GnucashPreview,
  GnucashUpload,
  ImportBatch,
  Payee,
  Transaction,
} from "@fd/shared";
import { gnucashDate } from "../src/importers/gnucash/read";
import { createSession } from "../src/auth/sessions";
import { users } from "../src/db/schema";
import { SESSION_COOKIE } from "../src/middleware";
import { createHousehold } from "../src/services/household";
import { sampleBook } from "./fixtures/gnucash";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  expect((await jeremy.post("/api/auth/setup", owner)).status).toBe(201);
  const sample = sampleBook();
  return { app, db, jeremy, sample };
}

async function upload(c: Client, bytes: Uint8Array, name = "family.gnucash") {
  const res = await c.upload(`/api/import/gnucash?name=${encodeURIComponent(name)}`, bytes);
  expect(res.status).toBe(201);
  return res.json as GnucashUpload;
}

async function preview(c: Client, up: GnucashUpload, mappings: Record<string, GnucashMapping> = {}) {
  const res = await c.post(`/api/import/gnucash/${up.uploadId}/preview`, { mappings });
  expect(res.status).toBe(200);
  return res.json as GnucashPreview;
}

async function commit(c: Client, up: GnucashUpload, mappings: Record<string, GnucashMapping> = {}) {
  const res = await c.post(`/api/import/gnucash/${up.uploadId}/commit`, { mappings });
  expect(res.status).toBe(201);
  return res.json as { batchId: number; preview: GnucashPreview };
}

const accountsOf = async (c: Client) => (await c.get("/api/accounts")).json as Account[];
const byName = (list: Account[], name: string) => list.find((a) => a.name === name)!;
const registerOf = async (c: Client, id: number) =>
  (await c.get(`/api/accounts/${id}/transactions`)).json as Transaction[];

test("gnucashDate handles new and old timestamp styles", () => {
  expect(gnucashDate("2026-01-15 10:59:00")).toBe("2026-01-15");
  expect(gnucashDate("20260115105900")).toBe("2026-01-15");
  // Local midnight stored as UTC, west and east of Greenwich.
  expect(gnucashDate("2026-03-10 05:00:00")).toBe("2026-03-10");
  expect(gnucashDate("2026-03-09 14:00:00")).toBe("2026-03-10");
});

describe("uploading", () => {
  test("rejects files that aren't GnuCash books, with a helpful message", async () => {
    const { jeremy } = await setUp();
    // XML books are read (see gnucash-xml.test.ts); an empty or broken one is explained.
    const empty = await jeremy.upload("/api/import/gnucash", new TextEncoder().encode('<?xml version="1.0"?><gnc-v2/>'));
    expect(empty.status).toBe(400);
    expect(empty.json.error).toContain("no root account");
    const gz = await jeremy.upload("/api/import/gnucash", new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]));
    expect(gz.json.error).toContain("decompress");
    const junk = await jeremy.upload("/api/import/gnucash", new TextEncoder().encode("hello"));
    expect(junk.status).toBe(400);
    expect(junk.json.error).toContain("Export Transactions to CSV");
    const { Database } = await import("bun:sqlite");
    const other = new Database(":memory:");
    other.exec("create table notes (x text)");
    const notBook = await jeremy.upload("/api/import/gnucash", other.serialize());
    expect(notBook.status).toBe(400);
    expect(notBook.json.error).toContain("isn't a GnuCash book");
    expect((await jeremy.upload("/api/import/gnucash", new Uint8Array())).status).toBe(400);
  });

  test("requires a session, and uploads belong to one household", async () => {
    const { app, db, jeremy, sample } = await setUp();
    expect((await new Client(app).upload("/api/import/gnucash", sample.builder.bytes())).status).toBe(401);

    const up = await upload(jeremy, sample.builder.bytes());
    const other = createHousehold(db, "Neighbours");
    const user = db
      .insert(users)
      .values({ householdId: other.id, username: "n", displayName: "N", passwordHash: "x", role: "owner" })
      .returning()
      .get();
    const intruder = new Client(app);
    intruder.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;
    expect((await intruder.post(`/api/import/gnucash/${up.uploadId}/preview`, { mappings: {} })).status).toBe(404);
    expect((await intruder.post(`/api/import/gnucash/${up.uploadId}/commit`, { mappings: {} })).status).toBe(404);
  });

  test("describes the book and suggests a mapping for each account", async () => {
    const { jeremy, sample } = await setUp();
    const up = await upload(jeremy, sample.builder.bytes());
    expect(up).toMatchObject({
      fileName: "family.gnucash",
      currency: "USD",
      transactionCount: 15, // the scheduled-transaction template is left out
      firstDate: "2026-01-01",
      lastDate: "2026-03-20",
    });
    const s = (guid: string) => up.accounts.find((a) => a.guid === guid)!;
    const { accounts: a } = sample;
    expect(s(a.checking)).toMatchObject({
      path: "Assets:Current Assets:Checking",
      type: "BANK",
      splitCount: 8,
      balance: 586750,
    });
    expect(s(a.checking).suggested).toMatchObject({
      kind: "account",
      accountId: null,
      type: "checking",
      onBudget: true,
    });
    expect(s(a.savings).suggested).toMatchObject({ type: "savings", onBudget: true });
    expect(s(a.visa).suggested).toMatchObject({ type: "credit", onBudget: true });
    expect(s(a.brokerage).suggested).toMatchObject({ type: "investment", onBudget: false });
    expect(s(a.k401).suggested).toMatchObject({ type: "asset", onBudget: false });
    expect(s(a.aapl).suggested).toEqual({
      kind: "holding",
      securityId: null,
      symbol: "AAPL",
      name: "AAPL",
      type: "stock",
    });
    expect(s(a.imbalance).suggested).toEqual({ kind: "skip" });
    expect(s(a.opening).suggested).toEqual({ kind: "opening" });
    expect(s(a.fuel).suggested).toMatchObject({ kind: "category", categoryId: null, groupName: "Auto", name: "Fuel" });
    expect(s(a.federal).suggested).toMatchObject({ kind: "category", groupName: "Taxes", name: "Federal" });
    expect(s(a.salary).suggested).toMatchObject({
      kind: "category",
      groupName: "Income",
      name: "Salary",
      isIncome: true,
    });
    // Groceries and Household match the household's default categories by name.
    expect(s(a.groceries).suggested).toMatchObject({ kind: "category", name: "Groceries" });
    expect((s(a.groceries).suggested as { categoryId: number | null }).categoryId).not.toBeNull();
  });
});

describe("importing the sample book", () => {
  test("preview counts what will happen and checks balances", async () => {
    const { jeremy, sample } = await setUp();
    const up = await upload(jeremy, sample.builder.bytes());
    const p = await preview(jeremy, up);
    expect(p).toMatchObject({
      transactions: 13,
      alreadyImported: 0,
      noAccount: 1,
      voided: 1,
      // The buy and sell become investment transactions (with their own cash rows), as does the split.
      rows: { transactions: 9, transfers: 3, splits: 4 },
      investments: 3,
      prices: 2,
      newSecurities: ["AAPL"],
    });
    expect(p.newAccounts.sort()).toEqual(["401k", "Brokerage", "Checking", "Savings Account", "Visa"]);
    expect(p.newCategories.sort()).toEqual(["Auto: Fuel", "Income: Dividends", "Income: Salary", "Taxes: Federal"]);
    expect(p.warnings.join("\n")).toContain("Imbalance-USD is skipped");
    for (const b of p.balances) expect(b.afterImport).toBe(b.gnucash);
    // Nothing is written by a preview.
    expect(await accountsOf(jeremy)).toEqual([]);
  });

  test("commit writes accounts, transactions, transfers and splits that match GnuCash", async () => {
    const { jeremy, sample } = await setUp();
    const up = await upload(jeremy, sample.builder.bytes());
    const { batchId } = await commit(jeremy, up);
    expect(batchId).toBeGreaterThan(0);

    const accts = await accountsOf(jeremy);
    expect(Object.fromEntries(accts.map((a) => [a.name, [a.balance, a.onBudget, a.type]]))).toEqual({
      Checking: [586750, true, "checking"],
      "Savings Account": [1100000, true, "savings"],
      Brokerage: [-33766, false, "investment"],
      "401k": [30000, false, "asset"],
      Visa: [-4567, true, "credit"],
    });

    const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
    const cat = (name: string) => groups.flatMap((g) => g.categories).find((c) => c.name === name)!.id;
    const payees = (await jeremy.get("/api/payees")).json as Payee[];
    const payee = (id: number | null) => payees.find((p) => p.id === id)?.name;

    const checking = await registerOf(jeremy, byName(accts, "Checking").id);
    const grocer = checking.find((t) => t.date === "2026-01-05")!;
    expect(grocer).toMatchObject({ amount: -8250, cleared: true, reconciled: true, categoryId: cat("Groceries") });
    expect(payee(grocer.payeeId)).toBe("Corner Grocer");
    expect(grocer.notes).toBe("#1001 · debit card · weekly shop");

    const opening = checking.find((t) => t.date === "2026-01-01")!;
    expect(opening).toMatchObject({ amount: 500000, categoryId: cat("Starting Balances") });
    expect(payee(opening.payeeId)).toBe("Starting Balance");

    // The paycheck: income and tax split on checking, plus a transfer out to the 401k.
    const pay = checking.filter((t) => t.date === "2026-01-15");
    const split = pay.find((t) => t.splits.length)!;
    expect(split.amount).toBe(240000);
    expect(split.splits.map((s) => [s.amount, s.categoryId])).toEqual([
      [300000, cat("Salary")],
      [-60000, cat("Federal")],
    ]);
    const to401k = pay.find((t) => t.transferId)!;
    expect(to401k.amount).toBe(-30000);
    expect((await registerOf(jeremy, byName(accts, "401k").id))[0]).toMatchObject({
      amount: 30000,
      transferId: to401k.id,
    });

    // A plain transfer is linked both ways.
    const toSavings = checking.find((t) => t.date === "2026-01-10")!;
    const savings = await registerOf(jeremy, byName(accts, "Savings Account").id);
    expect(savings.find((t) => t.id === toSavings.transferId)).toMatchObject({
      amount: 100000,
      transferId: toSavings.id,
    });

    // The Visa split, and the dates from older-style timestamps.
    const visa = await registerOf(jeremy, byName(accts, "Visa").id);
    expect(visa.find((t) => t.splits.length)!.splits.map((s) => [s.amount, s.notes])).toEqual([
      [-8000, "food"],
      [-4000, "cleaning"],
    ]);
    expect(checking.map((t) => t.date)).toContain("2026-03-10");
    const mystery = checking.find((t) => t.date === "2026-03-06")!;
    expect(mystery).toMatchObject({ amount: -1000, categoryId: null });
    expect(mystery.notes).toContain("GnuCash: Imbalance-USD");

    // Budget: January income is the salary plus both on-budget starting balances.
    const jan = (await jeremy.get("/api/budget/2026-01")).json as BudgetMonth;
    expect(jan.income).toBe(300000 + 1500000);
    expect(jan.spent).toBe(-(8250 + 8000 + 4000 + 60000 + 4567));
  });

  test("re-importing skips what's already there, remembers the mapping, and picks up new transactions", async () => {
    const { jeremy, sample } = await setUp();
    const custom: Record<string, GnucashMapping> = {
      [sample.accounts.checking]: {
        kind: "account",
        accountId: null,
        name: "Joint Checking",
        type: "checking",
        onBudget: true,
      },
    };
    await commit(jeremy, await upload(jeremy, sample.builder.bytes()), custom);
    const joint = byName(await accountsOf(jeremy), "Joint Checking");

    // Delete one imported transaction; a re-import must not bring it back.
    const [latest] = await registerOf(jeremy, joint.id);
    await jeremy.delete(`/api/transactions/${latest!.id}`);

    sample.builder.tx("2026-04-02", "Corner Grocer", [
      { account: sample.accounts.checking, value: -3000 },
      { account: sample.accounts.groceries, value: 3000 },
    ]);
    const again = await upload(jeremy, sample.builder.bytes());
    const checking = again.accounts.find((a) => a.guid === sample.accounts.checking)!;
    expect(checking.remembered).toBe(true);
    expect(checking.suggested).toMatchObject({ kind: "account", accountId: joint.id });

    const p = await preview(jeremy, again);
    expect(p).toMatchObject({
      transactions: 1,
      alreadyImported: 13,
      newAccounts: [],
      newCategories: [],
      investments: 0,
    });
    await commit(jeremy, again);
    const rows = await registerOf(jeremy, joint.id);
    expect(rows[0]).toMatchObject({ date: "2026-04-02", amount: -3000 });
    expect(rows.some((t) => t.id === latest!.id)).toBe(false);
    // GnuCash's balance, minus the deleted transaction, plus the new one.
    expect(byName(await accountsOf(jeremy), "Joint Checking").balance).toBe(586750 - latest!.amount - 3000);
  });

  test("custom mappings: into an existing account, a different category, or skipped", async () => {
    const { jeremy, sample } = await setUp();
    const existing = (await jeremy.post("/api/accounts", { name: "Our Bank", type: "checking", startingBalance: 100 }))
      .json as Account;
    const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
    const dining = groups.flatMap((g) => g.categories).find((c) => c.name === "Dining Out")!;

    const up = await upload(jeremy, sample.builder.bytes());
    const mappings: Record<string, GnucashMapping> = {
      [sample.accounts.checking]: {
        kind: "account",
        accountId: existing.id,
        name: "Our Bank",
        type: "checking",
        onBudget: true,
      },
      [sample.accounts.groceries]: {
        kind: "category",
        categoryId: dining.id,
        groupName: "Everyday",
        name: "Dining Out",
        isIncome: false,
      },
      [sample.accounts.k401]: { kind: "skip" },
    };
    const p = await preview(jeremy, up, mappings);
    expect(p.newAccounts).not.toContain("Checking");
    expect(p.newAccounts).not.toContain("401k");
    const ourBank = p.balances.find((b) => b.accountId === existing.id)!;
    expect(ourBank).toMatchObject({ gnucash: 586750, afterImport: 586850 });

    await commit(jeremy, up, mappings);
    const rows = await registerOf(jeremy, existing.id);
    expect(rows.find((t) => t.date === "2026-01-05")!.categoryId).toBe(dining.id);
    // With the 401k skipped, the paycheck's 401k share stays on checking as uncategorized.
    const paycheck = rows.find((t) => t.date === "2026-01-15")!;
    expect(paycheck.amount).toBe(210000);
    expect(paycheck.splits.find((s) => s.categoryId === null)).toMatchObject({ amount: -30000 });
  });

  test("bad mappings are rejected", async () => {
    const { jeremy, sample } = await setUp();
    const up = await upload(jeremy, sample.builder.bytes());
    const post = (mappings: unknown) => jeremy.post(`/api/import/gnucash/${up.uploadId}/preview`, { mappings });
    expect((await post({ ["0".repeat(32)]: { kind: "skip" } })).status).toBe(400);
    expect(
      (
        await post({
          [sample.accounts.checking]: { kind: "account", accountId: 999, name: "X", type: "checking", onBudget: true },
        })
      ).status,
    ).toBe(400);
    expect((await post({ [sample.accounts.checking]: { kind: "bogus" } })).status).toBe(400);
    expect((await post({ "not-a-guid": { kind: "skip" } })).status).toBe(400);
  });
});

describe("undo", () => {
  test("removes what the import created and lets it be imported again", async () => {
    const { jeremy, sample } = await setUp();
    const ownAccount = (await jeremy.post("/api/accounts", { name: "Cash", type: "cash" })).json as Account;
    const { batchId } = await commit(jeremy, await upload(jeremy, sample.builder.bytes()));

    // Something the user added to an imported account keeps that account alive.
    const visa = byName(await accountsOf(jeremy), "Visa");
    await jeremy.post("/api/transactions", { accountId: visa.id, date: "2026-05-01", amount: -500, payeeName: "Mine" });

    const batches = (await jeremy.get("/api/import/batches")).json as ImportBatch[];
    expect(batches[0]).toMatchObject({
      id: batchId,
      source: "gnucash",
      fileName: "family.gnucash",
      transactionCount: 13,
      createdBy: "Jeremy",
      undoneAt: null,
    });

    expect((await jeremy.post(`/api/import/batches/${batchId}/undo`)).status).toBe(200);
    expect((await jeremy.post(`/api/import/batches/${batchId}/undo`)).status).toBe(409);

    const left = await accountsOf(jeremy);
    expect(left.map((a) => a.name).sort()).toEqual(["Cash", "Visa"]);
    expect(byName(left, "Visa").balance).toBe(-500);
    expect(left.find((a) => a.id === ownAccount.id)).toBeDefined();
    const groups = (await jeremy.get("/api/categories")).json as CategoryGroup[];
    const names = groups.flatMap((g) => g.categories.map((c) => c.name));
    expect(names).not.toContain("Fuel");
    expect(groups.map((g) => g.name)).not.toContain("Auto");
    const payees = ((await jeremy.get("/api/payees")).json as Payee[]).map((p) => p.name);
    expect(payees).not.toContain("Corner Grocer");
    expect(payees).toContain("Mine");

    // The same book imports again from scratch.
    const p = await preview(jeremy, await upload(jeremy, sample.builder.bytes()));
    expect(p.alreadyImported).toBe(0);
    expect(p.transactions).toBe(13);
  });

  test("another household can't undo our import", async () => {
    const { app, db, jeremy, sample } = await setUp();
    const { batchId } = await commit(jeremy, await upload(jeremy, sample.builder.bytes()));
    const other = createHousehold(db, "Neighbours");
    const user = db
      .insert(users)
      .values({ householdId: other.id, username: "n", displayName: "N", passwordHash: "x", role: "owner" })
      .returning()
      .get();
    const intruder = new Client(app);
    intruder.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;
    expect((await intruder.post(`/api/import/batches/${batchId}/undo`)).status).toBe(404);
    expect((await intruder.get("/api/import/batches")).json).toEqual([]);
  });
});

describe("investments", () => {
  test("holdings become buys, sells and splits with linked cash, plus the book's prices", async () => {
    const { jeremy, sample } = await setUp();
    await commit(jeremy, await upload(jeremy, sample.builder.bytes()));
    const brokerage = byName(await accountsOf(jeremy), "Brokerage");

    const summary = (await jeremy.get("/api/investments/holdings")).json as HoldingsSummary;
    const holding = summary.accounts.find((x) => x.accountId === brokerage.id)!.holdings[0]!;
    // 5 bought, 2 sold, then split 2-for-1. Average cost: $1,000 - 2/5 of it = $600.
    expect(holding).toMatchObject({
      symbol: "AAPL",
      shares: 6_000_000,
      cost: 60_000,
      price: 165_000_000,
      priceDate: "2026-03-31",
      value: 99_000,
    });

    const txns = (await jeremy.get(`/api/investments/transactions?accountId=${brokerage.id}`)).json as InvestmentTxn[];
    expect(txns.map((t) => [t.date, t.action, t.shares, t.amount, t.price])).toEqual([
      ["2026-03-20", "split", 3_000_000, 0, 0],
      ["2026-03-01", "sell", -2_000_000, 65_000, 325_000_000],
      ["2026-02-01", "buy", 5_000_000, 100_000, 200_000_000],
    ]);
    // Cash still matches GnuCash, now through the linked rows.
    expect(brokerage.balance).toBe(-33766);
    expect(brokerage.holdingsValue).toBe(99_000);
    const register = await registerOf(jeremy, brokerage.id);
    const buyCash = register.find((t) => t.date === "2026-02-01")!;
    expect(buyCash).toMatchObject({ amount: -100_000, investmentTxnId: txns[2]!.id });

    // Undo removes the investment transactions and the new security too.
    const [batch] = (await jeremy.get("/api/import/batches")).json as ImportBatch[];
    await jeremy.post(`/api/import/batches/${batch!.id}/undo`);
    expect((await jeremy.get("/api/investments/transactions")).json).toEqual([]);
    expect((await jeremy.get("/api/investments/securities")).json).toEqual([]);
  });

  test("an earlier import that skipped holdings is flagged on re-import", async () => {
    const { jeremy, sample } = await setUp();
    await commit(jeremy, await upload(jeremy, sample.builder.bytes()), { [sample.accounts.aapl]: { kind: "skip" } });
    const again = await upload(jeremy, sample.builder.bytes());
    // Holdings were only ever skipped for lack of support, so the old "skip" isn't suggested.
    expect(again.accounts.find((a) => a.guid === sample.accounts.aapl)!.suggested.kind).toBe("holding");
    const p = await preview(jeremy, again);
    // The buy and the sell. The split touched no imported account back then, so it imports now.
    expect(p.warnings.join("\n")).toContain("2 transactions were imported before investment support");
    expect(p).toMatchObject({ transactions: 1, investments: 1 });
  });

  test("a holding maps into an existing security", async () => {
    const { jeremy, sample } = await setUp();
    const apple = (await jeremy.post("/api/investments/securities", { symbol: "AAPL", name: "Apple", type: "stock" }))
      .json as { id: number };
    const up = await upload(jeremy, sample.builder.bytes());
    expect(up.accounts.find((a) => a.guid === sample.accounts.aapl)!.suggested).toMatchObject({ securityId: apple.id });
    expect((await preview(jeremy, up)).newSecurities).toEqual([]);
  });
});
