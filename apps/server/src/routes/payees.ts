import { mergePayeesInput, updatePayeeInput, type Payee } from "@fd/shared";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import type { DbOrTx } from "../db";
import { payees, transactions } from "../db/schema";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";

/** A payee in the household that isn't a transfer payee (those follow their account). */
function regularPayee(db: DbOrTx, householdId: number, id: number) {
  const payee = db
    .select()
    .from(payees)
    .where(and(eq(payees.id, id), eq(payees.householdId, householdId)))
    .get();
  if (!payee) throw new HTTPException(404, { message: "Payee not found" });
  if (payee.transferAccountId) {
    throw new HTTPException(400, { message: "Transfer payees follow their account; rename the account instead" });
  }
  return payee;
}

const householdOf = (c: Context<AppEnv>) => actorOf(c).householdId;

export const payeeRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", (c) => {
    const list: Payee[] = c.var.db.all<Payee>(sql`
      select p.id as id, p.name as name, p.transfer_account_id as transferAccountId,
             (select count(*) from transactions t where t.payee_id = p.id and t.parent_id is null) as transactionCount,
             (select t.category_id from transactions t
              where t.payee_id = p.id and t.parent_id is null and t.category_id is not null
              order by t.date desc, t.id desc limit 1) as lastCategoryId
      from payees p
      where p.household_id = ${householdOf(c)}
      order by lower(p.name)
    `);
    return c.json(list);
  })

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const { name } = await parseBody(c, updatePayeeInput);
    const householdId = householdOf(c);
    regularPayee(c.var.db, householdId, id);
    const clash = c.var.db
      .select({ id: payees.id })
      .from(payees)
      .where(
        and(
          eq(payees.householdId, householdId),
          isNull(payees.transferAccountId),
          ne(payees.id, id),
          sql`lower(${payees.name}) = lower(${name})`,
        ),
      )
      .get();
    if (clash)
      throw new HTTPException(409, { message: `There's already a payee called "${name}". Merge them instead.` });
    c.var.db.update(payees).set({ name }).where(eq(payees.id, id)).run();
    return c.json({ ok: true });
  })

  .post("/merge", async (c) => {
    const { sourceIds, targetId } = await parseBody(c, mergePayeesInput);
    const householdId = householdOf(c);
    const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
    if (sources.length === 0) throw new HTTPException(400, { message: "Pick payees to merge into the target" });
    regularPayee(c.var.db, householdId, targetId);
    for (const id of sources) regularPayee(c.var.db, householdId, id);
    const moved = c.var.db.transaction((tx) => {
      const n = tx
        .update(transactions)
        .set({ payeeId: targetId })
        .where(inArray(transactions.payeeId, sources))
        .returning({ id: transactions.id })
        .all().length;
      tx.delete(payees).where(inArray(payees.id, sources)).run();
      return n;
    });
    return c.json({ ok: true, moved });
  })

  /** Delete a payee; its transactions keep everything else and just lose the payee. */
  .delete("/:id", (c) => {
    const id = idParam(c);
    regularPayee(c.var.db, householdOf(c), id);
    c.var.db.delete(payees).where(eq(payees.id, id)).run();
    return c.json({ ok: true });
  })

  .post("/delete-unused", (c) => {
    const deleted = c.var.db.all<{ id: number }>(sql`
      delete from payees
      where household_id = ${householdOf(c)}
        and transfer_account_id is null
        and not exists (select 1 from transactions t where t.payee_id = payees.id)
      returning id
    `).length;
    return c.json({ ok: true, deleted });
  });
