import { describe, expect, spyOn, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { LoginRateLimiter } from "../src/auth/rate-limit";
import { PasswordWorkLimiter } from "../src/auth/password-work";
import { Client, owner, testApp } from "./helpers";

test("closed setup and invalid, expired, or used invites do no password hashing", async () => {
  const { app, db } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const used = (await c.post("/api/household/invites")).json.token;
  await new Client(app).post("/api/auth/accept-invite", { ...owner, username: "partner", token: used });
  const expired = (await c.post("/api/household/invites")).json.token;
  db.$client.exec("UPDATE invites SET expires_at = 0 WHERE used_by IS NULL");
  const hash = spyOn(Bun.password, "hash");
  try {
    expect((await c.post("/api/auth/setup", owner)).status).toBe(409);
    for (const token of ["invalid", expired, used]) {
      expect((await c.post("/api/auth/accept-invite", { ...owner, username: "another", token })).status).toBe(404);
    }
    expect(hash).not.toHaveBeenCalled();
  } finally {
    hash.mockRestore();
  }
});

test("only one concurrent login can enter verification after nine failures", async () => {
  const { app } = testApp();
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  const input = { username: owner.username, password: "wrong password" };
  for (let i = 0; i < 9; i++) expect((await c.post("/api/auth/login", input)).status).toBe(401);
  const responses = await Promise.all(Array.from({ length: 3 }, () => new Client(app).post("/api/auth/login", input)));
  expect(responses.map((r) => r.status).sort()).toEqual([401, 429, 429]);
});

describe("login reservations", () => {
  test("counts requests across usernames for a client and keeps other clients independent", () => {
    const limiter = new LoginRateLimiter(1, 2);
    const a = limiter.start("client-a", "first")!;
    expect(limiter.start("client-a", "first")).toBeNull();
    const b = limiter.start("client-a", "second")!;
    expect(limiter.start("client-a", "third")).toBeNull();
    const other = limiter.start("client-b", "first")!;
    other(null);
    a(null);
    b(null);
    expect(limiter.isBlocked("client-a", "first")).toBe(false);
  });

  test("success does not discard concurrent reservations and completion is idempotent", () => {
    const limiter = new LoginRateLimiter(2, 30);
    const a = limiter.start("client", "user")!;
    const b = limiter.start("client", "user")!;
    a(true);
    a(false);
    b(false);
    expect(limiter.isBlocked("client", "user")).toBe(false);
    const next = limiter.start("client", "user")!;
    expect(limiter.start("client", "user")).toBeNull();
    next(null);
  });
});

describe("password work limit", () => {
  test("rejects excess concurrency and releases capacity after completion", async () => {
    const limiter = new PasswordWorkLimiter(1, 10);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = limiter.run(() => pending);
    const blocked = await limiter.run(async () => 2).catch((err) => err);
    expect(blocked).toBeInstanceOf(HTTPException);
    expect(blocked.status).toBe(429);
    release();
    await first;
    expect(await limiter.run(async () => 3)).toBe(3);
  });

  test("releases capacity after errors and throttles repeated starts", async () => {
    const limiter = new PasswordWorkLimiter(1, 2);
    await expect(limiter.run(async () => { throw new Error("verification failed"); })).rejects.toThrow("verification failed");
    expect(await limiter.run(async () => true)).toBe(true);
    const blocked = await limiter.run(async () => true).catch((err) => err);
    expect(blocked.status).toBe(429);
  });

  test("accepts requests again after the rate window expires", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(0);
    try {
      const limiter = new PasswordWorkLimiter(1, 1, 1000);
      await limiter.run(async () => true);
      clock.mockReturnValue(1000);
      expect(await limiter.run(async () => true)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
