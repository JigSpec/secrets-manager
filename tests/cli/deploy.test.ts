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
      path: "/tmp/alpha-fake",
      environments: ["development", "production"],
    },
    {
      id: "r2",
      name: "beta",
      path: "/tmp/beta-fake",
      environments: ["development"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://shared",
      scopes: [
        { repoId: "r1", env: "development" },
        { repoId: "r2", env: "development" },
      ],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_test_value",
      scopes: [{ repoId: "r1", env: "development" }],
    },
  ],
};

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

describe("CLI deploy", () => {
  it("dry-run returns the planned written keys without writing", async () => {
    const r = await s({ cmd: "deploy", args: { dryRun: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dryRun).toBe(true);
    const results = r.results as Array<{
      ok: boolean;
      repoName: string;
      env: string;
      writtenKeys?: string[];
    }>;
    const alphaDev = results.find(
      (x) => x.repoName === "alpha" && x.env === "development",
    );
    // issue #78 — s2 has namespace="stripe" but writes as the bare key
    // API_KEY. Pre-#78 this was STRIPE_API_KEY.
    expect(alphaDev?.writtenKeys?.sort()).toEqual([
      "API_KEY",
      "DATABASE_URL",
    ]);
    const betaDev = results.find(
      (x) => x.repoName === "beta" && x.env === "development",
    );
    expect(betaDev?.writtenKeys).toEqual(["DATABASE_URL"]);
  });

  it("dry-run flags collisions instead of silently overwriting", async () => {
    // Replace seed with a vault where two secrets collide on the written key.
    await daemon!.kill();
    daemon = null;
    await cleanupVaultDir(tmp);
    tmp = await makeVaultDir();
    await seedVault(
      tmp,
      {
        version: 2,
        repos: [
          {
            id: "r1",
            name: "alpha",
            path: "/tmp/alpha-fake",
            environments: ["development"],
          },
        ],
        secrets: [
          {
            id: "s1",
            key: "API_KEY",
            value: "vA",
            scopes: [{ repoId: "r1", env: "development" }],
          },
          {
            id: "s2",
            key: "API_KEY",
            value: "vB",
            scopes: [{ repoId: "r1", env: "development" }],
          },
        ],
      },
      DEFAULT_PASSWORD,
    );
    daemon = await startDaemon({ vaultDir: tmp });
    await daemon.ready;

    const r = await s({ cmd: "deploy", args: { dryRun: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const target = (r.results as Array<{
      ok: boolean;
      code?: string;
      collisions?: Array<{ writtenKey: string }>;
    }>)[0];
    expect(target.ok).toBe(false);
    expect(target.code).toBe("COLLISION");
    expect(target.collisions?.[0]?.writtenKey).toBe("API_KEY");
  });

  it("filters by --repo", async () => {
    const r = await s({
      cmd: "deploy",
      args: { dryRun: true, repo: "beta" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const results = r.results as Array<{ repoName: string }>;
    expect(results.map((x) => x.repoName)).toEqual(["beta"]);
  });

  it("filters by --repo + --env", async () => {
    const r = await s({
      cmd: "deploy",
      args: { dryRun: true, repo: "alpha", env: "production" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.results as unknown[]).length).toBe(0);
  });

  it("returns NOT_FOUND for unknown repo", async () => {
    const r = await s({
      cmd: "deploy",
      args: { dryRun: true, repo: "ghost" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });
});
