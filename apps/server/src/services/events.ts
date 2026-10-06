/** A change notification for a household's open sessions. */
export interface ChangeEvent {
  type: "change";
  /** The browser tab that made the change (from the x-client-id header), so it can skip its own echo. */
  origin: string | null;
}

type Listener = (event: ChangeEvent) => void;

/** In-process pub/sub keyed by household. One server process, so no broker is needed. */
export class EventHub {
  private listeners = new Map<number, Set<Listener>>();

  subscribe(householdId: number, listener: Listener) {
    const set = this.listeners.get(householdId) ?? new Set();
    set.add(listener);
    this.listeners.set(householdId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(householdId);
    };
  }

  publish(householdId: number, event: ChangeEvent) {
    for (const listener of this.listeners.get(householdId) ?? []) listener(event);
  }

  listenerCount(householdId: number) {
    return this.listeners.get(householdId)?.size ?? 0;
  }
}
