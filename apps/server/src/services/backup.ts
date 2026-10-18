import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { localDate } from "../util";

const PATTERN = /^finance-(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupInfo {
  name: string;
  date: string;
  size: number;
}

/**
 * Write a consistent copy of the database with VACUUM INTO. It's safe while the app is running
 * and produces a compact, standalone SQLite file. The target must not exist yet.
 */
export function snapshotTo(db: Db, path: string) {
  db.run(sql`VACUUM INTO ${path}`);
}

export function listBackups(dir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, match: PATTERN.exec(name) }))
    .filter((x): x is { name: string; match: RegExpExecArray } => x.match !== null)
    .map(({ name, match }) => ({ name, date: match[1]!, size: statSync(join(dir, name)).size }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Make today's nightly backup if it doesn't exist yet, then keep only the newest `keep`. */
export function runNightlyBackup(db: Db, dir: string, today: string, keep = 14) {
  mkdirSync(dir, { recursive: true });
  const name = `finance-${today}.db`;
  let created = false;
  if (!listBackups(dir).some((b) => b.name === name)) {
    snapshotTo(db, join(dir, name));
    created = true;
  }
  const removed: string[] = [];
  for (const old of listBackups(dir).slice(Math.max(keep, 1))) {
    unlinkSync(join(dir, old.name));
    removed.push(old.name);
  }
  return { name, created, removed };
}

/**
 * Make a one-off copy of the database file at `dbPath` (from the command line, e.g. before an
 * update), named with the date, time and an optional label. It opens the file directly, without
 * running migrations, so the copy is exactly what's there. These copies are never pruned.
 */
export function runManualBackup(dbPath: string, dir: string, label = "", now = new Date()) {
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}.`);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `finance-${localDate(now)}-${time}${slug ? `-${slug}` : ""}.db`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (existsSync(path)) throw new Error(`${path} already exists.`);
  const sqlite = new Database(dbPath, { readwrite: true });
  try {
    // Reserve the destination without overwriting a concurrent backup.
    closeSync(openSync(path, "wx"));
    try {
      sqlite.exec("PRAGMA busy_timeout = 5000;");
      sqlite.run("VACUUM INTO ?", [path]);
    } catch (err) {
      // A failed VACUUM can leave an empty or incomplete database.
      unlinkSync(path);
      throw err;
    }
  } finally {
    sqlite.close();
  }
  return path;
}
