import { formatCents, type Account, type CategoryGroup, type Payee, type Transaction } from "@fd/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { formatDate, useLedgerMutation } from "../ledger";
import {
  categoryText,
  choosesBudget,
  type LinkedKind,
  LinkedNotice,
  linkedKind,
  matchesSearch,
  payeeLabel,
  useLookups,
} from "./registerModel";
import { TransactionEditor } from "./TransactionEditor";

/** The register for phones: two-line rows, tap one to edit it in a dialog. */
export function MobileRegister(props: {
  account: Account;
  accounts: Account[];
  transactions: Transaction[];
  payees: Payee[];
  categories: CategoryGroup[];
  search: string;
  /** Whether the dialog for a new transaction is open. */
  adding: boolean;
  onAdd: () => void;
  onCloseAdding: () => void;
}) {
  const { account, transactions } = props;
  const lookups = useLookups(account, props.accounts, props.payees, props.categories);
  const showCategory = account.onBudget;
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [linkedNotice, setLinkedNotice] = useState<LinkedKind | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const update = useLedgerMutation(({ id, body }: { id: number; body: unknown }) =>
    api.patch(`/transactions/${id}`, body),
  );

  useEffect(() => {
    setEditing(null);
    setLinkedNotice(null);
  }, [account.id]);

  const rows = useMemo(() => {
    const q = props.search.trim().toLowerCase();
    return q ? transactions.filter((t) => matchesSearch(lookups, t, q, showCategory)) : transactions;
  }, [transactions, props.search, lookups, showCategory]);

  function open(t: Transaction) {
    const linked = linkedKind(t);
    if (linked) return setLinkedNotice(linked);
    if (t.reconciled && !confirm("This transaction is reconciled. Edit it anyway?")) return;
    setLinkedNotice(null);
    setEditing(t);
  }

  function toggleCleared(t: Transaction) {
    if (t.reconciled && !confirm("This transaction is reconciled. Unlock it?")) return;
    setSaveError(null);
    update.mutate({ id: t.id, body: { cleared: !t.cleared } }, { onError: (err) => setSaveError(err.message) });
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 10,
    getItemKey: (i) => rows[i]!.id,
  });

  return (
    <div className="mobile-register">
      {saveError && (
        <p className="error-text register-banner" role="alert">
          Couldn't save: {saveError}
        </p>
      )}
      {linkedNotice && <LinkedNotice kind={linkedNotice} onDismiss={() => setLinkedNotice(null)} />}
      <div className="mobile-register-scroll" ref={scrollRef}>
        {rows.length === 0 ? (
          <div className="register-empty muted">
            {props.search ? "No transactions match your search." : "No transactions yet. Tap + to add one."}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const t = rows[v.index]!;
              const payee = payeeLabel(t.payeeId != null ? lookups.payeeById.get(t.payeeId) : undefined);
              const category = showCategory ? categoryText(lookups, t) : "";
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="register-virtual-row"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <div className="m-row">
                    <button
                      type="button"
                      className="m-row-main"
                      onClick={() => open(t)}
                      aria-label={
                        `${formatDate(t.date)}, ${payee || "no payee"}, ${formatCents(t.amount)}. ` + "Tap to edit."
                      }
                    >
                      <span className="m-row-top">
                        <span className="truncate">{payee || t.notes || <span className="muted">No payee</span>}</span>
                        <span className={t.amount > 0 ? "amount positive" : "amount"}>{formatCents(t.amount)}</span>
                      </span>
                      <span className="m-row-bottom muted">
                        <span className="truncate">
                          {formatDate(t.date)}
                          {category === null ? (
                            <>
                              {" · "}
                              <span className="uncategorized">Uncategorized</span>
                            </>
                          ) : category ? (
                            ` · ${category}`
                          ) : null}
                          {choosesBudget(account) && t.inBudget && " · Family"}
                        </span>
                        <span className={t.runningBalance < 0 ? "amount negative" : "amount"}>
                          {formatCents(t.runningBalance)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={
                        t.reconciled ? "cleared-toggle reconciled" : t.cleared ? "cleared-toggle on" : "cleared-toggle"
                      }
                      aria-label={t.reconciled ? "Reconciled" : t.cleared ? "Cleared" : "Not cleared"}
                      title={t.reconciled ? "Reconciled" : t.cleared ? "Cleared" : "Not cleared"}
                      onClick={() => toggleCleared(t)}
                    >
                      {t.reconciled ? "🔒" : "✓"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <button type="button" className="fab" aria-label="Add transaction" title="Add transaction" onClick={props.onAdd}>
        +
      </button>
      {props.adding && <TransactionEditor lookups={lookups} onClose={props.onCloseAdding} />}
      {editing && (
        <TransactionEditor
          key={editing.id}
          lookups={lookups}
          transaction={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
