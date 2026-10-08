import { formatCents, type Account, type CategoryGroup, type Payee, type Transaction } from "@fd/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { formatDate, today, useLedgerMutation, useMembers } from "../ledger";
import { Autocomplete } from "./Autocomplete";
import {
  BillMark,
  amountOf,
  blankDraft,
  buildBody,
  categoryText,
  type CategoryValue,
  choosesBudget,
  createPayee,
  deleteMessage,
  type Draft,
  draftFrom,
  isBudgetTransfer,
  isBudgetTransferTo,
  type LinkedKind,
  LinkedNotice,
  linkedKind,
  type Lookups,
  matchesSearch,
  newSplitLine,
  payeeLabel,
  remainingOf,
  type SplitDraft,
  startSplit,
  transferLabel,
  useLookups,
} from "./registerModel";

type Field = "date" | "payee" | "notes" | "category" | "payment" | "deposit";

function EditRow(props: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  lookups: Lookups;
  focus: { field: Field; n: number };
  isNew: boolean;
  error: string | null;
  showCategory: boolean;
  onCommit: (move: 0 | 1 | -1) => void;
  onCancel: () => void;
  onBlurOut: () => void;
  onDelete?: () => void;
  balance?: number;
}) {
  const { draft: d, setDraft, lookups: l } = props;
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });

  useEffect(() => {
    inputs.current[props.focus.field]?.focus();
  }, [props.focus]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLInputElement;
    if (e.key === "Enter" && target.tagName !== "BUTTON") {
      e.preventDefault();
      props.onCommit(props.isNew ? 0 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && target.type !== "date" && !props.isNew) {
      e.preventDefault();
      props.onCommit(e.key === "ArrowDown" ? 1 : -1);
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    props.onBlurOut();
  }

  const transfer = isBudgetTransfer(l, d.payeeId);
  const remaining = remainingOf(d);

  function chooseCategory(value: CategoryValue) {
    if (value !== "split") return set({ categoryId: value, split: false, splits: [] });
    if (!d.split) set(startSplit(d));
  }

  function setSplit(key: number, patch: Partial<SplitDraft>) {
    set({ splits: d.splits.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  }

  function addSplit() {
    set({ splits: [...d.splits, newSplitLine(d)] });
  }

  const register = (f: Field) => (el: HTMLInputElement | null) => {
    inputs.current[f] = el;
  };

  return (
    <div className={props.isNew ? "register-edit new" : "register-edit"} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="register-row">
        <div className="cell">
          <input
            ref={register("date")}
            className="cell-input"
            type="date"
            aria-label="Date"
            value={d.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </div>
        <div className="cell">
          <Autocomplete
            ariaLabel="Payee"
            inputRef={register("payee")}
            value={d.payeeId != null ? payeeLabel(l.payeeById.get(d.payeeId)) : d.payeeName}
            options={l.payeeOptions}
            create={createPayee}
            onSelect={(v) => {
              const patch: Partial<Draft> = { payeeId: v.id, payeeName: v.name };
              if (isBudgetTransfer(l, v.id)) Object.assign(patch, { categoryId: null, split: false, splits: [] });
              else if (props.showCategory && !d.split && d.categoryId == null && v.id != null) {
                // Carry the payee's last category forward when none has been chosen yet.
                patch.categoryId = l.payeeById.get(v.id)?.lastCategoryId ?? null;
              }
              set(patch);
            }}
            onClear={() => set({ payeeId: null, payeeName: "" })}
            placeholder="Payee"
          />
        </div>
        <div className="cell">
          <input
            ref={register("notes")}
            className="cell-input"
            aria-label="Notes"
            value={d.notes}
            maxLength={1000}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Notes"
          />
        </div>
        {props.showCategory && (
          <div className="cell">
            <Autocomplete
              ariaLabel="Category"
              inputRef={register("category")}
              value={
                transfer
                  ? "Transfer"
                  : d.split
                    ? "Split transaction"
                    : d.categoryId != null
                      ? (l.categoryName.get(d.categoryId) ?? "")
                      : ""
              }
              options={l.categoryOptions}
              disabled={transfer}
              onSelect={chooseCategory}
              onClear={() => set({ categoryId: null, split: false, splits: [] })}
              placeholder="Category"
            />
          </div>
        )}
        <div className="cell">
          <input
            ref={register("payment")}
            className="cell-input amount"
            aria-label="Payment"
            inputMode="decimal"
            value={d.payment}
            onChange={(e) => set({ payment: e.target.value, deposit: e.target.value ? "" : d.deposit })}
          />
        </div>
        <div className="cell">
          <input
            ref={register("deposit")}
            className="cell-input amount"
            aria-label="Deposit"
            inputMode="decimal"
            value={d.deposit}
            onChange={(e) => set({ deposit: e.target.value, payment: e.target.value ? "" : d.payment })}
          />
        </div>
        <div className="cell amount muted">{props.balance !== undefined ? formatCents(props.balance) : ""}</div>
        <div className="cell center">
          <input
            type="checkbox"
            aria-label="Cleared"
            checked={d.cleared}
            onChange={(e) => set({ cleared: e.target.checked })}
          />
        </div>
      </div>

      {d.split && (
        <div className="split-editor">
          {d.splits.map((s) => (
            <div className="register-row split-line" key={s.key}>
              <div className="cell" />
              <div className="cell">
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
                  placeholder="Transfer to…"
                />
              </div>
              <div className="cell">
                <input
                  className="cell-input"
                  aria-label="Split notes"
                  value={s.notes}
                  maxLength={1000}
                  onChange={(e) => setSplit(s.key, { notes: e.target.value })}
                  placeholder="Notes"
                />
              </div>
              <div className="cell">
                <Autocomplete
                  ariaLabel="Split category"
                  value={
                    isBudgetTransferTo(l, s.transferAccountId)
                      ? "Transfer"
                      : s.categoryId != null
                        ? (l.categoryName.get(s.categoryId) ?? "")
                        : ""
                  }
                  options={l.splitCategoryOptions}
                  disabled={isBudgetTransferTo(l, s.transferAccountId)}
                  onSelect={(v) => setSplit(s.key, { categoryId: v as number })}
                  onClear={() => setSplit(s.key, { categoryId: null })}
                  placeholder="Category"
                />
              </div>
              <div className="cell">
                <input
                  className="cell-input amount"
                  aria-label="Split payment"
                  inputMode="decimal"
                  value={s.payment}
                  onChange={(e) =>
                    setSplit(s.key, { payment: e.target.value, deposit: e.target.value ? "" : s.deposit })
                  }
                />
              </div>
              <div className="cell">
                <input
                  className="cell-input amount"
                  aria-label="Split deposit"
                  inputMode="decimal"
                  value={s.deposit}
                  onChange={(e) =>
                    setSplit(s.key, { deposit: e.target.value, payment: e.target.value ? "" : s.payment })
                  }
                />
              </div>
              <div className="cell" />
              <div className="cell center">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove split"
                  title="Remove split"
                  onClick={() => set({ splits: d.splits.filter((x) => x.key !== s.key) })}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          <div className="split-footer">
            <button type="button" className="link-button" onClick={addSplit}>
              Add split
            </button>
            {remaining !== 0 && (
              <span className="error-text">
                {formatCents(Math.abs(remaining))} {remaining < 0 ? "over" : "left to assign"}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="register-edit-actions">
        {choosesBudget(l.account) && (
          <label className="checkbox in-budget-toggle" title="Family money paid for this, so it counts in the family budget">
            <input type="checkbox" checked={d.inBudget} onChange={(e) => set({ inBudget: e.target.checked })} />
            <span>Include in family budget</span>
          </label>
        )}
        {props.error && (
          <span className="error-text" role="alert">
            {props.error}
          </span>
        )}
        <span className="muted hint">Enter to save · Esc to cancel</span>
        {props.onDelete && (
          <button type="button" className="btn btn-small btn-danger-outline" onClick={props.onDelete}>
            Delete
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" onClick={() => props.onCommit(0)}>
          {props.isNew ? "Add" : "Save"}
        </button>
      </div>
    </div>
  );
}

function DisplayRow(props: {
  t: Transaction;
  lookups: Lookups;
  showCategory: boolean;
  who: string;
  onEdit: (field: Field) => void;
  onToggleCleared: () => void;
  /** Move keyboard focus to the row above (-1) or below (1). */
  onMove: (step: 1 | -1) => void;
}) {
  const { t, lookups: l } = props;
  const payee = t.payeeId != null ? l.payeeById.get(t.payeeId) : undefined;
  const text = categoryText(l, t);
  const category: ReactNode =
    text === null ? (
      <span className="uncategorized">Uncategorized</span>
    ) : t.splits.length || text === "Transfer" ? (
      <span className="muted">{text}</span>
    ) : (
      text
    );

  const cell = (field: Field, content: ReactNode, className = "cell") => (
    <div className={className} onClick={() => props.onEdit(field)}>
      {content}
    </div>
  );

  return (
    <div
      className="register-item"
      title={props.who}
      tabIndex={0}
      data-row-id={t.id}
      aria-label={`${formatDate(t.date)}, ${payeeLabel(payee) || "no payee"}, ${formatCents(t.amount)}. Press Enter to edit.`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          props.onEdit("payee");
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          props.onMove(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === " ") {
          e.preventDefault();
          props.onToggleCleared();
        }
      }}
    >
      <div className={t.date > today() ? "register-row future" : "register-row"}>
        {cell(
          "date",
          <>
            {formatDate(t.date)}
            {t.scheduledBillId != null && <BillMark />}
          </>,
        )}
        {cell("payee", payeeLabel(payee), "cell truncate")}
        {cell("notes", t.notes, "cell truncate muted")}
        {props.showCategory &&
          cell(
            "category",
            <>
              {category}
              {choosesBudget(l.account) && t.inBudget && (
                <span className="family-badge" title="Counts in the family budget">
                  Family
                </span>
              )}
            </>,
            "cell truncate",
          )}
        {cell("payment", t.amount < 0 ? formatCents(-t.amount) : "", "cell amount")}
        {cell("deposit", t.amount > 0 ? formatCents(t.amount) : "", "cell amount positive")}
        <div className={t.runningBalance < 0 ? "cell amount negative" : "cell amount"}>
          {formatCents(t.runningBalance)}
        </div>
        <div className="cell center">
          <button
            type="button"
            className={t.reconciled ? "cleared-toggle reconciled" : t.cleared ? "cleared-toggle on" : "cleared-toggle"}
            aria-label={t.reconciled ? "Reconciled" : t.cleared ? "Cleared" : "Not cleared"}
            title={t.reconciled ? "Reconciled" : t.cleared ? "Cleared" : "Not cleared"}
            onClick={props.onToggleCleared}
          >
            {t.reconciled ? "🔒" : "✓"}
          </button>
        </div>
      </div>
      {t.splits.map((s) => (
        <div className="register-row split-line display" key={s.id} onClick={() => props.onEdit("category")}>
          <div className="cell" />
          <div className="cell truncate">{transferLabel(l, s.transferAccountId)}</div>
          <div className="cell truncate muted">{s.notes}</div>
          {props.showCategory && (
            <div className="cell truncate">
              {isBudgetTransferTo(l, s.transferAccountId) ? (
                <span className="muted">Transfer</span>
              ) : s.categoryId != null ? (
                l.categoryName.get(s.categoryId)
              ) : (
                <span className="uncategorized">Uncategorized</span>
              )}
            </div>
          )}
          <div className="cell amount">{s.amount < 0 ? formatCents(-s.amount) : ""}</div>
          <div className="cell amount positive">{s.amount > 0 ? formatCents(s.amount) : ""}</div>
          <div className="cell" />
          <div className="cell" />
        </div>
      ))}
    </div>
  );
}

export function Register(props: {
  account: Account;
  accounts: Account[];
  transactions: Transaction[];
  payees: Payee[];
  categories: CategoryGroup[];
  search: string;
  /** Whether the row for entering a new transaction is open. */
  adding: boolean;
  onCloseAdding: () => void;
}) {
  const { account, transactions } = props;
  const lookups = useLookups(account, props.accounts, props.payees, props.categories);
  const members = useMembers();
  const showCategory = account.onBudget;

  const [newDraft, setNewDraft] = useState(() => blankDraft());
  const [newFocus, setNewFocus] = useState<{ field: Field; n: number }>({ field: "date", n: 0 });
  const [newError, setNewError] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ id: number; original: Draft; focus: { field: Field; n: number } } | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState<Draft>(() => blankDraft());
  const [editError, setEditError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Why the row the user tried to edit has to be edited somewhere else. */
  const [linkedNotice, setLinkedNotice] = useState<LinkedKind | null>(null);

  // Reset the entry row when switching accounts.
  useEffect(() => {
    setNewDraft(blankDraft());
    setEditing(null);
    setNewError(null);
    setSaveError(null);
  }, [account.id]);

  const create = useLedgerMutation((body: unknown) => api.post<Transaction>("/transactions", body));
  const update = useLedgerMutation(({ id, body }: { id: number; body: unknown }) =>
    api.patch<Transaction>(`/transactions/${id}`, body),
  );
  const remove = useLedgerMutation((id: number) => api.delete(`/transactions/${id}`));
  const onSaveError = { onError: (err: Error) => setSaveError(err.message) };

  const rows = useMemo(() => {
    const q = props.search.trim().toLowerCase();
    if (!q) return transactions;
    return transactions.filter((t) => matchesSearch(lookups, t, q, showCategory));
  }, [transactions, props.search, lookups, showCategory]);

  const whoById = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.displayName])), [members.data]);
  function who(t: Transaction) {
    const by = t.createdBy != null ? whoById.get(t.createdBy) : undefined;
    const edited = t.updatedBy != null && t.updatedBy !== t.createdBy ? whoById.get(t.updatedBy) : undefined;
    if (!by) return "";
    return edited ? `Added by ${by}, last edited by ${edited}` : `Added by ${by}`;
  }

  function commitNew() {
    const built = buildBody(newDraft);
    if (built.error !== null) return setNewError(built.error);
    if (amountOf(newDraft) === 0 && !newDraft.payeeName && !newDraft.payeeId) {
      return setNewError("Enter an amount");
    }
    setNewError(null);
    setSaveError(null);
    create.mutate({ accountId: account.id, ...built.body }, onSaveError);
    setNewDraft(blankDraft(newDraft.date));
    setNewFocus((f) => ({ field: "date", n: f.n + 1 }));
  }

  function payeeNameOf(t: Transaction) {
    return t.payeeId != null ? (lookups.payeeById.get(t.payeeId)?.name ?? "") : "";
  }

  /** Focus a row by its position, scrolling the virtual list to it first. */
  function focusRow(index: number) {
    const row = rows[index];
    if (!row) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    requestAnimationFrame(() =>
      scrollRef.current?.querySelector<HTMLElement>(`.register-item[data-row-id="${row.id}"]`)?.focus(),
    );
  }

  function beginEdit(t: Transaction, field: Field) {
    const original = draftFrom(t, payeeNameOf(t));
    setEditing((e) => ({ id: t.id, original, focus: { field, n: (e?.focus.n ?? 0) + 1 } }));
    setEditDraft(original);
    setEditError(null);
  }

  /** Save the row being edited. Returns false (and shows why) if it isn't valid. */
  function saveEdit() {
    if (!editing) return true;
    const built = buildBody(editDraft, editing.original);
    if (built.error !== null) {
      setEditError(built.error);
      return false;
    }
    if (Object.keys(built.body).length) {
      setSaveError(null);
      update.mutate({ id: editing.id, body: built.body }, onSaveError);
    }
    return true;
  }

  function commitEdit(move: 0 | 1 | -1) {
    if (!editing || !saveEdit()) return;
    const index = rows.findIndex((t) => t.id === editing.id);
    const next = move ? rows[index + move] : undefined;
    if (next) beginEdit(next, editing.focus.field);
    else setEditing(null);
  }

  function startEdit(t: Transaction, field: Field) {
    if (editing?.id === t.id) return;
    if (editing && !saveEdit()) return;
    const linked = linkedKind(t);
    if (linked) {
      setEditing(null);
      setLinkedNotice(linked);
      return;
    }
    if (t.reconciled && !confirm("This transaction is reconciled. Edit it anyway?")) return;
    beginEdit(t, field);
  }

  function toggleCleared(t: Transaction) {
    if (t.reconciled && !confirm("This transaction is reconciled. Unlock it?")) return;
    update.mutate({ id: t.id, body: { cleared: !t.cleared } }, onSaveError);
  }

  function deleteEditing() {
    if (!editing) return;
    const t = transactions.find((x) => x.id === editing.id);
    if (!confirm(deleteMessage(t))) return;
    remove.mutate(editing.id, onSaveError);
    setEditing(null);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 37,
    overscan: 12,
    getItemKey: (i) => rows[i]!.id,
  });

  const gridClass = showCategory ? "register" : "register no-category";

  return (
    <div className={gridClass}>
      <div className="register-row register-header" role="row">
        <div className="cell">Date</div>
        <div className="cell">Payee</div>
        <div className="cell">Notes</div>
        {showCategory && <div className="cell">Category</div>}
        <div className="cell amount">Payment</div>
        <div className="cell amount">Deposit</div>
        <div className="cell amount">Balance</div>
        <div className="cell center" title="Cleared">
          ✓
        </div>
      </div>

      {props.adding && (
        <EditRow
          isNew
          draft={newDraft}
          setDraft={setNewDraft}
          lookups={lookups}
          focus={newFocus}
          error={newError}
          showCategory={showCategory}
          onCommit={commitNew}
          onCancel={() => {
            setNewDraft(blankDraft(newDraft.date));
            setNewError(null);
            props.onCloseAdding();
          }}
          onBlurOut={() => {}}
        />
      )}
      {saveError && (
        <p className="error-text register-banner" role="alert">
          Couldn't save: {saveError}
        </p>
      )}
      {linkedNotice && <LinkedNotice kind={linkedNotice} onDismiss={() => setLinkedNotice(null)} />}

      <div className="register-scroll" ref={scrollRef}>
        {rows.length === 0 ? (
          <div className="register-empty muted">
            {props.search ? "No transactions match your search." : "No transactions yet. Use Add transaction to enter one."}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const t = rows[v.index]!;
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="register-virtual-row"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  {editing?.id === t.id ? (
                    <EditRow
                      draft={editDraft}
                      setDraft={setEditDraft}
                      lookups={lookups}
                      focus={editing.focus}
                      isNew={false}
                      error={editError}
                      showCategory={showCategory}
                      balance={t.runningBalance}
                      onCommit={(move) => {
                        commitEdit(move);
                        if (move === 0) focusRow(v.index);
                      }}
                      onCancel={() => {
                        setEditing(null);
                        focusRow(v.index);
                      }}
                      onBlurOut={() => commitEdit(0)}
                      onDelete={deleteEditing}
                    />
                  ) : (
                    <DisplayRow
                      t={t}
                      lookups={lookups}
                      showCategory={showCategory}
                      who={who(t)}
                      onEdit={(field) => startEdit(t, field)}
                      onToggleCleared={() => toggleCleared(t)}
                      onMove={(step) => focusRow(v.index + step)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
