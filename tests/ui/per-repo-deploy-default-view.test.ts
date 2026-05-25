/**
 * Tests for the discoverable per-repo "Deploy" control in the default
 * Secrets view (Issue #76).
 *
 * Today the "Deploy this repo" button only appears inside `RepoSecretsPane`,
 * which is gated behind selecting a repo and switching the third column to
 * `repo-secrets` mode. The user expected the button next to each repo in
 * the always-visible repo list and couldn't find it.
 *
 * After fix: every row in `RepoPane` exposes a per-repo deploy affordance
 * — clicking it triggers deploy for THAT repo without touching other repos.
 *
 * Static source-analysis only, following the repo's component-test
 * convention (see `tests/ui/scrolling-fix.test.ts`, `tests/ui/per-repo-deploy-button.test.ts`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

/**
 * Extract just the opening JSX tag `<Tag ...>` for the named element from
 * the source, so we can inspect its attributes without bleeding into the
 * rest of the file. Quote-aware so `prop="text with >"` doesn't end early.
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
// 1. RepoPane exposes a per-repo deploy control on each repo row.
// ---------------------------------------------------------------------------

describe("components/repo-pane.tsx — discoverable per-repo deploy control", () => {
  const src = readSrc("components/repo-pane.tsx");

  it("imports a Rocket (or equivalent) icon used for the deploy affordance", () => {
    // The shared deploy icon across the codebase is lucide-react's Rocket.
    // Using it here matches the topbar deploy button and the
    // RepoSecretsPane "Deploy this repo" button.
    expect(src).toMatch(/\bRocket\b/);
  });

  it("imports the per-repo deploy action or surfaces a per-repo deploy handler prop", () => {
    // EITHER:
    //   (a) RepoPane directly imports `deployRepoAction` from @/app/actions, OR
    //   (b) RepoPane accepts a per-repo deploy callback prop (e.g.
    //       `onDeployRepo: (repoId: string) => void` threaded from Workbench).
    // Both are acceptable. We test for at least one of these signals.
    const importsAction = /deployRepoAction/.test(src);
    const hasCallbackProp = /onDeployRepo[\s,}:?]/.test(src);
    expect(importsAction || hasCallbackProp).toBe(true);
  });

  it("renders a per-repo deploy button (or icon-button) inside the repo row map", () => {
    // After fix: each <li> in the repos list contains a per-repo deploy
    // affordance — either a labelled button or an icon-button with an
    // accessible label / aria attribute. We accept either.
    //
    // Required signal: somewhere inside the `sorted.map(...)` (or
    // equivalent) the JSX references either:
    //   - a Rocket icon + onClick that calls a per-repo deploy
    //   - or an aria-label containing "Deploy" with a repo reference
    const hasRocket = /<Rocket\b/.test(src);
    const hasDeployAriaLabel = /aria-label=\{?\s*["'`][^"'`]*Deploy/i.test(src);
    expect(hasRocket || hasDeployAriaLabel).toBe(true);
  });

  it("the per-repo deploy click handler passes the row's repoId (not a global deploy)", () => {
    // The wiring must invoke deploy with that row's repo.id — proving
    // clicking on one repo's button doesn't deploy the others.
    //
    // Required signal: a function call inside the row map that takes a
    // repo.id as its argument. We look for any of:
    //   deployRepoAction(repo.id)
    //   onDeployRepo(repo.id)
    //   handleDeployRepo(repo.id)
    //   handleDeploy(repo.id)
    const pattern =
      /(?:deployRepoAction|onDeployRepo|handleDeployRepo|handleDeploy)\s*\(\s*repo\.id/;
    expect(src).toMatch(pattern);
  });

  it("the per-repo deploy button has a discoverable accessible label", () => {
    // Pure-icon buttons must have an aria-label / title so screen readers
    // and tooltips reveal the purpose. We require some "Deploy" label
    // near a button-like element.
    const hasAccessibleDeployLabel =
      /(?:aria-label|title)=\{?\s*[`'"][^`'"]*Deploy[^`'"]*[`'"]/i.test(src) ||
      /"Deploy this repo"/.test(src) ||
      /"Deploy"/.test(src);
    expect(hasAccessibleDeployLabel).toBe(true);
  });

  it("the per-repo button is disabled while a deploy is in flight (deploying flag)", () => {
    // Like the existing RepoSecretsPane button, the new control must not
    // be clickable twice. We require a `deploying` reference in the file
    // — either threaded as a prop or read from local state — so the
    // disabled state can gate on it.
    expect(src).toMatch(/\bdeploying\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. Workbench wires the deploy state down to RepoPane.
// ---------------------------------------------------------------------------

describe("components/workbench.tsx — wires deploy state to RepoPane", () => {
  const src = readSrc("components/workbench.tsx");

  it("passes deploying state to RepoPane", () => {
    // The per-repo deploy button needs the same `deploying` gate the
    // existing RepoSecretsPane button uses. We inspect the JUST the
    // <RepoPane ...> opening tag so we don't accidentally match
    // `deploying=` on a sibling element later in the file.
    const tag = getOpeningTag(src, "RepoPane");
    expect(tag).toMatch(/\bdeploying=/);
  });

  it("passes a deploy-start callback (or onDeployRepo handler) to RepoPane", () => {
    // RepoPane must be able to trigger a per-repo deploy. Either it gets
    // the same onDeployStart / onDeployFinish callbacks the
    // RepoSecretsPane already gets, or it gets a higher-level onDeployRepo
    // handler. We assert at least one of these prop wirings on the
    // <RepoPane ...> opening tag itself.
    const tag = getOpeningTag(src, "RepoPane");
    const hasOnDeployStart = /\bonDeployStart=/.test(tag);
    const hasOnDeployRepo = /\bonDeployRepo=/.test(tag);
    expect(hasOnDeployStart || hasOnDeployRepo).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The control is visible in the DEFAULT Secrets view, not gated on
//    selecting a repo first.
// ---------------------------------------------------------------------------

describe("default Secrets view — per-repo deploy is reachable without repo selection", () => {
  const repoPaneSrc = readSrc("components/repo-pane.tsx");

  it("the deploy button does NOT gate on selectedRepoId being set", () => {
    // The fix is that the user can click deploy on a repo row without
    // first making that repo the current selection. We assert that the
    // deploy-button JSX is NOT wrapped in a `selectedRepoId === repo.id`
    // conditional.
    //
    // We can't perfectly inspect the AST in a static test, but we CAN
    // assert the deploy button isn't dependent on `selectedRepoId` being
    // truthy. Specifically: the substring `selectedRepoId` must not
    // appear inside a guard that the deploy element is conditioned on.
    //
    // The minimal sufficient check: the Rocket icon (or "Deploy" label)
    // must appear OUTSIDE the section where the source talks about
    // `selectedRepoId === repo.id`. Simpler structural check:
    // somewhere in the file there's a Rocket usage, and the surrounding
    // ~200 chars don't condition on `selectedRepoId`.

    const rocketIdx = repoPaneSrc.indexOf("<Rocket");
    if (rocketIdx === -1) {
      // If no <Rocket the test for icon presence above will fail; here
      // we additionally require it so this test gives a clear signal.
      expect.fail("RepoPane should expose a <Rocket /> deploy icon in each repo row.");
    }
    // Look at the 400 chars BEFORE the rocket — those should contain the
    // .map / iteration, not a selectedRepoId guard wrapping the rocket.
    const before = repoPaneSrc.slice(Math.max(0, rocketIdx - 400), rocketIdx);
    expect(before).not.toMatch(/selectedRepoId\s*===\s*repo\.id\s*&&\s*<(?:Rocket|Button)/);
    // And the rocket should sit inside a row map — at minimum the word
    // `repo` (as in `.map((repo) =>`) appears in the same neighborhood.
    expect(before + repoPaneSrc.slice(rocketIdx, rocketIdx + 200)).toMatch(/\brepo\b/);
  });
});
