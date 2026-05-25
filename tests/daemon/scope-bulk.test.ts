/**
 * Daemon handler unit tests: scope (envs array extension) + scope-bulk
 *
 * All tests in this file are expected to be RED until the implementation is
 * written in lib/daemon/handlers/scope.ts (envs extension) and
 * lib/daemon/handlers/scope-bulk.ts (new handler).
 *
 * Seed vault:
 *   r1 – "alpha"  environments: ["development", "production"]
 *   r2 – "beta"   environments: ["development"]
 *
 *   s1 – DATABASE_URL          scopes: [(r1,dev), (r1,prod)]
 *   s2 – API_KEY  ns=stripe    scopes: [(r2,dev)]
 *   s3 – API_KEY  ns=github    scopes: []
 */

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
      environments: ["development"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://user:pass@host:5432/db_high_entropy_AAAA",
      scopes: [
        { repoId: "r1", env: "development" },
        { repoId: "r1", env: "production" },
      ],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_AAAAAAAAAAAAAAAAAAAAAAAA",
      scopes: [{ repoId: "r2", env: "development" }],
    },
    {
      id: "s3",
      key: "API_KEY",
      namespace: "github",
      value: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAA",
      scopes: [],
    },
    {
      id: "s4",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_BBBBBBBBBBBBBBBBBBBBBBBB",
      scopes: [],
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

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

// ---------------------------------------------------------------------------
// scope command — envs array extension
// ---------------------------------------------------------------------------
describe("daemon handler: scope (envs array extension)", () => {
  it("scope command with envs array — registers multiple scopes in one call", async () => {
    // s3 (github/API_KEY) has no scopes. Fan out to both alpha envs.
    const r = await s("scope", {
      secret: "s3",
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as { ok: true; results: Array<{ env: string; status: string }> };
    expect(Array.isArray(resp.results)).toBe(true);
    expect(resp.results).toHaveLength(2);
    const statuses = resp.results.map((row) => row.status).sort();
    expect(statuses).toEqual(["scoped", "scoped"]);
    const envs = resp.results.map((row) => row.env).sort();
    expect(envs).toEqual(["development", "production"]);
    // Value must not leak.
    expect(JSON.stringify(r)).not.toContain("ghp_");
  });

  it("scope command backward-compat — singular env still produces results array", async () => {
    // The existing singular-env path should now return a results array with one
    // entry instead of (or in addition to) the old `{ secret, unchanged }` shape.
    const r = await s("scope", {
      secret: "s3",
      repo: "alpha",
      env: "development",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as { ok: true; results: Array<{ env: string; status: string }> };
    expect(Array.isArray(resp.results)).toBe(true);
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]!.env).toBe("development");
    expect(resp.results[0]!.status).toBe("scoped");
  });
});

// ---------------------------------------------------------------------------
// scope-bulk command
// ---------------------------------------------------------------------------
describe("daemon handler: scope-bulk", () => {
  it("scope-bulk command — all rows succeed", async () => {
    // s3 has no scopes. Bulk-scope it into alpha's two envs.
    const r = await s("scope-bulk", {
      secrets: ["s3"],
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as {
      ok: true;
      results: Array<{ secret: string; env: string; status: string }>;
    };
    expect(Array.isArray(resp.results)).toBe(true);
    // 1 secret × 2 envs = 2 rows
    expect(resp.results).toHaveLength(2);
    for (const row of resp.results) {
      expect(row.secret).toBe("s3");
      expect(row.status).toBe("scoped");
    }
    const envs = resp.results.map((row) => row.env).sort();
    expect(envs).toEqual(["development", "production"]);
    // Value must not leak.
    expect(JSON.stringify(r)).not.toContain("ghp_");
  });

  it("scope-bulk command — NOT_FOUND secret emits error rows for all its envs", async () => {
    const r = await s("scope-bulk", {
      secrets: ["s3", "DOES_NOT_EXIST"],
      repo: "alpha",
      envs: ["development"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as {
      ok: true;
      results: Array<{ secret: string; env: string; status: string; code?: string }>;
    };
    expect(Array.isArray(resp.results)).toBe(true);
    // 2 secrets × 1 env = 2 rows
    expect(resp.results).toHaveLength(2);
    const s3Row = resp.results.find((row) => row.secret === "s3");
    const missingRow = resp.results.find((row) => row.secret === "DOES_NOT_EXIST");
    expect(s3Row?.status).toBe("scoped");
    expect(missingRow?.status).toBe("error");
    expect(missingRow?.code).toMatch(/NOT_FOUND/i);
  });

  it("scope-bulk command — AMBIGUOUS secret emits error rows for all its envs", async () => {
    // "API_KEY" matches both s2 and s3 — should be AMBIGUOUS.
    const r = await s("scope-bulk", {
      secrets: ["API_KEY"],
      repo: "alpha",
      envs: ["development"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as {
      ok: true;
      results: Array<{ secret: string; env: string; status: string; code?: string }>;
    };
    expect(Array.isArray(resp.results)).toBe(true);
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]!.status).toBe("error");
    expect(resp.results[0]!.code).toMatch(/AMBIGUOUS/i);
  });

  it("scope-bulk command — env not in repo.environments emits INVALID_INPUT row", async () => {
    // "staging" is not a valid env for alpha (which has dev + prod).
    const r = await s("scope-bulk", {
      secrets: ["s3"],
      repo: "alpha",
      envs: ["development", "staging"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as {
      ok: true;
      results: Array<{ secret: string; env: string; status: string; code?: string }>;
    };
    expect(Array.isArray(resp.results)).toBe(true);
    // 1 secret × 2 envs = 2 rows
    expect(resp.results).toHaveLength(2);
    const devRow = resp.results.find((row) => row.env === "development");
    const stagingRow = resp.results.find((row) => row.env === "staging");
    expect(devRow?.status).toBe("scoped");
    expect(stagingRow?.status).toBe("error");
    expect(stagingRow?.code).toMatch(/INVALID_INPUT/i);
  });

  it("scope-bulk command — CONFLICT skips the row, continues", async () => {
    // s2 (stripe/API_KEY) is already in beta/development.
    // s4 shares the same key AND namespace (stripe/API_KEY) — scoping it to
    // the same cell must produce a CONFLICT row, not a hard failure.
    const r = await s("scope-bulk", {
      secrets: ["s4"],
      repo: "beta",
      envs: ["development"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const resp = r as unknown as {
      ok: true;
      results: Array<{ secret: string; env: string; status: string; code?: string }>;
    };
    expect(Array.isArray(resp.results)).toBe(true);
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]!.status).toBe("error");
    expect(resp.results[0]!.code).toMatch(/CONFLICT/i);
  });

  it("scope-bulk command — missing secrets arg returns INVALID_INPUT immediately", async () => {
    const r = await s("scope-bulk", {
      repo: "alpha",
      envs: ["development"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("scope-bulk command — missing envs arg returns INVALID_INPUT immediately", async () => {
    const r = await s("scope-bulk", {
      secrets: ["s3"],
      repo: "alpha",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });
});
