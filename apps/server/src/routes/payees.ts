import { updatePayeeInput, type Payee } from "@fd/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { payees } from "../db/schema";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";

export const payeeRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", (c) => {
    const list: Payee[] = c.var.db
      .select({ id: payees.id, name: payees.name, transferAccountId: payees.transferAccountId })
      .from(payees)
      .where(eq(payees.householdId, actorOf(c).householdId))
      .orderBy(asc(sql`lower(${payees.name})`))
      .all();
    return c.json(list);
  })

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updatePayeeInput);
    const payee = c.var.db
      .select()
      .from(payees)
      .where(and(eq(payees.id, id), eq(payees.householdId, actorOf(c).householdId)))
      .get();
    if (!payee) throw new HTTPException(404, { message: "Payee not found" });
    if (payee.transferAccountId) {
      throw new HTTPException(400, { message: "Rename the account to rename its transfer payee" });
    }
    c.var.db.update(payees).set({ name: input.name }).where(eq(payees.id, id)).run();
    return c.json({ ok: true });
  });
