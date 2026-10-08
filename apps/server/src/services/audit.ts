import { describeSchedule, formatCents, formatMonth, type AuditDetails, type AuditEntity } from "@fd/shared";
import { and, eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";
import type { DbOrTx } from "../db";
import {
  accountFolders,
  accounts,
  auditLog,
  budgetMonths,
  categories,
  categoryGroups,
  households,
  importBatches,
  investmentTxns,
  payees,
  scheduledBills,
  securities,
  transactions,
  users,
} from "../db/schema";

type Row = Record<string, unknown>;

export interface AuditRecord {
  householdId: number;
  userId: number | null;
  action: string;
  entity: AuditEntity;
  entityId: number | null;
  summary: string;
  details?: AuditDetails | null;
  private?: boolean;
}

export function recordAudit(db: DbOrTx, r: AuditRecord) {
  db.insert(auditLog)
    .values({ ...r, details: r.private ? null : (r.details ?? null), private: r.private ?? false })
    .run();
}

// --- Loading rows ---

/** Columns that are bookkeeping, not something a person changed. */
const NOISE = new Set([
  "householdId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "importBatchId",
  "importedId",
  "gnucashGuid",
  "passwordHash",
]);

const TABLES: Partial<Record<AuditEntity, SQLiteTable>> = {
  transaction: transactions,
  account: accounts,
  folder: accountFolders,
  category: categories,
  "category group": categoryGroups,
  payee: payees,
  bill: scheduledBills,
  security: securities,
  investment: investmentTxns,
  member: users,
  household: households,
};

/** A row as the audit log keeps it: without bookkeeping columns (or password hashes). */
function clean(row: Row | undefined | null): Row | null {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !NOISE.has(k)));
}

/** An entity's row, scoped to the household. */
function loadRow(db: DbOrTx, householdId: number, entity: AuditEntity, id: number): Row | null {
  const table = TABLES[entity];
  if (!table) return null;
  const cols = table as unknown as { id: SQLiteColumn; householdId: SQLiteColumn };
  const where =
    entity === "household" ? eq(cols.id, householdId) : and(eq(cols.id, id), eq(cols.householdId, householdId));
  return clean(db.select().from(table).where(where).get() as Row | undefined);
}

function loadBudget(db: DbOrTx, householdId: number, categoryId: number, month: string): Row {
  const row = db
    .select({ amount: budgetMonths.amount })
    .from(budgetMonths)
    .where(
      and(
        eq(budgetMonths.householdId, householdId),
        eq(budgetMonths.categoryId, categoryId),
        eq(budgetMonths.month, month),
      ),
    )
    .get();
  return { categoryId, month, amount: row?.amount ?? 0 };
}

/** Field-by-field differences between two versions of a row. */
export function diff(before: Row | null, after: Row | null) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (!before || !after) return changes;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
    }
  }
  return changes;
}

/** A request body as the audit log keeps it: never passwords, tokens or secrets. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row)
        .filter(([k]) => !/password|token|secret/i.test(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

/**
 * A request or response trimmed for storage: top-level numbers, strings and booleans, plus
 * small arrays and objects. Big payloads (an import's preview or mappings) are left out.
 */
function compact(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Row = {};
  for (const [k, v] of Object.entries(redact(value) as Row)) {
    if (v === null || ["number", "string", "boolean"].includes(typeof v)) out[k] = v;
    else if (JSON.stringify(v).length <= 500) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// --- Describing changes ---

const usDate = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

function nameOf(db: DbOrTx, table: typeof payees | typeof accounts | typeof categories, id: unknown) {
  if (typeof id !== "number") return null;
  return db.select({ name: table.name }).from(table).where(eq(table.id, id)).get()?.name ?? null;
}

function currencyOf(db: DbOrTx, householdId: number) {
  return db.select({ c: households.currency }).from(households).where(eq(households.id, householdId)).get()?.c;
}

/** A short, readable label for a row, e.g. "Landlord −$1,500.00 on 10/20/2026 in Checking". */
export function label(db: DbOrTx, householdId: number, entity: AuditEntity, row: Row | null): string {
  if (!row) return "";
  const money = (cents: unknown) => formatCents(Number(cents), currencyOf(db, householdId) ?? "USD");
  switch (entity) {
    case "transaction": {
      const payee = nameOf(db, payees, row.payeeId);
      const account = nameOf(db, accounts, row.accountId);
      return [payee, money(row.amount), `on ${usDate(String(row.date))}`, account && `in ${account}`]
        .filter(Boolean)
        .join(" ");
    }
    case "bill": {
      const payee = nameOf(db, payees, row.payeeId);
      const schedule = describeSchedule({
        frequency: row.frequency as "monthly",
        startDate: String(row.startDate),
      }).toLowerCase();
      return [payee, money(row.amount), schedule].filter(Boolean).join(" ");
    }
    case "budget": {
      const category = nameOf(db, categories, row.categoryId);
      return `${category ?? "a category"}, ${formatMonth(String(row.month))}`;
    }
    case "security":
      return `${row.symbol} (${row.name})`;
    case "investment": {
      const symbol = db
        .select({ s: securities.symbol })
        .from(securities)
        .where(eq(securities.id, Number(row.securityId)))
        .get()?.s;
      return `${row.action} ${symbol ?? ""} on ${usDate(String(row.date))}`.replace("  ", " ");
    }
    case "member":
      return String(row.displayName ?? row.username ?? "");
    default:
      return String(row.name ?? "");
  }
}

const VERBS: Record<string, string> = {
  create: "Added",
  update: "Changed",
  delete: "Deleted",
  move: "Moved",
  reconcile: "Reconciled",
};

/** Record something the app created on its own (no member), e.g. a recurring bill's payment. */
export function recordSystemCreate(db: DbOrTx, householdId: number, entity: AuditEntity, id: number, by: string) {
  const after = loadRow(db, householdId, entity, id);
  const isPrivate = isOthersPrivate(db, householdId, accountIdOf(entity, after));
  recordAudit(db, {
    householdId,
    userId: null,
    action: "create",
    entity,
    entityId: id,
    summary: isPrivate
      ? `${by} added ${PRIVATE_SUMMARY[entity] ?? entity}`
      : `${by} added ${entity}: ${label(db, householdId, entity, after)}`,
    details: { after },
    private: isPrivate,
  });
}

// --- The middleware ---

interface Target {
  entity: AuditEntity;
  action: string;
  /** The id in the path, if any. */
  id: number | null;
  /** For a budget amount: the month. */
  month?: string;
}

const ROUTES: [method: string, pattern: RegExp, entity: AuditEntity, action: string][] = [
  ["POST", /^\/transactions$/, "transaction", "create"],
  ["PATCH", /^\/transactions\/(\d+)$/, "transaction", "update"],
  ["DELETE", /^\/transactions\/(\d+)$/, "transaction", "delete"],
  ["POST", /^\/accounts$/, "account", "create"],
  ["PATCH", /^\/accounts\/(\d+)$/, "account", "update"],
  ["DELETE", /^\/accounts\/(\d+)$/, "account", "delete"],
  ["POST", /^\/accounts\/(\d+)\/reconcile$/, "account", "reconcile"],
  ["POST", /^\/account-folders$/, "folder", "create"],
  ["POST", /^\/account-folders\/move$/, "folder", "move"],
  ["PATCH", /^\/account-folders\/(\d+)$/, "folder", "update"],
  ["DELETE", /^\/account-folders\/(\d+)$/, "folder", "delete"],
  ["POST", /^\/categories\/groups$/, "category group", "create"],
  ["PATCH", /^\/categories\/groups\/(\d+)$/, "category group", "update"],
  ["POST", /^\/categories\/groups\/(\d+)\/move$/, "category group", "move"],
  ["DELETE", /^\/categories\/groups\/(\d+)$/, "category group", "delete"],
  ["POST", /^\/categories$/, "category", "create"],
  ["PATCH", /^\/categories\/(\d+)$/, "category", "update"],
  ["POST", /^\/categories\/(\d+)\/move$/, "category", "move"],
  ["DELETE", /^\/categories\/(\d+)$/, "category", "delete"],
  ["PUT", /^\/budget\/(\d{4}-\d{2})\/categories\/(\d+)$/, "budget", "update"],
  ["POST", /^\/budget\/(\d{4}-\d{2})\/copy-last-month$/, "budget", "copy"],
  ["PATCH", /^\/payees\/(\d+)$/, "payee", "update"],
  ["POST", /^\/payees\/merge$/, "payee", "merge"],
  ["DELETE", /^\/payees\/(\d+)$/, "payee", "delete"],
  ["POST", /^\/payees\/delete-unused$/, "payee", "delete-unused"],
  ["POST", /^\/scheduled-bills$/, "bill", "create"],
  ["PATCH", /^\/scheduled-bills\/(\d+)$/, "bill", "update"],
  ["DELETE", /^\/scheduled-bills\/(\d+)$/, "bill", "delete"],
  ["POST", /^\/investments\/securities$/, "security", "create"],
  ["PATCH", /^\/investments\/securities\/(\d+)$/, "security", "update"],
  ["DELETE", /^\/investments\/securities\/(\d+)$/, "security", "delete"],
  ["POST", /^\/investments\/securities\/(\d+)\/prices$/, "price", "create"],
  ["POST", /^\/investments\/transactions$/, "investment", "create"],
  ["PUT", /^\/investments\/transactions\/(\d+)$/, "investment", "update"],
  ["DELETE", /^\/investments\/transactions\/(\d+)$/, "investment", "delete"],
  ["POST", /^\/import\/(gnucash|bank|fund)\/[^/]+\/commit$/, "import", "import"],
  ["POST", /^\/import\/batches\/(\d+)\/undo$/, "import", "undo"],
  ["PATCH", /^\/household$/, "household", "update"],
  ["POST", /^\/household\/users\/(\d+)\/password$/, "member", "reset-password"],
  ["POST", /^\/household\/users\/(\d+)\/disable$/, "member", "disable"],
  ["POST", /^\/household\/users\/(\d+)\/enable$/, "member", "enable"],
  ["POST", /^\/household\/invites$/, "member", "invite"],
];

/** Which audited change a request is, or null for requests that aren't audited. */
export function auditTarget(method: string, path: string): Target | null {
  const rel = path.replace(/^\/api/, "");
  for (const [m, pattern, entity, action] of ROUTES) {
    if (m !== method) continue;
    const match = pattern.exec(rel);
    if (!match) continue;
    if (entity === "budget") {
      return { entity, action, month: match[1], id: match[2] ? Number(match[2]) : null };
    }
    const id = match[1] && /^\d+$/.test(match[1]) ? Number(match[1]) : null;
    return { entity, action, id };
  }
  return null;
}

/** The account a row belongs to, for the private-account rule. */
function accountIdOf(entity: AuditEntity, row: Row | null): number | null {
  if (!row) return null;
  if (entity === "account") return Number(row.id);
  if (entity === "transaction" || entity === "bill" || entity === "investment") return Number(row.accountId);
  return null;
}

/**
 * Whether changes to this account are kept private from the owner's report: it's another member's
 * private account. The owner's own private accounts aren't hidden from the owner.
 */
export function isOthersPrivate(db: DbOrTx, householdId: number, accountId: number | null) {
  if (accountId === null) return false;
  const account = db.select({ ownerId: accounts.ownerId }).from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account?.ownerId) return false;
  const owner = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.householdId, householdId), eq(users.role, "owner")))
    .get();
  return account.ownerId !== owner?.id;
}

const PRIVATE_SUMMARY: Record<string, string> = {
  transaction: "a transaction in a private account",
  account: "a private account",
  bill: "a recurring bill in a private account",
  investment: "an investment transaction in a private account",
};

function summarize(
  db: DbOrTx,
  householdId: number,
  t: Target,
  rows: { before: Row | null; after: Row | null; changes: Record<string, unknown> },
  body: Row | null,
  result: Row | null,
): string {
  const what = label(db, householdId, t.entity, rows.after ?? rows.before);
  const fields = Object.keys(rows.changes);
  switch (t.action) {
    case "create":
      if (t.entity === "price") {
        const sym = db.select({ s: securities.symbol }).from(securities).where(eq(securities.id, t.id!)).get()?.s;
        return `Entered a price for ${sym ?? "a security"} on ${usDate(String(body?.date ?? ""))}`;
      }
      return `Added ${t.entity}: ${what}`;
    case "update": {
      if (t.entity === "budget") {
        const money = (c: unknown) => formatCents(Number(c), currencyOf(db, householdId) ?? "USD");
        return `Changed budget for ${what}: ${money(rows.before?.amount)} → ${money(rows.after?.amount)}`;
      }
      return `Changed ${t.entity}: ${what}${fields.length ? ` (${fields.join(", ")})` : ""}`;
    }
    case "delete":
      return `Deleted ${t.entity}: ${what}`;
    case "move":
      return `Reordered ${t.entity === "folder" ? "accounts and folders" : `${t.entity}: ${what}`}`.trim();
    case "reconcile":
      return `Reconciled ${what}`;
    case "copy":
      return `Copied last month's budget into ${formatMonth(t.month!)}`;
    case "merge": {
      const target = nameOf(db, payees, body?.targetId);
      const n = Array.isArray(body?.sourceIds) ? body.sourceIds.length : 0;
      return `Merged ${n} payee${n === 1 ? "" : "s"} into ${target ?? "another payee"}`;
    }
    case "delete-unused":
      return `Deleted ${Number(result?.deleted ?? 0)} unused payees`;
    case "import":
    case "undo": {
      const batchId = t.action === "undo" ? t.id : Number(result?.batchId);
      const batch = Number.isFinite(batchId)
        ? db.select().from(importBatches).where(eq(importBatches.id, batchId!)).get()
        : undefined;
      const file = batch ? `${batch.fileName} (${batch.source})` : "a file";
      return t.action === "undo" ? `Undid the import of ${file}` : `Imported ${file}`;
    }
    case "reset-password":
      return `Reset the password for ${what}`;
    case "disable":
      return `Removed member ${what}`;
    case "enable":
      return `Restored member ${what}`;
    case "invite":
      return "Created an invite link";
    default:
      return `${VERBS[t.action] ?? t.action} ${t.entity}${what ? `: ${what}` : ""}`;
  }
}

/**
 * Record every successful change made through the API in the audit log: who, what, and the
 * values (the row before and after, or what was sent). Auth requests are logged instead, and
 * changes in another member's private account keep only who and when.
 */
export const auditMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const s = c.var.session;
  const t = s ? auditTarget(c.req.method, c.req.path) : null;
  if (!s || !t) return next();

  const db = c.var.db;
  const householdId = s.household.id;
  const load = (id: number | null) =>
    t.entity === "budget"
      ? id !== null
        ? loadBudget(db, householdId, id, t.month!)
        : null
      : id !== null || t.entity === "household"
        ? loadRow(db, householdId, t.entity, id ?? householdId)
        : null;

  let body: Row | null = null;
  if (c.req.header("content-type")?.includes("application/json")) {
    body = (await c.req.json().catch(() => null)) as Row | null;
  }
  const before = t.action === "create" && t.entity !== "price" ? null : load(t.id);
  const wasPrivate = isOthersPrivate(db, householdId, accountIdOf(t.entity, before));

  await next();
  if (c.res.status >= 400) return;

  try {
    let result: Row | null = null;
    if (c.res.headers.get("content-type")?.includes("json")) {
      result = (await c.res.clone().json().catch(() => null)) as Row | null;
    }
    const entityId = t.id ?? (typeof result?.id === "number" ? result.id : null);
    const after = t.action === "delete" ? null : t.entity === "price" ? null : load(entityId);
    const changes = t.action === "update" ? diff(before, after) : {};
    const isPrivate = wasPrivate || isOthersPrivate(db, householdId, accountIdOf(t.entity, after));

    let details: AuditDetails | null;
    if (t.action === "create" && t.entity !== "price") details = { after };
    else if (t.action === "update") details = { before, changes };
    else if (t.action === "delete") details = { before };
    else details = { changes: compact(body), after: compact(result) };

    recordAudit(db, {
      householdId,
      userId: s.user.id,
      action: t.action,
      entity: t.entity,
      entityId,
      summary: isPrivate
        ? `${VERBS[t.action] ?? "Changed"} ${PRIVATE_SUMMARY[t.entity] ?? t.entity}`
        : summarize(db, householdId, t, { before, after, changes }, body, result),
      details,
      private: isPrivate,
    });
  } catch (err) {
    c.var.log.error("http", `Couldn't record activity for ${c.req.method} ${c.req.path}`, {
      householdId,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }
});
