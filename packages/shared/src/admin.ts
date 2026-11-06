import { z } from "zod";

export const LOG_LEVELS = ["info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_SOURCES = ["server", "prices", "bills", "backup", "auth", "import", "http"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** What an Activity entry is about. */
export const AUDIT_ENTITIES = [
  "transaction",
  "account",
  "folder",
  "category",
  "category group",
  "budget",
  "payee",
  "bill",
  "security",
  "price",
  "investment",
  "import",
  "member",
  "household",
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

/** What was done in an Activity entry. */
export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "move",
  "reconcile",
  "copy",
  "merge",
  "delete-unused",
  "import",
  "undo",
  "reset-password",
  "disable",
  "enable",
  "invite",
  "join",
  "change-password",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The Summary's columns: the changes it counts one by one, per member. */
export const AUDIT_SUMMARY_COLUMNS: { label: string; entity: AuditEntity; action: AuditAction }[] = [
  { label: "Transactions added", entity: "transaction", action: "create" },
  { label: "Transactions changed", entity: "transaction", action: "update" },
  { label: "Transactions deleted", entity: "transaction", action: "delete" },
  { label: "Accounts added", entity: "account", action: "create" },
  { label: "Accounts deleted", entity: "account", action: "delete" },
];

/**
 * Groups of Activity entries: major changes (accounts, imports, members, the household, and
 * deleted categories, bills or securities), and other changes (none of the Summary's columns).
 */
export const AUDIT_GROUPS = ["major", "other"] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];

/** One page of a report: newest first; pass `next` as `before` to get the following page. */
export interface Page<T> {
  items: T[];
  next: number | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  /** Null when the app did it on its own, e.g. a recurring bill. */
  userId: number | null;
  userName: string | null;
  action: string;
  entity: string;
  entityId: number | null;
  summary: string;
  /** Withheld (null) for changes in another member's private account. */
  details: AuditDetails | null;
  private: boolean;
}

export interface AuditDetails {
  /** The item before an edit or delete. */
  before?: unknown;
  /** What the request set. */
  changes?: unknown;
  /** The item as created. */
  after?: unknown;
}

/** How many changes of one kind one member made (userId null: the app on its own). */
export interface AuditCount {
  userId: number | null;
  userName: string | null;
  entity: string;
  action: string;
  count: number;
}

/** The Summary report: changes counted by member. Major changes are listed with `group: "major"`. */
export interface AuditSummary {
  counts: AuditCount[];
}

export interface LogEntry {
  id: number;
  at: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  details: unknown;
}

const id = z.coerce.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

export const auditQuery = z.object({
  userId: id.optional(),
  entity: z.enum(AUDIT_ENTITIES).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  group: z.enum(AUDIT_GROUPS).optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** Activity report filters, as the web app sends them. */
export interface AuditFilters {
  userId?: number;
  entity?: AuditEntity;
  action?: AuditAction;
  group?: AuditGroup;
  from?: string;
  to?: string;
  q?: string;
}

export const auditSummaryQuery = z.object({ from: day.optional(), to: day.optional() });
export type AuditSummaryFilters = z.infer<typeof auditSummaryQuery>;

export const logQuery = z.object({
  level: z.enum(LOG_LEVELS).optional(),
  source: z.enum(LOG_SOURCES).optional(),
  q: z.string().trim().max(100).optional(),
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** Logs report filters, as the web app sends them. */
export interface LogFilters {
  level?: LogLevel;
  source?: LogSource;
  q?: string;
}
