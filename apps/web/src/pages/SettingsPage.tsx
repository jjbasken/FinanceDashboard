import type { InviteInfo } from "@fd/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useAuthStatus } from "../auth";
import { CategoriesCard } from "../components/CategoriesCard";
import { BackupCard } from "../components/BackupCard";
import { HouseholdCard, MemberActions, YourAccountCard } from "../components/AccountCards";
import { useMembers } from "../ledger";

export function SettingsPage() {
  const { data: status } = useAuthStatus();
  const members = useMembers();
  const invite = useMutation({ mutationFn: () => api.post<InviteInfo>("/household/invites") });
  const [copied, setCopied] = useState(false);

  const inviteUrl = invite.data ? `${window.location.origin}/invite/${invite.data.token}` : null;
  const isOwner = status?.user?.role === "owner";

  async function copy() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
  }

  return (
    <>
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="page-body">
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
                  setCopied(false);
                  invite.mutate();
                }}
                disabled={invite.isPending}
              >
                Create invite link
              </button>
              {invite.error && <p className="error-text">{invite.error.message}</p>}
              {inviteUrl && (
                <div className="invite-link">
                  <input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </button>
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
          <h2>Payees</h2>
          <p className="muted">Rename, merge or delete the payees on your transactions.</p>
          <div>
            <Link className="btn" to="/payees">
              Manage payees
            </Link>
          </div>
        </section>
        <BackupCard isOwner={isOwner} />
        <CategoriesCard />
      </div>
    </>
  );
}
