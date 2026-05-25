/**
 * tests/import/dotenvx-reserved-key.test.ts
 *
 * RED tests for issue #114 (OROBOROUS) — the import engine must skip keys
 * matching DOTENV_PUBLIC_KEY_* and DOTENV_PRIVATE_KEY_* rather than adding
 * them to the vault. Storing these dotenvx-internal headers bricks future
 * deploys because deployToScope overwrites them with encrypted blobs.
 *
 * ALL new tests in this file are expected to FAIL until lib/import/import.ts
 * is updated to call isDotenvxReservedKey and skip reserved keys.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runImport } from "@/lib/import/import";
import type { VaultDataV4 } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "sm-import-dotenvx-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Write a .env.<env> file in tmpDir and return its directory (repoPath)
 * so that runImport can locate it via readEnvFile.
 */
async function makeEnvFile(env: string, content: string): Promise<string> {
  await writeFile(path.join(tmpDir, `.env.${env}`), content, "utf8");
  return tmpDir;
}

function makeEmptyVault(): VaultDataV4 {
  return {
    version: 4,
    repos: [
      {
        id: "r1",
        name: "myapp",
        path: tmpDir,
        environments: ["production", "development"],
      },
    ],
    secrets: [],
    envVariantMap: { global: {}, repos: {} },
  };
}

// ---------------------------------------------------------------------------
// Tests — RED until lib/import/import.ts skips dotenvx-reserved keys
// ---------------------------------------------------------------------------

describe("runImport — dotenvx reserved-key filtering (issue #114 OROBOROUS)", () => {
  /**
   * Test 10: A .env file containing DOTENV_PUBLIC_KEY_PRODUCTION=03abc123
   * and DATABASE_URL=postgres://real must:
   *   - skip DOTENV_PUBLIC_KEY_PRODUCTION (reserved; must NOT be added to vault)
   *   - include DATABASE_URL (normal key)
   */
  it("skips DOTENV_PUBLIC_KEY_PRODUCTION and keeps DATABASE_URL", async () => {
    const repoPath = await makeEnvFile(
      "production",
      [
        "DOTENV_PUBLIC_KEY_PRODUCTION=03abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
        "DATABASE_URL=postgres://real",
      ].join("\n"),
    );

    const data = makeEmptyVault();
    const result = await runImport({
      data,
      repoPath,
      repoId: "r1",
      repoName: "myapp",
      env: "production",
      onConflict: "skip",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const actions = result.plan.actions;

    // DATABASE_URL must appear as a new-secret action.
    const dbAction = actions.find((a) => a.key === "DATABASE_URL");
    expect(dbAction).toBeDefined();
    expect(dbAction?.type).toBe("new-secret");

    // DOTENV_PUBLIC_KEY_PRODUCTION must NOT appear as a new-secret.
    // It must either be absent from the actions array entirely,
    // or present with type "skipped" (with reason "dotenvx-reserved" or similar).
    const pubKeyAction = actions.find(
      (a) => a.key === "DOTENV_PUBLIC_KEY_PRODUCTION",
    );
    if (pubKeyAction !== undefined) {
      // If the engine records a "skipped" action for the key, that is also
      // acceptable — the important invariant is that it is NOT added to the vault.
      expect(pubKeyAction.type).toBe("skipped");
      expect((pubKeyAction as { reason?: string }).reason).toMatch(/dotenvx|reserved/i);
    }
    // The vault must not contain a secret with this key.
    // (dryRun=true so `result.next` is absent, but that's fine — we just need
    // to assert that no new-secret action was emitted for the reserved key.)
    const newSecretActions = actions.filter((a) => a.type === "new-secret");
    const reservedNewSecret = newSecretActions.find(
      (a) => a.key === "DOTENV_PUBLIC_KEY_PRODUCTION",
    );
    expect(reservedNewSecret).toBeUndefined();
  });

  /**
   * Test 11: A .env file containing only DOTENV_PRIVATE_KEY_PRODUCTION=<hex>
   * must result in zero new-secret actions — the reserved key is silently
   * skipped and does NOT end up in the vault.
   */
  it("skips DOTENV_PRIVATE_KEY_PRODUCTION entirely (no new-secret action)", async () => {
    const repoPath = await makeEnvFile(
      "production",
      "DOTENV_PRIVATE_KEY_PRODUCTION=aabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabb\n",
    );

    const data = makeEmptyVault();
    const result = await runImport({
      data,
      repoPath,
      repoId: "r1",
      repoName: "myapp",
      env: "production",
      onConflict: "skip",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newSecretActions = result.plan.actions.filter(
      (a) => a.type === "new-secret",
    );
    // No secret must have been created for the private key.
    const reservedAction = newSecretActions.find(
      (a) => a.key === "DOTENV_PRIVATE_KEY_PRODUCTION",
    );
    expect(reservedAction).toBeUndefined();

    // Total new-secret actions must be zero (the only entry was the reserved key).
    expect(newSecretActions).toHaveLength(0);
  });

  /**
   * Regression guard: a plain API_SECRET must still be imported normally.
   */
  it("still imports regular keys like API_SECRET without regression", async () => {
    const repoPath = await makeEnvFile(
      "development",
      "API_SECRET=sk_live_not_a_dotenvx_key_AAAAAA\n",
    );

    const data = makeEmptyVault();
    const result = await runImport({
      data,
      repoPath,
      repoId: "r1",
      repoName: "myapp",
      env: "development",
      onConflict: "skip",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newSecretActions = result.plan.actions.filter(
      (a) => a.type === "new-secret",
    );
    const apiSecretAction = newSecretActions.find((a) => a.key === "API_SECRET");
    expect(apiSecretAction).toBeDefined();
    expect(apiSecretAction?.type).toBe("new-secret");
  });

  /**
   * Mixed .env file: multiple dotenvx reserved keys alongside legitimate secrets.
   * All reserved keys must be skipped; all legitimate secrets must be imported.
   */
  it("skips multiple dotenvx reserved keys in one .env file, imports the rest", async () => {
    const repoPath = await makeEnvFile(
      "production",
      [
        "DOTENV_PUBLIC_KEY_PRODUCTION=03abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
        "DOTENV_PRIVATE_KEY_PRODUCTION=aabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabb",
        "STRIPE_SECRET_KEY=sk_live_AAAAAAAAAAAAAAAAAAAAAAAA",
        "DATABASE_URL=postgres://real",
      ].join("\n"),
    );

    const data = makeEmptyVault();
    const result = await runImport({
      data,
      repoPath,
      repoId: "r1",
      repoName: "myapp",
      env: "production",
      onConflict: "skip",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newSecretActions = result.plan.actions.filter(
      (a) => a.type === "new-secret",
    );

    // Both legitimate keys must be imported.
    const stripeAction = newSecretActions.find((a) => a.key === "STRIPE_SECRET_KEY");
    expect(stripeAction).toBeDefined();
    const dbAction = newSecretActions.find((a) => a.key === "DATABASE_URL");
    expect(dbAction).toBeDefined();

    // Neither reserved key must appear as a new-secret.
    const pubKeyNewSecret = newSecretActions.find(
      (a) => a.key === "DOTENV_PUBLIC_KEY_PRODUCTION",
    );
    expect(pubKeyNewSecret).toBeUndefined();
    const privKeyNewSecret = newSecretActions.find(
      (a) => a.key === "DOTENV_PRIVATE_KEY_PRODUCTION",
    );
    expect(privKeyNewSecret).toBeUndefined();

    // Exactly 2 new-secret actions (STRIPE_SECRET_KEY and DATABASE_URL).
    expect(newSecretActions).toHaveLength(2);
  });
});
