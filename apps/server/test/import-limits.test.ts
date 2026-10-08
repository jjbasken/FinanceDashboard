import { expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { ImportPreviews, readUpload } from "../src/services/import-previews";
import { csvWidth, parseCsv } from "../src/importers/bank/parse";
import { readGnucashXml } from "../src/importers/gnucash/xml";
import { MAX_IMPORT_RECORDS, MAX_IMPORT_CELLS } from "../src/importers/limits";
import { Client, owner, testApp } from "./helpers";

function status(work: () => unknown) {
  try { work(); } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    return (error as HTTPException).status;
  }
  throw new Error("Expected rejection");
}

test("upload reservations bound concurrency across formats and release capacity", () => {
  const previews = new ImportPreviews();
  const first = previews.begin(1);
  expect(status(() => previews.begin(1))).toBe(429);
  const second = previews.begin(2);
  expect(status(() => previews.begin(3))).toBe(429);
  first(); second();
  previews.begin(3)();
});

test("preview counts, estimated bytes, ownership, deletion and expiry are bounded", async () => {
  const previews = new ImportPreviews(20, 500, 300);
  previews.set("bank:a", 1, 1, "a");
  expect(status(() => previews.get("bank:a", 2))).toBe(404);
  expect(status(() => previews.set("book:big", 2, 2, "x".repeat(200)))).toBe(413);
  previews.set("fund:b", 2, 2, "x".repeat(100));
  expect(status(() => previews.set("book:c", 3, 3, "x".repeat(100)))).toBe(429);
  previews.delete("fund:b");
  previews.set("book:c", 3, 3, "x".repeat(100));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(status(() => previews.get("bank:a", 1))).toBe(404);
  previews.set("bank:d", 1, 1, "a");
  previews.set("book:e", 1, 1, "a");
  previews.set("fund:f", 1, 1, "a");
  expect(status(() => previews.begin(1))).toBe(429);
  previews.delete("bank:d"); previews.delete("book:e"); previews.delete("fund:f");
  previews.begin(1)();
});

test("global preview count also reserves slots for in-flight uploads", () => {
  const previews = new ImportPreviews();
  for (let i = 0; i < 7; i++) previews.set(String(i), i + 1, 1, {});
  const release = previews.begin(10);
  expect(status(() => previews.begin(11))).toBe(429);
  release();
  for (let i = 0; i < 7; i++) previews.delete(String(i));
});

test("uploads without declared lengths stop reading at the byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  });
  await expect(readUpload(new Request("http://localhost/upload", { method: "POST", body }), 5)).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
  const bytes = await readUpload(new Request("http://localhost/upload", { method: "POST", body: "hello" }), 5);
  expect(new TextDecoder().decode(bytes)).toBe("hello");
});

test("CSV width handles a million rows without a spread call stack failure", () => {
  const rows = Array<string[]>(1_000_000).fill(["a", "b"]);
  rows[999_999] = ["a", "b", "c"];
  expect(csvWidth(rows)).toBe(3);
});

test("CSV parsing bounds rows and cells with useful errors", () => {
  expect(() => parseCsv("a\n".repeat(MAX_IMPORT_RECORDS + 1))).toThrow("too many rows");
  expect(() => parseCsv("a,".repeat(MAX_IMPORT_CELLS + 1))).toThrow("too many cells");
});

test("XML parsing rejects excessive nesting before building an unbounded tree", () => {
  const xml = '<?xml version="1.0"?><gnc-v2><gnc:book><gnc:account>' + "<x>".repeat(130) + "</x>".repeat(130) + "</gnc:account></gnc:book></gnc-v2>";
  expect(() => readGnucashXml(new TextEncoder().encode(xml))).toThrow("too complex");
});

test("route quotas span upload types, isolate app instances, and release failed uploads", async () => {
  const { app } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const accountId = (await c.post("/api/accounts", { name: "Checking", type: "checking" })).json.id;
  for (let i = 0; i < 4; i++) expect((await c.upload(`/api/import/bank?accountId=${accountId}`, new Uint8Array())).status).toBe(400);
  const file = new TextEncoder().encode("Date,Amount\n2026-10-01,1.00\n");
  for (let i = 0; i < 3; i++) expect((await c.upload(`/api/import/bank?accountId=${accountId}`, file)).status).toBe(201);
  expect((await c.upload("/api/import/gnucash", file)).status).toBe(429);
  const other = testApp();
  const otherClient = new Client(other.app);
  await otherClient.post("/api/auth/setup", owner);
  expect((await otherClient.upload("/api/import/gnucash", new Uint8Array())).status).toBe(400);
});

test("oversized GnuCash CSV uploads return a useful client error", async () => {
  const { app } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const header = "Transaction ID,Full Account Name,Amount Num.,Value Num.\n";
  const bytes = new TextEncoder().encode(header + "a,b,1,1\n".repeat(MAX_IMPORT_RECORDS));
  const result = await c.upload("/api/import/gnucash", bytes);
  expect(result.status).toBe(400);
  expect(result.json.error).toContain("too many rows");
});
