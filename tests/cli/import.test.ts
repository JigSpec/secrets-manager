import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
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

const PASSWORD = DEFAULT_PASSWORD;

let tmp: string;
let repoDir: string;
let daemon: SpawnedDaemon | null = null;

async function makeRepoWithEnv(
  content: string,
  envName: string = "development",
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sm-import-repo-"));
  await writeFile(path.join(dir, `.env.${envName}`), content, "utf8");
  return dir;
}

async function startWithSeed(seed: VaultData): Promise<void> {
  await seedVault(tmp, seed, PASSWORD);
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

describe("CLI import", () => {
  it("imports new secrets from a .env file (single-env repo, default env)", async () => {
    repoDir = await makeRepoWithEnv(
      [
        "# example",
        "DATABASE_URL=postgres://imported",
        'API_KEY="sk_imported_value"',
        "",
      ].join("\n"),
    );
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
    });

    const r = await s({ cmd: "import", args: { repo: "alpha" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.plan as { actions: { type: string; key: string }[]; entriesParsed: number };
    expect(plan.entriesParsed).toBe(2);
    expect(plan.actions.map((a) => a.type).sort()).toEqual([
      "new-secret",
      "new-secret",
    ]);

    const list = await s({ cmd: "list-secrets" });
    if (list.ok) {
      const keys = (list.secrets as Array<{ key: string }>)
        .map((x) => x.key)
        .sort();
      expect(keys).toEqual(["API_KEY", "DATABASE_URL"]);
    }
  });

  it("scopes an existing secret when value matches", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=postgres://shared");
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
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://shared",
          scopes: [],
        },
      ],
    });

    const r = await s({ cmd: "import", args: { repo: "alpha" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.plan as { actions: Array<{ type: string; secretId?: string }> };
    expect(plan.actions[0]?.type).toBe("scope-existing");
    expect(plan.actions[0]?.secretId).toBe("s1");
  });

  it("fails on conflicting value when on-conflict is fail", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=postgres://NEW");
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
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://OLD",
          // s1 already owns the (r1, development) cell — Pass 1 of import
          // matches and applies the conflict policy on value mismatch.
          scopes: [{ repoId: "r1", env: "development" }],
        },
      ],
    });

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", onConflict: "fail" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("IMPORT_CONFLICT");
  });

  it("overwrites the value when on-conflict is overwrite", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=postgres://NEW");
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
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://OLD",
          scopes: [{ repoId: "r1", env: "development" }],
        },
      ],
    });

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", onConflict: "overwrite" },
    });
    expect(r.ok).toBe(true);

    const desc = await s({
      cmd: "describe-secret",
      args: { id: "DATABASE_URL" },
    });
    expect(desc.ok).toBe(true);
    if (!desc.ok) return;
    const sec = desc.secret as { scopes: Array<{ env: string }> };
    expect(sec.scopes.some((sc) => sc.env === "development")).toBe(true);
  });

  it("skips on conflict by default", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=postgres://NEW");
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
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://OLD",
          scopes: [{ repoId: "r1", env: "development" }],
        },
      ],
    });

    const r = await s({ cmd: "import", args: { repo: "alpha" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.plan as { actions: Array<{ type: string }> };
    expect(plan.actions[0]?.type).toBe("skip");

    // Scopes untouched — still owned by s1's pre-import cell.
    const desc = await s({
      cmd: "describe-secret",
      args: { id: "DATABASE_URL" },
    });
    if (desc.ok) {
      const sec = desc.secret as { scopes: Array<{ repoId: string; env: string }> };
      expect(sec.scopes).toEqual([{ repoId: "r1", env: "development" }]);
    }
  });

  it("requires --env when the repo has multiple envs", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=x");
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
    });

    const r = await s({ cmd: "import", args: { repo: "alpha" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("dry-run does not persist", async () => {
    repoDir = await makeRepoWithEnv("DATABASE_URL=x_with_enough_entropy_xx");
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
    });

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", dryRun: true },
    });
    expect(r.ok).toBe(true);

    const list = await s({ cmd: "list-secrets" });
    if (list.ok) {
      expect((list.secrets as unknown[]).length).toBe(0);
    }
  });

  it("applies --default-namespace to all new entries", async () => {
    repoDir = await makeRepoWithEnv("STRIPE_KEY=sk_test_with_entropy_xx");
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
    });

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", defaultNamespace: "stripe" },
    });
    expect(r.ok).toBe(true);

    const list = await s({
      cmd: "list-secrets",
      args: { namespace: "stripe" },
    });
    if (list.ok) {
      const rows = list.secrets as Array<{ namespace?: string; key: string }>;
      expect(rows[0]?.namespace).toBe("stripe");
      expect(rows[0]?.key).toBe("STRIPE_KEY");
    }
  });

  it("uppercases lowercase keys from .env to fit schema", async () => {
    repoDir = await makeRepoWithEnv("database_url=postgres://lowercase_source");
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
    });

    const r = await s({ cmd: "import", args: { repo: "alpha" } });
    expect(r.ok).toBe(true);

    const list = await s({ cmd: "list-secrets" });
    if (list.ok) {
      const keys = (list.secrets as Array<{ key: string }>).map((x) => x.key);
      expect(keys).toContain("DATABASE_URL");
    }
  });

  it("reads .env.<env> when --env is passed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sm-multienv-"));
    await writeFile(path.join(dir, ".env.production"), "PROD_KEY=prod_value_with_entropy", "utf8");
    await writeFile(path.join(dir, ".env.development"), "DEV_KEY=dev_value_with_entropy", "utf8");
    repoDir = dir;

    await startWithSeed({
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: dir,
          environments: ["development", "production"],
        },
      ],
      secrets: [],
    });

    const r = await s({
      cmd: "import",
      args: { repo: "alpha", env: "production" },
    });
    expect(r.ok).toBe(true);

    const list = await s({ cmd: "list-secrets" });
    if (list.ok) {
      const keys = (list.secrets as Array<{ key: string }>).map((x) => x.key);
      expect(keys).toEqual(["PROD_KEY"]);
    }
  });
});
