import { describe, expect, test } from "bun:test";
import type { Account, CategoryGroup, ScheduledBill, Transaction } from "@fd/shared";
import { planBankImport } from "../src/importers/bank/plan";
import { createScheduledBill, postScheduledBills, updateScheduledBill } from "../src/services/scheduled-bills";
import { localDate } from "../src/util";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const me = (await c.get("/api/auth/status")).json;
  const actor = { householdId: me.household.id as number, userId: me.user.id as number };
  const account = async (body: Record<string, unknown>) => (await c.post("/api/accounts", body)).json as Account;
  const checking = await account({ name: "Checking", type: "checking" });
  const groups = (await c.get("/api/categories")).json as CategoryGroup[];
  const category = groups.flatMap((g) => g.categories).find((x) => !groups.find((g) => g.id === x.groupId)!.isIncome)!;
  const register = async (accountId = checking.id) =>
    ((await c.get(`/api/accounts/${accountId}/transactions`)).json as Transaction[]).map((t) => ({
      date: t.date,
      amount: t.amount,
      cleared: t.cleared,
      scheduledBillId: t.scheduledBillId,
    }));
  const rent = { accountId: checking.id, amount: -150000, payeeName: "Landlord", categoryId: category.id };
  return { app, db, c, actor, account, checking, category, register, rent };
}

describe("recurring bills", () => {
  test("adding a bill posts the rest of this month right away", async () => {
    const { db, actor, register, rent } = await setUp();
    const id = createScheduledBill(db, actor, { ...rent, frequency: "biweekly", startDate: "2026-10-09" }, "2026-10-08");
    expect(await register()).toEqual([
      { date: "2026-10-23", amount: -150000, cleared: false, scheduledBillId: id },
      { date: "2026-10-09", amount: -150000, cleared: false, scheduledBillId: id },
    ]);
  });

  test("a bill starting next month waits for the 1st, and posts each month exactly once", async () => {
    const { db, actor, register, rent } = await setUp();
    createScheduledBill(db, actor, { ...rent, frequency: "monthly", startDate: "2026-11-01" }, "2026-10-08");
    expect(await register()).toEqual([]);

    expect(postScheduledBills(db, "2026-10-31").size).toBe(0);
    expect(await register()).toEqual([]);
    expect([...postScheduledBills(db, "2026-11-01")]).toEqual([actor.householdId]);
    expect(postScheduledBills(db, "2026-11-01").size).toBe(0);
    expect(postScheduledBills(db, "2026-11-20").size).toBe(0);
    expect((await register()).map((t) => t.date)).toEqual(["2026-11-01"]);
  });

  test("months missed while the server was down are caught up", async () => {
    const { db, actor, register, rent } = await setUp();
    createScheduledBill(db, actor, { ...rent, frequency: "monthly", startDate: "2026-10-31" }, "2026-10-08");
    postScheduledBills(db, "2027-01-02");
    expect((await register()).map((t) => t.date)).toEqual(["2027-01-31", "2026-12-31", "2026-11-30", "2026-10-31"]);
  });

  test("paused bills don't post, and resuming skips the paused months", async () => {
    const { db, actor, register, rent } = await setUp();
    const id = createScheduledBill(db, actor, { ...rent, frequency: "monthly", startDate: "2026-10-05" }, "2026-10-01");
    updateScheduledBill(db, actor, id, { paused: true }, "2026-10-02");
    postScheduledBills(db, "2026-11-01");
    postScheduledBills(db, "2026-12-01");
    updateScheduledBill(db, actor, id, { paused: false }, "2026-12-10");
    postScheduledBills(db, "2027-01-01");
    // October was posted before pausing; November, and December's (already past) 5th, are skipped.
    expect((await register()).map((t) => t.date)).toEqual(["2027-01-05", "2026-10-05"]);
  });

  test("editing a bill doesn't repost a month that's already posted", async () => {
    const { db, actor, register, rent } = await setUp();
    const id = createScheduledBill(db, actor, { ...rent, frequency: "monthly", startDate: "2026-10-20" }, "2026-10-08");
    updateScheduledBill(db, actor, id, { startDate: "2026-10-25", amount: -160000 }, "2026-10-09");
    postScheduledBills(db, "2026-11-01");
    expect((await register()).map((t) => [t.date, t.amount])).toEqual([
      ["2026-11-25", -160000],
      ["2026-10-20", -150000],
    ]);
  });

  test("a transfer payee posts both sides", async () => {
    const { db, actor, account, register, checking } = await setUp();
    const card = await account({ name: "Visa", type: "credit" });
    createScheduledBill(
      db,
      actor,
      { accountId: checking.id, amount: -20000, payeeId: card.transferPayeeId, frequency: "monthly", startDate: "2026-10-12" },
      "2026-10-08",
    );
    expect((await register()).map((t) => t.amount)).toEqual([-20000]);
    expect((await register(card.id)).map((t) => t.amount)).toEqual([20000]);
  });

  test("a posted bill is matched by a bank import instead of duplicated", async () => {
    const { db, actor, rent, checking } = await setUp();
    createScheduledBill(db, actor, { ...rent, frequency: "monthly", startDate: "2026-10-20" }, "2026-10-08");
    const plan = planBankImport(db, actor.householdId, checking, [
      { externalId: "1", date: "2026-10-21", amount: -150000, payee: "LANDLORD LLC", notes: "" },
    ]);
    expect(plan.items[0]!.status).toBe("match");
  });

  test("the API lists, updates and deletes bills, and posted rows outlive the bill", async () => {
    const { c, register, rent } = await setUp();
    const today = localDate();
    const created = await c.post("/api/scheduled-bills", { ...rent, frequency: "monthly", startDate: today });
    expect(created.status).toBe(201);
    const bill = created.json as ScheduledBill;
    expect(bill.nextDue).toBe(today);
    expect((await register()).map((t) => t.date)).toEqual([today]);

    expect((await c.patch(`/api/scheduled-bills/${bill.id}`, { notes: "Apartment" })).json.notes).toBe("Apartment");
    expect(((await c.get("/api/scheduled-bills")).json as ScheduledBill[]).map((b) => b.id)).toEqual([bill.id]);
    expect((await c.post("/api/scheduled-bills", { ...rent, frequency: "monthly", startDate: today, endDate: "2000-01-01" })).status).toBe(400);

    expect((await c.delete(`/api/scheduled-bills/${bill.id}`)).status).toBe(200);
    expect((await c.get("/api/scheduled-bills")).json).toEqual([]);
    expect(await register()).toEqual([{ date: today, amount: -150000, cleared: false, scheduledBillId: null }]);
  });

  test("bills on a private account are only visible to its owner", async () => {
    const { c, app } = await setUp();
    const invite = await c.post("/api/household/invites");
    const sam = new Client(app);
    await sam.post("/api/auth/accept-invite", {
      token: invite.json.token,
      displayName: "Sam",
      username: "sam",
      password: "another good password",
    });
    const card = (await sam.post("/api/accounts", { name: "Sam's Visa", type: "credit", private: true })).json as Account;
    const res = await sam.post("/api/scheduled-bills", { accountId: card.id, amount: -999, frequency: "monthly", startDate: "2030-01-01" });
    expect(res.status).toBe(201);
    expect((await sam.get("/api/scheduled-bills")).json).toHaveLength(1);
    expect((await c.get("/api/scheduled-bills")).json).toEqual([]);
    expect((await c.patch(`/api/scheduled-bills/${res.json.id}`, { amount: -1 })).status).toBe(404);
    expect((await c.post("/api/scheduled-bills", { accountId: card.id, amount: -1, frequency: "monthly", startDate: "2030-01-01" })).status).toBe(404);
  });
});
