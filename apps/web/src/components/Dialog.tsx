import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";

/** A modal built on <dialog>, which gives us focus trapping and Escape-to-close for free. */
export function Dialog(props: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  pending?: boolean;
  error?: string | null;
  danger?: boolean;
  /** Hide the Cancel button, for dialogs that only show information. */
  noCancel?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    props.onSubmit();
  }

  return (
    <dialog
      aria-labelledby={titleId}
      ref={ref}
      className={props.wide ? "dialog wide" : "dialog"}
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <form onSubmit={submit}>
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
        {props.error && (
          <p className="error-text" role="alert">
            {props.error}
          </p>
        )}
        <div className="dialog-actions">
          {!props.noCancel && (
            <button type="button" className="btn" onClick={props.onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className={props.danger ? "btn btn-danger" : "btn btn-primary"} disabled={props.pending}>
            {props.pending ? "Please wait…" : props.submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
