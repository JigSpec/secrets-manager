/**
 * Tests for issue #77 — MCP / daemon / CLI surface coverage.
 *
 * Locks the tool surface against future drift. The three sources of truth
 * (`mcp/server.ts` TOOL_DEFINITIONS, `lib/daemon/handlers/index.ts`,
 * `lib/cli/commands/index.ts`) must each register the tools that the docs,
 * tests, and AI agents rely on. If a tool is intentionally removed, the
 * corresponding assertion in this file MUST be deleted in the same PR —
 * don't silently drift.
 *
 * Source-level only: no daemon spawn, no vault, no network.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_DEFINITIONS } from "../../mcp/server";

const REPO_ROOT = join(__dirname, "..", "..");

function readRepo(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

describe("Issue #77 — MCP / daemon / CLI tool-coverage invariants", () => {
  describe("MCP TOOL_DEFINITIONS exposes required tools", () => {
    it("TOOL_DEFINITIONS contains 'scope_secrets_bulk' (shipped in #45)", () => {
      const names = TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toContain("scope_secrets_bulk");
    });

    it("TOOL_DEFINITIONS contains 'set_tutorial' (shipped in #54)", () => {
      const names = TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toContain("set_tutorial");
    });
  });

  describe("Daemon handler registry imports the bulk + tutorial handlers", () => {
    it("lib/daemon/handlers/index.ts imports './scope-bulk'", () => {
      const src = readRepo("lib/daemon/handlers/index.ts");
      // Match either side-effect form (`import "./scope-bulk"`) or named
      // form (`import { register } from "./scope-bulk"`). A benign refactor
      // between the two should not break this lock-in check.
      expect(src).toMatch(/(?:import|from)\s+["']\.\/scope-bulk["']/);
    });

    it("lib/daemon/handlers/index.ts imports './set-tutorial'", () => {
      const src = readRepo("lib/daemon/handlers/index.ts");
      expect(src).toMatch(/(?:import|from)\s+["']\.\/set-tutorial["']/);
    });
  });

  describe("CLI command registry imports the update-repo-path command", () => {
    it("lib/cli/commands/index.ts imports './update-repo-path'", () => {
      const src = readRepo("lib/cli/commands/index.ts");
      expect(src).toMatch(/(?:import|from)\s+["']\.\/update-repo-path["']/);
    });
  });
});
