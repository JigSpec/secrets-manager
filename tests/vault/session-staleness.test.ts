/**
 * Tests for getVaultData() staleness fix (Issue #91, Step 3).
 *
 * ROOT CAUSE: lib/vault/session.ts caches VaultData in-memory. When the
 * daemon writes the vault to disk, the Next.js session never picks up the new
 * data — getVaultData() returns the stale cached copy.
 *
 * FIX (not yet implemented): getVaultData() must reload vault data from disk
 * on every call (or at least detect that the on-disk file has changed) so that
 * daemon writes are visible immediately.
 *
 * NOTE ON SERVER-ONLY GUARD
 * --------------------------
 * lib/vault/session.ts starts with `import "server-only"`, which throws at
 * import time outside the Next.js runtime. Direct unit-testing of the module
 * is infeasible in the plain Vitest/Node environment used by this project.
 *
 * This file therefore uses static source-analysis to assert the expected
 * structural changes: getVaultData() must call loadVault() on every invocation
 * so it returns fresh data from disk rather than the stale in-memory entry.
 *
 * Also tests that app/actions.ts commit() calls in updateRepoAction and
 * deleteRepoAction use `{ ...data, repos, secrets }` (spread) instead of
 * `{ version: 2, repos, secrets }` (hardcoded) to preserve vault version
 * metadata.
 *
 * These tests are intentionally RED until Agent D implements the fix.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// lib/vault/session.ts — getVaultData() must reload from disk on every call
// ---------------------------------------------------------------------------
describe("lib/vault/session.ts — getVaultData reloads from disk (no stale cache)", () => {
  const src = readSrc("lib/vault/session.ts");

  it("getVaultData calls loadVault on every invocation (not just returning cached entry.data)", () => {
    // After the fix, getVaultData must call loadVault() to pick up daemon writes.
    // Currently it just does `return entry ? entry.data : null` (stale cache).
    // Find getVaultData function body and verify it calls loadVault.
    const fnIdx = src.indexOf("getVaultData");
    expect(fnIdx).toBeGreaterThan(-1);

    // Extract the function body (up to 600 chars after the function signature)
    const segment = src.slice(fnIdx, fnIdx + 600);

    // The fixed implementation must call loadVault (to reload from disk) —
    // not just return the cached entry.data.
    const callsLoadVault = /loadVault\s*\(/.test(segment);
    expect(callsLoadVault).toBe(true);
  });

  it("getVaultData does not simply return entry.data from the in-memory sessions map", () => {
    // The current (broken) implementation is:
    //   const entry = sessions.get(id);
    //   return entry ? entry.data : null;
    // After the fix, getVaultData must not short-circuit by returning the
    // cached data without reloading from disk.
    const fnIdx = src.indexOf("async function getVaultData");
    expect(fnIdx).toBeGreaterThan(-1);

    // Look at the function body only (up to the next export function).
    const afterFn = src.indexOf("export async function", fnIdx + 1);
    const segment = src.slice(
      fnIdx,
      afterFn > fnIdx ? afterFn : fnIdx + 600,
    );

    // Must NOT contain the bare `entry.data` return that indicates a cache hit.
    // The fixed version will call loadVault() and use its result.
    const returnsEntryDataDirectly = /return\s+entry\s*\?\s*entry\.data/.test(segment);
    expect(returnsEntryDataDirectly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// app/actions.ts — updateRepoAction must preserve vault metadata via spread
// ---------------------------------------------------------------------------
describe("app/actions.ts — updateRepoAction preserves vault version via spread", () => {
  const src = readSrc("app/actions.ts");

  it('updateRepoAction uses { ...data, repos, secrets } (not hardcoded version: 2)', () => {
    const fnIdx = src.indexOf("updateRepoAction");
    expect(fnIdx).toBeGreaterThan(-1);

    // Find the commit() call inside updateRepoAction.
    // Look within the function body (up to 2000 chars is plenty).
    const segment = src.slice(fnIdx, fnIdx + 2000);

    // The broken version has: commit({ version: 2, repos, secrets })
    // The fixed version must have: commit({ ...data, repos, secrets })
    const hasHardcodedVersion2 = /commit\s*\(\s*\{\s*version\s*:\s*2\s*,\s*repos\s*,\s*secrets/.test(segment);
    expect(hasHardcodedVersion2).toBe(false);
  });

  it('updateRepoAction commit call spreads data (preserves envVariantMap and version)', () => {
    const fnIdx = src.indexOf("updateRepoAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 2000);

    // Must have a spread of the existing data object.
    const spreadsData = /commit\s*\(\s*\{\s*\.\.\.\s*data\s*,/.test(segment);
    expect(spreadsData).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// app/actions.ts — deleteRepoAction must preserve vault metadata via spread
// ---------------------------------------------------------------------------
describe("app/actions.ts — deleteRepoAction preserves vault version via spread", () => {
  const src = readSrc("app/actions.ts");

  it('deleteRepoAction uses { ...data, repos, secrets } (not hardcoded version: 2)', () => {
    const fnIdx = src.indexOf("deleteRepoAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1000);

    const hasHardcodedVersion2 = /commit\s*\(\s*\{\s*version\s*:\s*2\s*,\s*repos\s*,\s*secrets/.test(segment);
    expect(hasHardcodedVersion2).toBe(false);
  });

  it('deleteRepoAction commit call spreads data (preserves envVariantMap and version)', () => {
    const fnIdx = src.indexOf("deleteRepoAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1000);

    const spreadsData = /commit\s*\(\s*\{\s*\.\.\.\s*data\s*,/.test(segment);
    expect(spreadsData).toBe(true);
  });
});
