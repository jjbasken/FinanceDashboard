import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { listBackups, runManualBackup, runNightlyBackup } from "../src/services/backup";
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
    expect(copy.query("select name from accounts where budget_only = 0").all()).toEqual([{ name: "Checking" }]);
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

describe("backing up from the command line", () => {
  function dataFolder() {
    const dir = tempDir();
    const db = openDb(join(dir, "finance.db"));
    db.$client.exec("create table marker (name text); insert into marker values ('Savings');");
    return dir;
  }

  test("copies the database with the date, time and label, apart from the nightly ones", () => {
    const dir = dataFolder();
    const backups = join(dir, "backups");
    const when = new Date(2026, 9, 18, 9, 5, 7);
    const path = runManualBackup(join(dir, "finance.db"), backups, "Before update from a75926e", when);
    expect(path).toBe(join(backups, "finance-2026-10-18-090507-before-update-from-a75926e.db"));
    const copy = new Database(path, { readonly: true });
    expect(copy.query("select name from marker").all()).toEqual([{ name: "Savings" }]);
    copy.close();
    // Nightly pruning and the Settings card only count nightly copies.
    expect(listBackups(backups)).toEqual([]);
    runNightlyBackup(openDb(join(dir, "finance.db")), backups, "2026-10-19", 1);
    runNightlyBackup(openDb(join(dir, "finance.db")), backups, "2026-10-20", 1);
    expect(existsSync(path)).toBe(true);

    expect(() => runManualBackup(join(dir, "finance.db"), backups, "Before update from a75926e", when)).toThrow(
      /already exists/,
    );
    expect(runManualBackup(join(dir, "finance.db"), backups, "", when)).toEndWith("finance-2026-10-18-090507.db");
  });

  test("removes an incomplete copy when the database is locked", () => {
    const dir = tempDir();
    const backups = join(dir, "backups");
    const locker = new Database(join(dir, "finance.db"));
    locker.exec("CREATE TABLE marker (name TEXT); BEGIN EXCLUSIVE;");
    try {
      expect(() => runManualBackup(join(dir, "finance.db"), backups)).toThrow();
      expect(readdirSync(backups)).toEqual([]);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  }, 10000);

  test("refuses a missing database instead of creating an empty one", () => {
    const dir = tempDir();
    expect(() => runManualBackup(join(dir, "finance.db"), join(dir, "backups"))).toThrow(/No database/);
    expect(existsSync(join(dir, "finance.db"))).toBe(false);
  });

  test("the backup command prints where the copy went", () => {
    const dir = dataFolder();
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "backup", "manual"], {
      env: { ...process.env, DATA_DIR: dir },
    });
    expect(result.exitCode).toBe(0);
    const [name] = readdirSync(join(dir, "backups"));
    expect(name).toMatch(/^finance-\d{4}-\d{2}-\d{2}-\d{6}-manual\.db$/);
    expect(result.stdout.toString()).toContain(join(dir, "backups", name!));
  });
});

describe("docker/update.sh", () => {
  // Fake docker and git: record what the script asks for without touching a real container.
  function update(opts: {
    running?: boolean; hasBackupCommand?: boolean; backupFails?: boolean; database?: boolean;
    sameImage?: boolean; prepareFails?: boolean; env?: Record<string, string>;
  } = {}) {
    const dir = tempDir();
    const log = join(dir, "calls");
    writeFileSync(log, "");
    const docker = `
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  "compose config --images finance") echo ghcr.io/jjbasken/financedashboard:latest ;;
  "compose pull finance"|"compose build finance") exit "$MOCK_PREPARE_EXIT" ;;
  "compose up -d --no-build finance") ;;
  "image inspect -f {{.Id}} "*) echo new-image ;;
  "image inspect -f {{range .Config.Env}}{{println .}}{{end}} "*) echo GIT_COMMIT=b1c2d3e ;;
  "inspect -f {{.Image}} family-finance")
    [ "$MOCK_SAME_IMAGE" = 1 ] && echo new-image || echo old-image ;;
  "inspect -f {{.State.Running}} family-finance")
    [ "$MOCK_RUNNING" = 1 ] && echo true || exit 1 ;;
  "exec "*)
    case "$*" in
      *printenv*) echo a75926e ;;
      *grep*) [ "$MOCK_HAS_BACKUP" = 1 ] ;;
      *bun*) exit "$MOCK_BACKUP_EXIT" ;;
    esac ;;
  *) echo "Unexpected docker command: $*" >&2; exit 64 ;;
esac`;
    writeFileSync(join(dir, "docker"), `#!/bin/sh${docker}\n`);
    writeFileSync(join(dir, "git"), "#!/bin/sh\necho b1c2d3e\n");
    for (const name of ["docker", "git"]) chmodSync(join(dir, name), 0o755);
    const script = join(dir, "update.sh");
    writeFileSync(script, readFileSync(join(import.meta.dir, "../../../docker/update.sh")));
    if (opts.database) {
      mkdirSync(join(dir, "data"));
      writeFileSync(join(dir, "data/finance.db"), "existing database");
    }
    const result = Bun.spawnSync(["/bin/sh", script], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`, MOCK_LOG: log,
        MOCK_RUNNING: opts.running === false ? "0" : "1",
        MOCK_HAS_BACKUP: opts.hasBackupCommand === false ? "0" : "1",
        MOCK_BACKUP_EXIT: opts.backupFails ? "1" : "0",
        MOCK_SAME_IMAGE: opts.sameImage ? "1" : "0",
        MOCK_PREPARE_EXIT: opts.prepareFails ? "1" : "0",
        ...opts.env,
      },
    });
    return { exitCode: result.exitCode, calls: readFileSync(log, "utf8").trim().split("\n") };
  }

  test("pulls the image, backs up with the old version's name, then restarts", () => {
    const { exitCode, calls } = update();
    expect(exitCode).toBe(0);
    const backup = calls.findIndex((c) => c.includes("cli.ts backup before-update-from-a75926e"));
    const pull = calls.indexOf("compose pull finance");
    const restart = calls.indexOf("compose up -d --no-build finance");
    expect(backup).toBeGreaterThan(-1);
    expect(calls[backup]).toStartWith("exec -u bun family-finance");
    expect(pull).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(pull);
    expect(restart).toBeGreaterThan(backup);
  });

  test("does not restart when the backup fails", () => {
    const { exitCode, calls } = update({ backupFails: true });
    expect(exitCode).not.toBe(0);
    expect(calls).toContain("compose pull finance");
    expect(calls.some((c) => c.startsWith("compose up"))).toBe(false);
  });

  test("BUILD=1 builds the checkout before backup and restart", () => {
    const { exitCode, calls } = update({ env: { BUILD: "1" } });
    expect(exitCode).toBe(0);
    expect(calls[0]).toBe("compose build finance");
    expect(calls).not.toContain("compose pull finance");
    const backup = calls.findIndex((c) => c.includes("cli.ts backup before-update-from-a75926e"));
    expect(backup).toBeGreaterThan(0);
    expect(calls.indexOf("compose up -d --no-build finance")).toBeGreaterThan(backup);
  });

  test("failed image preparation stops before backup or restart in either mode", () => {
    for (const env of [{}, { BUILD: "1" }]) {
      const { exitCode, calls } = update({ prepareFails: true, env });
      expect(exitCode).not.toBe(0);
      expect(calls.some((c) => c.startsWith("exec"))).toBe(false);
      expect(calls.some((c) => c.startsWith("compose up"))).toBe(false);
    }
  });

  test("an already-current running container needs no backup or restart", () => {
    const { exitCode, calls } = update({ sameImage: true });
    expect(exitCode).toBe(0);
    expect(calls).toContain("compose pull finance");
    expect(calls.some((c) => c.startsWith("exec"))).toBe(false);
    expect(calls.some((c) => c.startsWith("compose up"))).toBe(false);
  });

  test("a stopped container on the same image still requires a backup for existing data", () => {
    const { exitCode, calls } = update({ sameImage: true, running: false, database: true });
    expect(exitCode).not.toBe(0);
    expect(calls.some((c) => c.startsWith("compose up"))).toBe(false);
  });

  test("a failed backup also prevents restart after a local build", () => {
    const { exitCode, calls } = update({ backupFails: true, env: { BUILD: "1" } });
    expect(exitCode).not.toBe(0);
    expect(calls[0]).toBe("compose build finance");
    expect(calls.some((c) => c.startsWith("compose up"))).toBe(false);
  });

  test("backs up a version from before the backup command directly", () => {
    const { exitCode, calls } = update({ hasBackupCommand: false });
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.includes("cli.ts backup"))).toBe(false);
    const log = calls.join("\n");
    expect(log).toContain("exec -u bun -e LABEL=before-update-from-a75926e family-finance bun -e");
    expect(log).toContain("VACUUM INTO");
  });

  test("the legacy fallback produces a usable SQLite copy", () => {
    const dir = tempDir();
    const source = new Database(join(dir, "finance.db"));
    source.exec("CREATE TABLE marker (name TEXT); INSERT INTO marker VALUES ('Savings');");
    source.close();
    const script = readFileSync(join(import.meta.dir, "../../../docker/update.sh"), "utf8");
    const inline = script.match(/bun -e '\n([\s\S]*?)\n    '/)![1]!;
    const result = Bun.spawnSync(["bun", "-e", inline], {
      env: { ...process.env, DATA_DIR: dir, LABEL: "before-update-from-legacy" },
    });
    expect(result.exitCode).toBe(0);
    const [name] = readdirSync(join(dir, "backups"));
    const copy = new Database(join(dir, "backups", name!), { readonly: true });
    expect(copy.query("SELECT name FROM marker").all()).toEqual([{ name: "Savings" }]);
    copy.close();
  });

  test("a stopped app with an existing database blocks the update", () => {
    const { exitCode, calls } = update({ running: false, database: true });
    expect(exitCode).not.toBe(0);
    expect(calls).toContain("compose pull finance");
    expect(calls.some((c) => c.startsWith("compose up"))).toBe(false);
  });

  test("a fresh installation without a database can start", () => {
    const { exitCode, calls } = update({ running: false });
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.startsWith("compose up"))).toBe(true);
  });

  test("SKIP_BACKUP=1 pulls and restarts without a backup", () => {
    const { exitCode, calls } = update({ env: { SKIP_BACKUP: "1" } });
    expect(exitCode).toBe(0);
    expect(calls).toContain("compose pull finance");
    expect(calls.at(-1)).toBe("compose up -d --no-build finance");
    expect(calls.some((c) => c.startsWith("exec"))).toBe(false);
  });
});
