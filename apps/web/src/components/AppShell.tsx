import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuthMutation, useAuthStatus } from "../auth";
import { useLiveUpdates } from "../live";
import { QuickEntry } from "./QuickEntry";
import { usePreferences } from "../preferences";
import { ConnectionStatus } from "./ConnectionStatus";
import { SidebarAccounts } from "./SidebarAccounts";

const nav = [
  { to: "/home", label: "Home" },
  { to: "/accounts", label: "Accounts" },
  { to: "/budget", label: "Budget" },
  { to: "/reports", label: "Reports" },
  { to: "/bills", label: "Bills" },
  { to: "/investments", label: "Investments" },
];

/** Phone tabs. Icons are 24×24 outline paths drawn with currentColor. */
const tabs = [
  { to: "/home", label: "Home", icon: "M3 11l9-8 9 8M5 10v11h14V10M9 21v-8h6v8" },
  { to: "/budget", label: "Budget", icon: "M4 6h16M4 12h16M4 18h10" },
  { to: "/accounts", label: "Accounts", icon: "M3 7h18v12H3zM3 11h18M7 15h4" },
  { to: "/bills", label: "Bills", icon: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" },
  { to: "/more", label: "More", icon: "M5 12h.01M12 12h.01M19 12h.01" },
];

const WIDTH_KEY = "fd.sidebarWidth";
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 240;
const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

/** The sidebar's width, dragged by its edge and remembered by this browser (best effort). */
function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return saved ? clampWidth(saved) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const save = (w: number) => {
    setWidth(w);
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      // Not remembered, but it still works for this visit.
    }
  };

  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    const move = (ev: PointerEvent) => {
      latest = clampWidth(startWidth + ev.clientX - startX);
      setWidth(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing-sidebar");
      save(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    document.body.classList.add("resizing-sidebar");
  }

  function onKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === "ArrowLeft") save(clampWidth(width - step));
    else if (e.key === "ArrowRight") save(clampWidth(width + step));
    else return;
    e.preventDefault();
  }

  return { width, startDrag, onKeyDown, reset: () => save(DEFAULT_WIDTH) };
}

export function AppShell() {
  useLiveUpdates();
  const { data: status } = useAuthStatus();
  const logout = useAuthMutation<void>("/auth/logout");
  const sidebar = useSidebarWidth();
  const [adding, setAdding] = useState(false);
  const location = useLocation();
  useEffect(() => setAdding(false), [location.pathname]);
  const { preferences } = usePreferences();

  const householdName = status?.household?.name ?? "Family Finance";

  return (
    <div className="shell">
      <header className="topbar">
        <img src="/favicon.svg" alt="" width={22} height={22} />
        <span className="truncate">{householdName}</span>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add purchase</button>
      </header>
      <aside className="sidebar" style={{ "--sidebar-width": `${sidebar.width}px` } as CSSProperties}>
        <div className="sidebar-brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>{householdName}</span>
        </div>

        <nav className="sidebar-nav">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add purchase</button>
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
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={sidebar.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize; double-click to reset"
        onPointerDown={sidebar.startDrag}
        onDoubleClick={sidebar.reset}
        onKeyDown={sidebar.onKeyDown}
      />
      <main className="main">
        <ConnectionStatus />
        {preferences.shortcuts.length > 0 && <nav className="personal-shortcuts" aria-label="Your shortcuts">{preferences.shortcuts.map(to => <NavLink key={to} to={to}>{to === "/reports" ? "Reports" : to === "/investments" ? "Investments" : "Review purchases"}</NavLink>)}</nav>}
        <Outlet />
      </main>
      {adding && <QuickEntry onClose={() => setAdding(false)} />}
      <nav className="tabbar" aria-label="Sections">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                d={t.icon}
                fill="none"
                stroke="currentColor"
                strokeWidth={t.label === "More" ? 3.2 : 1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
