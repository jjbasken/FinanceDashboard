import { formatCents, type Account } from "@fd/shared";
import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useAuthMutation, useAuthStatus } from "../auth";
import { useAccounts } from "../ledger";
import { AddAccountDialog } from "./AddAccountDialog";

const nav = [
  { to: "/budget", label: "Budget" },
  { to: "/reports", label: "Reports" },
  { to: "/investments", label: "Investments" },
];

/** Cash plus the market value of any investments held. */
const worth = (a: Account) => a.balance + a.holdingsValue;
const total = (list: Account[]) => list.reduce((sum, a) => sum + worth(a), 0);

function Money(props: { cents: number }) {
  return (
    <span className={props.cents < 0 ? "sidebar-amount negative" : "sidebar-amount"}>{formatCents(props.cents)}</span>
  );
}

function AccountGroup(props: { title: string; accounts: Account[]; collapsible?: boolean }) {
  const [open, setOpen] = useState(!props.collapsible);
  if (props.accounts.length === 0) return null;
  return (
    <div className="sidebar-group">
      <button className="sidebar-group-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          {props.collapsible && <span className="caret">{open ? "▾" : "▸"}</span>}
          {props.title}
        </span>
        {!props.collapsible && <Money cents={total(props.accounts)} />}
      </button>
      {open &&
        props.accounts.map((a) => (
          <NavLink key={a.id} to={`/accounts/${a.id}`} className="sidebar-account">
            <span className="truncate">{a.name}</span>
            <Money cents={worth(a)} />
          </NavLink>
        ))}
    </div>
  );
}

function SidebarAccounts() {
  const { data: accounts, error } = useAccounts();
  const [adding, setAdding] = useState(false);
  const open = (accounts ?? []).filter((a) => !a.closed);

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <span>Accounts</span>
        {accounts && accounts.length > 0 && <Money cents={total(accounts)} />}
      </div>
      {error && <p className="sidebar-empty">{error.message}</p>}
      {accounts?.length === 0 && <p className="sidebar-empty">No accounts yet</p>}
      <AccountGroup title="For budget" accounts={open.filter((a) => a.onBudget)} />
      <AccountGroup title="Off budget" accounts={open.filter((a) => !a.onBudget && a.type !== "investment")} />
      <AccountGroup title="Investments" accounts={open.filter((a) => !a.onBudget && a.type === "investment")} />
      <AccountGroup title="Closed" accounts={(accounts ?? []).filter((a) => a.closed)} collapsible />
      <button className="sidebar-add" onClick={() => setAdding(true)}>
        + Add account
      </button>
      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

export function AppShell() {
  const { data: status } = useAuthStatus();
  const logout = useAuthMutation<void>("/auth/logout");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>{status?.household?.name ?? "Family Finance"}</span>
        </div>

        <nav className="sidebar-nav">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <SidebarAccounts />

        <div className="sidebar-footer">
          <NavLink to="/settings">Settings</NavLink>
          <div className="sidebar-user">
            <span>{status?.user?.displayName}</span>
            <button className="link-button" onClick={() => logout.mutate()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
