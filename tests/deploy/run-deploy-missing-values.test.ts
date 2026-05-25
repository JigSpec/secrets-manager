/**
 * Tests for Issue #101: `runDeploy` / `computeTargetResult` must reject
 * secrets with empty or sentinel placeholder values (e.g. a user has 14
 * "awaiting" secrets that have `value: ""` or `value: "PLACEHOLDER"` but
 * do NOT have `status: "awaiting_value"` set).
 *
 * Bug: `secretsForCell` only filters out secrets with `status === "awaiting_value"`.
 * It does NOT filter secrets whose `value` is empty or a sentinel string.
 * `computeTargetResult` then silently writes those sentinel/blank strings
 * into the `.env` file.
 *
 * Fix: add a `MISSING_SECRET_VALUES` check in `computeTargetResult` that
 * detects any scoped secret with an empty or sentinel value and returns a
 * failure result before calling `deployToScope`.
 *
 * Test plan:
 *   TC-1: A secret with `value: ""` (empty, no status) causes the target
 *         result to be `{ ok: false, code: "MISSING_SECRET_VALUES" }`.
 *         FAILS before fix (currently produces a success/dry-run result).
 *   TC-2: A secret with a sentinel value like `"PLACEHOLDER"` causes the
 *         same failure. FAILS before fix.
 *   TC-3: A secret with `value: "<SET_ME>"` (angle-bracket sentinel) causes
 *         the same failure. FAILS before fix.
 *   TC-4: A secret with `value: "TODO"` causes the same failure.
 *         FAILS before fix.
 *   TC-5 (regression guard — PASSES before and after fix): A secret with
 *         a real, non-empty, non-sentinel value still succeeds in dryRun mode.
 *   TC-6 (regression guard — PASSES before and after fix): A secret with
 *         `status: "awaiting_value"` is still excluded by `secretsForCell`,
 *         so the target with zero real scoped secrets succeeds with 0 keys
 *         (existing behaviour, not regressed).
 *
 * NOTE: All tests run with `dryRun: true` so they never hit disk or require
 * a real dotenvx-ops binary. This matches the pattern in
 * `tests/deploy/run-deploy-on-target.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { runDeploy } from "@/lib/vault/deploy/run-deploy";
import type { VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeVaultWithValue(value: string, status?: "awaiting_value"): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "r-test",
        name: "test-repo",
        path: "/tmp/sm-test-missing-values",
        environments: ["test"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value,
        ...(status ? { status } : {}),
        scopes: [{ repoId: "r-test", env: "test" }],
      },
    ],
  };
}

function makeVaultWithTwoSecrets(value1: string, value2: string): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "r-test",
        name: "test-repo",
        path: "/tmp/sm-test-missing-values",
        environments: ["test"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value: value1,
        scopes: [{ repoId: "r-test", env: "test" }],
      },
      {
        id: "s2",
        key: "DB_URL",
        value: value2,
        scopes: [{ repoId: "r-test", env: "test" }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDeploy — MISSING_SECRET_VALUES check (Issue #101)", () => {
  it("TC-1: secret with empty value causes MISSING_SECRET_VALUES failure (FAILS before fix)", async () => {
    // A secret with no status but an empty string value must NOT be silently
    // written to disk. After the fix, computeTargetResult must detect this
    // and return { ok: false, code: "MISSING_SECRET_VALUES" }.
    const data = makeVaultWithValue("");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_SECRET_VALUES");
    }
  });

  it("TC-2: secret with 'PLACEHOLDER' sentinel value causes MISSING_SECRET_VALUES failure (FAILS before fix)", async () => {
    const data = makeVaultWithValue("PLACEHOLDER");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_SECRET_VALUES");
    }
  });

  it("TC-3: secret with '<SET_ME>' angle-bracket sentinel causes MISSING_SECRET_VALUES failure (FAILS before fix)", async () => {
    const data = makeVaultWithValue("<SET_ME>");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_SECRET_VALUES");
    }
  });

  it("TC-4: secret with 'TODO' sentinel causes MISSING_SECRET_VALUES failure (FAILS before fix)", async () => {
    const data = makeVaultWithValue("TODO");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_SECRET_VALUES");
    }
  });

  it("TC-5 (regression guard — PASSES before and after fix): real value succeeds in dryRun", async () => {
    // A properly-valued secret must still succeed (baseline regression guard).
    const data = makeVaultWithValue("sk-real-value-abc123");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(true);
  });

  it("TC-6 (regression guard — PASSES before and after fix): awaiting_value secret is excluded, target still succeeds with 0 keys", async () => {
    // Secrets with status: 'awaiting_value' are already excluded by
    // secretsForCell. If that's the ONLY secret for a target, the scoped
    // set is empty and the result should succeed with 0 owned keys.
    // This existing behaviour must not regress.
    const data = makeVaultWithValue("", "awaiting_value");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    // With awaiting_value filtering the scoped set is empty — no keys to write.
    // In dryRun mode this is a success with ownedKeyCount=0.
    expect(r.ok).toBe(true);
    // skipped is `never` on PerTargetSuccess, so this assertion confirms the
    // result is a full PerTargetSuccess (not PerTargetSkipped) with 0 keys.
    expect((r as import("@/lib/vault/deploy/run-deploy").PerTargetSuccess).ownedKeyCount).toBe(0);
  });

  it("TC-7: one empty-value secret among two causes failure (FAILS before fix)", async () => {
    // Even a single empty-value secret in a target cell must trigger the check.
    const data = makeVaultWithTwoSecrets("real-value-123", "");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_SECRET_VALUES");
    }
  });

  it("TC-8: whitespace-only value causes MISSING_SECRET_VALUES failure (FAILS before fix)", async () => {
    // A value that is purely whitespace (e.g. "   ") should be treated the
    // same as empty — it would write a blank line into the .env file.
    const data = makeVaultWithValue("   ");
    const results = await runDeploy({ data, dryRun: true });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MISSING_SECRET_VALUES");
    }
  });
});
