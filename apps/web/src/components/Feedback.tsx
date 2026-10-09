import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";

type Request = { message: string; initial?: string; resolve: (value: string | boolean | null) => void };
let dispatch: ((request: Request) => void) | undefined;
export const askConfirm = (message: string): Promise<boolean> => new Promise(resolve => dispatch?.({ message, resolve: v => resolve(v === true) }));
export const askText = (message: string, initial = ""): Promise<string | null> => new Promise(resolve => dispatch?.({ message, initial, resolve: v => resolve(typeof v === "string" ? v.trim() || null : null) }));
export function notify(message: string) { window.dispatchEvent(new CustomEvent("fd:notice", { detail: message })); }
export function Feedback() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    dispatch = request => setQueue(q => [...q, request]);
    let timer: ReturnType<typeof setTimeout>;
    const listener = (event: Event) => { setNotice((event as CustomEvent<string>).detail); clearTimeout(timer); timer = setTimeout(() => setNotice(""), 5000); };
    window.addEventListener("fd:notice", listener);
    return () => { dispatch = undefined; clearTimeout(timer); window.removeEventListener("fd:notice", listener); };
  }, []);
  const request = queue[0];
  useEffect(() => setText(request?.initial ?? ""), [request]);
  function finish(value: string | boolean | null) { request?.resolve(value); setQueue(q => q.slice(1)); }
  return <>
    <div className="toast-region" role="status" aria-live="polite">{notice && <div className="toast">{notice}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice("")}>×</button></div>}</div>
    {request && <Dialog title={request.initial !== undefined ? "Edit details" : "Confirm action"} submitLabel={request.initial !== undefined ? "Save" : "Continue"} onClose={() => finish(null)} onSubmit={() => finish(request.initial !== undefined ? text : true)} guardChanges={false}>
      <p>{request.message}</p>
      {request.initial !== undefined && <label className="field"><span> Name</span><input autoFocus required value={text} onChange={e => setText(e.target.value)} maxLength={100} /></label>}
    </Dialog>}
  </>;
}
