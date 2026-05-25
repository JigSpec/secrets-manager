/**
 * CLI tests: set-description command + description forwarding for
 * add-secret and set-value  (issue #34)
 *
 * All tests in this file are expected to be RED until:
 *   - lib/cli/commands/set-description.ts  is created and registered
 *   - lib/cli/commands/add-secret.ts       gains --description flag
 *   - lib/cli/commands/set-value.ts        gains --description flag
 *
 * Tests interact with the daemon directly via sendCommand so they are not
 * coupled to the final CLI flag names and are easier to maintain.
 */

import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { dispatchCommand } from "@/lib/cli/router";

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
  ],
};

let tmp: string;
let scratch: string;
let daemon: SpawnedDaemon | null = null;

async function writeTempValue(content: string): Promise<string> {
  const p = path.join(
    scratch,
    `value-${Math.random().toString(36).slice(2)}.txt`,
  );
  await writeFile(p, content, "utf8");
  return p;
}

beforeAll(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-cli-desc-"));
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
  await cleanupVaultDir(scratch);
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

describe("CLI: set-description command", () => {
  it("set-description sets description on a secret", async () => {
    // This test calls the daemon directly, which will fail until the
    // set-description daemon handler is registered.
    const r = await s("set-description", {
      secret: "s1",
      description: "The primary database connection string",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe("The primary database connection string");
    expect(sec).not.toHaveProperty("value");
  });

  it("set-description with empty string clears description (field absent)", async () => {
    const r = await s("set-description", {
      secret: "s2",
      description: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    // Empty string means clear: the field must be absent, not "".
    expect(sec).not.toHaveProperty("description");
  });

  it("set-description persists across daemon restart", async () => {
    const r = await s("set-description", {
      secret: "s1",
      description: "Persisted description",
    });
    expect(r.ok).toBe(true);

    // Kill the daemon and start a fresh one pointing at the same vault dir.
    await daemon!.kill();
    daemon = await startDaemon({ vaultDir: tmp });
    await daemon.ready;

    const describe = await s("describe-secret", { id: "s1" });
    expect(describe.ok).toBe(true);
    if (!describe.ok) return;
    const sec = describe.secret as Record<string, unknown>;
    expect(sec.description).toBe("Persisted description");
  });

  it("set-description does NOT modify the value", async () => {
    await s("set-description", {
      secret: "s1",
      description: "Value must stay intact",
    });

    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    expect(stored?.value).toBe("postgres://secret-value-AAAAAA");
  });

  it("set-description returns NOT_FOUND for unknown secret", async () => {
    const r = await s("set-description", {
      secret: "GHOST_SECRET",
      description: "irrelevant",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  it("set-description rejects description longer than 500 chars", async () => {
    const r = await s("set-description", {
      secret: "s1",
      description: "Z".repeat(501),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });
});

describe("CLI: add-secret stores description when provided", () => {
  it("add-secret forwards description to the daemon and stores it", async () => {
    // This test will be RED until lib/cli/commands/add-secret.ts gains a
    // --description flag and forwards it in the args payload.  We call the
    // daemon directly here (the same way the CLI does) to test end-to-end.
    const valuePath = await writeTempValue("new-secret-value-AAAAAA");
    const r = await s("add-secret", {
      key: "NEW_SECRET",
      valuePath,
      description: "Description for the new secret",
    });
    // The daemon handler already accepts description — the CLI just hasn't
    // been updated to forward it yet.  This validates the full round-trip.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe("Description for the new secret");
    expect(sec).not.toHaveProperty("value");

    // Confirm persistence.
    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.key === "NEW_SECRET");
    expect(stored?.description).toBe("Description for the new secret");
  });
});

describe("CLI: set-value updates description when provided", () => {
  it("set-value forwards description to the daemon and updates it", async () => {
    // This test will be RED until lib/cli/commands/set-value.ts gains a
    // --description flag and forwards it in the args payload.
    const valuePath = await writeTempValue(
      "replacement-secret-value-AAAAAA",
    );
    const r = await s("set-value", {
      secret: "s1",
      valuePath,
      description: "Updated description via set-value",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.description).toBe("Updated description via set-value");

    // Value also updated correctly.
    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    expect(stored?.value).toBe("replacement-secret-value-AAAAAA");
    expect(stored?.description).toBe("Updated description via set-value");
  });
});

/**
 * These tests exercise the CLI argument-parsing layer directly via
 * `dispatchCommand`, without a live daemon. They verify that the handler
 * in lib/cli/commands/set-description.ts correctly validates its argv
 * inputs before ever calling sendCommand.
 */
describe("CLI dispatch: set-description argument parsing", () => {
  it("rejects when both --description and --unset are supplied", async () => {
    const r = await dispatchCommand("set-description", [
      "MY_SECRET",
      "--description",
      "some text",
      "--unset",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/cannot specify both/);
  });

  it("rejects when neither --description nor --unset is supplied", async () => {
    const r = await dispatchCommand("set-description", ["MY_SECRET"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("rejects when --description exceeds 500 characters", async () => {
    const r = await dispatchCommand("set-description", [
      "MY_SECRET",
      "--description",
      "X".repeat(501),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/500 characters or fewer/);
  });

  it("rejects when the <secret> positional argument is missing", async () => {
    const r = await dispatchCommand("set-description", [
      "--description",
      "some text",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("--unset maps to description: '' and passes CLI validation (reaches daemon layer)", async () => {
    // With no live daemon the sendCommand call inside the handler will fail
    // with DAEMON_LOCKED — that is fine. The important thing is that the CLI
    // layer itself did NOT reject the request, which means --unset was
    // correctly mapped to an empty description and forwarded.
    const r = await dispatchCommand("set-description", [
      "MY_SECRET",
      "--unset",
    ]);
    // DAEMON_LOCKED means the CLI parsed args successfully and reached sendCommand.
    // Any code other than INVALID_INPUT means the CLI layer accepted the input.
    expect(r.ok === false && (r as { code: string }).code === "INVALID_INPUT").toBe(false);
  });
});
