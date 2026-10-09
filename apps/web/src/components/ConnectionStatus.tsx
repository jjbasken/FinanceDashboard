import { useEffect, useState } from "react";
export function ConnectionStatus() {
  const [connected, setConnected] = useState(navigator.onLine);
  useEffect(() => {
    const online = () => setConnected(navigator.onLine);
    const event = (e: Event) => setConnected((e as CustomEvent<boolean>).detail);
    window.addEventListener("online", online); window.addEventListener("offline", online); window.addEventListener("fd:connection", event);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", online); window.removeEventListener("fd:connection", event); };
  }, []);
  return !connected ? <p className="notice" role="status">Connection lost. Changes from other devices may be delayed. Keep this page open; we’ll reconnect automatically. If a save fails, your form stays open so you can try again.</p> : null;
}
