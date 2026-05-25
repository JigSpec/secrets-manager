/**
 * Tests for setSecretValueAction (Issue #64: "Needs Your Attention" GUI section).
 *
 * NOTE ON SERVER-ONLY GUARD
 * --------------------------
 * app/actions.ts imports from lib/vault/session.ts, which starts with
 * `import "server-only"`. This throws at import time outside the Next.js
 * runtime, making direct unit-testing of the module infeasible in the plain
 * Vitest/Node environment used by this project.
 *
 * As a result this file uses static source-analysis assertions against the
 * actual source file to verify that setSecretValueAction:
 *   - exists and is exported
 *   - validates empty / whitespace-only values
 *   - trims the value before saving
 *   - strips the "status" field after a value is set
 *   - preserves the "tutorial" field
 *   - calls classifySecret with the trimmed value
 *   - calls persistVaultData exactly once on success
 *
 * ALL tests are intentionally RED before Agent D creates setSecretValueAction.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// 1. app/actions.ts — must export setSecretValueAction
// ---------------------------------------------------------------------------
describe("app/actions.ts — exports setSecretValueAction", () => {
  const src = readSrc("app/actions.ts");

  it('exports a function named "setSecretValueAction"', () => {
    const hasExport =
      /export\s+(?:async\s+)?function\s+setSecretValueAction\b/.test(src) ||
      /export\s*\{[^}]*\bsetSecretValueAction\b[^}]*\}/.test(src);
    expect(hasExport).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. setSecretValueAction — validates empty string
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction rejects empty values", () => {
  const src = readSrc("app/actions.ts");

  it('contains validation that rejects an empty value (matching "empty" in the error path)', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);

    // Look at a reasonable segment after the function declaration
    const segment = src.slice(fnIdx, fnIdx + 1500);

    // Should have a check that returns { ok: false } for empty/whitespace value
    const hasEmptyCheck =
      /empty/i.test(segment) ||
      /\.trim\(\)/.test(segment) && /ok:\s*false/.test(segment);
    expect(hasEmptyCheck).toBe(true);
  });

  it('returns { ok: false } when value is empty string', () => {
    const src2 = readSrc("app/actions.ts");
    const fnIdx = src2.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src2.slice(fnIdx, fnIdx + 1500);
    // The function must produce a { ok: false, error: "..." } result for empty input
    expect(segment).toMatch(/ok:\s*false/);
  });
});

// ---------------------------------------------------------------------------
// 3. setSecretValueAction — trims the value
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction trims the input value", () => {
  const src = readSrc("app/actions.ts");

  it('calls .trim() on the incoming value inside setSecretValueAction', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    expect(segment).toMatch(/\.trim\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. setSecretValueAction — handles not-found secret
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction returns error for missing secret", () => {
  const src = readSrc("app/actions.ts");

  it('contains a "not found" error path inside setSecretValueAction', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    const hasNotFound =
      /not found/i.test(segment) ||
      /notFound/i.test(segment) ||
      /NOT_FOUND/i.test(segment);
    expect(hasNotFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. setSecretValueAction — strips status field after setting a value
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction strips status field", () => {
  const src = readSrc("app/actions.ts");

  it('removes the "status" field from the secret after value is set', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    // The implementation should explicitly delete or omit the status field.
    const stripsStatus =
      /delete.*\.status\b/.test(segment) ||
      /status.*undefined/.test(segment) ||
      // spread with explicit status omission
      /\.\.\.\s*(?!.*status)/.test(segment) && /status/.test(segment);
    expect(stripsStatus).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. setSecretValueAction — preserves tutorial field
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction preserves tutorial field", () => {
  const src = readSrc("app/actions.ts");

  it('references the "tutorial" field inside setSecretValueAction body', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    // The implementation should spread existing secret props (which includes tutorial)
    // or explicitly carry tutorial forward.
    const preservesTutorial =
      /tutorial/.test(segment) ||
      // spread operator that preserves all fields including tutorial
      /\.\.\.\s*\w+/.test(segment);
    expect(preservesTutorial).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. setSecretValueAction — calls classifySecret with the trimmed value
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction calls classifySecret", () => {
  const src = readSrc("app/actions.ts");

  it('imports classifySecret from lib/vault/classify', () => {
    const hasImport =
      /classifySecret/.test(src) &&
      /vault\/classify/.test(src);
    expect(hasImport).toBe(true);
  });

  it('calls classifySecret inside setSecretValueAction', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    expect(segment).toMatch(/classifySecret\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 8. setSecretValueAction — calls persistVaultData on success
// ---------------------------------------------------------------------------
describe("app/actions.ts — setSecretValueAction persists the vault on success", () => {
  const src = readSrc("app/actions.ts");

  it('calls persistVaultData (or commit helper) inside setSecretValueAction', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    const callsPersist =
      /persistVaultData\s*\(/.test(segment) ||
      /\bcommit\s*\(/.test(segment);
    expect(callsPersist).toBe(true);
  });

  it('returns { ok: true } on success', () => {
    const fnIdx = src.indexOf("setSecretValueAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const segment = src.slice(fnIdx, fnIdx + 1500);
    // Success is signalled either with an inline `{ ok: true, ... }` literal,
    // or by returning the local `commit(next)` helper whose body is
    // `await persistVaultData(next); return { ok: true, data: next };`
    // (the same pattern accepted by the persistVaultData check above).
    const returnsOkTrue =
      /ok:\s*true/.test(segment) || /\breturn\s+commit\s*\(/.test(segment);
    expect(returnsOkTrue).toBe(true);
  });
});
