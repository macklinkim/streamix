import { describe, expect, it } from "vitest";
import { encoderFailure } from "./ingest.js";

describe("encoder failure log summary", () => {
  it("never returns a publish destination or token", () => {
    const output = "Error opening output file rtmp://localhost/live/bit_secret: Connection refused";
    expect(encoderFailure(output)).toBe("RTMP connection refused");
    expect(encoderFailure("rtmp://localhost/live/bit_secret failed")).toBe("encoder error");
  });
});
