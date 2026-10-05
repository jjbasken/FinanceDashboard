import type { InviteInfo, PublicUser } from "@fd/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useAuthStatus } from "../auth";

export function SettingsPage() {
  const { data: status } = useAuthStatus();
  const members = useQuery({ queryKey: ["household", "users"], queryFn: () => api.get<PublicUser[]>("/household/users") });
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
        <section className="card">
          <h2>Household members</h2>
          {members.isPending && <p className="muted">Loading…</p>}
          {members.error && <p className="error-text">{members.error.message}</p>}
          <ul className="member-list">
            {members.data?.map((m) => (
              <li key={m.id}>
                <span className="avatar" aria-hidden>
                  {m.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{m.displayName}</strong> <span className="muted">@{m.username}</span>
                </span>
                <span className="badge">{m.role}</span>
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
      </div>
    </>
  );
}
