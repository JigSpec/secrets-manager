import { describe, expect, it } from "vitest";

import { findSiblingVariantConflict } from "@/lib/vault/scope/sibling-check";
import type { Secret } from "@/lib/vault/schema";

// Helper to build a minimal Secret
function makeSecret(overrides: Partial<Secret> & { key: string }): Secret {
  return {
    id: overrides.id ?? "s1",
    key: overrides.key,
    value: overrides.value ?? "val",
    namespace: overrides.namespace,
    variant: overrides.variant,
    scopes: overrides.scopes ?? [],
  };
}

// The cell we are testing against
const CELL = { repoId: "r1", env: "development" };

describe("findSiblingVariantConflict", () => {
  it("returns { conflict: false } when no siblings exist", () => {
    const candidate = makeSecret({ id: "s1", key: "API_KEY", variant: "test" });
    const result = findSiblingVariantConflict(candidate, [], CELL);
    expect(result.conflict).toBe(false);
  });

  it("returns { conflict: true } when a sibling with different variant owns the cell", () => {
    const candidate = makeSecret({ id: "s1", key: "API_KEY", variant: "test" });
    const sibling = makeSecret({
      id: "s2",
      key: "API_KEY",
      variant: "live",
      scopes: [CELL],
    });
    const result = findSiblingVariantConflict(candidate, [sibling], CELL);
    expect(result.conflict).toBe(true);
  });

  it("returns { conflict: false } when only the candidate itself owns the cell", () => {
    const candidate = makeSecret({
      id: "s1",
      key: "API_KEY",
      variant: "test",
      scopes: [CELL],
    });
    const result = findSiblingVariantConflict(candidate, [candidate], CELL);
    expect(result.conflict).toBe(false);
  });

  it("returns { conflict: false } when sibling has same variant", () => {
    const candidate = makeSecret({ id: "s1", key: "API_KEY", variant: "test" });
    const sibling = makeSecret({
      id: "s2",
      key: "API_KEY",
      variant: "test",
      scopes: [CELL],
    });
    const result = findSiblingVariantConflict(candidate, [sibling], CELL);
    expect(result.conflict).toBe(false);
  });

  it("returns { conflict: false } when sibling has different key", () => {
    const candidate = makeSecret({ id: "s1", key: "API_KEY", variant: "test" });
    const sibling = makeSecret({
      id: "s2",
      key: "OTHER_KEY",
      variant: "live",
      scopes: [CELL],
    });
    const result = findSiblingVariantConflict(candidate, [sibling], CELL);
    expect(result.conflict).toBe(false);
  });

  it("returns { conflict: false } when sibling has different namespace", () => {
    const candidate = makeSecret({
      id: "s1",
      key: "API_KEY",
      namespace: "stripe",
      variant: "test",
    });
    const sibling = makeSecret({
      id: "s2",
      key: "API_KEY",
      namespace: "paypal",
      variant: "live",
      scopes: [CELL],
    });
    const result = findSiblingVariantConflict(candidate, [sibling], CELL);
    expect(result.conflict).toBe(false);
  });
});
