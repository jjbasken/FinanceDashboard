import { describe, expect, test } from "bun:test";
import type { HouseholdMember } from "@fd/shared";
import { Client, owner, testApp } from "./helpers";

const SAM = { displayName: "Sam", username: "sam", password: "another good password" };

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  await jeremy.post("/api/auth/setup", owner);
  const invite = await jeremy.post("/api/household/invites");
  const sam = new Client(app);
  await sam.post("/api/auth/accept-invite", { token: invite.json.token, ...SAM });
  const members = async () => (await jeremy.get("/api/household/users")).json as HouseholdMember[];
  const samId = (await members()).find((m) => m.username === "sam")!.id;
  return { app, db, jeremy, sam, samId, members };
}

async function signIn(app: ReturnType<typeof testApp>["app"], username: string, password: string) {
  const c = new Client(app);
  const res = await c.post("/api/auth/login", { username, password });
  return { c, res };
}

describe("your own account", () => {
  test("changing your password keeps this session and signs out the others", async () => {
    const { app, jeremy } = await setUp();
    const { c: laptop } = await signIn(app, "jeremy", owner.password);

    expect(
      (await jeremy.post("/api/auth/password", { currentPassword: "wrong one!!", newPassword: "x".repeat(12) })).status,
    ).toBe(400);
    expect(
      (await jeremy.post("/api/auth/password", { currentPassword: owner.password, newPassword: "short" })).status,
    ).toBe(400);
    const res = await jeremy.post("/api/auth/password", {
      currentPassword: owner.password,
      newPassword: "a brand new passphrase",
    });
    expect(res.json).toEqual({ ok: true, signedOut: 1 });

    expect((await jeremy.get("/api/accounts")).status).toBe(200);
    expect((await laptop.get("/api/accounts")).status).toBe(401);
    expect((await signIn(app, "jeremy", owner.password)).res.status).toBe(401);
    expect((await signIn(app, "jeremy", "a brand new passphrase")).res.status).toBe(200);
  });

  test("sign out other sessions", async () => {
    const { app, jeremy } = await setUp();
    const { c: phone } = await signIn(app, "jeremy", owner.password);
    const { c: tablet } = await signIn(app, "jeremy", owner.password);
    expect((await jeremy.post("/api/auth/sign-out-others")).json).toEqual({ ok: true, signedOut: 2 });
    expect((await phone.get("/api/accounts")).status).toBe(401);
    expect((await tablet.get("/api/accounts")).status).toBe(401);
    expect((await jeremy.get("/api/accounts")).status).toBe(200);
  });
});

describe("the owner managing members", () => {
  test("can set a member's password, which signs them out", async () => {
    const { app, jeremy, sam, samId } = await setUp();
    expect(
      (await jeremy.post(`/api/household/users/${samId}/password`, { newPassword: "temporary password 1" })).status,
    ).toBe(200);
    expect((await sam.get("/api/accounts")).status).toBe(401);
    expect((await signIn(app, "sam", "temporary password 1")).res.status).toBe(200);
  });

  test("can remove and restore a member; removed members can't sign in but stay in the list", async () => {
    const { app, jeremy, sam, samId, members } = await setUp();
    expect((await jeremy.post(`/api/household/users/${samId}/disable`)).status).toBe(200);
    expect((await sam.get("/api/accounts")).status).toBe(401);
    const blocked = await signIn(app, "sam", SAM.password);
    expect(blocked.res.status).toBe(403);
    expect(blocked.res.json.error).toContain("removed");
    // A wrong password still gets the usual answer, so removal isn't revealed to guessers.
    expect((await signIn(app, "sam", "not the password")).res.status).toBe(401);
    expect((await members()).find((m) => m.id === samId)).toMatchObject({ disabled: true, displayName: "Sam" });

    await jeremy.post(`/api/household/users/${samId}/enable`);
    expect((await signIn(app, "sam", SAM.password)).res.status).toBe(200);
  });

  test("only the owner, and not on themselves", async () => {
    const { jeremy, sam, samId, members } = await setUp();
    const ownerId = (await members()).find((m) => m.role === "owner")!.id;
    expect((await sam.post(`/api/household/users/${ownerId}/disable`)).status).toBe(403);
    expect((await sam.post(`/api/household/users/${ownerId}/password`, { newPassword: "x".repeat(12) })).status).toBe(
      403,
    );
    expect((await jeremy.post(`/api/household/users/${ownerId}/disable`)).status).toBe(400);
    expect((await jeremy.post(`/api/household/users/9999/disable`)).status).toBe(404);
    void samId;
  });

  test("household currency", async () => {
    const { jeremy, sam } = await setUp();
    expect((await sam.patch("/api/household", { currency: "EUR" })).status).toBe(403);
    expect((await jeremy.patch("/api/household", { currency: "XYZ" })).status).toBe(400);
    expect((await jeremy.patch("/api/household", { currency: "EUR" })).status).toBe(200);
    expect((await sam.get("/api/auth/status")).json.household).toMatchObject({ currency: "EUR" });
  });
});

describe("login rate limiting", () => {
  test("is per client: one client's guessing doesn't lock out another", async () => {
    const { app } = testApp({ trustProxy: true });
    await new Client(app).post("/api/auth/setup", owner);
    const attempt = (ip: string, password: string) =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.9, ${ip}` },
        body: JSON.stringify({ username: "jeremy", password }),
      });
    for (let i = 0; i < 10; i++) await attempt("203.0.113.5", "wrong password");
    expect((await attempt("203.0.113.5", owner.password)).status).toBe(429);
    expect((await attempt("198.51.100.7", owner.password)).status).toBe(200);
  });

  test("caps guesses per client across usernames", async () => {
    const { app } = testApp({ trustProxy: true });
    await new Client(app).post("/api/auth/setup", owner);
    const attempt = (username: string, password: string) =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" },
        body: JSON.stringify({ username, password }),
      });
    for (let i = 0; i < 30; i++) await attempt(`user${i}`, "wrong password");
    expect((await attempt("jeremy", owner.password)).status).toBe(429);
  });

  test("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const { app } = testApp();
    await new Client(app).post("/api/auth/setup", owner);
    const attempt = (ip: string, password: string) =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ username: "jeremy", password }),
      });
    for (let i = 0; i < 10; i++) await attempt(`10.0.0.${i}`, "wrong password");
    // A forged header can't dodge the limit.
    expect((await attempt("10.9.9.9", owner.password)).status).toBe(429);
  });
});
