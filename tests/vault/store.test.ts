import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveKey,
  encryptVault,
  generateSalt,
  parseBlob,
  serializeBlob,
} from "@/lib/vault/crypto";
import {
  VaultError,
  loadVault,
  saveVault,
  vaultExists,
  vaultPath,
} from "@/lib/vault/store";
import type { VaultData } from "@/lib/vault/schema";
import { DEFAULT_ENV_VARIANT_MAP } from "@/lib/vault/variant/resolve";

const PASSWORD = "right-password";
const WRONG_PASSWORD = "wrong-password";

let activeDir: string | undefined;

async function withTempVault(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  process.env.SECRETS_MANAGER_VAULT_DIR = dir;
  activeDir = dir;
  return dir;
}

beforeEach(async () => {
  await withTempVault();
});

afterEach(async () => {
  delete process.env.SECRETS_MANAGER_VAULT_DIR;
  if (activeDir) {
    await rm(activeDir, { recursive: true, force: true });
    activeDir = undefined;
  }
});

function sampleData(): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "repo_1",
        name: "alpha",
        path: "/tmp/alpha",
        environments: ["development", "production"],
      },
      {
        id: "repo_2",
        name: "beta",
        path: "/tmp/beta",
        environments: ["staging"],
      },
    ],
    secrets: [
      {
        id: "sec_1",
        key: "DATABASE_URL",
        value: "postgres://localhost/db",
        scopes: [
          { repoId: "repo_1", env: "development" },
          { repoId: "repo_2", env: "staging" },
        ],
      },
      {
        id: "sec_2",
        key: "API_KEY",
        value: "super-secret",
        scopes: [],
      },
    ],
  };
}

describe("vaultExists", () => {
  it("returns false before any save", async () => {
    expect(await vaultExists()).toBe(false);
  });

  it("returns true after save", async () => {
    await saveVault(sampleData(), PASSWORD);
    expect(await vaultExists()).toBe(true);
  });
});

describe("saveVault → loadVault round-trip", () => {
  it("returns equivalent data (v2 saved → upgraded to v4 on load)", async () => {
    const data = sampleData();
    await saveVault(data, PASSWORD);
    const out = await loadVault(PASSWORD);
    // loadVault runs migrateToLatest, so a v2 vault is upgraded to v4 on read.
    expect(out.version).toBe(4);
    expect(out.repos).toEqual(data.repos);
    expect(out.secrets).toEqual(data.secrets);
    expect(out.envVariantMap).toEqual({
      global: DEFAULT_ENV_VARIANT_MAP,
      repos: {},
    });
  });

  it("returns equivalent data on an empty vault (v2 → v4 upgrade)", async () => {
    const data: VaultData = { version: 2, repos: [], secrets: [] };
    await saveVault(data, PASSWORD);
    const out = await loadVault(PASSWORD);
    expect(out.version).toBe(4);
    expect(out.repos).toEqual([]);
    expect(out.secrets).toEqual([]);
    expect(out.envVariantMap).toEqual({
      global: DEFAULT_ENV_VARIANT_MAP,
      repos: {},
    });
  });

  it("dedupes repo environments via schema", async () => {
    const data: VaultData = {
      version: 2,
      repos: [
        {
          id: "r1",
          name: "dupes",
          path: "/tmp/dupes",
          environments: ["dev", "dev", "prod"],
        },
      ],
      secrets: [],
    };
    await saveVault(data, PASSWORD);
    const out = await loadVault(PASSWORD);
    expect(out.repos[0].environments).toEqual(["dev", "prod"]);
  });
});

describe("wrong-password rejection", () => {
  it("throws VaultError with code WRONG_PASSWORD", async () => {
    await saveVault(sampleData(), PASSWORD);
    await expect(loadVault(WRONG_PASSWORD)).rejects.toMatchObject({
      name: "VaultError",
      code: "WRONG_PASSWORD",
    });
  });
});

describe("corrupted-blob rejection", () => {
  it("throws VaultError with code CORRUPTED on garbage file", async () => {
    await saveVault(sampleData(), PASSWORD);
    await writeFile(vaultPath(), "this is not a vault envelope", "utf8");
    await expect(loadVault(PASSWORD)).rejects.toMatchObject({
      name: "VaultError",
      code: "CORRUPTED",
    });
  });

  it("throws VaultError with code CORRUPTED on unknown version", async () => {
    await saveVault(sampleData(), PASSWORD);
    const raw = await readFile(vaultPath(), "utf8");
    const tampered = `v9:${raw.split(":").slice(1).join(":")}`;
    await writeFile(vaultPath(), tampered, "utf8");
    await expect(loadVault(PASSWORD)).rejects.toMatchObject({
      name: "VaultError",
      code: "CORRUPTED",
    });
  });
});

describe("not-found rejection", () => {
  it("throws VaultError with code NOT_FOUND when no vault file", async () => {
    await expect(loadVault(PASSWORD)).rejects.toMatchObject({
      name: "VaultError",
      code: "NOT_FOUND",
    });
  });
});

describe("salt freshness", () => {
  it("produces a different salt on each save but both decrypt with the same password", async () => {
    const data = sampleData();
    await saveVault(data, PASSWORD);
    const first = await readFile(vaultPath(), "utf8");
    const firstEnvelope = parseBlob(first.trim());

    await saveVault(data, PASSWORD);
    const second = await readFile(vaultPath(), "utf8");
    const secondEnvelope = parseBlob(second.trim());

    expect(firstEnvelope.salt.equals(secondEnvelope.salt)).toBe(false);
    expect(firstEnvelope.nonce.equals(secondEnvelope.nonce)).toBe(false);

    // loadVault runs migrateToLatest, so the v2 data is upgraded to v4.
    const out = await loadVault(PASSWORD);
    expect(out.version).toBe(4);
    expect(out.repos).toEqual(data.repos);
    expect(out.secrets).toEqual(data.secrets);
  });
});

describe("schema validation post-decrypt", () => {
  it("throws VaultError with code INVALID_DATA on schema-invalid plaintext", async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt);
    // After v2 migration, {} normalizes into a valid empty vault, so we have
    // to feed something the schema actively rejects: a secret with a lowercase
    // key (violates the SecretSchema regex).
    const plaintext = JSON.stringify({
      version: 2,
      repos: [],
      secrets: [
        { id: "x", key: "lowercase_key", value: "v", scopes: [] },
      ],
    });
    const { nonce, ciphertext, tag } = encryptVault(plaintext, key);
    const envelope = serializeBlob(salt, nonce, ciphertext, tag);
    await writeFile(vaultPath(), envelope, "utf8");

    await expect(loadVault(PASSWORD)).rejects.toMatchObject({
      name: "VaultError",
      code: "INVALID_DATA",
    });
  });

  it("throws VaultError with code CORRUPTED when decrypted plaintext is not JSON", async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt);
    const plaintext = "not valid json {{{";
    const { nonce, ciphertext, tag } = encryptVault(plaintext, key);
    const envelope = serializeBlob(salt, nonce, ciphertext, tag);
    await writeFile(vaultPath(), envelope, "utf8");

    await expect(loadVault(PASSWORD)).rejects.toMatchObject({
      name: "VaultError",
      code: "CORRUPTED",
    });
  });
});

describe("VaultError shape", () => {
  it("is instanceof Error and VaultError", async () => {
    await expect(loadVault(PASSWORD)).rejects.toBeInstanceOf(VaultError);
    await expect(loadVault(PASSWORD)).rejects.toBeInstanceOf(Error);
  });
});
