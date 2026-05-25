/**
 * Daemon handler: set-idle-ttl
 *
 * Covers:
 *   - happy path applies to the running daemon (status reflects new TTL)
 *   - value is persisted to daemon-config.json
 *   - INVALID_INPUT for non-numeric / out-of-range / missing
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  repos: [],
  secrets: [],
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  // Start with the harness default of 60 min; we'll change it to 240 in tests.
  daemon = await startDaemon({ vaultDir: tmp, idleTtlMin: 60 });
  await daemon.ready;
});

afterAll(async () => {
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

describe("daemon handler: set-idle-ttl", () => {
  it("applies a new TTL to the running daemon", async () => {
    const before = await s("status");
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect((before as Record<string, unknown>).idleTtlMs).toBe(60 * 60_000);

    const r = await s("set-idle-ttl", { minutes: 240 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as Record<string, unknown>).idleTtlMin).toBe(240);
    expect((r as Record<string, unknown>).idleTtlMs).toBe(240 * 60_000);

    const after = await s("status");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect((after as Record<string, unknown>).idleTtlMs).toBe(240 * 60_000);
    // Timer was re-armed: remaining is fresh (within a small margin of full TTL).
    const remaining = (after as Record<string, unknown>).idleTtlMsRemaining as number;
    expect(remaining).toBeGreaterThan(239 * 60_000);
  });

  it("persists the new TTL to daemon-config.json", async () => {
    const r = await s("set-idle-ttl", { minutes: 120 });
    expect(r.ok).toBe(true);

    const cfgPath = path.join(tmp, "daemon-config.json");
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.idleTtlMin).toBe(120);
  });

  it("rejects non-numeric minutes with INVALID_INPUT", async () => {
    const r = await s("set-idle-ttl", { minutes: "lots" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("rejects out-of-range minutes (below min)", async () => {
    const r = await s("set-idle-ttl", { minutes: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("rejects out-of-range minutes (above max)", async () => {
    const r = await s("set-idle-ttl", { minutes: 10_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("rejects missing minutes arg with INVALID_INPUT", async () => {
    const r = await s("set-idle-ttl", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });
});
