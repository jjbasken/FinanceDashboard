import {
  FUND_ACTIVITY_LABELS,
  formatCents,
  formatPrice,
  sharesToString,
  type FundImportResult,
  type FundStatementPreview,
} from "@fd/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { formatDate, useAccounts, useLedgerMutation } from "../ledger";

const shares = (micro: number | null) => (micro === null ? "—" : sharesToString(micro));

/** Import a 529 plan's (or similar fund company's) CSV download into an investment account. */
export function FundImport() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [accountId, setAccountId] = useState<number | null>(null);

  const choices = (accounts.data ?? []).filter((a) => !a.closed && a.type === "investment");
  const account = choices.find((a) => a.id === (accountId ?? choices[0]?.id));

  const send = useMutation({
    mutationFn: (file: File) =>
      api.upload<FundStatementPreview>(
        `/import/fund?accountId=${account!.id}&name=${encodeURIComponent(file.name)}`,
        file,
      ),
  });
  const p = send.data;
  const commit = useLedgerMutation(() => api.post<FundImportResult>(`/import/fund/${p!.uploadId}/commit`, {}));

  function reset() {
    send.reset();
    commit.reset();
  }

  if (commit.data && p) {
    const into = (accounts.data ?? []).find((a) => a.id === p.accountId);
    return (
      <section className="card wide">
        <h2>Fund statement imported</h2>
        <p>
          {commit.data.created
            ? `Added ${commit.data.created} investment transaction${commit.data.created === 1 ? "" : "s"} to ${into?.name}.`
            : "Nothing new to add; this statement was already imported."}
        </p>
        <div className="row-actions">
          <Link className="btn btn-primary" to={`/accounts/${p.accountId}`}>
            Go to {into?.name}
          </Link>
          <button className="btn" onClick={reset}>
            Import another file
          </button>
        </div>
      </section>
    );
  }

  const openings = p?.funds.filter((f) => f.openingShares > 0) ?? [];
  const mismatched = p?.funds.filter((f) => f.difference !== 0) ?? [];
  const total = (p?.counts.new ?? 0) + openings.length;

  return (
    <section className="card wide">
      <h2>529 or fund statement</h2>
      <p className="muted">
        Upload the CSV from your 529 plan's website, with its holdings and transaction history. Contributions are
        recorded as a deposit that buys shares, transactions already imported are skipped, and the first import adds
        opening shares so the account matches the statement.
      </p>
      {!p ? (
        <div className="field-row">
          <label className="field">
            <span>Into account</span>
            <select value={account?.id ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Statement file</span>
            <input
              type="file"
              accept=".csv,.txt"
              disabled={!account || send.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) send.mutate(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      ) : (
        <div className="import-summary">
          <p>
            <strong>{p.fileName}</strong> <span className="muted">into {account?.name}</span>
          </p>
          <button className="btn" onClick={reset}>
            Choose a different file
          </button>
        </div>
      )}
      {accounts.data && choices.length === 0 && (
        <p className="muted">Add an Investment account for the 529 first (Add account in the sidebar).</p>
      )}
      {send.error && <p className="error-text">{send.error.message}</p>}

      {p && (
        <>
          <p className="muted">
            {p.counts.new} new · {p.counts.duplicate} already imported
            {p.errors.length > 0 && ` · ${p.errors.length} row${p.errors.length === 1 ? "" : "s"} skipped`}
          </p>
          {(p.errors.length > 0 || mismatched.length > 0) && (
            <ul className="import-warnings">
              {p.errors.slice(0, 5).map((e) => (
                <li key={e.line}>
                  Line {e.line}: {e.message}
                </li>
              ))}
              {mismatched.map((f) => (
                <li key={f.name}>
                  {f.name}: the statement shows {shares(f.statementShares)} shares, but after this import the account
                  will have {shares(f.currentShares + f.importShares + f.openingShares)}. Some transactions may be
                  missing from the file.
                </li>
              ))}
            </ul>
          )}

          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fund</th>
                  <th>Symbol</th>
                  <th className="amount">Price</th>
                  <th className="amount">Statement shares</th>
                  <th className="amount">From transactions</th>
                  <th className="amount">Opening shares</th>
                </tr>
              </thead>
              <tbody>
                {p.funds.map((f) => (
                  <tr key={f.name}>
                    <td>{f.name}</td>
                    <td>
                      {f.symbol}
                      {f.securityId === null && <span className="muted small"> (new)</span>}
                    </td>
                    <td className="amount">{f.price === null ? "—" : formatPrice(f.price)}</td>
                    <td className="amount">{shares(f.statementShares)}</td>
                    <td className="amount">{shares(f.importShares)}</td>
                    <td className="amount">{f.openingShares ? shares(f.openingShares) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {openings.length > 0 && (
            <p className="muted small">
              Opening shares are dated {formatDate(p.openingDate)}, the day before the first transaction in the file,
              with no cost basis.
            </p>
          )}

          {p.items.length > 0 && (
            <div className="table-scroll bank-items">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Fund</th>
                    <th className="amount">Shares</th>
                    <th className="amount">Price</th>
                    <th className="amount">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((i) => (
                    <tr key={i.line} className={i.status === "duplicate" ? "muted" : undefined}>
                      <td>{formatDate(i.date)}</td>
                      <td title={i.type}>{FUND_ACTIVITY_LABELS[i.kind]}</td>
                      <td className="truncate">{i.fund}</td>
                      <td className="amount">{sharesToString(i.shares)}</td>
                      <td className="amount">{formatPrice(i.price)}</td>
                      <td className="amount">{formatCents(i.amount)}</td>
                      <td>
                        <span className={`status-badge ${i.status}`}>
                          {i.status === "new" ? "New" : "Already imported"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={total === 0 || commit.isPending}
              onClick={() =>
                commit.mutate(undefined, { onSuccess: () => qc.invalidateQueries({ queryKey: ["import", "batches"] }) })
              }
            >
              {commit.isPending
                ? "Importing…"
                : total === 0
                  ? "Nothing new to import"
                  : `Import ${total} transaction${total === 1 ? "" : "s"}`}
            </button>
            {commit.error && <span className="error-text">{commit.error.message}</span>}
          </div>
        </>
      )}
    </section>
  );
}
