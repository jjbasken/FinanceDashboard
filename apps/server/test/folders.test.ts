import { describe, expect, test } from "bun:test";
import { compareSidebarItems, type Account, type AccountFolder } from "@fd/shared";
import { createSession } from "../src/auth/sessions";
import { users } from "../src/db/schema";
import { createHousehold } from "../src/services/household";
import { SESSION_COOKIE } from "../src/middleware";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  expect((await jeremy.post("/api/auth/setup", owner)).status).toBe(201);
  const account = async (name: string, type = "checking", extra: Record<string, unknown> = {}) => {
    const res = await jeremy.post("/api/accounts", { name, type, ...extra });
    expect(res.status).toBe(201);
    return res.json as Account;
  };
  const folder = async (name: string, section = "budget", parentId: number | null = null) => {
    const res = await jeremy.post("/api/account-folders", { name, section, parentId });
    expect(res.status).toBe(201);
    return res.json.id as number;
  };
  const move = (item: { kind: string; id: number }, parentId: number | null, before: { kind: string; id: number } | null = null) =>
    jeremy.post("/api/account-folders/move", { item, parentId, before });
  const state = async () => ({
    accounts: (await jeremy.get("/api/accounts")).json as Account[],
    folders: (await jeremy.get("/api/account-folders")).json as AccountFolder[],
  });
  /** The names directly inside a folder (or the top of the budget section), in sidebar order. */
  const contents = async (parentId: number | null, section = "budget") => {
    const { accounts, folders } = await state();
    return [
      ...folders.filter((f) => f.section === section && f.parentId === parentId).map((f) => ({ kind: "folder" as const, ...f })),
      ...accounts
        .filter((a) => a.folderId === parentId && (section === "budget" ? a.onBudget : !a.onBudget))
        .map((a) => ({ kind: "account" as const, ...a })),
    ]
      .sort(compareSidebarItems)
      .map((x) => x.name);
  };
  return { app, db, jeremy, account, folder, move, state, contents };
}

describe("account folders", () => {
  test("accounts and folders can be arranged and nested", async () => {
    const { account, folder, move, contents } = await setUp();
    const checking = await account("Checking");
    const visa = await account("Visa", "credit");
    const amex = await account("Amex", "credit");
    const cards = await folder("Credit cards");
    expect(await contents(null)).toEqual(["Checking", "Visa", "Amex", "Credit cards"]);

    expect((await move({ kind: "account", id: visa.id }, cards)).status).toBe(200);
    expect((await move({ kind: "account", id: amex.id }, cards, { kind: "account", id: visa.id })).status).toBe(200);
    expect(await contents(cards)).toEqual(["Amex", "Visa"]);

    // A folder can sit between accounts, and folders nest.
    await move({ kind: "folder", id: cards }, null, { kind: "account", id: checking.id });
    expect(await contents(null)).toEqual(["Credit cards", "Checking"]);
    const old = await folder("Old cards", "budget", cards);
    await move({ kind: "account", id: visa.id }, old);
    expect(await contents(cards)).toEqual(["Amex", "Old cards"]);
    expect(await contents(old)).toEqual(["Visa"]);

    // New accounts land at the end of the section.
    await account("Cash", "cash");
    expect(await contents(null)).toEqual(["Credit cards", "Checking", "Cash"]);
  });

  test("a folder can't go inside itself or a folder it contains", async () => {
    const { folder, move } = await setUp();
    const outer = await folder("Outer");
    const inner = await folder("Inner", "budget", outer);
    expect((await move({ kind: "folder", id: outer }, outer)).status).toBe(400);
    expect((await move({ kind: "folder", id: outer }, inner)).status).toBe(400);
  });

  test("folders only hold their own section's accounts and folders", async () => {
    const { jeremy, account, folder, move } = await setUp();
    const brokerage = await account("Brokerage", "investment");
    const cards = await folder("Credit cards");
    const retirement = await folder("Retirement", "investment");
    expect((await move({ kind: "account", id: brokerage.id }, cards)).status).toBe(400);
    expect((await move({ kind: "folder", id: retirement }, cards)).status).toBe(400);
    expect((await jeremy.post("/api/account-folders", { name: "X", section: "budget", parentId: retirement })).status).toBe(400);
    expect((await jeremy.patch(`/api/accounts/${brokerage.id}`, { folderId: cards })).status).toBe(400);
    expect((await jeremy.patch(`/api/accounts/${brokerage.id}`, { folderId: retirement })).status).toBe(200);
  });

  test("moving an account to another section takes it out of its folder", async () => {
    const { jeremy, account, folder, state } = await setUp();
    const savings = await account("Savings", "savings");
    const banks = await folder("Banks");
    await jeremy.patch(`/api/accounts/${savings.id}`, { folderId: banks });
    expect((await state()).accounts[0]!.folderId).toBe(banks);

    // Renaming keeps it in place; moving off budget doesn't.
    await jeremy.patch(`/api/accounts/${savings.id}`, { name: "Rainy day" });
    expect((await state()).accounts[0]!.folderId).toBe(banks);
    await jeremy.patch(`/api/accounts/${savings.id}`, { onBudget: false });
    expect((await state()).accounts[0]!.folderId).toBeNull();
  });

  test("deleting a folder moves what was in it up to where it was", async () => {
    const { jeremy, account, folder, move, contents, state } = await setUp();
    const checking = await account("Checking");
    const banks = await folder("Banks");
    const inner = await folder("Inner", "budget", banks);
    const a = await account("A");
    const b = await account("B");
    await move({ kind: "account", id: a.id }, banks);
    await move({ kind: "account", id: b.id }, banks);
    await move({ kind: "folder", id: banks }, null, { kind: "account", id: checking.id });
    expect(await contents(banks)).toEqual(["Inner", "A", "B"]);

    expect((await jeremy.request("DELETE", `/api/account-folders/${banks}`)).status).toBe(200);
    expect(await contents(null)).toEqual(["Inner", "A", "B", "Checking"]);
    expect((await state()).folders.map((f) => [f.id, f.parentId])).toEqual([[inner, null]]);
    expect((await state()).accounts).toHaveLength(3);
  });

  test("rename and validation", async () => {
    const { jeremy, folder, state } = await setUp();
    const f = await folder("Banks");
    expect((await jeremy.patch(`/api/account-folders/${f}`, { name: "Everyday banking" })).status).toBe(200);
    expect((await state()).folders[0]!.name).toBe("Everyday banking");
    expect((await jeremy.patch(`/api/account-folders/${f}`, { name: " " })).status).toBe(400);
    expect((await jeremy.post("/api/account-folders", { name: "X", section: "elsewhere" })).status).toBe(400);
    expect((await jeremy.post("/api/account-folders", { name: "X", section: "budget", parentId: 9999 })).status).toBe(404);
  });

  test("another household can't see or change our folders", async () => {
    const { app, db, account, folder, move } = await setUp();
    const checking = await account("Checking");
    const banks = await folder("Banks");
    const other = createHousehold(db, "Neighbours");
    const user = db
      .insert(users)
      .values({ householdId: other.id, username: "n", displayName: "N", passwordHash: "x", role: "owner" })
      .returning()
      .get();
    const intruder = new Client(app);
    intruder.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;

    expect((await intruder.get("/api/account-folders")).json).toEqual([]);
    expect((await intruder.patch(`/api/account-folders/${banks}`, { name: "Mine" })).status).toBe(404);
    expect((await intruder.request("DELETE", `/api/account-folders/${banks}`)).status).toBe(404);
    expect((await intruder.post("/api/account-folders/move", { item: { kind: "account", id: checking.id }, parentId: null, before: null })).status).toBe(404);
    const theirs = (await intruder.post("/api/account-folders", { name: "Theirs", section: "budget" })).json.id as number;
    expect((await move({ kind: "account", id: checking.id }, theirs)).status).toBe(404);
  });
});
