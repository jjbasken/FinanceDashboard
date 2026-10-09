import { askConfirm, askText, notify } from "../components/Feedback";
import {
  ACCOUNT_TYPE_LABELS,
  accountSection,
  centsToInput,
  formatCents,
  parseCents,
  type Account,
  type AccountFolder,
  type InvestmentTxn,
  type Security,
} from "@fd/shared";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { QuickEntry } from "../components/QuickEntry";
import { Dialog } from "../components/Dialog";
import { HoldingsTable, InvestmentTxnTable, useSecurityColors } from "../components/HoldingsTables";
import { InvestmentTxnDialog, SecurityDialog } from "../components/InvestmentDialogs";
import { MobileRegister } from "../components/MobileRegister";
import { Register } from "../components/Register";
import { PHONE_QUERY, useMediaQuery, useContentWidth } from "../components/useMediaQuery";
import {
  useAccounts,
  useCategories,
  useFolders,
  useHoldings,
  useInvestmentTxns,
  useLedgerMutation,
  usePayees,
  useRegister,
  useSecurities,
  today,
} from "../ledger";

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
        onClick={async () => reconcile.mutate(cents!, { onSuccess: props.onDone })}
      >
        Finish reconciling
      </button>
    </div>
  );
}

/** The folders an account can go in (its own sidebar section's), nested folders indented under their parent. */
function folderOptions(folders: AccountFolder[], account: Account) {
  const section = folders.filter((f) => f.section === accountSection(account));
  const out: { id: number; label: string }[] = [];
  const add = (parentId: number | null, depth: number) => {
    for (const f of section.filter((x) => x.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)) {
      out.push({ id: f.id, label: `${"\u00a0\u00a0\u00a0".repeat(depth)}${f.name}` });
      add(f.id, depth + 1);
    }
  };
  add(null, 0);
  return out;
}

function MoveToFolderDialog(props: { account: Account; onClose: () => void }) {
  const { data: folders } = useFolders();
  const [folderId, setFolderId] = useState(props.account.folderId === null ? "" : String(props.account.folderId));
  const update = useLedgerMutation((body: unknown) => api.patch(`/accounts/${props.account.id}`, body));
  const options = folderOptions(folders ?? [], props.account);
  return (
    <Dialog
      title={`Move "${props.account.name}"`}
      submitLabel="Move"
      onClose={props.onClose}
      onSubmit={() =>
        update.mutate({ folderId: folderId ? Number(folderId) : null }, { onSuccess: props.onClose })
      }
      pending={update.isPending}
      error={update.error?.message}
    >
      <label className="field">
        <span>Folder</span>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">No folder</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {options.length === 0 && (
        <p className="muted">There are no folders here yet. Add one with "+ Folder" next to the section name in the sidebar.</p>
      )}
    </Dialog>
  );
}

function AccountMenu(props: { account: Account }) {
  const { account } = props;
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  const update = useLedgerMutation((body: unknown) => api.patch(`/accounts/${account.id}`, body));
  const remove = useLedgerMutation(() => api.delete(`/accounts/${account.id}`));

  async function rename() {
    const name = (await askText("Account name", account.name))?.trim();
    if (name && name !== account.name) update.mutate({ name });
  }

  async function toggleBudget() {
    const msg = account.onBudget
      ? `Move "${account.name}" off budget? Its transactions will stop counting in the budget for every month, including past months, so those months' income, spending and To Budget will change.`
      : `Move "${account.name}" on budget? Its categorized transactions will start counting in the budget for every month, including past months, and any without a category will need one.`;
    if ((await askConfirm(msg))) update.mutate({ onBudget: !account.onBudget });
  }

  async function togglePrivate() {
    const msg = account.private
      ? `Share "${account.name}" with the family? Everyone in the household will see it and all of its transactions.`
      : `Make "${account.name}" private? Only you will see it, and only the transactions you include will count in the family budget.`;
    if ((await askConfirm(msg))) update.mutate({ private: !account.private });
  }

  async function toggleClosed() {
    if (!account.closed && account.balance !== 0) {
      return notify("Move the remaining balance out of this account (for example, with a transfer) before closing it.");
    }
    update.mutate({ closed: !account.closed });
  }

  async function del() {
    const msg = `Delete "${account.name}" and all of its transactions? Transfers to other accounts stay in those accounts as plain transactions. This can't be undone.`;
    if (!(await askConfirm(msg))) return;
    remove.mutate(undefined, { onSuccess: () => navigate("/budget") });
  }

  return (
    <>
    <details className="menu">
      <summary className="btn" aria-label="Account actions">
        ⋯
      </summary>
      <div
        className="menu-items"
        onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}
      >
        <button onClick={rename}>Rename</button>
        {!account.closed && <button onClick={async () => setMoving(true)}>Move to folder</button>}
        <button onClick={toggleBudget}>{account.onBudget ? "Move off budget" : "Move on budget"}</button>
        <button onClick={togglePrivate}>{account.private ? "Share with family" : "Make private"}</button>
        <button onClick={async () => update.mutate({ excludeFromNetWorth: !account.excludeFromNetWorth })}>
          {account.excludeFromNetWorth ? "Include in net worth" : "Leave out of net worth"}
        </button>
        {!account.closed && (
          <button onClick={async () => navigate(`/import?account=${account.id}`)}>Import transactions</button>
        )}
        <button onClick={toggleClosed}>{account.closed ? "Reopen account" : "Close account"}</button>
        <button className="danger" onClick={del}>
          Delete account
        </button>
      </div>
      {(update.error || remove.error) && <p className="error-text">{(update.error ?? remove.error)!.message}</p>}
    </details>
      {moving && <MoveToFolderDialog account={account} onClose={() => setMoving(false)} />}
    </>
  );
}

/** An investment account's holdings and its buys, sells and other investment transactions. */
function AccountInvestments(props: { account: Account; accounts: Account[] }) {
  const { account } = props;
  const holdings = useHoldings();
  const securities = useSecurities();
  const txns = useInvestmentTxns();
  const colorOf = useSecurityColors(securities.data);
  const [filter, setFilter] = useState<number | null>(null);
  const [editing, setEditing] = useState<InvestmentTxn | "new" | null>(null);
  const [securityDialog, setSecurityDialog] = useState<Security | "new" | null>(null);

  // Closed accounts aren't in the holdings summary; show their cash alone.
  const own = holdings.data?.accounts.find((a) => a.accountId === account.id) ?? {
    accountId: account.id,
    accountName: account.name,
    cash: account.balance,
    holdings: [],
    value: account.balance,
  };
  const accountTxns = (txns.data ?? []).filter((t) => t.accountId === account.id);
  const shownTxns = accountTxns.filter((t) => filter === null || t.securityId === filter);
  const filtered = securities.data?.find((s) => s.id === filter);
  const filterSymbol = filtered?.symbol;
  const investAccounts = props.accounts
    .filter((a) => !a.closed || a.id === account.id)
    .sort((a, b) => Number(b.type === "investment") - Number(a.type === "investment"));
  const error = holdings.error ?? securities.error ?? txns.error;

  return (
    <div className="page-body investments">
      {error && <p className="error-text">{error.message}</p>}
      <section className="card wide">
        <div className="card-head">
          <h2>Holdings</h2>
          <div className="row-actions">
            <button className="btn" onClick={async () => setSecurityDialog("new")}>
              Add security
            </button>
            <button className="btn btn-primary" onClick={async () => setEditing("new")} disabled={!securities.data}>
              Add transaction
            </button>
          </div>
        </div>
        {holdings.data ? (
          <HoldingsTable accounts={[own]} colorOf={colorOf} filter={filter} onFilter={setFilter} />
        ) : (
          !error && <p className="muted">Loading…</p>
        )}
        {holdings.data && own.holdings.length === 0 && (
          <p className="muted">
            No holdings yet. Add a security, then record a buy (or shares moved in) to start tracking it here.
          </p>
        )}
      </section>

      {accountTxns.length > 0 && securities.data && (
        <section className="card wide">
          <div className="card-head">
            <h2>Transactions{filterSymbol && `: ${filterSymbol}`}</h2>
            {filtered && (
              <span className="row-actions-cell">
                <button className="link-button" onClick={async () => setSecurityDialog(filtered)}>
                  Edit {filtered.symbol}
                </button>
                <button className="link-button" onClick={async () => setFilter(null)}>
                  Show all
                </button>
              </span>
            )}
          </div>
          <InvestmentTxnTable txns={shownTxns} securities={securities.data} onEdit={setEditing} />
        </section>
      )}

      {editing && securities.data && (
        <InvestmentTxnDialog
          txn={editing === "new" ? undefined : editing}
          accounts={investAccounts}
          securities={securities.data}
          defaults={{ accountId: account.id, securityId: filter ?? undefined }}
          onClose={() => setEditing(null)}
          onAddSecurity={() => setSecurityDialog("new")}
        />
      )}
      {securityDialog && (
        <SecurityDialog
          security={securityDialog === "new" ? undefined : securityDialog}
          onClose={() => setSecurityDialog(null)}
        />
      )}
    </div>
  );
}

export function AccountPage() {
  const id = Number(useParams().id);
  const accounts = useAccounts();
  const payees = usePayees();
  const categories = useCategories();
  const register = useRegister(id);
  // Bills added on the 1st are dated later in the month; this is what the account holds today.
  const now = today();
  const upcoming = (register.data ?? []).filter((t) => t.date > now);
  const upcomingTotal = upcoming.reduce((sum, t) => sum + t.amount, 0);
  const [search, setSearch] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [id]);
  const fallbackPhone = useMediaQuery(PHONE_QUERY);
  const content = useContentWidth();
  const phone = content.width ? content.width < 940 : fallbackPhone;
  const [quickEntry, setQuickEntry] = useState(false);
  useEffect(() => setQuickEntry(false), [id]);
  const [params, setParams] = useSearchParams();

  const account = accounts.data?.find((a) => a.id === id);
  if (accounts.data && !account) return <Navigate to="/budget" replace />;

  // Investment accounts open on their holdings; the cash register is a click away.
  const invests = !!account && (account.type === "investment" || account.holdingsValue !== 0);
  const showHoldings = invests && params.get("view") !== "register";
  const setView = (view: "holdings" | "register") =>
    setParams(view === "register" ? { view } : {}, { replace: true });

  const error = accounts.error ?? payees.error ?? categories.error ?? register.error;
  const ready = account && payees.data && categories.data && register.data;

  return (
    <>
      <header ref={content.ref} className="page-header account-header">
        <div className="account-title">
          <h1>{account?.name ?? "…"}</h1>
          {account && (
            <span className="badge">
              {ACCOUNT_TYPE_LABELS[account.type]} · {account.onBudget ? "On budget" : "Off budget"}
              {account.private ? " · Private" : ""}
              {account.excludeFromNetWorth ? " · Not in net worth" : ""}
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
                <Amount label="Balance today" cents={account.balance - upcomingTotal} />
                {upcoming.length > 0 && <Amount label="After scheduled transactions" cents={account.balance} />}
                <details className="balance-details"><summary>Bank status details</summary><Amount label="Confirmed (cleared)" cents={account.clearedBalance} /><Amount label="Not confirmed (uncleared)" cents={account.balance - account.clearedBalance} /><p className="muted">These are recorded balances, not a live connection to your bank.</p></details>
              </>
            )}
          </div>
        )}
      </header>
      <div className="account-toolbar">
        {invests && (
          <div className="segmented" role="group" aria-label="View">
            <button className={showHoldings ? "active" : undefined} onClick={async () => setView("holdings")}>
              Holdings
            </button>
            <button
              className={showHoldings ? undefined : "active"}
              onClick={async () => setView("register")}
              title="The account's cash: deposits, withdrawals, and the cash side of buys, sells and dividends"
            >
              Cash register
            </button>
          </div>
        )}
        {!showHoldings && (
          <input
            type="search"
            placeholder="Search transactions"
            aria-label="Search transactions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <span className="spacer" />
        {account && !showHoldings && !adding && !phone && (
          <button className="btn btn-primary" onClick={async () => setAdding(true)}>
            Keyboard entry
          </button>
        )}
        {account && !showHoldings && !reconciling && (
          <button className="btn" onClick={async () => setReconciling(true)}>
            Reconcile
          </button>
        )}
        {account && !showHoldings && <button className="btn btn-primary" onClick={async () => setQuickEntry(true)}>+ Add purchase</button>}
        {account && <AccountMenu account={account} />}
      </div>
      {account && reconciling && !showHoldings && (
        <ReconcileBar account={account} onDone={() => setReconciling(false)} />
      )}
      {quickEntry && account && <QuickEntry accountId={account.id} onClose={() => setQuickEntry(false)} />}
      {error && <p className="error-text page-error">{error.message}</p>}
      {showHoldings ? (
        <AccountInvestments key={account!.id} account={account!} accounts={accounts.data!} />
      ) : ready && phone ? (
        <MobileRegister
          account={account}
          accounts={accounts.data!}
          transactions={register.data!}
          payees={payees.data!}
          categories={categories.data!}
          search={search}
          adding={false}
          onAdd={() => setQuickEntry(true)}
          onCloseAdding={() => setAdding(false)}
        />
      ) : ready ? (
        <Register
          account={account}
          accounts={accounts.data!}
          transactions={register.data!}
          payees={payees.data!}
          categories={categories.data!}
          search={search}
          adding={adding}
          onCloseAdding={() => setAdding(false)}
        />
      ) : (
        !error && <p className="muted page-error">Loading…</p>
      )}
    </>
  );
}
