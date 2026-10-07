import { type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useAuthMutation, useAuthStatus } from "../auth";
import { useLiveUpdates } from "../live";
import { SidebarAccounts } from "./SidebarAccounts";

const nav = [
  { to: "/budget", label: "Budget" },
  { to: "/reports", label: "Reports" },
  { to: "/investments", label: "Investments" },
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

  return (
    <div className="shell">
      <aside className="sidebar" style={{ "--sidebar-width": `${sidebar.width}px` } as CSSProperties}>
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
        <Outlet />
      </main>
    </div>
  );
}
