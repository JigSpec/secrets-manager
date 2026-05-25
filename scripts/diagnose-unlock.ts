#!/usr/bin/env -S npx tsx
/**
 * Diagnostic CLI for vault unlock failures.
 *
 * Usage:
 *   npx tsx scripts/diagnose-unlock.ts
 *
 * Reads the same vault file the GUI would (~/.config/secrets-manager/vault.enc
 * unless SECRETS_MANAGER_VAULT_DIR or XDG_CONFIG_HOME overrides), prompts for
 * the master password (without echo), and reports exactly where in the load
 * pipeline the failure occurs:
 *
 *   1. Read file from disk
 *   2. Parse envelope (header / base64 / lengths)
 *   3. Derive key via scrypt
 *   4. Decrypt + verify AEAD tag (correct password check)
 *   5. Parse JSON
 *   6. Migrate to latest schema (v2 -> v3 -> v4)
 *   7. Validate against VaultDataV4 schema
 *
 * Prints the schema version of the on-disk vault and a summary of what
 * survived (repo count, secret count, field histogram) without ever
 * revealing secret values.
 *
 * This script is intended to run locally on a developer machine when the
 * GUI shows "Failed to unlock." with no actionable detail. It is the
 * fastest path from "I can't unlock" to a concrete error message.
 */
import { readFile } from "node:fs/promises";

import { readPasswordFromTty } from "../lib/daemon/password-prompt";
import {
  decryptVault,
  deriveKey,
  parseBlob,
} from "../lib/vault/crypto";
import { migrateToLatest } from "../lib/vault/migrate";
import { VaultDataV4Schema } from "../lib/vault/schema";
import { vaultPath } from "../lib/vault/store";
import { VaultError } from "../lib/vault/errors";

type Stage =
  | "read-file"
  | "parse-envelope"
  | "derive-key"
  | "decrypt"
  | "parse-json"
  | "migrate"
  | "schema-validate";

function logStage(stage: Stage, status: "ok" | "fail", detail?: string): void {
  const stamp = status === "ok" ? "OK  " : "FAIL";
  process.stderr.write(`[${stamp}] ${stage}${detail ? ` — ${detail}` : ""}\n`);
}

function summarise(parsed: unknown): void {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`  (decrypted payload is not an object: typeof=${typeof parsed})\n`);
    return;
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  const repos = Array.isArray(obj.repos) ? obj.repos.length : "(missing)";
  const secrets = Array.isArray(obj.secrets) ? obj.secrets.length : "(missing)";
  const hasMap = obj.envVariantMap !== undefined;
  process.stderr.write(
    `  on-disk version: ${JSON.stringify(version)}\n` +
      `  repos: ${repos}\n` +
      `  secrets: ${secrets}\n` +
      `  envVariantMap present: ${hasMap}\n`,
  );

  if (Array.isArray(obj.secrets) && obj.secrets.length > 0) {
    const fieldCounts: Record<string, number> = {};
    for (const s of obj.secrets) {
      if (s === null || typeof s !== "object") continue;
      for (const k of Object.keys(s as Record<string, unknown>)) {
        fieldCounts[k] = (fieldCounts[k] ?? 0) + 1;
      }
    }
    const fieldSummary = Object.entries(fieldCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    process.stderr.write(`  secret fields seen: ${fieldSummary}\n`);
  }
}

async function main(): Promise<number> {
  const file = vaultPath();
  process.stderr.write(`vault path: ${file}\n\n`);

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
    logStage("read-file", "ok", `${raw.length} bytes`);
  } catch (err) {
    logStage("read-file", "fail", (err as Error).message);
    return 1;
  }

  let envelope: ReturnType<typeof parseBlob>;
  try {
    envelope = parseBlob(raw.trim());
    logStage(
      "parse-envelope",
      "ok",
      `salt=${envelope.salt.length}B nonce=${envelope.nonce.length}B ` +
        `ciphertext=${envelope.ciphertext.length}B tag=${envelope.tag.length}B`,
    );
  } catch (err) {
    logStage("parse-envelope", "fail", (err as Error).message);
    return 1;
  }

  // Blank line separates the envelope diagnostics from the interactive
  // password prompt so the output is easier to read in a terminal.
  process.stderr.write("\n");
  let password: string;
  try {
    password = await readPasswordFromTty();
  } catch (err) {
    process.stderr.write(`could not read password: ${(err as Error).message}\n`);
    return 1;
  }
  if (password.length === 0) {
    process.stderr.write("empty password, aborting\n");
    return 1;
  }
  process.stderr.write("\n");

  let key: Buffer;
  try {
    key = await deriveKey(password, envelope.salt);
    logStage("derive-key", "ok", `${key.length} bytes`);
  } catch (err) {
    logStage("derive-key", "fail", (err as Error).message);
    return 1;
  }

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
    logStage("decrypt", "ok", `${plaintext.length} bytes of JSON`);
  } catch (err) {
    logStage("decrypt", "fail", `${(err as Error).message} (probably wrong password)`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
    logStage("parse-json", "ok");
  } catch (err) {
    logStage("parse-json", "fail", (err as Error).message);
    return 1;
  }

  summarise(parsed);

  let migrated: unknown;
  try {
    migrated = migrateToLatest(parsed);
    logStage("migrate", "ok");
  } catch (err) {
    if (err instanceof VaultError) {
      logStage("migrate", "fail", `VaultError[${err.code}]: ${err.message}`);
    } else {
      logStage("migrate", "fail", (err as Error).message);
    }
    return 1;
  }

  const result = VaultDataV4Schema.safeParse(migrated);
  if (!result.success) {
    logStage("schema-validate", "fail", "see issues below");
    process.stderr.write("\nZod issues:\n");
    for (const issue of result.error.issues) {
      process.stderr.write(
        `  - path=${JSON.stringify(issue.path)} code=${issue.code} message=${issue.message}\n`,
      );
    }
    return 1;
  }

  logStage("schema-validate", "ok");
  process.stderr.write(
    `\nvault loads cleanly. version=${result.data.version} ` +
      `repos=${result.data.repos.length} secrets=${result.data.secrets.length}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(2);
  },
);
