import { writeFile, mkdtemp, access, readFile } from "node:fs/promises";
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
import { loadVault } from "@/lib/vault/store";
import type { VaultData } from "@/lib/vault/schema";

const SEED: VaultData = {
  version: 2,
  repos: [],
  secrets: [
    {
      id: "s1",
      key: "EXISTING_KEY",
      value: "old-value-with-enough-entropy-AAAAAA",
      scopes: [],
    },
  ],
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;
let scratch: string;

async function writeTempValue(content: string): Promise<string> {
  const p = path.join(scratch, `value-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(p, content, "utf8");
  return p;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-vals-"));
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
  await cleanupVaultDir(scratch);
});

function s(req: { cmd: string; args?: Record<string, unknown> }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

describe("CLI value-bearing mutations", () => {
  it("add-secret reads value from file, persists, and unlinks the temp file", async () => {
    const valuePath = await writeTempValue("super-secret-token-AAAAAA");
    const r = await s({
      cmd: "add-secret",
      args: { key: "NEW_KEY", valuePath },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec).not.toHaveProperty("value");
    expect(sec.key).toBe("NEW_KEY");

    // Temp file is gone.
    expect(await fileExists(valuePath)).toBe(false);

    // Value really landed in the encrypted vault.
    const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
    process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
    try {
      const v = await loadVault(DEFAULT_PASSWORD);
      const stored = v.secrets.find((x) => x.key === "NEW_KEY");
      expect(stored?.value).toBe("super-secret-token-AAAAAA");
    } finally {
      if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
      else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
    }
  });

  it("add-secret rejects an invalid key", async () => {
    const valuePath = await writeTempValue("v");
    const r = await s({
      cmd: "add-secret",
      args: { key: "lowercase_key", valuePath },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    // On invalid key, the file is NOT consumed — caller still owns it.
    expect(await fileExists(valuePath)).toBe(true);
  });

  it("add-secret allows a duplicate (key, namespace) — new scopes are empty so the disjoint invariant holds", async () => {
    // Issue #16: (key, namespace) uniqueness was replaced with disjoint-scope
    // uniqueness. A newly added secret always starts with scopes: [], which
    // cannot overlap with any sibling's scope set — so the add is allowed.
    const valuePath = await writeTempValue("v");
    const r = await s({
      cmd: "add-secret",
      args: { key: "EXISTING_KEY", valuePath },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as { id: string; key: string };
    expect(sec.key).toBe("EXISTING_KEY");
    // The new secret has a distinct id from the seed's s1.
    expect(sec.id).not.toBe("s1");

    // Both secrets coexist with the same (key, namespace) tuple.
    const list = await s({ cmd: "list-secrets" });
    if (list.ok) {
      const existing = (list.secrets as Array<{ key: string }>).filter(
        (x) => x.key === "EXISTING_KEY",
      );
      expect(existing.length).toBe(2);
    }
  });

  it("add-secret allows the same key in a different namespace", async () => {
    const valuePath = await writeTempValue("v");
    const r = await s({
      cmd: "add-secret",
      args: { key: "EXISTING_KEY", namespace: "stripe", valuePath },
    });
    expect(r.ok).toBe(true);
  });

  it("remove-secret deletes by key", async () => {
    const r = await s({
      cmd: "remove-secret",
      args: { target: "EXISTING_KEY" },
    });
    expect(r.ok).toBe(true);

    const list = await s({ cmd: "list-secrets" });
    if (list.ok) {
      expect((list.secrets as unknown[]).length).toBe(0);
    }
  });

  it("set-value swaps the value and unlinks", async () => {
    const valuePath = await writeTempValue("brand-new-value-with-entropy-AAAA");
    const r = await s({
      cmd: "set-value",
      args: { secret: "EXISTING_KEY", valuePath },
    });
    expect(r.ok).toBe(true);
    expect(await fileExists(valuePath)).toBe(false);

    const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
    process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
    try {
      const v = await loadVault(DEFAULT_PASSWORD);
      const stored = v.secrets.find((x) => x.key === "EXISTING_KEY");
      expect(stored?.value).toBe("brand-new-value-with-entropy-AAAA");
    } finally {
      if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
      else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
    }
  });

  it("set-value returns NOT_FOUND for unknown secret", async () => {
    const valuePath = await writeTempValue("v");
    const r = await s({
      cmd: "set-value",
      args: { secret: "DOES_NOT_EXIST", valuePath },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  it("the daemon response never carries a value field", async () => {
    const valuePath = await writeTempValue("definitely-secret-value-AAAAAA");
    const add = await s({
      cmd: "add-secret",
      args: { key: "NEVER_EMIT", valuePath },
    });
    expect(JSON.stringify(add)).not.toContain("definitely-secret-value");

    // Even read paths shouldn't leak the value.
    const desc = await s({
      cmd: "describe-secret",
      args: { id: "NEVER_EMIT" },
    });
    expect(JSON.stringify(desc)).not.toContain("definitely-secret-value");

    // Verify control: the value did persist (read via direct vault load).
    const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
    process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
    try {
      const v = await loadVault(DEFAULT_PASSWORD);
      const stored = v.secrets.find((x) => x.key === "NEVER_EMIT");
      expect(stored?.value).toBe("definitely-secret-value-AAAAAA");
      // Sanity check: file content really did land in vault, just not on the wire.
      void readFile;
    } finally {
      if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
      else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
    }
  });
});
