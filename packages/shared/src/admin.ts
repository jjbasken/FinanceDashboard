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
  from?: string;
  to?: string;
  q?: string;
}

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
