/**
 * Tests for per-repo deploy target enumeration (Issue #71).
 *
 * The GUI "Deploy this repo" button needs to compute, from VaultData, the
 * subset of `(repoId, env)` targets that belong to a given repo and have at
 * least one scoped secret. The CLI daemon already does this via
 * `enumerateTargets(data).filter((t) => t.repoId === repo.id)`. We hoist that
 * filter into a named helper so both call sites (server action + tests) share
 * the same definition.
 */
import { describe, expect, it } from "vitest";

import {
  enumerateTargets,
  targetsForRepo,
} from "@/lib/vault/deploy/run-deploy";
import type { VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixture(): VaultData {
  return {
    version: 2,
    repos: [
      { id: "r-alpha", name: "alpha", path: "/tmp/alpha", environments: ["test", "live"] },
      { id: "r-beta", name: "beta", path: "/tmp/beta", environments: ["test", "live"] },
      { id: "r-gamma", name: "gamma", path: "/tmp/gamma", environments: ["test"] },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value: "v1",
        scopes: [
          { repoId: "r-alpha", env: "test" },
          { repoId: "r-alpha", env: "live" },
          { repoId: "r-beta", env: "test" },
        ],
      },
      {
        id: "s2",
        key: "DB_URL",
        value: "v2",
        scopes: [
          { repoId: "r-alpha", env: "test" },
          { repoId: "r-beta", env: "live" },
        ],
      },
      {
        // unscoped secret — must not contribute targets
        id: "s3",
        key: "ORPHAN",
        value: "v3",
        scopes: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// targetsForRepo
// ---------------------------------------------------------------------------

describe("targetsForRepo", () => {
  it("returns only targets whose repoId matches", () => {
    const data = fixture();
    const t = targetsForRepo(data, "r-alpha");
    expect(t.map((x) => `${x.repoId}::${x.env}`).sort()).toEqual([
      "r-alpha::live",
      "r-alpha::test",
    ]);
  });

  it("deduplicates (repoId, env) cells when multiple secrets scope to them", () => {
    // alpha/test is scoped by both s1 and s2 — should appear once.
    const data = fixture();
    const t = targetsForRepo(data, "r-alpha");
    const keys = t.map((x) => `${x.repoId}::${x.env}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns an empty list for a repo with no scoped secrets", () => {
    const data = fixture();
    // gamma has env "test" configured but no secret scopes to it
    const t = targetsForRepo(data, "r-gamma");
    expect(t).toEqual([]);
  });

  it("returns an empty list for an unknown repoId", () => {
    const data = fixture();
    const t = targetsForRepo(data, "r-does-not-exist");
    expect(t).toEqual([]);
  });

  it("is a subset of enumerateTargets", () => {
    const data = fixture();
    const allKeys = new Set(
      enumerateTargets(data).map((t) => `${t.repoId}::${t.env}`),
    );
    for (const repoId of ["r-alpha", "r-beta", "r-gamma"] as const) {
      for (const t of targetsForRepo(data, repoId)) {
        expect(allKeys.has(`${t.repoId}::${t.env}`)).toBe(true);
      }
    }
  });

  it("matches the daemon-handler filter exactly", () => {
    // The CLI daemon handler uses:
    //   enumerateTargets(data).filter((t) => t.repoId === repo.id)
    // targetsForRepo must produce the same set.
    const data = fixture();
    for (const repoId of ["r-alpha", "r-beta", "r-gamma"] as const) {
      const direct = targetsForRepo(data, repoId)
        .map((t) => `${t.repoId}::${t.env}`)
        .sort();
      const viaFilter = enumerateTargets(data)
        .filter((t) => t.repoId === repoId)
        .map((t) => `${t.repoId}::${t.env}`)
        .sort();
      expect(direct).toEqual(viaFilter);
    }
  });
});
