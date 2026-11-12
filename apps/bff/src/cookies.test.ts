import { describe, expect, it, vi } from "vitest";

vi.mock("./env.js", () => ({
  env: { COOKIE_SECURE: true, COOKIE_SAMESITE: "none", REFRESH_TTL_DAYS: 30 },
}));
import { clearCookie, refreshCookie } from "./cookies.js";

describe("login persistence cookies", () => {
  it("uses a session cookie when automatic login is disabled", () => {
    const cookie = refreshCookie("session", false);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
  });

  it("uses the configured lifetime when automatic login is enabled", () => {
    expect(refreshCookie("session", true)).toContain("Max-Age=2592000");
  });

  it("expires either kind of cookie at logout", () => {
    expect(clearCookie()).toContain("Max-Age=0");
    expect(clearCookie()).toContain("Path=/auth");
  });
});
