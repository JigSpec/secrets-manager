/**
 * Integration round-trip test for lib/import/vault-drop.ts (Issue #32).
 *
 * Encrypts a vault with the real saveVault-level primitives, reads back the
 * envelope string, decrypts it via decryptDroppedVault, and then verifies
 * that merging the result with itself produces all noOps.
 *
 * This test is intentionally RED until lib/import/vault-drop.ts is implemented.
 */
import { describe, it, expect } from "vitest";

import {
  decryptDroppedVault,
  previewVaultMerge,
} from "@/lib/import/vault-drop";
import {
  deriveKey,
  encryptVault,
  generateSalt,
  serializeBlob,
} from "@/lib/vault/crypto";
import type { VaultData } from "@/lib/vault/schema";

describe("decryptDroppedVault — round-trip integration", () => {
  it(
    "round-trips: encrypts a vault, reads its content, decrypts it via decryptDroppedVault, " +
    "and preview shows all secrets as noOps when merged with itself",
    async () => {
      const TEST_PASSWORD = "integration-test-password-42";

      // Build a vault with a few secrets.
      const vault: VaultData = {
        version: 2,
        repos: [],
        secrets: [
          {
            id: "ns-API_KEY",
            key: "API_KEY",
            value: "sk-live-abc123",
            namespace: "myns",
            scopes: [],
          },
          {
            id: "ns-DB_PASSWORD",
            key: "DB_PASSWORD",
            value: "supersecret",
            namespace: "myns",
            scopes: [],
          },
          {
            id: "default-WEBHOOK_SECRET",
            key: "WEBHOOK_SECRET",
            value: "whsec_xyz",
            namespace: undefined,
            scopes: [],
          },
        ],
      };

      // Encrypt the vault using the same primitives as saveVault, but return
      // the envelope string directly instead of writing a file.
      const salt = generateSalt();
      const key = await deriveKey(TEST_PASSWORD, salt);
      const plaintext = JSON.stringify(vault);
      const { nonce, ciphertext, tag } = encryptVault(plaintext, key);
      const envelopeContent = serializeBlob(salt, nonce, ciphertext, tag);

      // Decrypt via the module under test.
      const decrypted = await decryptDroppedVault(envelopeContent, TEST_PASSWORD);

      // The decrypted vault must have the same number of secrets.
      expect(decrypted.secrets).toHaveLength(vault.secrets.length);

      // Merge the decrypted vault with itself — every secret is identical,
      // so the preview must classify them all as noOps.
      const preview = previewVaultMerge(decrypted, decrypted);

      expect(preview.noOps).toHaveLength(vault.secrets.length);
      expect(preview.toAdd).toHaveLength(0);
      expect(preview.conflicts).toHaveLength(0);
      expect(decrypted.secrets[2].namespace).toBeUndefined();
    },
  );
});
