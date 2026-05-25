/**
 * Tests for the "Needs Your Attention" section logic (Issue #64).
 *
 * Pure logic tests — no React, no DOM. Tests filtering and staleness logic
 * that the NeedsAttentionSection component and related code must satisfy.
 */

import { describe, expect, it } from "vitest";

import type { Secret } from "@/lib/vault/schema";
import { isTutorialStale } from "@/lib/vault/tutorial-staleness";

function makeSecret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: "test-id",
    key: "TEST_KEY",
    value: "",
    scopes: [],
    ...overrides,
  } as Secret;
}

describe("awaiting filtering logic", () => {
  it("filters to only secrets with status awaiting_value", () => {
    const secrets = [
      makeSecret({ id: "a", status: "awaiting_value" }),
      makeSecret({ id: "b" }),
      makeSecret({ id: "c", status: "awaiting_value" }),
    ];
    const awaiting = secrets.filter((s) => s.status === "awaiting_value");
    expect(awaiting).toHaveLength(2);
    expect(awaiting.every((s) => s.status === "awaiting_value")).toBe(true);
  });

  it("returns empty array when no secrets are awaiting", () => {
    const secrets = [makeSecret({ id: "a" }), makeSecret({ id: "b" })];
    const awaiting = secrets.filter((s) => s.status === "awaiting_value");
    expect(awaiting).toHaveLength(0);
  });

  it("count equals filtered array length", () => {
    const secrets = [
      makeSecret({ id: "a", status: "awaiting_value" }),
      makeSecret({ id: "b" }),
    ];
    const awaiting = secrets.filter((s) => s.status === "awaiting_value");
    expect(awaiting.length).toBe(1);
  });
});

describe("isTutorialStale", () => {
  function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  it("returns true when mayBeStale is true regardless of date", () => {
    expect(
      isTutorialStale({ steps: [], createdAt: daysAgo(1), mayBeStale: true }),
    ).toBe(true);
  });

  it("returns false for a recent tutorial (30 days ago)", () => {
    expect(
      isTutorialStale({ steps: [], createdAt: daysAgo(30) }),
    ).toBe(false);
  });

  it("returns true for a tutorial older than 90 days", () => {
    expect(
      isTutorialStale({ steps: [], createdAt: daysAgo(91) }),
    ).toBe(true);
  });
});
