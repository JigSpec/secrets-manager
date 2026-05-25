import { describe, expect, it } from "vitest";

import {
  resolveVariant,
  cellsForVariant,
  DEFAULT_ENV_VARIANT_MAP,
} from "@/lib/vault/variant/resolve";
import type { EnvVariantMap } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// resolveVariant
// ---------------------------------------------------------------------------
describe("resolveVariant", () => {
  it("resolveVariant(undefined, ...) uses DEFAULT_ENV_VARIANT_MAP", () => {
    // Default map: development → test, staging → staging, production → live
    expect(resolveVariant(undefined, "r1", "development")).toBe("test");
    expect(resolveVariant(undefined, "r1", "staging")).toBe("staging");
    expect(resolveVariant(undefined, "r1", "production")).toBe("live");
  });

  it("global override wins over default", () => {
    const map: EnvVariantMap = {
      global: { development: "preview" },
      repos: {},
    };
    expect(resolveVariant(map, "r1", "development")).toBe("preview");
  });

  it("per-repo override wins over global override", () => {
    const map: EnvVariantMap = {
      global: { development: "preview" },
      repos: { r1: { development: "special" } },
    };
    expect(resolveVariant(map, "r1", "development")).toBe("special");
    // other repos still see global
    expect(resolveVariant(map, "r2", "development")).toBe("preview");
  });

  it("returns undefined for an env with no mapping at any level", () => {
    const map: EnvVariantMap = {
      global: {},
      repos: {},
    };
    expect(resolveVariant(map, "r1", "review-env")).toBeUndefined();
  });

  it("DEFAULT_ENV_VARIANT_MAP is exported and has the expected shape", () => {
    expect(DEFAULT_ENV_VARIANT_MAP).toMatchObject({
      development: "test",
      staging: "staging",
      production: "live",
    });
  });
});

// ---------------------------------------------------------------------------
// cellsForVariant
// ---------------------------------------------------------------------------
describe("cellsForVariant", () => {
  const repos = [
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
  ];

  it("returns all (repoId, env) pairs that map to the target variant (default map)", () => {
    // variant=test should match development in all repos
    const cells = cellsForVariant("test", repos, undefined);
    expect(cells).toContainEqual({ repoId: "r1", env: "development" });
    // staging → staging, not test
    expect(cells).not.toContainEqual({ repoId: "r2", env: "staging" });
    // production → live, not test
    expect(cells).not.toContainEqual({ repoId: "r1", env: "production" });
  });

  it("returns correct cells across multiple repos (variant=live)", () => {
    const cells = cellsForVariant("live", repos, undefined);
    // production → live
    expect(cells).toContainEqual({ repoId: "r1", env: "production" });
    // staging → staging, not live
    expect(cells).not.toContainEqual({ repoId: "r2", env: "staging" });
  });

  it("returns empty array when no cells map to that variant", () => {
    const map: EnvVariantMap = { global: {}, repos: {} };
    const cells = cellsForVariant("live", repos, map);
    expect(cells).toEqual([]);
  });

  it("per-repo override only applies to that specific repo", () => {
    // r1's development maps to 'preview', r2's staging keeps default (staging)
    const map: EnvVariantMap = {
      global: { development: "test", staging: "staging", production: "live" },
      repos: { r1: { development: "preview" } },
    };
    const previewCells = cellsForVariant("preview", repos, map);
    expect(previewCells).toContainEqual({ repoId: "r1", env: "development" });
    // r2 has no development env anyway, but r1 no longer maps to test
    const testCells = cellsForVariant("test", repos, map);
    expect(testCells).not.toContainEqual({ repoId: "r1", env: "development" });
  });
});
