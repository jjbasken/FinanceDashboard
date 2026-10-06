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
  /** ISO 4217 code amounts are shown in, e.g. USD. */
  currency: string;
}

/** A household member as the Settings page lists them. */
export interface HouseholdMember extends PublicUser {
  /** Removed by the owner: can't sign in. */
  disabled: boolean;
}

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/** The owner setting a member's password. */
export const setPasswordInput = z.object({ newPassword: passwordSchema });

export const CURRENCIES = [
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "CHF",
  "JPY",
  "SEK",
  "NOK",
  "DKK",
  "MXN",
  "INR",
] as const;
export const updateHouseholdInput = z
  .object({
    name: z.string().trim().min(1, "Household name is required").max(64),
    currency: z.enum(CURRENCIES),
  })
  .partial();
export type UpdateHouseholdInput = z.infer<typeof updateHouseholdInput>;

export interface AuthStatus {
  needsSetup: boolean;
  user: PublicUser | null;
  household: Household | null;
}

export interface InviteInfo {
  token: string;
  expiresAt: string;
}
