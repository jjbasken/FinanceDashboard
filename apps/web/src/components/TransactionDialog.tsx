import { centsToInput, formatCents, formatMonth, parseCents, type BudgetCategory } from "@fd/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { thisMonth, today, useAccounts, useCategories, useLedgerMutation, usePayees } from "../ledger";
import { Autocomplete, type Option } from "./Autocomplete";
import { Dialog } from "./Dialog";
import { createPayee } from "./Register";

const LAST_ACCOUNT_KEY = "fd.budget.lastAccount";

function lastAccount() {
  try {
    return Number(localStorage.getItem(LAST_ACCOUNT_KEY)) || null;
  } catch {
    return null;
  }
}

function rememberAccount(id: number) {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, String(id));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); it's only a convenience.
  }
}

interface SplitRow {
  key: number;
  categoryId: number | null;
  amount: string;
  notes: string;
}

let splitKey = 0;

/** Unsigned amount text, or 0 when blank; null if it isn't a number. */
const centsOf = (text: string) => (text.trim() ? parseCents(text) : 0);

/** Add a transaction against a budget category, from the Budget page. */
export function TransactionDialog(props: {
  category: BudgetCategory;
  isIncome: boolean;
  month: string;
  onClose: () => void;
}) {
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();

  const budgetAccounts = useMemo(() => (accounts.data ?? []).filter((a) => a.onBudget && !a.closed), [accounts.data]);
  const payeeOptions = useMemo<Option<{ id: number | null; name: string }>[]>(
    () =>
      (payees.data ?? [])
        .filter((p) => !p.transferAccountId)
        .map((p) => ({ key: `p${p.id}`, label: p.name, value: { id: p.id, name: p.name } })),
    [payees.data],
  );
  const { categoryOptions, categoryName } = useMemo(() => {
    const categoryName = new Map<number, string>();
    const categoryOptions: Option<number>[] = [];
    for (const g of categories.data ?? []) {
      for (const c of g.categories) {
        categoryName.set(c.id, c.name);
        if (!g.hidden && !c.hidden)
          categoryOptions.push({ key: `c${c.id}`, label: c.name, value: c.id, group: g.name });
      }
    }
    return { categoryOptions, categoryName };
  }, [categories.data]);

  const [chosenAccount, setChosenAccount] = useState<number | null>(lastAccount);
  const accountId = budgetAccounts.some((a) => a.id === chosenAccount)
    ? chosenAccount
    : (budgetAccounts[0]?.id ?? null);
  const [date, setDate] = useState(() => (props.month === thisMonth() ? today() : `${props.month}-01`));
  const [payee, setPayee] = useState<{ id: number | null; name: string }>({ id: null, name: "" });
  const [notes, setNotes] = useState("");
  const [deposit, setDeposit] = useState(props.isIncome);
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(props.category.id);
  const [splits, setSplits] = useState<SplitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useLedgerMutation((body: unknown) => api.post("/transactions", body));

  // A validation message is stale as soon as anything changes.
  useEffect(() => setError(null), [accountId, date, payee, notes, deposit, amount, categoryId, splits]);

  const total = centsOf(amount);
  const remaining =
    splits && total !== null ? total - splits.reduce((sum, s) => sum + (centsOf(s.amount) ?? 0), 0) : 0;

  function startSplit() {
    setSplits([
      { key: ++splitKey, categoryId, amount, notes: "" },
      { key: ++splitKey, categoryId: null, amount: "", notes: "" },
    ]);
  }

  function setSplit(key: number, patch: Partial<SplitRow>) {
    setSplits((rows) => rows!.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function addSplit() {
    const rest = remaining > 0 ? centsToInput(remaining) : "";
    setSplits((rows) => [...rows!, { key: ++splitKey, categoryId: null, amount: rest, notes: "" }]);
  }

  function removeSplit(key: number) {
    const rows = splits!.filter((s) => s.key !== key);
    if (rows.length > 1) return setSplits(rows);
    // Down to one row: it's a plain transaction again.
    setCategoryId(rows[0]?.categoryId ?? null);
    setSplits(null);
  }

  function submit() {
    if (!accountId) return setError("Pick an account");
    if (!date) return setError("Enter a date");
    if (total === null) return setError("Enter amounts as numbers, like 12.34");
    if (total === 0) return setError("Enter an amount");
    const sign = deposit ? 1 : -1;

    const body: Record<string, unknown> = {
      accountId,
      date,
      amount: sign * total,
      notes: notes.trim(),
      cleared: false,
      ...(payee.id != null ? { payeeId: payee.id } : payee.name.trim() ? { payeeName: payee.name.trim() } : {}),
    };
    if (splits) {
      const parsed = splits.map((s) => ({
        amount: centsOf(s.amount),
        categoryId: s.categoryId,
        notes: s.notes.trim(),
      }));
      if (parsed.some((s) => s.amount === null)) return setError("Enter split amounts as numbers, like 12.34");
      if (parsed.some((s) => s.categoryId == null)) return setError("Pick a category for each split");
      if (remaining !== 0) return setError("The splits must add up to the transaction amount");
      body.splits = parsed.map((s) => ({ ...s, amount: sign * s.amount! }));
    } else {
      if (categoryId == null) return setError("Pick a category");
      body.categoryId = categoryId;
    }

    setError(null);
    rememberAccount(accountId);
    create.mutate(body, { onSuccess: props.onClose });
  }

  const loadError = accounts.error ?? payees.error ?? categories.error;

  return (
    <Dialog
      title={`Add transaction: ${props.category.name}`}
      submitLabel="Add transaction"
      wide
      onClose={props.onClose}
      onSubmit={submit}
      pending={create.isPending}
      error={error ?? create.error?.message ?? loadError?.message}
    >
      <div className="txn-form">
        {accounts.data && budgetAccounts.length === 0 && (
          <p className="notice">There are no open on-budget accounts to pay from yet.</p>
        )}
        <div className="field-row">
          <label className="field">
            <span>Paid {deposit ? "into" : "from"}</span>
            <select value={accountId ?? ""} onChange={(e) => setChosenAccount(Number(e.target.value))}>
              {budgetAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>
        {date && date.slice(0, 7) !== props.month && (
          <small className="muted">
            This date is outside {formatMonth(props.month)}, so it will count toward {formatMonth(date.slice(0, 7))}.
          </small>
        )}

        <div className="field-row">
          <div className="field">
            <span>Payee</span>
            <Autocomplete
              ariaLabel="Payee"
              value={payee.name}
              options={payeeOptions}
              create={createPayee}
              onSelect={(v) => setPayee(v)}
              onClear={() => setPayee({ id: null, name: "" })}
              placeholder="Optional"
            />
          </div>
          <div className="field">
            <span>Amount</span>
            <div className="txn-amount">
              <div className="segmented" role="group" aria-label="Direction">
                <button type="button" className={deposit ? undefined : "active"} onClick={() => setDeposit(false)}>
                  Payment
                </button>
                <button type="button" className={deposit ? "active" : undefined} onClick={() => setDeposit(true)}>
                  Deposit
                </button>
              </div>
              <input
                aria-label="Amount"
                className="amount"
                inputMode="decimal"
                placeholder="0.00"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
        </div>

        <label className="field">
          <span>Notes</span>
          <input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>

        {!splits ? (
          <div className="field">
            <span>Category</span>
            <div className="txn-category">
              <Autocomplete
                ariaLabel="Category"
                value={categoryId != null ? (categoryName.get(categoryId) ?? "") : ""}
                options={categoryOptions}
                onSelect={(v) => setCategoryId(v)}
                onClear={() => setCategoryId(null)}
                placeholder="Category"
              />
              <button type="button" className="link-button" onClick={startSplit}>
                Split
              </button>
            </div>
          </div>
        ) : (
          <div className="field">
            <span>Split between categories</span>
            <div className="txn-splits">
              {splits.map((s) => (
                <div className="txn-split" key={s.key}>
                  <Autocomplete
                    ariaLabel="Split category"
                    value={s.categoryId != null ? (categoryName.get(s.categoryId) ?? "") : ""}
                    options={categoryOptions}
                    onSelect={(v) => setSplit(s.key, { categoryId: v })}
                    onClear={() => setSplit(s.key, { categoryId: null })}
                    placeholder="Category"
                  />
                  <input
                    aria-label="Split amount"
                    className="amount"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={s.amount}
                    onChange={(e) => setSplit(s.key, { amount: e.target.value })}
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
                    onClick={() => removeSplit(s.key)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="txn-split-footer">
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
          </div>
        )}
      </div>
    </Dialog>
  );
}
