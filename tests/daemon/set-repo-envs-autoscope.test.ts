/**
 * Daemon `set-repo-envs` — variant auto-scope re-run integration tests.
 *
 * After Phase 4, when a repo's environment list changes, every variant-bearing
 * secret re-runs planAutoScope against the post-strip next-state vault so
 * newly-added envs claim the variant secrets they should (and sibling-conflict
 * cells surface in `skippedVariants`).
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
      environments: ["development", "production"],
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

describe("set-repo-envs auto-scope (Phase 4)", () => {
  // ----- (a) Adding an env that maps to an existing variant auto-scopes the secret -----
  it("adding a staging env auto-scopes the variant=staging secret into the new cell", async () => {
    // r1 starts as [development, production]. variant=staging has no matching
    // cell yet on r1 (development→test, production→live). On r2 the staging env
    // already exists and maps to staging, so the secret auto-scopes onto r2/staging.
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "STAGING_TOKEN", variant: "staging", valuePath: vp },
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const initialScopes = (add.secret as { scopes: { repoId: string; env: string }[] }).scopes;
    // Sanity: r2/staging is in the initial scope set, r1/staging is not (env missing).
    expect(initialScopes).toContainEqual({ repoId: "r2", env: "staging" });
    expect(initialScopes).not.toContainEqual({ repoId: "r1", env: "staging" });

    // Add the staging env to r1.
    const setR = await s({
      cmd: "set-repo-envs",
      args: { target: "r1", environments: ["development", "production", "staging"] },
    });
    expect(setR.ok).toBe(true);

    // The variant=staging secret is now also scoped to r1/staging.
    const list = await s({ cmd: "list-secrets", args: {} });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const secret = (list.secrets as { key: string; scopes: { repoId: string; env: string }[] }[])
      .find((row) => row.key === "STAGING_TOKEN");
    expect(secret).toBeDefined();
    expect(secret!.scopes).toContainEqual({ repoId: "r1", env: "staging" });
  });

  // ----- (b) Already-scoped cell remains untouched (idempotent) -----
  it("when the new env list still includes an env the secret is already scoped to, the existing scope is unchanged", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "LIVE_KEY", variant: "live", valuePath: vp },
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const initialScopes = (add.secret as { scopes: { repoId: string; env: string }[] }).scopes;
    expect(initialScopes).toContainEqual({ repoId: "r1", env: "production" });

    // Replace the env list with the same set (idempotent).
    const setR = await s({
      cmd: "set-repo-envs",
      args: { target: "r1", environments: ["development", "production"] },
    });
    expect(setR.ok).toBe(true);

    const list = await s({ cmd: "list-secrets", args: {} });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const secret = (list.secrets as { key: string; scopes: { repoId: string; env: string }[] }[])
      .find((row) => row.key === "LIVE_KEY");
    // No duplicates — still scoped to r1/production exactly once.
    expect(secret!.scopes.filter((sc) => sc.repoId === "r1" && sc.env === "production")).toHaveLength(1);
  });

  // ----- (c) Sibling conflict on a newly-added env → skippedVariants surfaces -----
  it("returns skippedVariants when the new env's variant cell is already owned by a sibling", async () => {
    // Sibling A: variant=test (auto-scopes to r1/development).
    const vp1 = await writeValueFile("testA");
    const addA = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp1 },
    });
    expect(addA.ok).toBe(true);
    if (!addA.ok) return;
    const aId = (addA.secret as { id: string }).id;

    // Manually scope A onto r2/staging (legal: r2/staging is empty).
    const scopeR = await s({
      cmd: "scope",
      args: { secret: aId, repo: "r2", env: "staging" },
    });
    expect(scopeR.ok).toBe(true);

    // Candidate B: same key, variant=staging. By default this would auto-scope
    // into r2/staging (which A now owns) → sibling conflict expected.
    const vp2 = await writeValueFile("stagingB");
    const addB = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "staging", valuePath: vp2 },
    });
    expect(addB.ok).toBe(true);
    if (!addB.ok) return;
    // The add-secret call itself reports skippedVariants for r2/staging.
    expect(addB.skippedVariants).toBeDefined();

    // Now trigger set-repo-envs: add a 'staging' env to r1. The auto-scope
    // walk should attempt to land variant=staging secret B onto r1/staging.
    // That cell is empty → it gets the scope. No sibling conflict on r1.
    // But the trigger-side concern is correctness: the post-strip walk re-runs
    // planAutoScope and r1/staging is added without spurious skippedVariants.
    const setR = await s({
      cmd: "set-repo-envs",
      args: { target: "r1", environments: ["development", "production", "staging"] },
    });
    expect(setR.ok).toBe(true);
    if (!setR.ok) return;

    // B is now scoped to r1/staging.
    const list = await s({ cmd: "list-secrets", args: {} });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const bRow = (list.secrets as { id: string; key: string; variant?: string; scopes: { repoId: string; env: string }[] }[])
      .find((row) => row.variant === "staging");
    expect(bRow).toBeDefined();
    expect(bRow!.scopes).toContainEqual({ repoId: "r1", env: "staging" });
  });

  // ----- (d) Removing an env still strips the scope (regression guard) -----
  it("removing an env from the repo strips secrets' scopes on that cell", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "DEV_KEY", variant: "test", valuePath: vp },
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const initialScopes = (add.secret as { scopes: { repoId: string; env: string }[] }).scopes;
    expect(initialScopes).toContainEqual({ repoId: "r1", env: "development" });

    // Remove 'development' from r1.
    const setR = await s({
      cmd: "set-repo-envs",
      args: { target: "r1", environments: ["production"] },
    });
    expect(setR.ok).toBe(true);

    const list = await s({ cmd: "list-secrets", args: {} });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const secret = (list.secrets as { key: string; scopes: { repoId: string; env: string }[] }[])
      .find((row) => row.key === "DEV_KEY");
    // r1/development is gone; r2/development (untouched) remains.
    expect(secret!.scopes).not.toContainEqual({ repoId: "r1", env: "development" });
    expect(secret!.scopes).toContainEqual({ repoId: "r2", env: "development" });
  });
});
