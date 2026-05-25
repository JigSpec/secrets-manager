import { mkdtemp } from "node:fs/promises";
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
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://alpha",
      scopes: [{ repoId: "r1", env: "development" }],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_test_abc",
      scopes: [],
    },
  ],
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;
let realDir: string;

beforeEach(async () => {
  tmp = await makeVaultDir();
  // We need an actual directory on disk for add-repo path validation.
  realDir = await mkdtemp(path.join(tmpdir(), "sm-repo-"));
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
  await cleanupVaultDir(realDir);
});

function s(req: { cmd: string; args?: Record<string, unknown> }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

describe("CLI structural mutations", () => {
  it("add-repo creates a new repo", async () => {
    const r = await s({
      cmd: "add-repo",
      args: {
        name: "beta",
        path: realDir,
        environments: ["development"],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.repo as { name: string }).name).toBe("beta");

    const list = await s({ cmd: "list-repos" });
    if (list.ok) {
      const names = (list.repos as Array<{ name: string }>).map(
        (x) => x.name,
      );
      expect(names.sort()).toEqual(["alpha", "beta"]);
    }
  });

  it("add-repo rejects nonexistent path", async () => {
    const r = await s({
      cmd: "add-repo",
      args: {
        name: "ghost",
        path: "/definitely/not/a/real/path/abc123xyz",
        environments: ["development"],
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("add-repo rejects duplicate name", async () => {
    const r = await s({
      cmd: "add-repo",
      args: {
        name: "alpha",
        path: realDir,
        environments: ["development"],
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
  });

  it("remove-repo strips scopes from secrets", async () => {
    const r = await s({ cmd: "remove-repo", args: { target: "alpha" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const list = await s({ cmd: "list-scopes" });
    if (list.ok) {
      expect(list.scopes).toEqual([]);
    }
  });

  it("remove-repo returns NOT_FOUND for unknown repo", async () => {
    const r = await s({ cmd: "remove-repo", args: { target: "nope" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  it("set-repo-envs drops orphaned scopes", async () => {
    const r = await s({
      cmd: "set-repo-envs",
      args: { target: "alpha", environments: ["production"] },
    });
    expect(r.ok).toBe(true);

    const list = await s({ cmd: "list-scopes" });
    if (list.ok) {
      const rows = list.scopes as Array<{ env: string }>;
      // s1 was scoped to development; production is what's left.
      expect(rows.find((row) => row.env === "development")).toBeUndefined();
    }
  });

  it("scope adds a (repo, env) to a secret", async () => {
    const r = await s({
      cmd: "scope",
      args: { secret: "API_KEY", repo: "alpha", env: "production" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as { scopes: { env: string }[] };
    expect(sec.scopes.some((sc) => sc.env === "production")).toBe(true);
  });

  it("scope is idempotent when already scoped", async () => {
    const r = await s({
      cmd: "scope",
      args: { secret: "DATABASE_URL", repo: "alpha", env: "development" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unchanged).toBe(true);
  });

  it("scope rejects an env that isn't on the repo", async () => {
    const r = await s({
      cmd: "scope",
      args: { secret: "API_KEY", repo: "alpha", env: "staging" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("unscope removes a (repo, env) from a secret", async () => {
    const r = await s({
      cmd: "unscope",
      args: { secret: "DATABASE_URL", repo: "alpha", env: "development" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as { scopes: unknown[] };
    expect(sec.scopes).toEqual([]);
  });

  it("unscope is idempotent when not scoped", async () => {
    const r = await s({
      cmd: "unscope",
      args: { secret: "API_KEY", repo: "alpha", env: "production" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unchanged).toBe(true);
  });

  it("set-namespace assigns and unsets", async () => {
    const set = await s({
      cmd: "set-namespace",
      args: { secret: "DATABASE_URL", namespace: "supabase" },
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect((set.secret as { namespace?: string }).namespace).toBe("supabase");

    const unset = await s({
      cmd: "set-namespace",
      args: { secret: "DATABASE_URL", unset: true },
    });
    expect(unset.ok).toBe(true);
    if (!unset.ok) return;
    expect((unset.secret as Record<string, unknown>).namespace).toBeUndefined();
  });

  it("set-namespace rejects invalid namespace casing", async () => {
    const r = await s({
      cmd: "set-namespace",
      args: { secret: "DATABASE_URL", namespace: "Supabase" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("rename-secret updates the key", async () => {
    const r = await s({
      cmd: "rename-secret",
      args: { secret: "DATABASE_URL", newKey: "DB_URL" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.secret as { key: string }).key).toBe("DB_URL");
  });

  it("rename-secret rejects lowercase keys", async () => {
    const r = await s({
      cmd: "rename-secret",
      args: { secret: "DATABASE_URL", newKey: "db_url" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("rename-secret allows same key in different namespaces", async () => {
    // s2 already has key API_KEY in namespace 'stripe'. We rename s1 to
    // API_KEY (no namespace) — that's a different (namespace, key) pair.
    const r = await s({
      cmd: "rename-secret",
      args: { secret: "DATABASE_URL", newKey: "API_KEY" },
    });
    expect(r.ok).toBe(true);
  });
});
