/**
 * Tests for issue #77 — CLAUDE.md ↔ MCP tool-mention parity.
 *
 * Two invariants are enforced in this file:
 *
 *   1. Forward direction: every tool name exported from `mcp/server.ts`
 *      TOOL_DEFINITIONS must appear in CLAUDE.md as a standalone token (i.e.
 *      not as a substring of a longer identifier). This stops new MCP tools
 *      from shipping without an AI usage note. The match uses word boundaries
 *      so that `scope_secret` is NOT considered present merely because
 *      `scope_secrets_bulk` or `unscope_secret` contains it as a substring.
 *
 *   2. Reverse direction: every backtick-wrapped tool-shaped identifier
 *      (snake_case, lowercase, in the MCP Tool Quick Reference table region)
 *      that appears in CLAUDE.md must correspond to a real entry in
 *      TOOL_DEFINITIONS. This stops removed tools from leaving stale doc
 *      references and stops typos like `scope_secrets` from sneaking in.
 *
 * If a tool genuinely should NOT appear in CLAUDE.md (e.g. a strictly
 * internal/debug tool), add its name to ALLOW_LIST below with a one-line
 * comment explaining why. The default allow-list is empty.
 *
 * If a backtick-wrapped snake_case identifier in CLAUDE.md is legitimately
 * NOT an MCP tool (e.g. a parameter name like `envs` or an internal value
 * like `awaiting_value`), add it to DOC_NON_TOOL_TOKENS below with a
 * one-line justification.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_DEFINITIONS } from "../../mcp/server";

const REPO_ROOT = join(__dirname, "..", "..");

function readRepo(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

// Tools intentionally omitted from CLAUDE.md. Keep this list short and
// document every entry — silent allow-listing defeats the point.
const ALLOW_LIST: ReadonlySet<string> = new Set<string>([
  // (empty — every shipped MCP tool currently belongs in CLAUDE.md)
]);

// Backtick-wrapped snake_case identifiers in CLAUDE.md that look like MCP
// tool names but are NOT — parameter names, status values, sentinels, etc.
// Keep this list narrow; prefer alternative phrasings in the doc when
// possible so the reverse-direction guard stays strict.
const DOC_NON_TOOL_TOKENS: ReadonlySet<string> = new Set<string>([
  "awaiting_value",   // status string used by deploy filter, not a tool
]);

describe("Issue #77 — CLAUDE.md ↔ MCP tool-mention parity", () => {
  const claudeMd = readRepo("CLAUDE.md");

  // ── Forward direction: TOOL_DEFINITIONS → CLAUDE.md ───────────────────────
  describe("CLAUDE.md mentions every MCP tool (forward parity)", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const name = tool.name;
      if (ALLOW_LIST.has(name)) continue;

      it(`CLAUDE.md must mention MCP tool '${name}' as a standalone token`, () => {
        // Word-boundary match: the tool name must not be merely a substring
        // of a longer identifier. For example, the bare string "scope_secret"
        // appears inside "scope_secrets_bulk" and "unscope_secret"; without
        // a boundary check, deleting every standalone mention of the shorter
        // name would still pass.
        const pattern = new RegExp("(?<![A-Za-z0-9_])" + escapeRegExp(name) + "(?![A-Za-z0-9_])");
        expect(
          claudeMd,
          `tool '${name}' is registered in mcp/server.ts TOOL_DEFINITIONS but is not mentioned in CLAUDE.md as a standalone token. ` +
            `Either add it to the AI Usage Guide, or — if you intentionally hid it — add the name to ALLOW_LIST in ` +
            `tests/docs/tool-mention-parity.test.ts with a one-line justification.`,
        ).toMatch(pattern);
      });
    }
  });

  // ── Reverse direction: CLAUDE.md → TOOL_DEFINITIONS ───────────────────────
  describe("CLAUDE.md has no stale tool references (reverse parity)", () => {
    // Pull every backtick-wrapped snake_case identifier out of CLAUDE.md.
    // The regex is restricted to lowercase + underscores + digits to avoid
    // picking up filenames, env var names (UPPERCASE_WITH_UNDERSCORES), or
    // file paths.
    const BACKTICK_TOKEN = /`([a-z][a-z0-9_]*)`/g;
    const validToolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));

    // Collect unique candidates so each becomes one `it` block.
    const candidates = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = BACKTICK_TOKEN.exec(claudeMd)) !== null) {
      const token = match[1];
      // Only flag tokens that LOOK like tools: must contain an underscore
      // (matches the snake_case convention of every existing tool name).
      // Single-word backtick tokens like `deploy` or `value` are too
      // ambiguous to police automatically — they'd produce false positives
      // on every prose mention.
      if (token.includes("_")) {
        candidates.add(token);
      }
    }

    for (const token of candidates) {
      if (DOC_NON_TOOL_TOKENS.has(token)) continue;

      it(`backtick-wrapped token '${token}' in CLAUDE.md must correspond to a real MCP tool`, () => {
        expect(
          validToolNames.has(token),
          `CLAUDE.md mentions \`${token}\` but no tool with that name exists in mcp/server.ts TOOL_DEFINITIONS. ` +
            `Either the tool was removed (delete the stale reference), or '${token}' is a legitimate non-tool ` +
            `identifier (parameter name, status value, etc.) — in which case add it to DOC_NON_TOOL_TOKENS in ` +
            `tests/docs/tool-mention-parity.test.ts with a one-line justification.`,
        ).toBe(true);
      });
    }
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
