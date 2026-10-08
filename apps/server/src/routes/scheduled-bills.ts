import { createScheduledBillInput, updateScheduledBillInput } from "@fd/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import {
  createScheduledBill,
  deleteScheduledBill,
  getScheduledBill,
  listScheduledBills,
  updateScheduledBill,
} from "../services/scheduled-bills";
import { localDate } from "../util";

export const scheduledBillRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/", (c) => c.json(listScheduledBills(c.var.db, actorOf(c), localDate())))

  .post("/", async (c) => {
    const input = await parseBody(c, createScheduledBillInput);
    const actor = actorOf(c);
    const today = localDate();
    const id = c.var.db.transaction((tx) => createScheduledBill(tx, actor, input, today));
    return c.json(getScheduledBill(c.var.db, actor, id, today), 201);
  })

  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateScheduledBillInput);
    const actor = actorOf(c);
    const today = localDate();
    c.var.db.transaction((tx) => updateScheduledBill(tx, actor, id, input, today));
    return c.json(getScheduledBill(c.var.db, actor, id, today));
  })

  .delete("/:id", (c) => {
    const id = idParam(c);
    c.var.db.transaction((tx) => deleteScheduledBill(tx, actorOf(c), id));
    return c.json({ ok: true });
  });
