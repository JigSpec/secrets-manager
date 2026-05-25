import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

import {
  decryptVault,
  deriveKey,
  encryptVault,
  generateSalt,
  parseBlob,
  serializeBlob,
} from "./crypto";
import { migrateToLatest } from "./migrate";
import { VaultDataSchema, VaultDataV4Schema, type VaultData, type VaultDataV4 } from "./schema";

export { VaultError } from "./errors";
export type { VaultErrorCode } from "./errors";
import { VaultError } from "./errors";

export function vaultDir(): string {
  const override = process.env.SECRETS_MANAGER_VAULT_DIR;
  if (override && override.length > 0) {
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".config");
  return path.join(base, "secrets-manager");
}

export function vaultPath(): string {
  return path.join(vaultDir(), "vault.enc");
}

export async function vaultExists(): Promise<boolean> {
  try {
    const info = await stat(vaultPath());
    return info.isFile() && info.size > 0;
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

export async function loadVault(password: string): Promise<VaultDataV4> {
  const file = vaultPath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new VaultError("NOT_FOUND", "vault file does not exist");
    }
    throw err;
  }
  if (raw.length === 0) {
    throw new VaultError("NOT_FOUND", "vault file is empty");
  }

  let envelope: ReturnType<typeof parseBlob>;
  try {
    envelope = parseBlob(raw.trim());
  } catch (err) {
    throw new VaultError("CORRUPTED", "vault envelope is malformed", {
      cause: err,
    });
  }

  const key = await deriveKey(password, envelope.salt);

  let plaintext: string;
  try {
    plaintext = decryptVault(
      {
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        tag: envelope.tag,
      },
      key,
    );
  } catch (err) {
    throw new VaultError(
      "WRONG_PASSWORD",
      "failed to decrypt vault — wrong password or tampered ciphertext",
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new VaultError(
      "CORRUPTED",
      "decrypted vault is not valid JSON",
      { cause: err },
    );
  }

  const migrated = migrateToLatest(parsed);

  // Parse directly against VaultDataV4Schema — migrateToLatest always produces
  // a v4 vault, so any deviation is a data-integrity error that should throw.
  let v4data: VaultDataV4;
  try {
    v4data = VaultDataV4Schema.parse(migrated);
  } catch (err) {
    throw new VaultError(
      "INVALID_DATA",
      "decrypted vault did not match expected schema",
      { cause: err },
    );
  }
  return v4data;
}

export async function saveVault(
  data: VaultData,
  password: string,
): Promise<void> {
  const validated = VaultDataSchema.parse(data);
  const plaintext = JSON.stringify(validated);

  const dir = vaultDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const salt = generateSalt();
  const key = await deriveKey(password, salt);
  const { nonce, ciphertext, tag } = encryptVault(plaintext, key);
  const envelope = serializeBlob(salt, nonce, ciphertext, tag);

  const finalPath = vaultPath();
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, envelope, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, finalPath);
}
