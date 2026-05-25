/**
 * Daemon `set-variant` handler — integration tests.
 *
 * Covers the Phase 4 in-place variant mutation handler: input validation,
 * identity-triple conflict detection, auto-scope re-run on set, sibling-conflict
 * skip propagation, and the "preserve scopes on unset" Open Question §6.1
 * resolution.
 *
 * Seeds V2 so migrateToLatest injects DEFAULT_ENV_VARIANT_MAP.
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
import { sendCommand } from "@/lib/cli/ipc-client";
import type { VaultData } from "@/lib/vault/schema";

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

/**
 * Creates a pair of same-key secrets designed to trigger a sibling-conflict
 * skip during planAutoScope:
 *
 *   1. A "live" variant secret for `key` — auto-scoped to r1/production, then
 *      manually scoped onto r1/development so that cell is "owned" by the live
 *      variant.
 *   2. A variant-less duplicate of the same `key` with no initial scopes.
 *      The caller can then call `set-variant` with variant:"test" on the
 *      returned `candidateId` to exercise the skip path.
 */
async function buildConflictingVariantPair(
  key: string,
): Promise<{ siblingId: string; candidateId: string }> {
  // 1. Add a "live" variant sibling — auto-scopes to r1/production.
  const vp1 = await writeValueFile("live-val");
  const sib = await s({ cmd: "add-secret", args: { key, variant: "live", valuePath: vp1 } });
  expect(sib.ok).toBe(true);
  if (!sib.ok) throw new Error("add-secret (live sibling) failed");
  const siblingId = (sib.secret as { id: string }).id;

  // 2. Manually scope the live sibling onto r1/development to block the test variant.
  const scopeR = await s({ cmd: "scope", args: { secret: key, repo: "r1", env: "development" } });
  expect(scopeR.ok).toBe(true);

  // 3. Add a variant-less duplicate of the same key (allowed because variant is
  //    undefined — the identity triple check is skipped and the new secret has no
  //    scopes yet so the disjoint-scope invariant is not violated).
  const vp2 = await writeValueFile("test-val");
  const add = await s({ cmd: "add-secret", args: { key, valuePath: vp2 } });
  expect(add.ok).toBe(true);
  if (!add.ok) throw new Error("add-secret (candidate) failed");
  const candidateId = (add.secret as { id: string }).id;

  return { siblingId, candidateId };
}

describe("set-variant daemon handler", () => {
  // (a) Missing args → INVALID_INPUT
  it("rejects when neither variant nor unset is provided", async () => {
    const r = await s({ cmd: "set-variant", args: { secret: "API_KEY" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // (b) Both variant and unset → INVALID_INPUT
  it("rejects when both variant and unset are provided", async () => {
    const r = await s({
      cmd: "set-variant",
      args: { secret: "API_KEY", variant: "test", unset: true },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // (c) Invalid variant regex → INVALID_INPUT
  it("rejects an invalid variant regex", async () => {
    const vp = await writeValueFile("v");
    await s({
      cmd: "add-secret",
      args: { key: "API_KEY", valuePath: vp },
    });
    const r = await s({
      cmd: "set-variant",
      args: { secret: "API_KEY", variant: "Test-Variant" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/variant/i);
  });

  // (d) Unknown secret needle → NOT_FOUND
  it("returns NOT_FOUND for an unknown secret needle", async () => {
    const r = await s({
      cmd: "set-variant",
      args: { secret: "NONEXISTENT", variant: "test" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  // (e) Happy path: set variant on a variant-less secret → auto-scope
  it("sets the variant and re-runs auto-scope on a variant-less secret", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_KEY", valuePath: vp },
    });
    expect(add.ok).toBe(true);

    const r = await s({
      cmd: "set-variant",
      args: { secret: "STRIPE_KEY", variant: "test" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as {
      variant?: string;
      scopes: { repoId: string; env: string }[];
    };
    expect(secret.variant).toBe("test");
    // r1/development and r2/development both map to "test" via DEFAULT_ENV_VARIANT_MAP.
    expect(secret.scopes).toContainEqual({ repoId: "r1", env: "development" });
    expect(secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    // production (→ live) and staging (→ staging) should NOT be auto-scoped.
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "production" });
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "staging" });
  });

  // (f) Identity-triple conflict → CONFLICT
  it("rejects when the new (key, namespace, variant) triple is already occupied", async () => {
    const vp1 = await writeValueFile("v1");
    await s({
      cmd: "add-secret",
      args: {
        key: "API_KEY",
        namespace: "stripe",
        variant: "test",
        valuePath: vp1,
      },
    });
    const vp2 = await writeValueFile("v2");
    const addSibling = await s({
      cmd: "add-secret",
      args: {
        key: "API_KEY",
        namespace: "stripe",
        variant: "live",
        valuePath: vp2,
      },
    });
    expect(addSibling.ok).toBe(true);
    if (!addSibling.ok) return;
    const siblingId = (addSibling.secret as { id: string }).id;

    // Now try to flip the "live" sibling to "test" — collides with the first.
    const r = await s({
      cmd: "set-variant",
      args: { secret: siblingId, variant: "test" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
  });

  // (g) Sibling-conflict skip on auto-scope
  it("reports sibling-conflict skips in skippedVariants while still scoping the rest", async () => {
    // Build the conflicting variant pair:
    //   - a "live" sibling that is also manually scoped onto r1/development (to
    //     block the cell), and
    //   - a variant-less duplicate of the same key that will be promoted to "test".
    // The variant-less duplicate is allowed on add-secret because the daemon only
    // enforces the (key, namespace, variant) identity triple when variant is set.
    const { candidateId } = await buildConflictingVariantPair("API_KEY");

    // Promote it to variant: test. r1/development is owned by the live sibling,
    // so it should appear in skippedVariants while r2/development is auto-scoped.
    const r = await s({
      cmd: "set-variant",
      args: { secret: candidateId, variant: "test" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as {
      scopes: { repoId: string; env: string }[];
    };
    expect(secret.scopes).not.toContainEqual({ repoId: "r1", env: "development" });
    expect(secret.scopes).toContainEqual({ repoId: "r2", env: "development" });
    const skipped = r.skippedVariants as { repoId: string; env: string }[] | undefined;
    expect(skipped).toBeDefined();
    expect(skipped).toContainEqual(
      expect.objectContaining({ repoId: "r1", env: "development" }),
    );
  });

  // (h) Unset preserves existing scopes
  it("preserves existing scopes when unsetting the variant", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_KEY", variant: "test", valuePath: vp },
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const scopesBefore = (add.secret as { scopes: { repoId: string; env: string }[] }).scopes;
    // Sanity: should have at least one auto-scope.
    expect(scopesBefore.length).toBeGreaterThan(0);

    const id = (add.secret as { id: string }).id;
    const r = await s({
      cmd: "set-variant",
      args: { secret: id, unset: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as {
      variant?: string;
      scopes: { repoId: string; env: string }[];
    };
    expect(secret.variant).toBeUndefined();
    // Existing scopes are intact.
    for (const sc of scopesBefore) {
      expect(secret.scopes).toContainEqual(sc);
    }
  });

  // (i) Ambiguous needle → AMBIGUOUS
  it("returns AMBIGUOUS when the bare key matches multiple secrets and no variant arg disambiguates", async () => {
    const vp1 = await writeValueFile("v1");
    await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp1 },
    });
    const vp2 = await writeValueFile("v2");
    await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "live", valuePath: vp2 },
    });
    const r = await s({
      cmd: "set-variant",
      args: { secret: "API_KEY", variant: "staging" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("AMBIGUOUS");
  });
});
