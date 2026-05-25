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
 * Tests for per-repo deploy with `--local-only` flag (issue #40 sub-problem 2
 * wired through the CLI daemon handler, plus sub-problem 3 groundwork).
 *
 * The `deploy` command should accept a `localOnly` arg that, when true,
 * causes repos whose paths don't exist locally to be skipped rather than
 * failing the whole deploy.
 *
 * All tests here are expected to FAIL (red) until the feature is implemented.
 */

const SEED: VaultData = {
  version: 2,
  repos: [
    {
      id: "r1",
      name: "local-repo",
      // Use /tmp directly — guaranteed to exist on Linux/macOS.
      path: "/tmp",
      environments: ["development"],
    },
    {
      id: "r2",
      name: "remote-repo",
      // This path will NOT exist on the test machine.
      path: "/nonexistent/path/to/remote/machine/repo",
      environments: ["development"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "SHARED_KEY",
      value: "shared-value",
      scopes: [
        { repoId: "r1", env: "development" },
        { repoId: "r2", env: "development" },
      ],
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

describe("CLI deploy --repo --local-only", () => {
  it("deploy with localOnly: true skips a repo whose path doesn't exist", async () => {
    // Deploy ALL repos with localOnly: true. The remote-repo path doesn't
    // exist on disk so it should produce a skipped result, not a failure.
    const r = await s({
      cmd: "deploy",
      args: { dryRun: true, localOnly: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const results = r.results as Array<{
      ok: boolean;
      repoName: string;
      skipped?: boolean;
    }>;

    const remoteResult = results.find((x) => x.repoName === "remote-repo");
    // Must be present and skipped (not failed).
    expect(remoteResult).toBeDefined();
    expect(remoteResult?.ok).toBe(true);
    expect(remoteResult?.skipped).toBe(true);
  });

  it("deploy with --repo NAME only deploys that specific repo's envs", async () => {
    // This exercises that the `repo` filter in the handler narrows to exactly
    // local-repo's targets. This part of the handler exists already, but we
    // verify that combined with localOnly: true it still works correctly.
    const r = await s({
      cmd: "deploy",
      args: { dryRun: true, repo: "local-repo", localOnly: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const results = r.results as Array<{ repoName: string; skipped?: boolean }>;
    // Only local-repo targets should appear.
    expect(results.every((x) => x.repoName === "local-repo")).toBe(true);
    // local-repo's path (/tmp) exists, so nothing should be skipped.
    expect(results.every((x) => !x.skipped)).toBe(true);
  });

  it("deploy without localOnly fails when a repo path is missing (existing behaviour)", async () => {
    // Sanity-check: without the flag the existing REPO_PATH_NOT_FOUND
    // behaviour is preserved (so we know localOnly actually changes things).
    const r = await s({
      cmd: "deploy",
      args: { dryRun: false, repo: "remote-repo" },
    });
    expect(r.ok).toBe(true); // outer envelope is ok
    if (!r.ok) return;

    const results = r.results as Array<{
      ok: boolean;
      code?: string;
      skipped?: boolean;
    }>;
    // Without localOnly, the missing path should produce a failure result.
    expect(results.some((x) => !x.ok && x.code === "REPO_PATH_NOT_FOUND")).toBe(true);
  });
});
