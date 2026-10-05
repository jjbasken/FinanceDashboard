import type { FormEvent, ReactNode } from "react";

export function AuthCard(props: {
  title: string;
  subtitle?: ReactNode;
  error?: string | null;
  submitLabel: string;
  pending?: boolean;
  onSubmit: (form: FormData) => void;
  children: ReactNode;
}) {
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    props.onSubmit(new FormData(e.currentTarget));
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Family Finance</span>
        </div>
        <h1>{props.title}</h1>
        {props.subtitle && <p className="muted">{props.subtitle}</p>}
        {props.children}
        {props.error && (
          <p className="error-text" role="alert">
            {props.error}
          </p>
        )}
        <button className="btn btn-primary" type="submit" disabled={props.pending}>
          {props.pending ? "Please wait…" : props.submitLabel}
        </button>
      </form>
    </div>
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        required
      />
      {props.hint && <small className="muted">{props.hint}</small>}
    </label>
  );
}

export const formValues = (form: FormData) => Object.fromEntries(form.entries()) as Record<string, string>;
