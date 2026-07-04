import { z } from "zod";

/**
 * Shared boundary-validation schemas (browser forms / external input, §6.2).
 * Internal gRPC trusts proto types; these guard the untrusted edges only.
 */
export const emailSchema = z.string().email();
export const passwordSchema = z.string().min(8).max(200);

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type LoginInput = z.infer<typeof loginSchema>;
