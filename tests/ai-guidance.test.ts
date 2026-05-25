/**
 * Tests for issue #42 "Fix AI tunnel vision".
 *
 * These tests assert properties that do NOT hold in the current codebase and
 * will therefore FAIL (be red) until the corresponding fixes are applied:
 *
 *   1. CLAUDE.md must contain comprehensive AI usage instructions.
 *   2. add_secret's `description` parameter description must be detailed and
 *      mention "always" / "ALWAYS".
 *   3. scope_secret's top-level description must mention that it should always
 *      be called after add_secret.
 *   4. add_repo's `environments` parameter description must mention both
 *      "test" and "live" environments.
 *   5. install.sh must install the sm-mcp binary.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");

// ── Helpers ──────────────────────────────────────────────────────────────────

function readRepo(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

/**
 * Parse TOOL_DEFINITIONS out of mcp/server.ts at the source level.
 * We import the compiled JS at runtime rather than parsing TypeScript text,
 * so we rely on the exported constant that is already present in server.ts.
 */
import { TOOL_DEFINITIONS } from "../mcp/server";

function getTool(name: string) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in TOOL_DEFINITIONS`);
  return tool;
}

function getParamDescription(toolName: string, paramName: string): string {
  const tool = getTool(toolName);
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
  const param = props[paramName];
  if (!param) throw new Error(`Param "${paramName}" not found in tool "${toolName}"`);
  return param.description ?? "";
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("Issue #42 — AI tunnel vision fixes", () => {

  // ── Test 1: CLAUDE.md comprehensive content ─────────────────────────────────
  describe("CLAUDE.md comprehensive AI instructions", () => {
    let claudeMd: string;

    it("CLAUDE.md must be longer than 100 characters", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd.length).toBeGreaterThan(100);
    });

    it("CLAUDE.md must mention 'daemon_status'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("daemon_status");
    });

    it("CLAUDE.md must mention 'scope_secret'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("scope_secret");
    });

    it("CLAUDE.md must mention 'description'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("description");
    });

    it("CLAUDE.md must mention 'test'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("test");
    });

    it("CLAUDE.md must mention 'live'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("live");
    });

    it("CLAUDE.md must mention 'deploy'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("deploy");
    });

    it("CLAUDE.md must mention 'namespace'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("namespace");
    });

    it("CLAUDE.md must mention 'rotate'", () => {
      claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("rotate");
    });
  });

  // ── Test 2: add_secret `description` parameter description ──────────────────
  describe("add_secret tool — 'description' parameter description", () => {
    it("must be longer than 50 characters", () => {
      const desc = getParamDescription("add_secret", "description");
      expect(desc.length).toBeGreaterThan(50);
    });

    it("must mention 'always' or 'ALWAYS'", () => {
      const desc = getParamDescription("add_secret", "description");
      const mentionsAlways =
        desc.toLowerCase().includes("always");
      expect(mentionsAlways).toBe(true);
    });
  });

  // ── Test 3: scope_secret top-level description ──────────────────────────────
  describe("scope_secret tool — top-level description", () => {
    it("must mention 'always', 'ALWAYS', or 'after add_secret'", () => {
      const tool = getTool("scope_secret");
      const desc: string = tool.description ?? "";
      const mentionsCallPattern =
        desc.toLowerCase().includes("always") ||
        desc.includes("after add_secret");
      expect(mentionsCallPattern).toBe(true);
    });
  });

  // ── Test 4: add_repo `environments` parameter description ───────────────────
  describe("add_repo tool — 'environments' parameter description", () => {
    it("must mention 'test'", () => {
      const desc = getParamDescription("add_repo", "environments");
      expect(desc.toLowerCase()).toContain("test");
    });

    it("must mention 'live'", () => {
      const desc = getParamDescription("add_repo", "environments");
      expect(desc.toLowerCase()).toContain("live");
    });
  });

  // ── Test 5: install.sh must include sm-mcp ───────────────────────────────────
  describe("install.sh — sm-mcp binary", () => {
    it("BINS array must include 'sm-mcp'", () => {
      const installSh = readRepo("install.sh");
      expect(installSh).toContain("sm-mcp");
    });

    it("SOURCES array must include a path to bin/sm-mcp.ts", () => {
      const installSh = readRepo("install.sh");
      expect(installSh).toContain("bin/sm-mcp.ts");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #77 — Tech debt cleanup
//
// CLAUDE.md and README.md drifted away from the shipped MCP/CLI surface:
//   - `scope_secrets_bulk` (added in #45) and `set_tutorial` (added in #54)
//     are missing from CLAUDE.md and from the MCP Tool Quick Reference table.
//   - The "Always set a namespace" golden rule actively encourages a
//     documented misuse pattern (issue #79).
//   - README's CLI surface section omits `sm update-repo-path`.
//   - README's "What it does" block does not mention tutorials or the
//     `awaiting_value` placeholder mechanism.
//
// These tests assert the post-cleanup invariants. They must fail RED on
// `main` and turn green after Agent D's doc edits land.
// ─────────────────────────────────────────────────────────────────────────────
describe("Issue #77 — Tech debt cleanup", () => {
  // ── CLAUDE.md tool-coverage invariants ─────────────────────────────────────
  describe("CLAUDE.md mentions shipped tools", () => {
    it("CLAUDE.md must mention 'scope_secrets_bulk' (shipped in #45)", () => {
      const claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("scope_secrets_bulk");
    });

    it("CLAUDE.md must mention 'set_tutorial' (shipped in #54)", () => {
      const claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("set_tutorial");
    });

    it("CLAUDE.md must mention 'awaiting_value' (placeholder semantic)", () => {
      const claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("awaiting_value");
    });
  });

  // ── CLAUDE.md namespace-rule rewrite ────────────────────────────────────────
  describe("CLAUDE.md namespace rule no longer encourages misuse", () => {
    it("must NOT contain the literal 'Always set a namespace' (#79 misuse #4)", () => {
      const claudeMd = readRepo("CLAUDE.md");
      // Negative assertion: the misleading guidance must be gone.
      expect(claudeMd).not.toContain("Always set a namespace");
    });

    // issue #78 — namespace is now a vault-internal disambiguator that does
    // NOT change the deployed env-var name. PR #85 originally pinned the
    // pre-#78 contract by asserting CLAUDE.md mentions `NS_KEY` (the
    // rewrite-aware framing). #78 reverses that semantics: namespaces never
    // appear in the deployed file, so `NS_KEY` should NOT be present and the
    // doc should instead anchor on the vault-internal framing.
    it("must declare namespace is vault-internal and does not rewrite the deployed key", () => {
      const claudeMd = readRepo("CLAUDE.md");
      // Negative: the pre-#78 rewrite framing must be gone.
      expect(claudeMd).not.toContain("NS_KEY");
      // Positive: the post-#78 framing must be present — the namespace is
      // a vault-internal disambiguator and the deployed file always uses
      // the bare key (regardless of how the doc backticks "KEY").
      expect(claudeMd).toContain("vault-internal");
      expect(claudeMd.toLowerCase()).toMatch(/does not change the env-var name|do not prefix the deployed key|bare `?key`?/i);
    });
  });

  // ── CLAUDE.md Common Mistakes section warns about deploy semantics ─────────
  describe("CLAUDE.md Common Mistakes warns deploy is not a runtime push", () => {
    it("must mention Vercel/Fly/Heroku or 'runtime' in the Common Mistakes section", () => {
      const claudeMd = readRepo("CLAUDE.md");
      // Locate the Common Mistakes header and grab everything until end-of-file
      // (or the next top-level header, whichever comes first).
      const headerIdx = claudeMd.indexOf("## Common Mistakes");
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      const tail = claudeMd.slice(headerIdx);
      const nextSectionIdx = tail.indexOf("\n## ", 1);
      const section = nextSectionIdx === -1 ? tail : tail.slice(0, nextSectionIdx);
      expect(section).toMatch(/Vercel|Fly|Heroku|runtime/i);
    });
  });

  // ── README.md surface coverage ──────────────────────────────────────────────
  describe("README.md mentions newly shipped surface", () => {
    it("README.md must list 'sm update-repo-path' in the CLI surface block", () => {
      const readme = readRepo("README.md");
      expect(readme).toContain("sm update-repo-path");
    });

    it("README.md 'What it does' block must mention tutorials", () => {
      const readme = readRepo("README.md");
      // Pull out everything between the "## What it does" header and the next
      // top-level header. Case-insensitive "tutorial" must appear within.
      const headerIdx = readme.indexOf("## What it does");
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      const tail = readme.slice(headerIdx);
      const nextSectionIdx = tail.indexOf("\n## ", 1);
      const section = nextSectionIdx === -1 ? tail : tail.slice(0, nextSectionIdx);
      expect(section.toLowerCase()).toContain("tutorial");
    });
  });
});

// ── Issue #80 — CLI vs MCP coherence ──────────────────────────────────────────
//
// These tests assert the post-fix state for issue #80 — they are intentionally
// RED until commits 1–4 of the plan land. The test strategy mirrors the #42
// pattern above: doc-file string assertions for CLAUDE.md / README.md, source
// string assertions for bin/sm.ts (the help text is a static inlined array),
// and source string assertions for the CLI scope command parser.
describe("Issue #80 — CLI vs MCP doc coherence", () => {
  describe("CLAUDE.md must point AI agents at MCP and provide a CLI fallback map", () => {
    it("CLAUDE.md must mention 'sm-mcp' (the MCP binary name)", () => {
      expect(readRepo("CLAUDE.md")).toContain("sm-mcp");
    });

    it("CLAUDE.md must include a 'Why MCP, not CLI?' section", () => {
      expect(readRepo("CLAUDE.md")).toContain("Why MCP, not CLI?");
    });

    it("CLAUDE.md must include the 'CLI Fallback' appendix heading", () => {
      expect(readRepo("CLAUDE.md")).toContain("CLI Fallback");
    });

    it("CLAUDE.md must map at least the core MCP tools to CLI verbs", () => {
      const claudeMd = readRepo("CLAUDE.md");
      expect(claudeMd).toContain("sm scope");
      expect(claudeMd).toContain("sm deploy");
      expect(claudeMd).toContain("sm add-secret");
      expect(claudeMd).toContain("sm add-repo");
      expect(claudeMd).toContain("sm-daemon status");
    });

    it("CLAUDE.md must remind CLI users to use --dry-run before deploy", () => {
      expect(readRepo("CLAUDE.md")).toContain("--dry-run");
    });

    it("CLAUDE.md must explicitly say sm is not a runtime proxy", () => {
      expect(readRepo("CLAUDE.md").toLowerCase()).toContain("not a runtime proxy");
    });
  });

  describe("README.md must direct AI agents to MCP", () => {
    it("README.md must mention 'sm-mcp' as the preferred agent surface", () => {
      const readme = readRepo("README.md");
      expect(readme).toContain("sm-mcp");
      // The callout must appear near the top — before the "What it does" section.
      const idx = readme.indexOf("sm-mcp");
      const whatItDoesIdx = readme.indexOf("## What it does");
      expect(idx).toBeGreaterThan(0);
      expect(idx).toBeLessThan(whatItDoesIdx);
    });

    it("README.md must clarify that sm is not a runtime proxy", () => {
      expect(readRepo("README.md").toLowerCase()).toContain("not a runtime proxy");
    });

    it("README.md must reference CLAUDE.md from the AI-agent callout", () => {
      expect(readRepo("README.md")).toContain("CLAUDE.md");
    });

    it("README.md must document repeatable --env for sm scope", () => {
      const readme = readRepo("README.md");
      expect(readme).toContain("sm scope");
      // Either inline-documented in the CLI surface block or via "[--env ENV ...]".
      expect(readme).toMatch(/sm scope[^\n]*--env[^\n]*\[--env/);
    });
  });

  describe("sm --help must surface the MCP-preference banner", () => {
    // We assert by reading bin/sm.ts source — the help text is a static
    // array of strings inline in the file, so source-level assertion is
    // sufficient and avoids needing to spawn a subprocess in this suite.
    it("bin/sm.ts must include the 'For AI agents' banner", () => {
      expect(readRepo("bin/sm.ts")).toContain("For AI agents");
    });

    it("bin/sm.ts must tell agents to prefer sm-mcp", () => {
      expect(readRepo("bin/sm.ts")).toContain("Prefer `sm-mcp`");
    });

    it("bin/sm.ts must reference CLAUDE.md from the banner", () => {
      expect(readRepo("bin/sm.ts")).toContain("CLAUDE.md");
    });

    it("bin/sm.ts must document repeatable --env on scope", () => {
      // Match intent (repeatable-flag contract) without locking column
      // alignment. A future help-text re-indent shouldn't break this test.
      expect(readRepo("bin/sm.ts")).toMatch(
        /scope\s+<secret>[^\n]*--env ENV \[--env ENV \.\.\.\]/,
      );
    });

    it("bin/sm.ts must still contain every existing verb-group section header", () => {
      const sm = readRepo("bin/sm.ts");
      expect(sm).toContain("Daemon-status:");
      expect(sm).toContain("Read-only:");
      expect(sm).toContain("Structural mutations:");
      expect(sm).toContain("Value-bearing mutations:");
      expect(sm).toContain("Import / discovery:");
      expect(sm).toContain("Deploy:");
      expect(sm).toContain("Output:");
    });
  });

  describe("sm scope CLI must accept repeatable --env (mirrors MCP scope_secret.envs)", () => {
    it("lib/cli/commands/scope.ts must use getRepeatedFlag for --env", () => {
      expect(readRepo("lib/cli/commands/scope.ts")).toContain("getRepeatedFlag");
    });

    it("lib/cli/commands/scope.ts usage line must show repeatable --env", () => {
      expect(readRepo("lib/cli/commands/scope.ts")).toContain("[--env ENV ...]");
    });
  });

  describe("sm scope CLI parser: repeatable --env behavior (unit test of argv + scope wire shape)", () => {
    // Structural unit test of the seam the plan calls out: parseArgs +
    // getRepeatedFlag must already produce an array for repeated --env. The
    // post-fix scope.ts must then forward (a) single-env as `env: string`
    // and (b) multi-env as `envs: string[]`. We exercise this by importing
    // the parser primitives directly and asserting on their outputs — this
    // does not depend on a running daemon.
    it("parseArgs collects repeated --env flags into an array via getRepeatedFlag", async () => {
      // Sanity check that the existing parser primitive already supports
      // repeated --env (the plan asserts no parser change is needed). If
      // this fails, the plan is wrong and the seam Agent D plans to use
      // does not exist.
      const { parseArgs, getRepeatedFlag } = await import("@/lib/cli/argv");
      const parsed = parseArgs([
        "MYSECRET",
        "--repo",
        "r",
        "--env",
        "a",
        "--env",
        "b",
        "--env",
        "c",
      ]);
      const envs = getRepeatedFlag(parsed, "env");
      expect(envs).toEqual(["a", "b", "c"]);
    });

    it("parseArgs preserves single --env as a single value retrievable via getRepeatedFlag", async () => {
      // Backward-compat shape: a single --env still flows through
      // getRepeatedFlag as a length-1 array. The post-fix scope.ts then
      // short-circuits this to `env: string` on the wire.
      const { parseArgs, getRepeatedFlag, getStringFlag } = await import(
        "@/lib/cli/argv"
      );
      const parsed = parseArgs(["MYSECRET", "--repo", "r", "--env", "only"]);
      const envs = getRepeatedFlag(parsed, "env");
      expect(envs).toEqual(["only"]);
      // getStringFlag should still work for the existing single-env code path.
      expect(getStringFlag(parsed, "env")).toBe("only");
    });

    it("lib/cli/commands/scope.ts must short-circuit single-env to { env: envs[0] } (backward-compat wire shape)", () => {
      // The plan's "Risks > 1" calls out that single --env x MUST still send
      // `{ env: "x" }` (not `{ envs: ["x"] }`). The implementation must keep
      // this branch. We assert on the source to lock in the contract.
      const src = readRepo("lib/cli/commands/scope.ts");
      // Look for the length-1 short-circuit pattern.
      expect(src).toMatch(/envs\.length\s*===\s*1/);
      // And that the single-env branch still produces `env:` in the args.
      expect(src).toMatch(/env:\s*envs\[0\]/);
    });

    it("lib/cli/commands/scope.ts must forward multi-env as { envs } (parity with MCP scope_secret.envs)", () => {
      const src = readRepo("lib/cli/commands/scope.ts");
      // The multi-env branch sends `envs` (the array) to the daemon —
      // this matches MCP scope_secret's `envs: string[]` shape that the
      // daemon already accepts. Match by looking for an `args:` payload
      // containing `envs` (object shorthand or `envs:`).
      expect(src).toMatch(/args:\s*\{[^}]*envs\b/);
    });
  });

  // End-to-end test of the registered scope handler. The source-text
  // regex checks above can't catch a typo like `env: envs` that would
  // still "contain envs" but break the daemon contract. This block
  // drives the actual handler with a multi-env argv and asserts the
  // outgoing `sendCommand` payload shape verbatim.
  describe("sm scope CLI handler: outgoing sendCommand payload (E2E with mocked IPC)", () => {
    it("dispatches { secret, repo, envs: [...] } for multiple --env flags", async () => {
      vi.resetModules();
      const sendCommandMock = vi.fn(
        async (_req: unknown) => ({ ok: true as const }),
      );
      vi.doMock("@/lib/cli/ipc-client", () => ({
        sendCommand: sendCommandMock,
        lockedResponse: (message: string) => ({
          ok: false,
          code: "DAEMON_LOCKED",
          message,
        }),
      }));

      const { dispatchCommand } = await import("@/lib/cli/router");
      await dispatchCommand("scope", [
        "X",
        "--repo",
        "r",
        "--env",
        "a",
        "--env",
        "b",
      ]);

      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      expect(sendCommandMock.mock.calls[0][0]).toEqual({
        cmd: "scope",
        args: { secret: "X", repo: "r", envs: ["a", "b"] },
      });

      vi.doUnmock("@/lib/cli/ipc-client");
      vi.resetModules();
    });

    it("dispatches { secret, repo, env: '...' } (singular) for exactly one --env flag", async () => {
      vi.resetModules();
      const sendCommandMock = vi.fn(
        async (_req: unknown) => ({ ok: true as const }),
      );
      vi.doMock("@/lib/cli/ipc-client", () => ({
        sendCommand: sendCommandMock,
        lockedResponse: (message: string) => ({
          ok: false,
          code: "DAEMON_LOCKED",
          message,
        }),
      }));

      const { dispatchCommand } = await import("@/lib/cli/router");
      await dispatchCommand("scope", ["X", "--repo", "r", "--env", "only"]);

      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      expect(sendCommandMock.mock.calls[0][0]).toEqual({
        cmd: "scope",
        args: { secret: "X", repo: "r", env: "only" },
      });

      vi.doUnmock("@/lib/cli/ipc-client");
      vi.resetModules();
    });
  });
});
