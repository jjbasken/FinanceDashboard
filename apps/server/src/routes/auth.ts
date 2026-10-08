import { acceptInviteInput, changePasswordInput, loginInput, setupInput, type AuthStatus } from "@fd/shared";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { households, invites, users } from "../db/schema";
import { createSession, deleteSession, deleteUserSessions } from "../auth/sessions";
import { hashToken } from "../auth/tokens";
import { createHousehold } from "../services/household";
import { clearSessionCookie, clientAddress, parseBody, requireAuth, sessionOf, setSessionCookie } from "../middleware";

let dummyHash: Promise<string> | null = null;
/** Verify against a throwaway hash so unknown usernames take as long as wrong passwords. */
function burnTime(password: string) {
  dummyHash ??= Bun.password.hash("not-a-real-password");
  return dummyHash.then((h) => Bun.password.verify(password, h));
}

function isUniqueViolation(err: unknown) {
  return err instanceof Error && /UNIQUE constraint failed: users\.username/.test(String(err.message ?? err));
}

export const authRoutes = new Hono<AppEnv>()
  .get("/status", (c) => {
    const [row] = c.var.db.select({ n: count() }).from(users).all();
    const s = c.var.session;
    const status: AuthStatus = {
      needsSetup: (row?.n ?? 0) === 0,
      user: s?.user ?? null,
      household: s?.household ?? null,
    };
    return c.json(status);
  })

  .post("/setup", async (c) => {
    const input = await parseBody(c, setupInput);
    const db = c.var.db;
    const [existing] = db.select({ n: count() }).from(users).all();
    if ((existing?.n ?? 0) > 0) throw new HTTPException(409, { message: "Setup has already been completed" });
    const passwordHash = await c.var.passwordWork.run(() => Bun.password.hash(input.password));

    const userId = db.transaction((tx) => {
      const [row] = tx.select({ n: count() }).from(users).all();
      if ((row?.n ?? 0) > 0) throw new HTTPException(409, { message: "Setup has already been completed" });
      const household = createHousehold(tx, input.householdName);
      return tx
        .insert(users)
        .values({
          householdId: household.id,
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          role: "owner",
        })
        .returning({ id: users.id })
        .get().id;
    });

    const { token, expiresAt } = createSession(db, userId);
    setSessionCookie(c, token, expiresAt);
    return c.json({ ok: true }, 201);
  })

  .post("/login", async (c) => {
    const input = await parseBody(c, loginInput);
    const limiter = c.var.loginLimiter;
    const client = clientAddress(c);
    const finish = limiter.start(client, input.username);
    if (!finish) {
      throw new HTTPException(429, { message: "Too many failed attempts. Try again in a few minutes." });
    }

    try {
      const user = c.var.db.select().from(users).where(eq(users.username, input.username)).get();
      const ok = await c.var.passwordWork.run(() =>
        user ? Bun.password.verify(input.password, user.passwordHash) : burnTime(input.password),
      );
      if (!user || !ok) {
        finish(false);
        throw new HTTPException(401, { message: "Incorrect username or password" });
      }

      if (user.disabledAt) {
        // They knew the password, so saying why doesn't reveal anything new.
        throw new HTTPException(403, { message: "This account has been removed from the household" });
      }
      finish(true);
      const { token, expiresAt } = createSession(c.var.db, user.id);
      setSessionCookie(c, token, expiresAt);
      return c.json({ ok: true });
    } finally {
      // Release reservations after throttling or unexpected verification failures, too.
      finish(null);
    }
  })

  /** Change your own password. Your other sessions are signed out; this one stays. */
  .post("/password", requireAuth, async (c) => {
    const input = await parseBody(c, changePasswordInput);
    const { user, sessionId } = sessionOf(c);
    const row = c.var.db.select().from(users).where(eq(users.id, user.id)).get()!;
    const passwordHash = await c.var.passwordWork.run(async () => {
      if (!(await Bun.password.verify(input.currentPassword, row.passwordHash))) {
        throw new HTTPException(400, { message: "Your current password is incorrect" });
      }
      return Bun.password.hash(input.newPassword);
    });
    c.var.db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
    const signedOut = deleteUserSessions(c.var.db, user.id, sessionId);
    return c.json({ ok: true, signedOut });
  })

  .post("/sign-out-others", requireAuth, (c) => {
    const { user, sessionId } = sessionOf(c);
    return c.json({ ok: true, signedOut: deleteUserSessions(c.var.db, user.id, sessionId) });
  })

  .post("/logout", (c) => {
    const s = c.var.session;
    if (s) deleteSession(c.var.db, s.sessionId);
    clearSessionCookie(c);
    return c.json({ ok: true });
  })

  .get("/invites/:token", (c) => {
    const row = c.var.db
      .select({ householdName: households.name })
      .from(invites)
      .innerJoin(households, eq(households.id, invites.householdId))
      .where(
        and(eq(invites.id, hashToken(c.req.param("token"))), isNull(invites.usedBy), gt(invites.expiresAt, Date.now())),
      )
      .get();
    if (!row) throw new HTTPException(404, { message: "This invite link is invalid or has expired" });
    return c.json({ householdName: row.householdName });
  })

  .post("/accept-invite", async (c) => {
    const input = await parseBody(c, acceptInviteInput);
    const db = c.var.db;
    const inviteId = hashToken(input.token);
    const available = db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.id, inviteId), isNull(invites.usedBy), gt(invites.expiresAt, Date.now())))
      .get();
    if (!available) throw new HTTPException(404, { message: "This invite link is invalid or has expired" });
    const passwordHash = await c.var.passwordWork.run(() => Bun.password.hash(input.password));

    let userId: number;
    try {
      userId = db.transaction((tx) => {
        const invite = tx
          .select()
          .from(invites)
          .where(and(eq(invites.id, inviteId), isNull(invites.usedBy), gt(invites.expiresAt, Date.now())))
          .get();
        if (!invite) throw new HTTPException(404, { message: "This invite link is invalid or has expired" });
        const id = tx
          .insert(users)
          .values({
            householdId: invite.householdId,
            username: input.username,
            displayName: input.displayName,
            passwordHash,
            role: "member",
          })
          .returning({ id: users.id })
          .get().id;
        tx.update(invites).set({ usedBy: id }).where(eq(invites.id, inviteId)).run();
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: "That username is already taken" });
      throw err;
    }

    const { token, expiresAt } = createSession(db, userId);
    setSessionCookie(c, token, expiresAt);
    return c.json({ ok: true }, 201);
  });
