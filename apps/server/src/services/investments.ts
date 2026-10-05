import {
  INVESTMENT_ACTION_LABELS,
  formatCents,
  priceToString,
  sharesToString,
  sharesValueCents,
  type CreateSecurityInput,
  type InvestmentTxn,
  type InvestmentTxnInput,
  type Security,
  type UpdateSecurityInput,
} from "@fd/shared";
import { and, asc, count, desc, eq, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db";
import { investmentTxns, prices, securities, transactions } from "../db/schema";
import { findOrCreatePayee, getAccount, type Actor } from "./ledger";

const bad = (message: string) => new HTTPException(400, { message });

function isUniqueViolation(err: unknown) {
  return err instanceof Error && /UNIQUE constraint failed: securities\./.test(err.message);
}

export function getSecurity(db: DbOrTx, householdId: number, id: number) {
  const row = db
    .select()
    .from(securities)
    .where(and(eq(securities.id, id), eq(securities.householdId, householdId)))
    .get();
  if (!row) throw new HTTPException(404, { message: "Security not found" });
  return row;
}

export function listSecurities(db: DbOrTx, householdId: number): Security[] {
  const latest = db.all<{ securityId: number; close: number; date: string }>(sql`
    select p.security_id as securityId, p.close as close, p.date as date
    from prices p
    join securities s on s.id = p.security_id
    where s.household_id = ${householdId}
      and p.date = (select max(date) from prices where security_id = p.security_id)
  `);
  const byId = new Map(latest.map((p) => [p.securityId, p]));
  return db
    .select({
      id: securities.id,
      symbol: securities.symbol,
      name: securities.name,
      type: securities.type,
      currency: securities.currency,
      autoPrice: securities.autoPrice,
    })
    .from(securities)
    .where(eq(securities.householdId, householdId))
    .orderBy(asc(securities.symbol))
    .all()
    .map((s) => ({ ...s, latestPrice: byId.get(s.id)?.close ?? null, latestPriceDate: byId.get(s.id)?.date ?? null }));
}

export function createSecurity(db: DbOrTx, householdId: number, input: CreateSecurityInput, importBatchId?: number) {
  try {
    return db
      .insert(securities)
      .values({ householdId, ...input, autoPrice: input.autoPrice ?? true, importBatchId })
      .returning()
      .get();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HTTPException(409, { message: `You already have ${input.symbol}` });
    throw err;
  }
}

export function updateSecurity(db: DbOrTx, householdId: number, id: number, input: UpdateSecurityInput) {
  getSecurity(db, householdId, id);
  try {
    db.update(securities).set(input).where(eq(securities.id, id)).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HTTPException(409, { message: `You already have ${input.symbol}` });
    throw err;
  }
}

export function deleteSecurity(db: DbOrTx, householdId: number, id: number) {
  getSecurity(db, householdId, id);
  const [used] = db.select({ n: count() }).from(investmentTxns).where(eq(investmentTxns.securityId, id)).all();
  if (used?.n) throw new HTTPException(409, { message: "Delete this security's transactions first" });
  db.delete(securities).where(eq(securities.id, id)).run();
}

export function setManualPrice(db: DbOrTx, householdId: number, securityId: number, date: string, close: number) {
  getSecurity(db, householdId, securityId);
  db.insert(prices)
    .values({ securityId, date, close, source: "manual" })
    .onConflictDoUpdate({ target: [prices.securityId, prices.date], set: { close, source: "manual" } })
    .run();
}

// --- Investment transactions ---

type Row = typeof investmentTxns.$inferSelect;

function toApi(r: Row): InvestmentTxn {
  return {
    id: r.id,
    accountId: r.accountId,
    securityId: r.securityId,
    date: r.date,
    action: r.action,
    shares: r.shares,
    price: r.price,
    fees: r.fees,
    amount: r.amount,
    transactionId: r.transactionId,
    notes: r.notes,
  };
}

export function listInvestmentTxns(
  db: DbOrTx,
  householdId: number,
  filter: { accountId?: number; securityId?: number } = {},
): InvestmentTxn[] {
  const conds = [eq(investmentTxns.householdId, householdId)];
  if (filter.accountId) conds.push(eq(investmentTxns.accountId, filter.accountId));
  if (filter.securityId) conds.push(eq(investmentTxns.securityId, filter.securityId));
  return db
    .select()
    .from(investmentTxns)
    .where(and(...conds))
    .orderBy(desc(investmentTxns.date), desc(investmentTxns.id))
    .all()
    .map(toApi);
}

function getRow(db: DbOrTx, householdId: number, id: number) {
  const row = db
    .select()
    .from(investmentTxns)
    .where(and(eq(investmentTxns.id, id), eq(investmentTxns.householdId, householdId)))
    .get();
  if (!row) throw new HTTPException(404, { message: "Investment transaction not found" });
  return row;
}

/** Shares held in an account on a date (inclusive), ignoring one transaction being edited. */
function positionOn(db: DbOrTx, accountId: number, securityId: number, date: string, excludeId?: number) {
  const conds = [
    eq(investmentTxns.accountId, accountId),
    eq(investmentTxns.securityId, securityId),
    sql`${investmentTxns.date} <= ${date}`,
  ];
  if (excludeId) conds.push(ne(investmentTxns.id, excludeId));
  const [row] = db
    .select({ n: sql<number>`coalesce(sum(${investmentTxns.shares}), 0)` })
    .from(investmentTxns)
    .where(and(...conds))
    .all();
  return row?.n ?? 0;
}

/** Reject any change that would leave the account short of shares at some point. */
function assertNeverShort(db: DbOrTx, accountId: number, securityId: number, symbol: string) {
  const rows = db
    .select({ date: investmentTxns.date, shares: investmentTxns.shares })
    .from(investmentTxns)
    .where(and(eq(investmentTxns.accountId, accountId), eq(investmentTxns.securityId, securityId)))
    .orderBy(asc(investmentTxns.date), asc(investmentTxns.id))
    .all();
  let held = 0;
  for (const r of rows) {
    held += r.shares;
    if (held < 0) throw bad(`That would leave the account short of ${symbol} shares on ${r.date}`);
  }
}

interface Normalised {
  shares: number;
  price: number;
  fees: number;
  amount: number;
  /** Cash moving in (+) or out (-) of the account. */
  cash: number;
  notes: string;
}

function need<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === 0) throw bad(message);
  return value;
}

/** Work out shares, amounts and cash for an action from the user's input. */
function normalise(input: InvestmentTxnInput, held: number): Normalised {
  const fees = input.fees ?? 0;
  const notes = input.notes ?? "";
  switch (input.action) {
    case "buy": {
      const shares = need(input.shares, "Enter the number of shares");
      const price = need(input.price, "Enter the price per share");
      const amount = input.amount ?? sharesValueCents(shares, price) + fees;
      return { shares, price, fees, amount, cash: -amount, notes };
    }
    case "sell": {
      const shares = need(input.shares, "Enter the number of shares");
      const price = need(input.price, "Enter the price per share");
      if (shares > held) throw bad("You can't sell more shares than you hold on that date");
      const amount = input.amount ?? sharesValueCents(shares, price) - fees;
      return { shares: -shares, price, fees, amount, cash: amount, notes };
    }
    case "dividend": {
      const amount = need(input.amount, "Enter the dividend amount");
      return { shares: 0, price: 0, fees: 0, amount, cash: amount, notes };
    }
    case "reinvest": {
      const shares = need(input.shares, "Enter the number of shares bought");
      const price = need(input.price, "Enter the price per share");
      const amount = input.amount ?? sharesValueCents(shares, price);
      return { shares, price, fees: 0, amount, cash: 0, notes };
    }
    case "split": {
      const ratioNew = need(input.splitNew, "Enter the split ratio");
      const ratioOld = need(input.splitOld, "Enter the split ratio");
      if (ratioNew === ratioOld) throw bad("A split needs a ratio other than 1 for 1");
      if (held <= 0) throw bad("There are no shares to split on that date");
      const delta = Math.round((held * ratioNew) / ratioOld) - held;
      return {
        shares: delta,
        price: 0,
        fees: 0,
        amount: 0,
        cash: 0,
        notes: notes || `${ratioNew} for ${ratioOld} split`,
      };
    }
    case "transfer_in": {
      const shares = need(input.shares, "Enter the number of shares");
      return { shares, price: 0, fees: 0, amount: input.amount ?? 0, cash: 0, notes };
    }
    case "transfer_out": {
      const shares = need(input.shares, "Enter the number of shares");
      if (shares > held) throw bad("You can't move out more shares than you hold on that date");
      return { shares: -shares, price: 0, fees: 0, amount: 0, cash: 0, notes };
    }
  }
}

/** Create, update or remove the register row that mirrors an investment transaction's cash. */
function syncCash(
  db: DbOrTx,
  actor: Actor,
  existingId: number | null,
  values: { accountId: number; date: string; action: InvestmentTxnInput["action"]; symbol: string } & Normalised,
): number | null {
  if (values.cash === 0) {
    if (existingId) db.delete(transactions).where(eq(transactions.id, existingId)).run();
    return null;
  }
  const payee = findOrCreatePayee(db, actor.householdId, `${INVESTMENT_ACTION_LABELS[values.action]} ${values.symbol}`);
  const detail =
    values.action === "dividend"
      ? ""
      : `${sharesToString(Math.abs(values.shares))} @ $${priceToString(values.price)}${values.fees ? ` + ${formatCents(values.fees)} fees` : ""}`;
  const notes = [detail, values.notes].filter(Boolean).join(" · ");
  const row = {
    accountId: values.accountId,
    date: values.date,
    amount: values.cash,
    payeeId: payee.id,
    categoryId: null,
    notes,
    updatedBy: actor.userId,
  };
  if (existingId) {
    db.update(transactions).set(row).where(eq(transactions.id, existingId)).run();
    return existingId;
  }
  return db
    .insert(transactions)
    .values({ ...row, householdId: actor.householdId, createdBy: actor.userId })
    .returning({ id: transactions.id })
    .get().id;
}

export function createInvestmentTxn(
  db: DbOrTx,
  actor: Actor,
  input: InvestmentTxnInput,
  extra: { importedId?: string; importBatchId?: number } = {},
) {
  getAccount(db, actor.householdId, input.accountId);
  const security = getSecurity(db, actor.householdId, input.securityId);
  const n = normalise(input, positionOn(db, input.accountId, input.securityId, input.date));
  const transactionId = syncCash(db, actor, null, { ...input, symbol: security.symbol, ...n });
  if (transactionId && extra.importBatchId) {
    db.update(transactions)
      .set({ importBatchId: extra.importBatchId, importedId: extra.importedId ? `${extra.importedId}:cash` : null })
      .where(eq(transactions.id, transactionId))
      .run();
  }
  const row = db
    .insert(investmentTxns)
    .values({
      householdId: actor.householdId,
      accountId: input.accountId,
      securityId: input.securityId,
      date: input.date,
      action: input.action,
      shares: n.shares,
      price: n.price,
      fees: n.fees,
      amount: n.amount,
      notes: n.notes,
      transactionId,
      importedId: extra.importedId,
      importBatchId: extra.importBatchId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning()
    .get();
  assertNeverShort(db, input.accountId, input.securityId, security.symbol);
  return row.id;
}

export function updateInvestmentTxn(db: DbOrTx, actor: Actor, id: number, input: InvestmentTxnInput) {
  const existing = getRow(db, actor.householdId, id);
  getAccount(db, actor.householdId, input.accountId);
  const security = getSecurity(db, actor.householdId, input.securityId);
  const n = normalise(input, positionOn(db, input.accountId, input.securityId, input.date, id));
  const transactionId = syncCash(db, actor, existing.transactionId, { ...input, symbol: security.symbol, ...n });
  db.update(investmentTxns)
    .set({
      accountId: input.accountId,
      securityId: input.securityId,
      date: input.date,
      action: input.action,
      shares: n.shares,
      price: n.price,
      fees: n.fees,
      amount: n.amount,
      notes: n.notes,
      transactionId,
      updatedBy: actor.userId,
    })
    .where(eq(investmentTxns.id, id))
    .run();
  assertNeverShort(db, input.accountId, input.securityId, security.symbol);
  if (existing.accountId !== input.accountId || existing.securityId !== input.securityId) {
    const old = getSecurity(db, actor.householdId, existing.securityId);
    assertNeverShort(db, existing.accountId, existing.securityId, old.symbol);
  }
}

export function deleteInvestmentTxn(db: DbOrTx, householdId: number, id: number) {
  const row = getRow(db, householdId, id);
  db.delete(investmentTxns).where(eq(investmentTxns.id, id)).run();
  if (row.transactionId) db.delete(transactions).where(eq(transactions.id, row.transactionId)).run();
  assertNeverShort(db, row.accountId, row.securityId, getSecurity(db, householdId, row.securityId).symbol);
}
