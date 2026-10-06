import { ACCOUNT_TYPE_LABELS, centsToInput, formatCents, parseCents, type Account } from "@fd/shared";
import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Register } from "../components/Register";
import { useAccounts, useCategories, useLedgerMutation, usePayees, useRegister } from "../ledger";

function Amount(props: { label: string; cents: number }) {
  return (
    <div className="stat">
      <span className="muted">{props.label}</span>
      <strong className={props.cents < 0 ? "negative" : undefined}>{formatCents(props.cents)}</strong>
    </div>
  );
}

function ReconcileBar(props: { account: Account; onDone: () => void }) {
  const [statement, setStatement] = useState(() => centsToInput(props.account.clearedBalance));
  const reconcile = useLedgerMutation((statementBalance: number) =>
    api.post(`/accounts/${props.account.id}/reconcile`, { statementBalance }),
  );
  const cents = parseCents(statement);
  const difference = cents === null ? null : props.account.clearedBalance - cents;

  return (
    <div className="reconcile-bar">
      <label className="field inline">
        <span>Statement balance</span>
        <input value={statement} onChange={(e) => setStatement(e.target.value)} inputMode="decimal" autoFocus />
      </label>
      <span>
        Cleared: <strong>{formatCents(props.account.clearedBalance)}</strong>
      </span>
      {difference !== null && difference !== 0 && (
        <span className="error-text">
          Difference: {formatCents(difference)}. Clear or fix transactions until this is zero.
        </span>
      )}
      {difference === 0 && <span className="positive">Balanced</span>}
      <span className="spacer" />
      {reconcile.error && <span className="error-text">{reconcile.error.message}</span>}
      <button className="btn" onClick={props.onDone}>
        Cancel
      </button>
      <button
        className="btn btn-primary"
        disabled={difference !== 0 || reconcile.isPending}
        onClick={() => reconcile.mutate(cents!, { onSuccess: props.onDone })}
      >
        Finish reconciling
      </button>
    </div>
  );
}

function AccountMenu(props: { account: Account }) {
  const { account } = props;
  const navigate = useNavigate();
  const update = useLedgerMutation((body: unknown) => api.patch(`/accounts/${account.id}`, body));
  const remove = useLedgerMutation(() => api.delete(`/accounts/${account.id}`));

  function rename() {
    const name = prompt("Account name", account.name)?.trim();
    if (name && name !== account.name) update.mutate({ name });
  }

  function toggleBudget() {
    const msg = account.onBudget
      ? `Move "${account.name}" off budget? Its transactions will stop counting in the budget for every month, including past months, so those months' income, spending and To Budget will change.`
      : `Move "${account.name}" on budget? Its categorized transactions will start counting in the budget for every month, including past months, and any without a category will need one.`;
    if (confirm(msg)) update.mutate({ onBudget: !account.onBudget });
  }

  function toggleClosed() {
    if (!account.closed && account.balance !== 0) {
      return alert("Move the remaining balance out of this account (for example, with a transfer) before closing it.");
    }
    update.mutate({ closed: !account.closed });
  }

  function del() {
    const msg = `Delete "${account.name}" and all of its transactions? Transfers to other accounts stay in those accounts as plain transactions. This can't be undone.`;
    if (!confirm(msg)) return;
    remove.mutate(undefined, { onSuccess: () => navigate("/budget") });
  }

  return (
    <details className="menu">
      <summary className="btn" aria-label="Account actions">
        ⋯
      </summary>
      <div
        className="menu-items"
        onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}
      >
        <button onClick={rename}>Rename</button>
        <button onClick={toggleBudget}>{account.onBudget ? "Move off budget" : "Move on budget"}</button>
        {account.type === "investment" && (
          <button onClick={() => navigate(`/import?account=${account.id}`)}>Import from GnuCash</button>
        )}
        <button onClick={toggleClosed}>{account.closed ? "Reopen account" : "Close account"}</button>
        <button className="danger" onClick={del}>
          Delete account
        </button>
      </div>
      {(update.error || remove.error) && <p className="error-text">{(update.error ?? remove.error)!.message}</p>}
    </details>
  );
}

export function AccountPage() {
  const id = Number(useParams().id);
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();
  const register = useRegister(id);
  const [search, setSearch] = useState("");
  const [reconciling, setReconciling] = useState(false);

  const account = accounts.data?.find((a) => a.id === id);
  if (accounts.data && !account) return <Navigate to="/budget" replace />;

  const error = accounts.error ?? payees.error ?? categories.error ?? register.error;
  const ready = account && payees.data && categories.data && register.data;

  return (
    <>
      <header className="page-header account-header">
        <div className="account-title">
          <h1>{account?.name ?? "…"}</h1>
          {account && (
            <span className="badge">
              {ACCOUNT_TYPE_LABELS[account.type]} · {account.onBudget ? "On budget" : "Off budget"}
              {account.closed ? " · Closed" : ""}
            </span>
          )}
        </div>
        {account && (
          <div className="account-stats">
            {account.type === "investment" || account.holdingsValue !== 0 ? (
              <>
                <Amount label="Cash" cents={account.balance} />
                <Amount label="Investments" cents={account.holdingsValue} />
                <Amount label="Total" cents={account.balance + account.holdingsValue} />
              </>
            ) : (
              <>
                <Amount label="Cleared" cents={account.clearedBalance} />
                <Amount label="Uncleared" cents={account.balance - account.clearedBalance} />
                <Amount label="Balance" cents={account.balance} />
              </>
            )}
          </div>
        )}
      </header>
      <div className="account-toolbar">
        <input
          type="search"
          placeholder="Search transactions"
          aria-label="Search transactions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="spacer" />
        {account && !reconciling && (
          <button className="btn" onClick={() => setReconciling(true)}>
            Reconcile
          </button>
        )}
        {account && <AccountMenu account={account} />}
      </div>
      {account && reconciling && <ReconcileBar account={account} onDone={() => setReconciling(false)} />}
      {error && <p className="error-text page-error">{error.message}</p>}
      {ready ? (
        <Register
          account={account}
          accounts={accounts.data!}
          transactions={register.data!}
          payees={payees.data!}
          categories={categories.data!}
          search={search}
        />
      ) : (
        !error && <p className="muted page-error">Loading…</p>
      )}
    </>
  );
}
