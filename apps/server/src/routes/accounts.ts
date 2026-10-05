import { createAccountInput, reconcileInput, updateAccountInput } from "@fd/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import {
  accountSummary,
  createAccount,
  deleteAccount,
  listAccounts,
  listTransactions,
  reconcileAccount,
  updateAccount,
} from "../services/ledger";
import { localDate } from "../util";

export const accountRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", (c) => c.json(listAccounts(c.var.db, actorOf(c).householdId)))

  .post("/", async (c) => {
    const input = await parseBody(c, createAccountInput);
    const actor = actorOf(c);
    const account = c.var.db.transaction((tx) => createAccount(tx, actor, input, localDate()));
    return c.json(accountSummary(c.var.db, actor.householdId, account.id), 201);
  })

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateAccountInput);
    const actor = actorOf(c);
    c.var.db.transaction((tx) => updateAccount(tx, actor, id, input));
    return c.json(accountSummary(c.var.db, actor.householdId, id));
  })

  .delete("/:id", (c) => {
    const id = idParam(c);
    c.var.db.transaction((tx) => deleteAccount(tx, actorOf(c).householdId, id));
    return c.json({ ok: true });
  })

  .get("/:id/transactions", (c) => c.json(listTransactions(c.var.db, actorOf(c).householdId, idParam(c))))

  .post("/:id/reconcile", async (c) => {
    const id = idParam(c);
    const { statementBalance } = await parseBody(c, reconcileInput);
    const actor = actorOf(c);
    c.var.db.transaction((tx) => reconcileAccount(tx, actor, id, statementBalance));
    return c.json(accountSummary(c.var.db, actor.householdId, id));
  });
