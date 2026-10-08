import { Database } from "bun:sqlite";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type Db = ReturnType<typeof openDb>;

const migrationsFolder = join(import.meta.dir, "../../drizzle");

/**
 * Fail early, with a useful message, when the database folder or file isn't writable. SQLite's
 * own errors ("unable to open database file", "readonly database") don't say what to fix.
 */
function assertWritable(path: string) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  const help = `Make sure the user running the app (uid ${uid}) can write to it.`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    accessSync(dirname(path), constants.W_OK);
  } catch {
    throw new Error(`Can't write to the data folder ${dirname(path)}. ${help}`);
  }
  if (existsSync(path)) {
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`Can't write to the database file ${path}. ${help}`);
    }
  }
}

function migrationCount(sqlite: Database) {
  try {
    return sqlite.query<{ n: number }, []>("select count(*) as n from __drizzle_migrations").get()?.n ?? 0;
  } catch {
    return 0; // A new database: the migrations table doesn't exist yet.
  }
}

/**
 * Open (creating if needed) the SQLite database and apply pending migrations. Use ":memory:" for
 * tests. `onMigrated` gets the names of the migrations this call applied, if any.
 */
export function openDb(path: string, onMigrated?: (applied: string[]) => void) {
  if (path !== ":memory:") assertWritable(path);
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const db = drizzle({ client: sqlite, schema });
  const before = migrationCount(sqlite);
  migrate(db, { migrationsFolder });
  const after = migrationCount(sqlite);
  if (onMigrated && after > before) {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    onMigrated(journal.entries.slice(before, after).map((e) => e.tag));
  }
  return db;
}

/** Either the database or an open transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
