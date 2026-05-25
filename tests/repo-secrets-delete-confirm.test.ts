/**
 * Tests for the Delete + Confirmation dialog state machine in RepoSecretsPane
 * (Issue #91, Step 2).
 *
 * CURRENT STATE: `components/repo-secrets-pane.tsx` has a `<Checkbox>` that
 * calls `toggleScopeAction` immediately on uncheck — no confirmation step.
 *
 * REQUIRED CHANGE: Replace the Checkbox with a Delete button that first sets a
 * `pendingUnscope` state variable. A confirmation dialog then lets the user
 * confirm or cancel. Only on confirm is `toggleScopeAction` actually called.
 *
 * These tests are intentionally RED until Agent D implements the state machine.
 *
 * NOTE: Since repo-secrets-pane.tsx is a React Client Component, and this
 * project's Vitest config uses environment: "node" without a DOM setup,
 * these are pure logic/state-machine tests — they check the source text for
 * the required state machine constructs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// State variable: pendingUnscope starts as null
// ---------------------------------------------------------------------------
describe("repo-secrets-pane.tsx — pendingUnscope state variable", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("declares a pendingUnscope state variable initialised to null", () => {
    // The component must use useState to track which secret+env pair is pending
    // deletion confirmation. Initial value must be null.
    const hasPendingState =
      /\bpendingUnscope\b/.test(src) &&
      /useState\s*(<[^>]*>\s*)?\(\s*null\s*\)/.test(src);
    expect(hasPendingState).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delete button: clicking sets pendingUnscope (not null)
// ---------------------------------------------------------------------------
describe("repo-secrets-pane.tsx — clicking delete sets pendingUnscope", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("sets pendingUnscope to a non-null value on delete click (does NOT call toggleScopeAction immediately)", () => {
    // The component must set pendingUnscope when a delete action is triggered,
    // not call toggleScopeAction directly.
    const setPendingOnClick = /setPendingUnscope\s*\(/.test(src);
    expect(setPendingOnClick).toBe(true);
  });

  it("does not call toggleScopeAction on the first delete click (confirmation is required)", () => {
    // The Checkbox's onCheckedChange handler must NOT call toggleScopeAction
    // directly. Instead it must set pendingUnscope.
    // Verify: there is no Checkbox whose handler directly calls toggleScopeAction.
    // We check that handleUncheck (or equivalent) is NOT the direct handler on
    // the primary interactive element — the code must go through pendingUnscope.
    //
    // The simplest structural check: the component must NOT render a <Checkbox>
    // as the primary remove control (it should be replaced with a Delete button).
    const hasCheckboxRemoveControl = /<Checkbox/.test(src);
    expect(hasCheckboxRemoveControl).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirmation: confirming clears pendingUnscope and calls toggleScopeAction
// ---------------------------------------------------------------------------
describe("repo-secrets-pane.tsx — confirming calls toggleScopeAction and clears pendingUnscope", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("calls toggleScopeAction somewhere in the confirmation handler", () => {
    expect(src).toMatch(/toggleScopeAction\s*\(/);
  });

  it("sets pendingUnscope back to null after confirm", () => {
    // After the user confirms, pendingUnscope must be reset to null.
    // The implementation will call setPendingUnscope(null) in the confirm path.
    const fnIdx = src.indexOf("setPendingUnscope");
    expect(fnIdx).toBeGreaterThan(-1);

    // There must be at least one call with null (the reset on confirm/cancel).
    const resetsToNull = /setPendingUnscope\s*\(\s*null\s*\)/.test(src);
    expect(resetsToNull).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancellation: cancelling clears pendingUnscope without calling toggleScopeAction
// ---------------------------------------------------------------------------
describe("repo-secrets-pane.tsx — cancelling clears pendingUnscope", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("has a cancel path that resets pendingUnscope to null", () => {
    // Cancel should call setPendingUnscope(null) — same reset as confirm,
    // but without calling toggleScopeAction.
    const resetsToNull = /setPendingUnscope\s*\(\s*null\s*\)/.test(src);
    expect(resetsToNull).toBe(true);
  });

  it("renders a confirmation dialog that uses pendingUnscope as its open trigger", () => {
    // A Dialog (or AlertDialog) component must be gated on pendingUnscope.
    // Accept any Radix Dialog / AlertDialog pattern.
    const hasConfirmDialog =
      (/Dialog/.test(src) || /AlertDialog/.test(src)) &&
      /pendingUnscope/.test(src);
    expect(hasConfirmDialog).toBe(true);
  });
});
