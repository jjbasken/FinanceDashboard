import { describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import type { GnucashPreview, GnucashUpload, HoldingsSummary } from "@fd/shared";
import { readBook, type GncBook } from "../src/importers/gnucash/read";
import { readGnucashXml } from "../src/importers/gnucash/xml";
import { Client, owner, testApp } from "./helpers";

// Written by GnuCash 5.10 itself from the same script, once per format (see the fixture README).
const DIR = join(import.meta.dir, "fixtures/gnucash-real");
const xmlBytes = async () => new Uint8Array(await Bun.file(join(DIR, "sample-5.10.gnucash-xml")).arrayBuffer());
const SQLITE = join(DIR, "sample-5.10.gnucash-sqlite3");

/** A book with GUIDs replaced by paths, so two saves of the same content compare equal. */
function comparable(book: GncBook) {
  const path = (guid: string | null) => (guid ? book.accounts.find((a) => a.guid === guid)!.path : null);
  return {
    currency: book.currency,
    accounts: book.accounts.map((a) => ({
      ...a,
      guid: path(a.guid),
      parentGuid: path(a.parentGuid),
      // GnuCash's XML doesn't spell out currencies' full names ("US Dollar"); only holdings' names are used.
      commodityName: a.commodityNamespace === "CURRENCY" ? "" : a.commodityName,
    })),
    transactions: book.transactions
      .map((t) => ({
        ...t,
        guid: "",
        splits: t.splits
          .map((s) => ({ ...s, guid: "", accountGuid: path(s.accountGuid) }))
          .sort((x, y) => x.accountGuid!.localeCompare(y.accountGuid!)),
      }))
      .sort((x, y) => `${x.date}${x.description}`.localeCompare(`${y.date}${y.description}`)),
    prices: book.prices,
  };
}

describe("GnuCash XML books", () => {
  test("read the same as the sqlite3 save of the same book", async () => {
    const xml = readGnucashXml(await xmlBytes());
    expect(comparable(xml)).toEqual(comparable(readBook(SQLITE)));

    expect(xml.accounts.find((a) => a.path === "Assets")).toMatchObject({ placeholder: true, type: "ASSET" });
    expect(xml.accounts.find((a) => a.path === "Assets:Old Savings")).toMatchObject({ hidden: true });
    expect(xml.accounts.find((a) => a.path === "Assets:Brokerage:Spartan Total Market")).toMatchObject({
      type: "MUTUAL",
      commodity: "SP TTL MRKT",
      commodityName: "Spartan Total Market",
      commodityNamespace: "FUND",
    });
    const grocer = xml.transactions.find((t) => t.num === "1001")!;
    expect(grocer).toMatchObject({ date: "2026-01-05", description: "Smith & Sons <Grocer>", notes: "weekly shop" });
    expect(grocer.splits.find((s) => s.memo)).toMatchObject({ memo: "debit & card", reconcile: "c", value: -8250 });
    expect(xml.prices).toHaveLength(2);
  });

  test("import exactly like the sqlite3 book, holdings included", async () => {
    async function importFile(bytes: Uint8Array) {
      const { app } = testApp();
      const c = new Client(app);
      await c.post("/api/auth/setup", owner);
      const up = (await c.upload("/api/import/gnucash?name=book.gnucash", bytes)).json as GnucashUpload;
      const preview = (await c.post(`/api/import/gnucash/${up.uploadId}/preview`, { mappings: {} }))
        .json as GnucashPreview;
      await c.post(`/api/import/gnucash/${up.uploadId}/commit`, { mappings: {} });
      const holdings = ((await c.get("/api/investments/holdings")).json as HoldingsSummary).accounts.flatMap((a) =>
        a.holdings.map((h) => [a.accountName, h.symbol, h.shares, h.cost]),
      );
      return { source: up.source, transactionCount: up.transactionCount, preview, holdings };
    }
    const fromXml = await importFile(await xmlBytes());
    const fromSqlite = await importFile(new Uint8Array(await Bun.file(SQLITE).arrayBuffer()));
    expect(fromXml).toEqual(fromSqlite);
    expect(fromXml.source).toBe("book");
    expect(fromXml.preview).toMatchObject({ transactions: 8, voided: 1, investments: 3, prices: 2 });
    for (const b of fromXml.preview.balances) expect(b.afterImport).toBe(b.gnucash);
    // Largest value first: 4.367 × $230 beats 3 × $260 (prices from the book).
    expect(fromXml.holdings).toEqual([
      ["Brokerage", "STM", 4_367_000, 100_000],
      ["Brokerage", "AAPL", 3_000_000, 60_000],
    ]);
  });

  test("uncompressed XML works, and scheduled-transaction templates are left out", async () => {
    const plain = new TextDecoder().decode(gunzipSync(await xmlBytes()));
    // A template account and transaction, as GnuCash stores scheduled transactions.
    const template = `
<gnc:template-transactions>
<gnc:account version="2.0.0"><act:name>Template Root</act:name><act:id type="guid">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</act:id><act:type>ROOT</act:type></gnc:account>
<gnc:account version="2.0.0"><act:name>tmpl</act:name><act:id type="guid">bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</act:id><act:type>BANK</act:type><act:parent type="guid">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</act:parent></gnc:account>
<gnc:transaction version="2.0.0"><trn:id type="guid">cccccccccccccccccccccccccccccccc</trn:id><trn:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></trn:currency><trn:date-posted><ts:date>2026-04-01 10:59:00 +0000</ts:date></trn:date-posted><trn:description>Rent (scheduled)</trn:description><trn:splits><trn:split><split:id type="guid">dddddddddddddddddddddddddddddddd</split:id><split:reconciled-state>n</split:reconciled-state><split:value>-150000/100</split:value><split:quantity>-150000/100</split:quantity><split:account type="guid">bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</split:account></trn:split></trn:splits></gnc:transaction>
</gnc:template-transactions>`;
    const withTemplate = plain.replace("</gnc:book>", `${template}\n</gnc:book>`);
    expect(withTemplate).not.toBe(plain);
    const book = readGnucashXml(new TextEncoder().encode(withTemplate));
    expect(book.transactions.map((t) => t.description)).not.toContain("Rent (scheduled)");
    expect(book.accounts.map((a) => a.name)).not.toContain("tmpl");
    expect(comparable(book)).toEqual(comparable(readGnucashXml(gzipSync(plain))));
  });

  test("a damaged file gets a clear error", async () => {
    const { app } = testApp();
    const c = new Client(app);
    await c.post("/api/auth/setup", owner);
    const truncated = (await xmlBytes()).slice(0, 200);
    const res = await c.upload("/api/import/gnucash", truncated);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/decompress|GnuCash/);
  });
});
