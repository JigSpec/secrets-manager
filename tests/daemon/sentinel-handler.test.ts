/**
 * Integration tests: sentinel-value rejection in add-secret and set-value
 * handlers (issue #92).
 *
 * Both handlers must reject placeholder sentinel strings (e.g. TODO,
 * PLACEHOLDER, <YOUR_KEY>) and return INVALID_INPUT rather than storing
 * garbage in the vault.
 *
 * A single daemon instance is shared across all tests in this file
 * (beforeAll/afterAll) to avoid starting 9 separate daemons and save ~40 s
 * in the test suite. Rejection tests have no side effects on vault state,
 * and the two acceptance tests use non-overlapping keys/values.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const SEED: VaultData = {
  version: 4,
  repos: [],
  secrets: [
    {
      id: "s1",
      key: "API_KEY",
      value: "sk_live_realvalue_AAAAAA",
      scopes: [],
    },
  ],
  envVariantMap: { global: {}, repos: {} },
};

let tmp: string;
let scratch: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-sentinel-"));
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
});

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

async function writeValueFile(filename: string, value: string): Promise<string> {
  const p = path.join(scratch, filename);
  await writeFile(p, value, "utf8");
  return p;
}

// ── add-secret: sentinel rejection ─────────────────────────────────────────────

describe("daemon handler: add-secret — sentinel rejection", () => {
  it('rejects "PLACEHOLDER" as an INVALID_INPUT', async () => {
    const vp = await writeValueFile("v1.txt", "PLACEHOLDER");
    const r = await s("add-secret", { key: "NEW_SECRET", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/sentinel/i);
  });

  it('rejects "TODO" as an INVALID_INPUT', async () => {
    const vp = await writeValueFile("v2.txt", "TODO");
    const r = await s("add-secret", { key: "ANOTHER_SECRET", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it('rejects "<YOUR_API_KEY>" as an INVALID_INPUT', async () => {
    const vp = await writeValueFile("v3.txt", "<YOUR_API_KEY>");
    const r = await s("add-secret", { key: "SOME_KEY", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it('rejects "YOUR_KEY_HERE" (sentinel with delimiter) as an INVALID_INPUT', async () => {
    const vp = await writeValueFile("v4.txt", "YOUR_KEY_HERE");
    const r = await s("add-secret", { key: "ANOTHER_KEY", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("accepts a real-looking secret value", async () => {
    const vp = await writeValueFile("v5.txt", "sk_live_realtoken_AAAAAA");
    const r = await s("add-secret", { key: "REAL_KEY", valuePath: vp });
    expect(r.ok).toBe(true);
  });
});

// ── set-value: sentinel rejection ────────────────────────────────────────────

describe("daemon handler: set-value — sentinel rejection", () => {
  it('rejects "PLACEHOLDER" when updating an existing secret', async () => {
    const vp = await writeValueFile("sv1.txt", "PLACEHOLDER");
    const r = await s("set-value", { secret: "s1", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/sentinel/i);
  });

  it('rejects "__SET_VIA_TUTORIAL__" when updating an existing secret', async () => {
    const vp = await writeValueFile("sv2.txt", "__SET_VIA_TUTORIAL__");
    const r = await s("set-value", { secret: "s1", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it('rejects "INSERT_KEY_HERE" (sentinel with delimiter)', async () => {
    const vp = await writeValueFile("sv3.txt", "INSERT_KEY_HERE");
    const r = await s("set-value", { secret: "s1", valuePath: vp });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("accepts a real-looking updated value", async () => {
    const vp = await writeValueFile("sv4.txt", "sk_live_rotated_BBBBBB");
    const r = await s("set-value", { secret: "s1", valuePath: vp });
    expect(r.ok).toBe(true);
  });
});

// ── add-secret: dotenvx reserved-key rejection (issue #114 OROBOROUS) ────────
//
// These tests are RED until lib/daemon/handlers/add-secret.ts guards against
// dotenvx-reserved keys (DOTENV_PUBLIC_KEY_* and DOTENV_PRIVATE_KEY_*).
// The daemon must reject them with { ok: false, code: "INVALID_INPUT" }
// regardless of the supplied value.

describe("daemon handler: add-secret — dotenvx reserved-key rejection", () => {
  it('rejects key "DOTENV_PUBLIC_KEY_PRODUCTION" with INVALID_INPUT', async () => {
    const vp = await writeValueFile("dpk1.txt", "03abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab");
    const r = await s("add-secret", {
      key: "DOTENV_PUBLIC_KEY_PRODUCTION",
      valuePath: vp,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it('rejects key "DOTENV_PRIVATE_KEY_DEVELOPMENT" with INVALID_INPUT', async () => {
    const vp = await writeValueFile("dpk2.txt", "aabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabb");
    const r = await s("add-secret", {
      key: "DOTENV_PRIVATE_KEY_DEVELOPMENT",
      valuePath: vp,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it('still accepts a normal key "API_SECRET" (no regression)', async () => {
    const vp = await writeValueFile("dpk3.txt", "sk_live_notadotenvxkey_AAAA");
    const r = await s("add-secret", { key: "API_SECRET", valuePath: vp });
    expect(r.ok).toBe(true);
  });
});
