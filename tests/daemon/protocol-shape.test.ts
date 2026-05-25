import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * Find every JSON path that ends in a `value` field. Returns `[]` when the
 * payload is clean. The walker descends into both objects and arrays; the
 * path uses dot notation for object keys and bracket notation for array
 * indices.
 */
function findValueFields(node: unknown, prefix = "$"): string[] {
  const hits: string[] = [];
  if (node === null || typeof node !== "object") return hits;
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      hits.push(...findValueFields(child, `${prefix}[${i}]`));
    });
    return hits;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "value") {
      hits.push(`${prefix}.value`);
    }
    hits.push(...findValueFields(v, `${prefix}.${k}`));
  }
  return hits;
}

const SEED_VALUE = "high-entropy-secret-AAAAAAAAAAAAAA"; // long enough to keep fingerprint emitted

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
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: SEED_VALUE,
      scopes: [{ repoId: "r1", env: "development" }],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: SEED_VALUE,
      scopes: [{ repoId: "r1", env: "development" }],
    },
  ],
};

let tmp: string;
let scratch: string;
let realRepo: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-proto-"));
  realRepo = await mkdtemp(path.join(tmpdir(), "sm-repo-"));
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterAll(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
  await rm(scratch, { recursive: true, force: true });
  await rm(realRepo, { recursive: true, force: true });
});

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

async function tmpFile(content: string): Promise<string> {
  const p = path.join(scratch, `v-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(p, content, "utf8");
  return p;
}

describe("status response shape", () => {
  it("includes state, pid, idleTtlMs, and idleTtlMsRemaining", async () => {
    const status = await s("status");
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const r = status as Record<string, unknown>;
    expect(r.state).toBe("running");
    expect(typeof r.pid).toBe("number");
    expect(typeof r.idleTtlMs).toBe("number");
    expect(typeof r.idleTtlMsRemaining).toBe("number");
    expect(r.idleTtlMsRemaining as number).toBeGreaterThan(0);
    expect(r.idleTtlMsRemaining as number).toBeLessThanOrEqual(
      r.idleTtlMs as number,
    );
  });
});

describe("RPC responses never carry a `value` field", () => {
  it("walks every command's response and finds no `value` field at any depth", async () => {
    const responses: Array<{ cmd: string; resp: unknown }> = [];
    const record = async (cmd: string, args?: Record<string, unknown>) => {
      const r = await s(cmd, args);
      responses.push({ cmd, resp: r });
    };

    // Read surface.
    await record("list-repos");
    await record("list-secrets");
    await record("list-scopes");
    await record("describe-secret", { id: "DATABASE_URL" });
    await record("describe-secret", { id: "s2" });
    await record("find-shared");

    // Structural mutations.
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
    // Batch scope via envs — tests that the new code path also never leaks `value`.
    await record("scope", {
      secret: "s1",
      repo: "alpha",
      envs: ["production"],
    });
    await record("set-namespace", { secret: "s1", namespace: "supabase" });
    await record("set-namespace", { secret: "s1", unset: true });
    await record("rename-secret", { secret: "DATABASE_URL", newKey: "DB_URL" });
    await record("rename-secret", { secret: "DB_URL", newKey: "DATABASE_URL" });

    // Repo CRUD.
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

    // Value-bearing.
    const f1 = await tmpFile("brand-new-high-entropy-AAAAAAAA");
    await record("add-secret", { key: "NEW_KEY", valuePath: f1 });

    const f2 = await tmpFile("replacement-high-entropy-AAAAAAA");
    await record("set-value", { secret: "DATABASE_URL", valuePath: f2 });

    await record("remove-secret", { target: "NEW_KEY" });

    // Import (dry-run; needs an env file).
    await writeFile(path.join(realRepo, ".env.development"), "# empty\n");
    await record("add-repo", {
      name: "beta",
      path: realRepo,
      environments: ["development"],
    });
    await record("import", { repo: "beta", dryRun: true });

    // Deploy (dry-run).
    await record("deploy", { dryRun: true });
    await record("deploy", { dryRun: true, repo: "alpha" });

    // Assertion: no response has a `value` field at any depth.
    for (const { cmd, resp } of responses) {
      const hits = findValueFields(resp);
      expect(
        hits,
        `command "${cmd}" emitted a \`value\` field at: ${hits.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("rejects a synthetic payload that does contain a value field (walker control)", () => {
    const bad = {
      ok: true,
      secrets: [{ id: "x", key: "K", value: "leak" }],
    };
    expect(findValueFields(bad)).toEqual(["$.secrets[0].value"]);
    const good = { ok: true, secrets: [{ id: "x", key: "K" }] };
    expect(findValueFields(good)).toEqual([]);
  });
});
