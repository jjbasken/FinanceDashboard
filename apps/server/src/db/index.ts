import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type Db = ReturnType<typeof openDb>;

const migrationsFolder = join(import.meta.dir, "../../drizzle");

/** Open (creating if needed) the SQLite database and apply pending migrations. Use ":memory:" for tests. */
export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder });
  return db;
}

/** Either the database or an open transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
