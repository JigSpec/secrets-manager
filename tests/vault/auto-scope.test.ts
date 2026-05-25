import { describe, expect, it } from "vitest";

import { planAutoScope, applyAutoScope } from "@/lib/vault/variant/auto-scope";
import type { Secret, VaultDataV4 } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

function baseVault(overrides: Partial<VaultDataV4> = {}): VaultDataV4 {
  return {
    version: 4,
    repos: [
      {
        id: "r1",
        name: "alpha",
        path: "/repos/alpha",
        environments: ["development", "production"],
      },
      {
        id: "r2",
        name: "beta",
        path: "/repos/beta",
        environments: ["staging"],
      },
    ],
    secrets: [],
    envVariantMap: { global: {}, repos: {} },
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------------
// planAutoScope
// ---------------------------------------------------------------------------
describe("planAutoScope", () => {
  it("secret without variant: plan returns empty array", () => {
    const vault = baseVault();
    const secret = makeSecret({ key: "API_KEY" }); // no variant
    const plan = planAutoScope(secret, vault);
    expect(plan).toHaveLength(0);
  });

  it("secret with variant 'test': cells map to all (repo, env) pairs resolving to 'test' via default map", () => {
    const vault = baseVault();
    // default map: development → test
    const secret = makeSecret({ key: "API_KEY", variant: "test" });
    const plan = planAutoScope(secret, vault);
    const addActions = plan.filter((e) => e.action === "add");
    // r1/development resolves to test
    expect(addActions).toContainEqual(
      expect.objectContaining({ cell: { repoId: "r1", env: "development" }, action: "add" }),
    );
    // production → live, staging → staging — neither is test
    expect(addActions).not.toContainEqual(
      expect.objectContaining({ cell: { repoId: "r1", env: "production" } }),
    );
    expect(addActions).not.toContainEqual(
      expect.objectContaining({ cell: { repoId: "r2", env: "staging" } }),
    );
  });

  it("cell already in secret's scopes → action is 'skip-already-scoped'", () => {
    const vault = baseVault();
    const cell = { repoId: "r1", env: "development" };
    const secret = makeSecret({
      key: "API_KEY",
      variant: "test",
      scopes: [cell],
    });
    const plan = planAutoScope(secret, vault);
    const entry = plan.find(
      (e) => e.cell.repoId === "r1" && e.cell.env === "development",
    );
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("skip-already-scoped");
  });

  it("cell occupied by sibling with different variant → action is 'skip-sibling-conflict'", () => {
    const sibling = makeSecret({
      id: "s-sibling",
      key: "API_KEY",
      variant: "live",
      scopes: [{ repoId: "r1", env: "development" }],
    });
    const vault = baseVault({ secrets: [sibling] });
    const secret = makeSecret({ key: "API_KEY", variant: "test" });
    const plan = planAutoScope(secret, vault);
    const entry = plan.find(
      (e) => e.cell.repoId === "r1" && e.cell.env === "development",
    );
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("skip-sibling-conflict");
  });

  it("same variant different key → NOT a conflict, should be 'add'", () => {
    const sibling = makeSecret({
      id: "s-sibling",
      key: "OTHER_KEY",
      variant: "test",
      scopes: [{ repoId: "r1", env: "development" }],
    });
    const vault = baseVault({ secrets: [sibling] });
    const secret = makeSecret({ key: "API_KEY", variant: "test" });
    const plan = planAutoScope(secret, vault);
    const entry = plan.find(
      (e) => e.cell.repoId === "r1" && e.cell.env === "development",
    );
    expect(entry?.action).toBe("add");
  });

  it("different variant same key different namespace → NOT a conflict", () => {
    const sibling = makeSecret({
      id: "s-sibling",
      key: "API_KEY",
      namespace: "paypal",
      variant: "live",
      scopes: [{ repoId: "r1", env: "development" }],
    });
    const vault = baseVault({ secrets: [sibling] });
    const secret = makeSecret({
      key: "API_KEY",
      namespace: "stripe",
      variant: "test",
    });
    const plan = planAutoScope(secret, vault);
    const entry = plan.find(
      (e) => e.cell.repoId === "r1" && e.cell.env === "development",
    );
    expect(entry?.action).toBe("add");
  });
});

// ---------------------------------------------------------------------------
// applyAutoScope
// ---------------------------------------------------------------------------
describe("applyAutoScope", () => {
  it("adds only 'add' action cells to the secret's scopes", () => {
    const cell = { repoId: "r1", env: "development" };
    const plan = [
      { cell, action: "add" as const },
      { cell: { repoId: "r1", env: "production" }, action: "skip-sibling-conflict" as const },
    ];
    const secret = makeSecret({ key: "API_KEY", variant: "test" });
    const result = applyAutoScope(secret, plan);
    expect(result.scopes).toContainEqual(cell);
    expect(result.scopes).not.toContainEqual({ repoId: "r1", env: "production" });
  });

  it("with no 'add' actions, returns same-shaped data with unchanged scopes", () => {
    const plan = [
      { cell: { repoId: "r1", env: "development" }, action: "skip-already-scoped" as const },
    ];
    const secret = makeSecret({
      key: "API_KEY",
      variant: "test",
      scopes: [{ repoId: "r1", env: "development" }],
    });
    const result = applyAutoScope(secret, plan);
    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]).toEqual({ repoId: "r1", env: "development" });
  });
});
