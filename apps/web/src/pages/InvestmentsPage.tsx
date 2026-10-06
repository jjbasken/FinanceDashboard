import {
  INVESTMENT_ACTION_LABELS,
  formatCents,
  formatPrice,
  sharesToString,
  type InvestmentTxn,
  type PriceRefreshResult,
  type Security,
} from "@fd/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { AllocationBar, NEUTRAL, NEUTRAL_LIGHT, SERIES, ValueChart, type Slice } from "../components/InvestmentCharts";
import { InvestmentTxnDialog, SecurityDialog } from "../components/InvestmentDialogs";
import { formatDate, useAccounts, useHoldings, useInvestmentTxns, useSecurities, useValueHistory } from "../ledger";

const RANGES = [
  ["3m", "3M"],
  ["1y", "1Y"],
  ["5y", "5Y"],
  ["all", "All"],
] as const;

const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "–");

function Tile(props: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative";
  hero?: boolean;
}) {
  return (
    <div className={props.hero ? "stat-tile hero" : "stat-tile"}>
      <span className="muted">{props.label}</span>
      <strong className={props.tone}>{props.value}</strong>
      {props.detail && <span className="muted small">{props.detail}</span>}
    </div>
  );
}

export function InvestmentsPage() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const securities = useSecurities();
  const holdings = useHoldings();
  const txns = useInvestmentTxns();
  const [range, setRange] = useState("1y");
  const history = useValueHistory(range);
  const [editing, setEditing] = useState<InvestmentTxn | "new" | null>(null);
  const [securityDialog, setSecurityDialog] = useState<Security | "new" | null>(null);
  const [filter, setFilter] = useState<number | null>(null);

  const refresh = useMutation({
    mutationFn: () => api.post<PriceRefreshResult>("/investments/prices/refresh"),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["investments"] }).then(() => qc.invalidateQueries({ queryKey: ["accounts"] })),
  });

  // Each security keeps its color slot as long as it exists (by creation order), so colors never
  // repaint when values change. Past seven securities, the rest fold into "Other".
  const colorOf = useMemo(() => {
    const ids = [...(securities.data ?? [])].sort((a, b) => a.id - b.id).map((s) => s.id);
    return (id: number) => {
      const i = ids.indexOf(id);
      return i >= 0 && i < SERIES.length ? SERIES[i]! : null;
    };
  }, [securities.data]);

  const summary = holdings.data;
  const slices = useMemo<Slice[]>(() => {
    if (!summary) return [];
    const bySecurity = new Map<number, { symbol: string; name: string; value: number }>();
    for (const h of summary.accounts.flatMap((a) => a.holdings)) {
      const cur = bySecurity.get(h.securityId) ?? { symbol: h.symbol, name: h.name, value: 0 };
      cur.value += h.value;
      bySecurity.set(h.securityId, cur);
    }
    const out: Slice[] = [];
    let other = 0;
    for (const [id, s] of [...bySecurity].sort((a, b) => a[0] - b[0])) {
      const color = colorOf(id);
      if (color) out.push({ key: `s${id}`, label: s.symbol, sublabel: s.name, value: s.value, color });
      else other += s.value;
    }
    if (other > 0) out.push({ key: "other", label: "Other", value: other, color: NEUTRAL });
    if (summary.totals.cash > 0)
      out.push({ key: "cash", label: "Cash", value: summary.totals.cash, color: NEUTRAL_LIGHT });
    return out;
  }, [summary, colorOf]);

  const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const secById = new Map((securities.data ?? []).map((s) => [s.id, s]));
  const investAccounts = (accounts.data ?? [])
    .filter((a) => !a.closed)
    .sort((a, b) => Number(b.type === "investment") - Number(a.type === "investment"));
  const shownTxns = (txns.data ?? []).filter((t) => filter === null || t.securityId === filter);
  const error = accounts.error ?? securities.error ?? holdings.error ?? txns.error;
  const hasAnything = (summary?.accounts.length ?? 0) > 0 || (securities.data?.length ?? 0) > 0;

  return (
    <>
      <header className="page-header budget-header">
        <h1>Investments</h1>
        <div className="row-actions">
          <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh prices"}
          </button>
          <Link className="btn" to="/import">
            Import from GnuCash
          </Link>
          <button className="btn" onClick={() => setSecurityDialog("new")}>
            Add security
          </button>
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            Add transaction
          </button>
        </div>
      </header>
      <div className="page-body investments">
        {error && <p className="error-text">{error.message}</p>}
        {refresh.data && (
          <p className="notice">
            {refresh.data.updated
              ? `Fetched ${refresh.data.updated} new price${refresh.data.updated === 1 ? "" : "s"}.`
              : "Prices are up to date."}
            {refresh.data.errors.map((e) => ` ${e.symbol}: ${e.message}.`).join("")}
          </p>
        )}
        {refresh.error && <p className="error-text">{refresh.error.message}</p>}

        {!hasAnything && summary && (
          <div className="empty-state">
            <p>
              Track investments by adding an <strong>Investment</strong> account, then a security and your buys and
              sells. Or bring them in from GnuCash on the <Link to="/import">import page</Link>.
            </p>
          </div>
        )}

        {summary && hasAnything && (
          <>
            <div className="kpi-row">
              <Tile hero label="Total value" value={formatCents(summary.totals.value)} />
              <Tile
                label="Unrealized gain"
                value={formatCents(summary.totals.gain)}
                detail={`${percent(summary.totals.gain, summary.totals.cost)} on ${formatCents(summary.totals.cost)} cost`}
                tone={summary.totals.gain >= 0 ? "positive" : "negative"}
              />
              <Tile label="Holdings" value={formatCents(summary.totals.holdingsValue)} />
              <Tile label="Cash" value={formatCents(summary.totals.cash)} />
            </div>

            <section className="card wide">
              <div className="card-head">
                <h2>Value over time</h2>
                <div className="segmented" role="group" aria-label="Time range">
                  {RANGES.map(([key, label]) => (
                    <button key={key} className={range === key ? "active" : undefined} onClick={() => setRange(key)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {history.data && history.data.length > 1 ? (
                <ValueChart points={history.data} fineDates={range === "3m" || range === "1y"} />
              ) : (
                <p className="muted">Not enough history yet.</p>
              )}
            </section>

            <section className="card wide">
              <h2>Allocation</h2>
              <AllocationBar slices={slices} />
            </section>

            <section className="card wide">
              <h2>Holdings</h2>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Holding</th>
                      <th className="amount">Shares</th>
                      <th className="amount">Price</th>
                      <th className="amount">Value</th>
                      <th className="amount">Cost</th>
                      <th className="amount">Gain</th>
                    </tr>
                  </thead>
                  {summary.accounts.map((a) => (
                    <tbody key={a.accountId}>
                      <tr className="group-row">
                        <td colSpan={3}>
                          <Link to={`/accounts/${a.accountId}`}>{a.accountName}</Link>
                        </td>
                        <td className="amount">{formatCents(a.value)}</td>
                        <td colSpan={2} />
                      </tr>
                      {a.holdings.map((h) => (
                        <tr key={h.securityId} className={filter === h.securityId ? "selected" : undefined}>
                          <td>
                            <button
                              className="holding-name"
                              onClick={() => setFilter(filter === h.securityId ? null : h.securityId)}
                              title="Show this holding's transactions"
                            >
                              <span className="swatch" style={{ background: colorOf(h.securityId) ?? NEUTRAL }} />
                              <strong>{h.symbol}</strong> <span className="muted truncate">{h.name}</span>
                            </button>
                          </td>
                          <td className="amount">{sharesToString(h.shares)}</td>
                          <td
                            className="amount"
                            title={h.priceDate ? `As of ${formatDate(h.priceDate)}` : "No price yet"}
                          >
                            {h.price !== null ? formatPrice(h.price) : "–"}
                          </td>
                          <td className="amount">{formatCents(h.value)}</td>
                          <td className="amount">{formatCents(h.cost)}</td>
                          <td className={h.gain >= 0 ? "amount positive" : "amount negative"}>
                            {formatCents(h.gain)} <span className="small">({percent(h.gain, h.cost)})</span>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className="muted">Cash</td>
                        <td colSpan={2} />
                        <td className="amount">{formatCents(a.cash)}</td>
                        <td colSpan={2} />
                      </tr>
                    </tbody>
                  ))}
                </table>
              </div>
            </section>
          </>
        )}

        {(txns.data?.length ?? 0) > 0 && (
          <section className="card wide">
            <div className="card-head">
              <h2>Transactions{filter !== null && `: ${secById.get(filter)?.symbol ?? ""}`}</h2>
              {filter !== null && (
                <button className="link-button" onClick={() => setFilter(null)}>
                  Show all
                </button>
              )}
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Account</th>
                    <th>Action</th>
                    <th>Security</th>
                    <th className="amount">Shares</th>
                    <th className="amount">Price</th>
                    <th className="amount">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shownTxns.map((t) => (
                    <tr key={t.id}>
                      <td>{formatDate(t.date)}</td>
                      <td>{accountName.get(t.accountId)}</td>
                      <td>{INVESTMENT_ACTION_LABELS[t.action]}</td>
                      <td>{secById.get(t.securityId)?.symbol}</td>
                      <td className="amount">{t.shares ? sharesToString(t.shares) : ""}</td>
                      <td className="amount">{t.price ? formatPrice(t.price) : ""}</td>
                      <td className="amount">{t.amount ? formatCents(t.amount) : ""}</td>
                      <td className="amount">
                        <button className="link-button" onClick={() => setEditing(t)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {(securities.data?.length ?? 0) > 0 && (
          <section className="card wide">
            <h2>Securities</h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th className="amount">Latest price</th>
                    <th>Prices</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {securities.data!.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className="swatch" style={{ background: colorOf(s.id) ?? NEUTRAL }} />{" "}
                        <strong>{s.symbol}</strong>
                      </td>
                      <td>{s.name}</td>
                      <td className="amount">
                        {s.latestPrice !== null ? formatPrice(s.latestPrice) : "–"}
                        {s.latestPriceDate && <span className="muted small"> {formatDate(s.latestPriceDate)}</span>}
                      </td>
                      <td className="muted">{s.autoPrice ? "Automatic" : "Manual"}</td>
                      <td className="amount">
                        <button className="link-button" onClick={() => setSecurityDialog(s)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {editing && accounts.data && securities.data && (
        <InvestmentTxnDialog
          txn={editing === "new" ? undefined : editing}
          accounts={investAccounts}
          securities={securities.data}
          defaults={{ securityId: filter ?? undefined }}
          onClose={() => setEditing(null)}
          onAddSecurity={() => setSecurityDialog("new")}
        />
      )}
      {securityDialog && (
        <SecurityDialog
          security={securityDialog === "new" ? undefined : securityDialog}
          onClose={() => setSecurityDialog(null)}
        />
      )}
    </>
  );
}
