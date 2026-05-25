/**
 * Daemon `add-repo` — variant auto-scope walk integration tests.
 *
 * After Phase 4, when a new repo is registered, every variant-bearing secret
 * re-runs planAutoScope so the secret lands in the new repo's matching cells.
 * Sibling-conflict cells surface in `skippedVariants` on the response.
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

async function makeRepoDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `sm-repo-${prefix}-`));
}

describe("add-repo auto-scope (Phase 4)", () => {
  // ----- (a) Variant secret lands on the newly-added repo's matching cell -----
  it("variant=test secret is auto-scoped into the new repo's development cell", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_TEST_KEY", variant: "test", valuePath: vp },
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const initialScopes = (add.secret as { scopes: { repoId: string; env: string }[] }).scopes;
    // Sanity: r1/development is already scoped.
    expect(initialScopes).toContainEqual({ repoId: "r1", env: "development" });

    // Register a brand-new repo.
    const r2Path = await makeRepoDir("beta");
    const addR2 = await s({
      cmd: "add-repo",
      args: { name: "beta", path: r2Path, environments: ["development", "production"] },
    });
    expect(addR2.ok).toBe(true);
    if (!addR2.ok) return;
    const r2Id = (addR2.repo as { id: string }).id;

    // The variant=test secret is now also scoped to r2/development.
    const list = await s({ cmd: "list-secrets", args: {} });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const secret = (list.secrets as { key: string; scopes: { repoId: string; env: string }[] }[])
      .find((row) => row.key === "STRIPE_TEST_KEY");
    expect(secret).toBeDefined();
    expect(secret!.scopes).toContainEqual({ repoId: r2Id, env: "development" });
  });

  // ----- (b) New repo's envs don't match any variant → no new scopes -----
  it("new repo with envs that don't match any variant adds no scopes", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "STAGING_TOKEN", variant: "staging", valuePath: vp },
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const initialScopes = (add.secret as { scopes: { repoId: string; env: string }[] }).scopes;
    // No staging env in r1, so no auto-scope from the existing repo.
    expect(initialScopes).toHaveLength(0);

    // Register a repo whose envs are NOT in the default variant map at all.
    const r2Path = await makeRepoDir("foo");
    const addR2 = await s({
      cmd: "add-repo",
      args: { name: "weird", path: r2Path, environments: ["qa"] },
    });
    expect(addR2.ok).toBe(true);

    const list = await s({ cmd: "list-secrets", args: {} });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const secret = (list.secrets as { key: string; scopes: { repoId: string; env: string }[] }[])
      .find((row) => row.key === "STAGING_TOKEN");
    // Still no scopes — qa does not resolve to staging by default.
    expect(secret!.scopes).toHaveLength(0);
  });

  // ----- (c) Regression: repo-name conflict still rejects -----
  it("duplicate repo name returns CONFLICT (regression for add-repo.ts:52-54)", async () => {
    const dupPath = await makeRepoDir("dup");
    const r = await s({
      cmd: "add-repo",
      args: { name: "alpha", path: dupPath, environments: ["test"] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
  });

  // ----- (d) Regression: path conflict still rejects -----
  it("duplicate repo path returns CONFLICT (regression for add-repo.ts:49-51)", async () => {
    // r1 seeded with path /repos/alpha. Make a brand-new dir but reuse that
    // path string — the existsSync check will reject the bogus path first.
    // Instead, seed a unique path, then attempt to re-register THAT path.
    const repoPath = await makeRepoDir("path-conflict");
    const firstAdd = await s({
      cmd: "add-repo",
      args: { name: "first", path: repoPath, environments: ["test"] },
    });
    expect(firstAdd.ok).toBe(true);

    const dupAdd = await s({
      cmd: "add-repo",
      args: { name: "second", path: repoPath, environments: ["test"] },
    });
    expect(dupAdd.ok).toBe(false);
    if (dupAdd.ok) return;
    expect(dupAdd.code).toBe("CONFLICT");
  });
});
