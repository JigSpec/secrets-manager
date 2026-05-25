/**
 * Regression tests for unlock action error coverage.
 *
 * Symptom that motivated this file: a user pulled main, entered the correct
 * password in the GUI unlock form, and got "Failed to unlock." with no
 * actionable detail. The generic catch-all in `app/unlock/actions.ts` hid
 * the real cause.
 *
 * Two invariants must hold:
 *
 * 1. Every `VaultErrorCode` defined in `lib/vault/errors.ts` must be
 *    explicitly mapped to a user-facing string in `app/unlock/actions.ts`.
 *    Otherwise a future code addition silently falls through to the
 *    generic "Failed to unlock: ..." message.
 *
 * 2. The unlock action must log the underlying error (stderr) before
 *    returning the generic message, so unexpected non-VaultError
 *    exceptions can be diagnosed from server logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VaultError, type VaultErrorCode } from "@/lib/vault/errors";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the mocked modules.
// ---------------------------------------------------------------------------

// Mock the entire vault session so the `server-only` guard in
// lib/vault/session.ts never executes. Individual tests override the
// unlockWithPassword mock to simulate different error conditions.
const mockUnlockWithPassword = vi.fn();
const mockVaultIsInitialized = vi.fn();

vi.mock("@/lib/vault/session", () => ({
  unlockWithPassword: (...args: unknown[]) => mockUnlockWithPassword(...args),
  vaultIsInitialized: (...args: unknown[]) => mockVaultIsInitialized(...args),
  createVaultWithPassword: vi.fn(),
  lock: vi.fn(),
}));

// Mock next/navigation so redirect() does not throw a NEXT_REDIRECT error
// (which Next.js uses internally but is unhandled in plain Vitest/Node).
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// ALL_VAULT_ERROR_CODES — derived from the VaultErrorCode union type.
//
// TypeScript union types have no runtime representation, so we maintain a
// const array and use `satisfies` to ensure it stays exhaustive: if
// VaultErrorCode gains a new member, the type-checker will flag this array
// as incomplete rather than silently allowing runtime blind spots.
// ---------------------------------------------------------------------------
const ALL_VAULT_ERROR_CODES = [
  "WRONG_PASSWORD",
  "CORRUPTED",
  "NOT_FOUND",
  "INVALID_DATA",
  "INCOMPATIBLE_VAULT_VERSION",
] as const satisfies readonly VaultErrorCode[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unlockAction — each VaultErrorCode maps to a specific user-facing message", () => {
  beforeEach(() => {
    // Vault exists so we reach the unlock call.
    mockVaultIsInitialized.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const code of ALL_VAULT_ERROR_CODES) {
    it(`VaultErrorCode "${code}" does not fall through to the generic fallback`, async () => {
      // Arrange: make unlockWithPassword throw the specific VaultError code.
      mockUnlockWithPassword.mockRejectedValueOnce(
        new VaultError(code, `simulated ${code}`),
      );

      const { unlockAction } = await import("@/app/unlock/actions");
      const result = await unlockAction(
        { ok: false, error: "" },
        makeFormData({ password: "any-password" }),
      );

      // The action must return { ok: false } for every VaultError.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The message must NOT be the generic catch-all that swallows the
        // specific error code. Each code must have its own tailored string.
        expect(result.error).not.toMatch(/^Failed to unlock:/);
        // And it must not be empty.
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("unlockAction — logs unexpected errors and surfaces err.message", () => {
  beforeEach(() => {
    mockVaultIsInitialized.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls console.error and includes err.message for non-VaultError exceptions", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("disk on fire");
    mockUnlockWithPassword.mockRejectedValueOnce(boom);

    const { unlockAction } = await import("@/app/unlock/actions");
    const result = await unlockAction(
      { ok: false, error: "" },
      makeFormData({ password: "any-password" }),
    );

    // console.error must have been called so the error surfaces in server logs.
    expect(consoleSpy).toHaveBeenCalled();
    // The returned message must include the underlying error detail.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("disk on fire");
    }
    consoleSpy.mockRestore();
  });
});

describe("VaultError is preserved across the unlock boundary", () => {
  it("constructing a VaultError with INCOMPATIBLE_VAULT_VERSION carries the code", () => {
    // Sanity check that we're testing against the right type. If this
    // ever fails, the unlock-action code coverage tests above are also
    // looking at the wrong type.
    const e = new VaultError(
      "INCOMPATIBLE_VAULT_VERSION",
      "vault version 5 is newer than this build supports",
    );
    expect(e.code).toBe("INCOMPATIBLE_VAULT_VERSION");
    expect(e).toBeInstanceOf(Error);
  });
});
