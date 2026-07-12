import { z } from "zod";
import { isWeakPassword } from "./weak-password.js";

export * from "./errors.js";
export * from "./weak-password.js";

/**
 * Shared boundary-validation schemas (browser forms / external input, §6.2).
 * Internal gRPC trusts proto types; these guard the untrusted edges only.
 */
// Canonicalized email (inbox/review.md P2-4): trimmed + lowercased so rate-limit
// keys, uniqueness, and lookups all agree on one form.
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
// Registration password policy (P2-4): length-first, no composition rules
// (password managers welcome). 200 cap bounds Argon2 input. Trivially weak
// 12+ char passwords (repeats, digit sequences, common phrases) are rejected.
export const passwordSchema = z
  .string()
  .min(12)
  .max(200)
  .refine((p) => !isWeakPassword(p), { message: "password is too common or predictable" });
// Login accepts any non-empty password: accounts created before the 12+ minimum
// must still be able to sign in.
export const loginPasswordSchema = z.string().min(1).max(200);
// Server-side display-name guard (P2-4): trimmed, bounded, no control characters
// or line/paragraph separators.
export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(50)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(s), "invalid characters");

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
});
export type LoginInput = z.infer<typeof loginSchema>;
