import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { clientId } from "./api";

/**
 * Keep this tab current with changes made elsewhere (the other person, or another tab): the
 * server pushes a "change" event after every write, and we refetch whatever is on screen.
 * EventSource reconnects on its own; after a reconnect we refresh in case events were missed.
 */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedBefore = false;
    const refresh = () => {
      clearTimeout(timer);
      // Coalesce bursts (an import, a run of edits) into one refetch.
      timer = setTimeout(() => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" }), 300);
    };
    const source = new EventSource("/api/events");
    source.addEventListener("ready", () => {
      if (connectedBefore) refresh();
      connectedBefore = true;
      window.dispatchEvent(new CustomEvent("fd:connection", { detail: true }));
    });
    source.addEventListener("error", () => window.dispatchEvent(new CustomEvent("fd:connection", { detail: false })));
    source.addEventListener("change", (e) => {
      try {
        if (JSON.parse((e as MessageEvent).data).origin === clientId) return;
      } catch {
        // A malformed event still means something changed.
      }
      refresh();
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [qc]);
}
