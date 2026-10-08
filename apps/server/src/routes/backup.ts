import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireAuth, requireOwner } from "../middleware";
import { listBackups, snapshotTo } from "../services/backup";
import { localDate } from "../util";

export const backupRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/status", (c) => {
    const dir = c.var.backupDir;
    const backups = dir ? listBackups(dir) : [];
    return c.json({ enabled: c.var.backupsEnabled, latest: backups[0] ?? null, count: backups.length });
  })

  /** Download a fresh copy of the whole database. It holds everything, so only the owner may. */
  .get("/download", requireOwner, async (c) => {
    const path = join(tmpdir(), `fd-backup-${randomUUID()}.db`);
    try {
      snapshotTo(c.var.db, path);
      const bytes = await Bun.file(path).arrayBuffer();
      return c.body(bytes, 200, {
        "content-type": "application/vnd.sqlite3",
        "content-disposition": `attachment; filename="finance-${localDate()}.db"`,
        "cache-control": "no-store",
      });
    } finally {
      await unlink(path).catch(() => {});
    }
  });
