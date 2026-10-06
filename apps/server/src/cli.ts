/**
 * Maintenance commands, run on the server.
 *
 *   bun apps/server/src/cli.ts reset-password <username>
 *     Set a new random password for a user (the owner too) and sign them out everywhere.
 *     With Docker: docker exec -u bun family-finance bun apps/server/src/cli.ts reset-password jeremy
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { deleteUserSessions } from "./auth/sessions";
import { newToken } from "./auth/tokens";
import { dataDir } from "./config";
import { openDb } from "./db";
import { users } from "./db/schema";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, username] = process.argv.slice(2);
if (command !== "reset-password" || !username) {
  fail("Usage: bun apps/server/src/cli.ts reset-password <username>");
}

// Running as root against the app's folder could leave root-owned SQLite files the app can't write.
let owner: number | null = null;
try {
  owner = statSync(dataDir).uid;
} catch {
  // A missing folder is reported by openDb.
}
if (typeof process.getuid === "function" && process.getuid() === 0 && owner !== null && owner !== 0) {
  fail(`Run this as the app's user, not root (with Docker: docker exec -u bun ...).`);
}

const db = openDb(join(dataDir, "finance.db"));
const user = db.select().from(users).where(eq(users.username, username.trim().toLowerCase())).get();
if (!user) fail(`No user named "${username}".`);

const password = newToken(12);
db.update(users)
  .set({ passwordHash: await Bun.password.hash(password), disabledAt: null })
  .where(eq(users.id, user.id))
  .run();
const ended = deleteUserSessions(db, user.id);
console.log(`New password for ${user.username}: ${password}`);
console.log(
  `Signed out of ${ended} session${ended === 1 ? "" : "s"}. Change it after signing in (Settings → Your account).`,
);
