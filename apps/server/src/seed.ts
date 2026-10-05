import { setupInput } from "@fd/shared";
import { count } from "drizzle-orm";
import type { Db } from "./db";
import { households, users } from "./db/schema";

export type SeedResult =
  | { status: "not-configured" }
  | { status: "skipped"; reason: string }
  | { status: "created"; username: string };

/**
 * Create the household owner from SEED_* environment variables when the database
 * has no users yet, so the first-run setup page never appears. Invalid or partial
 * config throws, so a typo fails loudly at startup instead of leaving setup open.
 */
export async function seedOwnerFromEnv(db: Db, env: Record<string, string | undefined>): Promise<SeedResult> {
  const raw = {
    householdName: env.SEED_HOUSEHOLD_NAME,
    displayName: env.SEED_OWNER_DISPLAY_NAME || env.SEED_OWNER_USERNAME,
    username: env.SEED_OWNER_USERNAME,
    password: env.SEED_OWNER_PASSWORD,
  };
  const provided = [raw.householdName, raw.username, raw.password].filter(Boolean).length;
  if (provided === 0) return { status: "not-configured" };
  if (provided < 3) {
    throw new Error(
      "Seeding needs SEED_HOUSEHOLD_NAME, SEED_OWNER_USERNAME and SEED_OWNER_PASSWORD together (or none of them).",
    );
  }

  const parsed = setupInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid SEED_* configuration: ${issue?.path.join(".")}: ${issue?.message}`);
  }
  const input = parsed.data;

  const [existing] = db.select({ n: count() }).from(users).all();
  if ((existing?.n ?? 0) > 0) return { status: "skipped", reason: "database already has users" };

  const passwordHash = await Bun.password.hash(input.password);
  return db.transaction((tx) => {
    // Re-check inside the transaction in case setup ran concurrently.
    const [row] = tx.select({ n: count() }).from(users).all();
    if ((row?.n ?? 0) > 0) return { status: "skipped", reason: "database already has users" } as const;
    const household = tx.insert(households).values({ name: input.householdName }).returning().get();
    tx.insert(users)
      .values({
        householdId: household.id,
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        role: "owner",
      })
      .run();
    return { status: "created", username: input.username } as const;
  });
}
