import { describe, it, expect } from "vitest";
import { isWeakPassword } from "./weak-password.js";
import { passwordSchema } from "./index.js";

describe("isWeakPassword", () => {
  it("flags repeated single characters", () => {
    expect(isWeakPassword("aaaaaaaaaaaa")).toBe(true);
    expect(isWeakPassword("111111111111")).toBe(true);
  });

  it("flags common digit sequences", () => {
    expect(isWeakPassword("123456789012")).toBe(true);
    expect(isWeakPassword("1234567890123")).toBe(true);
  });

  it("flags common 12+ phrases (case-insensitive)", () => {
    expect(isWeakPassword("PasswordPassword")).toBe(true);
    expect(isWeakPassword("qwertyuiop12")).toBe(true);
  });

  it("accepts a strong 12+ password", () => {
    expect(isWeakPassword("correct horse battery")).toBe(false);
    expect(isWeakPassword("Tr0ub4dour&3xtra")).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("rejects too-short passwords", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
  });
  it("rejects weak 12+ passwords", () => {
    expect(passwordSchema.safeParse("aaaaaaaaaaaa").success).toBe(false);
    expect(passwordSchema.safeParse("123456789012").success).toBe(false);
  });
  it("accepts a strong password", () => {
    expect(passwordSchema.safeParse("correct horse battery").success).toBe(true);
  });
});
