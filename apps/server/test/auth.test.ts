import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sessions } from "../src/db/schema";
import { hashToken } from "../src/auth/tokens";
import { Client, owner, testApp } from "./helpers";

async function setUp() {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  const res = await jeremy.post("/api/auth/setup", owner);
  expect(res.status).toBe(201);
  return { app, db, jeremy };
}

test("responses carry security headers", async () => {
  const { app } = testApp();
  const res = await app.request("/api/health");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  // No HSTS, and none of the headers browsers ignore on plain HTTP, unless served over HTTPS.
  expect(res.headers.get("strict-transport-security")).toBeNull();
  expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
});

describe("first-run setup", () => {
  test("reports needsSetup until an owner exists", async () => {
    const { app } = testApp();
    const c = new Client(app);
    expect((await c.get("/api/auth/status")).json).toEqual({ needsSetup: true, user: null, household: null });

    await c.post("/api/auth/setup", owner);
    const status = (await c.get("/api/auth/status")).json;
    expect(status.needsSetup).toBe(false);
    expect(status.user).toMatchObject({ username: "jeremy", displayName: "Jeremy", role: "owner" });
    expect(status.household).toMatchObject({ name: "The Baskens" });
  });

  test("can only run once", async () => {
    const { app } = await setUp();
    const res = await new Client(app).post("/api/auth/setup", { ...owner, username: "intruder" });
    expect(res.status).toBe(409);
  });

  test("validates input", async () => {
    const { app } = testApp();
    const res = await new Client(app).post("/api/auth/setup", { ...owner, password: "four" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("password");
  });

  test("session cookie is httpOnly and SameSite=Lax", async () => {
    const { app } = testApp();
    const res = await new Client(app).post("/api/auth/setup", owner);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("login and logout", () => {
  test("logs in with correct credentials, case-insensitive username", async () => {
    const { app } = await setUp();
    const c = new Client(app);
    const res = await c.post("/api/auth/login", { username: "JEREMY", password: owner.password });
    expect(res.status).toBe(200);
    expect((await c.get("/api/auth/status")).json.user.username).toBe("jeremy");
  });

  test("rejects a wrong password and an unknown user with the same message", async () => {
    const { app } = await setUp();
    const c = new Client(app);
    const wrong = await c.post("/api/auth/login", { username: "jeremy", password: "nope nope nope" });
    const unknown = await c.post("/api/auth/login", { username: "nobody", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error).toBe(unknown.json.error);
  });

  test("locks out after repeated failures", async () => {
    const { app } = await setUp();
    const c = new Client(app);
    for (let i = 0; i < 10; i++) await c.post("/api/auth/login", { username: "jeremy", password: "wrong password" });
    const res = await c.post("/api/auth/login", { username: "jeremy", password: owner.password });
    expect(res.status).toBe(429);
  });

  test("logout invalidates the session server-side", async () => {
    const { app, jeremy } = await setUp();
    const stolen = jeremy.cookie;
    await jeremy.post("/api/auth/logout");
    const replay = new Client(app);
    replay.cookie = stolen;
    expect((await replay.get("/api/household/users")).status).toBe(401);
  });

  test("expired sessions are rejected", async () => {
    const { db, jeremy } = await setUp();
    const token = jeremy.cookie!.split("=")[1]!;
    db.update(sessions)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(sessions.id, hashToken(token)))
      .run();
    expect((await jeremy.get("/api/household/users")).status).toBe(401);
  });
});

describe("protected routes", () => {
  test("require a session", async () => {
    const { app } = await setUp();
    const anon = new Client(app);
    expect((await anon.get("/api/household/users")).status).toBe(401);
    expect((await anon.post("/api/household/invites")).status).toBe(401);
  });

  test("mutations require a JSON content type (CSRF defence)", async () => {
    const { app, jeremy } = await setUp();
    const res = await app.request("/api/household/invites", {
      method: "POST",
      headers: { cookie: jeremy.cookie!, "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(res.status).toBe(415);
  });
});

describe("invites", () => {
  test("owner invites a second user who then shares the household", async () => {
    const { app, jeremy } = await setUp();
    const invite = await jeremy.post("/api/household/invites");
    expect(invite.status).toBe(201);

    const spouse = new Client(app);
    const check = await spouse.get(`/api/auth/invites/${invite.json.token}`);
    expect(check.json).toEqual({ householdName: "The Baskens" });

    const accepted = await spouse.post("/api/auth/accept-invite", {
      token: invite.json.token,
      displayName: "Partner",
      username: "partner",
      password: "another long password",
    });
    expect(accepted.status).toBe(201);

    const status = (await spouse.get("/api/auth/status")).json;
    expect(status.user).toMatchObject({ username: "partner", role: "member" });
    expect(status.household.name).toBe("The Baskens");

    const fromJeremy = (await jeremy.get("/api/household/users")).json;
    const fromSpouse = (await spouse.get("/api/household/users")).json;
    expect(fromJeremy).toEqual(fromSpouse);
    expect(fromJeremy.map((u: { username: string }) => u.username)).toEqual(["jeremy", "partner"]);
  });

  test("an invite can only be used once", async () => {
    const { app, jeremy } = await setUp();
    const { token } = (await jeremy.post("/api/household/invites")).json;
    const body = { token, displayName: "A", username: "first", password: "long enough password" };
    expect((await new Client(app).post("/api/auth/accept-invite", body)).status).toBe(201);
    const again = await new Client(app).post("/api/auth/accept-invite", { ...body, username: "second" });
    expect(again.status).toBe(404);
  });

  test("taken usernames are rejected without consuming the invite", async () => {
    const { app, jeremy } = await setUp();
    const { token } = (await jeremy.post("/api/household/invites")).json;
    const c = new Client(app);
    const dup = await c.post("/api/auth/accept-invite", {
      token,
      displayName: "X",
      username: "jeremy",
      password: "long enough password",
    });
    expect(dup.status).toBe(409);
    const ok = await c.post("/api/auth/accept-invite", {
      token,
      displayName: "X",
      username: "partner",
      password: "long enough password",
    });
    expect(ok.status).toBe(201);
  });

  test("members cannot create invites", async () => {
    const { app, jeremy } = await setUp();
    const { token } = (await jeremy.post("/api/household/invites")).json;
    const spouse = new Client(app);
    await spouse.post("/api/auth/accept-invite", {
      token,
      displayName: "Partner",
      username: "partner",
      password: "another long password",
    });
    expect((await spouse.post("/api/household/invites")).status).toBe(403);
  });
});

test("passwords need at least 5 characters", async () => {
  const { app } = testApp();
  const c = new Client(app);
  expect((await c.post("/api/auth/setup", { ...owner, password: "abcd" })).status).toBe(400);
  expect((await c.post("/api/auth/setup", { ...owner, password: "abcde" })).status).toBe(201);
  expect((await new Client(app).post("/api/auth/login", { username: "jeremy", password: "abcde" })).status).toBe(200);
});
