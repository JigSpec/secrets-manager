/**
 * Tests for the deploy progress UI (Issue #71).
 *
 * These are static source-analysis tests in the style of
 * tests/ui/scrolling-fix.test.ts — they assert that the deploy-sheet component
 * exposes the progress contract (props, JSX shape) and that the dialog blocks
 * close-affordances while deploying.
 *
 * Static analysis is the right tool here: the alternative is rendering Next.js
 * client components inside vitest, which the rest of this repo deliberately
 * avoids (see scrolling-fix.test.ts for the precedent).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 1. DeploySheet exposes a `progress` prop and renders a determinate <progress>
// ---------------------------------------------------------------------------

describe("DeploySheet — progress bar contract", () => {
  const src = readSrc("components/deploy-sheet.tsx");

  it("DeploySheet props include a `progress` field with `completed` and `total`", () => {
    // The component signature must include progress: { completed, total, current? }
    // We check for the literal type-shape pieces in the prop list.
    expect(src).toMatch(/progress\s*:/);
    expect(src).toMatch(/completed\s*:\s*number/);
    expect(src).toMatch(/total\s*:\s*number/);
  });

  it("renders a determinate <progress> element when deploying", () => {
    // A native <progress value={...} max={...}> is the simplest a11y-correct
    // determinate progress affordance. Required while deploying.
    expect(src).toMatch(/<progress\b/);
    expect(src).toMatch(/\bvalue=\{/);
    expect(src).toMatch(/\bmax=\{/);
  });

  it("includes an aria-label or aria-labelledby on the progress element", () => {
    // Accessibility: screen readers need to announce progress.
    // Either inline aria-label or label-via-id.
    const hasAriaLabel =
      /<progress\b[^>]*\baria-label=/.test(src) ||
      /<progress\b[^>]*\baria-labelledby=/.test(src);
    expect(hasAriaLabel).toBe(true);
  });

  it("renders a `data-testid=\"deploy-progress\"` anchor for tests", () => {
    expect(src).toMatch(/data-testid="deploy-progress"/);
  });

  it("renders a `current` target hint string near the bar when provided", () => {
    // e.g. "Deploying alpha / live (3 of 7)…"
    // We assert the source references `progress.current` so the UI can show
    // the live target string when the parent supplies it.
    expect(src).toMatch(/progress\.current/);
  });
});

// ---------------------------------------------------------------------------
// 2. DeploySheet blocks Esc + outside-click + ✕ while deploying
// ---------------------------------------------------------------------------

describe("DeploySheet — non-dismissible while deploying", () => {
  const src = readSrc("components/deploy-sheet.tsx");

  it("DialogContent guards onEscapeKeyDown while deploying", () => {
    // Radix Dialog: passing a handler to onEscapeKeyDown that calls
    // e.preventDefault() blocks Esc-to-close. The source must wire this
    // guard against the `deploying` flag.
    expect(src).toMatch(/onEscapeKeyDown/);
  });

  it("DialogContent guards onPointerDownOutside while deploying", () => {
    // Likewise for click-outside.
    expect(src).toMatch(/onPointerDownOutside/);
  });

  it("the guard references the `deploying` prop", () => {
    // The handler must be conditional on `deploying` — we just check that
    // both names co-occur in the file (the simplest signal that one gates
    // the other).
    expect(src).toMatch(/deploying/);
  });

  it("the close (✕) button is hidden while deploying", () => {
    // The DialogPrimitive.Close baked into our DialogContent renders a ✕.
    // While deploying we either render DialogContent without the X (custom
    // content), or apply `hideClose` / equivalent. We require some signal
    // that the close affordance is suppressed — `hideClose` is the prop the
    // updated dialog primitive must accept.
    expect(src).toMatch(/hideClose/);
  });
});

// ---------------------------------------------------------------------------
// 3. The Dialog primitive supports a `hideClose` opt-out
// ---------------------------------------------------------------------------

describe("components/ui/dialog.tsx — hideClose prop", () => {
  const src = readSrc("components/ui/dialog.tsx");

  it("DialogContent accepts a hideClose prop", () => {
    // The prop must appear in the destructuring of DialogContent props.
    expect(src).toMatch(/hideClose/);
  });

  it("the ✕ Close primitive is conditionally rendered on !hideClose", () => {
    // We expect a guard such as `{!hideClose && <DialogPrimitive.Close ...>}`
    // around the X button.
    expect(src).toMatch(/!hideClose/);
  });
});
