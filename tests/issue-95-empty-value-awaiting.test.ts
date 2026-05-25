/**
 * Tests for Issue #95: blank-valued secrets must appear in "Needs Your Attention".
 *
 * Verifies that:
 *  1. isEmptyValue("") and isEmptyValue("  ") return true.
 *  2. isEmptyValue("real_value") returns false.
 *  3. isEmptyValue with nullish input returns false (no TypeError).
 *  4. needsAttention counts empty-valued secrets (mirrors workbench.tsx / needs-attention-dialog.tsx).
 *  5. sortAwaiting logic includes empty-valued secrets.
 *
 * These are pure logic tests — no React/DOM required.
 */

import { describe, expect, it } from "vitest";

import { isEmptyValue, isSentinelValue, needsAttention } from "@/lib/vault/sentinel";
import type { Secret } from "@/lib/vault/schema";

function makeSecret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: "id-1",
    key: "SOME_KEY",
    value: "test_value",
    scopes: [],
    ...overrides,
  } as Secret;
}

// ---------------------------------------------------------------------------
// Unit tests for isEmptyValue
// ---------------------------------------------------------------------------

describe("isEmptyValue — lib/vault/sentinel.ts", () => {
  it('returns true for ""', () => {
    expect(isEmptyValue("")).toBe(true);
  });

  it('returns true for " " (single space)', () => {
    expect(isEmptyValue(" ")).toBe(true);
  });

  it('returns true for "\\n" (newline only)', () => {
    expect(isEmptyValue("\n")).toBe(true);
  });

  it('returns true for "  \\t  " (tabs and spaces)', () => {
    expect(isEmptyValue("  \t  ")).toBe(true);
  });

  it('returns false for "real_value"', () => {
    expect(isEmptyValue("real_value")).toBe(false);
  });

  it('returns false for "sk-abc123"', () => {
    expect(isEmptyValue("sk-abc123")).toBe(false);
  });

  it("does not change behavior of isSentinelValue for non-empty sentinels", () => {
    expect(isSentinelValue("PLACEHOLDER")).toBe(true);
    expect(isSentinelValue("__SET_VIA_TUTORIAL__")).toBe(true);
    expect(isSentinelValue("sk-real-key")).toBe(false);
  });

  it('isSentinelValue("") returns false (confirming isEmptyValue is the right tool)', () => {
    expect(isSentinelValue("")).toBe(false);
  });

  it("returns false for null without throwing", () => {
    expect(isEmptyValue(null)).toBe(false);
  });

  it("returns false for undefined without throwing", () => {
    expect(isEmptyValue(undefined)).toBe(false);
  });

  it("returns false when allowEmpty option is true", () => {
    expect(isEmptyValue("", { allowEmpty: true })).toBe(false);
    expect(isEmptyValue("  ", { allowEmpty: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for needsAttention
// ---------------------------------------------------------------------------

describe("needsAttention — lib/vault/sentinel.ts", () => {
  it("returns true for awaiting_value status", () => {
    expect(needsAttention(makeSecret({ status: "awaiting_value", value: "test_value" }))).toBe(true);
  });

  it("returns true for sentinel value", () => {
    expect(needsAttention(makeSecret({ value: "PLACEHOLDER" }))).toBe(true);
  });

  it("returns true for empty value", () => {
    expect(needsAttention(makeSecret({ value: "" }))).toBe(true);
  });

  it("returns true for whitespace-only value", () => {
    expect(needsAttention(makeSecret({ value: "  " }))).toBe(true);
  });

  it("returns false for a real non-sentinel value", () => {
    expect(needsAttention(makeSecret({ value: "sk-real-key" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logic-level: awaitingCount with needsAttention (mirrors workbench.tsx useMemo)
// ---------------------------------------------------------------------------

function fixedAwaitingCount(secrets: Secret[]): number {
  return secrets.filter(needsAttention).length;
}

describe("awaitingCount — empty-value secrets (Issue #95)", () => {
  it('counts a secret with value="" and no status as needing attention', () => {
    const secrets = [
      makeSecret({ value: "" }),
      makeSecret({ value: "real_value" }),
    ];
    expect(fixedAwaitingCount(secrets)).toBe(1);
  });

  it('counts a secret with value=" " (whitespace only) as needing attention', () => {
    const secrets = [
      makeSecret({ value: " " }),
      makeSecret({ value: "real_value" }),
    ];
    expect(fixedAwaitingCount(secrets)).toBe(1);
  });

  it("does not double-count a secret with status=awaiting_value AND empty value", () => {
    const secrets = [
      makeSecret({ status: "awaiting_value", value: "" }),
      makeSecret({ value: "real_value" }),
    ];
    expect(fixedAwaitingCount(secrets)).toBe(1);
  });

  it("counts all three categories: awaiting_value status + sentinel + empty", () => {
    const secrets = [
      makeSecret({ status: "awaiting_value", value: "SOME_REAL" }),
      makeSecret({ value: "PLACEHOLDER" }),
      makeSecret({ value: "" }),
      makeSecret({ value: "  " }),
      makeSecret({ value: "sk-real-key" }),
    ];
    expect(fixedAwaitingCount(secrets)).toBe(4);
  });

  it("returns 0 when all secrets have real non-empty non-sentinel values", () => {
    const secrets = [
      makeSecret({ value: "ghp_realtoken123" }),
      makeSecret({ value: "sk-actual-real-key-abc123" }),
    ];
    expect(fixedAwaitingCount(secrets)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Logic-level: sortAwaiting with needsAttention (mirrors needs-attention-dialog.tsx)
// ---------------------------------------------------------------------------

function fixedSortAwaiting(secrets: Secret[]): Secret[] {
  return secrets
    .filter(needsAttention)
    .sort((a, b) => {
      const aTime = a.tutorial?.createdAt
        ? new Date(a.tutorial.createdAt).getTime()
        : 0;
      const bTime = b.tutorial?.createdAt
        ? new Date(b.tutorial.createdAt).getTime()
        : 0;
      return bTime - aTime;
    });
}

describe("sortAwaiting — empty-value secrets (Issue #95, needs-attention-dialog)", () => {
  it('includes a secret with value="" in the awaiting list', () => {
    const secrets = [
      makeSecret({ id: "empty", value: "" }),
      makeSecret({ id: "real", value: "real_value" }),
    ];
    const result = fixedSortAwaiting(secrets);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("empty");
  });

  it('includes a secret with value="  " (whitespace) in the awaiting list', () => {
    const secrets = [
      makeSecret({ id: "ws", value: "  " }),
      makeSecret({ id: "real", value: "real_value" }),
    ];
    const result = fixedSortAwaiting(secrets);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ws");
  });

  it("does not include real-valued secrets without awaiting status", () => {
    const secrets = [makeSecret({ id: "real", value: "sk-actual-real-key" })];
    expect(fixedSortAwaiting(secrets)).toHaveLength(0);
  });

  it("sorts by tutorial.createdAt descending (newest first)", () => {
    const secrets = [
      makeSecret({
        id: "older",
        value: "",
        tutorial: {
          steps: [{ order: 0, title: "Step", body: "Body" }],
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      }),
      makeSecret({
        id: "newer",
        value: "",
        tutorial: {
          steps: [{ order: 0, title: "Step", body: "Body" }],
          createdAt: "2024-06-01T00:00:00.000Z",
        },
      }),
    ];
    const result = fixedSortAwaiting(secrets);
    expect(result[0].id).toBe("newer");
    expect(result[1].id).toBe("older");
  });
});
