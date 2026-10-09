import { monthSchema, setBudgetInput } from "@fd/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import { uncategorizedActivity, categoryActivity, copyLastMonth, getBudgetMonth, setBudget } from "../services/budget";

function monthParam(raw: string | undefined) {
  const parsed = monthSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(404, { message: "Not found" });
  return parsed.data;
}

export const budgetRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/:month", (c) => c.json(getBudgetMonth(c.var.db, actorOf(c).householdId, monthParam(c.req.param("month")))))

  .get("/:month/uncategorized", c => c.json(uncategorizedActivity(c.var.db, actorOf(c), monthParam(c.req.param("month")))))

  .put("/:month/categories/:id", async (c) => {
    const month = monthParam(c.req.param("month"));
    const id = idParam(c);
    const { amount } = await parseBody(c, setBudgetInput);
    const actor = actorOf(c);
    c.var.db.transaction((tx) => setBudget(tx, actor, month, id, amount));
    return c.json(getBudgetMonth(c.var.db, actor.householdId, month));
  })

  .get("/:month/categories/:id/transactions", (c) =>
    c.json(categoryActivity(c.var.db, actorOf(c), monthParam(c.req.param("month")), idParam(c))),
  )

  .post("/:month/copy-last-month", (c) => {
    const month = monthParam(c.req.param("month"));
    const actor = actorOf(c);
    c.var.db.transaction((tx) => copyLastMonth(tx, actor, month));
    return c.json(getBudgetMonth(c.var.db, actor.householdId, month));
  });
