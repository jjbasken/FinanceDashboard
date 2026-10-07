import { monthSchema } from "@fd/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { actorOf, requireAuth } from "../middleware";
import { HISTORY_RANGES, type HistoryRange } from "../services/holdings";
import { cashFlow, netWorthHistory, spendingByCategory } from "../services/reports";
import { localDate } from "../util";

/** ?from=YYYY-MM&to=YYYY-MM, defaulting to the last 12 months; at most 20 years. */
function monthRange(c: Context<AppEnv>) {
  const thisMonth = localDate().slice(0, 7);
  const parse = (raw: string | undefined, fallback: string) => {
    if (!raw) return fallback;
    const r = monthSchema.safeParse(raw);
    if (!r.success) throw new HTTPException(400, { message: "Use YYYY-MM months" });
    return r.data;
  };
  const to = parse(c.req.query("to"), thisMonth);
  const [y, m] = to.split("-").map(Number) as [number, number];
  const yearAgo = `${m === 12 ? y : y - 1}-${String((m % 12) + 1).padStart(2, "0")}`;
  const from = parse(c.req.query("from"), yearAgo);
  if (from > to) throw new HTTPException(400, { message: "The start month is after the end month" });
  if (Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 20) {
    throw new HTTPException(400, { message: "Pick a range of 20 years or less" });
  }
  return { from, to };
}

export const reportRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/net-worth", (c) => {
    const range = (c.req.query("range") ?? "1y") as HistoryRange;
    if (!HISTORY_RANGES.includes(range)) throw new HTTPException(400, { message: "Unknown range" });
    return c.json(netWorthHistory(c.var.db, actorOf(c), range, localDate()));
  })

  .get("/cash-flow", (c) => {
    const { from, to } = monthRange(c);
    return c.json(cashFlow(c.var.db, actorOf(c).householdId, from, to));
  })

  .get("/spending", (c) => {
    const { from, to } = monthRange(c);
    return c.json(spendingByCategory(c.var.db, actorOf(c).householdId, from, to));
  });
