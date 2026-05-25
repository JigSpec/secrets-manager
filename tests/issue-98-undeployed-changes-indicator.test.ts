/**
 * Tests for Issue #98: "unsaved changes" indicator never turns off and has a
 * misleading label.
 *
 * Fix involves two source-level changes:
 *   1. components/topbar.tsx  — rename "unsaved changes" → "undeployed changes"
 *   2. components/workbench.tsx — onDeployFinish:
 *        a. remove `results.length > 0 &&` guard
 *        b. use functional updater `setLastDeployedRevision((r) => ...)` to
 *           read live revision instead of closing over a stale value
 *        c. drop `revision` from the useCallback dep array
 *
 * Test groups:
 *   Group 1 — source scan: topbar label text
 *   Group 2 — source scan: workbench.tsx onDeployFinish logic
 *   Group 3 — pure logic: dirty flag derivation (all PASS before and after fix)
 *   Group 4 — source scan: workbench.tsx isDirty derivation shape (PASS before and after fix)
 *
 * Tests that FAIL before the fix: TC-1.1, TC-1.2, TC-2.1, TC-2.2, TC-2.3
 * Tests that PASS before and after the fix: TC-1.3, TC-1.4, TC-3.*, TC-4.*
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const topbarSrc = readSrc("components/topbar.tsx");
const workbenchSrc = readSrc("components/workbench.tsx");

// ---------------------------------------------------------------------------
// GROUP 1 — Source scan: topbar label text
//
// NOTE: These are intentional structural regression guards. They scan the
// source file as a string to ensure the specific label text required by
// Issue #98 is (or is not) present. This approach is deliberate: the goal
// is to prevent the string from silently regressing back to the old value
// in future edits, which a runtime/render test would not catch as cheaply.
// ---------------------------------------------------------------------------

describe("topbar.tsx — undeployed changes indicator label (Issue #98, Group 1)", () => {
  it("TC-1.1: label text IS 'undeployed changes' (FAILS before fix — currently says 'unsaved changes')", () => {
    // After the fix, the span must say "undeployed changes", not "unsaved changes".
    // This test FAILS before the fix because the file still contains "unsaved changes".
    expect(
      topbarSrc,
      'Expected topbar.tsx to contain "undeployed changes" but it was not found. '
      + 'Rename the indicator label from "unsaved changes" to "undeployed changes".',
    ).toContain("undeployed changes");
  });

  it("TC-1.2: label text is NOT 'unsaved changes' (FAILS before fix — file still has old label)", () => {
    // After the fix the old string must be gone.
    // This test FAILS before the fix because the old label is still present.
    expect(
      topbarSrc.includes("unsaved changes"),
      'topbar.tsx still contains "unsaved changes". '
      + 'The label must be renamed to "undeployed changes" to fix Issue #98.',
    ).toBe(false);
  });

  it("TC-1.3: the amber indicator <span> is still present (regression guard — PASSES before and after fix)", () => {
    // The visual amber dot and label must still exist after the rename.
    // We look for the amber-600 class which wraps the indicator text.
    const hasAmberSpan =
      /text-amber-600/.test(topbarSrc) ||
      /text-amber-[0-9]+/.test(topbarSrc);
    expect(
      hasAmberSpan,
      'Expected topbar.tsx to still contain the amber indicator span (text-amber-600 class). '
      + 'Do not remove the amber indicator — only rename its text.',
    ).toBe(true);
  });

  it("TC-1.4: indicator is still conditional on `dirty && deployTargetCount > 0` (regression guard — PASSES before and after fix)", () => {
    // The indicator must only show when the vault is dirty AND there are targets.
    // We match the combined condition in any form that covers both checks.
    const hasDirtyAndTargetGuard =
      /dirty\s*&&\s*deployTargetCount\s*>\s*0/.test(topbarSrc) ||
      /deployTargetCount\s*>\s*0\s*&&\s*dirty/.test(topbarSrc);
    expect(
      hasDirtyAndTargetGuard,
      'Expected topbar.tsx to conditionally render the indicator with '
      + '"dirty && deployTargetCount > 0". Do not remove this guard.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GROUP 2 — Source scan: workbench.tsx onDeployFinish logic
//
// NOTE: These are intentional structural regression guards. They verify that
// specific anti-patterns identified in Issue #98 are absent from the source
// and that the correct patterns are present. Source scanning is used here
// because the bugs (stale closure, nested setState, spurious dep) are
// static structural issues that cannot be reliably detected at runtime
// without significant component harness overhead.
// ---------------------------------------------------------------------------

describe("workbench.tsx — onDeployFinish logic (Issue #98, Group 2)", () => {
  it("TC-2.1: onDeployFinish does NOT have `results.length > 0 &&` guard (FAILS before fix)", () => {
    // The bug: if deploy is called with zero targets, results is [], so
    // results.length > 0 is false and lastDeployedRevision is never updated,
    // leaving the indicator stuck. The fix removes this guard so an empty
    // results array (full success with nothing to deploy) still clears the flag.
    const hasLengthGuard = /results\.length\s*>\s*0\s*&&/.test(workbenchSrc);
    expect(
      hasLengthGuard,
      'workbench.tsx still contains "results.length > 0 &&" guard in onDeployFinish. '
      + 'Remove the guard so that an empty deploy result still clears the dirty indicator.',
    ).toBe(false);
  });

  it("TC-2.2: onDeployFinish uses setLastDeployedRevision functional updater to read live revision (FAILS before fix)", () => {
    // The bug: `setLastDeployedRevision(revision)` closes over a stale
    // `revision` value from the last render. The fix uses a functional updater
    // that reads the live revision from the setRevision state:
    //   setLastDeployedRevision((prev) => revision) — but more correctly the
    // fix should pass the live revision in. The canonical fix is to capture
    // revision inside a setRevision functional form so that both updates are
    // batched, OR to use setRevision's callback to pass the up-to-date value.
    //
    // We look for the functional updater form:
    //   setLastDeployedRevision((r) => ...) or setLastDeployedRevision(_ => ...)
    //   or setLastDeployedRevision((prev) => ...)
    // which is the distinguishing shape of the fix.
    const hasFunctionalUpdater =
      /setLastDeployedRevision\s*\(\s*\(/.test(workbenchSrc);
    expect(
      hasFunctionalUpdater,
      'workbench.tsx onDeployFinish should call setLastDeployedRevision with a '
      + 'functional updater (e.g. setLastDeployedRevision((r) => ...)) to read the '
      + 'live revision value and avoid stale closure. Currently it passes the closed-over '
      + '"revision" variable directly.',
    ).toBe(true);
  });

  it("TC-2.3: onDeployFinish useCallback dep array does NOT contain `revision` (FAILS before fix)", () => {
    // The bug: `revision` is listed in the useCallback dep array, causing
    // onDeployFinish to be recreated on every revision change. This means
    // any component holding a reference to the old onDeployFinish (e.g. the
    // TopBar, which is re-rendered infrequently) may call a stale version.
    // The fix removes `revision` from the dep array by using a functional updater.
    //
    // Strategy: find the onDeployFinish useCallback block and check its dep array.
    // We look for the block ending with ], [revision]) which is the current broken form.
    // After the fix the dep array should be [] (empty) or not contain `revision`.
    //
    // We search for the useCallback closing dep array that contains `revision`
    // as a standalone identifier immediately before the closing `]`.
    const hasRevisionInDeps =
      /onDeployFinish\s*=\s*useCallback[\s\S]*?\[\s*revision\s*\]/.test(workbenchSrc) ||
      /setLastDeployedRevision[\s\S]{0,300}?\[\s*revision\s*\]/.test(workbenchSrc);
    expect(
      hasRevisionInDeps,
      'workbench.tsx onDeployFinish useCallback still lists "revision" in its dep array. '
      + 'Remove "revision" from the dep array after switching to a functional updater for '
      + 'setLastDeployedRevision — the functional updater reads the live value so the dep '
      + 'is no longer needed.',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GROUP 3 — Pure logic: dirty flag derivation
// All of these PASS before and after the source fix.
// ---------------------------------------------------------------------------

/**
 * isDirty mirrors the expression in workbench.tsx:
 *   const isDirty = revision > lastDeployedRevision;
 */
function isDirty(revision: number, lastDeployedRevision: number): boolean {
  return revision > lastDeployedRevision;
}

/**
 * shouldClearAfterDeploy models the FIXED onDeployFinish guard:
 *   results.every(r => r.ok)
 *
 * The old (broken) code was: results.length > 0 && results.every(r => r.ok)
 * The fix removes the `results.length > 0` guard, so an empty array (= success
 * with nothing to deploy) correctly returns true and clears the indicator.
 */
function shouldClearAfterDeploy(results: { ok: boolean }[]): boolean {
  return results.every((r) => r.ok);
}

describe("isDirty — pure logic (Issue #98, Group 3, all PASS before and after fix)", () => {
  it("TC-3.1: isDirty(0, 0) === false (initial state — no changes yet)", () => {
    expect(isDirty(0, 0)).toBe(false);
  });

  it("TC-3.2: isDirty(1, 0) === true (after first mutation — not yet deployed)", () => {
    expect(isDirty(1, 0)).toBe(true);
  });

  it("TC-3.3: isDirty(3, 3) === false (after successful deploy — revision matches)", () => {
    expect(isDirty(3, 3)).toBe(false);
  });

  it("TC-3.4: isDirty(4, 3) === true (mutation after deploy — revision ahead again)", () => {
    expect(isDirty(4, 3)).toBe(true);
  });

  it("TC-3.5: isDirty(2, 2) === false (partial deploy that clears — when revision unchanged)", () => {
    expect(isDirty(2, 2)).toBe(false);
  });
});

describe("shouldClearAfterDeploy — pure logic (Issue #98, Group 3, all PASS)", () => {
  it("TC-3.6: shouldClearAfterDeploy([{ok:true},{ok:false}]) === false (partial failure does not clear)", () => {
    expect(shouldClearAfterDeploy([{ ok: true }, { ok: false }])).toBe(false);
  });

  it("TC-3.7: shouldClearAfterDeploy([{ok:true},{ok:true}]) === true (full success clears indicator)", () => {
    expect(shouldClearAfterDeploy([{ ok: true }, { ok: true }])).toBe(true);
  });

  it("TC-3.8: shouldClearAfterDeploy([]) === true (empty results = full success, clears indicator)", () => {
    // Array.prototype.every returns true for an empty array (vacuous truth).
    // The FIXED code uses results.every(r => r.ok) without the length guard,
    // so this correctly returns true. The old broken code (results.length > 0 && ...)
    // would return false here, keeping the indicator stuck.
    expect(shouldClearAfterDeploy([])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GROUP 4 — Source scan: workbench.tsx isDirty derivation shape
// These PASS before and after the fix.
//
// NOTE: These are intentional structural regression guards. They verify that
// the `isDirty` expression and the `dirty` prop wiring remain intact after
// any future refactoring. Source scanning is used because the shape of these
// expressions in the source is what matters for correctness, and it is cheaper
// to assert here than to spin up a full component render environment.
// ---------------------------------------------------------------------------

describe("workbench.tsx — isDirty derivation shape (Issue #98, Group 4, PASS before and after fix)", () => {
  it("TC-4.1: isDirty computed as `revision > lastDeployedRevision`", () => {
    // The workbench derives isDirty by comparing the live revision counter to
    // the last-deployed snapshot. This test guards against accidentally
    // removing or rewriting this expression.
    const hasDirtyExpression =
      /revision\s*>\s*lastDeployedRevision/.test(workbenchSrc);
    expect(
      hasDirtyExpression,
      'workbench.tsx should compute isDirty as "revision > lastDeployedRevision". '
      + 'This expression was not found — ensure the dirty-flag logic is not removed.',
    ).toBe(true);
  });

  it("TC-4.2: `dirty` prop passed as `{isDirty}` to TopBar", () => {
    // The Workbench passes the derived isDirty boolean to TopBar as the `dirty` prop.
    // We accept both `dirty={isDirty}` and `dirty = {isDirty}` forms.
    const hasDirtyProp =
      /dirty\s*=\s*\{isDirty\}/.test(workbenchSrc);
    expect(
      hasDirtyProp,
      'workbench.tsx should pass "dirty={isDirty}" to TopBar. '
      + 'This prop was not found — ensure TopBar still receives the dirty flag.',
    ).toBe(true);
  });
});
