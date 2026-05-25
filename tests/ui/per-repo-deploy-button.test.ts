/**
 * Tests for the per-repo "Deploy this repo" button on RepoSecretsPane
 * (Issue #71). Static source-analysis only — see scrolling-fix.test.ts for the
 * precedent in this repo.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 1. RepoSecretsPane renders a "Deploy this repo" button
// ---------------------------------------------------------------------------

describe("components/repo-secrets-pane.tsx — Deploy this repo button", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("has a button labelled with the per-repo deploy intent", () => {
    // Match the visible button label string. Allow either "Deploy this repo"
    // or "Deploy repo" but the canonical label is "Deploy this repo".
    expect(src).toMatch(/Deploy this repo/);
  });

  it("imports the per-repo deploy server action", () => {
    // The button must call deployRepoAction from @/app/actions.
    expect(src).toMatch(/deployRepoAction/);
  });

  it("threads onDeployStart and onDeployFinish props down from Workbench", () => {
    // The pane needs to surface deploy progress in the shared DeploySheet,
    // so it must accept the same callbacks the TopBar uses.
    expect(src).toMatch(/onDeployStart/);
    expect(src).toMatch(/onDeployFinish/);
  });

  it("disables the button when the repo has zero scoped secrets", () => {
    // We assert the disabled attribute references a count/length so a
    // zero-secret repo can't trigger an empty deploy.
    // Allow either "disabled={... === 0" / "disabled={totalCount === 0" /
    // "disabled={!totalCount" / "disabled={deployTargetCount === 0".
    const hasDisabledGuard =
      /disabled=\{[^}]*(?:totalCount\s*===\s*0|!\s*totalCount|deployTargetCount\s*===\s*0|targetCount\s*===\s*0)/.test(
        src,
      );
    expect(hasDisabledGuard).toBe(true);
  });

  it("disables the button while a deploy is in flight (deploying prop)", () => {
    // The shared deploy state must keep the button from being clicked twice.
    expect(src).toMatch(/\bdeploying\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. Workbench passes the deploy callbacks down to RepoSecretsPane
// ---------------------------------------------------------------------------

describe("components/workbench.tsx — wires deploy callbacks to RepoSecretsPane", () => {
  const src = readSrc("components/workbench.tsx");

  it("passes onDeployStart to RepoSecretsPane", () => {
    // We just check the JSX usage of RepoSecretsPane includes onDeployStart.
    expect(src).toMatch(/<RepoSecretsPane[\s\S]*?onDeployStart=/);
  });

  it("passes onDeployFinish to RepoSecretsPane", () => {
    expect(src).toMatch(/<RepoSecretsPane[\s\S]*?onDeployFinish=/);
  });

  it("passes deploying state to RepoSecretsPane", () => {
    expect(src).toMatch(/<RepoSecretsPane[\s\S]*?deploying=/);
  });
});

// ---------------------------------------------------------------------------
// 3. The server-action export exists
// ---------------------------------------------------------------------------

describe("app/actions.ts — deployRepoAction export", () => {
  const src = readSrc("app/actions.ts");

  it("exports deployRepoAction", () => {
    expect(src).toMatch(/export\s+async\s+function\s+deployRepoAction/);
  });

  it("deployRepoAction takes a repoId parameter", () => {
    // Signature must accept a string repoId argument.
    expect(src).toMatch(/deployRepoAction\s*\(\s*repoId\s*:\s*string/);
  });

  it("deployRepoAction routes through runDeploy with a filtered targets list", () => {
    // The targets are computed per-repo. We require some reference to
    // targetsForRepo (or enumerateTargets) plus `runDeploy`.
    expect(src).toMatch(/runDeploy\s*\(/);
    expect(src).toMatch(/targetsForRepo|enumerateTargets/);
  });
});
