import type { SetupInput } from "@fd/shared";
import { useAuthMutation } from "../auth";
import { AuthCard, Field, formValues } from "../components/AuthCard";

export function SetupPage() {
  const setup = useAuthMutation<SetupInput>("/auth/setup");
  return (
    <AuthCard
      title="Welcome"
      subtitle="Create your household and the owner account. You can invite your partner afterwards."
      submitLabel="Create household"
      pending={setup.isPending}
      error={setup.error?.message}
      onSubmit={(form) => setup.mutate(formValues(form) as unknown as SetupInput)}
    >
      <Field label="Household name" name="householdName" autoFocus />
      <Field label="Your name" name="displayName" autoComplete="name" />
      <Field label="Username" name="username" autoComplete="username" />
      <Field label="Password" name="password" type="password" autoComplete="new-password" hint="At least 10 characters" />
    </AuthCard>
  );
}
