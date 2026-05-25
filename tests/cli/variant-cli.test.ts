/**
 * CLI tests: variant exposure (Phase 2)
 *
 * These drive the CLI through `dispatchCommand` from `@/lib/cli/router` to
 * exercise the argv-parser layer that sits above the daemon. The existing
 * `tests/cli/env-variant.test.ts` already covers the daemon IPC contract via
 * `sendCommand`; this file covers the CLI argv → daemon → response round-trip
 * for the new Phase 2 surfaces:
 *
 *   - `sm add-secret --variant V ...`
 *   - `sm env-variant <list|set|unset>` (new sub-verb dispatching command)
 *
 * Tests use a live daemon (per-test, via `_helpers/daemon-harness.ts`) and a
 * V2 seed so that the daemon's migrateToLatest injects DEFAULT_ENV_VARIANT_MAP.
 * The seed mirrors `tests/cli/env-variant.test.ts:18-36` so auto-scope
 * assertions can reuse the same expected (repo, env) cells.
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
import { dispatchCommand } from "@/lib/cli/router";

// Seed as v2 so that migrateToLatest injects DEFAULT_ENV_VARIANT_MAP on first
// load. Two repos with overlapping environments — mirrors the seed in
// tests/cli/env-variant.test.ts so the auto-scope expected cells are
// (r1/development, r2/development) for variant "test" by default.
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
let prevSocketEnv: string | undefined;

async function writeValueFile(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sm-val-"));
  const p = path.join(dir, "value.txt");
  await writeFile(p, value, "utf8");
  return p;
}

beforeEach(async () => {
  tmp = await makeVaultDir();
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
  // The CLI's sendCommand resolves the socket path via socketPath(), which
  // reads SECRETS_MANAGER_VAULT_DIR (see lib/daemon/paths.ts). Point it at
  // the per-test vault directory so the CLI talks to the spawned daemon.
  prevSocketEnv = process.env.SECRETS_MANAGER_VAULT_DIR;
  process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  if (prevSocketEnv === undefined) {
    delete process.env.SECRETS_MANAGER_VAULT_DIR;
  } else {
    process.env.SECRETS_MANAGER_VAULT_DIR = prevSocketEnv;
  }
  await cleanupVaultDir(tmp);
});

describe("CLI: variant exposure (Phase 2)", () => {
  // -----------------------------------------------------------------------
  // (a) add-secret --variant happy path
  // -----------------------------------------------------------------------
  it("add-secret --variant test auto-scopes to every cell mapping to 'test'", async () => {
    const valuePath = await writeValueFile("sk_test_abc");
    const r = await dispatchCommand("add-secret", [
      "--key",
      "STRIPE_KEY",
      "--variant",
      "test",
      "--value-from-file",
      valuePath,
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as {
      variant?: string;
      scopes: { repoId: string; env: string }[];
    };
    expect(secret.variant).toBe("test");
    expect(secret.scopes).toContainEqual({ repoId: "r1", env: "development" });
    expect(secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    // Should NOT auto-scope into staging or production cells.
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "production" });
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "staging" });
  });

  // -----------------------------------------------------------------------
  // (b) add-secret --variant invalid → daemon-side INVALID_INPUT
  // -----------------------------------------------------------------------
  it("add-secret --variant 'Invalid-Variant' returns INVALID_INPUT from the daemon", async () => {
    const valuePath = await writeValueFile("v");
    const r = await dispatchCommand("add-secret", [
      "--key",
      "API_KEY",
      "--variant",
      "Invalid-Variant",
      "--value-from-file",
      valuePath,
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/variant/);
  });

  // -----------------------------------------------------------------------
  // (c) add-secret --variant is OPTIONAL — omitting it is supported
  // -----------------------------------------------------------------------
  it("add-secret without --variant creates a secret with no variant field", async () => {
    const valuePath = await writeValueFile("postgres://x");
    const r = await dispatchCommand("add-secret", [
      "--key",
      "DB_URL",
      "--value-from-file",
      valuePath,
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as { variant?: string };
    expect(secret.variant).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // (d) env-variant list — end-to-end via dispatchCommand
  // -----------------------------------------------------------------------
  it("env-variant list returns the default map after V2→V3 migration", async () => {
    const r = await dispatchCommand("env-variant", ["list"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const map = r.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.global["development"]).toBe("test");
    expect(map.global["production"]).toBe("live");
    expect(map.global["staging"]).toBe("staging");
    expect(map.repos).toEqual({});
  });

  // -----------------------------------------------------------------------
  // (e) env-variant set global → persisted and surfaced by list
  // -----------------------------------------------------------------------
  it("env-variant set --env qa --variant test persists a global override", async () => {
    const set = await dispatchCommand("env-variant", [
      "set",
      "--env",
      "qa",
      "--variant",
      "test",
    ]);
    expect(set.ok).toBe(true);

    const list = await dispatchCommand("env-variant", ["list"]);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.global["qa"]).toBe("test");
  });

  // -----------------------------------------------------------------------
  // (f) env-variant set per-repo
  // -----------------------------------------------------------------------
  it("env-variant set --env qa --variant preview --repo r1 persists a per-repo override without affecting global", async () => {
    const set = await dispatchCommand("env-variant", [
      "set",
      "--env",
      "qa",
      "--variant",
      "preview",
      "--repo",
      "r1",
    ]);
    expect(set.ok).toBe(true);

    const list = await dispatchCommand("env-variant", ["list"]);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.repos["r1"]?.["qa"]).toBe("preview");
    // The seed produced a fresh vault for this test; no global qa override
    // should be present.
    expect(map.global["qa"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // (g) env-variant set --repo with an unknown repo ID → NOT_FOUND
  // -----------------------------------------------------------------------
  it("env-variant set --repo with unknown repo ID returns NOT_FOUND from the daemon", async () => {
    const r = await dispatchCommand("env-variant", [
      "set",
      "--env",
      "qa",
      "--variant",
      "test",
      "--repo",
      "nonexistent",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  // -----------------------------------------------------------------------
  // (h) env-variant set with invalid variant → INVALID_INPUT (daemon-side)
  // -----------------------------------------------------------------------
  it("env-variant set --variant 'Invalid-Variant' returns INVALID_INPUT from the daemon", async () => {
    const r = await dispatchCommand("env-variant", [
      "set",
      "--env",
      "qa",
      "--variant",
      "Invalid-Variant",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // (i) env-variant unset global
  // -----------------------------------------------------------------------
  it("env-variant unset removes a global override that was just set", async () => {
    const set = await dispatchCommand("env-variant", [
      "set",
      "--env",
      "qa",
      "--variant",
      "test",
    ]);
    expect(set.ok).toBe(true);

    const unset = await dispatchCommand("env-variant", [
      "unset",
      "--env",
      "qa",
    ]);
    expect(unset.ok).toBe(true);

    const list = await dispatchCommand("env-variant", ["list"]);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.global["qa"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // (j) env-variant unset per-repo with orphan-cleanup
  // -----------------------------------------------------------------------
  it("env-variant unset removes repos[repoId] entirely when the last per-repo override is removed", async () => {
    const set = await dispatchCommand("env-variant", [
      "set",
      "--env",
      "qa",
      "--variant",
      "preview",
      "--repo",
      "r2",
    ]);
    expect(set.ok).toBe(true);

    const unset = await dispatchCommand("env-variant", [
      "unset",
      "--env",
      "qa",
      "--repo",
      "r2",
    ]);
    expect(unset.ok).toBe(true);

    const list = await dispatchCommand("env-variant", ["list"]);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const map = list.envVariantMap as {
      global: Record<string, string>;
      repos: Record<string, Record<string, string>>;
    };
    expect(map.repos["r2"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // (k) Argv: env-variant with no sub-verb → CLI-side INVALID_INPUT
  // -----------------------------------------------------------------------
  it("env-variant with no sub-verb returns INVALID_INPUT with the usage banner", async () => {
    const r = await dispatchCommand("env-variant", []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/^usage: sm env-variant <list\|set\|unset>/);
  });

  // -----------------------------------------------------------------------
  // (l) Argv: env-variant with unknown sub-verb → CLI-side INVALID_INPUT
  // -----------------------------------------------------------------------
  it("env-variant with an unknown sub-verb returns INVALID_INPUT mentioning the bad sub-verb", async () => {
    const r = await dispatchCommand("env-variant", ["foo"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toContain('unknown sub-verb "foo"');
  });

  // -----------------------------------------------------------------------
  // (m) Argv: env-variant set without --env → CLI-side INVALID_INPUT
  // -----------------------------------------------------------------------
  it("env-variant set without --env returns INVALID_INPUT", async () => {
    const r = await dispatchCommand("env-variant", [
      "set",
      "--variant",
      "test",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // (n) Argv: env-variant set without --variant → CLI-side INVALID_INPUT
  // -----------------------------------------------------------------------
  it("env-variant set without --variant returns INVALID_INPUT", async () => {
    const r = await dispatchCommand("env-variant", ["set", "--env", "qa"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // (o) Argv: env-variant unset without --env → CLI-side INVALID_INPUT
  // -----------------------------------------------------------------------
  it("env-variant unset without --env returns INVALID_INPUT", async () => {
    const r = await dispatchCommand("env-variant", ["unset"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // -----------------------------------------------------------------------
  // (p) set-variant happy path — flip a variant-less secret to "test"
  // -----------------------------------------------------------------------
  it("set-variant <secret> --variant test sets the variant and re-runs auto-scope", async () => {
    const vp = await writeValueFile("v");
    const add = await dispatchCommand("add-secret", [
      "--key",
      "STRIPE_KEY",
      "--value-from-file",
      vp,
    ]);
    expect(add.ok).toBe(true);

    const r = await dispatchCommand("set-variant", ["STRIPE_KEY", "--variant", "test"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as {
      variant?: string;
      scopes: { repoId: string; env: string }[];
    };
    expect(secret.variant).toBe("test");
    expect(secret.scopes).toContainEqual({ repoId: "r1", env: "development" });
    expect(secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
  });

  // -----------------------------------------------------------------------
  // (q) set-variant --unset preserves existing scopes
  // -----------------------------------------------------------------------
  it("set-variant <secret> --unset clears the variant and preserves existing scopes", async () => {
    const vp = await writeValueFile("v");
    const add = await dispatchCommand("add-secret", [
      "--key",
      "STRIPE_KEY",
      "--variant",
      "test",
      "--value-from-file",
      vp,
    ]);
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = (add.secret as {
      id: string;
      scopes: { repoId: string; env: string }[];
    });
    expect(before.scopes.length).toBeGreaterThan(0);

    const r = await dispatchCommand("set-variant", [before.id, "--unset"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = r.secret as {
      variant?: string;
      scopes: { repoId: string; env: string }[];
    };
    expect(after.variant).toBeUndefined();
    for (const sc of before.scopes) {
      expect(after.scopes).toContainEqual(sc);
    }
  });

  // -----------------------------------------------------------------------
  // (r) Argv: set-variant without --variant and without --unset → CLI INVALID_INPUT
  // -----------------------------------------------------------------------
  it("set-variant without --variant and without --unset returns INVALID_INPUT", async () => {
    const r = await dispatchCommand("set-variant", ["API_KEY"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/^usage: sm set-variant/);
  });

  // -----------------------------------------------------------------------
  // (s) Argv: set-variant with BOTH --variant and --unset → CLI INVALID_INPUT
  // -----------------------------------------------------------------------
  it("set-variant with both --variant and --unset returns INVALID_INPUT", async () => {
    const r = await dispatchCommand("set-variant", [
      "API_KEY",
      "--variant",
      "test",
      "--unset",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/both/);
  });
});
