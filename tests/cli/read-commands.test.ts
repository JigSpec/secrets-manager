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
      value: "postgres://user:pass@host:5432/db_high_entropy_value_xx",
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
      value: "short",
      scopes: [],
    },
  ],
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
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
});

describe("CLI read commands", () => {
  it("list-repos returns repos with environments", async () => {
    const r = await sendCommand(
      { cmd: "list-repos" },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.repos)).toBe(true);
    const repos = r.repos as Array<{
      id: string;
      name: string;
      environments: string[];
    }>;
    expect(repos.map((x) => x.name).sort()).toEqual(["alpha", "beta"]);
    const alpha = repos.find((x) => x.name === "alpha")!;
    expect(alpha.environments).toEqual(["development", "production"]);
  });

  it("list-secrets returns metadata without value", async () => {
    const r = await sendCommand(
      { cmd: "list-secrets" },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secrets = r.secrets as Array<Record<string, unknown>>;
    expect(secrets).toHaveLength(3);
    for (const s of secrets) {
      expect(s).not.toHaveProperty("value");
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("key");
      expect(s).toHaveProperty("scopes");
    }
  });

  it("list-secrets filters by namespace", async () => {
    const r = await sendCommand(
      { cmd: "list-secrets", args: { namespace: "stripe" } },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const secrets = r.secrets as Array<{ id: string; namespace?: string }>;
    expect(secrets).toHaveLength(1);
    expect(secrets[0].id).toBe("s2");
    expect(secrets[0].namespace).toBe("stripe");
  });

  it("list-secrets rejects malformed namespace", async () => {
    const r = await sendCommand(
      { cmd: "list-secrets", args: { namespace: "Bad-Name" } },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("list-scopes joins repos to secret scopes", async () => {
    const r = await sendCommand(
      { cmd: "list-scopes" },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.scopes as Array<{
      repoName: string;
      env: string;
      secretKey: string;
      namespace?: string;
    }>;
    expect(rows).toHaveLength(3);
    const dbRows = rows.filter((row) => row.secretKey === "DATABASE_URL");
    expect(dbRows.map((row) => row.env).sort()).toEqual([
      "development",
      "production",
    ]);
    const stripeRow = rows.find(
      (row) => row.secretKey === "API_KEY" && row.namespace === "stripe",
    );
    expect(stripeRow?.repoName).toBe("beta");
  });

  it("describe-secret returns metadata + fingerprint by id", async () => {
    const r = await sendCommand(
      { cmd: "describe-secret", args: { id: "s1" } },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.key).toBe("DATABASE_URL");
    expect(sec).not.toHaveProperty("value");
    expect(typeof sec.valueFingerprint).toBe("string");
    expect((sec.valueFingerprint as string).length).toBe(16);
  });

  it("describe-secret resolves by key when id isn't a match", async () => {
    const r = await sendCommand(
      { cmd: "describe-secret", args: { id: "DATABASE_URL" } },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.secret as Record<string, unknown>).id).toBe("s1");
  });

  it("describe-secret omits fingerprint for low-signal values", async () => {
    const r = await sendCommand(
      { cmd: "describe-secret", args: { id: "s3" } },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec).not.toHaveProperty("valueFingerprint");
  });

  it("describe-secret returns NOT_FOUND when key is unknown", async () => {
    const r = await sendCommand(
      { cmd: "describe-secret", args: { id: "DOES_NOT_EXIST" } },
      { socketPathOverride: daemon!.socketPath },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });
});
