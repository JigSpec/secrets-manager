/**
 * Tests for isSentinelValue (Issue #91, Step 5).
 *
 * `lib/vault/sentinel.ts` exports `isSentinelValue`, which rejects
 * placeholder strings that should never be stored as real secret values.
 * Examples include `PLACEHOLDER`, `TODO`, `__SET_VIA_TUTORIAL__`,
 * and angle-bracket templates like `<YOUR_API_KEY>`.
 */

import { describe, expect, it } from "vitest";

import { isEmptyValue, isSentinelValue } from "@/lib/vault/sentinel";

describe("isSentinelValue — known sentinel strings", () => {
  it('returns true for "PLACEHOLDER"', () => {
    expect(isSentinelValue("PLACEHOLDER")).toBe(true);
  });

  it('returns true for "__SET_VIA_TUTORIAL__"', () => {
    expect(isSentinelValue("__SET_VIA_TUTORIAL__")).toBe(true);
  });

  it('returns true for "<YOUR_API_KEY>"', () => {
    expect(isSentinelValue("<YOUR_API_KEY>")).toBe(true);
  });

  it('returns true for "TODO"', () => {
    expect(isSentinelValue("TODO")).toBe(true);
  });
});

describe("isSentinelValue — real secret values", () => {
  it('returns false for a real-looking Stripe secret key', () => {
    expect(isSentinelValue("sk-actual-real-key-abc123")).toBe(false);
  });

  it('returns false for a real-looking GitHub personal access token', () => {
    expect(isSentinelValue("ghp_realtoken123")).toBe(false);
  });

  it('returns false for a real-looking Stripe test key (test_ prefix should not be a sentinel)', () => {
    expect(isSentinelValue("test_sk_abc123")).toBe(false);
  });
});

describe("isEmptyValue — empty and whitespace-only strings (Issue #95)", () => {
  it('returns true for "" (empty string)', () => {
    expect(isEmptyValue("")).toBe(true);
  });

  it('returns true for "   " (spaces only)', () => {
    expect(isEmptyValue("   ")).toBe(true);
  });

  it('returns true for "\\n\\t" (only whitespace chars)', () => {
    expect(isEmptyValue("\n\t")).toBe(true);
  });

  it('returns false for a real API key', () => {
    expect(isEmptyValue("sk-actual-real-key-abc123")).toBe(false);
  });

  it("isSentinelValue(\"\") is false — documents the gap isEmptyValue fills", () => {
    expect(isSentinelValue("")).toBe(false);
    expect(isEmptyValue("")).toBe(true);
  });
});

// ── Issue #114 (OROBOROUS): isDotenvxReservedKey ────────────────────────────
//
// These tests are RED until lib/vault/sentinel.ts exports
// `isDotenvxReservedKey`. The function must match keys that start with
// DOTENV_PUBLIC_KEY_ or DOTENV_PRIVATE_KEY_ (dotenvx internal headers).
// Keys that merely contain those substrings elsewhere must NOT match.

describe("isDotenvxReservedKey — issue #114 (OROBOROUS)", () => {
  // Import is placed inside the describe so that a missing export produces a
  // clear "not a function" / import error rather than a confusing reference
  // error at the top of the file that would mask other suites.
  // Each `it` uses its own dynamic import via `await import(...)` inside the test body.

  it('returns true for "DOTENV_PUBLIC_KEY_PRODUCTION"', async () => {
    const { isDotenvxReservedKey } = await import("@/lib/vault/sentinel");
    expect(isDotenvxReservedKey("DOTENV_PUBLIC_KEY_PRODUCTION")).toBe(true);
  });

  it('returns true for "DOTENV_PRIVATE_KEY_PRODUCTION"', async () => {
    const { isDotenvxReservedKey } = await import("@/lib/vault/sentinel");
    expect(isDotenvxReservedKey("DOTENV_PRIVATE_KEY_PRODUCTION")).toBe(true);
  });

  it('returns true for "DOTENV_PUBLIC_KEY_" (bare suffix)', async () => {
    const { isDotenvxReservedKey } = await import("@/lib/vault/sentinel");
    expect(isDotenvxReservedKey("DOTENV_PUBLIC_KEY_")).toBe(true);
  });

  it('returns false for "DATABASE_URL" (unrelated key)', async () => {
    const { isDotenvxReservedKey } = await import("@/lib/vault/sentinel");
    expect(isDotenvxReservedKey("DATABASE_URL")).toBe(false);
  });

  it('returns false for "DOTENV_VAULT" (related prefix but not the reserved pattern)', async () => {
    const { isDotenvxReservedKey } = await import("@/lib/vault/sentinel");
    expect(isDotenvxReservedKey("DOTENV_VAULT")).toBe(false);
  });

  it('returns false for "MY_DOTENV_PUBLIC_KEY_THING" (contains but does not start with the pattern)', async () => {
    const { isDotenvxReservedKey } = await import("@/lib/vault/sentinel");
    expect(isDotenvxReservedKey("MY_DOTENV_PUBLIC_KEY_THING")).toBe(false);
  });
});
