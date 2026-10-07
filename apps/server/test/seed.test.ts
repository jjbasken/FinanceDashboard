import { describe, expect, test } from "bun:test";
import { users } from "../src/db/schema";
import { seedOwnerFromEnv } from "../src/seed";
import { Client, owner, testApp } from "./helpers";

const env = {
  SEED_HOUSEHOLD_NAME: "The Baskens",
  SEED_OWNER_USERNAME: "Jeremy",
  SEED_OWNER_PASSWORD: "correct horse battery",
};

describe("seedOwnerFromEnv", () => {
  test("does nothing when no SEED_* variables are set", async () => {
    const { db } = testApp();
    expect(await seedOwnerFromEnv(db, {})).toEqual({ status: "not-configured" });
    expect(db.select().from(users).all()).toHaveLength(0);
  });

  test("creates the owner on an empty database, closing first-run setup", async () => {
    const { db, app } = testApp();
    expect(await seedOwnerFromEnv(db, env)).toEqual({ status: "created", username: "jeremy" });

    const c = new Client(app);
    const status = (await c.get("/api/auth/status")).json;
    expect(status.needsSetup).toBe(false);
    expect((await c.post("/api/auth/setup", owner)).status).toBe(409);

    const login = await c.post("/api/auth/login", { username: "jeremy", password: env.SEED_OWNER_PASSWORD });
    expect(login.status).toBe(200);
    const me = (await c.get("/api/auth/status")).json;
    expect(me.user).toMatchObject({ username: "jeremy", displayName: "Jeremy", role: "owner" });
    expect(me.household.name).toBe("The Baskens");
  });

  test("display name defaults to the username but can be set", async () => {
    const { db } = testApp();
    await seedOwnerFromEnv(db, { ...env, SEED_OWNER_DISPLAY_NAME: "Jeremy B" });
    expect(db.select().from(users).get()?.displayName).toBe("Jeremy B");
  });

  test("is skipped once any user exists", async () => {
    const { db } = testApp();
    await seedOwnerFromEnv(db, env);
    const again = await seedOwnerFromEnv(db, { ...env, SEED_OWNER_USERNAME: "someone" });
    expect(again.status).toBe("skipped");
    expect(db.select().from(users).all()).toHaveLength(1);
  });

  test("ignores removed or invalid seed configuration after first boot", async () => {
    const { db } = testApp();
    await seedOwnerFromEnv(db, env);
    for (const remaining of [
      {},
      { SEED_HOUSEHOLD_NAME: env.SEED_HOUSEHOLD_NAME, SEED_OWNER_USERNAME: env.SEED_OWNER_USERNAME },
      { ...env, SEED_OWNER_PASSWORD: "four" },
    ]) {
      expect((await seedOwnerFromEnv(db, remaining)).status).toBe("skipped");
    }
    expect(db.select().from(users).all()).toHaveLength(1);
  });

  test("rejects partial configuration", async () => {
    const { db } = testApp();
    await expect(seedOwnerFromEnv(db, { SEED_OWNER_USERNAME: "jeremy" })).rejects.toThrow(/together/);
  });

  test("rejects invalid values", async () => {
    const { db } = testApp();
    await expect(seedOwnerFromEnv(db, { ...env, SEED_OWNER_PASSWORD: "four" })).rejects.toThrow(/password/);
    await expect(seedOwnerFromEnv(db, { ...env, SEED_OWNER_USERNAME: "bad name!" })).rejects.toThrow(/username/);
  });
});
