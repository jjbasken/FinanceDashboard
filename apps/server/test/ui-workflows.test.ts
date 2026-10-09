import { describe, expect, test } from "bun:test";
import { Client, owner, testApp } from "./helpers";
import { createHousehold } from "../src/services/household";
import { users } from "../src/db/schema";
import { createSession } from "../src/auth/sessions";
import { SESSION_COOKIE } from "../src/middleware";
import { localDate } from "../src/util";

async function fixture() {
  const { app, db } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const invitation = await c.post("/api/household/invites");
  const partner = new Client(app);
  await partner.post("/api/auth/accept-invite", { token: invitation.json.token, username: "partner", displayName: "Partner", password: "partner password" });
  const date = localDate(); const month = date.slice(0, 7);
  const account = (client: Client, body: unknown) => client.post("/api/accounts", body).then(r => r.json);
  const checking = await account(c, { name: "Checking", type: "checking" });
  const groups = (await c.get("/api/categories")).json;
  const category = groups.flatMap((g: any) => g.categories).find((x: any) => x.name === "Groceries").id;
  const transaction = (client: Client, body: Record<string, unknown>) => client.post("/api/transactions", { date, ...body }).then(r => { expect(r.status).toBe(201); return r.json; });
  return { app, db, c, partner, date, month, checking, account, category, transaction };
}

describe("everyday UI workflows", () => {
  test("review agrees with the budget and does not expose private purchases", async () => {
    const { c, partner, month, checking, account, transaction, category } = await fixture();
    const privateCard = await account(partner, { name: "Secret card name", type: "credit", private: true });
    const shared = await transaction(c, { accountId: checking.id, amount: -1000, payeeName: "Shared shop" });
    await transaction(partner, { accountId: privateCard.id, amount: -2000, payeeName: "Secret purchase" });
    const included = await transaction(partner, { accountId: privateCard.id, amount: -3000, payeeName: "Family shop", inBudget: true });
    const rows = (await c.get(`/api/budget/${month}/uncategorized`)).json;
    expect(rows).toHaveLength((await c.get(`/api/budget/${month}`)).json.uncategorized);
    expect(rows).toHaveLength(2);
    expect(rows.find((r: any) => r.id === included.id)).toMatchObject({ accountName: "Private account", privateAccount: true, payeeName: "Family shop" });
    expect(JSON.stringify(rows)).not.toContain("Secret");
    expect((await c.patch(`/api/transactions/${included.id}`, { categoryId: category })).status).toBe(404);
    await c.patch(`/api/transactions/${shared.id}`, { categoryId: category });
    expect((await c.get(`/api/budget/${month}/uncategorized`)).json).toHaveLength(1);
    expect((await partner.get(`/api/budget/${month}/uncategorized`)).json[0].privateAccount).toBe(false);
  });

  test("review identifies uncategorized split lines and excludes internal transfers", async () => {
    const { c, month, checking, account, transaction, category } = await fixture();
    const savings = await account(c, { name: "Savings", type: "savings" });
    await transaction(c, { accountId: checking.id, amount: -1000, payeeId: savings.transferPayeeId });
    const split = await transaction(c, { accountId: checking.id, amount: -2000, splits: [{ amount: -500, categoryId: category }, { amount: -1500, categoryId: null }] });
    const rows = (await c.get(`/api/budget/${month}/uncategorized`)).json;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transactionId: split.id, amount: -1500 });
    const full = (await c.get(`/api/transactions/${rows[0].transactionId}`)).json;
    await c.patch(`/api/transactions/${full.id}`, { amount: full.amount, splits: full.splits.map((s: any) => ({ amount: s.amount, categoryId: category, notes: s.notes, transferAccountId: s.transferAccountId })) });
    expect((await c.get(`/api/budget/${month}/uncategorized`)).json).toHaveLength(0);
  });

  test("review requires authentication and is scoped to the current household", async () => {
    const { app, db, c, month, checking, transaction } = await fixture();
    await transaction(c, { accountId: checking.id, amount: -1000, payeeName: "First household" });
    expect((await new Client(app).get(`/api/budget/${month}/uncategorized`)).status).toBe(401);
    expect((await c.get("/api/budget/2026-99/uncategorized")).status).toBe(404);
    // A separate household in the same database is never included.
    const household = createHousehold(db, "Other household");
    const user = db.insert(users).values({ householdId: household.id, username: "other", displayName: "Other", passwordHash: "unused", role: "owner" }).returning().get();
    const other = new Client(app);
    other.cookie = `${SESSION_COOKIE}=${createSession(db, user.id).token}`;
    expect((await other.get(`/api/budget/${month}/uncategorized`)).json).toEqual([]);
    expect((await other.get("/api/scheduled-bills/payments")).json).toEqual([]);
    expect((await c.get("/api/budget/2025-01/uncategorized")).json).toEqual([]);
  });

  test("confirming a bill updates the posted entry without adding a duplicate", async () => {
    const { c, date, checking, category } = await fixture();
    const bill = await c.post("/api/scheduled-bills", { accountId: checking.id, amount: -12300, payeeName: "Electric company", categoryId: category, frequency: "monthly", startDate: date });
    expect(bill.status).toBe(201);
    const before = (await c.get(`/api/accounts/${checking.id}/transactions`)).json;
    const rows = (await c.get("/api/scheduled-bills/payments")).json;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scheduledBillId: bill.json.id, date, cleared: false });
    expect((await c.patch(`/api/transactions/${rows[0].id}`, { cleared: true })).status).toBe(200);
    const after = (await c.get(`/api/accounts/${checking.id}/transactions`)).json;
    expect(after).toHaveLength(before.length);
    expect((await c.get("/api/scheduled-bills/payments")).json[0].cleared).toBe(true);
  });

  test("new review and bill lists conceal a partner's private transfer destination", async () => {
    const { c, partner, date, month, checking, account, transaction } = await fixture();
    const privateAccount = await account(partner, { name: "Secret destination", type: "checking", private: true, onBudget: false });
    await transaction(partner, { accountId: checking.id, amount: -5000, payeeId: privateAccount.transferPayeeId });
    expect((await partner.post("/api/scheduled-bills", { accountId: checking.id, amount: -7500, payeeId: privateAccount.transferPayeeId, frequency: "monthly", startDate: date })).status).toBe(201);
    const review = (await c.get(`/api/budget/${month}/uncategorized`)).json;
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((r: any) => r.payeeName === "Transfer: Private account")).toBe(true);
    const payments = (await c.get("/api/scheduled-bills/payments")).json;
    expect(payments).toHaveLength(1);
    expect(payments[0].payeeName).toBe("Transfer: Private account");
    expect(JSON.stringify({ review, payments })).not.toContain("Secret destination");
    expect((await partner.get("/api/scheduled-bills/payments")).json[0].payeeName).toContain("Secret destination");
  });

  test("private bill entries are visible only to the account owner", async () => {
    const { c, partner, date, account, category } = await fixture();
    const privateAccount = await account(partner, { name: "Private bills", type: "checking", private: true });
    expect((await partner.post("/api/scheduled-bills", { accountId: privateAccount.id, amount: -7500, payeeName: "Private subscription", categoryId: category, frequency: "monthly", startDate: date })).status).toBe(201);
    expect((await c.get("/api/scheduled-bills/payments")).json).toEqual([]);
    expect((await partner.get("/api/scheduled-bills/payments")).json).toHaveLength(1);
  });
});
