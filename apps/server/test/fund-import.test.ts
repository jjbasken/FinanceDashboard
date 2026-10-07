import { describe, expect, test } from "bun:test";
import type {
  Account,
  FundImportResult,
  FundStatementPreview,
  HoldingsSummary,
  ImportBatch,
  Security,
  Transaction,
} from "@fd/shared";
import { classify, parseFundStatement, symbolFor } from "../src/importers/fund/statement";
import { Client, owner, testApp } from "./helpers";

const STATEMENT = `Fund Account Number,Fund Name,Price,Shares,Total Value
974455687-02,2034/2035 Enrollment Portfolio,$19.64,1634.4842,$32101.27
974455687-02,Large-Cap Stock Index Portfolio,$69.83,626.8554,$43773.31

Account Number,Trade Date,Process Date,Transaction Type,Transaction Description,Investment Name,Share Price,Shares,Gross Amount,Net Amount
974455687-02,10/01/2026,10/01/2026,Recurring Contribution,Recurring Contribution,Large-Cap Stock Index Portfolio,$68.45,2.5566,$175,$175
974455687-02,10/01/2026,10/01/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.42,9.0113,$175,$175
974455687-02,09/01/2026,09/01/2026,Recurring Contribution,Recurring Contribution,Large-Cap Stock Index Portfolio,$68.08,2.5705,$175,$175
974455687-02,09/01/2026,09/01/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.71,8.8787,$175,$175
974455687-02,08/03/2026,08/03/2026,Recurring Contribution,Recurring Contribution,Large-Cap Stock Index Portfolio,$67.74,2.5834,$175,$175
974455687-02,08/03/2026,08/03/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.62,8.9195,$175,$175
974455687-02,07/01/2026,07/01/2026,Recurring Contribution,Recurring Contribution,Large-Cap Stock Index Portfolio,$66.65,2.6257,$175,$175
974455687-02,07/01/2026,07/01/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.51,8.9698,$175,$175
974455687-02,06/01/2026,06/01/2026,Recurring Contribution,Recurring Contribution,Large-Cap Stock Index Portfolio,$67.62,2.588,$175,$175
974455687-02,06/01/2026,06/01/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.6,8.9286,$175,$175
974455687-02,05/01/2026,05/01/2026,Recurring Contribution,Recurring Contribution,Large-Cap Stock Index Portfolio,$64.26,2.7233,$175,$175
974455687-02,05/01/2026,05/01/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.07,9.1767,$175,$175
`;

const bytes = (s: string) => new TextEncoder().encode(s);

async function setUp() {
  const { app } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const plan = (await c.post("/api/accounts", { name: "Kids 529", type: "investment" })).json as Account;
  const upload = async (text = STATEMENT) => {
    const res = await c.upload(`/api/import/fund?accountId=${plan.id}&name=529.csv`, bytes(text));
    return res;
  };
  const preview = async (text = STATEMENT) => {
    const res = await upload(text);
    expect(res.status).toBe(201);
    return res.json as FundStatementPreview;
  };
  const commit = async (p: FundStatementPreview) =>
    (await c.post(`/api/import/fund/${p.uploadId}/commit`, {})).json as FundImportResult;
  const account = async () => ((await c.get("/api/accounts")).json as Account[]).find((a) => a.id === plan.id)!;
  return { c, plan, upload, preview, commit, account };
}

describe("reading fund statements", () => {
  test("reads both sections", () => {
    const s = parseFundStatement(STATEMENT);
    expect(s.errors).toEqual([]);
    expect(s.holdings[0]).toEqual({
      line: 2,
      fund: "2034/2035 Enrollment Portfolio",
      price: 19_640_000,
      shares: 1_634_484_200,
    });
    expect(s.txns).toHaveLength(12);
    expect(s.txns[0]).toMatchObject({
      line: 6,
      date: "2026-10-01",
      kind: "contribution",
      fund: "Large-Cap Stock Index Portfolio",
      shares: 2_556_600,
      price: 68_450_000,
      amount: 17_500,
    });
  });

  test("classifies transaction types", () => {
    expect(classify("Recurring Contribution", 1)).toBe("contribution");
    expect(classify("Qualified Withdrawal", -1)).toBe("withdrawal");
    expect(classify("Dividend Reinvestment", 1)).toBe("reinvest");
    expect(classify("Exchange", -1)).toBe("exchange_out");
    expect(classify("Exchange In", 1)).toBe("exchange_in");
    expect(classify("Annual Account Fee", -1)).toBe("fee");
    expect(classify("Something else", 1)).toBeNull();
  });

  test("makes ticker-style symbols for funds without one", () => {
    expect(symbolFor("Large-Cap Stock Index Portfolio", new Set())).toBe("LARGE-CAP-STOCK-INDEX");
    expect(symbolFor("2034/2035 Enrollment Portfolio", new Set(["2034-2035-ENROLLMENT"]))).toBe(
      "2034-2035-ENROLLMENT-2",
    );
  });

  test("rejects files that aren't fund statements", async () => {
    const { upload } = await setUp();
    const res = await upload("Date,Description,Amount\n2026-01-01,Coffee,-4.50\n");
    expect(res.status).toBe(400);
  });
});

describe("importing a 529 statement", () => {
  test("adds opening shares so holdings match the statement, and records each contribution", async () => {
    const { c, plan, preview, commit, account } = await setUp();
    const p = await preview();
    expect(p.counts).toEqual({ new: 12, duplicate: 0 });
    expect(p.openingDate).toBe("2026-04-30");
    expect(p.funds.map((f) => [f.name, f.symbol, f.importShares, f.openingShares, f.difference])).toEqual([
      ["2034/2035 Enrollment Portfolio", "2034-2035-ENROLLMENT", 53_884_600, 1_580_599_600, 0],
      ["Large-Cap Stock Index Portfolio", "LARGE-CAP-STOCK-INDEX", 15_647_500, 611_207_900, 0],
    ]);

    expect(await commit(p)).toMatchObject({ created: 14 });
    // Each contribution's deposit is spent on shares, so no cash is left over.
    const a = await account();
    expect(a.balance).toBe(0);
    // Valued at the statement's prices: $32,101.27 + $43,773.31.
    expect(a.holdingsValue).toBe(7_587_458);

    const register = (await c.get(`/api/accounts/${plan.id}/transactions`)).json as Transaction[];
    expect(register).toHaveLength(24);
    expect(register.filter((t) => t.amount === 17_500)).toHaveLength(12);
    const securities = (await c.get("/api/investments/securities")).json as Security[];
    expect(securities.every((s) => !s.autoPrice && s.type === "mutual_fund")).toBe(true);
    // Opening shares have no cost basis, so gains aren't shown for them.
    const summary = (await c.get("/api/investments/holdings")).json as HoldingsSummary;
    expect(summary.accounts[0]!.holdings.map((h) => h.costKnown)).toEqual([false, false]);
    expect(summary.totals).toMatchObject({ cost: 0, gain: 0, costUnknownValue: 7_587_458 });
  });

  test("importing the same file again adds nothing", async () => {
    const { preview, commit, account } = await setUp();
    await commit(await preview());
    const again = await preview();
    expect(again.counts).toEqual({ new: 0, duplicate: 12 });
    expect(again.funds.every((f) => f.openingShares === 0 && f.difference === 0)).toBe(true);
    expect(await commit(again)).toEqual({ batchId: null, created: 0 });
    expect((await account()).holdingsValue).toBe(7_587_458);
  });

  test("a later statement adds only its new transactions, and reports a mismatch", async () => {
    const { preview, commit } = await setUp();
    await commit(await preview());
    const november = STATEMENT.replace("1634.4842", "1643.4842").replace(
      "Net Amount\n",
      "Net Amount\n974455687-02,11/02/2026,11/02/2026,Recurring Contribution,Recurring Contribution,2034/2035 Enrollment Portfolio,$19.50,8.9744,$175,$175\n",
    );
    const p = await preview(november);
    expect(p.counts).toEqual({ new: 1, duplicate: 12 });
    const enrollment = p.funds.find((f) => f.name.startsWith("2034"))!;
    // 9 more shares on the statement, 8.9744 from the new contribution: 0.0256 unexplained.
    expect(enrollment).toMatchObject({ importShares: 8_974_400, openingShares: 0, difference: 25_600 });
  });

  test("withdrawals sell shares and take the cash out; unknown types are listed", async () => {
    const { c, plan, preview, commit, account } = await setUp();
    await commit(await preview());
    const withdrawal = `Account Number,Trade Date,Process Date,Transaction Type,Transaction Description,Investment Name,Share Price,Shares,Gross Amount,Net Amount
974455687-02,11/15/2026,11/15/2026,Qualified Withdrawal,Tuition,Large-Cap Stock Index Portfolio,$70.00,-10,($700),($700)
974455687-02,11/16/2026,11/16/2026,Mystery Adjustment,Mystery,Large-Cap Stock Index Portfolio,$70.00,1,$70,$70
`;
    const p = await preview(withdrawal);
    expect(p.items.map((i) => i.kind)).toEqual(["withdrawal"]);
    expect(p.errors).toEqual([{ line: 3, message: "Don't know how to import “Mystery Adjustment” transactions" }]);
    await commit(p);
    expect((await account()).balance).toBe(0);
    const register = (await c.get(`/api/accounts/${plan.id}/transactions`)).json as Transaction[];
    expect(register.filter((t) => t.date === "2026-11-15").map((t) => t.amount).sort()).toEqual([-70_000, 70_000]);
  });

  test("undoing the import removes what it added", async () => {
    const { c, preview, commit, account } = await setUp();
    await commit(await preview());
    const [batch] = (await c.get("/api/import/batches")).json as ImportBatch[];
    expect(batch).toMatchObject({ source: "fund_csv", fileName: "529.csv", transactionCount: 14 });
    expect((await c.post(`/api/import/batches/${batch!.id}/undo`, {})).status).toBe(200);
    const a = await account();
    expect([a.balance, a.holdingsValue]).toEqual([0, 0]);
    expect((await c.get("/api/investments/securities")).json).toEqual([]);
  });
});
