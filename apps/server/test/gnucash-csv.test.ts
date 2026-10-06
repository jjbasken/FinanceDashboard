import { describe, expect, test } from "bun:test";
import type { Account, GnucashMapping, GnucashPreview, GnucashUpload, HoldingsSummary, Security } from "@fd/shared";
import { isGnucashCsv, readGnucashCsv } from "../src/importers/gnucash/csv";
import { Client, owner, testApp } from "./helpers";

const HEADER =
  "Date,Transaction ID,Number,Description,Notes,Commodity/Currency,Void Reason,Action,Memo,Full Account Name,Account Name,Amount With Sym,Amount Num.,Value With Sym,Value Num.,Reconcile,Reconcile Date,Rate/Price";
const id = (n: number) => n.toString(16).padStart(32, "0");

/** A made-up IRA in GnuCash's full CSV layout (no real data). */
function sampleCsv() {
  const row = (
    date: string,
    tx: number,
    desc: string,
    account: string,
    amountSym: string,
    amount: string,
    value: string,
    extra: { void?: string; reconcile?: string } = {},
  ) =>
    [
      date,
      id(tx),
      "",
      desc,
      "",
      "CURRENCY::USD",
      extra.void ?? "",
      "",
      "",
      account,
      account.split(":").at(-1),
      amountSym,
      amount,
      `$${value}`,
      value,
      extra.reconcile ?? "n",
      "",
      "1",
    ]
      .map((c) => (/[,"]/.test(c!) ? `"${c!.replace(/"/g, '""')}"` : c))
      .join(",");
  const IRA = "Investments:IRA";
  return [
    HEADER,
    // An outside contribution: its other side is in another tree, skipped by default.
    row("01/02/2026", 1, "Contribution", IRA, "$5,000.00", "5000.00", "5000.00", { reconcile: "c" }),
    row("01/02/2026", 1, "Contribution", "Income:IRA Contribution", "-$5,000.00", "-5000.00", "-5000.00"),
    // A ticker fund, a named fund without a ticker, and a stock.
    row("01/05/2026", 2, "Buy VTSAX", IRA, "-$1,000.00", "-1000.00", "-1000.00"),
    row("01/05/2026", 2, "Buy VTSAX", `${IRA}:Vanguard Total Stock`, "10 VTSAX", "10", "1000.00"),
    row("01/06/2026", 3, "Statement update", IRA, "-$1,234.57", "-1234.57", "-1234.57"),
    row(
      "01/06/2026",
      3,
      "Statement update",
      `${IRA}:Acme Stable Value Fund`,
      "1,234.567 Acme Stable Value Fund",
      "1,234.567",
      "1,234.57",
    ),
    row("01/07/2026", 4, "Buy AAPL", IRA, "-$600.00", "-600.00", "-600.00"),
    row("01/07/2026", 4, "Buy AAPL", `${IRA}:Apple`, "3 AAPL", "3", "600.00"),
    // A share-class conversion recorded as shares with no money: a split.
    row("02/01/2026", 5, "Conversion", IRA, "$0.00", "0.00", "0.00"),
    row("02/01/2026", 5, "Conversion", `${IRA}:Apple`, "3 AAPL", "3", "0.00"),
    // A sale; older exports leave the transaction fields blank on later rows.
    row("03/13/2026", 6, "Sell AAPL", IRA, "$700.00", "700.00", "700.00"),
    [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      `${IRA}:Apple`,
      "Apple",
      "-2 AAPL",
      "-2",
      "-$700.00",
      "-700.00",
      "n",
      "",
      "350",
    ].join(","),
    // A voided transaction.
    row("03/20/2026", 7, "Voided buy", IRA, "$0.00", "0.00", "0.00", { void: "Entered twice" }),
    row("03/20/2026", 7, "Voided buy", `${IRA}:Vanguard Total Stock`, "0 VTSAX", "0", "0.00", {
      void: "Entered twice",
    }),
  ].join("\n");
}

describe("reading a GnuCash CSV export", () => {
  test("recognises the export and infers the account tree", () => {
    const text = sampleCsv();
    expect(isGnucashCsv(text)).toBe(true);
    expect(isGnucashCsv("Date,Payee,Amount\n")).toBe(false);

    const book = readGnucashCsv(text);
    expect(book.currency).toBe("USD");
    const acct = (path: string) => book.accounts.find((a) => a.path === path)!;
    expect(acct("Investments")).toMatchObject({ type: "ASSET", placeholder: true });
    expect(acct("Investments:IRA")).toMatchObject({ type: "ASSET", commodity: "USD", placeholder: false });
    expect(acct("Investments:IRA:Vanguard Total Stock")).toMatchObject({ type: "MUTUAL", commodity: "VTSAX" });
    expect(acct("Investments:IRA:Acme Stable Value Fund")).toMatchObject({
      type: "MUTUAL",
      commodity: "Acme Stable Value Fund",
    });
    expect(acct("Investments:IRA:Apple")).toMatchObject({ type: "STOCK", commodity: "AAPL" });
    // Accounts in another tree aren't guessed at.
    expect(acct("Income:IRA Contribution").type).toBe("UNKNOWN");
    expect(acct("Investments:IRA:Apple").parentGuid).toBe(acct("Investments:IRA").guid);

    expect(book.transactions).toHaveLength(7);
    const sale = book.transactions.find((t) => t.guid === id(6))!;
    expect(sale).toMatchObject({ date: "2026-03-13", description: "Sell AAPL" });
    expect(sale.splits.map((s) => [s.value, s.shares])).toEqual([
      [70000, 700_000_000],
      [-70000, -2_000_000],
    ]);
    const fund = book.transactions.find((t) => t.guid === id(3))!.splits[1]!;
    expect(fund).toMatchObject({ value: 123457, shares: 1_234_567_000 });
    expect(book.transactions.find((t) => t.guid === id(1))!.splits[0]!.reconcile).toBe("c");
    expect(book.transactions.find((t) => t.guid === id(7))!.splits.every((s) => s.value === 0 && s.shares === 0)).toBe(
      true,
    );
  });

  test("works out day-first dates and decimal commas", () => {
    const text = [
      HEADER,
      `31/01/2026,${id(9)},,Buy,,CURRENCY::EUR,,,,Depot,Depot,"-1.234,50 €","-1.234,50","-1.234,50 €","-1.234,50",n,,1`,
      `31/01/2026,${id(9)},,Buy,,CURRENCY::EUR,,,,Depot:ETF,ETF,"12,5 IWDA","12,5","1.234,50 €","1.234,50",n,,98.76`,
    ].join("\n");
    const book = readGnucashCsv(text);
    expect(book.currency).toBe("EUR");
    expect(book.transactions[0]).toMatchObject({ date: "2026-01-31" });
    expect(book.transactions[0]!.splits.map((s) => [s.value, s.shares])).toEqual([
      [-123450, -1_234_500_000],
      [123450, 12_500_000],
    ]);
    expect(book.accounts.find((a) => a.path === "Depot")!.commodity).toBe("EUR");
  });

  test("explains what to do with the wrong kind of CSV", () => {
    expect(() => readGnucashCsv("Transaction ID,Full Account Name,Amount Num.,Value Num.\n")).toThrow(/simple layout/);
  });
});

describe("importing a GnuCash CSV into an investment account", () => {
  async function setUp() {
    const { app } = testApp();
    const c = new Client(app);
    await c.post("/api/auth/setup", owner);
    const ira = (await c.post("/api/accounts", { name: "Roth IRA", type: "investment" })).json as Account;
    const upload = async () => {
      const res = await c.upload("/api/import/gnucash?name=ira.csv", new TextEncoder().encode(sampleCsv()));
      expect(res.status).toBe(201);
      return res.json as GnucashUpload;
    };
    return { c, ira, upload };
  }

  test("brings in holdings, cash and trades, matching GnuCash's balance", async () => {
    const { c, ira, upload } = await setUp();
    const up = await upload();
    expect(up).toMatchObject({ source: "csv", currency: "USD", transactionCount: 7 });
    const suggested = (path: string) => up.accounts.find((a) => a.path === path)!.suggested;
    expect(suggested("Investments:IRA")).toMatchObject({ kind: "account", type: "investment", onBudget: false });
    expect(suggested("Investments:IRA:Vanguard Total Stock")).toMatchObject({
      kind: "holding",
      symbol: "VTSAX",
      type: "mutual_fund",
    });
    expect(suggested("Investments:IRA:Acme Stable Value Fund")).toMatchObject({ kind: "holding", symbol: "ASVF" });
    expect(suggested("Income:IRA Contribution")).toEqual({ kind: "skip" });

    // Point the GnuCash cash account at the investment account we just made.
    const iraGuid = up.accounts.find((a) => a.path === "Investments:IRA")!.guid;
    const mappings: Record<string, GnucashMapping> = {
      [iraGuid]: { kind: "account", accountId: ira.id, name: ira.name, type: "investment", onBudget: false },
    };
    const preview = (await c.post(`/api/import/gnucash/${up.uploadId}/preview`, { mappings })).json as GnucashPreview;
    expect(preview).toMatchObject({ transactions: 6, voided: 1, investments: 5, newAccounts: [] });
    expect(preview.balances).toEqual([{ name: "Roth IRA", accountId: ira.id, gnucash: 286543, afterImport: 286543 }]);

    expect((await c.post(`/api/import/gnucash/${up.uploadId}/commit`, { mappings })).status).toBe(201);
    const account = ((await c.get("/api/accounts")).json as Account[]).find((a) => a.id === ira.id)!;
    expect(account.balance).toBe(286543);

    const holdings = ((await c.get("/api/investments/holdings")).json as HoldingsSummary).accounts[0]!.holdings;
    expect(Object.fromEntries(holdings.map((h) => [h.symbol, h.shares]))).toEqual({
      VTSAX: 10_000_000,
      ASVF: 1_234_567_000,
      AAPL: 4_000_000, // 3 bought, 3 more from the conversion, 2 sold
    });
    // Only real tickers get automatic prices.
    const secs = (await c.get("/api/investments/securities")).json as Security[];
    expect(Object.fromEntries(secs.map((s) => [s.symbol, s.autoPrice]))).toEqual({
      AAPL: true,
      ASVF: false,
      VTSAX: true,
    });

    // The same file again brings in nothing new.
    const again = (await c.post(`/api/import/gnucash/${(await upload()).uploadId}/preview`, { mappings: {} }))
      .json as GnucashPreview;
    expect(again).toMatchObject({ transactions: 0, alreadyImported: 6 });
  });

  test("a CSV that isn't GnuCash's gets a helpful message", async () => {
    const { c } = await setUp();
    const res = await c.upload("/api/import/gnucash", new TextEncoder().encode("Date,Payee,Amount\n2026-01-01,X,1\n"));
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("Export Transactions to CSV");
  });
});
