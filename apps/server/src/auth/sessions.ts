import type { Household, PublicUser } from "@fd/shared";
import { and, eq, lt, ne } from "drizzle-orm";
import type { Db } from "../db";
import { households, sessions, users } from "../db/schema";
import { hashToken, newToken } from "./tokens";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Extend a session once less than this much time remains. */
const RENEW_THRESHOLD_MS = 15 * DAY_MS;

export interface SessionContext {
  user: PublicUser;
  household: Household;
  sessionId: string;
}

export function createSession(db: Db, userId: number, now = Date.now()) {
  const token = newToken();
  const expiresAt = now + SESSION_TTL_MS;
  db.insert(sessions)
    .values({ id: hashToken(token), userId, expiresAt })
    .run();
  return { token, expiresAt };
}

/** Look up the session for a cookie token, renewing it when it is past half-life. */
export function validateSession(db: Db, token: string, now = Date.now()) {
  const id = hashToken(token);
  const row = db
    .select({
      expiresAt: sessions.expiresAt,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      householdId: households.id,
      householdName: households.name,
      currency: households.currency,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(households, eq(households.id, users.householdId))
    .where(eq(sessions.id, id))
    .get();

  if (!row) return null;
  if (row.expiresAt <= now || row.disabledAt) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }

  let expiresAt = row.expiresAt;
  if (expiresAt - now < RENEW_THRESHOLD_MS) {
    expiresAt = now + SESSION_TTL_MS;
    db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
  }

  const ctx: SessionContext = {
    sessionId: id,
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    },
    household: { id: row.householdId, name: row.householdName, currency: row.currency },
  };
  return { ctx, expiresAt, renewed: expiresAt !== row.expiresAt };
}

export function deleteSession(db: Db, sessionId: string) {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** Sign a user out everywhere, or everywhere except one session. Returns how many were ended. */
export function deleteUserSessions(db: Db, userId: number, exceptSessionId?: string) {
  const where = exceptSessionId
    ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
    : eq(sessions.userId, userId);
  return db.delete(sessions).where(where).returning({ id: sessions.id }).all().length;
}

export function purgeExpiredSessions(db: Db, now = Date.now()) {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
