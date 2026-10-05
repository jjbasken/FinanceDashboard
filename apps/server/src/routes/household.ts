import type { InviteInfo, PublicUser } from "@fd/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { invites, users } from "../db/schema";
import { hashToken, newToken } from "../auth/tokens";
import { requireAuth, requireOwner, sessionOf } from "../middleware";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const householdRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/users", (c) => {
    const { household } = sessionOf(c);
    const list: PublicUser[] = c.var.db
      .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role })
      .from(users)
      .where(eq(users.householdId, household.id))
      .orderBy(asc(users.id))
      .all();
    return c.json(list);
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
