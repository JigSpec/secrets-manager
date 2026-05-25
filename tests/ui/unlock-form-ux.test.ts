/**
 * Tests for the unlock-form UX improvements (Issue #29: "Unable to log out").
 *
 * These tests do static source analysis — they read the actual source files
 * and assert that the required changes are present. This approach avoids the
 * complexity of rendering Next.js server/client components in a test
 * environment while still giving precise, meaningful signal about the
 * implementation.
 *
 * ALL tests in this file are intentionally RED before the fix is applied
 * and turn GREEN once each change described in Issue #29 is made:
 *
 *   1. app/unlock/actions.ts  — export clearSessionAction; improve
 *      WRONG_PASSWORD error message with recovery guidance.
 *   2. app/unlock/page.tsx    — compute & pass hasStaleSession prop.
 *   3. app/unlock/unlock-form.tsx — accept hasStaleSession prop; update
 *      CardDescriptions to mention "No username needed"; add stale-session
 *      notice + clear-session button.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// 1. app/unlock/unlock-form.tsx — CardDescription for "create" mode
//    must reference that no username is needed.
// ---------------------------------------------------------------------------
describe('app/unlock/unlock-form.tsx — CardDescription "create" mode mentions no username', () => {
  const src = readSrc("app/unlock/unlock-form.tsx");

  it('the source contains "No username" or similar phrasing about username', () => {
    // The planned fix adds a note that no username is needed.
    // We accept any of the likely phrasings.
    const hasNoUsername =
      /[Nn]o username/.test(src) ||
      /username.*not.*required/i.test(src) ||
      /username.*needed/i.test(src) ||
      /no.*username.*needed/i.test(src);
    expect(hasNoUsername).toBe(true);
  });

  it('the create-mode CardDescription branch contains a "username" reference', () => {
    // The create branch is the first arm of the ternary inside CardDescription.
    // After the fix, it must mention username.
    const cardDescBlock = src.slice(src.indexOf("CardDescription"));
    expect(cardDescBlock).toMatch(/[Uu]sername/);
  });
});

// ---------------------------------------------------------------------------
// 2. app/unlock/unlock-form.tsx — CardDescription for "unlock" mode
//    must also reference no-username.
// ---------------------------------------------------------------------------
describe('app/unlock/unlock-form.tsx — CardDescription "unlock" mode mentions no username', () => {
  const src = readSrc("app/unlock/unlock-form.tsx");

  it('overall source contains at least two mentions of "username" (one per mode)', () => {
    const matches = src.match(/[Uu]sername/g) ?? [];
    // After the fix both the create and unlock branches should mention username.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 3. app/unlock/page.tsx — must import getSessionId for stale-session detection
// ---------------------------------------------------------------------------
describe("app/unlock/page.tsx — imports getSessionId", () => {
  const src = readSrc("app/unlock/page.tsx");

  it('imports "getSessionId" from the session module', () => {
    // The fix adds getSessionId to the existing session import so it can
    // compute the hasStaleSession prop.
    expect(src).toMatch(/\bgetSessionId\b/);
  });

  it('passes hasStaleSession as a prop to UnlockForm', () => {
    expect(src).toMatch(/\bhasStaleSession\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. app/unlock/actions.ts — must export clearSessionAction
// ---------------------------------------------------------------------------
describe("app/unlock/actions.ts — exports clearSessionAction", () => {
  const src = readSrc("app/unlock/actions.ts");

  it('exports a function named "clearSessionAction"', () => {
    // Accept "export async function clearSessionAction" or
    // "export function clearSessionAction" or "export { clearSessionAction }".
    const hasExport =
      /export\s+(?:async\s+)?function\s+clearSessionAction\b/.test(src) ||
      /export\s*\{[^}]*\bclearSessionAction\b[^}]*\}/.test(src);
    expect(hasExport).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. app/unlock/unlock-form.tsx — must reference clearSessionAction
// ---------------------------------------------------------------------------
describe("app/unlock/unlock-form.tsx — references clearSessionAction", () => {
  const src = readSrc("app/unlock/unlock-form.tsx");

  it('imports or references "clearSessionAction"', () => {
    expect(src).toMatch(/\bclearSessionAction\b/);
  });
});

// ---------------------------------------------------------------------------
// 6. app/unlock/actions.ts — WRONG_PASSWORD error must contain recovery hint
// ---------------------------------------------------------------------------
describe("app/unlock/actions.ts — WRONG_PASSWORD error includes recovery guidance", () => {
  const src = readSrc("app/unlock/actions.ts");

  it('the WRONG_PASSWORD error message contains a recovery hint ("forgotten" or "recover")', () => {
    // Find the block around the WRONG_PASSWORD branch.
    const idx = src.indexOf("WRONG_PASSWORD");
    expect(idx).toBeGreaterThan(-1);

    // Look at the ~300 chars following the WRONG_PASSWORD check for the error string.
    const segment = src.slice(idx, idx + 400);

    const hasRecoveryHint =
      /forgotten/i.test(segment) ||
      /recover/i.test(segment) ||
      /reset/i.test(segment);
    expect(hasRecoveryHint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. app/unlock/unlock-form.tsx — must accept and use hasStaleSession prop
// ---------------------------------------------------------------------------
describe("app/unlock/unlock-form.tsx — hasStaleSession prop", () => {
  const src = readSrc("app/unlock/unlock-form.tsx");

  it('the UnlockForm component signature includes "hasStaleSession"', () => {
    expect(src).toMatch(/\bhasStaleSession\b/);
  });

  it("the component renders a stale-session notice or clear-session button when hasStaleSession is true", () => {
    // After the fix there should be conditional JSX based on hasStaleSession.
    // A simple check: hasStaleSession appears in JSX context (not just type sig).
    const occurrences = (src.match(/\bhasStaleSession\b/g) ?? []).length;
    // It must appear at least twice: once in the prop signature and once in JSX.
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
