import type { LoginInput } from "@fd/shared";
import { useAuthMutation } from "../auth";
import { AuthCard, Field, formValues } from "../components/AuthCard";

export function LoginPage() {
  const login = useAuthMutation<LoginInput>("/auth/login");
  return (
    <AuthCard
      title="Sign in"
      submitLabel="Sign in"
      pending={login.isPending}
      error={login.error?.message}
      onSubmit={(form) => login.mutate(formValues(form) as unknown as LoginInput)}
    >
      <Field label="Username" name="username" autoComplete="username" autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" />
    </AuthCard>
  );
}
