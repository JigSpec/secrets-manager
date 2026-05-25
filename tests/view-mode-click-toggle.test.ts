/**
 * Tests for click-to-toggle view auto-switching (Issue #91, Step 1).
 *
 * PART A — getThirdColumnMode (lib/vault/view-mode.ts):
 *   These tests verify existing behaviour of the pure function and should pass
 *   once the function is correctly implemented. They are included here to
 *   document the contract that the auto-switch feature builds on.
 *
 * PART B — workbench.tsx auto-switch handlers (intentionally RED):
 *   When a user selects a REPO, the workbench's handleRepoSelect must
 *   automatically switch `view` to "repos" so the RepoSecretsPane is shown.
 *   When a user selects a SECRET, handleSecretSelect must automatically switch
 *   `view` to "secrets" so the ScopePane is shown.
 *   Currently, workbench.tsx just calls `setSelectedRepoId`/`setSelectedSecretId`
 *   without changing the view — the auto-switch is MISSING.
 *
 * These auto-switch tests are intentionally RED until Agent D adds the
 *   auto-switch logic to workbench.tsx.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getThirdColumnMode,
} from "@/lib/vault/view-mode";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// PART A: getThirdColumnMode — contract tests (may already pass)
// ---------------------------------------------------------------------------

describe("getThirdColumnMode — repos view: clicking a repo shows repo-secrets", () => {
  it('returns "repo-secrets" when view is "repos" and a repoId is set', () => {
    expect(getThirdColumnMode("repos", null, "repo-abc")).toBe("repo-secrets");
  });

  it('returns "repo-secrets-placeholder" when view is "repos" and no repoId', () => {
    expect(getThirdColumnMode("repos", null, null)).toBe("repo-secrets-placeholder");
  });
});

describe("getThirdColumnMode — secrets view: clicking a secret shows scope", () => {
  it('returns "scope" when view is "secrets" and a secretId is set', () => {
    expect(getThirdColumnMode("secrets", "secret-xyz", null)).toBe("scope");
  });

  it('returns "scope" when view is "secrets" and no secret or repo is selected', () => {
    expect(getThirdColumnMode("secrets", null, null)).toBe("scope");
  });
});

// ---------------------------------------------------------------------------
// PART B: workbench.tsx — auto-switch on repo/secret selection (RED tests)
//
// The workbench must define dedicated handlers (handleRepoSelect,
// handleSecretSelect, or equivalent) that both update the selection AND switch
// the view.  Currently the panes receive `setSelectedRepoId` / `setSelectedSecretId`
// directly, with no view switch.
// ---------------------------------------------------------------------------

describe("workbench.tsx — handleRepoSelect switches view to repos", () => {
  const src = readSrc("components/workbench.tsx");

  it("defines a handleRepoSelect (or onRepoSelect) handler that calls setView", () => {
    // After the fix there must be a named handler for repo selection that also
    // calls setView (or setView("repos")).
    const hasHandler =
      /handleRepoSelect\b/.test(src) ||
      /onRepoSelect\b/.test(src) ||
      /selectRepo\b/.test(src);
    expect(hasHandler).toBe(true);
  });

  it('handleRepoSelect switches view to "repos"', () => {
    // The handler must call setView("repos") or equivalent.
    const handlerIdx =
      src.indexOf("handleRepoSelect") !== -1
        ? src.indexOf("handleRepoSelect")
        : src.indexOf("onRepoSelect") !== -1
          ? src.indexOf("onRepoSelect")
          : src.indexOf("selectRepo");
    expect(handlerIdx).toBeGreaterThan(-1);

    // Look at 400 chars after the handler declaration for setView("repos").
    const segment = src.slice(handlerIdx, handlerIdx + 400);
    const switchesToRepos =
      /setView\s*\(\s*["']repos["']\s*\)/.test(segment) ||
      // arrow function that sets view inline
      /["']repos["']/.test(segment);
    expect(switchesToRepos).toBe(true);
  });
});

describe("workbench.tsx — handleSecretSelect switches view to secrets", () => {
  const src = readSrc("components/workbench.tsx");

  it("defines a handleSecretSelect (or onSecretSelect) handler that calls setView", () => {
    const hasHandler =
      /handleSecretSelect\b/.test(src) ||
      /onSecretSelect\b/.test(src) ||
      /selectSecret\b/.test(src);
    expect(hasHandler).toBe(true);
  });

  it('handleSecretSelect switches view to "secrets"', () => {
    const handlerIdx =
      src.indexOf("handleSecretSelect") !== -1
        ? src.indexOf("handleSecretSelect")
        : src.indexOf("onSecretSelect") !== -1
          ? src.indexOf("onSecretSelect")
          : src.indexOf("selectSecret");
    expect(handlerIdx).toBeGreaterThan(-1);

    const segment = src.slice(handlerIdx, handlerIdx + 400);
    const switchesToSecrets =
      /setView\s*\(\s*["']secrets["']\s*\)/.test(segment) ||
      /["']secrets["']/.test(segment);
    expect(switchesToSecrets).toBe(true);
  });
});
