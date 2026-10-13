import type { Preferences } from "@fd/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api } from "./api";
import { useAuthStatus } from "./auth";
import { notify } from "./components/Feedback";

export type { Preferences };
const defaults: Preferences = { startPage: "/home", favorites: [], entryAccounts: [], shortcuts: [], showRunningBalance: false };
const Context = createContext<{ preferences: Preferences; loaded: boolean; update: (patch: Partial<Preferences>) => void }>({ preferences: defaults, loaded: true, update: () => {} });

/** Fill in and tidy saved preferences, which may come from an older version of the app. */
function clean(p: unknown): Preferences {
  if (!p || typeof p !== "object") return defaults;
  const v = p as Record<string, unknown>;
  const ids = (x: unknown) => Array.isArray(x) ? x.filter((id): id is number => Number.isInteger(id)) : [];
  return { startPage: typeof v.startPage === "string" && /^\/(home|budget|accounts(?:\/\d+)?)$/.test(v.startPage) ? v.startPage : defaults.startPage,
    favorites: ids(v.favorites),
    entryAccounts: ids(v.entryAccounts),
    shortcuts: Array.isArray(v.shortcuts) ? v.shortcuts.filter((x): x is string => x === "/reports" || x === "/investments" || x === "/review") : [],
    showRunningBalance: v.showRunningBalance === true };
}

/** Preferences are saved with the signed-in person, so they follow them to every device. */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { data } = useAuthStatus();
  const qc = useQueryClient();
  const userId = data?.user?.id;
  const key = ["preferences", userId];
  const query = useQuery({ queryKey: key, enabled: userId != null, queryFn: () => api.get<{ preferences: unknown }>("/auth/preferences").then(r => r.preferences ?? null) });
  // Before preferences were saved on the server, they lived in this browser; carry them over once.
  const legacyKey = `fd.preferences.${data?.household?.id}.${userId}`;
  useEffect(() => {
    if (query.data !== null) return;
    let legacy: unknown = null;
    try { legacy = JSON.parse(localStorage.getItem(legacyKey) ?? "null"); } catch {}
    if (!legacy) return;
    const preferences = clean(legacy);
    qc.setQueryData(key, preferences);
    api.put("/auth/preferences", preferences).then(() => { try { localStorage.removeItem(legacyKey); } catch {} }, () => {});
  }, [query.data, legacyKey]);
  const preferences = clean(query.data);
  function update(patch: Partial<Preferences>) {
    const next = { ...clean(qc.getQueryData(key)), ...patch };
    // Don't let a refetch already in flight put back the old values.
    void qc.cancelQueries({ queryKey: key });
    qc.setQueryData(key, next);
    api.put("/auth/preferences", next).catch(() => {
      notify("Couldn't save your preferences. Check your connection and try again.");
      void qc.invalidateQueries({ queryKey: key });
    });
  }
  return <Context.Provider value={{ preferences, loaded: userId == null || !query.isPending, update }}>{children}</Context.Provider>;
}
export const usePreferences = () => useContext(Context);
