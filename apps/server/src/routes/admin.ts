import {
  AUDIT_SUMMARY_COLUMNS,
  auditQuery,
  auditSummaryQuery,
  logQuery,
  type AuditCount,
  type AuditEntry,
  type AuditGroup,
  type AuditSummary,
  type LogEntry,
  type Page,
} from "@fd/shared";
import { and, count, desc, eq, gte, inArray, isNull, like, lt, not, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app";
import { appLog, auditLog, users } from "../db/schema";
import { requireAuth, requireOwner, sessionOf } from "../middleware";

/** Parse query parameters with a zod schema, returning 400 on bad input. */
function parseQuery<T extends typeof auditQuery | typeof auditSummaryQuery | typeof logQuery>(query: Record<string, string>, schema: T) {
  const result = schema.safeParse(query);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HTTPException(400, { message: first ? `${first.path.join(".")}: ${first.message}` : "Invalid query" });
  }
  return result.data as T["_output"];
}

/** The day after a YYYY-MM-DD date, so "to" includes the whole day. */
const nextDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** An Activity entry as the reports send it, with the member's name. */
const entryColumns = {
  id: auditLog.id,
  at: auditLog.at,
  userId: auditLog.userId,
  userName: users.displayName,
  action: auditLog.action,
  entity: auditLog.entity,
  entityId: auditLog.entityId,
  summary: auditLog.summary,
  details: auditLog.details,
  private: auditLog.private,
};

/** Entries in a group: major changes, or changes none of the Summary's columns count. */
function inGroup(group: AuditGroup): SQL | undefined {
  if (group === "major") {
    return or(
      inArray(auditLog.entity, ["account", "import", "member", "household"]),
      and(inArray(auditLog.entity, ["category", "category group", "bill", "security"]), eq(auditLog.action, "delete")),
    );
  }
  return not(or(...AUDIT_SUMMARY_COLUMNS.map((col) => and(eq(auditLog.entity, col.entity), eq(auditLog.action, col.action))))!);
}

/** The owner's reports: who changed what (Activity), and system events and errors (Logs). */
export const adminRoutes = new Hono<AppEnv>()
  .use(requireAuth, requireOwner)

  .get("/audit", (c) => {
    const q = parseQuery(c.req.query(), auditQuery);
    const { household } = sessionOf(c);
    const where: (SQL | undefined)[] = [eq(auditLog.householdId, household.id)];
    if (q.userId) where.push(eq(auditLog.userId, q.userId));
    if (q.entity) where.push(eq(auditLog.entity, q.entity));
    if (q.action) where.push(eq(auditLog.action, q.action));
    if (q.group) where.push(inGroup(q.group));
    if (q.from) where.push(gte(auditLog.at, q.from));
    if (q.to) where.push(lt(auditLog.at, nextDay(q.to)));
    if (q.q) where.push(like(auditLog.summary, `%${q.q}%`));
    if (q.before) where.push(lt(auditLog.id, q.before));
    const rows = c.var.db
      .select(entryColumns)
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(and(...where))
      .orderBy(desc(auditLog.id))
      .limit(q.limit + 1)
      .all();
    const items = rows.slice(0, q.limit) as AuditEntry[];
    const page: Page<AuditEntry> = { items, next: rows.length > q.limit ? items.at(-1)!.id : null };
    return c.json(page);
  })

  .get("/audit/summary", (c) => {
    const q = parseQuery(c.req.query(), auditSummaryQuery);
    const { household } = sessionOf(c);
    const where: (SQL | undefined)[] = [eq(auditLog.householdId, household.id)];
    if (q.from) where.push(gte(auditLog.at, q.from));
    if (q.to) where.push(lt(auditLog.at, nextDay(q.to)));
    const counts: AuditCount[] = c.var.db
      .select({
        userId: auditLog.userId,
        userName: users.displayName,
        entity: auditLog.entity,
        action: auditLog.action,
        count: count(),
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(and(...where))
      .groupBy(auditLog.userId, auditLog.entity, auditLog.action)
      .all();
    const summary: AuditSummary = { counts };
    return c.json(summary);
  })

  .get("/logs", (c) => {
    const q = parseQuery(c.req.query(), logQuery);
    const { household } = sessionOf(c);
    // This household's events, plus server-wide ones (start-ups, backups, price refreshes).
    const where: (SQL | undefined)[] = [or(eq(appLog.householdId, household.id), isNull(appLog.householdId))];
    if (q.level) where.push(eq(appLog.level, q.level));
    if (q.source) where.push(eq(appLog.source, q.source));
    if (q.q) where.push(like(appLog.message, `%${q.q}%`));
    if (q.before) where.push(lt(appLog.id, q.before));
    const rows = c.var.db
      .select({
        id: appLog.id,
        at: appLog.at,
        level: appLog.level,
        source: appLog.source,
        message: appLog.message,
        details: appLog.details,
      })
      .from(appLog)
      .where(and(...where))
      .orderBy(desc(appLog.id))
      .limit(q.limit + 1)
      .all();
    const items = rows.slice(0, q.limit) as LogEntry[];
    const page: Page<LogEntry> = { items, next: rows.length > q.limit ? items.at(-1)!.id : null };
    return c.json(page);
  });
