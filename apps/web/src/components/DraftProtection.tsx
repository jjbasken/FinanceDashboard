import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { Dialog } from "./Dialog";
const Context = createContext<(id: string, dirty: boolean, discard?: () => void) => void>(() => {});
/** One router blocker covers inline editing and stacked dialogs. */
export function DraftProtection({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Map<string, (() => void) | undefined>>(new Map());
  const register = useCallback((id: string, dirty: boolean, discard?: () => void) => setDrafts(previous => {
    if (previous.has(id) === dirty) return previous;
    const next = new Map(previous); if (dirty) next.set(id, discard); else next.delete(id); return next;
  }), []);
  const dirty = drafts.size > 0;
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", before); return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  return <Context.Provider value={register}>{children}{blocker.state === "blocked" && <Dialog title="Leave without saving?" submitLabel="Keep editing" onClose={() => blocker.reset()} onSubmit={() => blocker.reset()} guardChanges={false} noCancel>
    <p>Your unfinished changes will be lost if you leave this page.</p><button type="button" className="btn btn-danger-outline" onClick={() => { for (const discard of drafts.values()) discard?.(); setDrafts(new Map()); blocker.proceed(); }}>Discard changes and leave</button>
  </Dialog>}</Context.Provider>;
}
export function useDraftProtection(dirty: boolean, onDiscard?: () => void) {
  const register = useContext(Context); const id = useId();
  const discard = useRef(onDiscard); discard.current = onDiscard;
  useEffect(() => { register(id, dirty, () => discard.current?.()); return () => register(id, false); }, [register, id, dirty]);
}
