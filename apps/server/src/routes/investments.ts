import { createSecurityInput, investmentTxnInput, manualPriceInput, updateSecurityInput } from "@fd/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { actorOf, idParam, parseBody, requireAuth } from "../middleware";
import { getHoldings, HISTORY_RANGES, valueHistory, type HistoryRange } from "../services/holdings";
import {
  createInvestmentTxn,
  createSecurity,
  deleteInvestmentTxn,
  deleteSecurity,
  listInvestmentTxns,
  listSecurities,
  setManualPrice,
  updateInvestmentTxn,
  updateSecurity,
} from "../services/investments";
import { refreshPrices } from "../services/prices";
import { localDate } from "../util";

const optionalId = (raw: string | undefined) => {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HTTPException(400, { message: "Invalid id" });
  return n;
};

export const investmentRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .get("/holdings", (c) => c.json(getHoldings(c.var.db, actorOf(c))))

  .get("/history", (c) => {
    const range = (c.req.query("range") ?? "1y") as HistoryRange;
    if (!HISTORY_RANGES.includes(range)) throw new HTTPException(400, { message: "Unknown range" });
    return c.json(valueHistory(c.var.db, actorOf(c), range, localDate()));
  })

  .post("/prices/refresh", async (c) =>
    c.json(await refreshPrices(c.var.db, c.var.priceProvider, localDate(), actorOf(c).householdId, c.var.log)),
  )

  // --- Securities ---
  .get("/securities", (c) => c.json(listSecurities(c.var.db, actorOf(c).householdId)))

  .get("/securities/lookup", async (c) => {
    const symbol = (c.req.query("symbol") ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9.\-^=]{1,24}$/.test(symbol)) throw new HTTPException(400, { message: "Enter a ticker symbol" });
    const found = await c.var.priceProvider.lookup(symbol);
    if (!found) throw new HTTPException(404, { message: `Couldn't find ${symbol}` });
    return c.json(found);
  })

  .post("/securities", async (c) => {
    const input = await parseBody(c, createSecurityInput);
    const security = createSecurity(c.var.db, actorOf(c).householdId, input);
    return c.json(security, 201);
  })

  .patch("/securities/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, updateSecurityInput);
    updateSecurity(c.var.db, actorOf(c).householdId, id, input);
    return c.json({ ok: true });
  })

  .delete("/securities/:id", (c) => {
    deleteSecurity(c.var.db, actorOf(c).householdId, idParam(c));
    return c.json({ ok: true });
  })

  .post("/securities/:id/prices", async (c) => {
    const id = idParam(c);
    const { date, price } = await parseBody(c, manualPriceInput);
    setManualPrice(c.var.db, actorOf(c).householdId, id, date, price);
    return c.json({ ok: true }, 201);
  })

  // --- Investment transactions ---
  .get("/transactions", (c) =>
    c.json(
      listInvestmentTxns(c.var.db, actorOf(c), {
        accountId: optionalId(c.req.query("accountId")),
        securityId: optionalId(c.req.query("securityId")),
      }),
    ),
  )

  .post("/transactions", async (c) => {
    const input = await parseBody(c, investmentTxnInput);
    const actor = actorOf(c);
    const id = c.var.db.transaction((tx) => createInvestmentTxn(tx, actor, input));
    return c.json({ id }, 201);
  })

  .put("/transactions/:id", async (c) => {
    const id = idParam(c);
    const input = await parseBody(c, investmentTxnInput);
    const actor = actorOf(c);
    c.var.db.transaction((tx) => updateInvestmentTxn(tx, actor, id, input));
    return c.json({ id });
  })

  .delete("/transactions/:id", (c) => {
    const id = idParam(c);
    c.var.db.transaction((tx) => deleteInvestmentTxn(tx, actorOf(c), id));
    return c.json({ ok: true });
  });
