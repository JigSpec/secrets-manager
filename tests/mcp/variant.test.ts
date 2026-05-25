/**
 * MCP variant feature — integration test suite.
 *
 * Exercises the MCP boundary for the Phase 1 variant exposure:
 *   - `add_secret` with `variant` forwarding (auto-scope, sibling-conflict skip,
 *     identity-triple conflict, invalid-variant client-side validation)
 *   - `env_variant_list` / `env_variant_set` / `env_variant_unset` tools
 *     (dispatch correctness, validation, NOT_FOUND, orphan-cleanup parity)
 *
 * Seeds a V2 vault so the v2→latest migration injects DEFAULT_ENV_VARIANT_MAP
 * automatically (development/test/local → test, staging/stage/preview → staging,
 * production/prod/live → live).
 *
 * Each test gets its own daemon (beforeEach/afterEach) because `add_secret`
 * mutates global vault state and the (key, namespace, variant) identity rule
 * makes shared state across tests fragile.
 *
 * Run:  pnpm test tests/mcp/variant.test.ts
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import type { VaultData } from "@/lib/vault/schema";

import { callTool } from "../../mcp/tools/index";
import type { McpToolResult } from "../../mcp/server";

// Seed as V2 so migrateToLatest injects DEFAULT_ENV_VARIANT_MAP on first load.
// Mirrors tests/cli/env-variant.test.ts so the assertions on the default map
// are valid (development → test, staging → staging, production → live).
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
let scratch: string;
let daemon: SpawnedDaemon | null = null;

beforeEach(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-mcp-variant-"));
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

/** Shorthand: call an MCP tool against the per-test daemon. */
function tool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  return callTool(name, args, { socketPath: daemon!.socketPath });
}

/** Parse the JSON payload from a successful MCP result. */
function parse(result: McpToolResult): unknown {
  const block = result.content.find((c) => c.type === "text");
  if (!block) {
    throw new Error(
      `parse(): McpToolResult contains no text content block. isError=${String(result.isError)}`,
    );
  }
  return JSON.parse(block.text);
}

/** Concatenate all text blocks (used to inspect error messages). */
function text(result: McpToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Write a value to a tempfile inside the per-test scratch dir. */
async function tmpFile(content: string): Promise<string> {
  const p = path.join(scratch, `v-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(p, content, "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCP variant feature", () => {
  // -------------------------------------------------------------------------
  // a. add_secret with variant — happy path
  // -------------------------------------------------------------------------
  it("add_secret with variant=test auto-scopes to every cell that maps to 'test'", async () => {
    const vp = await tmpFile("sk_test_abc");
    const r = await tool("add_secret", {
      key: "STRIPE_KEY",
      variant: "test",
      valuePath: vp,
      description: "Stripe test secret for variant auto-scope verification.",
    });
    expect(r.isError).toBeFalsy();
    const data = parse(r) as {
      secret: {
        variant?: string;
        scopes: { repoId: string; env: string }[];
      };
    };
    expect(data.secret.variant).toBe("test");
    // r1/development and r2/development both map to "test" via the default map.
    expect(data.secret.scopes).toContainEqual({ repoId: "r1", env: "development" });
    expect(data.secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    // production (→ live) and staging (→ staging) MUST NOT be auto-scoped.
    expect(data.secret.scopes).not.toContainEqual({ repoId: "r1", env: "production" });
    expect(data.secret.scopes).not.toContainEqual({ repoId: "r1", env: "staging" });
    expect(data.secret.scopes).not.toContainEqual({ repoId: "r2", env: "staging" });
  });

  // -------------------------------------------------------------------------
  // b. add_secret with invalid variant — uppercase, hyphen, leading digit
  // -------------------------------------------------------------------------
  it("add_secret with invalid variant 'Invalid-Variant' (uppercase + hyphen) returns isError with regex hint", async () => {
    const vp = await tmpFile("v");
    const r = await tool("add_secret", {
      key: "STRIPE_KEY",
      variant: "Invalid-Variant",
      valuePath: vp,
      description: "Should reject before reaching the daemon.",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/variant/i);
    expect(text(r)).toMatch(/\[a-z\]\[a-z0-9\]\*/);
  });

  it("add_secret with invalid variant 'test-variant' (contains hyphen) returns isError", async () => {
    const vp = await tmpFile("v");
    const r = await tool("add_secret", {
      key: "STRIPE_KEY",
      variant: "test-variant",
      valuePath: vp,
      description: "Should reject hyphen.",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/variant/i);
  });

  it("add_secret with invalid variant '1test' (leading digit) returns isError", async () => {
    const vp = await tmpFile("v");
    const r = await tool("add_secret", {
      key: "STRIPE_KEY",
      variant: "1test",
      valuePath: vp,
      description: "Should reject leading digit.",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/variant/i);
  });

  // -------------------------------------------------------------------------
  // c. add_secret identity-triple conflict
  // -------------------------------------------------------------------------
  it("add_secret with duplicate (key, namespace, variant) triple returns CONFLICT", async () => {
    const vp1 = await tmpFile("v1");
    const first = await tool("add_secret", {
      key: "STRIPE_KEY",
      variant: "test",
      valuePath: vp1,
      description: "First add — should succeed.",
    });
    expect(first.isError).toBeFalsy();

    const vp2 = await tmpFile("v2");
    const second = await tool("add_secret", {
      key: "STRIPE_KEY",
      variant: "test",
      valuePath: vp2,
      description: "Duplicate triple — should CONFLICT.",
    });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("CONFLICT");
  });

  // -------------------------------------------------------------------------
  // d. add_secret sibling-conflict skip
  // -------------------------------------------------------------------------
  it("add_secret with variant skips cells already owned by a sibling and reports them in skippedVariants", async () => {
    // 1) Add a 'live' variant — auto-scopes to r1/production only by default.
    const vp1 = await tmpFile("live-val");
    const sibling = await tool("add_secret", {
      key: "API_KEY",
      variant: "live",
      valuePath: vp1,
      description: "Live sibling that will block r1/development.",
    });
    expect(sibling.isError).toBeFalsy();

    // 2) Manually scope the live sibling onto r1/development so it occupies
    //    the cell that the next 'test' variant would normally auto-scope to.
    const scopeR = await tool("scope_secret", {
      secret: "API_KEY",
      repo: "r1",
      env: "development",
    });
    expect(scopeR.isError).toBeFalsy();

    // 3) Add a 'test' variant for the same key — r1/development is now owned
    //    by the sibling, so auto-scope must skip it (and report it in
    //    skippedVariants), while r2/development still receives the scope.
    const vp2 = await tmpFile("test-val");
    const r = await tool("add_secret", {
      key: "API_KEY",
      variant: "test",
      valuePath: vp2,
      description: "Test variant — r1/development should be skipped.",
    });
    expect(r.isError).toBeFalsy();
    const data = parse(r) as {
      secret: { scopes: { repoId: string; env: string }[] };
      skippedVariants?: { repoId: string; env: string }[];
    };
    // r1/development was blocked by the live sibling
    expect(data.secret.scopes).not.toContainEqual({ repoId: "r1", env: "development" });
    // r2/development should still be scoped (no sibling there)
    expect(data.secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    // The skipped cell must surface in the response — proves rest-spread
    // through dispatch() preserves daemon's extra fields.
    expect(data.skippedVariants).toBeDefined();
    expect(data.skippedVariants).toContainEqual(
      expect.objectContaining({ repoId: "r1", env: "development" }),
    );
  });

  // -------------------------------------------------------------------------
  // e. env_variant_list returns the default V3 map after V2 migration
  // -------------------------------------------------------------------------
  it("env_variant_list returns the default envVariantMap after V2→latest migration", async () => {
    const r = await tool("env_variant_list");
    expect(r.isError).toBeFalsy();
    const data = parse(r) as {
      envVariantMap: {
        global: Record<string, string>;
        repos: Record<string, Record<string, string>>;
      };
    };
    expect(data.envVariantMap.global["development"]).toBe("test");
    expect(data.envVariantMap.global["staging"]).toBe("staging");
    expect(data.envVariantMap.global["production"]).toBe("live");
    expect(data.envVariantMap.repos).toEqual({});
  });

  // -------------------------------------------------------------------------
  // f. env_variant_set (global + per-repo) persists; per-repo does not
  //    shadow other repos' global mapping.
  // -------------------------------------------------------------------------
  it("env_variant_set with global scope persists and surfaces in subsequent env_variant_list", async () => {
    const setR = await tool("env_variant_set", { env: "preview", variant: "test" });
    expect(setR.isError).toBeFalsy();

    const listR = await tool("env_variant_list");
    expect(listR.isError).toBeFalsy();
    const data = parse(listR) as {
      envVariantMap: { global: Record<string, string>; repos: Record<string, Record<string, string>> };
    };
    expect(data.envVariantMap.global["preview"]).toBe("test");
  });

  it("env_variant_set with per-repo scope sets a per-repo override that does not affect global", async () => {
    const setR = await tool("env_variant_set", {
      env: "development",
      variant: "preview",
      repo: "r1",
    });
    expect(setR.isError).toBeFalsy();

    const listR = await tool("env_variant_list");
    expect(listR.isError).toBeFalsy();
    const data = parse(listR) as {
      envVariantMap: { global: Record<string, string>; repos: Record<string, Record<string, string>> };
    };
    // Per-repo override is recorded under repos[r1]
    expect(data.envVariantMap.repos["r1"]?.["development"]).toBe("preview");
    // Global mapping for development must remain "test" — per-repo override
    // does NOT shadow other repos. r2 still gets "test" via global.
    expect(data.envVariantMap.global["development"]).toBe("test");
  });

  // -------------------------------------------------------------------------
  // g. env_variant_set unknown repo → NOT_FOUND
  // -------------------------------------------------------------------------
  it("env_variant_set with an unknown repo id returns NOT_FOUND", async () => {
    const r = await tool("env_variant_set", {
      env: "development",
      variant: "test",
      repo: "nonexistent-repo",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // h. env_variant_set invalid variant (client-side validation)
  // -------------------------------------------------------------------------
  it("env_variant_set with variant 'Invalid-Variant' returns isError (client-side regex)", async () => {
    const r = await tool("env_variant_set", {
      env: "development",
      variant: "Invalid-Variant",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/variant/i);
  });

  it("env_variant_set with empty-string variant returns isError", async () => {
    const r = await tool("env_variant_set", {
      env: "development",
      variant: "",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/variant/i);
  });

  // -------------------------------------------------------------------------
  // i. env_variant_unset (global + per-repo) — set then unset; orphan
  //    cleanup parity with finding #13 from tests/cli/env-variant.test.ts.
  // -------------------------------------------------------------------------
  it("env_variant_unset removes a global override", async () => {
    await tool("env_variant_set", { env: "qa", variant: "test" });
    const unsetR = await tool("env_variant_unset", { env: "qa" });
    expect(unsetR.isError).toBeFalsy();

    const listR = await tool("env_variant_list");
    const data = parse(listR) as {
      envVariantMap: { global: Record<string, string>; repos: Record<string, Record<string, string>> };
    };
    expect(data.envVariantMap.global["qa"]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // set_variant — Phase 4 in-place variant mutation
  // -------------------------------------------------------------------------
  describe("set_variant", () => {
    it("rejects when neither variant nor unset is provided", async () => {
      const r = await tool("set_variant", { secret: "API_KEY" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/variant/i);
    });

    it("rejects when both variant and unset are provided", async () => {
      const r = await tool("set_variant", {
        secret: "API_KEY",
        variant: "test",
        unset: true,
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/both/i);
    });

    it("rejects an invalid variant client-side before reaching the daemon", async () => {
      const r = await tool("set_variant", {
        secret: "API_KEY",
        variant: "Invalid-Variant",
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/variant/i);
      expect(text(r)).toMatch(/\[a-z\]\[a-z0-9\]\*/);
    });

    it("returns NOT_FOUND for an unknown secret needle", async () => {
      const r = await tool("set_variant", {
        secret: "NONEXISTENT",
        variant: "test",
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("NOT_FOUND");
    });

    it("sets the variant and auto-scopes a variant-less secret", async () => {
      const vp = await tmpFile("v");
      const add = await tool("add_secret", {
        key: "STRIPE_KEY",
        valuePath: vp,
        description: "Variant-less initially; promoted via set_variant.",
      });
      expect(add.isError).toBeFalsy();

      const r = await tool("set_variant", {
        secret: "STRIPE_KEY",
        variant: "test",
      });
      expect(r.isError).toBeFalsy();
      const data = parse(r) as {
        secret: { variant?: string; scopes: { repoId: string; env: string }[] };
      };
      expect(data.secret.variant).toBe("test");
      expect(data.secret.scopes).toContainEqual({ repoId: "r1", env: "development" });
      expect(data.secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    });

    it("returns CONFLICT when the new (key, namespace, variant) triple is already occupied", async () => {
      const vp1 = await tmpFile("v1");
      const first = await tool("add_secret", {
        key: "API_KEY",
        namespace: "stripe",
        variant: "test",
        valuePath: vp1,
        description: "Stripe test API_KEY (existing variant=test).",
      });
      expect(first.isError).toBeFalsy();

      const vp2 = await tmpFile("v2");
      const sibling = await tool("add_secret", {
        key: "API_KEY",
        namespace: "stripe",
        variant: "live",
        valuePath: vp2,
        description: "Stripe live API_KEY (will try to flip to test).",
      });
      expect(sibling.isError).toBeFalsy();
      const siblingId = (parse(sibling) as { secret: { id: string } }).secret.id;

      const r = await tool("set_variant", { secret: siblingId, variant: "test" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("CONFLICT");
    });

    it("preserves existing scopes when unsetting the variant", async () => {
      const vp = await tmpFile("v");
      const add = await tool("add_secret", {
        key: "STRIPE_KEY",
        variant: "test",
        valuePath: vp,
        description: "Will be unset and verify scopes survive.",
      });
      expect(add.isError).toBeFalsy();
      const before = (parse(add) as {
        secret: { id: string; scopes: { repoId: string; env: string }[] };
      }).secret;
      expect(before.scopes.length).toBeGreaterThan(0);

      const r = await tool("set_variant", { secret: before.id, unset: true });
      expect(r.isError).toBeFalsy();
      const after = (parse(r) as {
        secret: { variant?: string; scopes: { repoId: string; env: string }[] };
      }).secret;
      expect(after.variant).toBeUndefined();
      for (const sc of before.scopes) {
        expect(after.scopes).toContainEqual(sc);
      }
    });

    it("returns AMBIGUOUS when the bare key matches multiple secrets", async () => {
      const vp1 = await tmpFile("v1");
      await tool("add_secret", {
        key: "API_KEY",
        variant: "test",
        valuePath: vp1,
        description: "First API_KEY (test).",
      });
      const vp2 = await tmpFile("v2");
      await tool("add_secret", {
        key: "API_KEY",
        variant: "live",
        valuePath: vp2,
        description: "Second API_KEY (live).",
      });
      const r = await tool("set_variant", { secret: "API_KEY", variant: "staging" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("AMBIGUOUS");
    });
  });

  it("env_variant_unset removes a per-repo override and cleans up the empty repo entry (no orphan {})", async () => {
    // Set a single per-repo override for r1
    const setR = await tool("env_variant_set", {
      env: "development",
      variant: "preview",
      repo: "r1",
    });
    expect(setR.isError).toBeFalsy();

    // Unset the only per-repo override — repos["r1"] must be deleted entirely
    const unsetR = await tool("env_variant_unset", {
      env: "development",
      repo: "r1",
    });
    expect(unsetR.isError).toBeFalsy();

    const listR = await tool("env_variant_list");
    const data = parse(listR) as {
      envVariantMap: { global: Record<string, string>; repos: Record<string, Record<string, string>> };
    };
    // The repos["r1"] key must be ABSENT — not present as an empty {}.
    expect(data.envVariantMap.repos["r1"]).toBeUndefined();
  });
});
