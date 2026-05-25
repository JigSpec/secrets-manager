/**
 * Daemon `import` — Phase 4 variant-aware import tests.
 *
 * Verifies that:
 *   - imported secrets get the env-derived variant by default (resolved via
 *     the vault's envVariantMap with DEFAULT_ENV_VARIANT_MAP fallback);
 *   - `--default-variant V` overrides the env-derived inference;
 *   - envs not in the variant map produce variant-less secrets (regression
 *     guard for vaults that have not adopted variants);
 *   - sibling conflicts surface as `variant-skip` plan actions;
 *   - invalid `--default-variant` returns INVALID_INPUT.
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

let tmp: string;
let repoDir: string;
let daemon: SpawnedDaemon | null = null;

async function makeRepoWithEnv(
  content: string,
  envName: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sm-import-variant-"));
  await writeFile(path.join(dir, `.env.${envName}`), content, "utf8");
  return dir;
}

async function startWithSeed(seed: VaultData): Promise<void> {
  await seedVault(tmp, seed, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
}

beforeEach(async () => {
  tmp = await makeVaultDir();
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
  if (repoDir) await cleanupVaultDir(repoDir);
});

function s(req: { cmd: string; args?: Record<string, unknown> }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

describe("Import — variant awareness (Phase 4)", () => {
  // ----- (a) Env-derived variant assigned to new secrets -----
  it("imports into a .env.production file → new secrets get variant=live AND are auto-scoped across live cells", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=postgres://live", "production");
    await startWithSeed({
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: repoDir,
          environments: ["development", "production"],
        },
        // A second repo with its own production env so the auto-scope walk
        // has another cell to claim.
        {
          id: "r2",
          name: "beta",
          path: "/repos/beta",
          environments: ["development", "production"],
        },
      ],
      secrets: [],
    } as unknown as VaultData);

    const r = await s({ cmd: "import", args: { repo: "alpha", env: "production" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const list = await s({ cmd: "list-secrets" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = (list.secrets as { key: string; variant?: string; scopes: { repoId: string; env: string }[] }[])
      .find((x) => x.key === "DATABASE_URL");
    expect(row).toBeDefined();
    expect(row!.variant).toBe("live");
    // Auto-scoped to BOTH r1/production (the target cell) AND r2/production
    // (other live cell).
    expect(row!.scopes).toContainEqual({ repoId: "r1", env: "production" });
    expect(row!.scopes).toContainEqual({ repoId: "r2", env: "production" });
  });

  // ----- (b) Explicit --default-variant overrides the env-derived inference -----
  it("--default-variant test overrides the env-derived live variant for the imported secret", async () => {
    repoDir = await makeRepoWithEnv("API_KEY=sk_imported", "production");
    await startWithSeed({
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: repoDir,
          environments: ["development", "production"],
        },
      ],
      secrets: [],
    } as unknown as VaultData);

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", env: "production", defaultVariant: "test" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const list = await s({ cmd: "list-secrets" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = (list.secrets as { key: string; variant?: string }[])
      .find((x) => x.key === "API_KEY");
    expect(row?.variant).toBe("test");
  });

  // ----- (c) Env not in variant map → variant-less secret -----
  it("imports into a custom env not in the variant map → no variant on the new secret", async () => {
    repoDir = await makeRepoWithEnv("WEIRD_KEY=value", "qa");
    await startWithSeed({
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: repoDir,
          environments: ["qa"],
        },
      ],
      secrets: [],
    } as unknown as VaultData);

    const r = await s({ cmd: "import", args: { repo: "alpha", env: "qa" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const list = await s({ cmd: "list-secrets" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = (list.secrets as { key: string; variant?: string }[])
      .find((x) => x.key === "WEIRD_KEY");
    expect(row).toBeDefined();
    expect(row!.variant).toBeUndefined();
  });

  // ----- (d) Sibling conflict during auto-scope → variant-skip action -----
  it("emits a variant-skip plan action when auto-scoping a new variant collides with a sibling", async () => {
    repoDir = await makeRepoWithEnv("API_KEY=sk_new", "production");
    await startWithSeed({
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: repoDir,
          environments: ["development", "production"],
        },
        {
          id: "r2",
          name: "beta",
          path: "/repos/beta",
          environments: ["development", "production"],
        },
      ],
      secrets: [],
    } as unknown as VaultData);

    // Pre-place a sibling API_KEY (variant=test) — auto-scopes to r1/dev + r2/dev.
    const vp = await mkdtemp(path.join(tmpdir(), "sm-import-vp-"));
    const vpath = path.join(vp, "v.txt");
    await writeFile(vpath, "sk_test", "utf8");
    const addSib = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vpath },
    });
    expect(addSib.ok).toBe(true);

    // Now sibling has variant=test on r1/dev and r2/dev. Import a NEW API_KEY
    // into r1/production (env→variant=live). Variant=live secret auto-scopes
    // to r1/production AND r2/production — no collision with the test sibling.
    // To force a collision, scope sibling A onto r2/production manually first.
    if (!addSib.ok) return;
    const sibId = (addSib.secret as { id: string }).id;
    const scopeR = await s({
      cmd: "scope",
      args: { secret: sibId, repo: "r2", env: "production" },
    });
    // scope may CONFLICT because the new sibling-check is in effect. But since
    // sibling A has variant=test and there's no other secret yet, the cell is
    // empty and the scope succeeds.
    expect(scopeR.ok).toBe(true);

    // Trigger the import. New API_KEY (variant=live, inferred from prod) will
    // try to auto-scope into r2/production — now owned by sibling test variant.
    // That cell appears in the plan as variant-skip.
    const r = await s({ cmd: "import", args: { repo: "alpha", env: "production" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const actions = (r.plan as { actions: { type: string; key?: string }[] }).actions;
    const variantSkips = actions.filter((a) => a.type === "variant-skip");
    expect(variantSkips.length).toBeGreaterThan(0);
  });

  // ----- (e) Invalid --default-variant returns INVALID_INPUT -----
  it("--default-variant 'Foo-Bar' returns INVALID_INPUT", async () => {
    repoDir = await makeRepoWithEnv("X=1", "development");
    await startWithSeed({
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: repoDir,
          environments: ["development"],
        },
      ],
      secrets: [],
    } as unknown as VaultData);

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", env: "development", defaultVariant: "Foo-Bar" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/variant/i);
  });
});
