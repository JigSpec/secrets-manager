/**
 * Daemon handler: set-description  (issue #34)
 *
 * All tests in this file are expected to be RED until the implementation
 * is written at lib/daemon/handlers/set-description.ts.
 *
 * Seed vault:
 *   s1 – DATABASE_URL   (no description, no namespace)
 *   s2 – API_KEY        namespace=stripe  description="Existing description"
 *   s3 – API_KEY        namespace=github  (no description)
 *
 * Having two secrets share the bare key "API_KEY" (s2 and s3) lets us
 * exercise the AMBIGUOUS path when the caller passes the key instead of
 * the secret id.
 */

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
import { loadVault } from "@/lib/vault/store";
import type { VaultData } from "@/lib/vault/schema";

const SEED: VaultData = {
  version: 2,
  repos: [],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://secret-value-AAAAAA",
      scopes: [],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_AAAAAA",
      scopes: [],
      description: "Existing description",
    },
    {
      id: "s3",
      key: "API_KEY",
      namespace: "github",
      value: "ghp_AAAAAA",
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

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

/** Read the live vault directly from disk (bypasses the daemon). */
async function readVault(): Promise<VaultData> {
  const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
  process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
  try {
    return await loadVault(DEFAULT_PASSWORD);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
    else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
  }
}

describe("daemon handler: set-description", () => {
  // ── happy-path ────────────────────────────────────────────────────────────────────

  it("sets a description on a secret that had none", async () => {
    const r = await s("set-description", {
      secret: "s1",
      description: "Primary database connection string",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe("Primary database connection string");
    // Value must not be leaked in the response.
    expect(sec).not.toHaveProperty("value");
  });

  it("replaces an existing description", async () => {
    const r = await s("set-description", {
      secret: "s2",
      description: "Updated stripe key description",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe("Updated stripe key description");
  });

  it("clears description with empty string — field is absent, not empty", async () => {
    const r = await s("set-description", {
      secret: "s2",
      description: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    // The vault schema has min(1) on description, so empty string must be
    // treated as "clear": the field should be absent entirely.
    expect(sec).not.toHaveProperty("description");

    // Verify the vault on disk also omits the field.
    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s2");
    expect(stored).not.toHaveProperty("description");
  });

  it("accepts exactly 500 characters", async () => {
    const desc = "A".repeat(500);
    const r = await s("set-description", { secret: "s1", description: desc });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe(desc);
  });

  it("value is NOT touched when only description changes", async () => {
    // Set a description, then verify the stored value is unchanged.
    const r = await s("set-description", {
      secret: "s1",
      description: "Just a description update",
    });
    expect(r.ok).toBe(true);

    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    expect(stored?.value).toBe("postgres://secret-value-AAAAAA");
  });

  it("description round-trips through describe-secret", async () => {
    await s("set-description", {
      secret: "s1",
      description: "Round-trip test description",
    });

    const r = await s("describe-secret", { id: "s1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe("Round-trip test description");
  });

  // ── error paths ────────────────────────────────────────────────────────────────────

  it("returns NOT_FOUND for an unknown secret", async () => {
    const r = await s("set-description", {
      secret: "DOES_NOT_EXIST",
      description: "irrelevant",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  it("returns AMBIGUOUS when bare key matches multiple secrets", async () => {
    // "API_KEY" matches both s2 (stripe) and s3 (github).
    const r = await s("set-description", {
      secret: "API_KEY",
      description: "should fail with ambiguous",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("AMBIGUOUS");
  });

  it("returns INVALID_INPUT when description exceeds 500 characters", async () => {
    const desc = "B".repeat(501);
    const r = await s("set-description", { secret: "s1", description: desc });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when `secret` arg is missing", async () => {
    const r = await s("set-description", {
      description: "no secret provided",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when `description` arg is missing", async () => {
    const r = await s("set-description", { secret: "s1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });
});
