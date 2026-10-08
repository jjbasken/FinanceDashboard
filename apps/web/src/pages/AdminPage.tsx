import {
  AUDIT_ENTITIES,
  formatCents,
  LOG_LEVELS,
  LOG_SOURCES,
  type AuditDetails,
  type AuditEntity,
  type AuditEntry,
  type LogEntry,
  type LogLevel,
  type LogSource,
} from "@fd/shared";
import { Fragment, useState } from "react";
import { useAuthStatus } from "../auth";
import { useAppLogs, useAuditLog, useMembers } from "../ledger";

const when = (at: string) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A stored value, readably: money as money, nothing as a dash. */
function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number" && /amount|balance/i.test(key)) return formatCents(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Fields(props: { title: string; row: unknown }) {
  if (!props.row || typeof props.row !== "object") return null;
  const entries = Object.entries(props.row as Record<string, unknown>);
  if (!entries.length) return null;
  return (
    <div className="audit-fields">
      <h4>{props.title}</h4>
      <dl>
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{formatValue(k, v)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** What an Activity entry recorded: what changed (old → new), or the item as added or deleted. */
function AuditDetailsView(props: { entry: AuditEntry }) {
  const { entry } = props;
  if (entry.private) {
    return <p className="muted">This was in another member's private account, so only who and when are kept.</p>;
  }
  const d: AuditDetails = entry.details ?? {};
  const changes =
    entry.action === "update" && d.changes && typeof d.changes === "object"
      ? Object.entries(d.changes as Record<string, { from: unknown; to: unknown }>)
      : null;
  return (
    <div className="audit-details">
      {changes && (
        <div className="audit-fields">
          <h4>Changed</h4>
          {changes.length === 0 ? (
            <p className="muted">Nothing changed.</p>
          ) : (
            <dl>
              {changes.map(([k, c]) => (
                <Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>
                    {formatValue(k, c.from)} → <strong>{formatValue(k, c.to)}</strong>
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>
      )}
      {entry.action === "delete" && <Fields title="What was deleted" row={d.before} />}
      {entry.action === "create" && <Fields title="As added" row={d.after} />}
      {!["create", "update", "delete"].includes(entry.action) && (
        <>
          <Fields title="Sent" row={d.changes} />
          <Fields title="Result" row={d.after} />
        </>
      )}
    </div>
  );
}

function ActivityTab() {
  const members = useMembers();
  const [userId, setUserId] = useState("");
  const [entity, setEntity] = useState<AuditEntity | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const audit = useAuditLog({
    userId: userId ? Number(userId) : undefined,
    entity: entity || undefined,
    from: from || undefined,
    to: to || undefined,
    q: q.trim() || undefined,
  });
  const items = audit.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="card wide">
      <div className="report-filters">
        <select aria-label="Member" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Everyone</option>
          {members.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        <select aria-label="Kind" value={entity} onChange={(e) => setEntity(e.target.value as AuditEntity | "")}>
          <option value="">All kinds</option>
          {AUDIT_ENTITIES.map((x) => (
            <option key={x} value={x}>
              {x[0]!.toUpperCase() + x.slice(1)}
            </option>
          ))}
        </select>
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <input type="search" placeholder="Search" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {audit.error && <p className="error-text">{audit.error.message}</p>}
      <div className="table-scroll">
        <table className="data-table report-table">
          <thead>
            <tr>
              <th>When</th>
              <th className="report-detail">Who</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <Fragment key={e.id}>
                <tr
                  className={open === e.id ? "report-row selected" : "report-row"}
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                  aria-expanded={open === e.id}
                >
                  <td className="report-when">{when(e.at)}</td>
                  <td className="report-detail">{e.userName ?? <span className="muted">System</span>}</td>
                  <td className="report-what">
                    <span className="report-who">{e.userName ?? "System"} · </span>
                    {e.summary}
                    {e.private && <span className="badge report-badge">private</span>}
                  </td>
                </tr>
                {open === e.id && (
                  <tr className="report-expanded">
                    <td colSpan={3}>
                      <AuditDetailsView entry={e} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {audit.data && items.length === 0 && <p className="muted">No activity matches.</p>}
        {audit.isPending && <p className="muted">Loading…</p>}
      </div>
      {audit.hasNextPage && (
        <button className="btn" onClick={() => audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
          {audit.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

const SOURCE_LABELS: Record<LogSource, string> = {
  server: "Server",
  prices: "Prices",
  bills: "Recurring bills",
  backup: "Backups",
  auth: "Sign-ins",
  import: "Imports",
  http: "Errors",
};

function LogsTab() {
  const [level, setLevel] = useState<LogLevel | "">("");
  const [source, setSource] = useState<LogSource | "">("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const logs = useAppLogs({ level: level || undefined, source: source || undefined, q: q.trim() || undefined });
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];

  const detailText = (l: LogEntry) => {
    const { stack, ...rest } = (l.details ?? {}) as { stack?: string };
    return { rest: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null, stack };
  };

  return (
    <section className="card wide">
      <div className="report-filters">
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as LogLevel | "")}>
          <option value="">All levels</option>
          {LOG_LEVELS.map((x) => (
            <option key={x} value={x}>
              {x === "warn" ? "Warnings" : x === "error" ? "Errors" : "Info"}
            </option>
          ))}
        </select>
        <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as LogSource | "")}>
          <option value="">All sources</option>
          {LOG_SOURCES.map((x) => (
            <option key={x} value={x}>
              {SOURCE_LABELS[x]}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Search" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {logs.error && <p className="error-text">{logs.error.message}</p>}
      <div className="table-scroll">
        <table className="data-table report-table">
          <thead>
            <tr>
              <th>When</th>
              <th className="report-detail">Source</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => {
              const { rest, stack } = detailText(l);
              return (
                <Fragment key={l.id}>
                  <tr
                    className={`report-row log-${l.level}${open === l.id ? " selected" : ""}`}
                    onClick={() => setOpen(open === l.id ? null : l.id)}
                    aria-expanded={open === l.id}
                  >
                    <td className="report-when">{when(l.at)}</td>
                    <td className="report-detail">{SOURCE_LABELS[l.source]}</td>
                    <td className="report-what">
                      {l.level !== "info" && <span className={`badge log-badge ${l.level}`}>{l.level === "warn" ? "warning" : "error"}</span>}
                      <span className="report-who">{SOURCE_LABELS[l.source]} · </span>
                      {l.message}
                    </td>
                  </tr>
                  {open === l.id && (
                    <tr className="report-expanded">
                      <td colSpan={3}>
                        {rest || stack ? (
                          <>
                            {rest && <pre className="log-details">{rest}</pre>}
                            {stack && <pre className="log-details">{stack}</pre>}
                          </>
                        ) : (
                          <p className="muted">No more details.</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {logs.data && items.length === 0 && <p className="muted">No log entries match.</p>}
        {logs.isPending && <p className="muted">Loading…</p>}
      </div>
      {logs.hasNextPage && (
        <button className="btn" onClick={() => logs.fetchNextPage()} disabled={logs.isFetchingNextPage}>
          {logs.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

/** The owner's reports: who changed what, and what the server has been doing. */
export function AdminPage() {
  const { data: status } = useAuthStatus();
  const [tab, setTab] = useState<"activity" | "logs">("activity");

  if (status?.user?.role !== "owner") {
    return (
      <>
        <header className="page-header">
          <h1>Activity & logs</h1>
        </header>
        <div className="page-body">
          <p className="muted">Only the household owner can see this.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header budget-header">
        <h1>Activity & logs</h1>
        <div className="segmented" role="group" aria-label="Report">
          <button className={tab === "activity" ? "active" : undefined} onClick={() => setTab("activity")}>
            Activity
          </button>
          <button className={tab === "logs" ? "active" : undefined} onClick={() => setTab("logs")}>
            Logs
          </button>
        </div>
      </header>
      <div className="page-body investments">{tab === "activity" ? <ActivityTab /> : <LogsTab />}</div>
    </>
  );
}
