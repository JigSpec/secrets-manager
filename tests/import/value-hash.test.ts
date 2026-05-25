import { describe, expect, it } from "vitest";

import {
  FINGERPRINT_HEX_CHARS,
  FINGERPRINT_MIN_ENTROPY_BITS_PER_CHAR,
  FINGERPRINT_MIN_LENGTH,
  fingerprint,
  shannonEntropy,
} from "@/lib/import/value-hash";

describe("shannonEntropy", () => {
  it("returns 0 for empty input", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for a single repeated char", () => {
    expect(shannonEntropy("aaaaaaaaaa")).toBe(0);
  });

  it("returns 1 for a balanced two-symbol string", () => {
    expect(shannonEntropy("ababab")).toBeCloseTo(1, 6);
  });

  it("approaches log2(256) for random high-entropy bytes", () => {
    const high =
      "f8a7c3919b04ee27ad1c0f5b8e6042b3cdde7191aa55bf6c12d4830b97a4e08c";
    expect(shannonEntropy(high)).toBeGreaterThan(
      FINGERPRINT_MIN_ENTROPY_BITS_PER_CHAR,
    );
  });
});

describe("fingerprint", () => {
  it("returns null for short values", () => {
    expect(fingerprint("abc")).toBeNull();
    expect("a".repeat(FINGERPRINT_MIN_LENGTH - 1)).toHaveLength(
      FINGERPRINT_MIN_LENGTH - 1,
    );
    expect(fingerprint("a".repeat(FINGERPRINT_MIN_LENGTH - 1))).toBeNull();
  });

  it("returns null for low-entropy long values", () => {
    expect(fingerprint("aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(fingerprint("password" + "password" + "password")).toBeNull();
  });

  it("returns 16 hex chars for high-entropy values at threshold length", () => {
    const v = "abc-123-def-456-ghij";
    expect(v.length).toBeGreaterThanOrEqual(FINGERPRINT_MIN_LENGTH);
    const f = fingerprint(v);
    expect(f).not.toBeNull();
    expect(f!).toHaveLength(FINGERPRINT_HEX_CHARS);
    expect(f!).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    const v =
      "postgres://user:complex@host:5432/database?ssl=true&pool=20";
    expect(fingerprint(v)).toBe(fingerprint(v));
  });

  it("differs for different inputs", () => {
    const a = "AKIAIOSFODNN7EXAMPLE-very-fake-aws-key";
    const b = "AKIAIOSFODNN7EXAMPLE-another-fake-aws-key";
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});
