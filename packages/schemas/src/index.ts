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
export const passwordPolicyMessage =
  "비밀번호는 8자 이상이며 영문, 숫자, 특수문자를 각각 1개 이상 포함해야 합니다";

export const loginPasswordSchema = z
  .string()
  .min(8, passwordPolicyMessage)
  .max(200, "비밀번호는 200자 이하여야 합니다")
  .regex(/[A-Za-z]/, passwordPolicyMessage)
  .regex(/[0-9]/, passwordPolicyMessage)
  .regex(/[\p{P}\p{S}]/u, passwordPolicyMessage);

// Reject predictable passwords when creating or changing a password.
export const passwordSchema = loginPasswordSchema.refine(
  (password) => !isWeakPassword(password),
  "너무 흔하거나 예측하기 쉬운 비밀번호입니다",
);
// Server-side display-name guard (P2-4): trimmed, bounded, no control characters
// or line/paragraph separators.
export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(50)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(s), "invalid characters");

// Fixed channel categories (benchmark G-03): a closed list so channels group on
// the home filter. Legacy free-text values stay readable but can't be newly set.
export const CHANNEL_CATEGORIES = [
  "저스트 채팅",
  "게임",
  "음악",
  "아트",
  "IRL",
  "교육",
  "기술",
  "스포츠",
] as const;
export const categorySchema = z.enum(CHANNEL_CATEGORIES);

export const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
});
export type LoginInput = z.infer<typeof loginSchema>;
