import { CURRENCIES, type HouseholdMember } from "@fd/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { authKey, useAuthStatus } from "../auth";
import { ledgerKeys } from "../ledger";
import { Dialog } from "./Dialog";

/** Change your own password, or sign out your other devices. */
export function YourAccountCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      api.post<{ signedOut: number }>("/auth/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
    },
  });
  const others = useMutation({ mutationFn: () => api.post<{ signedOut: number }>("/auth/sign-out-others") });

  function submit(e: FormEvent) {
    e.preventDefault();
    setMismatch(next !== confirm);
    if (next === confirm) change.mutate();
  }

  return (
    <section className="card">
      <h2>Your account</h2>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={5}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
        </div>
        <small className="muted">At least 5 characters. Your other devices will be signed out.</small>
        {mismatch && <p className="error-text">The new passwords don't match.</p>}
        {change.error && <p className="error-text">{change.error.message}</p>}
        {change.isSuccess && <p className="positive">Password changed.</p>}
        <div>
          <button className="btn btn-primary" type="submit" disabled={change.isPending}>
            Change password
          </button>
        </div>
      </form>
      <div className="row-actions align-center">
        <button className="btn" onClick={() => others.mutate()} disabled={others.isPending}>
          Sign out other devices
        </button>
        {others.data && (
          <span className="muted">
            Signed out {others.data.signedOut} other session{others.data.signedOut === 1 ? "" : "s"}.
          </span>
        )}
        {others.error && <span className="error-text">{others.error.message}</span>}
      </div>
    </section>
  );
}

function SetPasswordDialog(props: { member: HouseholdMember; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const set = useMutation({
    mutationFn: () => api.post(`/household/users/${props.member.id}/password`, { newPassword: password }),
    onSuccess: props.onClose,
  });
  return (
    <Dialog
      title={`New password for ${props.member.displayName}`}
      submitLabel="Set password"
      onClose={props.onClose}
      onSubmit={() => set.mutate()}
      pending={set.isPending}
      error={set.error?.message}
    >
      <label className="field">
        <span>New password</span>
        <input
          type="text"
          autoComplete="off"
          minLength={5}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          required
        />
      </label>
      <small className="muted">
        At least 5 characters. They'll be signed out everywhere; give them this password and ask them to change it
        under Your account.
      </small>
    </Dialog>
  );
}

/** The owner's actions on another member. */
export function MemberActions(props: { member: HouseholdMember }) {
  const qc = useQueryClient();
  const m = props.member;
  const [settingPassword, setSettingPassword] = useState(false);
  const toggle = useMutation({
    mutationFn: () => api.post(`/household/users/${m.id}/${m.disabled ? "enable" : "disable"}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ledgerKeys.members }),
  });
  return (
    <span className="member-actions">
      {!m.disabled && (
        <button className="link-button" onClick={() => setSettingPassword(true)}>
          Set password
        </button>
      )}
      <button
        className={m.disabled ? "link-button" : "link-button danger"}
        disabled={toggle.isPending}
        onClick={() => {
          if (
            m.disabled ||
            confirm(`Remove ${m.displayName}? They'll be signed out and can't sign in. Everything they entered stays.`)
          ) {
            toggle.mutate();
          }
        }}
      >
        {m.disabled ? "Restore" : "Remove"}
      </button>
      {toggle.error && <span className="error-text">{toggle.error.message}</span>}
      {settingPassword && <SetPasswordDialog member={m} onClose={() => setSettingPassword(false)} />}
    </span>
  );
}

/** Household name and display currency (owner only). */
export function HouseholdCard() {
  const qc = useQueryClient();
  const { data: status } = useAuthStatus();
  const household = status?.household;
  const [name, setName] = useState(household?.name ?? "");
  const save = useMutation({
    mutationFn: (body: { name?: string; currency?: string }) => api.patch("/household", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey }),
  });
  if (!household) return null;
  return (
    <section className="card">
      <h2>Household</h2>
      <div className="field-row">
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== household.name && save.mutate({ name })}
          />
        </label>
        <label className="field">
          <span>Currency</span>
          <select value={household.currency} onChange={(e) => save.mutate({ currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <small className="muted">
        Amounts are shown in this currency. Nothing is converted, so pick the one your accounts are in.
      </small>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </section>
  );
}
