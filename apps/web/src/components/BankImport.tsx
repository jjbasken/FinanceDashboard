import {
  CSV_DATE_FORMATS,
  formatCents,
  type BankPreview,
  type BankUpload,
  type CsvDateFormat,
  type CsvMapping,
} from "@fd/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatDate, useAccounts, useCategories, useLedgerMutation } from "../ledger";

const STATUS_LABELS = { new: "New", match: "Matches", duplicate: "Already imported" } as const;

function ColumnSelect(props: {
  label: string;
  value: number | null;
  columns: string[];
  optional?: boolean;
  onChange: (v: number | null) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? null : Number(e.target.value))}
      >
        {props.optional && <option value="">None</option>}
        {props.columns.map((c, i) => (
          <option key={i} value={i}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

function CsvMappingEditor(props: { rows: string[][]; mapping: CsvMapping; onChange: (m: CsvMapping) => void }) {
  const m = props.mapping;
  const width = Math.max(...props.rows.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) =>
    m.hasHeader ? props.rows[0]?.[i] || `Column ${i + 1}` : `Column ${i + 1}`,
  );
  const split = m.amount === null;
  const set = (patch: Partial<CsvMapping>) => props.onChange({ ...m, ...patch });

  return (
    <div className="csv-mapping">
      <div className="table-scroll">
        <table className="data-table csv-sample">
          <tbody>
            {props.rows.slice(0, 6).map((r, i) => (
              <tr key={i} className={m.hasHeader && i === 0 ? "group-row" : undefined}>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c}>{r[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="checkbox inline">
        <input type="checkbox" checked={m.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })} />
        <span>The first row is a header</span>
      </label>
      <div className="mapping-grid">
        <ColumnSelect label="Date" value={m.date} columns={columns} onChange={(v) => set({ date: v ?? 0 })} />
        <label className="field">
          <span>Date format</span>
          <select value={m.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as CsvDateFormat })}>
            {CSV_DATE_FORMATS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <ColumnSelect label="Payee" value={m.payee} columns={columns} optional onChange={(v) => set({ payee: v })} />
        <ColumnSelect label="Notes" value={m.notes} columns={columns} optional onChange={(v) => set({ notes: v })} />
        <label className="field">
          <span>Amounts are in</span>
          <select
            value={split ? "split" : "one"}
            onChange={(e) =>
              e.target.value === "split"
                ? set({ amount: null, debit: m.debit ?? 0, credit: m.credit })
                : set({ amount: m.amount ?? m.debit ?? 0, debit: null, credit: null })
            }
          >
            <option value="one">One column</option>
            <option value="split">Separate debit and credit columns</option>
          </select>
        </label>
        {split ? (
          <>
            <ColumnSelect
              label="Debit (money out)"
              value={m.debit}
              columns={columns}
              optional
              onChange={(v) => set({ debit: v })}
            />
            <ColumnSelect
              label="Credit (money in)"
              value={m.credit}
              columns={columns}
              optional
              onChange={(v) => set({ credit: v })}
            />
          </>
        ) : (
          <ColumnSelect label="Amount" value={m.amount} columns={columns} onChange={(v) => set({ amount: v })} />
        )}
      </div>
      <label className="checkbox inline">
        <input type="checkbox" checked={m.invert} onChange={(e) => set({ invert: e.target.checked })} />
        <span>Spending is shown as positive numbers in this file (common for credit cards)</span>
      </label>
    </div>
  );
}

export function BankImport(props: { defaultAccountId?: number }) {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const categories = useCategories();
  const [accountId, setAccountId] = useState<number | null>(props.defaultAccountId ?? null);
  const [upload, setUpload] = useState<BankUpload | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | undefined>(undefined);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [chosen, setChosen] = useState<Record<string, number | null>>({});

  const open = (accounts.data ?? []).filter((a) => !a.closed);
  const account = open.find((a) => a.id === (accountId ?? open[0]?.id));

  const send = useMutation({
    mutationFn: (file: File) =>
      api.upload<BankUpload>(`/import/bank?accountId=${account!.id}&name=${encodeURIComponent(file.name)}`, file),
    onSuccess: (u) => {
      setUpload(u);
      setMapping(u.csv?.suggested);
      setChosen({});
    },
  });

  const preview = useQuery({
    queryKey: ["import", "bank", upload?.uploadId, mapping],
    queryFn: () => api.post<BankPreview>(`/import/bank/${upload!.uploadId}/preview`, { csv: mapping }),
    enabled: !!upload,
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Start with every new or matching row ticked.
  useEffect(() => {
    if (preview.data)
      setIncluded(new Set(preview.data.items.filter((i) => i.status !== "duplicate").map((i) => i.index)));
  }, [preview.data]);

  const commit = useLedgerMutation(() =>
    api.post<{ created: number; matched: number }>(`/import/bank/${upload!.uploadId}/commit`, {
      csv: mapping,
      include: [...included],
      categories: chosen,
    }),
  );

  function reset() {
    setUpload(null);
    send.reset();
    commit.reset();
  }

  if (commit.data) {
    return (
      <section className="card wide">
        <h2>Statement imported</h2>
        <p>
          Added {commit.data.created} transaction{commit.data.created === 1 ? "" : "s"}
          {commit.data.matched ? ` and matched ${commit.data.matched} that were already there` : ""} in {account?.name}.
        </p>
        <div>
          <button className="btn" onClick={reset}>
            Import another file
          </button>
        </div>
      </section>
    );
  }

  const items = preview.data?.items ?? [];
  const p = preview.data;
  return (
    <section className="card wide">
      <h2>Bank or card statement</h2>
      <p className="muted">
        Upload an OFX, QFX or CSV file downloaded from your bank. Transactions already imported are skipped, and ones
        already in the account (entered by hand or brought in from GnuCash) are matched instead of duplicated.
      </p>
      {!upload ? (
        <div className="field-row">
          <label className="field">
            <span>Into account</span>
            <select value={account?.id ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
              {open.map((a) => (
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
              accept=".ofx,.qfx,.csv,.txt"
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
            <strong>{upload.fileName}</strong> <span className="muted">into {account?.name}</span>
          </p>
          <button className="btn" onClick={reset}>
            Choose a different file
          </button>
        </div>
      )}
      {open.length === 0 && <p className="muted">Add an account first.</p>}
      {send.error && <p className="error-text">{send.error.message}</p>}

      {upload?.csv && mapping && <CsvMappingEditor rows={upload.csv.rows} mapping={mapping} onChange={setMapping} />}
      {preview.error && <p className="error-text">{preview.error.message}</p>}

      {p && (
        <>
          <p className={preview.isFetching ? "muted stale" : "muted"}>
            {p.counts.new} new · {p.counts.match} matching existing entries · {p.counts.duplicate} already imported
            {p.errors.length > 0 && ` · ${p.errors.length} unreadable row${p.errors.length === 1 ? "" : "s"}`}
          </p>
          {p.errors.length > 0 && (
            <ul className="import-warnings">
              {p.errors.slice(0, 5).map((e) => (
                <li key={e.line}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <div className="table-scroll bank-items">
            <table className="data-table">
              <thead>
                <tr>
                  <th />
                  <th>Date</th>
                  <th>Payee</th>
                  <th className="amount">Amount</th>
                  <th>Status</th>
                  {account?.onBudget && <th>Category</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.index} className={i.status === "duplicate" ? "muted" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Import ${i.payee}`}
                        disabled={i.status === "duplicate"}
                        checked={included.has(i.index)}
                        onChange={(e) => {
                          const next = new Set(included);
                          if (e.target.checked) next.add(i.index);
                          else next.delete(i.index);
                          setIncluded(next);
                        }}
                      />
                    </td>
                    <td>{formatDate(i.date)}</td>
                    <td className="truncate" title={i.notes}>
                      {i.payee}
                    </td>
                    <td className={i.amount < 0 ? "amount" : "amount positive"}>{formatCents(i.amount)}</td>
                    <td>
                      <span className={`status-badge ${i.status}`}>{STATUS_LABELS[i.status]}</span>
                      {i.status === "match" && (
                        <span className="muted small">
                          {" "}
                          {i.matchPayee ?? "no payee"}, {formatDate(i.matchDate!)}
                        </span>
                      )}
                    </td>
                    {account?.onBudget && (
                      <td>
                        {i.status === "new" && (
                          <select
                            aria-label={`Category for ${i.payee}`}
                            value={
                              String(i.index) in chosen
                                ? (chosen[String(i.index)] ?? "")
                                : (i.suggestedCategoryId ?? "")
                            }
                            onChange={(e) =>
                              setChosen({
                                ...chosen,
                                [String(i.index)]: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                          >
                            <option value="">Uncategorized</option>
                            {(categories.data ?? []).map((g) => (
                              <optgroup key={g.id} label={g.name}>
                                {g.categories
                                  .filter((c) => !c.hidden)
                                  .map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                          </select>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row-actions">
            <button
              className="btn btn-primary"
              disabled={included.size === 0 || commit.isPending || preview.isFetching}
              onClick={() =>
                commit.mutate(undefined, { onSuccess: () => qc.invalidateQueries({ queryKey: ["import", "batches"] }) })
              }
            >
              {commit.isPending ? "Importing…" : `Import ${included.size} transaction${included.size === 1 ? "" : "s"}`}
            </button>
            {commit.error && <span className="error-text">{commit.error.message}</span>}
          </div>
        </>
      )}
    </section>
  );
}
