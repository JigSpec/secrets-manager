/**
 * Tests for Issue #101: DeploySheet must render a specific error message
 * when `deployError` is non-null instead of silently showing
 * "Nothing to deploy yet".
 *
 * Fix: add `deployError: string | null` prop to DeploySheet; render a
 * vault-lock specific (or generic) error message when it is set.
 *
 * Test plan:
 *   TC-1: DeploySheet source exports a `deployError` prop in its props type
 *         signature. FAILS before fix (prop does not exist).
 *   TC-2: DeploySheet source renders a `data-testid="deploy-error-message"`
 *         element. FAILS before fix (element not present).
 *   TC-3: DeploySheet source renders vault-session-expired / vault-lock text
 *         when deployError is present. FAILS before fix.
 *   TC-4: DeploySheet source does NOT unconditionally render
 *         "Nothing to deploy" when results is empty — it must first check
 *         deployError. FAILS before fix (currently goes straight to the
 *         "Nothing to deploy" branch for empty results).
 *   TC-5 (regression guard — PASSES before and after fix): "Nothing to deploy"
 *         text still exists in the source so the empty/no-error case still works.
 *
 * NOTE: These tests are intentional source-scan structural regression guards.
 * DeploySheet is a "use client" React component that requires a full DOM +
 * React runtime to render, and the repo has no @testing-library/react setup.
 * Source scanning is the established pattern in this test suite for verifying
 * component structural changes (see issue-98-undeployed-changes-indicator.test.ts).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const deploySheetSrc = readSrc("components/deploy-sheet.tsx");

// ---------------------------------------------------------------------------
// GROUP 1 — DeploySheet props interface includes deployError
// ---------------------------------------------------------------------------

describe("deploy-sheet.tsx — deployError prop (Issue #101)", () => {
  it("TC-1: props signature includes 'deployError' parameter (FAILS before fix)", () => {
    // After the fix the component must accept a `deployError` prop.
    // The current file has no such prop — this test FAILS before the fix.
    const hasDeployErrorProp =
      /deployError\s*:/.test(deploySheetSrc) ||
      /deployError\?\s*:/.test(deploySheetSrc);
    expect(
      hasDeployErrorProp,
      'Expected deploy-sheet.tsx to declare a "deployError" prop in its props ' +
        "type/interface. The prop does not exist yet — add it as part of the " +
        "Issue #101 fix.",
    ).toBe(true);
  });

  it("TC-2: renders data-testid='deploy-error-message' element (FAILS before fix)", () => {
    // After the fix, the component must render an element with this testid
    // when deployError is set, so callers and e2e tests can assert on it.
    const hasTestId = /deploy-error-message/.test(deploySheetSrc);
    expect(
      hasTestId,
      'Expected deploy-sheet.tsx to contain data-testid="deploy-error-message" ' +
        "on the error message element. This element does not exist yet — add it " +
        "as part of the Issue #101 fix.",
    ).toBe(true);
  });

  it("TC-3: renders vault-lock / vault-session-expired text when deployError is set (FAILS before fix)", () => {
    // The fix must render a human-readable vault-lock explanation when
    // deployError contains a vault-lock message. We look for any of the
    // canonical phrases the fix might use.
    const hasVaultLockText =
      /vault.*session.*expired/i.test(deploySheetSrc) ||
      /vault.*locked/i.test(deploySheetSrc) ||
      /session.*expired/i.test(deploySheetSrc) ||
      /unlock.*vault/i.test(deploySheetSrc);
    expect(
      hasVaultLockText,
      'Expected deploy-sheet.tsx to include a vault-lock specific message ' +
        '(e.g. "vault session has expired", "vault is locked", "unlock the vault"). ' +
        "This text does not exist yet — add it as part of the Issue #101 fix.",
    ).toBe(true);
  });

  it("TC-4: deployError branch appears BEFORE the 'Nothing to deploy' branch (FAILS before fix)", () => {
    // After the fix, the component must check deployError before falling
    // through to the empty-results branch. We check that 'deploy-error-message'
    // appears before 'Nothing to deploy' in the source.
    const errorIdx = deploySheetSrc.indexOf("deploy-error-message");
    const nothingIdx = deploySheetSrc.indexOf("Nothing to deploy");

    // Both must be present for the ordering check to be meaningful.
    expect(
      errorIdx,
      'deploy-error-message testid must be present in deploy-sheet.tsx',
    ).toBeGreaterThan(-1);

    expect(
      nothingIdx,
      '"Nothing to deploy" text must still be present in deploy-sheet.tsx',
    ).toBeGreaterThan(-1);

    expect(
      errorIdx,
      'The deploy-error-message element must appear BEFORE the "Nothing to deploy" ' +
        'branch in the source. This ensures deployError is checked first when results=[].'
    ).toBeLessThan(nothingIdx);
  });

  it("TC-5 (regression guard — PASSES before and after fix): 'Nothing to deploy' text still present", () => {
    // The fix must not remove the existing empty-results message — it just
    // must be guarded so it only shows when deployError is null.
    const hasNothingToDeploy = /Nothing to deploy/.test(deploySheetSrc);
    expect(
      hasNothingToDeploy,
      'Expected deploy-sheet.tsx to still contain "Nothing to deploy" text. ' +
        "Do not remove this fallback — only guard it behind deployError === null.",
    ).toBe(true);
  });
});
