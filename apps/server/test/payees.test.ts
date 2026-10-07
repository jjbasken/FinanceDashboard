import { describe, expect, test } from "bun:test";
import type { Account, Payee, Transaction } from "@fd/shared";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const checking = (await c.post("/api/accounts", { name: "Checking", type: "checking" })).json as Account;
  const add = async (payeeName: string) =>
    (await c.post("/api/transactions", { accountId: checking.id, date: "2026-10-01", amount: -100, payeeName }))
      .json as Transaction;
  const list = async () => (await c.get("/api/payees")).json as Payee[];
  const byName = async (name: string) => (await list()).find((p) => p.name === name)!;
  return { c, checking, add, list, byName };
}

describe("payees", () => {
  test("list how often each is used", async () => {
    const { add, byName } = await setUp();
    await add("Corner Grocer");
    await add("corner grocer");
    await add("Gas Station");
    expect((await byName("Corner Grocer")).transactionCount).toBe(2);
    expect((await byName("Checking")).transferAccountId).not.toBeNull();
  });

  test("remember the category of each payee's latest categorised transaction", async () => {
    const { c, checking, add, byName } = await setUp();
    const groups = (await c.get("/api/categories")).json as { categories: { id: number; name: string }[] }[];
    const cat = (name: string) => groups.flatMap((g) => g.categories).find((x) => x.name === name)!.id;
    const post = (date: string, categoryId: number | null) =>
      c.post("/api/transactions", { accountId: checking.id, date, amount: -100, payeeName: "Corner Grocer", categoryId });
    await add("Gas Station");
    expect((await byName("Gas Station")).lastCategoryId).toBeNull();
    await post("2026-10-01", cat("Groceries"));
    await post("2026-09-01", cat("Household"));
    await post("2026-10-02", null);
    expect((await byName("Corner Grocer")).lastCategoryId).toBe(cat("Groceries"));
  });

  test("rename, but not onto an existing name", async () => {
    const { c, add, byName } = await setUp();
    await add("CORNER GROCER #12");
    await add("Corner Grocer");
    const ugly = await byName("CORNER GROCER #12");
    expect((await c.patch(`/api/payees/${ugly.id}`, { name: "corner grocer" })).status).toBe(409);
    expect((await c.patch(`/api/payees/${ugly.id}`, { name: "Grocer (downtown)" })).status).toBe(200);
    expect((await byName("Grocer (downtown)")).id).toBe(ugly.id);
  });

  test("merge moves transactions and removes the sources", async () => {
    const { c, add, list, byName } = await setUp();
    const a = await add("CORNER GROCER #12");
    await add("CORNER GROCER #7");
    await add("Corner Grocer");
    const target = await byName("Corner Grocer");
    const sources = [(await byName("CORNER GROCER #12")).id, (await byName("CORNER GROCER #7")).id];
    const res = await c.post("/api/payees/merge", { sourceIds: sources, targetId: target.id });
    expect(res.json).toEqual({ ok: true, moved: 2 });
    expect((await byName("Corner Grocer")).transactionCount).toBe(3);
    expect((await list()).map((p) => p.name)).not.toContain("CORNER GROCER #7");
    expect(((await c.get(`/api/transactions/${a.id}`)).json as Transaction).payeeId).toBe(target.id);
    expect((await c.post("/api/payees/merge", { sourceIds: [target.id], targetId: target.id })).status).toBe(400);
  });

  test("delete leaves transactions without a payee; delete-unused clears leftovers", async () => {
    const { c, add, list, byName } = await setUp();
    const t = await add("Mystery");
    await add("Kept");
    const mystery = await byName("Mystery");
    expect((await c.delete(`/api/payees/${mystery.id}`)).status).toBe(200);
    expect(((await c.get(`/api/transactions/${t.id}`)).json as Transaction).payeeId).toBeNull();

    // Moving a transaction to another payee strands the old one.
    const s1 = await add("Stranded");
    await c.patch(`/api/transactions/${s1.id}`, { payeeName: "Kept" });
    expect((await c.post("/api/payees/delete-unused")).json).toEqual({ ok: true, deleted: 1 });
    expect((await list()).map((p) => p.name)).toEqual(["Checking", "Kept"]);
  });

  test("transfer payees can't be renamed, merged or deleted", async () => {
    const { c, checking, add, byName } = await setUp();
    await add("Someone");
    const someone = await byName("Someone");
    expect((await c.patch(`/api/payees/${checking.transferPayeeId}`, { name: "x" })).status).toBe(400);
    expect((await c.delete(`/api/payees/${checking.transferPayeeId}`)).status).toBe(400);
    expect(
      (await c.post("/api/payees/merge", { sourceIds: [checking.transferPayeeId], targetId: someone.id })).status,
    ).toBe(400);
  });
});
