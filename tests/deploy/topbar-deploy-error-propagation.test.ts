/**
 * Tests for Issue #101: topbar.tsx must pass a second `error` argument to
 * `onDeployFinish` on all error paths so the parent can distinguish
 * "genuinely no scoped secrets" from "deploy failed with vault-lock error".
 *
 * Fix: extend `onDeployFinish(results, error?)` signature and pass the
 * error string in the three failure paths:
 *   1. `!res.ok` (HTTP error response, e.g. vault locked → 401)
 *   2. `inbandError` (NDJSON `kind:"error"` frame from the server)
 *   3. `finalResults === null` (stream ended without a done frame)
 *
 * Test plan:
 *   TC-1: onDeployFinish signature in topbar.tsx accepts a second optional
 *         `error` parameter. FAILS before fix.
 *   TC-2: The `!res.ok` error path calls `onDeployFinish([], <errorString>)`.
 *         FAILS before fix (currently calls `onDeployFinish([])`).
 *   TC-3: The `inbandError` path calls `onDeployFinish([], <errorString>)`.
 *         FAILS before fix.
 *   TC-4: The `finalResults === null` path calls `onDeployFinish([], <errorString>)`.
 *         FAILS before fix.
 *   TC-5 (regression guard — PASSES before and after fix): The success path
 *         calls `onDeployFinish` with only the results array (no second arg,
 *         or explicit null/undefined second arg).
 *
 * NOTE: Source-scan approach follows the pattern established for Issue #98.
 * topbar.tsx is a "use client" component requiring DOM + React to render;
 * source scanning is the right level of abstraction for structural contract
 * checks of this kind.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const topbarSrc = readSrc("components/topbar.tsx");

// ---------------------------------------------------------------------------
// GROUP 1 — onDeployFinish signature
// ---------------------------------------------------------------------------

describe("topbar.tsx — onDeployFinish error propagation (Issue #101)", () => {
  it("TC-1: onDeployFinish prop type includes a second error parameter (FAILS before fix)", () => {
    // After the fix the prop type must include an optional error parameter:
    //   onDeployFinish: (results: DeployTargetResult[], error?: string | null) => void
    // Currently it is: onDeployFinish: (results: DeployTargetResult[]) => void
    const hasErrorParam =
      /onDeployFinish\s*:\s*\([^)]*error/.test(topbarSrc) ||
      /onDeployFinish\s*:\s*\([^)]*,\s*error/.test(topbarSrc);
    expect(
      hasErrorParam,
      'Expected topbar.tsx onDeployFinish prop type to include a second "error" ' +
        "parameter (e.g. `(results: DeployTargetResult[], error?: string | null) => void`). " +
        "The current signature only takes `results`. Update it as part of the Issue #101 fix.",
    ).toBe(true);
  });

  it("TC-2: !res.ok path calls onDeployFinish with a non-empty error string (FAILS before fix)", () => {
    // In the current code the !res.ok block ends with:
    //   onDeployFinish([]);
    // After the fix it must pass the error message as the second argument:
    //   onDeployFinish([], errorMessage)  or  onDeployFinish([], someVar)
    //
    // Strategy: find the `!res.ok` block and verify that `onDeployFinish`
    // is not called with a bare `[]` as its only argument on that code path.
    //
    // We look for the pattern where onDeployFinish is called with TWO args
    // (i.e. a comma after the first `[]`) anywhere in the res.ok guard block.
    // Since the block is contiguous, we look for the combination:
    //   - the !res.ok condition
    //   - followed by onDeployFinish([], <anything>)
    const resBadPathHasError =
      /!res\.ok[\s\S]{0,400}?onDeployFinish\s*\(\s*\[\s*\]\s*,/.test(topbarSrc);
    expect(
      resBadPathHasError,
      'Expected topbar.tsx to call onDeployFinish with a second error argument on the ' +
        '`!res.ok` path (e.g. `onDeployFinish([], errorMessage)`). ' +
        'Currently it calls `onDeployFinish([])` with no error. Fix: pass the error string.',
    ).toBe(true);
  });

  it("TC-3: inbandError path calls onDeployFinish with the error string (FAILS before fix)", () => {
    // Current code:
    //   if (inbandError) { toast.error(inbandError); onDeployFinish([]); return; }
    // After the fix:
    //   onDeployFinish([], inbandError);
    const inbandPathHasError =
      /inbandError[\s\S]{0,300}?onDeployFinish\s*\(\s*\[\s*\]\s*,/.test(topbarSrc);
    expect(
      inbandPathHasError,
      'Expected topbar.tsx to call onDeployFinish([], inbandError) on the in-band error path. ' +
        'Currently it calls onDeployFinish([]) with no second argument. ' +
        'Fix: pass inbandError as the second argument.',
    ).toBe(true);
  });

  it("TC-4: finalResults===null path calls onDeployFinish with an error string (FAILS before fix)", () => {
    // Current code:
    //   if (finalResults === null) { toast.error(...); onDeployFinish([]); return; }
    // After the fix:
    //   onDeployFinish([], "Deploy stream ended without a done event.")
    //   (or similar non-null string)
    const finalResultsNullPathHasError =
      /finalResults\s*===\s*null[\s\S]{0,300}?onDeployFinish\s*\(\s*\[\s*\]\s*,/.test(topbarSrc);
    expect(
      finalResultsNullPathHasError,
      'Expected topbar.tsx to call onDeployFinish([], <errorString>) on the ' +
        '`finalResults === null` path. Currently it calls onDeployFinish([]) with no error. ' +
        'Fix: pass the error string as the second argument.',
    ).toBe(true);
  });

  it("TC-5 (regression guard — PASSES before and after fix): success path still calls onDeployFinish with results", () => {
    // The success path must still forward all results to the parent.
    // We look for `onDeployFinish(results)` or `onDeployFinish(results,` (with undefined/null error)
    // anywhere in the success flow — the key is it is NOT an error path.
    const hasSuccessCall =
      /onDeployFinish\s*\(\s*results/.test(topbarSrc) ||
      /onDeployFinish\s*\(\s*finalResults/.test(topbarSrc);
    expect(
      hasSuccessCall,
      'Expected topbar.tsx to still call onDeployFinish(results) on the success path. ' +
        'Ensure the happy path still forwards the results array to the parent.',
    ).toBe(true);
  });
});
