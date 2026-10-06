import { describe, expect, test } from "bun:test";
import type { Account, BankPreview, BankUpload, CategoryGroup, ImportBatch, Transaction } from "@fd/shared";
import { csvToTxns, parseCsv, parseDate, parseOfx, suggestCsvMapping } from "../src/importers/bank/parse";
import { eq } from "drizzle-orm";
import { transactions } from "../src/db/schema";
import { Client, owner, testApp } from "./helpers";

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261001120000.000[-5:EST]
<TRNAMT>-42.50
<FITID>2026100101
<NAME>CORNER GROCER #12
<MEMO>POS PURCHASE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20261003
<TRNAMT>-150.00
<FITID>2026100302
<CHECKNUM>1042
<NAME>CITY WATER &amp; SEWER
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261005
<TRNAMT>2500.00
<FITID>2026100503
<NAME>ACME PAYROLL
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261002</DTPOSTED><TRNAMT>-9.99</TRNAMT><FITID>X1</FITID><NAME>Streaming</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

describe("parsing", () => {
  test("OFX 1.x (SGML) and 2.x (XML)", () => {
    expect(parseOfx(OFX_SGML)).toEqual([
      {
        externalId: "2026100101",
        date: "2026-10-01",
        amount: -4250,
        payee: "CORNER GROCER #12",
        notes: "POS PURCHASE",
      },
      { externalId: "2026100302", date: "2026-10-03", amount: -15000, payee: "CITY WATER & SEWER", notes: "#1042" },
      { externalId: "2026100503", date: "2026-10-05", amount: 250000, payee: "ACME PAYROLL", notes: "" },
    ]);
    // OFX also allows a decimal comma.
    expect(parseOfx(OFX_SGML.replace("-42.50", "-42,50"))[0]!.amount).toBe(-4250);
    expect(parseOfx(OFX_XML)).toEqual([
      { externalId: "X1", date: "2026-10-02", amount: -999, payee: "Streaming", notes: "" },
    ]);
  });

  test("CSV with quotes, and column and date-format guessing", () => {
    const rows = parseCsv(
      'Date,Description,Amount,Balance\r\n10/01/2026,"Grocer, Inc.",-42.50,"1,000.00"\r\n10/13/2026,"Say ""hi""",15,1015\n',
    );
    expect(rows[1]).toEqual(["10/01/2026", "Grocer, Inc.", "-42.50", "1,000.00"]);
    expect(rows[2]![1]).toBe('Say "hi"');
    const m = suggestCsvMapping(rows);
    expect(m).toMatchObject({
      hasHeader: true,
      date: 0,
      dateFormat: "MM/DD/YYYY",
      payee: 1,
      amount: 2,
      debit: null,
      credit: null,
    });
    expect(csvToTxns(rows, m).txns.map((t) => [t.date, t.amount, t.payee])).toEqual([
      ["2026-10-01", -4250, "Grocer, Inc."],
      ["2026-10-13", 1500, 'Say "hi"'],
    ]);
  });

  test("semicolon CSV with day-first dates and separate debit/credit columns", () => {
    const rows = parseCsv("Booking date;Payee;Debit;Credit\n31.10.2026;Bakery;3.20;\n01.11.2026;Refund;;10.00\n");
    const m = suggestCsvMapping(rows);
    expect(m).toMatchObject({ dateFormat: "DD.MM.YYYY", debit: 2, credit: 3, amount: null });
    expect(csvToTxns(rows, m).txns.map((t) => [t.date, t.amount])).toEqual([
      ["2026-10-31", -320],
      ["2026-11-01", 1000],
    ]);
  });

  test("dates and bad rows", () => {
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("3/7/26", "MM/DD/YYYY")).toBe("2026-03-07");
    expect(parseDate("3/7/26", "DD/MM/YYYY")).toBe("2026-07-03");
    const { txns, errors } = csvToTxns(
      [
        ["d", "a"],
        ["2026-01-01", "oops"],
        ["nope", "1"],
        ["2026-01-02", "1"],
      ],
      {
        hasHeader: true,
        date: 0,
        dateFormat: "YYYY-MM-DD",
        payee: null,
        notes: null,
        amount: 1,
        debit: null,
        credit: null,
        invert: true,
      },
    );
    expect(txns.map((t) => t.amount)).toEqual([-100]);
    expect(errors).toEqual([
      { line: 2, message: "Unreadable amount" },
      { line: 3, message: 'Unreadable date "nope"' },
    ]);
  });
});

async function setUp() {
  const { app, db } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const checking = (await c.post("/api/accounts", { name: "Checking", type: "checking" })).json as Account;
  const groups = (await c.get("/api/categories")).json as CategoryGroup[];
  const cat = (name: string) => groups.flatMap((g) => g.categories).find((x) => x.name === name)!.id;
  const upload = async (text: string, name = "statement.ofx", accountId = checking.id) => {
    const res = await c.upload(`/api/import/bank?accountId=${accountId}&name=${name}`, new TextEncoder().encode(text));
    return res;
  };
  const register = async () => (await c.get(`/api/accounts/${checking.id}/transactions`)).json as Transaction[];
  return { app, db, c, checking, cat, upload, register };
}

describe("importing a bank file", () => {
  test("OFX: new rows, a match with a hand-entered transaction, suggested categories, then duplicates", async () => {
    const { c, checking, cat, upload, register } = await setUp();
    // Entered by hand two days off; the import should link to it rather than duplicate it.
    await c.post("/api/transactions", {
      accountId: checking.id,
      date: "2026-10-05",
      amount: -15000,
      payeeName: "Water bill",
    });
    // A past transaction teaches the payee's category.
    await c.post("/api/transactions", {
      accountId: checking.id,
      date: "2026-09-01",
      amount: -1000,
      payeeName: "Corner Grocer #12",
      categoryId: cat("Groceries"),
    });

    const res = await upload(OFX_SGML);
    expect(res.status).toBe(201);
    const up = res.json as BankUpload;
    expect(up).toMatchObject({ format: "ofx", accountId: checking.id, fileName: "statement.ofx" });
    expect(up.csv).toBeUndefined();

    const preview = (await c.post(`/api/import/bank/${up.uploadId}/preview`, {})).json as BankPreview;
    expect(preview.counts).toEqual({ new: 2, duplicate: 0, match: 1 });
    expect(preview.items.map((i) => [i.payee, i.status, i.suggestedCategoryId])).toEqual([
      ["CORNER GROCER #12", "new", cat("Groceries")],
      ["CITY WATER & SEWER", "match", null],
      ["ACME PAYROLL", "new", null],
    ]);
    expect(preview.items[1]).toMatchObject({ matchPayee: "Water bill", matchDate: "2026-10-05" });

    // Import everything, choosing a category for the paycheck.
    const commit = await c.post(`/api/import/bank/${up.uploadId}/commit`, {
      include: [0, 1, 2],
      categories: { "2": cat("Income") },
    });
    expect(commit.json).toMatchObject({ created: 2, matched: 1 });
    const rows = await register();
    expect(rows).toHaveLength(4);
    expect(rows.find((t) => t.amount === 250000)).toMatchObject({ categoryId: cat("Income"), cleared: true });
    expect(rows.find((t) => t.amount === -4250)).toMatchObject({ categoryId: cat("Groceries"), notes: "POS PURCHASE" });
    // The matched transaction keeps its own details and becomes cleared.
    expect(rows.find((t) => t.amount === -15000)).toMatchObject({ date: "2026-10-05", cleared: true });

    // The same file again: all duplicates.
    const again = (await upload(OFX_SGML)).json as BankUpload;
    const second = (await c.post(`/api/import/bank/${again.uploadId}/preview`, {})).json as BankPreview;
    expect(second.counts).toEqual({ new: 0, duplicate: 3, match: 0 });
  });

  test("CSV needs a mapping; left-out rows are skipped; undo removes what was added", async () => {
    const { c, upload, register } = await setUp();
    const csv = "Date,Payee,Amount\n2026-10-01,Coffee,-4.50\n2026-10-01,Coffee,-4.50\n2026-10-02,Lunch,-12.00\n";
    const up = (await upload(csv, "card.csv")).json as BankUpload;
    expect(up.format).toBe("csv");
    expect(up.csv!.rows[0]).toEqual(["Date", "Payee", "Amount"]);
    expect((await c.post(`/api/import/bank/${up.uploadId}/preview`, {})).status).toBe(400);

    const mapping = up.csv!.suggested;
    const preview = (await c.post(`/api/import/bank/${up.uploadId}/preview`, { csv: mapping })).json as BankPreview;
    // Two identical coffees are two purchases.
    expect(preview.counts).toEqual({ new: 3, duplicate: 0, match: 0 });
    const res = await c.post(`/api/import/bank/${up.uploadId}/commit`, { csv: mapping, include: [0, 1] });
    expect(res.json).toMatchObject({ created: 2, matched: 0 });
    expect((await register()).map((t) => t.amount)).toEqual([-450, -450]);

    // Re-importing marks the imported rows as duplicates and offers the rest.
    const again = (await upload(csv, "card.csv")).json as BankUpload;
    const second = (await c.post(`/api/import/bank/${again.uploadId}/preview`, { csv: mapping })).json as BankPreview;
    expect(second.items.map((i) => i.status)).toEqual(["duplicate", "duplicate", "new"]);

    const [batch] = (await c.get("/api/import/batches")).json as ImportBatch[];
    expect(batch).toMatchObject({ source: "csv", fileName: "card.csv", transactionCount: 2 });
    await c.post(`/api/import/batches/${batch!.id}/undo`);
    expect(await register()).toEqual([]);
    expect(((await c.get("/api/payees")).json as { name: string }[]).map((p) => p.name)).not.toContain("Coffee");
  });

  test("rows imported from GnuCash can match; rows already linked to a statement can't", async () => {
    const { db, c, checking, upload } = await setUp();
    const add = async (date: string, importedId: string) => {
      const t = (
        await c.post("/api/transactions", { accountId: checking.id, date, amount: -4250, payeeName: "Grocer" })
      ).json as Transaction;
      db.update(transactions).set({ importedId }).where(eq(transactions.id, t.id)).run();
      return t.id;
    };
    await add("2026-10-01", "ofx:99:OLD");
    const fromGnucash = await add("2026-09-30", "gnucash:abc:def");
    const up = (await upload(OFX_SGML)).json as BankUpload;
    const preview = (await c.post(`/api/import/bank/${up.uploadId}/preview`, {})).json as BankPreview;
    expect(preview.items[0]).toMatchObject({ status: "match", matchId: fromGnucash });
  });

  test("validation", async () => {
    const { c, upload, checking } = await setUp();
    expect((await upload("", "x.csv")).status).toBe(400);
    expect((await upload("a,b\n", "x.csv", 999)).status).toBe(404);
    expect((await c.upload("/api/import/bank", new TextEncoder().encode("a"))).status).toBe(400);
    const up = (await upload("Date,Amount\n2026-01-01,1\n", "x.csv")).json as BankUpload;
    const bad = { ...up.csv!.suggested, amount: 9 };
    expect((await c.post(`/api/import/bank/${up.uploadId}/preview`, { csv: bad })).status).toBe(400);
    void checking;
  });
});
