import { mkdtemp, writeFile, rm } from "node:fs/promises";
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

/**
 * A high-entropy string longer than 20 chars so the fingerprint emitter
 * doesn't drop it (and so it's distinctive enough that any leak in stdout/
 * stderr/response is obvious). The value is reused as every secret's value
 * across the sweep — any RPC response containing this substring is a leak.
 */
const SENTINEL = "SENTINEL_VALUE_DO_NOT_LEAK_X9k7mZpQ2vW8nLrT4HfYjB";

let tmp: string;
let scratch: string;
let realRepo: string;
let daemon: SpawnedDaemon | null = null;

function makeSeed(): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "r1",
        name: "alpha",
        path: "/repos/alpha",
        environments: ["development", "production"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "DATABASE_URL",
        value: SENTINEL,
        scopes: [{ repoId: "r1", env: "development" }],
      },
      {
        id: "s2",
        key: "API_KEY",
        namespace: "stripe",
        value: SENTINEL,
        scopes: [{ repoId: "r1", env: "development" }],
      },
      {
        id: "s3",
        key: "API_KEY",
        namespace: "github",
        value: SENTINEL,
        scopes: [],
      },
    ],
  };
}

beforeEach(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-sentinel-"));
  realRepo = await mkdtemp(path.join(tmpdir(), "sm-repo-"));
  await seedVault(tmp, makeSeed(), DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
  await rm(scratch, { recursive: true, force: true });
  await rm(realRepo, { recursive: true, force: true });
});

async function writeSentinelFile(): Promise<string> {
  const p = path.join(scratch, `v-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(p, SENTINEL, "utf8");
  return p;
}

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

describe("CLI never emits plaintext secret values", () => {
  it("no CLI command leaks the sentinel value in its response or daemon stderr", async () => {
    const responses: Array<{ cmd: string; resp: unknown }> = [];
    const record = async (
      cmd: string,
      args?: Record<string, unknown>,
    ) => {
      const r = await s(cmd, args);
      responses.push({ cmd, resp: r });
    };

    // ----- Read surface -----
    await record("list-repos");
    await record("list-secrets");
    await record("list-secrets", { namespace: "stripe" });
    await record("list-scopes");
    await record("describe-secret", { id: "DATABASE_URL" });
    await record("describe-secret", { id: "s2" });
    await record("find-shared");

    // ----- Structural mutations -----
    await record("scope", {
      secret: "API_KEY",
      repo: "alpha",
      env: "production",
    });
    await record("unscope", {
      secret: "API_KEY",
      repo: "alpha",
      env: "production",
    });
    await record("set-namespace", { secret: "s3", namespace: "twilio" });
    await record("set-namespace", { secret: "s3", unset: true });
    await record("rename-secret", {
      secret: "DATABASE_URL",
      newKey: "DB_URL",
    });
    await record("rename-secret", { secret: "DB_URL", newKey: "DATABASE_URL" });

    // ----- Repo CRUD (needs a real on-disk path) -----
    await record("add-repo", {
      name: "beta",
      path: realRepo,
      environments: ["development"],
    });
    await record("set-repo-envs", {
      target: "beta",
      environments: ["development", "staging"],
    });
    await record("remove-repo", { target: "beta" });

    // ----- Value-bearing mutations (re-create temp file per call) -----
    const f1 = await writeSentinelFile();
    await record("add-secret", { key: "NEW_KEY", valuePath: f1 });

    const f2 = await writeSentinelFile();
    await record("add-secret", {
      key: "ANOTHER",
      namespace: "stripe",
      valuePath: f2,
    });

    const f3 = await writeSentinelFile();
    await record("set-value", { secret: "DATABASE_URL", valuePath: f3 });

    await record("remove-secret", { target: "NEW_KEY" });

    // ----- Import (dry-run; needs a .env file in the repo path) -----
    await writeFile(path.join(realRepo, ".env.development"), "# empty\n");
    // Re-add beta so import has a target.
    await record("add-repo", {
      name: "beta",
      path: realRepo,
      environments: ["development"],
    });
    await record("import", { repo: "beta", dryRun: true });

    // ----- Deploy (dry-run; avoids needing dotenvx-ops binary) -----
    await record("deploy", { dryRun: true });
    await record("deploy", { dryRun: true, repo: "alpha" });
    await record("deploy", {
      dryRun: true,
      repo: "alpha",
      env: "development",
    });

    // ----- Assertions -----
    // No response stringifies into a payload that contains the sentinel.
    for (const { cmd, resp } of responses) {
      const text = JSON.stringify(resp);
      expect(
        text.includes(SENTINEL),
        `command "${cmd}" leaked sentinel in response: ${text}`,
      ).toBe(false);
    }

    // The daemon's stderr (logs, errors, dispatcher noise) also doesn't
    // contain the sentinel.
    const stderr = daemon!.stderrBuf();
    expect(
      stderr.includes(SENTINEL),
      `daemon stderr leaked sentinel:\n${stderr}`,
    ).toBe(false);

    // Sanity-control: the sentinel really did persist in the encrypted vault
    // — otherwise we'd be testing nothing.
    const sanity = await s("list-secrets");
    expect(sanity.ok).toBe(true);
    if (!sanity.ok) return;
    const stillPresent = (sanity.secrets as Array<{ id: string }>).some(
      (x) => x.id === "s1",
    );
    expect(stillPresent).toBe(true);
  });
});
