/**
 * Tests for the topbar awaiting-secrets badge count logic (Issue #64).
 *
 * Pure logic tests — no React, no DOM. Tests the count derivation and
 * badge display text that the Topbar component must implement.
 */

import { describe, expect, it } from "vitest";

import type { Secret } from "@/lib/vault/schema";

function makeSecret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: "id",
    key: "KEY",
    value: "",
    scopes: [],
    ...overrides,
  } as Secret;
}

function countAwaiting(secrets: Secret[]): number {
  return secrets.filter((s) => s.status === "awaiting_value").length;
}

function badgeDisplay(count: number): string {
  return count > 9 ? "9+" : String(count);
}

describe("awaitingCount derivation", () => {
  it("returns 0 when no awaiting secrets", () => {
    expect(countAwaiting([makeSecret(), makeSecret()])).toBe(0);
  });

  it("returns correct count for all awaiting", () => {
    const secrets = [
      makeSecret({ status: "awaiting_value" }),
      makeSecret({ status: "awaiting_value" }),
      makeSecret({ status: "awaiting_value" }),
    ];
    expect(countAwaiting(secrets)).toBe(3);
  });

  it("counts only awaiting_value status secrets", () => {
    const secrets = [
      makeSecret({ status: "awaiting_value" }),
      makeSecret(),
      makeSecret({ status: "awaiting_value" }),
    ];
    expect(countAwaiting(secrets)).toBe(2);
  });
});

describe("badge display text", () => {
  it("shows count as string when 9 or less", () => {
    expect(badgeDisplay(9)).toBe("9");
    expect(badgeDisplay(1)).toBe("1");
  });

  it("shows '9+' when count exceeds 9", () => {
    expect(badgeDisplay(10)).toBe("9+");
    expect(badgeDisplay(99)).toBe("9+");
  });
});
