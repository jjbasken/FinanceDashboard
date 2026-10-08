import {
  centsToInput,
  describeSchedule,
  formatCents,
  parseCents,
  type BillFrequency,
  type ScheduledBill,
} from "@fd/shared";
import { useMemo, useState } from "react";
import { api } from "../api";
import { Autocomplete, type Option } from "../components/Autocomplete";
import { Dialog } from "../components/Dialog";
import { createPayee } from "../components/registerModel";
import {
  formatDate,
  today,
  useAccounts,
  useCategories,
  useLedgerMutation,
  usePayees,
  useScheduledBills,
} from "../ledger";

const FREQUENCY_LABELS: Record<BillFrequency, string> = {
  monthly: "Every month",
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  yearly: "Every year",
};

type PayeeChoice = { id: number | null; name: string };

/** Add or change a recurring bill. */
function BillDialog(props: { bill: ScheduledBill | null; onClose: () => void }) {
  const { bill } = props;
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();

  const openAccounts = useMemo(
    () => (accounts.data ?? []).filter((a) => !a.closed || a.id === bill?.accountId),
    [accounts.data, bill],
  );
  const payeeOptions = useMemo<Option<PayeeChoice>[]>(
    () =>
      (payees.data ?? []).map((p) => {
        const label = p.transferAccountId ? `Transfer: ${p.name}` : p.name;
        return { key: `p${p.id}`, label, value: { id: p.id, name: label } };
      }),
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

  const [chosenAccount, setChosenAccount] = useState<number | null>(bill?.accountId ?? null);
  const accountId = chosenAccount ?? openAccounts.find((a) => a.onBudget)?.id ?? openAccounts[0]?.id ?? null;
  const [payee, setPayee] = useState<PayeeChoice>(() => {
    const p = payees.data?.find((x) => x.id === bill?.payeeId);
    return p ? { id: p.id, name: p.transferAccountId ? `Transfer: ${p.name}` : p.name } : { id: null, name: "" };
  });
  const [deposit, setDeposit] = useState(bill ? bill.amount > 0 : false);
  const [amount, setAmount] = useState(bill ? centsToInput(Math.abs(bill.amount)) : "");
  const [categoryId, setCategoryId] = useState<number | null>(bill?.categoryId ?? null);
  const [notes, setNotes] = useState(bill?.notes ?? "");
  const [frequency, setFrequency] = useState<BillFrequency>(bill?.frequency ?? "monthly");
  const [startDate, setStartDate] = useState(bill?.startDate ?? today());
  const [endDate, setEndDate] = useState(bill?.endDate ?? "");
  const [paused, setPaused] = useState(bill?.paused ?? false);
  const [error, setError] = useState<string | null>(null);

  const save = useLedgerMutation((body: unknown) =>
    bill ? api.patch(`/scheduled-bills/${bill.id}`, body) : api.post("/scheduled-bills", body),
  );
  const remove = useLedgerMutation((id: number) => api.delete(`/scheduled-bills/${id}`));

  function submit() {
    const cents = amount.trim() ? parseCents(amount) : null;
    if (!accountId) return setError("Pick an account");
    if (cents === null || cents === 0) return setError("Enter an amount, like 12.34");
    if (!startDate) return setError("Enter the first due date");
    if (endDate && endDate < startDate) return setError("The end date must be on or after the first due date");
    setError(null);
    save.mutate(
      {
        accountId,
        amount: (deposit ? 1 : -1) * Math.abs(cents),
        ...(payee.id != null
          ? { payeeId: payee.id }
          : payee.name.trim()
            ? { payeeName: payee.name.trim() }
            : { payeeId: null }),
        categoryId,
        notes: notes.trim(),
        frequency,
        startDate,
        endDate: endDate || null,
        paused,
      },
      { onSuccess: props.onClose },
    );
  }

  const loadError = accounts.error ?? payees.error ?? categories.error;
  const schedule = startDate ? describeSchedule({ frequency, startDate }) : null;

  return (
    <Dialog
      title={bill ? "Edit recurring bill" : "Add recurring bill"}
      submitLabel={bill ? "Save" : "Add bill"}
      wide
      onClose={props.onClose}
      onSubmit={submit}
      pending={save.isPending || remove.isPending}
      error={error ?? save.error?.message ?? remove.error?.message ?? loadError?.message}
    >
      <div className="txn-form">
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
              placeholder="Who you pay"
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

        <div className="field-row">
          <label className="field">
            <span>Account</span>
            <select value={accountId ?? ""} onChange={(e) => setChosenAccount(Number(e.target.value))}>
              {openAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Category</span>
            <Autocomplete
              ariaLabel="Category"
              value={categoryId != null ? (categoryName.get(categoryId) ?? "") : ""}
              options={categoryOptions}
              onSelect={(v) => setCategoryId(v)}
              onClear={() => setCategoryId(null)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Repeats</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as BillFrequency)}>
              {(Object.keys(FREQUENCY_LABELS) as BillFrequency[]).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>First due date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          <label className="field">
            <span>Ends</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="Never" />
          </label>
        </div>
        {schedule && (
          <small className="muted">
            {schedule}. On the 1st of each month, that month's payments are added to the register.
            {bill && " Changes apply to payments that haven't been added yet."}
          </small>
        )}

        <label className="field">
          <span>Notes</span>
          <input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>

        {bill && (
          <div className="bill-dialog-footer">
            <label className="checkbox">
              <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
              Paused: don't add it to the register
            </label>
            <button
              type="button"
              className="link-button danger"
              onClick={() =>
                confirm("Delete this recurring bill? Payments already in the register stay.") &&
                remove.mutate(bill.id, { onSuccess: props.onClose })
              }
            >
              Delete bill
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function BillsPage() {
  const bills = useScheduledBills();
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();
  const [editing, setEditing] = useState<ScheduledBill | "new" | null>(null);

  const setPaused = useLedgerMutation((b: { id: number; paused: boolean }) =>
    api.patch(`/scheduled-bills/${b.id}`, { paused: b.paused }),
  );
  const remove = useLedgerMutation((id: number) => api.delete(`/scheduled-bills/${id}`));

  const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const payeeName = new Map(
    (payees.data ?? []).map((p) => [p.id, p.transferAccountId ? `Transfer: ${p.name}` : p.name]),
  );
  const categoryName = new Map((categories.data ?? []).flatMap((g) => g.categories).map((c) => [c.id, c.name]));
  const error = bills.error ?? setPaused.error ?? remove.error;

  return (
    <>
      <header className="page-header budget-header">
        <h1>Recurring bills</h1>
        <div className="row-actions">
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            Add bill
          </button>
        </div>
      </header>
      <div className="page-body investments">
        <section className="card wide">
          <p className="muted">
            On the 1st of each month, every bill due that month is added to its account's register with its due date,
            not yet cleared. A bank import then matches it instead of adding it twice.
          </p>
          {error && <p className="error-text">{error.message}</p>}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th className="bill-detail">Account</th>
                  <th className="bill-detail">Category</th>
                  <th className="bill-detail">Repeats</th>
                  <th className="bill-detail">Next due</th>
                  <th className="amount">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bills.data?.map((b) => {
                  const nextDue = b.nextDue ? formatDate(b.nextDue) : "Ended";
                  return (
                  <tr key={b.id} className={b.paused ? "muted" : undefined}>
                    <td className="bill-payee">
                      {(b.payeeId != null && payeeName.get(b.payeeId)) || b.notes || <span className="muted">No payee</span>}
                      {b.paused && <span className="badge bill-paused">paused</span>}
                      <small className="bill-summary muted">
                        {describeSchedule(b)} · {accountName.get(b.accountId)}
                        {!b.paused && ` · ${nextDue}`}
                      </small>
                    </td>
                    <td className="bill-detail">{accountName.get(b.accountId)}</td>
                    <td className="bill-detail">{b.categoryId != null ? categoryName.get(b.categoryId) : ""}</td>
                    <td className="bill-detail">{describeSchedule(b)}</td>
                    <td className="bill-detail">{b.paused ? "—" : nextDue}</td>
                    <td className={b.amount < 0 ? "amount negative" : "amount positive"}>{formatCents(b.amount)}</td>
                    <td className="amount">
                      <span className="row-actions-cell">
                        <button className="link-button" onClick={() => setEditing(b)}>
                          Edit
                        </button>
                        <button
                          className="link-button bill-detail"
                          onClick={() => setPaused.mutate({ id: b.id, paused: !b.paused })}
                        >
                          {b.paused ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="link-button danger bill-detail"
                          onClick={() =>
                            confirm("Delete this recurring bill? Payments already in the register stay.") &&
                            remove.mutate(b.id)
                          }
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {bills.data?.length === 0 && <p className="muted">No recurring bills yet.</p>}
          </div>
        </section>
      </div>
      {editing && <BillDialog bill={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
