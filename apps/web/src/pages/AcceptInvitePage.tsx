import type { AcceptInviteInput } from "@fd/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { useAuthMutation } from "../auth";
import { AuthCard, Field, formValues } from "../components/AuthCard";

export function AcceptInvitePage() {
  const { token = "" } = useParams();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<{ householdName: string }>(`/auth/invites/${encodeURIComponent(token)}`),
  });
  const accept = useAuthMutation<AcceptInviteInput>("/auth/accept-invite");

  if (invite.isPending) return <div className="fullscreen-center muted">Checking invite…</div>;
  if (invite.error) {
    return (
      <div className="fullscreen-center">
        <div className="auth-card">
          <h1>Invite unavailable</h1>
          <p className="error-text">{invite.error.message}</p>
          <Link to="/login">Go to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <AuthCard
      title={`Join ${invite.data.householdName}`}
      subtitle="Create your login to share this household's finances."
      submitLabel="Create account"
      pending={accept.isPending}
      error={accept.error?.message}
      onSubmit={(form) => accept.mutate({ ...formValues(form), token } as unknown as AcceptInviteInput)}
    >
      <Field label="Your name" name="displayName" autoComplete="name" autoFocus />
      <Field label="Username" name="username" autoComplete="username" />
      <Field label="Password" name="password" type="password" autoComplete="new-password" hint="At least 10 characters" />
    </AuthCard>
  );
}
