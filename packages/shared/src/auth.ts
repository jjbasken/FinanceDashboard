import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Username must be at least 2 characters")
  .max(32, "Username must be at most 32 characters")
  .regex(/^[a-z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores");

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(256, "Password is too long");

export const displayNameSchema = z.string().trim().min(1, "Name is required").max(64);

export const setupInput = z.object({
  householdName: z.string().trim().min(1, "Household name is required").max(64),
  displayName: displayNameSchema,
  username: usernameSchema,
  password: passwordSchema,
});
export type SetupInput = z.infer<typeof setupInput>;

export const loginInput = z.object({
  username: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInput>;

export const acceptInviteInput = z.object({
  token: z.string().min(1),
  displayName: displayNameSchema,
  username: usernameSchema,
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;

export type UserRole = "owner" | "member";

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface Household {
  id: number;
  name: string;
}

export interface AuthStatus {
  needsSetup: boolean;
  user: PublicUser | null;
  household: Household | null;
}

export interface InviteInfo {
  token: string;
  expiresAt: string;
}
