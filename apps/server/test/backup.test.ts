import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBackups, runNightlyBackup } from "../src/services/backup";
import { Client, owner, testApp } from "./helpers";

const tempDir = () => mkdtempSync(join(tmpdir(), "fd-backup-test-"));

async function setUp() {
  const dir = tempDir();
  const { app, db } = testApp({ backupDir: dir });
  const jeremy = new Client(app);
  await jeremy.post("/api/auth/setup", owner);
  await jeremy.post("/api/accounts", { name: "Checking", type: "checking", startingBalance: 12345 });
  return { app, db, dir, jeremy };
}

describe("nightly backups", () => {
  test("make one copy per day, readable on its own, and prune old ones", async () => {
    const { db, dir } = await setUp();
    const first = runNightlyBackup(db, dir, "2026-10-01");
    expect(first).toEqual({ name: "finance-2026-10-01.db", created: true, removed: [] });
    expect(runNightlyBackup(db, dir, "2026-10-01").created).toBe(false);

    const copy = new Database(join(dir, first.name), { readonly: true });
    expect(copy.query("select name from accounts").all()).toEqual([{ name: "Checking" }]);
    copy.close();

    // Unrelated files in the folder are left alone.
    writeFileSync(join(dir, "notes.txt"), "keep me");
    for (const day of ["02", "03", "04"]) runNightlyBackup(db, dir, `2026-10-${day}`, 3);
    expect(listBackups(dir).map((b) => b.date)).toEqual(["2026-10-04", "2026-10-03", "2026-10-02"]);
  });

  test("status reports the latest backup", async () => {
    const { db, dir, jeremy } = await setUp();
    expect((await jeremy.get("/api/backup/status")).json).toEqual({ enabled: true, latest: null, count: 0 });
    runNightlyBackup(db, dir, "2026-10-05");
    const status = (await jeremy.get("/api/backup/status")).json;
    expect(status).toMatchObject({
      enabled: true,
      count: 1,
      latest: { name: "finance-2026-10-05.db", date: "2026-10-05" },
    });
    expect(status.latest.size).toBeGreaterThan(0);
  });
});

describe("downloading a backup", () => {
  test("gives the owner a complete SQLite copy", async () => {
    const { app, jeremy, dir } = await setUp();
    const res = await app.request("/api/backup/download", { headers: { cookie: jeremy.cookie! } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="finance-\d{4}-\d{2}-\d{2}\.db"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3");
    const path = join(dir, "downloaded.db");
    writeFileSync(path, bytes);
    const copy = new Database(path, { readonly: true });
    expect(copy.query("select sum(amount) as total from transactions").get()).toEqual({ total: 12345 });
    copy.close();
  });

  test("is limited to the owner", async () => {
    const { app, jeremy } = await setUp();
    const invite = await jeremy.post("/api/household/invites");
    const sam = new Client(app);
    await sam.post("/api/auth/accept-invite", {
      token: invite.json.token,
      displayName: "Sam",
      username: "sam",
      password: "another good password",
    });
    expect((await sam.get("/api/backup/download")).status).toBe(403);
    expect((await new Client(app).get("/api/backup/download")).status).toBe(401);
  });
});

test("disabled nightly backups still list existing copies and allow manual downloads", async () => {
  const dir = tempDir();
  const { app, db } = testApp({ backupDir: dir, backupsEnabled: false });
  const c = new Client(app);
  await c.post("/api/auth/setup", owner);
  runNightlyBackup(db, dir, "2026-10-05");
  expect((await c.get("/api/backup/status")).json).toMatchObject({
    enabled: false, count: 1, latest: { date: "2026-10-05" },
  });
  expect((await app.request("/api/backup/download", { headers: { cookie: c.cookie! } })).status).toBe(200);
});
