import type { LogLevel, LogSource } from "@fd/shared";
import { lt } from "drizzle-orm";
import type { DbOrTx } from "../db";
import { appLog } from "../db/schema";

export interface LogOptions {
  /** The household it concerns; leave out for server-wide events. */
  householdId?: number | null;
  details?: unknown;
}

type LogFn = (source: LogSource, message: string, options?: LogOptions) => void;
export type Logger = Record<LogLevel, LogFn>;

/** How long the Logs report keeps entries. */
export const LOG_RETENTION_DAYS = 90;

/** An Error's message and stack, as plain data that survives JSON. */
export function errorDetails(err: unknown) {
  return err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
}

/**
 * Write events to the app_log table, for the owner's Logs report, and optionally to the console
 * too (for `docker logs`). Logging never throws: if the database write fails, it says so on the
 * console and carries on.
 */
export function createLogger(db: DbOrTx, opts: { console?: boolean } = {}): Logger {
  const write = (level: LogLevel) => (source: LogSource, message: string, options: LogOptions = {}) => {
    if (opts.console) {
      const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      const stack = (options.details as { stack?: string } | undefined)?.stack;
      out(`[${source}] ${message}${stack ? `\n${stack}` : ""}`);
    }
    try {
      db.insert(appLog)
        .values({
          level,
          source,
          message,
          householdId: options.householdId ?? null,
          details: options.details === undefined ? null : options.details,
        })
        .run();
    } catch (err) {
      console.error("Couldn't write to the log table:", err);
    }
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** Delete log entries older than the retention period. The Activity (audit) log is kept forever. */
export function pruneLogs(db: DbOrTx, now = new Date()) {
  const cutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
  return db.delete(appLog).where(lt(appLog.at, cutoff)).returning({ id: appLog.id }).all().length;
}
