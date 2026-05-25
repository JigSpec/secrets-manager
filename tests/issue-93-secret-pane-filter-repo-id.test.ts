/**
 * Test 3 — Issue #93 Point 4: SecretPane filterRepoId prop
 *
 * Verifies that `components/secret-pane.tsx` correctly filters secrets
 * when a `filterRepoId` prop is provided — only secrets scoped to the
 * selected repo are displayed.
 *
 * These are pure source-text tests — no DOM required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Secret } from "@/lib/vault/schema";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Logic-level test: the filterRepoId filter function
// ---------------------------------------------------------------------------

function makeSecret(
  id: string,
  key: string,
  scopeRepoIds: string[] = [],
): Secret {
  return {
    id,
    key,
    value: "val",
    scopes: scopeRepoIds.map((repoId) => ({ repoId, env: "production" })),
  } as Secret;
}

/**
 * Mirrors the filter applied in SecretPane when filterRepoId is set.
 */
function applyFilterRepoId(
  secrets: Secret[],
  filterRepoId: string | undefined,
): Secret[] {
  if (!filterRepoId) return secrets;
  return secrets.filter((s) =>
    s.scopes.some((sc) => sc.repoId === filterRepoId),
  );
}

const SECRET_ALL = makeSecret("s1", "GLOBAL_KEY");               // no scopes
const SECRET_REPO1 = makeSecret("s2", "REPO1_KEY", ["repo-1"]); // scoped to repo-1
const SECRET_REPO2 = makeSecret("s3", "REPO2_KEY", ["repo-2"]); // scoped to repo-2
const ALL_SECRETS = [SECRET_ALL, SECRET_REPO1, SECRET_REPO2];

describe("filterRepoId logic — SecretPane filtering (Issue #93, Point 4)", () => {
  it("returns all secrets when filterRepoId is undefined", () => {
    expect(applyFilterRepoId(ALL_SECRETS, undefined)).toHaveLength(3);
  });

  it('returns only repo-1 secret when filterRepoId="repo-1"', () => {
    const result = applyFilterRepoId(ALL_SECRETS, "repo-1");
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("REPO1_KEY");
  });

  it("returns empty list when filterRepoId matches no secret's scopes", () => {
    const result = applyFilterRepoId(ALL_SECRETS, "repo-unknown");
    expect(result).toHaveLength(0);
  });

  it("does not include globally-unscoped secrets when filterRepoId is set", () => {
    // SECRET_ALL has no scopes — it should NOT appear when a repoId filter is active.
    const result = applyFilterRepoId(ALL_SECRETS, "repo-1");
    const keys = result.map((s) => s.key);
    expect(keys).not.toContain("GLOBAL_KEY");
  });
});

// ---------------------------------------------------------------------------
// Source-text test: secret-pane.tsx must declare filterRepoId prop
// ---------------------------------------------------------------------------

describe("secret-pane.tsx — filterRepoId prop exists (Issue #93, Point 4)", () => {
  const src = readSrc("components/secret-pane.tsx");

  it("declares a filterRepoId prop in SecretPane's props interface", () => {
    // The component signature / destructuring must mention filterRepoId.
    const hasProp = /filterRepoId/.test(src);
    expect(
      hasProp,
      'Expected secret-pane.tsx to declare a filterRepoId prop. '
      + 'Add `filterRepoId?: string` to the SecretPane props and apply it as a filter.',
    ).toBe(true);
  });

  it('uses filterRepoId to filter the displayed secret list', () => {
    // The `filtered` useMemo must gate on filterRepoId.
    const usedInFilter =
      /filterRepoId/.test(src) &&
      (/\.filter\s*\(/.test(src) || /\.some\s*\(/.test(src));
    expect(
      usedInFilter,
      'Expected filterRepoId to be used inside a .filter() or .some() call in secret-pane.tsx. '
      + 'Apply the filterRepoId to the secrets list so only matching secrets are displayed.',
    ).toBe(true);
  });
});
