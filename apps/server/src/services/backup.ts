import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "../db";

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
