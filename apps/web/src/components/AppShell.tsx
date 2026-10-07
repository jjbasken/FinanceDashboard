import { NavLink, Outlet } from "react-router";
import { useAuthMutation, useAuthStatus } from "../auth";
import { useLiveUpdates } from "../live";
import { SidebarAccounts } from "./SidebarAccounts";

const nav = [
  { to: "/budget", label: "Budget" },
  { to: "/reports", label: "Reports" },
  { to: "/investments", label: "Investments" },
];

export function AppShell() {
  useLiveUpdates();
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
