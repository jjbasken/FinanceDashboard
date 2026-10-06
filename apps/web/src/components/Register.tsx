import {
  centsToInput,
  formatCents,
  parseCents,
  type Account,
  type CategoryGroup,
  type Payee,
  type Transaction,
} from "@fd/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { formatDate, today, useLedgerMutation, useMembers } from "../ledger";
import { Autocomplete, type Option } from "./Autocomplete";

type Field = "date" | "payee" | "notes" | "category" | "payment" | "deposit";

interface SplitDraft {
  key: number;
  categoryId: number | null;
  notes: string;
  payment: string;
  deposit: string;
}

interface Draft {
  date: string;
  payeeId: number | null;
  payeeName: string;
  notes: string;
  categoryId: number | null;
  split: boolean;
  splits: SplitDraft[];
  payment: string;
  deposit: string;
  cleared: boolean;
}

type PayeeValue = { id: number | null; name: string };
type CategoryValue = number | "split";

let splitKey = 0;

/** Unsigned cents for the payment/deposit columns, e.g. -1234 -> "12.34". */
const plain = (cents: number) => centsToInput(Math.abs(cents));

function amountFields(amount: number) {
  if (amount < 0) return { payment: plain(amount), deposit: "" };
  if (amount > 0) return { payment: "", deposit: plain(amount) };
  return { payment: "", deposit: "" };
}

/** Deposit minus payment, or null if either field isn't a valid amount. */
function amountOf(f: { payment: string; deposit: string }) {
  const pay = f.payment.trim() ? parseCents(f.payment) : 0;
  const dep = f.deposit.trim() ? parseCents(f.deposit) : 0;
  if (pay === null || dep === null) return null;
  return dep - pay;
}

function blankDraft(date = today()): Draft {
  return {
    date,
    payeeId: null,
    payeeName: "",
    notes: "",
    categoryId: null,
    split: false,
    splits: [],
    payment: "",
    deposit: "",
    cleared: false,
  };
}

function draftFrom(t: Transaction, payeeName: string): Draft {
  return {
    date: t.date,
    payeeId: t.payeeId,
    payeeName,
    notes: t.notes,
    categoryId: t.categoryId,
    split: t.splits.length > 0,
    splits: t.splits.map((s) => ({
      key: ++splitKey,
      categoryId: s.categoryId,
      notes: s.notes,
      ...amountFields(s.amount),
    })),
    ...amountFields(t.amount),
    cleared: t.cleared,
  };
}

type Built = { error: string } | { error: null; body: Record<string, unknown> };

/** Validate a draft and turn it into an API body; with `original`, only the changed fields. */
function buildBody(d: Draft, original?: Draft): Built {
  if (!d.date) return { error: "Enter a date" };
  const amount = amountOf(d);
  if (amount === null) return { error: "Enter amounts as numbers, like 12.34" };

  const splits = d.split
    ? d.splits.map((s) => ({ amount: amountOf(s), categoryId: s.categoryId, notes: s.notes.trim() }))
    : [];
  if (splits.some((s) => s.amount === null)) return { error: "Enter split amounts as numbers, like 12.34" };
  if (d.split && splits.reduce((sum, s) => sum + s.amount!, 0) !== amount) {
    return { error: "The splits must add up to the transaction amount" };
  }

  const payee =
    d.payeeId != null
      ? { payeeId: d.payeeId }
      : d.payeeName.trim()
        ? { payeeName: d.payeeName.trim() }
        : { payeeId: null };
  const full: Record<string, unknown> = {
    date: d.date,
    amount,
    ...payee,
    notes: d.notes.trim(),
    categoryId: d.split ? null : d.categoryId,
    cleared: d.cleared,
    splits,
  };
  if (!original) return { error: null, body: full };

  const before = buildBody(original);
  if (before.error !== null) return { error: null, body: full };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === "payeeId" || k === "payeeName") continue;
    if (JSON.stringify(v) !== JSON.stringify(before.body[k])) body[k] = v;
  }
  if (d.payeeId !== original.payeeId || (d.payeeId == null && d.payeeName.trim() !== original.payeeName.trim())) {
    Object.assign(body, payee);
  }
  // Splits have to travel with the amount they add up to.
  if (body.amount !== undefined && (d.split || original.split)) body.splits = splits;
  if (body.splits !== undefined) body.amount = amount;
  return { error: null, body };
}

interface Lookups {
  account: Account;
  accounts: Account[];
  payeeById: Map<number, Payee>;
  payeeOptions: Option<PayeeValue>[];
  categoryName: Map<number, string>;
  categoryOptions: Option<CategoryValue>[];
  splitCategoryOptions: Option<CategoryValue>[];
}

function payeeLabel(p: Payee | undefined) {
  if (!p) return "";
  return p.transferAccountId ? `Transfer: ${p.name}` : p.name;
}

/** Transfers between two on-budget accounts don't take a category. */
function isBudgetTransfer(l: Lookups, payeeId: number | null) {
  const target = payeeId != null ? l.payeeById.get(payeeId)?.transferAccountId : null;
  if (!target) return false;
  return l.account.onBudget && !!l.accounts.find((a) => a.id === target)?.onBudget;
}

function useLookups(account: Account, accounts: Account[], payees: Payee[], groups: CategoryGroup[]): Lookups {
  return useMemo(() => {
    const payeeById = new Map(payees.map((p) => [p.id, p]));
    const open = new Set(accounts.filter((a) => !a.closed).map((a) => a.id));
    const regular = payees.filter((p) => !p.transferAccountId);
    const transfers = payees.filter(
      (p) => p.transferAccountId && p.transferAccountId !== account.id && open.has(p.transferAccountId),
    );
    const payeeOptions: Option<PayeeValue>[] = [
      ...regular.map((p) => ({ key: `p${p.id}`, label: p.name, value: { id: p.id, name: p.name }, group: "Payees" })),
      ...transfers.map((p) => ({
        key: `p${p.id}`,
        label: payeeLabel(p),
        value: { id: p.id, name: p.name },
        group: "Transfer to/from",
      })),
    ];

    const categoryName = new Map<number, string>();
    const splitCategoryOptions: Option<CategoryValue>[] = [];
    for (const g of groups) {
      for (const c of g.categories) {
        categoryName.set(c.id, c.name);
        if (!g.hidden && !c.hidden)
          splitCategoryOptions.push({ key: `c${c.id}`, label: c.name, value: c.id, group: g.name });
      }
    }
    const categoryOptions: Option<CategoryValue>[] = [
      { key: "split", label: "Split transaction", value: "split" },
      ...splitCategoryOptions,
    ];
    return { account, accounts, payeeById, payeeOptions, categoryName, categoryOptions, splitCategoryOptions };
  }, [account, accounts, payees, groups]);
}

const createPayee = (text: string): Option<PayeeValue> => ({
  key: "create",
  label: `Create payee “${text}”`,
  value: { id: null, name: text },
});

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
  const amount = amountOf(d);
  const remaining = d.split && amount !== null ? amount - d.splits.reduce((sum, s) => sum + (amountOf(s) ?? 0), 0) : 0;

  function chooseCategory(value: CategoryValue) {
    if (value !== "split") return set({ categoryId: value, split: false, splits: [] });
    if (d.split) return;
    const first: SplitDraft = {
      key: ++splitKey,
      categoryId: d.categoryId,
      notes: "",
      payment: d.payment,
      deposit: d.deposit,
    };
    set({
      split: true,
      categoryId: null,
      splits: [first, { key: ++splitKey, categoryId: null, notes: "", payment: "", deposit: "" }],
    });
  }

  function setSplit(key: number, patch: Partial<SplitDraft>) {
    set({ splits: d.splits.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  }

  function addSplit() {
    const rest = amountFields(remaining);
    set({ splits: [...d.splits, { key: ++splitKey, categoryId: null, notes: "", ...rest }] });
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
              <div className="cell" />
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
                  value={s.categoryId != null ? (l.categoryName.get(s.categoryId) ?? "") : ""}
                  options={l.splitCategoryOptions}
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
}) {
  const { t, lookups: l } = props;
  const payee = t.payeeId != null ? l.payeeById.get(t.payeeId) : undefined;
  let category: ReactNode;
  if (t.splits.length) category = <span className="muted">Split ({t.splits.length})</span>;
  else if (isBudgetTransfer(l, t.payeeId)) category = <span className="muted">Transfer</span>;
  else if (t.categoryId != null) category = l.categoryName.get(t.categoryId);
  else category = <span className="uncategorized">Uncategorized</span>;

  const cell = (field: Field, content: ReactNode, className = "cell") => (
    <div className={className} onClick={() => props.onEdit(field)}>
      {content}
    </div>
  );

  return (
    <div className="register-item" title={props.who}>
      <div className="register-row">
        {cell("date", formatDate(t.date))}
        {cell("payee", payeeLabel(payee), "cell truncate")}
        {cell("notes", t.notes, "cell truncate muted")}
        {props.showCategory && cell("category", category, "cell truncate")}
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
          <div className="cell" />
          <div className="cell truncate muted">{s.notes}</div>
          {props.showCategory && (
            <div className="cell truncate">
              {s.categoryId != null ? (
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
  const [linkedNotice, setLinkedNotice] = useState(false);

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
    return transactions.filter((t) => {
      const payee = payeeLabel(t.payeeId != null ? lookups.payeeById.get(t.payeeId) : undefined);
      const ids = t.splits.length ? t.splits.map((s) => s.categoryId) : [t.categoryId];
      const needsCategory = showCategory && !isBudgetTransfer(lookups, t.payeeId);
      const cats = ids
        .map((id) => (id != null ? (lookups.categoryName.get(id) ?? "") : needsCategory ? "uncategorized" : ""))
        .join(" ");
      const text = [payee, t.notes, ...t.splits.map((s) => s.notes), cats, plain(t.amount), formatDate(t.date)];
      return text.join(" ").toLowerCase().includes(q);
    });
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
    if (t.investmentTxnId) {
      setEditing(null);
      setLinkedNotice(true);
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
    const msg = t?.transferId ? "Delete this transfer? Both sides will be removed." : "Delete this transaction?";
    if (!confirm(msg)) return;
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
        }}
        onBlurOut={() => {}}
      />
      {saveError && (
        <p className="error-text register-banner" role="alert">
          Couldn't save: {saveError}
        </p>
      )}
      {linkedNotice && (
        <p className="notice register-notice" role="status">
          That row is the cash side of an investment transaction. Edit it on the{" "}
          <Link to="/investments">Investments page</Link>.{" "}
          <button className="link-button" onClick={() => setLinkedNotice(false)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="register-scroll" ref={scrollRef}>
        {rows.length === 0 ? (
          <div className="register-empty muted">
            {props.search ? "No transactions match your search." : "No transactions yet. Add one above."}
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
                      onCommit={commitEdit}
                      onCancel={() => setEditing(null)}
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
