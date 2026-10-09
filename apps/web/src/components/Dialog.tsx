import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useDraftProtection } from "./DraftProtection";

/** Native dialog with shared focus, draft protection, and a reachable footer on phones. */
export function Dialog(props: {
  title: string; onClose: () => void; onSubmit: () => void; submitLabel: string;
  pending?: boolean; error?: string | null; danger?: boolean; noCancel?: boolean; wide?: boolean;
  dirty?: boolean; guardChanges?: boolean; children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [changed, setChanged] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = props.guardChanges !== false && !props.noCancel && (props.dirty || changed);
  useDraftProtection(dirty, props.onClose);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const viewport = window.visualViewport;
    const resize = () => {
      dialog?.style.setProperty("--visual-height", `${viewport?.height ?? window.innerHeight}px`);
      dialog?.style.setProperty("--visual-top", `${viewport?.offsetTop ?? 0}px`);
    };
    resize(); viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize);
    return () => { viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize); };
  }, []);
  function close() { if (props.pending) return; if (dirty) setDiscard(true); else props.onClose(); }
  function submit(e: FormEvent) { e.preventDefault(); if (!props.pending && !discard) props.onSubmit(); }
  const confirming = discard;
  return <dialog aria-labelledby={titleId} ref={ref} className={props.wide ? "dialog wide" : "dialog"}
    onCancel={e => { e.preventDefault(); close(); }}>
    <form onSubmit={submit} onChange={() => setChanged(true)} onInput={() => setChanged(true)}>
      <h2 id={titleId}>{props.title}</h2>
      {confirming && <section className="draft-warning" role="alert">
        <h3>Discard your unsaved changes?</h3><p>Your changes have not been saved.</p>
        <div className="dialog-actions"><button type="button" className="btn btn-primary" autoFocus onClick={() => { setDiscard(false);  }}>Keep editing</button>
        <button type="button" className="btn btn-danger-outline" onClick={() => { setChanged(false); props.onClose(); }}>Discard changes</button></div>
      </section>}<div className="dialog-content" hidden={confirming}>
        {props.children}
        {props.error && <p className="error-text" role="alert">{props.error}</p>}
        <div className="dialog-actions">
          {!props.noCancel && <button type="button" className="btn" disabled={props.pending} onClick={close}>Cancel</button>}
          <button type="submit" data-autofocus={props.noCancel || undefined} className={props.danger ? "btn btn-danger" : "btn btn-primary"} disabled={props.pending}>{props.pending ? "Saving…" : props.submitLabel}</button>
        </div>
      </div>
    </form>
  </dialog>;
}
