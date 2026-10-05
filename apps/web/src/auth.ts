import type { AuthStatus } from "@fd/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const authKey = ["auth", "status"] as const;

export function useAuthStatus() {
  return useQuery({ queryKey: authKey, queryFn: () => api.get<AuthStatus>("/auth/status") });
}

/** A mutation that refreshes auth status (and drops all cached data) on success. */
export function useAuthMutation<TInput>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => api.post(path, input),
    onSuccess: async () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
      await qc.invalidateQueries({ queryKey: authKey });
    },
  });
}
