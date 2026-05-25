/**
 * Daemon scope-sibling-check tests — Phase 4 Task 4.
 *
 * Verifies that manual `scope` and `scope-bulk` reject cells already owned
 * by a same-(key, namespace) sibling with a DIFFERENT variant. The guard
 * runs BEFORE `scopeCellConflicts` so the sibling-conflict message is
 * preferred over the namespace-blind one.
 *
 * Seeds V2 so migrateToLatest injects DEFAULT_ENV_VARIANT_MAP — needed for
 * the variant-bearing sibling's auto-scoping to land deterministically on
 * the expected cells.
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

describe("scope sibling-check guard (Phase 4)", () => {
  // ----- (a) singular env, blocked by sibling — CONFLICT with sibling id -----
  it("scope (singular env) by id blocked by sibling with different variant returns CONFLICT with sibling id in message", async () => {
    const vp1 = await writeValueFile("live");
    const addA = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "live", valuePath: vp1 },
    });
    expect(addA.ok).toBe(true);
    if (!addA.ok) return;
    const siblingAId = (addA.secret as { id: string }).id;

    const vp2 = await writeValueFile("test");
    const addB = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp2 },
    });
    expect(addB.ok).toBe(true);
    if (!addB.ok) return;
    const bId = (addB.secret as { id: string }).id;

    const r = await s({
      cmd: "scope",
      args: { secret: bId, repo: "r1", env: "production" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toContain(siblingAId);
    expect(r.message).toMatch(/variant identity rule/);
  });

  // ----- (b) batch envs: mixed scoped + error rows -----
  it("scope (envs array) returns per-row CONFLICT for sibling-owned cells while scoping the rest", async () => {
    // Sibling A: variant=live → r1/production (auto-scope).
    const vp1 = await writeValueFile("live");
    const addA = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "live", valuePath: vp1 },
    });
    expect(addA.ok).toBe(true);

    // Candidate B: variant=test (auto-scopes to r1/development + r2/development).
    const vp2 = await writeValueFile("test");
    const addB = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp2 },
    });
    expect(addB.ok).toBe(true);
    if (!addB.ok) return;
    const bId = (addB.secret as { id: string }).id;

    // Attempt to scope B into r1's [staging, production] in one call:
    //   - staging  → cell free → "scoped"
    //   - production → owned by A (variant=live) → "error" CONFLICT
    const r = await s({
      cmd: "scope",
      args: { secret: bId, repo: "r1", envs: ["staging", "production"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.results as { env: string; status: string; code?: string }[];
    const staging = rows.find((row) => row.env === "staging");
    const production = rows.find((row) => row.env === "production");
    expect(staging?.status).toBe("scoped");
    expect(production?.status).toBe("error");
    expect(production?.code).toBe("CONFLICT");
  });

  // ----- (c) scope-bulk: many secrets × many envs in one call -----
  it("scope-bulk surfaces sibling-conflict rows alongside scoped rows", async () => {
    // Sibling A: variant=live → r1/production.
    const vp1 = await writeValueFile("live-A");
    await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "live", valuePath: vp1 },
    });

    // Candidate B (same key, variant=test).
    const vp2 = await writeValueFile("test-B");
    const addB = await s({
      cmd: "add-secret",
      args: { key: "API_KEY", variant: "test", valuePath: vp2 },
    });
    expect(addB.ok).toBe(true);
    if (!addB.ok) return;
    const bId = (addB.secret as { id: string }).id;

    // Candidate C: different key, variant=test. No sibling conflict possible.
    const vp3 = await writeValueFile("C");
    const addC = await s({
      cmd: "add-secret",
      args: { key: "DB_URL", variant: "test", valuePath: vp3 },
    });
    expect(addC.ok).toBe(true);
    if (!addC.ok) return;
    const cId = (addC.secret as { id: string }).id;

    // Bulk: scope both B and C into [production, staging].
    //   - B/production → CONFLICT (sibling A)
    //   - B/staging    → scoped
    //   - C/production → scoped (no sibling shares C's key)
    //   - C/staging    → scoped
    const r = await s({
      cmd: "scope-bulk",
      args: {
        secrets: [bId, cId],
        repo: "r1",
        envs: ["production", "staging"],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.results as {
      secret: string;
      env: string;
      status: string;
      code?: string;
    }[];

    const bProd = rows.find((row) => row.secret === bId && row.env === "production");
    expect(bProd?.status).toBe("error");
    expect(bProd?.code).toBe("CONFLICT");

    const bStaging = rows.find((row) => row.secret === bId && row.env === "staging");
    expect(bStaging?.status).toBe("scoped");

    const cProd = rows.find((row) => row.secret === cId && row.env === "production");
    expect(cProd?.status).toBe("scoped");

    const cStaging = rows.find((row) => row.secret === cId && row.env === "staging");
    expect(cStaging?.status).toBe("scoped");
  });

  // ----- (d) regression: variant-less candidate skips the sibling guard -----
  it("variant-less candidate skips the sibling-variant guard and scopes cleanly when no scope conflict", async () => {
    // No sibling exists for DB_URL. Variant-less secret scopes into r1/staging
    // without the sibling-check intervening (it short-circuits on undefined variant).
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "DB_URL", valuePath: vp },
    });
    expect(add.ok).toBe(true);

    const r = await s({
      cmd: "scope",
      args: { secret: "DB_URL", repo: "r1", env: "staging" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as { scopes: { repoId: string; env: string }[] };
    expect(secret.scopes).toContainEqual({ repoId: "r1", env: "staging" });
  });

  // ----- (e) same variant on both secrets → no sibling conflict fires -----
  //   The identity rule fires when variants DIFFER. If two secrets share the
  //   same variant tag, the (key, namespace, variant) triple identity rule
  //   would have already prevented their coexistence at add-secret time;
  //   we therefore exercise this case by ensuring the sibling-check does not
  //   spuriously fire when no variant mismatch exists.
  //
  //   Setup: a single variant-bearing secret with NO sibling that shares its
  //   key, scoped manually into an additional cell (still clean — no sibling
  //   guard trigger).
  it("variant-bearing candidate with no different-variant sibling scopes cleanly (regression)", async () => {
    const vp = await writeValueFile("v");
    const add = await s({
      cmd: "add-secret",
      args: { key: "STRIPE_KEY", variant: "test", valuePath: vp },
    });
    expect(add.ok).toBe(true);

    // Manually scope into r1/staging — no sibling owns that cell, so the
    // sibling guard finds nothing and falls through cleanly.
    const r = await s({
      cmd: "scope",
      args: { secret: "STRIPE_KEY", repo: "r1", env: "staging" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secret = r.secret as { scopes: { repoId: string; env: string }[] };
    expect(secret.scopes).toContainEqual({ repoId: "r1", env: "staging" });
  });
});
