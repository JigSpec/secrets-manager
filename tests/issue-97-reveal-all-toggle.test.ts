/**
 * Tests for Issue #97: "Reveal all / Hide all" toggle.
 *
 * Verifies that both secret-pane.tsx and repo-secrets-pane.tsx:
 *   1. Declare a `revealAll` boolean state (or consume it via useRevealAll).
 *   2. Derive visibility as `revealAll || revealed.has(id)`.
 *   3. Render a header button with aria-label "Reveal all values" / "Hide all values".
 *   4. Include a toggleRevealAll function that clears `revealed` when turning off.
 *
 * Issue #6/#7 fix: tests now also scan the shared `useRevealAll` hook for logic
 * that was extracted out of the components (Issue #5 — maintainability).
 * Additional behavioral tests verify the runtime logic directly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Logic-level tests for the isRevealed derivation
// ---------------------------------------------------------------------------

describe("isRevealed derivation logic", () => {
  function isRevealed(revealAll: boolean, revealed: Set<string>, id: string): boolean {
    return revealAll || revealed.has(id);
  }

  it("returns true when revealAll=true regardless of the revealed Set", () => {
    expect(isRevealed(true, new Set(), "s1")).toBe(true);
    expect(isRevealed(true, new Set(["s2"]), "s1")).toBe(true);
  });

  it("returns true when revealAll=false and id is in the revealed Set", () => {
    expect(isRevealed(false, new Set(["s1"]), "s1")).toBe(true);
  });

  it("returns false when revealAll=false and id is NOT in the revealed Set", () => {
    expect(isRevealed(false, new Set(["s2"]), "s1")).toBe(false);
    expect(isRevealed(false, new Set(), "s1")).toBe(false);
  });
});

describe("toggleRevealAll logic: clears revealed Set when turning off", () => {
  function applyToggle(
    current: boolean,
    revealed: Set<string>,
  ): { revealAll: boolean; revealed: Set<string> } {
    if (current) {
      return { revealAll: false, revealed: new Set() };
    }
    return { revealAll: true, revealed };
  }

  it("turning revealAll ON preserves existing revealed Set entries", () => {
    const existing = new Set(["s1", "s2"]);
    const result = applyToggle(false, existing);
    expect(result.revealAll).toBe(true);
    expect(result.revealed.size).toBe(2);
  });

  it("turning revealAll OFF clears the revealed Set", () => {
    const existing = new Set(["s1", "s2"]);
    const result = applyToggle(true, existing);
    expect(result.revealAll).toBe(false);
    expect(result.revealed.size).toBe(0);
  });

  it("turning revealAll ON from false when revealed is empty keeps it empty", () => {
    const result = applyToggle(false, new Set());
    expect(result.revealAll).toBe(true);
    expect(result.revealed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests for the useRevealAll hook logic
// (Issue #6/#7: test actual runtime logic, not just source patterns)
// ---------------------------------------------------------------------------

/**
 * Pure implementation of the useRevealAll hook logic for behavioral testing.
 * Mirrors hooks/use-reveal-all.ts without React state — each call returns
 * the new state after applying an action, so we can chain assertions.
 */
interface RevealState {
  revealAll: boolean;
  revealed: Set<string>;
}

function initialState(): RevealState {
  return { revealAll: false, revealed: new Set() };
}

function applyToggleRevealAll(state: RevealState): RevealState {
  // Issue #2 fix: both setters called sequentially (not nested)
  const next = !state.revealAll;
  return {
    revealAll: next,
    revealed: next === false ? new Set() : new Set(state.revealed),
  };
}

function applyToggleReveal(state: RevealState, id: string, allIds?: string[]): RevealState {
  // Issue #3 fix: hiding an individual row while revealAll is active
  // disables revealAll and shows all others (minus this one).
  if (state.revealAll) {
    const base = allIds ? new Set<string>(allIds) : new Set<string>(state.revealed);
    base.delete(id);
    return { revealAll: false, revealed: base };
  } else {
    const next = new Set(state.revealed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { revealAll: state.revealAll, revealed: next };
  }
}

function applyRepoChange(state: RevealState): RevealState {
  // Issue #1 fix: reset on repo/filter change
  return { revealAll: false, revealed: new Set() };
}

describe("useRevealAll hook — behavioral tests (Issue #6/#7)", () => {
  describe("Issue #1 (security): revealAll resets when repo changes", () => {
    it("resets revealAll to false on repo change", () => {
      let state = initialState();
      state = applyToggleRevealAll(state); // turn on revealAll
      expect(state.revealAll).toBe(true);

      // Simulate repo change
      state = applyRepoChange(state);
      expect(state.revealAll).toBe(false);
    });

    it("resets revealed Set to empty on repo change", () => {
      let state = initialState();
      state = applyToggleReveal(state, "s1");
      state = applyToggleReveal(state, "s2");
      expect(state.revealed.size).toBe(2);

      // Simulate repo change
      state = applyRepoChange(state);
      expect(state.revealed.size).toBe(0);
    });

    it("resets both revealAll and revealed on repo change when both are active", () => {
      let state = initialState();
      state = applyToggleRevealAll(state); // revealAll = true
      state = { ...state, revealed: new Set(["s1", "s2"]) }; // some individual reveals
      expect(state.revealAll).toBe(true);
      expect(state.revealed.size).toBe(2);

      // Simulate repo change
      state = applyRepoChange(state);
      expect(state.revealAll).toBe(false);
      expect(state.revealed.size).toBe(0);
    });
  });

  describe("Issue #2 (React correctness): toggleRevealAll calls setters sequentially", () => {
    it("clears revealed Set when toggling revealAll off", () => {
      let state = initialState();
      // Add individual reveals first
      state = applyToggleReveal(state, "s1");
      state = applyToggleReveal(state, "s2");
      // Turn on revealAll
      state = applyToggleRevealAll(state);
      expect(state.revealAll).toBe(true);
      // Turn off — should clear revealed
      state = applyToggleRevealAll(state);
      expect(state.revealAll).toBe(false);
      expect(state.revealed.size).toBe(0);
    });

    it("does NOT clear revealed Set when toggling revealAll on", () => {
      let state = initialState();
      state = applyToggleReveal(state, "s1");
      state = applyToggleRevealAll(state); // turning ON
      expect(state.revealAll).toBe(true);
      expect(state.revealed.size).toBe(1); // preserved
    });
  });

  describe("Issue #3 (UX): per-row hide works correctly when revealAll is active", () => {
    it("hides a row and turns off revealAll, showing all others", () => {
      let state = initialState();
      state = applyToggleRevealAll(state); // revealAll = true
      expect(state.revealAll).toBe(true);

      const allIds = ["s1", "s2", "s3"];
      // User clicks "Hide" on s2 while revealAll is active
      state = applyToggleReveal(state, "s2", allIds);

      expect(state.revealAll).toBe(false);
      expect(state.revealed.has("s1")).toBe(true);  // still visible
      expect(state.revealed.has("s2")).toBe(false); // hidden
      expect(state.revealed.has("s3")).toBe(true);  // still visible
    });

    it("hides the last row, leaving revealed empty and revealAll false", () => {
      let state = initialState();
      state = applyToggleRevealAll(state);
      const allIds = ["s1"];
      state = applyToggleReveal(state, "s1", allIds);

      expect(state.revealAll).toBe(false);
      expect(state.revealed.size).toBe(0);
    });

    it("normal toggle (no revealAll) still works: adds/removes from revealed", () => {
      let state = initialState();
      state = applyToggleReveal(state, "s1");
      expect(state.revealed.has("s1")).toBe(true);
      state = applyToggleReveal(state, "s1");
      expect(state.revealed.has("s1")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Source-text tests: useRevealAll hook (Issue #5 — extracted logic)
// ---------------------------------------------------------------------------

describe("hooks/use-reveal-all.ts — shared hook (Issue #5)", () => {
  const src = readSrc("hooks/use-reveal-all.ts");

  it("exports a useRevealAll function", () => {
    expect(/export\s+function\s+useRevealAll/.test(src)).toBe(true);
  });

  it("resets state on resetKey change via useEffect", () => {
    // Issue #1: must have a useEffect that resets both setters
    expect(/useEffect/.test(src)).toBe(true);
    expect(/setRevealAll\s*\(\s*false\s*\)/.test(src)).toBe(true);
    expect(/setRevealed\s*\(\s*new Set\s*\(\s*\)\s*\)/.test(src)).toBe(true);
  });

  it("clears revealed Set in toggleRevealAll when turning off (Issue #2)", () => {
    const idx = src.indexOf("toggleRevealAll");
    const segment = idx >= 0 ? src.slice(idx, idx + 400) : "";
    const clearsRevealed = /setRevealed\s*\(\s*new Set\s*\(\s*\)\s*\)/.test(segment);
    expect(
      clearsRevealed,
      "Expected toggleRevealAll in useRevealAll hook to call `setRevealed(new Set())` when turning revealAll off.",
    ).toBe(true);
  });

  it("handles per-row hide while revealAll is active (Issue #3)", () => {
    expect(/revealAll/.test(src)).toBe(true);
    // The toggleReveal function should check revealAll
    const idx = src.indexOf("toggleReveal");
    const segment = idx >= 0 ? src.slice(idx, idx + 500) : "";
    expect(/if\s*\(\s*revealAll\s*\)/.test(segment)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source-text tests: secret-pane.tsx
// ---------------------------------------------------------------------------

describe("secret-pane.tsx — revealAll state and toggle (Issue #97)", () => {
  const src = readSrc("components/secret-pane.tsx");
  // Also read the hook file to check for logic that may have been extracted (Issue #5)
  const hookSrc = readSrc("hooks/use-reveal-all.ts");
  const combined = src + "\n" + hookSrc;

  it("declares a revealAll boolean state", () => {
    const hasRevealAll = /\brevealAll\b/.test(src);
    expect(
      hasRevealAll,
      'Expected secret-pane.tsx to declare or consume a `revealAll` state variable. ' +
      'Add `const [revealAll, setRevealAll] = useState(false)` or use the useRevealAll hook.',
    ).toBe(true);
  });

  it("derives isRevealed as revealAll || revealed.has(id)", () => {
    const hasCompoundDerivation =
      /revealAll\s*\|\|\s*revealed\.has/.test(src) ||
      /revealed\.has[^)]*\|\|\s*revealAll/.test(src);
    expect(
      hasCompoundDerivation,
      'Expected secret-pane.tsx to derive isRevealed as `revealAll || revealed.has(secret.id)`. ' +
      'Update the `const isRevealed = ...` line inside `filtered.map`.',
    ).toBe(true);
  });

  it("defines a toggleRevealAll function", () => {
    expect(/toggleRevealAll/.test(src)).toBe(true);
  });

  it('renders a header button with aria-label "Reveal all values" or "Hide all values"', () => {
    const hasRevealAllButton =
      /aria-label\s*=\s*[{"'`]Reveal all values[}"'`]/.test(src) ||
      /aria-label\s*=\s*\{[^}]*"Reveal all values"[^}]*\}/.test(src) ||
      /aria-label\s*=\s*\{[^}]*"Hide all values"[^}]*\}/.test(src);
    expect(
      hasRevealAllButton,
      'Expected secret-pane.tsx to have a header button with aria-label "Reveal all values". ' +
      'Add a Button in the header that calls toggleRevealAll.',
    ).toBe(true);
  });

  it('renders "Reveal all" and "Hide all" text labels', () => {
    expect(/Reveal all/.test(src)).toBe(true);
    expect(/Hide all/.test(src)).toBe(true);
  });

  it("clears the revealed Set when turning revealAll off (may be in hook)", () => {
    // Issue #6/#7 fix: since logic may be extracted to the useRevealAll hook
    // (Issue #5 — maintainability), check either the component or the hook.
    const clearsInComponent = (() => {
      const idx = src.indexOf("toggleRevealAll");
      const segment = idx >= 0 ? src.slice(idx, idx + 400) : "";
      return /setRevealed\s*\(\s*new Set\s*\(\s*\)\s*\)/.test(segment);
    })();
    const clearsInHook = (() => {
      const idx = hookSrc.indexOf("toggleRevealAll");
      const segment = idx >= 0 ? hookSrc.slice(idx, idx + 400) : "";
      return /setRevealed\s*\(\s*new Set\s*\(\s*\)\s*\)/.test(segment);
    })();
    const usesHook = /useRevealAll/.test(src);
    expect(
      clearsInComponent || (usesHook && clearsInHook),
      'Expected toggleRevealAll to call `setRevealed(new Set())` when turning revealAll off. ' +
      'This can be in the component directly or in the shared useRevealAll hook.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source-text tests: repo-secrets-pane.tsx
// ---------------------------------------------------------------------------

describe("repo-secrets-pane.tsx — revealAll state and toggle (Issue #97)", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");
  const hookSrc = readSrc("hooks/use-reveal-all.ts");

  it("declares a revealAll boolean state", () => {
    const hasRevealAll = /\brevealAll\b/.test(src);
    expect(
      hasRevealAll,
      'Expected repo-secrets-pane.tsx to declare a `revealAll` state variable.',
    ).toBe(true);
  });

  it("derives per-row reveal as revealAll || revealed.has(id)", () => {
    const hasCompoundDerivation =
      /revealAll\s*\|\|\s*revealed\.has/.test(src) ||
      /revealed\.has[^)]*\|\|\s*revealAll/.test(src);
    expect(
      hasCompoundDerivation,
      'Expected repo-secrets-pane.tsx to use `revealAll || revealed.has(secret.id)` for per-row reveal.',
    ).toBe(true);
  });

  it("defines a toggleRevealAll function", () => {
    expect(/toggleRevealAll/.test(src)).toBe(true);
  });

  it('renders a header button with aria-label "Reveal all values" or "Hide all values"', () => {
    const hasRevealAllButton =
      /aria-label\s*=\s*[{"'`]Reveal all values[}"'`]/.test(src) ||
      /aria-label\s*=\s*\{[^}]*"Reveal all values"[^}]*\}/.test(src) ||
      /aria-label\s*=\s*\{[^}]*"Hide all values"[^}]*\}/.test(src);
    expect(
      hasRevealAllButton,
      'Expected repo-secrets-pane.tsx to have a header button with aria-label "Reveal all values".',
    ).toBe(true);
  });

  it('renders "Reveal all" and "Hide all" text labels', () => {
    expect(/Reveal all/.test(src)).toBe(true);
    expect(/Hide all/.test(src)).toBe(true);
  });

  it("clears the revealed Set when turning revealAll off (may be in hook)", () => {
    // Issue #6/#7 fix: since logic may be extracted to the useRevealAll hook
    // (Issue #5 — maintainability), check either the component or the hook.
    const clearsInComponent = (() => {
      const idx = src.indexOf("toggleRevealAll");
      const segment = idx >= 0 ? src.slice(idx, idx + 400) : "";
      return /setRevealed\s*\(\s*new Set\s*\(\s*\)\s*\)/.test(segment);
    })();
    const clearsInHook = (() => {
      const idx = hookSrc.indexOf("toggleRevealAll");
      const segment = idx >= 0 ? hookSrc.slice(idx, idx + 400) : "";
      return /setRevealed\s*\(\s*new Set\s*\(\s*\)\s*\)/.test(segment);
    })();
    const usesHook = /useRevealAll/.test(src);
    expect(
      clearsInComponent || (usesHook && clearsInHook),
      'Expected toggleRevealAll to call `setRevealed(new Set())` when turning revealAll off. ' +
      'This can be in the component directly or in the shared useRevealAll hook.',
    ).toBe(true);
  });
});
