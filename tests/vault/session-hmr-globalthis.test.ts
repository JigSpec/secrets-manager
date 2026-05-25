/**
 * Tests for the HMR-safe globalThis session store (PR #105).
 *
 * lib/vault/session.ts cannot be imported directly in Vitest because it starts
 * with `import "server-only"`. This file uses static source-analysis (reading
 * the .ts source as a string) to verify the structural guarantees introduced by
 * the HMR fix:
 *
 *   1. The globalThis key is the namespaced constant
 *      `__secretsManager_webSessions_v1` (not the old `__smSessions`), reducing
 *      the risk of collisions with other packages on the same globalThis.
 *
 *   2. An `instanceof Map` guard is in place so that if anything else ever
 *      writes a non-Map to that key, the module falls back to a fresh Map
 *      rather than throwing a TypeError on `sessions.has(id)`.
 *
 *   3. A security comment is present near the globalThis assignment explaining
 *      why storing plaintext passwords on globalThis is acceptable for this
 *      localhost-only tool.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const src = readSrc("lib/vault/session.ts");

// ---------------------------------------------------------------------------
// 1. Namespaced globalThis key
// ---------------------------------------------------------------------------
describe("lib/vault/session.ts — HMR globalThis key is namespaced", () => {
  it("uses __secretsManager_webSessions_v1 as the globalThis key", () => {
    expect(src).toContain("__secretsManager_webSessions_v1");
  });

  it("does not use the old short key __smSessions", () => {
    expect(src).not.toContain("__smSessions");
  });
});

// ---------------------------------------------------------------------------
// 2. instanceof Map guard
// ---------------------------------------------------------------------------
describe("lib/vault/session.ts — instanceof Map guard prevents TypeError on corrupt globalThis", () => {
  it("contains an instanceof Map check", () => {
    expect(src).toMatch(/instanceof\s+Map/);
  });

  it("falls back to a new Map when the candidate is not a Map", () => {
    // The pattern we expect:
    //   candidate instanceof Map ? candidate : new Map()
    // Allow for an optional TypeScript generic type parameter between Map and (,
    // e.g. new Map<string, SessionEntry>().
    expect(src).toMatch(/instanceof\s+Map\b[\s\S]*?new\s+Map(?:<[^>]+>)?\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 3. Security comment
// ---------------------------------------------------------------------------
describe("lib/vault/session.ts — security comment near globalThis assignment", () => {
  it("mentions that this is a localhost-only tool", () => {
    expect(src).toMatch(/localhost[- ]only/i);
  });

  it("explains that the password is already in process memory", () => {
    expect(src).toMatch(/process memory/i);
  });
});
