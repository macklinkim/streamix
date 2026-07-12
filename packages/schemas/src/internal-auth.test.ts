import { describe, it, expect } from "vitest";
import { internalTokenValid, INTERNAL_TOKEN_HEADER } from "./internal-auth.js";

describe("internalTokenValid", () => {
  const expected = "s".repeat(48);

  it("accepts an exact match", () => {
    expect(internalTokenValid(expected, expected)).toBe(true);
  });

  it("rejects a wrong token of equal length", () => {
    expect(internalTokenValid("x".repeat(48), expected)).toBe(false);
  });

  it("rejects a token of different length", () => {
    expect(internalTokenValid(expected + "x", expected)).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(internalTokenValid(null, expected)).toBe(false);
    expect(internalTokenValid(undefined, expected)).toBe(false);
    expect(internalTokenValid("", expected)).toBe(false);
  });

  it("exposes a stable header name", () => {
    expect(INTERNAL_TOKEN_HEADER).toBe("x-internal-token");
  });
});
