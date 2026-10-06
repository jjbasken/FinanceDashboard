import { useMemo, useState } from "react";
import { api } from "../api";
import { useLedgerMutation, usePayees } from "../ledger";

export function PayeesPage() {
  const payees = usePayees();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState<number | "">("");
  const [message, setMessage] = useState<string | null>(null);

  const rename = useLedgerMutation(({ id, name }: { id: number; name: string }) =>
    api.patch(`/payees/${id}`, { name }),
  );
  const remove = useLedgerMutation((id: number) => api.delete(`/payees/${id}`));
  const merge = useLedgerMutation((body: { sourceIds: number[]; targetId: number }) =>
    api.post<{ moved: number }>("/payees/merge", body),
  );
  const prune = useLedgerMutation(() => api.post<{ deleted: number }>("/payees/delete-unused"));

  // Transfer payees follow their accounts, so only regular payees are managed here.
  const regular = useMemo(() => (payees.data ?? []).filter((p) => !p.transferAccountId), [payees.data]);
  const shown = regular.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));
  const unused = regular.filter((p) => p.transactionCount === 0).length;
  const error = payees.error ?? rename.error ?? remove.error ?? merge.error ?? prune.error;

  function toggle(id: number, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  function doMerge() {
    if (target === "") return;
    const sources = [...selected].filter((id) => id !== target);
    const into = regular.find((p) => p.id === target)!.name;
    if (!sources.length || !confirm(`Merge ${sources.length} payee${sources.length === 1 ? "" : "s"} into "${into}"?`))
      return;
    merge.mutate(
      { sourceIds: sources, targetId: target },
      {
        onSuccess: (r) => {
          setMessage(`Moved ${r.moved} transaction${r.moved === 1 ? "" : "s"} to "${into}".`);
          setSelected(new Set());
          setTarget("");
        },
      },
    );
  }

  return (
    <>
      <header className="page-header">
        <h1>Payees</h1>
      </header>
      <div className="page-body investments">
        <section className="card wide">
          <div className="payee-toolbar">
            <input
              type="search"
              placeholder="Search payees"
              aria-label="Search payees"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="spacer" />
            <button
              className="btn"
              disabled={unused === 0 || prune.isPending}
              onClick={() =>
                confirm(`Delete ${unused} payee${unused === 1 ? "" : "s"} no transaction uses?`) &&
                prune.mutate(undefined, { onSuccess: (r) => setMessage(`Deleted ${r.deleted} unused payees.`) })
              }
            >
              Delete unused ({unused})
            </button>
          </div>
          {selected.size > 0 && (
            <div className="payee-toolbar merge-bar">
              <span>{selected.size} selected. Merge them into</span>
              <select
                aria-label="Merge into"
                value={target}
                onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Choose a payee…</option>
                {regular
                  .filter((p) => selected.has(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <button
                className="btn btn-primary"
                disabled={target === "" || selected.size < 2 || merge.isPending}
                onClick={doMerge}
              >
                Merge
              </button>
              <button className="link-button" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </div>
          )}
          {message && <p className="notice">{message}</p>}
          {error && <p className="error-text">{error.message}</p>}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th />
                  <th>Payee</th>
                  <th className="amount">Transactions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className={selected.has(p.id) ? "selected" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.name}`}
                        checked={selected.has(p.id)}
                        onChange={(e) => toggle(p.id, e.target.checked)}
                      />
                    </td>
                    <td>{p.name}</td>
                    <td className="amount">{p.transactionCount}</td>
                    <td className="amount">
                      <span className="row-actions-cell">
                        <button
                          className="link-button"
                          onClick={() => {
                            const name = prompt("Rename payee", p.name)?.trim();
                            if (name && name !== p.name) rename.mutate({ id: p.id, name });
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="link-button danger"
                          onClick={() => {
                            const msg = p.transactionCount
                              ? `Delete "${p.name}"? Its ${p.transactionCount} transactions stay, without a payee.`
                              : `Delete "${p.name}"?`;
                            if (confirm(msg)) remove.mutate(p.id);
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <p className="muted">{search ? "No payees match." : "No payees yet."}</p>}
          </div>
        </section>
      </div>
    </>
  );
}
