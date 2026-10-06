import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, defaultOnBudget, parseCents, type Account, type AccountType } from "@fd/shared";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { today, useLedgerMutation } from "../ledger";
import { Dialog } from "./Dialog";

export function AddAccountDialog(props: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [onBudget, setOnBudget] = useState(true);
  const [balance, setBalance] = useState("");
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [importNext, setImportNext] = useState(false);

  const create = useLedgerMutation((body: unknown) => api.post<Account>("/accounts", body));

  // The imported history brings the balance with it.
  const importing = importNext && type === "investment";

  function submit() {
    const startingBalance = importing || balance.trim() === "" ? 0 : parseCents(balance);
    if (startingBalance === null) return setError("Enter the balance as a number, like 1,234.56");
    setError(null);
    create.mutate(
      { name, type, onBudget, startingBalance, startingDate: date },
      {
        onSuccess: (account) => {
          props.onClose();
          navigate(importing ? `/import?account=${account.id}` : `/accounts/${account.id}`);
        },
      },
    );
  }

  return (
    <Dialog
      title="Add account"
      submitLabel="Add account"
      onClose={props.onClose}
      onSubmit={submit}
      pending={create.isPending}
      error={error ?? create.error?.message}
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={100} />
      </label>
      <label className="field">
        <span>Type</span>
        <select
          value={type}
          onChange={(e) => {
            const t = e.target.value as AccountType;
            setType(t);
            setOnBudget(defaultOnBudget(t));
          }}
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={onBudget} onChange={(e) => setOnBudget(e.target.checked)} />
        <span>
          On budget <small className="muted">(its spending is tracked against budget categories)</small>
        </span>
      </label>
      {!importing && (
        <div className="field-row">
          <label className="field">
            <span>Current balance</span>
            <input
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
            />
          </label>
          <label className="field">
            <span>As of</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>
      )}
      {type === "investment" && (
        <label className="checkbox">
          <input type="checkbox" checked={importNext} onChange={(e) => setImportNext(e.target.checked)} />
          <span>
            Then import its history from GnuCash <small className="muted">(a .gnucash file or a CSV export)</small>
          </span>
        </label>
      )}
      {type === "credit" || type === "loan" ? (
        <small className="muted">Enter money you owe as a negative number.</small>
      ) : null}
    </Dialog>
  );
}
