import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import { sendCommand } from "@/lib/cli/ipc-client";
import type { VaultData } from "@/lib/vault/schema";

// Seed as v2 so that migrateToLatest injects DEFAULT_ENV_VARIANT_MAP on first load.
const SEED: VaultData = {
  version: 2,
  repos: [
    {
      id: "r1",
      name: "alpha",
      path: "/repos/alpha",
      environments: ["development", "production", "staging"],
    },
    {
      id: "r2",
      name: "beta",
      path: "/repos/beta",
      environments: ["development", "staging"],
    },
  ],
  secrets: [],
} as unknown as VaultData;

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeEach(async () => {
  tmp = await makeVaultDir();
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
});

function s(req: { cmd: string; args?: Record<string, unknown> }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

async function writeValueFile(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sm-val-"));
  const p = path.join(dir, "value.txt");
  await writeFile(p, value, "utf8");
  return p;
}

describe("env-variant CLI commands", () => {
  // -----------------------------------------------------------------------
  // env-variant-list
  // -----------------------------------------------------------------------
  it("env-variant-list returns the default map", async () => {
    const r = await s({ cmd: "env-variant-list" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Default map has development→test, staging→staging, production→live
    const map = r.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.global["development"]).toBe("test");
    expect(map.global["staging"]).toBe("staging");
    expect(map.global["production"]).toBe("live");
    expect(map.repos).toEqual({});
  });

  // -----------------------------------------------------------------------
  // env-variant-set (global)
  // -----------------------------------------------------------------------
  it("env-variant-set with global scope persists and is returned by subsequent list", async () => {
    const set = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "preview" },
    });
    expect(set.ok).toBe(true);

    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.global["development"]).toBe("preview");
  });

  // -----------------------------------------------------------------------
  // env-variant-set (per-repo)
  // -----------------------------------------------------------------------
  it("env-variant-set with --repo scope sets a per-repo override", async () => {
    const set = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "preview", repo: "r1" },
    });
    expect(set.ok).toBe(true);

    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.repos["r1"]?.["development"]).toBe("preview");
    // global should not be affected
    expect(map.global["development"]).not.toBe("preview");
  });

  // -----------------------------------------------------------------------
  // env-variant-unset (global)
  // -----------------------------------------------------------------------
  it("env-variant-unset removes a global override", async () => {
    // First set it
    await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "preview" },
    });

    // Then unset it
    const unset = await s({
      cmd: "env-variant-unset",
      args: { env: "development" },
    });
    expect(unset.ok).toBe(true);

    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.global["development"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // env-variant-unset (per-repo)
  // -----------------------------------------------------------------------
  it("env-variant-unset removes a per-repo override", async () => {
    await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "preview", repo: "r1" },
    });

    const unset = await s({
      cmd: "env-variant-unset",
      args: { env: "development", repo: "r1" },
    });
    expect(unset.ok).toBe(true);

    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.repos["r1"]?.["development"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // env-variant-set validation
  // -----------------------------------------------------------------------
  it("env-variant-set with invalid (empty) env returns INVALID_INPUT", async () => {
    const r = await s({
      cmd: "env-variant-set",
      args: { env: "", variant: "test" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // env-variant-set with unknown repo ID → NOT_FOUND (M3 / L7)
  // -----------------------------------------------------------------------
  it("env-variant-set with unknown repo ID returns NOT_FOUND", async () => {
    const r = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "test", repo: "nonexistent-repo" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  // -----------------------------------------------------------------------
  // add-secret with --variant → auto-scoping
  // -----------------------------------------------------------------------
  it("add-secret with --variant test auto-scopes to all cells that map to 'test'", async () => {
    const valuePath = await writeValueFile("sk_test_abc");
    const r = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_KEY", variant: "test", valuePath },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Should auto-scope to r1/development and r2/development (both map to test by default)
    const secret = r.secret as { scopes: { repoId: string; env: string }[] };
    expect(secret.scopes).toContainEqual({ repoId: "r1", env: "development" });
    expect(secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    // Should NOT scope to production (→ live) or staging (→ staging)
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "production" });
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "staging" });
  });

  it("add-secret with --variant test when a sibling already occupies a cell → cell is skipped and reported in skippedVariants", async () => {
    // Add a 'live' variant secret and directly scope it to r1/development
    // via add-secret (auto-scope will place it on production cells for 'live').
    // Then manually scope it to development via the `scope` command so it
    // occupies that cell and blocks the subsequent 'test' variant.
    const vp1 = await writeValueFile("live-val");
    const sibling = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_KEY", variant: "live", valuePath: vp1 },
    });
    expect(sibling.ok).toBe(true);

    // Use the `scope` command (which accepts: secret key/id, repo id/name, env)
    // to add r1/development to the live-variant sibling.
    const scopeR = await s({
      cmd: "scope",
      args: { secret: "STRIPE_KEY", repo: "r1", env: "development" },
    });
    expect(scopeR.ok).toBe(true);

    // Now add a 'test' variant — r1/development should be skipped due to sibling conflict
    const vp2 = await writeValueFile("test-val");
    const r = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_KEY", variant: "test", valuePath: vp2 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as { scopes: { repoId: string; env: string }[] };
    // r1/development is blocked by the live sibling
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "development" });
    // r2/development should still be scoped (no sibling there)
    expect(secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    // The skipped cell should be reported in the response
    const skipped = r.skippedVariants as { repoId: string; env: string }[] | undefined;
    expect(skipped).toBeDefined();
    expect(skipped).toContainEqual(expect.objectContaining({ repoId: "r1", env: "development" }));
  });

  it("add-secret with same (key, namespace, variant) triple → CONFLICT error", async () => {
    const vp1 = await writeValueFile("v1");
    await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp1 },
    });

    const vp2 = await writeValueFile("v2");
    const r = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp2 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
  });

  it("add-secret with same key+namespace but different variant → succeeds", async () => {
    const vp1 = await writeValueFile("v1");
    await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp1 },
    });

    const vp2 = await writeValueFile("v2");
    const r = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "live", valuePath: vp2 },
    });
    expect(r.ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Finding #14 — EnvVariantMapSchema should reject invalid variant strings
  // -----------------------------------------------------------------------
  it("env-variant-set with variant 'Invalid-Variant' (uppercase + hyphens) returns INVALID_INPUT", async () => {
    const r = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "Invalid-Variant" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("env-variant-set with variant '1test' (starts with digit) returns INVALID_INPUT", async () => {
    const r = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "1test" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // Finding #13 — Orphan repo entry accumulation after unset
  // -----------------------------------------------------------------------
  it("env-variant-unset removes the repos[repoId] key entirely when the last per-repo override is removed", async () => {
    // Set a single per-repo override for r1
    const set = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "preview", repo: "r1" },
    });
    expect(set.ok).toBe(true);

    // Unset that single override — repos["r1"] should be completely absent, not {}
    const unset = await s({
      cmd: "env-variant-unset",
      args: { env: "development", repo: "r1" },
    });
    expect(unset.ok).toBe(true);

    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    // The entire repos["r1"] key must be absent (not an empty object {})
    expect(map.repos["r1"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Finding #14 (hyphen case) — variant with hyphens should be rejected
  // -----------------------------------------------------------------------
  it("env-variant-set with variant 'test-variant' (contains hyphen) returns INVALID_INPUT", async () => {
    const r = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "test-variant" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // Empty variant
  // -----------------------------------------------------------------------
  it("env-variant-set with variant '' (empty string) returns INVALID_INPUT", async () => {
    const r = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // Finding #13 (sibling retention) — unset one of several per-repo overrides
  // -----------------------------------------------------------------------
  it("env-variant-unset retains repos[repoId] with remaining overrides when one of several per-repo overrides is removed", async () => {
    // Set two per-repo overrides for r2 across different envs
    const set1 = await s({
      cmd: "env-variant-set",
      args: { env: "development", variant: "preview", repo: "r2" },
    });
    expect(set1.ok).toBe(true);
    const set2 = await s({
      cmd: "env-variant-set",
      args: { env: "staging", variant: "stable", repo: "r2" },
    });
    expect(set2.ok).toBe(true);

    // Unset only the 'development' override — 'staging' override must remain
    const unset = await s({
      cmd: "env-variant-unset",
      args: { env: "development", repo: "r2" },
    });
    expect(unset.ok).toBe(true);

    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    // repos["r2"] must still exist with the remaining staging override
    expect(map.repos["r2"]).toBeDefined();
    expect(map.repos["r2"]["staging"]).toBe("stable");
    // The development override must be gone
    expect(map.repos["r2"]["development"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Empty-map footgun (scope-doc §5 Phase 4 #6 option (a)):
  // env-variant-unset that empties the map → response includes a `note`
  // explaining the daemon falls back to DEFAULT_ENV_VARIANT_MAP rather
  // than disabling auto-scoping.
  // -----------------------------------------------------------------------
  it("env-variant-unset that empties the entire map returns a `note` mentioning DEFAULT_ENV_VARIANT_MAP", async () => {
    // Clear ALL global entries injected by the default map (see
    // DEFAULT_ENV_VARIANT_MAP in lib/vault/variant/resolve.ts). The final
    // unset that drains the map should produce a non-empty `note` warning
    // that the daemon will fall back to DEFAULT_ENV_VARIANT_MAP rather
    // than disabling auto-scoping.
    const list = await s({ cmd: "env-variant-list" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const initialMap = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    const allEnvs = Object.keys(initialMap.global);
    expect(allEnvs.length).toBeGreaterThan(1);

    // Unset all but the last entry — none of those responses should carry note.
    for (const env of allEnvs.slice(0, -1)) {
      const r = await s({ cmd: "env-variant-unset", args: { env } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.note).toBeUndefined();
    }
    // Unset the final entry — this drains the map → note expected.
    const lastEnv = allEnvs[allEnvs.length - 1];
    const finalUnset = await s({
      cmd: "env-variant-unset",
      args: { env: lastEnv },
    });
    expect(finalUnset.ok).toBe(true);
    if (!finalUnset.ok) return;
    expect(finalUnset.note).toBeDefined();
    expect(typeof finalUnset.note).toBe("string");
    expect(finalUnset.note as string).toMatch(/DEFAULT_ENV_VARIANT_MAP/);
  });

  it("env-variant-unset that leaves entries behind does NOT include a `note` field", async () => {
    // The vault ships with 3 default globals. Unset only one of them; two
    // remain → response should NOT include the empty-map note.
    const r = await s({
      cmd: "env-variant-unset",
      args: { env: "development" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toBeUndefined();
  });
});
