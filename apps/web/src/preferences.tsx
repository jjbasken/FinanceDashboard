import { createContext, useContext, useState, type ReactNode } from "react";
import { useAuthStatus } from "./auth";

export type Preferences = { startPage: string; favorites: number[]; shortcuts: string[]; showRunningBalance: boolean };
const defaults: Preferences = { startPage: "/home", favorites: [], shortcuts: [], showRunningBalance: false };
const Context = createContext<{ preferences: Preferences; update: (patch: Partial<Preferences>) => void }>({ preferences: defaults, update: () => {} });
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { data } = useAuthStatus();
  const key = `fd.preferences.${data?.household?.id}.${data?.user?.id}`;
  return <Store key={key} storageKey={key}>{children}</Store>;
}
function Store({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [preferences, set] = useState<Preferences>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (!p || typeof p !== "object") return defaults;
      return { startPage: typeof p.startPage === "string" && /^\/(home|budget|accounts(?:\/\d+)?)$/.test(p.startPage) ? p.startPage : defaults.startPage,
        favorites: Array.isArray(p.favorites) ? p.favorites.filter((id: unknown) => Number.isInteger(id)) : [],
        shortcuts: Array.isArray(p.shortcuts) ? p.shortcuts.filter((x: unknown) => x === "/reports" || x === "/investments" || x === "/review") : [],
        showRunningBalance: p.showRunningBalance === true };
    } catch { return defaults; }
  });
  function update(patch: Partial<Preferences>) {
    set(previous => { const next = { ...previous, ...patch }; try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {} return next; });
  }
  return <Context.Provider value={{ preferences, update }}>{children}</Context.Provider>;
}
export const usePreferences = () => useContext(Context);
