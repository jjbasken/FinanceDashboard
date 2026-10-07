import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake only privileged commands: exercise the real startup script without changing host ownership.
function startup(opts: { uid?: string; owner?: string; chownFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fd-entrypoint-"));
  const log = join(dir, "calls");
  const scripts = {
    id: 'if [ "$2" = "bun" ]; then echo 1000; else echo "$MOCK_UID"; fi',
    stat: 'echo "$MOCK_OWNER"',
    chown: 'printf "chown %s\\n" "$*" >> "$MOCK_LOG"; exit "$MOCK_CHOWN_EXIT"',
    setpriv: 'printf "setpriv %s\\n" "$*" >> "$MOCK_LOG"; while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  };
  try {
    writeFileSync(log, "");
    writeFileSync(join(dir, "finance.db"), "");
    for (const [name, source] of Object.entries(scripts)) {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\n${source}\n`);
      chmodSync(file, 0o755);
    }
    const result = Bun.spawnSync(["/bin/sh", join(import.meta.dir, "../../../docker/entrypoint.sh"), "/bin/sh", "-c", "echo app-started"], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`, DATA_DIR: dir, MOCK_LOG: log,
        MOCK_UID: opts.uid ?? "0", MOCK_OWNER: opts.owner ?? "0", MOCK_CHOWN_EXIT: opts.chownFails ? "1" : "0",
      },
    });
    return { exitCode: result.exitCode, output: result.stdout.toString(), calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Docker startup fixes a root-owned bind mount then drops privileges", () => {
  const result = startup();
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContain("chown -R bun:bun");
  expect(result.calls).toContain("setpriv --reuid=bun --regid=bun --init-groups --");
  expect(result.output).toContain("app-started");
});

test("Docker startup repairs restored database ownership even with a writable parent", () => {
  const result = startup({ owner: "1000" });
  expect(result.exitCode).toBe(0);
  expect(result.calls).not.toContain("chown -R");
  expect(result.calls).toContain("finance.db");
});

test("Docker startup stops on ownership failure rather than launching an unwritable database", () => {
  const result = startup({ chownFails: true });
  expect(result.exitCode).toBe(1);
  expect(result.calls).not.toContain("setpriv");
  expect(result.output).not.toContain("app-started");
});

test("Docker startup respects an explicitly configured non-root user", () => {
  const result = startup({ uid: "1000" });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toBe("");
  expect(result.output).toContain("app-started");
});
