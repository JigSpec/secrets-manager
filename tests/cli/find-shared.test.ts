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

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeEach(async () => {
  tmp = await makeVaultDir();
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
});

async function bootWith(seed: VaultData): Promise<void> {
  await seedVault(tmp, seed, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
}

function s(req: { cmd: string }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

describe("CLI find-shared", () => {
  it("groups secrets that share a high-entropy value", async () => {
    const SHARED = "shared-high-entropy-value-AAAAAAAA";
    await bootWith({
      version: 2,
      repos: [],
      secrets: [
        { id: "s1", key: "FOO", value: SHARED, scopes: [] },
        { id: "s2", key: "BAR", value: SHARED, scopes: [] },
        {
          id: "s3",
          key: "BAZ",
          value: "different-but-also-entropic-value-BBB",
          scopes: [],
        },
      ],
    });

    const r = await s({ cmd: "find-shared" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.groups as Array<{
      fingerprint: string;
      members: Array<{ id: string; key: string }>;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.id).sort()).toEqual(["s1", "s2"]);
  });

  it("ignores secrets whose values fall below the entropy floor", async () => {
    await bootWith({
      version: 2,
      repos: [],
      secrets: [
        { id: "s1", key: "FOO", value: "password", scopes: [] },
        { id: "s2", key: "BAR", value: "password", scopes: [] },
      ],
    });

    const r = await s({ cmd: "find-shared" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups).toEqual([]);
  });

  it("surfaces namespace on each member", async () => {
    const SHARED = "shared-high-entropy-value-AAAAAAAA";
    await bootWith({
      version: 2,
      repos: [],
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          namespace: "stripe",
          value: SHARED,
          scopes: [],
        },
        {
          id: "s2",
          key: "API_KEY",
          namespace: "github",
          value: SHARED,
          scopes: [],
        },
      ],
    });

    const r = await s({ cmd: "find-shared" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.groups as Array<{
      members: Array<{ namespace?: string }>;
    }>;
    expect(groups[0]?.members.map((m) => m.namespace).sort()).toEqual([
      "github",
      "stripe",
    ]);
  });
});
