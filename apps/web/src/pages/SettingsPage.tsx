import type { InviteInfo } from "@fd/shared";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { copyInviteLink } from "../clipboard";
import { useAuthStatus } from "../auth";
import { PreferencesCard } from "../components/PreferencesCard";
import { CategoriesCard } from "../components/CategoriesCard";
import { BackupCard } from "../components/BackupCard";
import { HouseholdCard, MemberActions, YourAccountCard } from "../components/AccountCards";
import { useMembers } from "../ledger";

export function SettingsPage() {
  const { data: status } = useAuthStatus();
  const members = useMembers();
  const invite = useMutation({ mutationFn: () => api.post<InviteInfo>("/household/invites") });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const inviteInput = useRef<HTMLInputElement>(null);
  const copyAttempt = useRef(0);

  const inviteUrl = invite.data ? `${window.location.origin}/invite/${invite.data.token}` : null;
  const isOwner = status?.user?.role === "owner";

  async function copy() {
    if (!inviteUrl) return;
    const attempt = ++copyAttempt.current;
    setCopied(false);
    setCopyFailed(false);
    const ok = await copyInviteLink(inviteUrl, inviteInput.current);
    if (attempt !== copyAttempt.current) return;
    setCopied(ok);
    setCopyFailed(!ok);
  }

  return (
    <>
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="page-body">
        <PreferencesCard />
        <YourAccountCard />
        {isOwner && <HouseholdCard />}
        <section className="card">
          <h2>Household members</h2>
          {members.isPending && <p className="muted">Loading…</p>}
          {members.error && <p className="error-text">{members.error.message}</p>}
          <ul className="member-list">
            {members.data?.map((m) => (
              <li key={m.id} className={m.disabled ? "disabled" : undefined}>
                <span className="avatar" aria-hidden>
                  {m.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{m.displayName}</strong> <span className="muted">@{m.username}</span>
                </span>
                <span className="badge">{m.disabled ? "removed" : m.role}</span>
                {isOwner && m.id !== status?.user?.id && <MemberActions member={m} />}
              </li>
            ))}
          </ul>

          {isOwner && (
            <div className="invite">
              <button
                className="btn"
                onClick={() => {
                  copyAttempt.current++;
                  setCopied(false);
                  setCopyFailed(false);
                  invite.mutate();
                }}
                disabled={invite.isPending}
              >
                Create invite link
              </button>
              {invite.error && <p className="error-text">{invite.error.message}</p>}
              {inviteUrl && (
                <div className="invite-link">
                  <input
                    ref={inviteInput}
                    aria-label="Invite link"
                    readOnly
                    value={inviteUrl}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button className="btn" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                  {copyFailed && (
                    <small className="error-text">Couldn't copy; select the link and copy it yourself.</small>
                  )}
                  <small className="muted">
                    Single use, expires {new Date(invite.data!.expiresAt).toLocaleDateString()}.
                  </small>
                </div>
              )}
            </div>
          )}
        </section>
        <section className="card">
          <h2>Import</h2>
          <p className="muted">
            Add transactions from a bank or card statement (OFX, QFX or CSV), or bring in your history from a GnuCash
            book.
          </p>
          <div>
            <Link className="btn" to="/import">
              Import transactions
            </Link>
          </div>
        </section>
        <section className="card">
          <h2>Recurring bills</h2>
          <p className="muted">Bills that repeat are added to the register on the 1st of the month they're due.</p>
          <div>
            <Link className="btn" to="/bills">
              Manage recurring bills
            </Link>
          </div>
        </section>
        <section className="card">
          <h2>Payees</h2>
          <p className="muted">Rename, merge or delete the payees on your transactions.</p>
          <div>
            <Link className="btn" to="/payees">
              Manage payees
            </Link>
          </div>
        </section>
        {isOwner && (
          <section className="card">
            <h2>Activity & logs</h2>
            <p className="muted">
              Who added, changed or deleted what, and what the server has been doing: sign-ins, price updates,
              recurring bills, backups and errors. Only you can see this.
            </p>
            <div>
              <Link className="btn" to="/admin">
                Open activity & logs
              </Link>
            </div>
          </section>
        )}
        <BackupCard isOwner={isOwner} />
        <CategoriesCard />
      </div>
    </>
  );
}
