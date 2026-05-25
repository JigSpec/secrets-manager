import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadVault,
  saveVault,
  vaultExists,
  VaultError,
} from "@/lib/vault/store";
import type { VaultData } from "@/lib/vault/schema";
import { DEFAULT_ENV_VARIANT_MAP } from "@/lib/vault/variant/resolve";

describe("vault end-to-end round-trip without server-only session", () => {
  let tmp: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sm-e2e-"));
    prevDir = process.env.SECRETS_MANAGER_VAULT_DIR;
    process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
    else process.env.SECRETS_MANAGER_VAULT_DIR = prevDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a vault, persists multiple mutations, survives lock+unlock", async () => {
    expect(await vaultExists()).toBe(false);

    const seed: VaultData = { version: 2, repos: [], secrets: [] };
    await saveVault(seed, "hunter22hunter22");
    expect(await vaultExists()).toBe(true);

    // simulate: add a repo, add a secret, assign a scope.
    const next: VaultData = {
      version: 2,
      repos: [
        {
          id: "r1",
          name: "my-app",
          path: "/tmp/my-app",
          environments: ["development", "production"],
        },
      ],
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://example",
          scopes: [{ repoId: "r1", env: "production" }],
        },
      ],
    };
    await saveVault(next, "hunter22hunter22");

    // simulate lock (drop in-memory state) and re-unlock from disk.
    // loadVault runs migrateToLatest so a v2 vault is upgraded to v4 on read.
    const loaded = await loadVault("hunter22hunter22");
    expect(loaded.version).toBe(4);
    expect(loaded.repos).toEqual(next.repos);
    expect(loaded.secrets).toEqual(next.secrets);
    expect(loaded.envVariantMap).toEqual({ global: DEFAULT_ENV_VARIANT_MAP, repos: {} });

    // wrong password rejected, vault unchanged on disk.
    await expect(loadVault("wrong-pw")).rejects.toMatchObject({
      code: "WRONG_PASSWORD",
    });
    const loadedAgain = await loadVault("hunter22hunter22");
    expect(loadedAgain.version).toBe(4);
    expect(loadedAgain.repos).toEqual(next.repos);
    expect(loadedAgain.secrets).toEqual(next.secrets);
  });

  it("VaultError is throwable and has discriminating code", async () => {
    const err = new VaultError("CORRUPTED", "test");
    expect(err.code).toBe("CORRUPTED");
    expect(err).toBeInstanceOf(Error);
  });
});
