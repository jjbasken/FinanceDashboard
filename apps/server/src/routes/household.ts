import { setPasswordInput, updateHouseholdInput, type HouseholdMember, type InviteInfo } from "@fd/shared";
import type { Context } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { deleteUserSessions } from "../auth/sessions";
import { households, invites, users } from "../db/schema";
import { hashToken, newToken } from "../auth/tokens";
import { idParam, parseBody, requireAuth, requireOwner, sessionOf } from "../middleware";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Another member of the owner's household (never the owner themselves). */
function memberOf(c: Context<AppEnv>) {
  const { household, user } = sessionOf(c);
  const id = idParam(c);
  const member = c.var.db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.householdId, household.id)))
    .get();
  if (!member) throw new HTTPException(404, { message: "Member not found" });
  if (member.id === user.id) {
    throw new HTTPException(400, { message: "Use the Your account section to change your own password" });
  }
  return member;
}

export const householdRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/users", (c) => {
    const { household } = sessionOf(c);
    const list: HouseholdMember[] = c.var.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.householdId, household.id))
      .orderBy(asc(users.id))
      .all()
      .map(({ disabledAt, ...u }) => ({ ...u, disabled: !!disabledAt }));
    return c.json(list);
  })

  /** Household settings: name and display currency. */
  .patch("/", requireOwner, async (c) => {
    const input = await parseBody(c, updateHouseholdInput);
    const { household } = sessionOf(c);
    c.var.db.update(households).set(input).where(eq(households.id, household.id)).run();
    return c.json({ ok: true });
  })

  /** The owner sets a new password for a member (e.g. one who forgot theirs). Signs them out everywhere. */
  .post("/users/:id/password", requireOwner, async (c) => {
    const member = memberOf(c);
    const { newPassword } = await parseBody(c, setPasswordInput);
    const passwordHash = await c.var.passwordWork.run(() => Bun.password.hash(newPassword));
    c.var.db.update(users).set({ passwordHash }).where(eq(users.id, member.id)).run();
    deleteUserSessions(c.var.db, member.id);
    return c.json({ ok: true });
  })

  /** Remove a member: they're signed out and can't sign in, but their name stays on what they entered. */
  .post("/users/:id/disable", requireOwner, (c) => {
    const member = memberOf(c);
    c.var.db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, member.id)).run();
    deleteUserSessions(c.var.db, member.id);
    return c.json({ ok: true });
  })

  .post("/users/:id/enable", requireOwner, (c) => {
    const member = memberOf(c);
    c.var.db.update(users).set({ disabledAt: null }).where(eq(users.id, member.id)).run();
    return c.json({ ok: true });
  })

  .post("/invites", requireOwner, (c) => {
    const { user, household } = sessionOf(c);
    const token = newToken();
    const expiresAt = Date.now() + INVITE_TTL_MS;
    c.var.db
      .insert(invites)
      .values({ id: hashToken(token), householdId: household.id, createdBy: user.id, expiresAt })
      .run();
    const info: InviteInfo = { token, expiresAt: new Date(expiresAt).toISOString() };
    return c.json(info, 201);
  });
