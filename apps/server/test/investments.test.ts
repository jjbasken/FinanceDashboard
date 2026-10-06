import { describe, expect, test } from "bun:test";
import type { Account, HoldingsSummary, InvestmentTxn, Security, Transaction, ValuePoint } from "@fd/shared";
import { createSession } from "../src/auth/sessions";
import { users } from "../src/db/schema";
import { SESSION_COOKIE } from "../src/middleware";
import { createHousehold } from "../src/services/household";
import { Client, fakePrices, owner, testApp } from "./helpers";

const SH = 1_000_000; // micro-shares per share
const $ = (dollars: number) => Math.round(dollars * 1_000_000); // price in micros

async function setUp(quotes: Parameters<typeof fakePrices>[0] = {}) {
  const prices = fakePrices(quotes, {
    VTI: { symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", currency: "USD", price: $(380.27) },
  });
  const { app, db } = testApp({ priceProvider: prices.provider });
  const c = new Client(app);
  expect((await c.post("/api/auth/setup", owner)).status).toBe(201);
  const brokerage = (
    await c.post("/api/accounts", {
      name: "Brokerage",
      type: "investment",
      startingBalance: 1_000_000,
      startingDate: "2026-01-01",
    })
  ).json as Account;
  const vti = (await c.post("/api/investments/securities", { symbol: "vti", name: "Total Market", type: "etf" }))
    .json as Security;
  const txn = async (body: Record<string, unknown>, status = 201) => {
    const res = await c.post("/api/investments/transactions", { accountId: brokerage.id, securityId: vti.id, ...body });
    expect(res.status).toBe(status);
    return res.json;
  };
  const holdings = async () => (await c.get("/api/investments/holdings")).json as HoldingsSummary;
  const position = async () => (await holdings()).accounts.find((a) => a.accountId === brokerage.id)!.holdings[0];
  const register = async () => (await c.get(`/api/accounts/${brokerage.id}/transactions`)).json as Transaction[];
  const account = async () => ((await c.get("/api/accounts")).json as Account[]).find((a) => a.id === brokerage.id)!;
  return { app, db, c, prices, brokerage, vti, txn, holdings, position, register, account };
}

describe("securities", () => {
  test("create, look up, rename and delete", async () => {
    const { c, vti, txn } = await setUp();
    expect(vti).toMatchObject({ symbol: "VTI", type: "etf", autoPrice: true });
    expect((await c.post("/api/investments/securities", { symbol: "VTI", name: "Again", type: "etf" })).status).toBe(
      409,
    );
    expect(
      (await c.post("/api/investments/securities", { symbol: "bad symbol!", name: "x", type: "etf" })).status,
    ).toBe(400);

    const lookup = await c.get("/api/investments/securities/lookup?symbol=vti");
    expect(lookup.json).toMatchObject({ symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf" });
    expect((await c.get("/api/investments/securities/lookup?symbol=NOPE")).status).toBe(404);

    await c.patch(`/api/investments/securities/${vti.id}`, { name: "Vanguard Total" });
    expect(((await c.get("/api/investments/securities")).json as Security[])[0]!.name).toBe("Vanguard Total");

    await txn({ date: "2026-01-02", action: "buy", shares: 1 * SH, price: $(100) });
    expect((await c.delete(`/api/investments/securities/${vti.id}`)).status).toBe(409);
  });
});

describe("investment transactions", () => {
  test("a buy moves cash out through a linked register row and adds shares at cost", async () => {
    const { c, txn, position, register, account } = await setUp();
    await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(200), fees: 495 });

    expect(await position()).toMatchObject({
      symbol: "VTI",
      shares: 10 * SH,
      cost: 200_495,
      price: $(200),
      value: 200_000,
    });
    const [cash] = await register();
    expect(cash).toMatchObject({ amount: -200_495, notes: "10 @ $200.00 + $4.95 fees" });
    expect(cash!.investmentTxnId).not.toBeNull();
    const payees = (await c.get("/api/payees")).json as { id: number; name: string }[];
    expect(payees.find((p) => p.id === cash!.payeeId)!.name).toBe("Buy VTI");

    // Cash and holdings both count toward the account.
    expect(await account()).toMatchObject({ balance: 1_000_000 - 200_495, holdingsValue: 200_000 });

    // The register row can be cleared, but not edited or deleted directly.
    expect((await c.patch(`/api/transactions/${cash!.id}`, { amount: -1 })).status).toBe(400);
    expect((await c.delete(`/api/transactions/${cash!.id}`)).status).toBe(400);
    expect((await c.patch(`/api/transactions/${cash!.id}`, { cleared: true })).json.cleared).toBe(true);
  });

  test("sells use average cost, and you can't sell what you don't have", async () => {
    const { txn, position, register } = await setUp();
    await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(100) });
    await txn({ date: "2026-02-05", action: "buy", shares: 10 * SH, price: $(200) });
    await txn({ date: "2026-01-04", action: "sell", shares: 1 * SH, price: $(100) }, 400); // before the first buy
    await txn({ date: "2026-03-01", action: "sell", shares: 21 * SH, price: $(250) }, 400);

    await txn({ date: "2026-03-01", action: "sell", shares: 5 * SH, price: $(250), fees: 100 });
    // Average cost was $150/share: 15 shares left cost $2,250.
    expect(await position()).toMatchObject({ shares: 15 * SH, cost: 225_000 });
    expect((await register())[0]).toMatchObject({ amount: 125_000 - 100 });
  });

  test("dividends, reinvestment, splits and share transfers", async () => {
    const { txn, position, register } = await setUp();
    await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(100) });
    await txn({ date: "2026-02-01", action: "dividend", amount: 1234 });
    expect((await register())[0]).toMatchObject({ amount: 1234 });

    const before = (await register()).length;
    await txn({ date: "2026-03-01", action: "reinvest", shares: 0.5 * SH, price: $(110) });
    expect((await register()).length).toBe(before); // no cash moves
    expect(await position()).toMatchObject({ shares: 10.5 * SH, cost: 105_500 });

    await txn({ date: "2026-04-01", action: "split", splitNew: 2, splitOld: 1 });
    expect(await position()).toMatchObject({ shares: 21 * SH, cost: 105_500 });
    await txn({ date: "2026-04-02", action: "split", splitNew: 1, splitOld: 1 }, 400);

    await txn({ date: "2026-05-01", action: "transfer_in", shares: 4 * SH, amount: 20_000 });
    await txn({ date: "2026-05-02", action: "transfer_out", shares: 5 * SH });
    expect((await position())!.shares).toBe(20 * SH);
  });

  test("splits are recomputed from their ratio when earlier transactions change", async () => {
    const { c, txn, position } = await setUp();
    const buy = await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(100) });
    await txn({ date: "2026-02-01", action: "split", splitNew: 2, splitOld: 1 });
    expect((await position())!.shares).toBe(20 * SH);

    const list = (await c.get("/api/investments/transactions")).json as InvestmentTxn[];
    expect(list.find((t) => t.action === "split")).toMatchObject({ splitNew: 2, splitOld: 1, shares: 10 * SH });
    const original = list.find((t) => t.id === buy.id)!;
    await c.request("PUT", `/api/investments/transactions/${buy.id}`, {
      accountId: original.accountId,
      securityId: original.securityId,
      date: original.date,
      action: "buy",
      shares: 15 * SH,
      price: $(100),
    });
    expect((await position())!.shares).toBe(30 * SH);

    // A later buy before the split's date counts too; one after it doesn't.
    await txn({ date: "2026-01-20", action: "buy", shares: 5 * SH, price: $(100) });
    await txn({ date: "2026-03-01", action: "buy", shares: 1 * SH, price: $(100) });
    expect((await position())!.shares).toBe(41 * SH);
  });

  test("editing and deleting keep the cash row and share counts consistent", async () => {
    const { c, txn, position, register } = await setUp();
    const buy = await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(100) });
    await txn({ date: "2026-02-01", action: "sell", shares: 8 * SH, price: $(120) });

    // Shrinking the buy below what was later sold is rejected and nothing changes.
    const list = (await c.get("/api/investments/transactions")).json as InvestmentTxn[];
    const original = list.find((t) => t.id === buy.id)!;
    const tooSmall = await c.request("PUT", `/api/investments/transactions/${buy.id}`, {
      accountId: original.accountId,
      securityId: original.securityId,
      date: original.date,
      action: "buy",
      shares: 5 * SH,
      price: $(100),
    });
    expect(tooSmall.status).toBe(400);
    expect((await position())!.shares).toBe(2 * SH);

    const ok = await c.request("PUT", `/api/investments/transactions/${buy.id}`, {
      accountId: original.accountId,
      securityId: original.securityId,
      date: original.date,
      action: "buy",
      shares: 12 * SH,
      price: $(100),
    });
    expect(ok.status).toBe(200);
    const cashRow = (await register()).find((t) => t.date === "2026-01-05" && t.investmentTxnId === buy.id)!;
    expect(cashRow.amount).toBe(-120_000);

    // Deleting the sell removes its cash row; deleting the buy would go short, so it's refused.
    const sell = list.find((t) => t.action === "sell")!;
    expect((await c.delete(`/api/investments/transactions/${buy.id}`)).status).toBe(400);
    expect((await c.delete(`/api/investments/transactions/${sell.id}`)).status).toBe(200);
    expect((await register()).some((t) => t.investmentTxnId === sell.id)).toBe(false);
    expect((await c.delete(`/api/investments/transactions/${buy.id}`)).status).toBe(200);
    expect(await position()).toBeUndefined();
  });

  test("an account with holdings can't be closed", async () => {
    const { c, brokerage, txn } = await setUp();
    await txn({ date: "2026-01-05", action: "buy", shares: 1 * SH, price: $(100) });
    await c.post("/api/transactions", { accountId: brokerage.id, date: "2026-01-06", amount: -(1_000_000 - 10_000) });
    const res = await c.patch(`/api/accounts/${brokerage.id}`, { closed: true });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("investments");
  });
});

describe("prices", () => {
  const quotes = {
    VTI: [
      { date: "2026-01-05", close: $(201) },
      { date: "2026-01-06", close: $(202) },
      { date: "2026-02-02", close: $(210) },
    ],
  };

  test("refresh fetches from the first transaction, then only what's missing", async () => {
    const { c, txn, position, prices } = await setUp(quotes);
    await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(200) });

    const first = (await c.post("/api/investments/prices/refresh")).json;
    expect(first).toEqual({ updated: 3, errors: [] });
    expect(prices.calls[0]).toMatchObject({ symbol: "VTI", from: "2026-01-05" });
    expect(await position()).toMatchObject({ price: $(210), priceDate: "2026-02-02", value: 210_000, gain: 10_000 });

    await c.post("/api/investments/prices/refresh");
    expect(prices.calls[1]).toMatchObject({ symbol: "VTI", from: "2026-02-03" });
  });

  test("securities you've sold out of stop getting price updates", async () => {
    const { c, txn, prices } = await setUp(quotes);
    await txn({ date: "2026-01-05", action: "buy", shares: 1 * SH, price: $(200) });
    await txn({ date: "2026-01-06", action: "sell", shares: 1 * SH, price: $(201) });
    await c.post("/api/investments/securities", { symbol: "WATCH", name: "Never traded", type: "stock" });
    await c.post("/api/investments/prices/refresh");
    expect(prices.calls.map((x) => x.symbol)).toEqual(["WATCH"]);
  });

  test("cash notes use the household's currency", async () => {
    const { c, txn, register } = await setUp();
    await c.patch("/api/household", { currency: "EUR" });
    await txn({ date: "2026-01-05", action: "buy", shares: 2 * SH, price: $(12.5), fees: 100 });
    expect((await register())[0]!.notes).toBe("2 @ €12.50 + €1.00 fees");
  });

  test("manual prices win and failures are reported per symbol", async () => {
    const { c, vti, txn, position } = await setUp(quotes);
    await txn({ date: "2026-01-05", action: "buy", shares: 1 * SH, price: $(200) });
    await c.post(`/api/investments/securities/${vti.id}/prices`, { date: "2026-02-02", price: $(999) });
    await c.post("/api/investments/securities", { symbol: "ZZZZ", name: "Unknown", type: "stock" });

    const res = (await c.post("/api/investments/prices/refresh")).json;
    expect(res.errors).toEqual([{ symbol: "ZZZZ", message: "Unknown symbol ZZZZ" }]);
    // VTI already had a price on its latest date, so nothing new was needed.
    expect((await position())!.price).toBe($(999));
  });

  test("value history combines cash and holdings at each date's price", async () => {
    const { c, txn } = await setUp(quotes);
    await txn({ date: "2026-01-05", action: "buy", shares: 10 * SH, price: $(200) });
    await c.post("/api/investments/prices/refresh");
    const points = (await c.get("/api/investments/history?range=all")).json as ValuePoint[];
    const at = (date: string) => points.find((p) => p.date === date);
    // Month end of January: cash 10,000 - 2,000 + 10 × $202.
    expect(at("2026-01-31")).toMatchObject({ value: 800_000 + 202_000, invested: 1_000_000 });
    expect(at("2026-02-28")).toMatchObject({ value: 800_000 + 210_000 });
    expect((await c.get("/api/investments/history?range=forever")).status).toBe(400);
  });
});

test("another household can't see or touch our investments", async () => {
  const { app, db, brokerage, vti, txn } = await setUp();
  const buy = await txn({ date: "2026-01-05", action: "buy", shares: 1 * SH, price: $(100) });
  const other = createHousehold(db, "Neighbours");
  const user = db
    .insert(users)
    .values({ householdId: other.id, username: "n", displayName: "N", passwordHash: "x", role: "owner" })
    .returning()
    .get();
  const intruder = new Client(app);
  intruder.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;

  expect((await intruder.get("/api/investments/securities")).json).toEqual([]);
  expect((await intruder.get("/api/investments/transactions")).json).toEqual([]);
  expect((await intruder.get("/api/investments/holdings")).json.accounts).toEqual([]);
  const body = {
    accountId: brokerage.id,
    securityId: vti.id,
    date: "2026-01-06",
    action: "buy",
    shares: SH,
    price: $(1),
  };
  expect((await intruder.post("/api/investments/transactions", body)).status).toBe(404);
  expect((await intruder.request("PUT", `/api/investments/transactions/${buy.id}`, body)).status).toBe(404);
  expect((await intruder.delete(`/api/investments/transactions/${buy.id}`)).status).toBe(404);
  expect(
    (await intruder.post(`/api/investments/securities/${vti.id}/prices`, { date: "2026-01-01", price: 1 })).status,
  ).toBe(404);
  expect((await intruder.patch(`/api/investments/securities/${vti.id}`, { name: "x" })).status).toBe(404);
});
