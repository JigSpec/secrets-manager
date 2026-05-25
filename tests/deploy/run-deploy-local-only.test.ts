import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDeploy } from "@/lib/vault/deploy/run-deploy";
import type { VaultData } from "@/lib/vault/schema";

/**
 * Tests for the `localOnly` flag on `runDeploy` (issue #40 sub-problem 2).
 *
 * When `localOnly: true`, repos whose path does not exist locally are
 * silently skipped (returning a "skipped" result) instead of failing with
 * REPO_PATH_NOT_FOUND.  Repos whose path DOES exist are still deployed
 * normally.
 *
 */

let tmpRoots: string[] = [];

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sm-local-only-"));
  tmpRoots.push(root);
  return root;
}

function ghostPath(): string {
  // A path that is guaranteed not to exist.
  return path.join(
    os.tmpdir(),
    `sm-ghost-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
}

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  for (const r of tmpRoots) {
    await fs.rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Shared seed builders
// ---------------------------------------------------------------------------

function makeVaultWithMissingRepo(repoPath: string): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "r1",
        name: "ghost-repo",
        path: repoPath,
        environments: ["development"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value: "secret-value",
        scopes: [{ repoId: "r1", env: "development" }],
      },
    ],
  };
}

function makeVaultWithTwoRepos(
  existingPath: string,
  missingPath: string,
): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "r1",
        name: "present-repo",
        path: existingPath,
        environments: ["development"],
      },
      {
        id: "r2",
        name: "absent-repo",
        path: missingPath,
        environments: ["development"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "DB_URL",
        value: "postgres://localhost",
        scopes: [
          { repoId: "r1", env: "development" },
          { repoId: "r2", env: "development" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDeploy localOnly flag", () => {
  it("without localOnly (default), a non-existent path produces a failure result", async () => {
    const missing = ghostPath();
    const data = makeVaultWithMissingRepo(missing);

    const results = await runDeploy({ data, dryRun: false });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result!.ok).toBe(false);
    if (result!.ok) return;
    // Without localOnly the existing behaviour applies: REPO_PATH_NOT_FOUND.
    expect(result!.code).toBe("REPO_PATH_NOT_FOUND");
  });

  it("with localOnly: true, a non-existent path produces a skipped result (not failure)", async () => {
    const missing = ghostPath();
    const data = makeVaultWithMissingRepo(missing);

    // localOnly is the new option — not yet implemented.
    const results = await runDeploy({ data, dryRun: false, localOnly: true });

    expect(results).toHaveLength(1);
    const [result] = results;
    // A skipped result should be ok:true with a skipped flag, OR a dedicated
    // code.  We assert the discriminating shape here.
    expect(result!.ok).toBe(true);
    if (!result!.ok) return;
    // The result should carry a skipped indicator.
    expect((result as { skipped?: boolean }).skipped).toBe(true);
  });

  it("with localOnly: true, repos with existing paths are still deployed normally", async () => {
    const existingRepo = await mkRepo();
    const data = makeVaultWithMissingRepo(existingRepo);

    const results = await runDeploy({ data, dryRun: true, localOnly: true });

    expect(results).toHaveLength(1);
    const [result] = results;
    // Should not be skipped — the path exists.
    expect(result!.ok).toBe(true);
    if (!result!.ok) return;
    expect((result as { skipped?: boolean }).skipped).toBeFalsy();
    // It was a dry-run, so writtenKeys should be present.
    expect((result as { writtenKeys?: string[] }).writtenKeys).toBeDefined();
  });

  it("with localOnly: true, mix of existing/missing — only existing ones deploy", async () => {
    const existingRepo = await mkRepo();
    const missingRepo = ghostPath();
    const data = makeVaultWithTwoRepos(existingRepo, missingRepo);

    const results = await runDeploy({ data, dryRun: true, localOnly: true });

    expect(results).toHaveLength(2);

    const present = results.find(
      (r) => (r as { repoName: string }).repoName === "present-repo",
    );
    const absent = results.find(
      (r) => (r as { repoName: string }).repoName === "absent-repo",
    );

    // The existing repo deploys successfully.
    expect(present?.ok).toBe(true);
    if (present?.ok) {
      expect((present as { skipped?: boolean }).skipped).toBeFalsy();
    }

    // The missing repo is skipped, not failed.
    expect(absent?.ok).toBe(true);
    if (absent?.ok) {
      expect((absent as { skipped?: boolean }).skipped).toBe(true);
    }
  });
});
