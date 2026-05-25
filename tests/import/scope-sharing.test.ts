/**
 * tests/import/scope-sharing.test.ts
 *
 * RED tests for issue #16 — import behaviour when multiple secrets share
 * (key, namespace) with disjoint scopes.
 *
 * ALL tests in this file are expected to FAIL with the current code and
 * PASS once the fix is applied.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
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

/**
 * Shared seed used by both import tests below.
 *
 *   r1/alpha  — environments: development, production
 *   r2/beta   — environments: development, production
 *
 *   s1: DATABASE_URL (no ns) value="postgres://alpha" → scoped to r1/dev
 *   s2: DATABASE_URL (no ns) value="postgres://beta"  → scoped to r2/dev
 */
const SEED: VaultData = {
  version: 2,
  repos: [
    {
      id: "r1",
      name: "alpha",
      path: "", // overwritten per-test
      environments: ["development", "production"],
    },
    {
      id: "r2",
      name: "beta",
      path: "", // overwritten per-test
      environments: ["development", "production"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://alpha",
      scopes: [{ repoId: "r1", env: "development" }],
    },
    {
      id: "s2",
      key: "DATABASE_URL",
      value: "postgres://beta",
      scopes: [{ repoId: "r2", env: "development" }],
    },
  ],
};

let tmp: string;
let alphaRepoDir: string;
let betaRepoDir: string;
let daemon: SpawnedDaemon | null = null;

async function makeEnvFile(dir: string, env: string, content: string) {
  await writeFile(path.join(dir, `.env.${env}`), content, "utf8");
}

beforeEach(async () => {
  tmp = await makeVaultDir();
  alphaRepoDir = await mkdtemp(path.join(tmpdir(), "sm-alpha-"));
  betaRepoDir = await mkdtemp(path.join(tmpdir(), "sm-beta-"));

  // Patch repo paths into the seed.
  const seed: VaultData = {
    ...SEED,
    repos: [
      { ...SEED.repos[0]!, path: alphaRepoDir },
      { ...SEED.repos[1]!, path: betaRepoDir },
    ],
  };
  await seedVault(tmp, seed, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
  await cleanupVaultDir(alphaRepoDir);
  await cleanupVaultDir(betaRepoDir);
});

function s(req: { cmd: string; args?: Record<string, unknown> }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

describe("import scope-sharing: correct sibling selection and new-secret creation", () => {
  /**
   * Test 7 — import creates a NEW secret when the existing sibling for
   * this cell has a *different* value.
   *
   * Scenario:
   *   - s1 owns DATABASE_URL at r1/development with value "postgres://alpha".
   *   - We import .env.development for alpha repo with value "postgres://NEW".
   *   - With onConflict=skip (default) the current code finds s1 by
   *     (key=DATABASE_URL, ns=undefined) and skips it (value mismatch).
   *   - But with the fix, the import layer must look at ALL siblings and
   *     determine which one (if any) already owns the (r1, development) cell.
   *     s1 owns it with a different value → CONFLICT/skip as before.
   *     Crucially s2's record must NOT be corrupted — its scope set should
   *     remain [r2/dev] regardless of what happens to s1.
   *
   * After the fix the test verifies:
   *   - The import plan action for DATABASE_URL is "skip" (onConflict=skip,
   *     value mismatch against the cell-owning sibling s1).
   *   - s2's scope set is untouched: still only [r2/development].
   *
   * FAILS TODAY because the current code's findIndex picks the FIRST
   * (key, namespace) match — that happens to be s1 here — but the check
   * that distinguishes "which sibling owns this cell" doesn't exist, so
   * on overwrite it would clobber the wrong secret or on a future code
   * path it may incorrectly scope s2.
   */
  it("import skips correctly and does not corrupt the sibling secret (s2)", async () => {
    await makeEnvFile(
      alphaRepoDir,
      "development",
      "DATABASE_URL=postgres://NEW\n",
    );

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", env: "development", onConflict: "skip" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const plan = r.plan as {
      actions: Array<{ type: string; key: string; secretId?: string }>;
    };
    const action = plan.actions.find((a) => a.key === "DATABASE_URL");
    // The cell-owning sibling is s1 (value mismatch) → skip.
    expect(action?.type).toBe("skip");
    expect(action?.secretId).toBe("s1");

    // s2 must be completely untouched.
    const desc = await s({ cmd: "describe-secret", args: { id: "s2" } });
    expect(desc.ok).toBe(true);
    if (!desc.ok) return;
    const sec = desc.secret as { scopes: Array<{ repoId: string; env: string }> };
    expect(sec.scopes).toEqual([{ repoId: "r2", env: "development" }]);
  });

  /**
   * Test 8 — import selects the correct sibling by value match.
   *
   * Scenario:
   *   - s1 owns DATABASE_URL at r1/dev with value "postgres://alpha".
   *   - s2 owns DATABASE_URL at r2/dev with value "postgres://beta".
   *   - Importing .env.development for beta repo with value "postgres://beta"
   *     should resolve to s2 (value matches) and add scope (r2, development)
   *     — which is already there, so action = scope-existing on s2 OR
   *     the cell is already present and the action reflects idempotent
   *     scoping.
   *
   * More meaningfully: importing beta repo for a cell NOT yet held by s2,
   *   e.g. beta/production with value "postgres://beta":
   *   - The only sibling that value-matches is s2.
   *   - s2 does NOT yet own (r2, production).
   *   - Result: scope-existing on s2 for (r2, production).
   *   - s1 must be completely untouched.
   *
   * FAILS TODAY because the current import logic does a single
   * `secrets.findIndex(s => s.key === key && s.namespace === ns)` which
   * returns the first match (s1) regardless of value or current scope
   * ownership.  The value of "postgres://beta" != "postgres://alpha"
   * (s1's value), so it would trigger conflict/skip/overwrite on s1
   * instead of finding s2.
   */
  it("import selects correct sibling by value match (s2 scope-existing for beta/production)", async () => {
    await makeEnvFile(
      betaRepoDir,
      "production",
      "DATABASE_URL=postgres://beta\n",
    );

    const r = await s({
      cmd: "import",
      args: { repo: "beta", env: "production" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const plan = r.plan as {
      actions: Array<{ type: string; key: string; secretId?: string }>;
    };
    const action = plan.actions.find((a) => a.key === "DATABASE_URL");

    // Must pick s2 (value matches) not s1 (value mismatch).
    expect(action?.type).toBe("scope-existing");
    expect(action?.secretId).toBe("s2");

    // s2 now has (r2, production) in addition to (r2, development).
    const desc2 = await s({ cmd: "describe-secret", args: { id: "s2" } });
    expect(desc2.ok).toBe(true);
    if (!desc2.ok) return;
    const s2 = desc2.secret as { scopes: Array<{ repoId: string; env: string }> };
    expect(
      s2.scopes.some((sc) => sc.repoId === "r2" && sc.env === "production"),
    ).toBe(true);

    // s1 must be completely untouched.
    const desc1 = await s({ cmd: "describe-secret", args: { id: "s1" } });
    expect(desc1.ok).toBe(true);
    if (!desc1.ok) return;
    const s1 = desc1.secret as { scopes: Array<{ repoId: string; env: string }> };
    expect(s1.scopes).toEqual([{ repoId: "r1", env: "development" }]);
  });
});
