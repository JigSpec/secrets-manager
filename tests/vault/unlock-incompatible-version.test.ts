// Regression: an existing vault that surfaces VaultError codes the unlock
// action's catch ladder does not handle (currently `INCOMPATIBLE_VAULT_VERSION`)
// falls through to the generic "Failed to unlock." message in
// `app/unlock/actions.ts`. The user reported pulling latest main and being
// unable to unlock with no actionable error — this test reproduces the
// underlying VaultError code that the unlock action silently swallows.
//
// Pattern mirrors tests/vault/store.test.ts.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveKey,
  encryptVault,
  generateSalt,
  serializeBlob,
} from "@/lib/vault/crypto";
import { VaultError, loadVault, vaultPath } from "@/lib/vault/store";

const PASSWORD = "right-password";

let activeDir: string | undefined;

async function withTempVault(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-test-unlock-"));
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

/**
 * Write an encrypted vault payload to disk under PASSWORD. The payload is the
 * raw JSON object as it would appear after decryption — bypassing saveVault's
 * VaultDataSchema validation so we can plant pre-migration shapes a previous
 * daemon could plausibly have written.
 */
async function plantAndWriteRaw(payload: unknown): Promise<void> {
  const plaintext = JSON.stringify(payload);
  const salt = generateSalt();
  const key = await deriveKey(PASSWORD, salt);
  const { nonce, ciphertext, tag } = encryptVault(plaintext, key);
  const envelope = serializeBlob(salt, nonce, ciphertext, tag);
  await writeFile(vaultPath(), envelope, { encoding: "utf8", mode: 0o600 });
}

// Mirror of the codes app/unlock/actions.ts maps to specific user-facing
// error messages. Any other VaultError code falls through to the generic
// "Failed to unlock." string. Keep this list in sync with the catch ladder
// in unlockAction (app/unlock/actions.ts). `tests/ui/unlock-error-coverage.test.ts`
// is the structural invariant — this set just mirrors it for the runtime
// assertion below.
const UNLOCK_ACTION_HANDLED_CODES = new Set([
  "WRONG_PASSWORD",
  "CORRUPTED",
  "INVALID_DATA",
  "NOT_FOUND",
  "INCOMPATIBLE_VAULT_VERSION",
]);

describe("loadVault → unlock action: every VaultError code must be handled", () => {
  it("vault with version > 4 (e.g. v5 written by a newer build or a teammate's vault sync) surfaces a VaultError code that unlockAction handles", async () => {
    // Simulate a vault that another machine (or a future build) wrote with
    // version > 4. Possible real-world origin: the user temporarily ran a
    // forward-incompatible build on this machine (e.g. switched branches
    // for a 1-minute experiment), or synced a vault.enc from a teammate on
    // a newer release. The exact pre-conditions are not the point; the
    // user-visible failure mode is that VaultError(INCOMPATIBLE_VAULT_VERSION)
    // leaks through unlockAction as the generic "Failed to unlock." string,
    // which gives the user no actionable signal about what went wrong.
    await plantAndWriteRaw({
      version: 5,
      repos: [],
      secrets: [],
      envVariantMap: { global: {}, repos: {} },
    });

    let caught: unknown;
    try {
      await loadVault(PASSWORD);
    } catch (e) {
      caught = e;
    }

    // Sanity check: loadVault should reject this as a VaultError.
    expect(caught).toBeInstanceOf(VaultError);

    // The actual assertion: the VaultError code MUST be one of the codes the
    // unlock action's catch ladder maps to a specific user-facing message.
    // `INCOMPATIBLE_VAULT_VERSION` is now handled — the user receives a
    // tailored message instead of the generic "Failed to unlock." catch-all.
    expect(UNLOCK_ACTION_HANDLED_CODES.has((caught as VaultError).code)).toBe(
      true,
    );
  });
});
