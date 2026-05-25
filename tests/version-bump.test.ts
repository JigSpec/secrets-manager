/**
 * Tests for Issue #91, Step 0: Version bump.
 *
 * REQUIRED CHANGES (not yet implemented):
 *   1. package.json `version` field must be bumped to "0.2.0".
 *   2. CLAUDE.md must contain a `## Versioning Policy` section that documents
 *      the project's versioning conventions for AI agents and contributors.
 *
 * These tests are intentionally RED until Agent D applies the changes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// package.json — version must be "0.2.0"
// ---------------------------------------------------------------------------
describe("package.json — version bump to 0.2.0 (Issue #91, Step 0)", () => {
  it('package.json version is "0.2.0"', () => {
    const raw = readSrc("package.json");
    const pkg = JSON.parse(raw) as { version?: string };
    // Bumped from 0.1.0 → 0.2.0 (features + bugfixes; MAJOR reserved for breaking changes).
    expect(pkg.version).toBe("0.2.0");
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md — must contain a ## Versioning Policy section
// ---------------------------------------------------------------------------
describe("CLAUDE.md — Versioning Policy section (Issue #91, Step 0)", () => {
  const src = readSrc("CLAUDE.md");

  it('contains a "## Versioning Policy" heading', () => {
    // CLAUDE.md does not currently contain a Versioning Policy section.
    // After the fix it must include "## Versioning Policy" so AI agents
    // and contributors understand the version numbering scheme.
    expect(src).toMatch(/^##\s+Versioning Policy/m);
  });

  it("Versioning Policy section has meaningful content (not just a heading)", () => {
    const idx = src.search(/^##\s+Versioning Policy/m);
    expect(idx).toBeGreaterThan(-1);

    // Grab up to 500 chars after the heading — there must be some prose.
    const segment = src.slice(idx, idx + 500);
    // Strip the heading itself and check remaining content is non-trivial.
    const afterHeading = segment.replace(/^##\s+Versioning Policy\s*/m, "").trim();
    expect(afterHeading.length).toBeGreaterThan(30);
  });
});
