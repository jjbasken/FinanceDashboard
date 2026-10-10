import { askConfirm } from "./Feedback";
import { formatCents, type Account, type Transaction } from "@fd/shared";
import { useState } from "react";
import { api } from "../api";
import { useLedgerMutation } from "../ledger";
import { Autocomplete } from "./Autocomplete";
import { Dialog } from "./Dialog";
import {
  amountOf,
  blankDraft,
  buildBody,
  choosesBudget,
  createPayee,
  deleteMessage,
  type Draft,
  draftFrom,
  isBudgetTransfer,
  isBudgetTransferTo,
  type Lookups,
  newSplitLine,
  payeeLabel,
  remainingOf,
  type SplitDraft,
  startSplit,
  transferLabel,
} from "./registerModel";

type Side = "payment" | "deposit";
const other = (side: Side): Side => (side === "payment" ? "deposit" : "payment");

/**
 * Amount text in the transaction's direction: "12.34" on that side, "-12.34" on the other.
 * Typing a leading minus puts the amount on the other side.
 */
function sidedText(f: { payment: string; deposit: string }, side: Side) {
  if (f[side].trim()) return f[side];
  return f[other(side)].trim() ? `-${f[other(side)]}` : "";
}

function fromSidedText(text: string, side: Side) {
  const negative = text.trim().startsWith("-");
  const value = negative ? text.trim().slice(1) : text;
  return { [negative ? other(side) : side]: value, [negative ? side : other(side)]: "" } as Record<Side, string>;
}

/** Add or edit a register transaction in a dialog, for phones. */
export function TransactionEditor(props: {
  lookups: Lookups;
  /** The transaction being edited; omit to add one. */
  transaction?: Transaction;
  onClose: () => void;
  initialCategory?: number; initialIncome?: boolean; initialDate?: string;
  accountOptions?: Account[]; onAccountChange?: (id: number) => void; onSaved?: () => void;
  /** Start a recurring bill from the transaction, as saved. */
  onMakeRecurring?: (t: Transaction) => void;
}) {
  const l = props.lookups;
  const t = props.transaction;
  const [original] = useState<Draft | undefined>(() =>
    t ? draftFrom(t, t.payeeId != null ? (l.payeeById.get(t.payeeId)?.name ?? "") : "") : undefined,
  );
  const [initial] = useState<Draft>(() => original ?? { ...blankDraft(props.initialDate), categoryId: props.initialCategory ?? null });
  const [d, setDraft] = useState<Draft>(initial);
  const [side, setSide] = useState<Side>(() => ((t ? t.amount > 0 : props.initialIncome) ? "deposit" : "payment"));
  const [transferMode, setTransferMode] = useState(() => !!(t?.payeeId && l.payeeById.get(t.payeeId)?.transferAccountId));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft(previous => ({ ...previous, ...patch }));
    setError(null);
  };

  const create = useLedgerMutation((body: unknown) => api.post("/transactions", body));
  const update = useLedgerMutation((body: unknown) => api.patch<Transaction>(`/transactions/${t!.id}`, body));
  const remove = useLedgerMutation(() => api.delete(`/transactions/${t!.id}`));
  const pending = create.isPending || update.isPending || remove.isPending;

  const showCategory = l.account.onBudget;
  const transfer = isBudgetTransfer(l, d.payeeId);
  const remaining = remainingOf(d);
  // A remaining amount in the transaction's direction is positive.
  const remainingShown = side === "deposit" ? remaining : -remaining;

  function flip(next: Side) {
    if (next === side) return;
    const swap = <T extends { payment: string; deposit: string }>(f: T): T => ({
      ...f,
      payment: f.deposit,
      deposit: f.payment,
    });
    // Keep each line's direction relative to the transaction, so a plain split stays plain.
    setDraft(previous => ({ ...swap(previous), splits: previous.splits.map(swap) }));
    setSide(next);
  }

  function setSplit(key: number, patch: Partial<SplitDraft>) {
    set({ splits: d.splits.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  }

  function removeSplit(key: number) {
    const rest = d.splits.filter((s) => s.key !== key);
    if (rest.length > 0) return set({ splits: rest });
    set({ split: false, splits: [] });
  }

  function save() {
    if (sidedText(d, side).trim().startsWith("-")) return setError("Enter a positive amount and choose Expense or Income.");
    if (transferMode && !l.payeeById.get(d.payeeId ?? -1)?.transferAccountId) return setError("Choose a destination account");
    if (!original && amountOf(d) === 0 && !d.payeeName && !d.payeeId) return setError("Enter an amount");
    const built = buildBody(d, original);
    if (built.error !== null) return setError(built.error);
    const done = { onSuccess: () => { props.onSaved?.(); props.onClose(); } };
    if (!t) return create.mutate({ accountId: l.account.id, ...built.body }, done);
    if (Object.keys(built.body).length === 0) return props.onClose();
    update.mutate(built.body, done);
  }

  /** Save any changes, then hand the saved transaction over to make a recurring bill from it. */
  function makeRecurring() {
    const built = buildBody(d, original);
    if (built.error !== null) return setError(built.error);
    if (Object.keys(built.body).length === 0) return props.onMakeRecurring!(t!);
    update.mutate(built.body, { onSuccess: (saved) => props.onMakeRecurring!(saved) });
  }

  async function del() {
    if ((await askConfirm(deleteMessage(t)))) remove.mutate(undefined, { onSuccess: props.onClose });
  }

  const categoryValue = transfer
    ? "Transfer"
    : d.categoryId != null
      ? (l.categoryName.get(d.categoryId) ?? "")
      : "";

  return (
    <Dialog
      title={t ? "Edit transaction" : transferMode ? "Record transfer" : side === "deposit" ? "Record income" : "Add purchase"}
      submitLabel={t ? "Save changes" : transferMode ? "Save transfer" : side === "deposit" ? "Save income" : "Save purchase"}
      dirty={JSON.stringify(d) !== JSON.stringify(initial)}
      onClose={props.onClose}
      onSubmit={save}
      pending={pending}
      error={error ?? (create.error ?? update.error ?? remove.error)?.message}
    >
      <div className="txn-form">
        <div className="field-row txn-amount-row">
          <div className="field">
            <span>Amount</span>
            <div className="txn-amount">
              <div className="segmented" role="group" aria-label="Direction">
                {(["expense", "income", "transfer"] as const).map(kind => <button key={kind} type="button"
                  aria-pressed={kind === "transfer" ? transferMode : !transferMode && side === (kind === "income" ? "deposit" : "payment")}
                  className={(kind === "transfer" ? transferMode : !transferMode && side === (kind === "income" ? "deposit" : "payment")) ? "active" : undefined}
                  onClick={async () => { setTransferMode(kind === "transfer"); flip(kind === "income" ? "deposit" : "payment"); if (kind !== "transfer" && transferMode) set({ payeeId: null, payeeName: "" }); }}>
                  {kind === "expense" ? "Expense" : kind === "income" ? "Income" : "Transfer"}
                </button>)}
              </div>
              <input
                aria-label="Amount"
                className="amount"
                autoFocus={!t}
                data-autofocus={!t || undefined}
                inputMode="decimal"
                placeholder="0.00"
                value={sidedText(d, side)}
                onChange={(e) => set(fromSidedText(e.target.value, side))}
              />
            </div>
          </div>
        </div>

        <div className="field">
          <span>{transferMode ? "Transfer to" : "Merchant or payee"}</span>
          <Autocomplete
            ariaLabel="Payee"
            value={d.payeeId != null ? payeeLabel(l.payeeById.get(d.payeeId)) : d.payeeName}
            options={l.payeeOptions.filter(o => transferMode === !!(o.value.id && l.payeeById.get(o.value.id)?.transferAccountId))}
            create={transferMode ? undefined : createPayee}
            onSelect={(v) => {
              const patch: Partial<Draft> = { payeeId: v.id, payeeName: v.name };
              if (isBudgetTransfer(l, v.id)) Object.assign(patch, { categoryId: null, split: false, splits: [] });
              else if (showCategory && !d.split && d.categoryId == null && v.id != null) {
                // Carry the payee's last category forward when none has been chosen yet.
                patch.categoryId = l.payeeById.get(v.id)?.lastCategoryId ?? null;
              }
              set(patch);
            }}
            onClear={() => set({ payeeId: null, payeeName: "" })}
            placeholder={transferMode ? "Choose destination account" : "Who did you pay?"}
          />
        </div>

        {showCategory && !d.split && (
          <div className="field">
            <span>Category</span>
            <div className="txn-category">
              <Autocomplete
                ariaLabel="Category"
                value={categoryValue}
                options={l.splitCategoryOptions}
                disabled={transfer}
                onSelect={(v) => set({ categoryId: v as number })}
                onClear={() => set({ categoryId: null })}
                placeholder={transfer ? "Transfer" : "Uncategorized"}
              />
              {!transfer && (
                <button type="button" className="link-button" onClick={async () => set(startSplit(d))}>
                  Split
                </button>
              )}
            </div>
          </div>
        )}

        {d.split && (
          <div className="field">
            <span>Split</span>
            <div className="txn-splits">
              {d.splits.map((s) => {
                const lineTransfer = isBudgetTransferTo(l, s.transferAccountId);
                return (
                  <div className="txn-split-card" key={s.key}>
                    <div className="txn-split">
                      {showCategory ? (
                        <Autocomplete
                          ariaLabel="Split category"
                          value={
                            lineTransfer
                              ? "Transfer"
                              : s.categoryId != null
                                ? (l.categoryName.get(s.categoryId) ?? "")
                                : ""
                          }
                          options={l.splitCategoryOptions}
                          disabled={lineTransfer}
                          onSelect={(v) => setSplit(s.key, { categoryId: v as number })}
                          onClear={() => setSplit(s.key, { categoryId: null })}
                          placeholder="Category"
                        />
                      ) : (
                        <span />
                      )}
                      <input
                        aria-label="Split amount"
                        className="amount"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={sidedText(s, side)}
                        onChange={(e) => setSplit(s.key, fromSidedText(e.target.value, side))}
                      />
                      <input
                        aria-label="Split notes"
                        className="txn-split-notes"
                        value={s.notes}
                        maxLength={1000}
                        onChange={(e) => setSplit(s.key, { notes: e.target.value })}
                        placeholder="Notes"
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Remove split"
                        title="Remove split"
                        onClick={async () => removeSplit(s.key)}
                      >
                        ×
                      </button>
                    </div>
                    {l.transferOptions.length > 0 && (
                      <Autocomplete
                        ariaLabel="Split transfer"
                        value={transferLabel(l, s.transferAccountId)}
                        options={l.transferOptions}
                        onSelect={(v) =>
                          setSplit(s.key, {
                            transferAccountId: v,
                            ...(isBudgetTransferTo(l, v) ? { categoryId: null } : {}),
                          })
                        }
                        onClear={() => setSplit(s.key, { transferAccountId: null })}
                        placeholder="Transfer to another account (optional)"
                      />
                    )}
                  </div>
                );
              })}
              <div className="txn-split-footer">
                <button
                  type="button"
                  className="link-button"
                  onClick={async () => set({ splits: [...d.splits, newSplitLine(d)] })}
                >
                  Add split
                </button>
                {remaining !== 0 && (
                  <span className="error-text">
                    {formatCents(Math.abs(remainingShown))} {remainingShown < 0 ? "over" : "left to assign"}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {props.accountOptions && <label className="field"><span>{transferMode ? "Transfer from" : side === "deposit" ? "Paid into" : "Paid from"}</span><select value={l.account.id} onChange={e => { props.onAccountChange?.(Number(e.target.value)); set({ payeeId: null, payeeName: "" }); }}>
          {props.accountOptions.map(a => <option key={a.id} value={a.id}>{a.name}{a.private ? " · Private" : ""}</option>)}
        </select></label>}
        <label className="field"><span>Date</span><input type="date" value={d.date} onChange={e => set({ date: e.target.value })} required /></label>
        {transferMode && <p className="muted">This records money moved between your accounts. It does not move money at your bank. Transfers within the budget are not spending; transfers out of the budget need a category.</p>}
        <details className="entry-details" open={d.split || undefined}><summary>More details: notes, splits & bank status</summary>
        <label className="field">
          <span>Notes</span>
          <input
            value={d.notes}
            maxLength={1000}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Optional"
          />
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={d.cleared} onChange={(e) => set({ cleared: e.target.checked })} />
          <span>Confirmed by bank <small className="muted">(cleared)</small></span>
        </label>
        </details>
        {choosesBudget(l.account) && (
          <label className="checkbox">
            <input type="checkbox" checked={d.inBudget} onChange={(e) => set({ inBudget: e.target.checked })} />
            <span>
              Include in family budget <small className="muted">(family money paid for this)</small>
            </span>
          </label>
        )}


        {t && (
          <div className="txn-editor-actions">
            {props.onMakeRecurring && (
              <button type="button" className="btn" onClick={makeRecurring} disabled={pending}>
                Make recurring
              </button>
            )}
            <button type="button" className="btn btn-danger-outline txn-delete" onClick={del} disabled={pending}>
              Delete transaction
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
