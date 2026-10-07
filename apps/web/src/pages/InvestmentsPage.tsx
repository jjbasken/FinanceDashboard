import {
  formatCents,
  formatPrice,
  type InvestmentTxn,
  type PriceRefreshResult,
  type Security,
} from "@fd/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { HoldingsTable, InvestmentTxnTable, percent, useSecurityColors } from "../components/HoldingsTables";
import { AllocationBar, NEUTRAL, NEUTRAL_LIGHT, ValueChart, type Slice } from "../components/InvestmentCharts";
import { InvestmentTxnDialog, SecurityDialog } from "../components/InvestmentDialogs";
import { formatDate, useAccounts, useHoldings, useInvestmentTxns, useSecurities, useValueHistory } from "../ledger";

const RANGES = [
  ["3m", "3M"],
  ["1y", "1Y"],
  ["5y", "5Y"],
  ["all", "All"],
] as const;

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

  const colorOf = useSecurityColors(securities.data);

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
              <HoldingsTable
                accounts={summary.accounts}
                accountHeadings
                colorOf={colorOf}
                filter={filter}
                onFilter={setFilter}
              />
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
            <InvestmentTxnTable
              txns={shownTxns}
              securities={securities.data ?? []}
              accountName={(id) => accountName.get(id)}
              onEdit={setEditing}
            />
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
