/**
 * Tests for lib/import/vault-drop.ts (Issue #32 — drag-and-drop encrypted vault files).
 *
 * ALL tests in this file are intentionally RED: the implementation module
 * lib/import/vault-drop.ts does not exist yet. These tests define the
 * expected public API and behaviour so that the implementor can make them
 * green without guessing at the contract.
 */
import { describe, expect, it } from "vitest";

import {
  applyVaultMerge,
  decryptDroppedVault,
  previewVaultMerge,
} from "@/lib/import/vault-drop";
import type { VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_VAULT: VaultData = {
  version: 2,
  repos: [],
  secrets: [],
};

function makeVault(secrets: VaultData["secrets"] = []): VaultData {
  return { version: 2, repos: [], secrets };
}

function makeSecret(
  key: string,
  value: string,
  namespace?: string,
): VaultData["secrets"][number] {
  return {
    id: `${namespace ?? "default"}-${key}`,
    key,
    value,
    namespace,
    scopes: [],
  };
}

// ---------------------------------------------------------------------------
// describe("decryptDroppedVault")
// ---------------------------------------------------------------------------

describe("decryptDroppedVault", () => {
  it("throws an error on wrong password", async () => {
    // Build a real encrypted envelope with one password, then try a different one.
    // We use the crypto primitives directly so this test is self-contained.
    const { generateSalt, deriveKey, encryptVault, serializeBlob } = await import(
      "@/lib/vault/crypto"
    );
    const payload: VaultData = makeVault([
      makeSecret("API_KEY", "secret-value"),
    ]);
    const salt = generateSalt();
    const key = await deriveKey("correct-password", salt);
    const { nonce, ciphertext, tag } = encryptVault(
      JSON.stringify(payload),
      key,
    );
    const envelope = serializeBlob(salt, nonce, ciphertext, tag);

    await expect(
      decryptDroppedVault(envelope, "wrong-password"),
    ).rejects.toThrow();
  });

  it("throws an error on malformed/corrupted envelope", async () => {
    const corrupted = "not-a-valid-envelope-at-all";
    await expect(
      decryptDroppedVault(corrupted, "any-password"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// describe("previewVaultMerge")
// ---------------------------------------------------------------------------

describe("previewVaultMerge", () => {
  it("returns empty arrays when incoming vault is empty", () => {
    const current = makeVault([makeSecret("DB_URL", "postgres://localhost")]);
    const preview = previewVaultMerge(current, EMPTY_VAULT);

    expect(preview.toAdd).toEqual([]);
    expect(preview.noOps).toEqual([]);
    expect(preview.conflicts).toEqual([]);
  });

  it("classifies new (non-existing) secrets as toAdd", () => {
    const current = EMPTY_VAULT;
    const incoming = makeVault([
      makeSecret("NEW_KEY", "new-value", "myns"),
    ]);

    const preview = previewVaultMerge(current, incoming);

    expect(preview.toAdd).toHaveLength(1);
    expect(preview.toAdd[0].key).toBe("NEW_KEY");
    expect(preview.noOps).toHaveLength(0);
    expect(preview.conflicts).toHaveLength(0);
  });

  it("classifies identical secrets (same key+namespace+value) as noOps", () => {
    const secret = makeSecret("DB_PASSWORD", "hunter2", "app");
    const current = makeVault([secret]);
    const incoming = makeVault([{ ...secret }]);

    const preview = previewVaultMerge(current, incoming);

    expect(preview.noOps).toHaveLength(1);
    expect(preview.noOps[0].key).toBe("DB_PASSWORD");
    expect(preview.toAdd).toHaveLength(0);
    expect(preview.conflicts).toHaveLength(0);
  });

  it("classifies same key+namespace but different value secrets as conflicts", () => {
    const current = makeVault([makeSecret("API_KEY", "old-value", "svc")]);
    const incoming = makeVault([makeSecret("API_KEY", "new-value", "svc")]);

    const preview = previewVaultMerge(current, incoming);

    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0].key).toBe("API_KEY");
    expect(preview.toAdd).toHaveLength(0);
    expect(preview.noOps).toHaveLength(0);
  });

  it("treats [ns1]KEY and [ns2]KEY as separate secrets (both toAdd)", () => {
    const current = makeVault([
      makeSecret("SHARED_KEY", "value-ns1", "ns1"),
    ]);
    const incoming = makeVault([
      makeSecret("SHARED_KEY", "value-ns2", "ns2"),
    ]);

    const preview = previewVaultMerge(current, incoming);

    // ns2/SHARED_KEY doesn't exist in current → toAdd, not a conflict
    expect(preview.toAdd).toHaveLength(1);
    expect(preview.toAdd[0].namespace).toBe("ns2");
    expect(preview.conflicts).toHaveLength(0);
    expect(preview.noOps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe("applyVaultMerge — overwrite policy")
// ---------------------------------------------------------------------------

describe("applyVaultMerge — overwrite policy", () => {
  it("adds toAdd secrets to the resulting vault", () => {
    const current = EMPTY_VAULT;
    const incoming = makeVault([makeSecret("BRAND_NEW", "value")]);

    const result = applyVaultMerge(current, incoming, "overwrite");

    const keys = result.vault.secrets.map((s) => s.key);
    expect(keys).toContain("BRAND_NEW");
    expect(result.added).toBe(1);
    expect(result.overwritten).toBe(0);
  });

  it("overwrites conflicting secret values", () => {
    const current = makeVault([makeSecret("API_KEY", "old", "app")]);
    const incoming = makeVault([makeSecret("API_KEY", "new", "app")]);

    const result = applyVaultMerge(current, incoming, "overwrite");

    const secret = result.vault.secrets.find(
      (s) => s.key === "API_KEY" && s.namespace === "app",
    );
    expect(secret?.value).toBe("new");
    expect(result.overwritten).toBe(1);
    expect(result.added).toBe(0);
  });

  it("skips noOps without duplicating them", () => {
    const secret = makeSecret("SAME_KEY", "same-value", "ns");
    const current = makeVault([secret]);
    const incoming = makeVault([{ ...secret }]);

    const result = applyVaultMerge(current, incoming, "overwrite");

    const matches = result.vault.secrets.filter(
      (s) => s.key === "SAME_KEY" && s.namespace === "ns",
    );
    expect(matches).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
    expect(result.overwritten).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe("applyVaultMerge — skip policy")
// ---------------------------------------------------------------------------

describe("applyVaultMerge — skip policy", () => {
  it("adds toAdd secrets", () => {
    const current = EMPTY_VAULT;
    const incoming = makeVault([makeSecret("FRESH", "value")]);

    const result = applyVaultMerge(current, incoming, "skip");

    expect(result.vault.secrets.map((s) => s.key)).toContain("FRESH");
    expect(result.added).toBe(1);
  });

  it("leaves conflicting secrets at current value", () => {
    const current = makeVault([makeSecret("TOKEN", "current-value", "api")]);
    const incoming = makeVault([makeSecret("TOKEN", "incoming-value", "api")]);

    const result = applyVaultMerge(current, incoming, "skip");

    const secret = result.vault.secrets.find(
      (s) => s.key === "TOKEN" && s.namespace === "api",
    );
    expect(secret?.value).toBe("current-value");
    expect(result.overwritten).toBe(0);
  });

  it("returned counts (added, overwritten, skipped) are correct", () => {
    const current = makeVault([
      makeSecret("CONFLICT_KEY", "old", "ns"),
      makeSecret("SAME_KEY", "same", "ns"),
    ]);
    const incoming = makeVault([
      makeSecret("NEW_KEY", "val", "ns"),       // toAdd
      makeSecret("CONFLICT_KEY", "new", "ns"),  // conflict — skipped under skip policy
      makeSecret("SAME_KEY", "same", "ns"),     // noOp
    ]);

    const result = applyVaultMerge(current, incoming, "skip");

    expect(result.added).toBe(1);       // NEW_KEY
    expect(result.overwritten).toBe(0); // skip policy — no overwrites
    expect(result.skipped).toBe(2);    // CONFLICT_KEY (skipped) + SAME_KEY (noOp)
  });
});
