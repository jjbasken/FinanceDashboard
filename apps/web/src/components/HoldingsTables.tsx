import {
  INVESTMENT_ACTION_LABELS,
  formatCents,
  formatPrice,
  sharesToString,
  type AccountHoldings,
  type InvestmentTxn,
  type Security,
} from "@fd/shared";
import { useMemo } from "react";
import { Link } from "react-router";
import { formatDate } from "../ledger";
import { NEUTRAL, SERIES } from "./InvestmentCharts";

export const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "–");

/**
 * Each security keeps its color slot as long as it exists (by creation order), so colors never
 * repaint when values change. Past seven securities, the rest get null (shown as "Other").
 */
export function useSecurityColors(securities: Security[] | undefined) {
  return useMemo(() => {
    const ids = [...(securities ?? [])].sort((a, b) => a.id - b.id).map((s) => s.id);
    return (id: number) => {
      const i = ids.indexOf(id);
      return i >= 0 && i < SERIES.length ? SERIES[i]! : null;
    };
  }, [securities]);
}

/**
 * Holdings with shares, price, value, cost and gain, plus each account's cash. With more than one
 * account (or `accountHeadings`), each account gets a heading row linking to its page.
 */
export function HoldingsTable(props: {
  accounts: AccountHoldings[];
  accountHeadings?: boolean;
  colorOf: (securityId: number) => string | null;
  /** The holding whose transactions are shown; clicking a holding toggles it. */
  filter: number | null;
  onFilter: (securityId: number | null) => void;
}) {
  const headings = props.accountHeadings ?? props.accounts.length > 1;
  return (
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
        {props.accounts.map((a) => (
          <tbody key={a.accountId}>
            {headings && (
              <tr className="group-row">
                <td colSpan={3}>
                  <Link to={`/accounts/${a.accountId}`}>{a.accountName}</Link>
                </td>
                <td className="amount">{formatCents(a.value)}</td>
                <td colSpan={2} />
              </tr>
            )}
            {a.holdings.map((h) => (
              <tr key={h.securityId} className={props.filter === h.securityId ? "selected" : undefined}>
                <td>
                  <button
                    className="holding-name"
                    onClick={() => props.onFilter(props.filter === h.securityId ? null : h.securityId)}
                    title="Show this holding's transactions"
                  >
                    <span className="swatch" style={{ background: props.colorOf(h.securityId) ?? NEUTRAL }} />
                    <strong>{h.symbol}</strong> <span className="muted truncate">{h.name}</span>
                  </button>
                </td>
                <td className="amount">{sharesToString(h.shares)}</td>
                <td className="amount" title={h.priceDate ? `As of ${formatDate(h.priceDate)}` : "No price yet"}>
                  {h.price !== null ? formatPrice(h.price) : "–"}
                </td>
                <td className="amount">{formatCents(h.value)}</td>
                {h.costKnown ? (
                  <>
                    <td className="amount">{formatCents(h.cost)}</td>
                    <td className={h.gain >= 0 ? "amount positive" : "amount negative"}>
                      {formatCents(h.gain)} <span className="small">({percent(h.gain, h.cost)})</span>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="amount muted" title="Some shares came in without a cost basis">
                      Unknown
                    </td>
                    <td className="amount muted">–</td>
                  </>
                )}
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
  );
}

/** Buys, sells, dividends and the rest, newest first as given. Leave out `accountName` to hide that column. */
export function InvestmentTxnTable(props: {
  txns: InvestmentTxn[];
  securities: Security[];
  accountName?: (accountId: number) => string | undefined;
  onEdit: (txn: InvestmentTxn) => void;
}) {
  const secById = new Map(props.securities.map((s) => [s.id, s]));
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            {props.accountName && <th>Account</th>}
            <th>Action</th>
            <th>Security</th>
            <th className="amount">Shares</th>
            <th className="amount">Price</th>
            <th className="amount">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.txns.map((t) => (
            <tr key={t.id}>
              <td>{formatDate(t.date)}</td>
              {props.accountName && <td>{props.accountName(t.accountId)}</td>}
              <td>{INVESTMENT_ACTION_LABELS[t.action]}</td>
              <td>{secById.get(t.securityId)?.symbol}</td>
              <td className="amount">{t.shares ? sharesToString(t.shares) : ""}</td>
              <td className="amount">{t.price ? formatPrice(t.price) : ""}</td>
              <td className="amount">{t.amount ? formatCents(t.amount) : ""}</td>
              <td className="amount">
                <button className="link-button" onClick={() => props.onEdit(t)}>
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
