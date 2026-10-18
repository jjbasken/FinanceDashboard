import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Account, CategoryGroup, GnucashUpload, HoldingsSummary } from "@fd/shared";
import { readGnucashXml } from "../src/importers/gnucash/xml";
import type { GncBook } from "../src/importers/gnucash/read";
import { Client, owner, testApp } from "./helpers";

const SH = 1_000_000;
const $ = (dollars: number) => Math.round(dollars * 1_000_000);

async function download(c: Client) {
  const res = await (c as any).app.request("/api/backup/gnucash", { headers: { cookie: c.cookie ?? "" } });
  return res as Response;
}

async function exportBook(c: Client) {
  const res = await download(c);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="finance-\d{4}-\d{2}-\d{2}\.gnucash"/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, book: readGnucashXml(bytes) };
}

/** Each account's balance in the book, by path: currency for most, micro-shares for holdings. */
function balances(book: GncBook) {
  const holding = new Set(book.accounts.filter((a) => a.type === "STOCK" || a.type === "MUTUAL").map((a) => a.guid));
  const totals = new Map<string, number>();
  for (const t of book.transactions) {
    for (const s of t.splits) {
      const path = book.accounts.find((a) => a.guid === s.accountGuid)!.path;
      totals.set(path, (totals.get(path) ?? 0) + (holding.has(s.accountGuid) ? s.shares : s.quantity));
    }
  }
  return totals;
}

async function newHousehold() {
  const { app } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  return { app, c };
}

/** Import a GnuCash file with the suggested mappings. */
async function importInto(c: Client, bytes: Uint8Array) {
  const up = (await c.upload("/api/import/gnucash?name=book.gnucash", bytes)).json as GnucashUpload;
  expect((await c.post(`/api/import/gnucash/${up.uploadId}/commit`, { mappings: {} })).status).toBe(201);
}

async function summary(c: Client) {
  const accounts = ((await c.get("/api/accounts")).json as Account[]).map((a) => [a.name, a.type, a.balance]);
  const holdings = ((await c.get("/api/investments/holdings")).json as HoldingsSummary).accounts.flatMap((a) =>
    a.holdings.map((h) => [a.accountName, h.symbol, h.shares]),
  );
  return { accounts: accounts.sort((x, y) => String(x[0]).localeCompare(String(y[0]))), holdings };
}

async function household() {
  const { app, c } = await newHousehold();
  const groups = (await c.get("/api/categories")).json as CategoryGroup[];
  const cat = (name: string) => groups.flatMap((g) => g.categories).find((x) => x.name === name)!.id;
  const account = async (body: Record<string, unknown>) => (await c.post("/api/accounts", body)).json as Account;
  const txn = async (body: Record<string, unknown>) => {
    const res = await c.post("/api/transactions", { date: "2026-03-10", ...body });
    expect(res.status).toBe(201);
  };

  const checking = await account({ name: "Checking", type: "checking", startingBalance: 500_000, startingDate: "2026-01-01" });
  const savings = await account({ name: "Rainy Day: Savings", type: "savings" });
  const card = await account({ name: "Visa", type: "credit" });
  const loan = await account({ name: "Mortgage", type: "loan", startingBalance: -20_000_000, startingDate: "2026-01-01" });
  const brokerage = await account({ name: "Brokerage", type: "investment" });

  await txn({ accountId: checking.id, amount: -8250, payeeName: "Smith & Sons <Grocer>", categoryId: cat("Groceries"), notes: "weekly shop", cleared: true });
  await txn({ accountId: card.id, amount: -1999, payeeName: "Mystery charge" });
  await txn({ accountId: checking.id, amount: -100_000, payeeId: (savings as any).transferPayeeId });
  await txn({
    accountId: checking.id,
    amount: -200_000,
    payeeName: "Bank",
    splits: [
      { amount: -150_000, categoryId: cat("Housing"), notes: "Principal", transferAccountId: loan.id },
      { amount: -50_000, categoryId: cat("Housing"), notes: "Interest" },
    ],
  });
  await txn({ accountId: checking.id, amount: -300_000, payeeId: (brokerage as any).transferPayeeId, categoryId: cat("Housing") });

  const vti = (await c.post("/api/investments/securities", { symbol: "VTI", name: "Total Market", type: "etf" })).json;
  const inv = async (body: Record<string, unknown>) => {
    const res = await c.post("/api/investments/transactions", { accountId: brokerage.id, securityId: vti.id, ...body });
    expect(res.status).toBe(201);
  };
  await inv({ date: "2026-03-11", action: "buy", shares: 10 * SH, price: $(200), fees: 500 });
  await inv({ date: "2026-04-01", action: "dividend", amount: 1234 });
  await inv({ date: "2026-04-02", action: "reinvest", shares: 0.5 * SH, price: $(210) });
  await inv({ date: "2026-05-01", action: "split", splitNew: 2, splitOld: 1 });
  await inv({ date: "2026-06-01", action: "sell", shares: 3 * SH, price: $(110) });
  await c.post(`/api/investments/securities/${vti.id}/prices`, { date: "2026-06-30", price: $(112.5) });

  return { app, c, checking, savings, brokerage };
}

describe("exporting to GnuCash", () => {
  test("writes a balanced book with the same balances, categories and holdings", async () => {
    const { c } = await household();
    const { bytes, book } = await exportBook(c);
    expect(bytes[0]).toBe(0x1f); // gzip-compressed, like GnuCash saves it

    const types = Object.fromEntries(book.accounts.map((a) => [a.path, a.type]));
    expect(types).toMatchObject({
      Assets: "ASSET",
      "Assets:Checking": "BANK",
      "Assets:Rainy Day- Savings": "BANK",
      "Assets:Brokerage": "ASSET",
      "Assets:Brokerage:VTI": "STOCK",
      Liabilities: "LIABILITY",
      "Liabilities:Visa": "CREDIT",
      "Liabilities:Mortgage": "LIABILITY",
      "Expenses:Everyday:Groceries": "EXPENSE",
      "Income:Income": "INCOME",
      "Equity:Opening Balances": "EQUITY",
      "Income:Dividends": "INCOME",
      "Imbalance-USD": "BANK",
    });
    expect(book.accounts.find((a) => a.path === "Expenses")).toMatchObject({ placeholder: true });
    expect(book.accounts.find((a) => a.path === "Assets:Brokerage:VTI")).toMatchObject({ commodity: "VTI", commodityName: "Total Market" });

    for (const t of book.transactions) expect(t.splits.reduce((sum, s) => sum + s.value, 0)).toBe(0);

    const app = Object.fromEntries((await summary(c)).accounts.map(([name, , balance]) => [name, balance]));
    const totals = balances(book);
    expect(totals.get("Assets:Checking")).toBe(app.Checking);
    expect(totals.get("Assets:Rainy Day- Savings")).toBe(app["Rainy Day: Savings"]);
    expect(totals.get("Liabilities:Visa")).toBe(app.Visa);
    expect(totals.get("Liabilities:Mortgage")).toBe(app.Mortgage);
    expect(totals.get("Assets:Brokerage")).toBe(app.Brokerage);
    expect(totals.get("Assets:Brokerage:VTI")).toBe(18 * SH); // (10 + 0.5) × 2 − 3
    expect(totals.get("Imbalance-USD")).toBe(1999); // the uncategorized charge

    const grocer = book.transactions.find((t) => t.description === "Smith & Sons <Grocer>")!;
    expect(grocer.date).toBe("2026-03-10");
    expect(grocer.splits.find((s) => s.memo === "weekly shop")).toMatchObject({ reconcile: "c", value: -8250 });
    const path = (guid: string) => book.accounts.find((a) => a.guid === guid)!.path;
    const mortgage = book.transactions.find((t) => t.description === "Bank")!;
    expect(mortgage.splits.map((s) => [path(s.accountGuid), s.value, s.memo])).toEqual([
      ["Assets:Checking", -200_000, ""],
      ["Liabilities:Mortgage", 150_000, "Principal"],
      [expect.stringMatching(/^Expenses:.*Housing$/), 50_000, "Interest"],
    ]);
    expect(book.prices).toEqual([{ commodity: "VTI", currency: "USD", date: "2026-06-30", value: $(112.5) }]);
  });

  test("keeps categories and groups distinct when exported names collide", async () => {
    const { c } = await newHousehold();
    const account = (await c.post("/api/accounts", { name: "Checking", type: "checking" })).json;
    const groupIds = [];
    for (const name of ["Food:Home", "Food-Home", "Expenses"]) {
      groupIds.push((await c.post("/api/categories/groups", { name })).json.id);
    }
    const ids = [];
    for (const [groupId, name] of [[groupIds[0], "Meals:Out"], [groupIds[0], "Meals-Out"],
      [groupIds[1], "Meals-Out"], [groupIds[2], "Food-Home"]] as const) {
      const category = await c.post("/api/categories", { groupId, name });
      expect(category.status).toBe(201);
      ids.push(category.json.id);
    }
    for (const [i, categoryId] of ids.entries()) {
      expect((await c.post("/api/transactions", {
        accountId: account.id, date: "2026-01-01", amount: -(i + 1) * 100,
        payeeName: `Purchase ${i}`, categoryId,
      })).status).toBe(201);
    }
    const { book } = await exportBook(c);
    const destination = book.transactions.map((t) => t.splits.find((s) => s.value > 0)!.accountGuid);
    expect(new Set(destination).size).toBe(ids.length);
    expect(new Set(book.accounts.map((a) => a.path)).size).toBe(book.accounts.length);
    for (const id of destination) expect(book.accounts.find((a) => a.guid === id)!.placeholder).toBe(false);
  });

  test("exports XML-safe text while preserving Unicode and ordinary whitespace", async () => {
    const { c } = await newHousehold();
    const account = (await c.post("/api/accounts", { name: "Cash", type: "cash" })).json;
    expect((await c.post("/api/transactions", {
      accountId: account.id, date: "2026-01-01", amount: -100,
      payeeName: "Café 😀 & shop", notes: "first\u0001second\tthird\nfourth",
    })).status).toBe(201);
    const { bytes, book } = await exportBook(c);
    const xml = gunzipSync(bytes).toString("utf8");
    expect(xml).not.toContain("\u0001");
    expect(book.transactions[0]!.description).toBe("Café 😀 & shop");
    expect(book.transactions[0]!.splits[0]!.memo).toBe("first�second\tthird\nfourth");
  });

  test("keeps investment dividends separate from an existing Dividends category", async () => {
    const { c, brokerage } = await household();
    const groups = (await c.get("/api/categories")).json as CategoryGroup[];
    const income = groups.find((g) => g.isIncome)!;
    const category = (await c.post("/api/categories", { groupId: income.id, name: "Dividends" })).json;
    expect((await c.post("/api/transactions", {
      accountId: brokerage.id, date: "2026-07-01", amount: 100,
      categoryId: category.id, payeeName: "Other income",
    })).status).toBe(201);
    const { book } = await exportBook(c);
    const categoryIncome = book.transactions.find((t) => t.description === "Other income")!;
    const investmentIncome = book.transactions.find((t) => t.date === "2026-04-01")!;
    expect(categoryIncome.splits.find((s) => s.value < 0)!.accountGuid)
      .not.toBe(investmentIncome.splits.find((s) => s.value < 0)!.accountGuid);
  });

  test("imports back with the same accounts, balances and holdings", async () => {
    const { c } = await household();
    const { bytes } = await exportBook(c);
    const fresh = await newHousehold();
    await importInto(fresh.c, bytes);
    // GnuCash uses ":" between account names, so the export swaps it for "-".
    const before = await summary(c);
    before.accounts = before.accounts.map(([name, ...rest]) => [String(name).replaceAll(":", "-"), ...rest]);
    expect(await summary(fresh.c)).toEqual(before);
  });

  test("round-trips a real GnuCash book", async () => {
    const dir = join(import.meta.dir, "fixtures/gnucash-real");
    const original = new Uint8Array(await Bun.file(join(dir, "sample-5.10.gnucash-xml")).arrayBuffer());
    const first = await newHousehold();
    await importInto(first.c, original);
    const { bytes } = await exportBook(first.c);
    const second = await newHousehold();
    await importInto(second.c, bytes);
    expect(await summary(second.c)).toEqual(await summary(first.c));
  });

  test("leaves out other members' private accounts and is for the owner only", async () => {
    const { app, c, checking } = await household();
    const invite = await c.post("/api/household/invites");
    const sam = new Client(app);
    await sam.post("/api/auth/accept-invite", {
      token: invite.json.token,
      displayName: "Sam",
      username: "sam",
      password: "another good password",
    });
    const secret = (await sam.post("/api/accounts", { name: "Sam's Secret Visa", type: "credit", private: true })).json as Account;
    expect(
      (await sam.post("/api/transactions", { accountId: checking.id, date: "2026-07-01", amount: -4200, payeeId: (secret as any).transferPayeeId })).status,
    ).toBe(201);

    const { book } = await exportBook(c);
    expect(book.accounts.some((a) => a.name.includes("Sam"))).toBe(false);
    const paid = book.transactions.find((t) => t.date === "2026-07-01")!;
    expect(paid.splits.find((s) => s.value === 4200)!.memo).toBe("Transfer to a private account");
    expect(balances(book).get("Assets:Checking")).toBe(
      ((await c.get("/api/accounts")).json as Account[]).find((a) => a.id === checking.id)!.balance,
    );

    expect((await download(sam)).status).toBe(403);
    expect((await download(new Client(app))).status).toBe(401);
  });
});
