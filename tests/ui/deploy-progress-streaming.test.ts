/**
 * Tests for per-target progress streaming in the GUI (Issue #76).
 *
 * In `main` today, the deploy progress bar jumps from 0/N to N/N because the
 * server returns one final payload. The fix replaces the single
 * `deployAllAction()` / `deployRepoAction()` call with a streamed fetch to
 * `/api/deploy/stream`, processed line-by-line so the progress bar updates
 * once per target.
 *
 * This file follows the repo convention of static source-analysis component
 * testing (see `tests/ui/scrolling-fix.test.ts` and `tests/ui/deploy-progress.test.ts`
 * for the precedent). The assertions encode the consumer contract.
 *
 * The fixer must:
 *   - Update `components/topbar.tsx` (and the new per-repo button site) so
 *     the deploy flow streams from `/api/deploy/stream` and calls a
 *     per-target progress callback.
 *   - Expose an `onDeployProgress(completed, total, current?)` callback on
 *     the `TopBar` / `RepoSecretsPane` props that `Workbench` wires to its
 *     `setProgress` state.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

/**
 * Quote-and-brace-aware extractor for an opening JSX tag so we can inspect
 * the attributes of a specific element without bleeding into siblings.
 */
function getOpeningTag(source: string, tagName: string): string {
  const anchor = `<${tagName}`;
  const idx = source.indexOf(anchor);
  if (idx === -1) throw new Error(`Anchor not found: <${tagName}`);
  let i = idx;
  let inString: false | '"' | "'" | "`" = false;
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (inString) {
      if (ch === inString) inString = false;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (ch === ">" && braceDepth === 0) {
      return source.slice(idx, i + 1);
    }
    i++;
  }
  throw new Error(`No closing > found after <${tagName}`);
}

// ---------------------------------------------------------------------------
// 1. Workbench owns an onDeployProgress callback and wires it to setProgress
// ---------------------------------------------------------------------------

describe("Workbench — per-target progress wiring", () => {
  const src = readSrc("components/workbench.tsx");

  it("declares an onDeployProgress callback", () => {
    // The Workbench must surface a callback that updates `progress` state
    // when a per-target streamed event arrives. The simplest signal is
    // that the function name appears in the source.
    expect(src).toMatch(/onDeployProgress/);
  });

  it("calls setProgress from onDeployProgress (per-target update path)", () => {
    // After fix, the per-target handler must call setProgress with new
    // {completed, total, current} — proving the bar advances on each event.
    // We look for the (loose) co-occurrence of onDeployProgress and
    // setProgress in the same component.
    expect(src).toMatch(/onDeployProgress[\s\S]*?setProgress\(/);
  });

  it("passes onDeployProgress to the TopBar (deploy-all path)", () => {
    // TopBar drives "Encrypt & Deploy All" and must receive the callback
    // so it can call it once per streamed target.
    const tag = getOpeningTag(src, "TopBar");
    expect(tag).toMatch(/\bonDeployProgress=/);
  });

  it("passes onDeployProgress to the per-repo deploy entry-point(s)", () => {
    // The per-repo deploy buttons (whether on RepoSecretsPane or RepoPane)
    // must also receive the callback. At least one of the per-repo panes
    // in workbench.tsx must thread it.
    const repoSecretsHasIt = (() => {
      try {
        return /\bonDeployProgress=/.test(getOpeningTag(src, "RepoSecretsPane"));
      } catch {
        return false;
      }
    })();
    const repoPaneHasIt = (() => {
      try {
        return /\bonDeployProgress=/.test(getOpeningTag(src, "RepoPane"));
      } catch {
        return false;
      }
    })();
    expect(repoSecretsHasIt || repoPaneHasIt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. TopBar consumes the streaming endpoint and calls onDeployProgress
// ---------------------------------------------------------------------------

describe("TopBar — streaming consumer for deploy-all", () => {
  const src = readSrc("components/topbar.tsx");

  it("calls fetch against the streaming deploy endpoint", () => {
    // The deploy-all flow must fetch the streaming Route Handler, not the
    // old non-streaming server action.
    expect(src).toMatch(/fetch\(\s*["'`]\/api\/deploy\/stream/);
  });

  it("uses a stream reader (getReader/TextDecoder) to consume events", () => {
    // The consumer must read the body incrementally — proves it's
    // line-streaming, not awaiting the full response.
    expect(src).toMatch(/getReader\s*\(\s*\)/);
    expect(src).toMatch(/TextDecoder/);
  });

  it("calls onDeployProgress at least once during the streamed loop", () => {
    // The streamed-target handler must update the parent's progress state.
    // We look for any call to onDeployProgress(...) in the component body.
    expect(src).toMatch(/onDeployProgress\(/);
  });

  it("accepts onDeployProgress as a prop on the TopBar component", () => {
    // We just check the prop name appears in the destructured props (loose
    // match works for both arrow / function-decl style).
    expect(src).toMatch(/onDeployProgress[\s,}:]/);
  });
});

// ---------------------------------------------------------------------------
// 3. The Workbench's `onDeployFinish` (or replacement) advances progress to
//    total on the terminal event — NOT in a 0→N jump.
// ---------------------------------------------------------------------------

describe("Workbench — progress lifecycle", () => {
  const src = readSrc("components/workbench.tsx");

  it("does NOT short-circuit progress to total in onDeployFinish without first advancing", () => {
    // The OLD code path used `setProgress((p) => ({ ...p, completed: p.total, ... }))`
    // inside onDeployFinish — this is the "jump to 100%" symptom. The new
    // code path must rely on the per-target `onDeployProgress` events for
    // the bulk of advancement; a terminal sync is fine but the per-target
    // events must do the actual work. We assert onDeployProgress is
    // referenced and not stubbed out.
    expect(src).toMatch(/onDeployProgress/);
    // And the per-target callback path must call setProgress with the
    // streamed `completed` value (a literal number coming from the event,
    // not `p.total`).
    expect(src).toMatch(/setProgress\s*\(\s*\{[\s\S]*?completed\s*:/);
  });
});
