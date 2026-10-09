import { askConfirm } from "./Feedback";
import {
  centsToInput,
  describeSchedule,
  parseCents,
  type BillFrequency,
  type ScheduledBill,
} from "@fd/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { today, useAccounts, useCategories, useLedgerMutation, usePayees } from "../ledger";
import { Autocomplete, type Option } from "./Autocomplete";
import type { BillPrefill } from "./billPrefill";
import { Dialog } from "./Dialog";
import { createPayee } from "./registerModel";

const FREQUENCY_LABELS: Record<BillFrequency, string> = {
  monthly: "Every month",
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  yearly: "Every year",
};

type PayeeChoice = { id: number | null; name: string };

/**
 * Add or change a recurring bill. With `prefill` (and no bill), a new bill starts from those
 * values, e.g. a transaction picked in the register.
 */
export function BillDialog(props: {
  bill: ScheduledBill | null;
  prefill?: BillPrefill;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { bill } = props;
  // Where the form starts: the bill being edited, or the values it's being made from.
  const start = bill ?? props.prefill;
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();

  const openAccounts = useMemo(
    () => (accounts.data ?? []).filter((a) => !a.closed || a.id === start?.accountId),
    [accounts.data, start],
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

  const [chosenAccount, setChosenAccount] = useState<number | null>(start?.accountId ?? null);
  const accountId = chosenAccount ?? openAccounts.find((a) => a.onBudget)?.id ?? openAccounts[0]?.id ?? null;
  const [payee, setPayee] = useState<PayeeChoice>(() => {
    const p = payees.data?.find((x) => x.id === start?.payeeId);
    return p ? { id: p.id, name: p.transferAccountId ? `Transfer: ${p.name}` : p.name } : { id: null, name: "" };
  });
  const [deposit, setDeposit] = useState(start ? start.amount > 0 : false);
  const [amount, setAmount] = useState(start ? centsToInput(Math.abs(start.amount)) : "");
  const [categoryId, setCategoryId] = useState<number | null>(start?.categoryId ?? null);
  const [notes, setNotes] = useState(start?.notes ?? "");
  const [frequency, setFrequency] = useState<BillFrequency>(bill?.frequency ?? "monthly");
  const [startDate, setStartDate] = useState(start?.startDate ?? today());
  const [endDate, setEndDate] = useState(bill?.endDate ?? "");
  const [paused, setPaused] = useState(bill?.paused ?? false);
  const [error, setError] = useState<string | null>(null);
  // Made from a transaction, everything but the schedule is filled in, so start on how often it
  // repeats. (This runs after the dialog opens, which focuses its first field.)
  const repeats = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (props.prefill) repeats.current?.focus();
  }, []);

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
      {
        onSuccess: () => {
          props.onSaved?.();
          props.onClose();
        },
      },
    );
  }

  const loadError = accounts.error ?? payees.error ?? categories.error;
  const schedule = startDate ? describeSchedule({ frequency, startDate }) : null;

  return (
    <Dialog
      title={bill ? "Edit recurring bill" : props.prefill ? "Make recurring bill" : "Add recurring bill"}
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
                <button type="button" className={deposit ? undefined : "active"} onClick={async () => setDeposit(false)}>
                  Payment
                </button>
                <button type="button" className={deposit ? "active" : undefined} onClick={async () => setDeposit(true)}>
                  Deposit
                </button>
              </div>
              <input
                aria-label="Amount"
                className="amount"
                inputMode="decimal"
                placeholder="0.00"
                autoFocus={!props.prefill}
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
            {props.prefill?.split && (
              <small className="muted">That transaction was split. A recurring bill has one category; pick it here.</small>
            )}
          </div>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Repeats</span>
            <select ref={repeats} value={frequency} onChange={(e) => setFrequency(e.target.value as BillFrequency)}>
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
              onClick={async () =>
                (await askConfirm("Delete this recurring bill? Payments already in the register stay.")) &&
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
