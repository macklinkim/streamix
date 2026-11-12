import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { isUniqueViolation } from "./errors.js";

describe("isUniqueViolation", () => {
  const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });

  it.each([duplicate, new DrizzleQueryError("insert into users", [], duplicate)])(
    "recognizes direct and Drizzle-wrapped unique violations",
    (error) => {
      expect(isUniqueViolation(error)).toBe(true);
    },
  );

  it.each([
    null,
    undefined,
    new Error("connection failed"),
    new DrizzleQueryError("insert into users", []),
    new DrizzleQueryError(
      "insert into users",
      [],
      Object.assign(new Error("not null violation"), { code: "23502" }),
    ),
  ])("does not classify other failures as duplicates", (error) => {
    expect(isUniqueViolation(error)).toBe(false);
  });
});
