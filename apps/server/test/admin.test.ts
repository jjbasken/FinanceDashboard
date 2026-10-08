import { describe, expect, test } from "bun:test";
import type { Account, AuditEntry, BankUpload, LogEntry, Page, Transaction } from "@fd/shared";
import { appLog, auditLog } from "../src/db/schema";
import { createLogger, pruneLogs } from "../src/services/log";
import { postScheduledBills } from "../src/services/scheduled-bills";
import { Client, fakePrices, owner, testApp } from "./helpers";

/** The owner (Jeremy) and a member (Sam), with a shared checking account. */
async function setUp() {
  const prices = fakePrices({});
  const { app, db } = testApp({ priceProvider: prices.provider });
  const jeremy = new Client(app);
  await jeremy.post("/api/auth/setup", owner);
  const invite = await jeremy.post("/api/household/invites");
  const sam = new Client(app);
  await sam.post("/api/auth/accept-invite", {
    token: invite.json.token,
    displayName: "Sam",
    username: "sam",
    password: "another good password",
  });
  const checking = (await jeremy.post("/api/accounts", { name: "Checking", type: "checking" })).json as Account;
  const audit = async (query = "") => ((await jeremy.get(`/api/admin/audit${query}`)).json as Page<AuditEntry>).items;
  const logs = async (query = "") => ((await jeremy.get(`/api/admin/logs${query}`)).json as Page<LogEntry>).items;
  return { app, db, jeremy, sam, checking, audit, logs };
}

describe("activity and logs", () => {
  test("only the owner can see them", async () => {
    const { jeremy, sam } = await setUp();
    expect((await sam.get("/api/admin/audit")).status).toBe(403);
    expect((await sam.get("/api/admin/logs")).status).toBe(403);
    expect((await jeremy.get("/api/admin/audit")).status).toBe(200);
    expect((await jeremy.get("/api/admin/logs")).status).toBe(200);
  });

  test("adding, changing and deleting a transaction records who, what and the values", async () => {
    const { sam, checking, audit } = await setUp();
    const t = (
      await sam.post("/api/transactions", {
        accountId: checking.id,
        date: "2026-10-05",
        amount: -4250,
        payeeName: "Grocer",
      })
    ).json as Transaction;
    await sam.patch(`/api/transactions/${t.id}`, { amount: -5000 });
    await sam.delete(`/api/transactions/${t.id}`);

    const [deleted, changed, added] = await audit("?entity=transaction");
    expect(added).toMatchObject({
      userName: "Sam",
      action: "create",
      entityId: t.id,
      summary: "Added transaction: Grocer -$42.50 on 10/05/2026 in Checking",
      private: false,
    });
    expect((added!.details!.after as Record<string, unknown>).amount).toBe(-4250);
    expect(changed).toMatchObject({ action: "update", summary: "Changed transaction: Grocer -$50.00 on 10/05/2026 in Checking (amount)" });
    expect(changed!.details!.changes).toEqual({ amount: { from: -4250, to: -5000 } });
    expect(deleted).toMatchObject({ action: "delete", summary: "Deleted transaction: Grocer -$50.00 on 10/05/2026 in Checking" });
    expect((deleted!.details!.before as Record<string, unknown>).amount).toBe(-5000);
  });

  test("another member's private account shows only who and when", async () => {
    const { jeremy, sam, audit } = await setUp();
    const card = (await sam.post("/api/accounts", { name: "Sam's Visa", type: "credit", private: true })).json as Account;
    await sam.post("/api/transactions", { accountId: card.id, date: "2026-10-05", amount: -8000, payeeName: "Jeweler" });
    const mine = (await jeremy.post("/api/accounts", { name: "My Card", type: "credit", private: true })).json as Account;
    await jeremy.post("/api/transactions", { accountId: mine.id, date: "2026-10-05", amount: -100, payeeName: "Cafe" });

    const entries = await audit();
    const samTxn = entries.find((e) => e.entity === "transaction" && e.userName === "Sam")!;
    expect(samTxn).toMatchObject({ private: true, details: null, summary: "Added a transaction in a private account" });
    expect(JSON.stringify(entries)).not.toContain("Jeweler");
    expect(JSON.stringify(entries)).not.toContain("Sam's Visa");
    // The owner's own private account keeps its details.
    const mineTxn = entries.find((e) => e.entity === "transaction" && e.userName === "Jeremy")!;
    expect(mineTxn).toMatchObject({ private: false, summary: "Added transaction: Cafe -$1.00 on 10/05/2026 in My Card" });
  });

  test("passwords are never stored", async () => {
    const { db, jeremy, sam } = await setUp();
    const members = (await jeremy.get("/api/household/users")).json as { id: number; username: string }[];
    const samId = members.find((m) => m.username === "sam")!.id;
    await jeremy.post(`/api/household/users/${samId}/password`, { newPassword: "a brand new password" });
    await sam.post("/api/auth/password", { currentPassword: "x", newPassword: "y" });
    const stored = JSON.stringify([db.select().from(auditLog).all(), db.select().from(appLog).all()]);
    expect(stored).not.toContain("a brand new password");
    expect(stored).not.toContain("correct horse battery");
    expect(stored).not.toContain("passwordHash");
  });

  test("sign-ins are logged with the username and address", async () => {
    const { app, logs } = await setUp();
    const stranger = new Client(app);
    await stranger.post("/api/auth/login", { username: "sam", password: "wrong password" });
    await stranger.post("/api/auth/login", { username: "sam", password: "another good password" });
    const auth = await logs("?source=auth");
    expect(auth[1]).toMatchObject({ level: "warn", message: "Failed sign-in for sam" });
    expect(auth[1]!.details).toMatchObject({ username: "sam", reason: "wrong password", ip: "unknown" });
    expect(auth[0]).toMatchObject({ level: "info", message: "sam signed in" });
  });

  test("recurring bill payments are recorded as the app's own activity", async () => {
    const { db, jeremy, checking, audit, logs } = await setUp();
    await jeremy.post("/api/scheduled-bills", {
      accountId: checking.id,
      amount: -150000,
      payeeName: "Landlord",
      frequency: "monthly",
      startDate: "2099-01-20",
    });
    postScheduledBills(db, "2099-01-01", createLogger(db));
    const [posted] = await audit("?entity=transaction");
    expect(posted).toMatchObject({
      userId: null,
      userName: null,
      summary: "Recurring bill added transaction: Landlord -$1,500.00 on 01/20/2099 in Checking",
    });
    expect((await logs("?source=bills"))[0]).toMatchObject({ level: "info", message: "Posted 1 payment for 1 recurring bill" });
  });

  test("a price refresh logs symbols it couldn't price", async () => {
    const { jeremy, logs } = await setUp();
    await jeremy.post("/api/investments/securities", { symbol: "EPIC", name: "Epic Systems", type: "stock" });
    await jeremy.post("/api/investments/prices/refresh");
    expect((await logs("?level=warn&source=prices"))[0]).toMatchObject({
      message: "EPIC: Unknown symbol EPIC. Switched it to manual prices",
    });
  });

  test("unhandled errors are logged", async () => {
    const { app } = testApp();
    app.get("/api/boom", () => {
      throw new Error("kaboom");
    });
    const c = new Client(app);
    await c.post("/api/auth/setup", owner);
    expect((await c.get("/api/boom")).status).toBe(500);
    const [entry] = ((await c.get("/api/admin/logs?level=error")).json as Page<LogEntry>).items;
    expect(entry).toMatchObject({ source: "http", message: "GET /api/boom failed: kaboom" });
    expect(entry!.details).toMatchObject({ user: "jeremy" });
    expect((entry!.details as { stack: string }).stack).toContain("kaboom");
  });

  test("imports and undos are recorded and logged", async () => {
    const { jeremy, checking, audit, logs } = await setUp();
    const csv = "Date,Payee,Amount\n2026-10-01,Coffee,-4.50\n";
    const up = (await jeremy.upload(`/api/import/bank?accountId=${checking.id}&name=card.csv`, new TextEncoder().encode(csv)))
      .json as BankUpload;
    const commit = await jeremy.post(`/api/import/bank/${up.uploadId}/commit`, { csv: up.csv!.suggested, include: [0] });
    expect(commit.status).toBe(201);
    await jeremy.post(`/api/import/batches/${commit.json.batchId}/undo`);

    expect((await audit("?entity=import")).map((e) => e.summary)).toEqual([
      "Undid the import of card.csv (csv)",
      "Imported card.csv (csv)",
    ]);
    expect((await logs("?source=import")).map((l) => l.message)).toEqual([
      `Undid import #${commit.json.batchId}`,
      "Imported card.csv: 1 new, 0 matched to existing transactions",
    ]);
  });

  test("logs older than 90 days are pruned; activity is kept", async () => {
    const { db, logs, audit } = await setUp();
    const log = createLogger(db);
    log.info("server", "old news");
    db.update(appLog).set({ at: "2026-01-01T00:00:00.000Z" }).run();
    log.info("server", "fresh");
    const activity = (await audit()).length;
    expect(pruneLogs(db, new Date("2026-10-08T12:00:00Z"))).toBeGreaterThan(0);
    expect((await logs()).map((l) => l.message)).toEqual(["fresh"]);
    expect((await audit()).length).toBe(activity);
  });

  test("filters and paging", async () => {
    const { sam, jeremy, checking, audit } = await setUp();
    for (const amount of [-100, -200, -300]) {
      await sam.post("/api/transactions", { accountId: checking.id, date: "2026-10-05", amount, payeeName: "Shop" });
    }
    const samId = ((await jeremy.get("/api/household/users")).json as { id: number; username: string }[]).find(
      (m) => m.username === "sam",
    )!.id;
    const first = (await jeremy.get(`/api/admin/audit?userId=${samId}&limit=2`)).json as Page<AuditEntry>;
    expect(first.items.map((e) => e.summary)).toEqual([
      "Added transaction: Shop -$3.00 on 10/05/2026 in Checking",
      "Added transaction: Shop -$2.00 on 10/05/2026 in Checking",
    ]);
    const rest = (await jeremy.get(`/api/admin/audit?userId=${samId}&limit=2&before=${first.next}`)).json as Page<AuditEntry>;
    expect(rest.items.map((e) => e.summary)).toEqual(["Added transaction: Shop -$1.00 on 10/05/2026 in Checking"]);
    expect(rest.next).toBeNull();
    expect((await audit("?q=-$2.00")).length).toBe(1);
    expect((await audit("?entity=account")).map((e) => e.summary)).toEqual(["Added account: Checking"]);
    expect((await jeremy.get("/api/admin/audit?limit=999")).status).toBe(400);
  });
});
