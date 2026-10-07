import { createTransactionInput, updateTransactionInput } from "@fd/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import { createTransaction, deleteTransaction, getTransaction, updateTransaction } from "../services/ledger";

export const transactionRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .post("/", async (c) => {
    const input = await parseBody(c, createTransactionInput);
    const actor = actorOf(c);
    const id = c.var.db.transaction((tx) => createTransaction(tx, actor, input));
    return c.json(getTransaction(c.var.db, actor, id), 201);
  })

  .get("/:id", (c) => c.json(getTransaction(c.var.db, actorOf(c), idParam(c))))

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateTransactionInput);
    const actor = actorOf(c);
    c.var.db.transaction((tx) => updateTransaction(tx, actor, id, input));
    return c.json(getTransaction(c.var.db, actor, id));
  })

  .delete("/:id", (c) => {
    const id = idParam(c);
    c.var.db.transaction((tx) => deleteTransaction(tx, actorOf(c), id));
    return c.json({ ok: true });
  });
