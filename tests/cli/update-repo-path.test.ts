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
 * Tests for the `update-repo-path` daemon command (issue #40 sub-problem 1).
 *
 * This command must:
 *   - Update a repo's recorded path without requiring the new path to exist
 *     on disk (cross-machine scenario).
 *   - Reject unknown repo names with NOT_FOUND.
 *   - Reject relative paths (not starting with "/") with INVALID_INPUT.
 *   - Leave scopes and secrets untouched after the path change.
 *
 */

const SEED: VaultData = {
  version: 2,
  repos: [
    {
      id: "r1",
      name: "alpha",
      path: "/old/path/alpha",
      environments: ["development", "production"],
    },
    {
      id: "r2",
      name: "beta",
      path: "/old/path/beta",
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
      scopes: [{ repoId: "r1", env: "production" }],
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

describe("CLI update-repo-path", () => {
  it("updates a repo's path and reflects the change in list-repos", async () => {
    const newPath = "/new/machine/path/alpha";
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "alpha", path: newPath },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The returned repo object should carry the new path.
    expect((r.repo as { path: string }).path).toBe(newPath);

    // list-repos should also reflect the update.
    const list = await s({ cmd: "list-repos" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const repos = list.repos as Array<{ name: string; path: string }>;
    const alpha = repos.find((x) => x.name === "alpha");
    expect(alpha?.path).toBe(newPath);
  });

  it("does NOT require the new path to exist on disk", async () => {
    // The defining feature for multi-user: path may be on a remote machine.
    const ghostPath = "/this/path/does/not/exist/on/this/machine";
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "alpha", path: ghostPath },
    });
    // Must succeed even though the directory doesn't exist locally.
    expect(r.ok).toBe(true);
  });

  it("returns NOT_FOUND for an unknown repo name", async () => {
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "nonexistent", path: "/some/valid/path" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  it("rejects a relative path (not starting with /)", async () => {
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "alpha", path: "relative/path/without/slash" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("scopes and secrets are unchanged after a path update", async () => {
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "alpha", path: "/new/path/alpha" },
    });
    expect(r.ok).toBe(true);

    // Scopes for r1 must still be intact: DATABASE_URL scoped to dev,
    // and API_KEY (namespace=stripe) scoped to production.
    const listScopes = await s({ cmd: "list-scopes" });
    expect(listScopes.ok).toBe(true);
    if (!listScopes.ok) return;
    const scopes = listScopes.scopes as Array<{
      repoName: string;
      env: string;
      secretKey: string;
    }>;
    const alphaScopes = scopes.filter((sc) => sc.repoName === "alpha");
    expect(alphaScopes.length).toBeGreaterThanOrEqual(2);
    expect(alphaScopes.some((sc) => sc.env === "development")).toBe(true);
    expect(alphaScopes.some((sc) => sc.env === "production")).toBe(true);
  });

  it("returns CONFLICT when the new path is already registered to a different repo", async () => {
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "alpha", path: "/old/path/beta" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");

    // Post-condition: alpha's path must be unchanged.
    const list = await s({ cmd: "list-repos" });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const repos = list.repos as Array<{ name: string; path: string }>;
    const alpha = repos.find((x) => x.name === "alpha");
    expect(alpha?.path).toBe("/old/path/alpha");
  });

  it("succeeds (no-op) when called with the repo's own current path", async () => {
    const r = await s({
      cmd: "update-repo-path",
      args: { repo: "alpha", path: "/old/path/alpha" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.repo as { path: string }).path).toBe("/old/path/alpha");
  });
});
