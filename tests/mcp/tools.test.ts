/**
 * MCP server tools — integration test suite.
 *
 * Run:  pnpm test tests/mcp/tools.test.ts
 */

import { mkdtemp, writeFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import type { VaultData } from "@/lib/vault/schema";

import { callTool } from "../../mcp/tools/index";
import type { McpToolResult } from "../../mcp/server";

// ---------------------------------------------------------------------------
// Seed data shared across most tests
// ---------------------------------------------------------------------------
const SEED: VaultData = {
  version: 2,
  repos: [
    {
      id: "r1",
      name: "alpha",
      path: "/repos/alpha",
      environments: ["development", "production"],
    },
    {
      id: "r2",
      name: "beta",
      path: "/repos/beta",
      environments: ["development"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://user:pass@host:5432/db_high_entropy_value_xx",
      scopes: [
        { repoId: "r1", env: "development" },
        { repoId: "r1", env: "production" },
      ],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_AAAAAAAAAAAAAAAAAAAAAAAA",
      scopes: [{ repoId: "r2", env: "development" }],
    },
    {
      id: "s3",
      key: "API_KEY",
      namespace: "github",
      value: "short",
      scopes: [],
    },
    {
      id: "s4",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_BBBBBBBBBBBBBBBBBBBBBBBB",
      scopes: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------
let tmp: string;
let scratch: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-mcp-"));
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterAll(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
  await rm(scratch, { recursive: true, force: true });
});

/** Shorthand: call an MCP tool and return the parsed result. */
function tool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  return callTool(name, args, { socketPath: daemon!.socketPath });
}

/**
 * Parse the JSON payload embedded in the first text content block.
 * Throws an explicit error if no text block is present, so test failures
 * are not silently masked by an empty-object fallback.
 */
function parse(result: McpToolResult): unknown {
  const block = result.content.find((c) => c.type === "text");
  if (!block) {
    throw new Error(
      `parse(): McpToolResult contains no text content block. isError=${String(result.isError)}`,
    );
  }
  return JSON.parse(block.text);
}

/** Write a temp file and return its path. */
async function tmpFile(content: string): Promise<string> {
  const p = path.join(
    scratch,
    `v-${Math.random().toString(36).slice(2)}.txt`,
  );
  await writeFile(p, content, "utf8");
  return p;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("MCP tool handlers", () => {
  // 1. daemon_status — happy path
  it("daemon_status returns running status when daemon is up", async () => {
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    expect(data.running).toBe(true);
    // socketPath must NOT be present by default (verbose not set)
    expect(data).not.toHaveProperty("socketPath");
  });

  // 1b. daemon_status — socketPath exposed only when verbose:true
  it("daemon_status includes socketPath only when verbose:true", async () => {
    const result = await tool("daemon_status", { verbose: true });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    expect(data.running).toBe(true);
    expect(typeof data.socketPath).toBe("string");
  });

  // 2. list_repos — shape
  it("list_repos returns repos array with correct shape", async () => {
    const result = await tool("list_repos");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { repos: Array<Record<string, unknown>> };
    expect(Array.isArray(data.repos)).toBe(true);
    expect(data.repos).toHaveLength(2);
    const names = data.repos.map((r) => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    const alpha = data.repos.find((r) => r.name === "alpha")!;
    expect(Array.isArray(alpha.environments)).toBe(true);
    expect((alpha.environments as string[]).sort()).toEqual([
      "development",
      "production",
    ]);
  });

  // 3. list_secrets — NEVER includes `value`
  it("list_secrets NEVER includes value field (critical security invariant)", async () => {
    const result = await tool("list_secrets");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secrets: Array<Record<string, unknown>> };
    expect(Array.isArray(data.secrets)).toBe(true);
    for (const secret of data.secrets) {
      expect(secret).not.toHaveProperty("value");
    }
    // The raw serialised text must also be clean.
    const rawText = JSON.stringify(result);
    // None of the known seed values should appear verbatim.
    expect(rawText).not.toContain("postgres://user:pass");
    expect(rawText).not.toContain("sk_live_");
  });

  // 4. list_secrets — namespace filter
  it("list_secrets filters by namespace correctly", async () => {
    const result = await tool("list_secrets", { namespace: "github" });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secrets: Array<Record<string, unknown>> };
    expect(data.secrets).toHaveLength(1);
    expect(data.secrets[0].id).toBe("s3");
    expect(data.secrets[0].namespace).toBe("github");
  });

  // 5. describe_secret — returns valueFingerprint, not value
  it("describe_secret returns valueFingerprint not value", async () => {
    const result = await tool("describe_secret", { id: "s1" });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret).not.toHaveProperty("value");
    expect(typeof data.secret.valueFingerprint).toBe("string");
    // Fingerprint is a 16-char hex string as per existing daemon convention.
    expect(data.secret.valueFingerprint as string).toMatch(/^[a-f0-9]{16}$/);
    expect(data.secret.key).toBe("DATABASE_URL");
  });

  // 6. add_secret — ok:true, no value in response
  it("add_secret creates a secret with ok:true but no value in response", async () => {
    const vp = await tmpFile("brand-new-secret-token-AAAAAAA");
    const result = await tool("add_secret", {
      key: "NEW_SECRET",
      valuePath: vp,
      description: "Test fixture — verifies add_secret response shape.",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret.key).toBe("NEW_SECRET");
    expect(data.secret).not.toHaveProperty("value");
    expect(JSON.stringify(result)).not.toContain("brand-new-secret-token");
  });

  // 7. add_secret — temp file is cleaned up on success AND failure
  it("add_secret temp file is cleaned up after success and after failure", async () => {
    // Success path: temp file must be unlinked after daemon reads it.
    const vpSuccess = await tmpFile("secret-for-success-cleanup-AAAA");
    const ok = await tool("add_secret", {
      key: "CLEANUP_OK",
      valuePath: vpSuccess,
      description: "Test fixture — success-path temp-file cleanup check.",
    });
    expect(ok.isError).toBeFalsy();
    expect(await fileExists(vpSuccess)).toBe(false);

    // Failure path: invalid key — the MCP layer rejects before forwarding to
    // the daemon, so the daemon never reads the file. The file should still be
    // present (the MCP layer did not touch it on a validation error). The key
    // format check runs before the description check, so omitting `description`
    // here is intentional: we want the key-format error, not a description error.
    const vpFail = await tmpFile("secret-for-failure-cleanup-AAAA");
    const fail = await tool("add_secret", { key: "lowercase_invalid", valuePath: vpFail });
    expect(fail.isError).toBe(true);
    // On validation error, the MCP layer returns early before forwarding to the
    // daemon, so it never reads or deletes the file — the caller still owns it.
    expect(await fileExists(vpFail)).toBe(true);
  });

  // 8. set_value — updates without leaking value
  it("set_value updates a secret without leaking value in response", async () => {
    const vp = await tmpFile("updated-secret-value-AAAAAAAAA");
    const result = await tool("set_value", {
      secret: "DATABASE_URL",
      valuePath: vp,
    });
    expect(result.isError).toBeFalsy();
    const rawText = JSON.stringify(result);
    expect(rawText).not.toContain("updated-secret-value");
    expect(await fileExists(vp)).toBe(false);
  });

  // 9. scope_secret + unscope_secret round-trip
  it("scope_secret and unscope_secret round-trip correctly", async () => {
    // s3 / github API_KEY has no scopes initially.
    const scopeResult = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      env: "development",
    });
    expect(scopeResult.isError).toBeFalsy();
    const afterScope = parse(scopeResult) as {
      secret: { scopes: Array<{ repoId: string; env: string }> };
    };
    expect(
      afterScope.secret.scopes.some(
        (sc) => sc.env === "development",
      ),
    ).toBe(true);

    // Now unscope it.
    const unscopeResult = await tool("unscope_secret", {
      secret: "s3",
      repo: "alpha",
      env: "development",
    });
    expect(unscopeResult.isError).toBeFalsy();
    const afterUnscope = parse(unscopeResult) as {
      secret: { scopes: Array<unknown> };
    };
    expect(afterUnscope.secret.scopes).toEqual([]);
  });

  // 10. deploy with dryRun:true returns plan without writing files
  it("deploy with dryRun:true returns a plan without writing files", async () => {
    const result = await tool("deploy", { dryRun: true });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as {
      dryRun: boolean;
      results: Array<Record<string, unknown>>;
    };
    expect(data.dryRun).toBe(true);
    expect(Array.isArray(data.results)).toBe(true);
    // Each plan entry should describe what would be written, not the values.
    for (const entry of data.results) {
      expect(entry).not.toHaveProperty("value");
    }
  });

  // 11. No tool response contains excessively long opaque strings
  it("no tool response contains strings longer than 200 chars in a clean response", async () => {
    const readOnlyTools: Array<[string, Record<string, unknown>]> = [
      ["daemon_status", {}],
      ["list_repos", {}],
      ["list_secrets", {}],
      ["list_scopes", {}],
      ["describe_secret", { id: "s1" }],
      ["find_shared", {}],
    ];

    function collectLongStrings(node: unknown, prefix = "$"): string[] {
      const hits: string[] = [];
      if (typeof node === "string" && node.length > 200) {
        hits.push(`${prefix}=${node.slice(0, 40)}…`);
      } else if (Array.isArray(node)) {
        node.forEach((child, i) =>
          hits.push(...collectLongStrings(child, `${prefix}[${i}]`)),
        );
      } else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(
          node as Record<string, unknown>,
        )) {
          hits.push(...collectLongStrings(v, `${prefix}.${k}`));
        }
      }
      return hits;
    }

    for (const [toolName, args] of readOnlyTools) {
      const result = await tool(toolName, args);
      if (result.isError) continue; // skip error responses for this check
      const data = parse(result);
      const offenders = collectLongStrings(data);
      expect(
        offenders,
        `tool "${toolName}" returned long strings: ${offenders.join(", ")}`,
      ).toEqual([]);
    }
  });

  // 13. Invalid inputs return isError:true with meaningful message
  it("invalid inputs return isError:true with meaningful message", async () => {
    // Completely unknown tool name.
    const unknown = await tool("this_tool_does_not_exist");
    expect(unknown.isError).toBe(true);
    const unknownText = unknown.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(unknownText.length).toBeGreaterThan(0);

    // Known tool, invalid argument.
    const badNs = await tool("list_secrets", { namespace: "Bad-Namespace" });
    expect(badNs.isError).toBe(true);
    const badNsText = badNs.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(badNsText.length).toBeGreaterThan(0);

    // describe_secret with a non-existent id.
    const notFound = await tool("describe_secret", { id: "DOES_NOT_EXIST" });
    expect(notFound.isError).toBe(true);
  });

  // 14. validateValuePath — symlink/escape protection
  describe("valuePath validation rejects paths outside tmpdir", () => {
    it("accepts a regular file inside tmpdir", async () => {
      // Positive control: tmpFile() lives inside the per-test scratch dir,
      // which is under tmpdir(). Establishes the negative cases below aren't
      // failing for unrelated reasons.
      const vp = await tmpFile("ok-value-inside-tmp-AAAAAAAA");
      const result = await tool("add_secret", {
        key: "PATH_OK",
        valuePath: vp,
        description: "Test fixture — valuePath positive-control check.",
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects a raw absolute path outside tmpdir (e.g. /etc/passwd)", async () => {
      const result = await tool("add_secret", {
        key: "ESCAPE_RAW",
        valuePath: "/etc/passwd",
      });
      expect(result.isError).toBe(true);
      const text = result.content.map((c) => c.text).join("");
      expect(text).toMatch(/temp directory|valuePath/i);
    });

    it("rejects a symlink inside tmpdir that points to a file outside tmpdir", async () => {
      // Create a target outside tmpdir — use the daemon's vault dir, which we
      // know exists and is outside tmpdir().
      const linkPath = path.join(scratch, `escape-link-${Math.random().toString(36).slice(2)}`);
      // Point the symlink at /etc/passwd — an existing file outside tmpdir on
      // every POSIX system. realpath() will resolve it, validation must reject.
      await symlink("/etc/passwd", linkPath);

      const result = await tool("add_secret", {
        key: "ESCAPE_SYM",
        valuePath: linkPath,
      });
      expect(result.isError).toBe(true);
      const text = result.content.map((c) => c.text).join("");
      expect(text).toMatch(/temp directory|valuePath/i);

      // Clean up the symlink we created.
      await rm(linkPath, { force: true });
    });
  });

  // ── NEW TESTS for issue #34: set_description + description forwarding ────

  // 15. set_description — sets a description without touching the value
  it("set_description sets a description without touching the value", async () => {
    const result = await tool("set_description", {
      secret: "s1",
      description: "Describes the primary database connection",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret.description).toBe(
      "Describes the primary database connection",
    );
    // Value must never appear in any response.
    expect(data.secret).not.toHaveProperty("value");
    expect(JSON.stringify(result)).not.toContain(
      "postgres://user:pass",
    );
  });

  // 16. set_description with empty string clears description (field absent)
  it("set_description with empty string clears description (field absent)", async () => {
    // First, give s1 a description to clear.
    await tool("set_description", {
      secret: "s1",
      description: "To be cleared",
    });

    const result = await tool("set_description", {
      secret: "s1",
      description: "",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    // The vault schema enforces min(1) on description, so empty string must
    // mean "clear": the field should be absent, not present as "".
    expect(data.secret).not.toHaveProperty("description");
  });

  // 17. set_description with unset:true clears description
  it("set_description with unset:true clears description", async () => {
    // First, give s1 a description to clear.
    await tool("set_description", {
      secret: "s1",
      description: "To be unset",
    });

    const result = await tool("set_description", {
      secret: "s1",
      unset: true,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret).not.toHaveProperty("description");
  });

  // 18. set_description returns error for nonexistent secret
  it("set_description returns error for nonexistent secret", async () => {
    const result = await tool("set_description", {
      secret: "DOES_NOT_EXIST",
      description: "irrelevant",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 19. set_description rejects description longer than 500 chars
  it("set_description rejects description longer than 500 chars", async () => {
    const result = await tool("set_description", {
      secret: "s1",
      description: "X".repeat(501),
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 20. set_description returns error when neither description nor unset is supplied
  it("set_description returns error when neither description nor unset is supplied", async () => {
    const result = await tool("set_description", { secret: "s1" });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 21. add_secret forwards description to daemon
  it("add_secret forwards description to daemon", async () => {
    const vp = await tmpFile("new-secret-value-AAAAAAAAAA");
    const result = await tool("add_secret", {
      key: "DESCRIBED_SECRET",
      valuePath: vp,
      description: "Created with a description",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret.key).toBe("DESCRIBED_SECRET");
    // The description must be forwarded through the MCP → daemon path and
    // reflected back in the response.
    expect(data.secret.description).toBe("Created with a description");
    expect(data.secret).not.toHaveProperty("value");
  });

  // 22. set_value forwards description to daemon
  it("set_value forwards description to daemon", async () => {
    const vp = await tmpFile("updated-db-value-AAAAAAAAA");
    const result = await tool("set_value", {
      secret: "s1",
      valuePath: vp,
      description: "Updated description via set_value",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    // The description must be forwarded and reflected in the response.
    expect(data.secret.description).toBe("Updated description via set_value");
    expect(data.secret).not.toHaveProperty("value");
  });

  // 23. describe_secret includes description when previously set via set_description
  it("describe_secret includes description field when previously set via set_description", async () => {
    // Set a description first.
    const setResult = await tool("set_description", {
      secret: "s1",
      description: "Readable description for describe_secret test",
    });
    expect(setResult.isError).toBeFalsy();

    // Now describe_secret must return the description.
    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const data = parse(descResult) as { secret: Record<string, unknown> };
    expect(data.secret.description).toBe(
      "Readable description for describe_secret test",
    );
    expect(data.secret).not.toHaveProperty("value");
  });

  // 24. list_secrets includes description field when set
  it("list_secrets includes description field when set", async () => {
    // Set a description on s1.
    await tool("set_description", {
      secret: "s1",
      description: "Listed description",
    });

    const result = await tool("list_secrets");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secrets: Array<Record<string, unknown>> };
    const s1 = data.secrets.find((sec) => sec.id === "s1");
    expect(s1).toBeDefined();
    expect(s1!.description).toBe("Listed description");
    // Value must never appear.
    expect(s1!).not.toHaveProperty("value");
  });

  // 25. set_description rejects when both unset:true and description are provided
  it("set_description returns error when both unset:true and description are provided", async () => {
    const result = await tool("set_description", {
      secret: "s1",
      description: "some description",
      unset: true,
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 26. add_secret returns error when description exceeds 500 chars
  it("add_secret returns error when description exceeds 500 chars", async () => {
    const vp = await tmpFile("some-secret-value-AAAAAAAAA");
    const result = await tool("add_secret", {
      key: "LONG_DESC_SECRET",
      valuePath: vp,
      description: "X".repeat(501),
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 27. set_value returns error when description exceeds 500 chars
  it("set_value returns error when description exceeds 500 chars", async () => {
    const vp = await tmpFile("updated-secret-value-AAAAAA");
    const result = await tool("set_value", {
      secret: "s1",
      valuePath: vp,
      description: "Y".repeat(501),
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // ── NEW TESTS for issue #45: scope_secret envs array + scope_secrets_bulk ──

  // 28. scope_secret with `envs` array fans out across multiple envs
  it("scope_secret with envs array fans out across multiple envs", async () => {
    // s3 (github API_KEY) has no scopes; fan out to both alpha envs.
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { results: Array<{ env: string; status: string }> };
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(2);
    const statuses = data.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["scoped", "scoped"]);
    const envs = data.results.map((r) => r.env).sort();
    expect(envs).toEqual(["development", "production"]);
    // Restore s3 to no-scopes so subsequent tests start with a clean slate.
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "development" });
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "production" });
  });

  // 29. scope_secret with `envs` is idempotent on re-add
  it("scope_secret with envs is idempotent on re-add", async () => {
    // s1 already has development + production scoped in alpha.
    const result = await tool("scope_secret", {
      secret: "s1",
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { results: Array<{ env: string; status: string }> };
    expect(Array.isArray(data.results)).toBe(true);
    // Both should report "unchanged" since they're already scoped.
    for (const row of data.results) {
      expect(row.status).toBe("unchanged");
    }
  });

  // 30. scope_secret backward-compat — singular `env` still works but returns results array
  it("scope_secret backward-compat: singular env still works and returns results array", async () => {
    // s3 has no scopes; scope it with singular env.
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      env: "development",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { results: Array<{ env: string; status: string }> };
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.env).toBe("development");
    expect(data.results[0]!.status).toBe("scoped");
    // Restore s3 to no-scopes so subsequent tests start with a clean slate.
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "development" });
  });

  // 31. scope_secret with `envs` — partial failure (one unknown env)
  it("scope_secret with envs: partial failure when one env is unknown for repo", async () => {
    // "alpha" has development and production, not "staging".
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      envs: ["development", "staging"],
    });
    // isError stays false — caller inspects results[*].status
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { results: Array<{ env: string; status: string; code?: string }> };
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(2);
    const dev = data.results.find((r) => r.env === "development");
    const staging = data.results.find((r) => r.env === "staging");
    expect(dev?.status).toBe("scoped");
    expect(staging?.status).toBe("error");
    // Restore s3: dev scope was added, staging was rejected. Remove dev.
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "development" });
  });

  // 32. scope_secret with empty `envs` array returns isError=true
  it("scope_secret with empty envs array returns isError=true", async () => {
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      envs: [],
    });
    expect(result.isError).toBe(true);
  });

  // 33. scope_secret with `envs` containing a non-string returns isError=true
  it("scope_secret with envs containing a non-string returns isError=true", async () => {
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      envs: ["development", 42],
    });
    expect(result.isError).toBe(true);
  });

  // 34. scope_secret returns error when neither `env` nor `envs` supplied
  it("scope_secret returns error when neither env nor envs is supplied", async () => {
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 34b. scope_secret rejects when both env and envs are provided (from PR #50)
  it("scope_secret rejects when both env and envs are provided", async () => {
    const result = await tool("scope_secret", {
      secret: "s3",
      repo: "alpha",
      env: "development",
      envs: ["development", "production"],
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 35. scope_secrets_bulk fans out N secrets × E envs
  it("scope_secrets_bulk fans out N secrets × E envs", async () => {
    // s3 (github) has no scopes; s2 (stripe) is only in beta/development.
    // Bulk scope both into alpha's two envs.
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s3"],
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as {
      results: Array<{ secret: string; env: string; status: string }>;
    };
    expect(Array.isArray(data.results)).toBe(true);
    // 1 secret × 2 envs = 2 rows
    expect(data.results).toHaveLength(2);
    for (const row of data.results) {
      expect(row.secret).toBe("s3");
      expect(row.status).toBe("scoped");
    }
    const envs = data.results.map((r) => r.env).sort();
    expect(envs).toEqual(["development", "production"]);
    // Restore s3 to no-scopes so subsequent tests start with a clean slate.
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "development" });
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "production" });
  });

  // 36. scope_secrets_bulk is idempotent
  it("scope_secrets_bulk is idempotent on re-add", async () => {
    // s1 already has both alpha envs scoped.
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s1"],
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as {
      results: Array<{ secret: string; env: string; status: string }>;
    };
    expect(Array.isArray(data.results)).toBe(true);
    for (const row of data.results) {
      expect(row.status).toBe("unchanged");
    }
  });

  // 37. scope_secrets_bulk partial failure — unknown secret emits error rows per env
  it("scope_secrets_bulk partial failure: unknown secret emits error rows per env", async () => {
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s3", "DOES_NOT_EXIST"],
      repo: "alpha",
      envs: ["development"],
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as {
      results: Array<{ secret: string; env: string; status: string; code?: string }>;
    };
    expect(Array.isArray(data.results)).toBe(true);
    // 2 secrets × 1 env = 2 rows
    expect(data.results).toHaveLength(2);
    const s3Row = data.results.find((r) => r.secret === "s3");
    const missingRow = data.results.find((r) => r.secret === "DOES_NOT_EXIST");
    expect(s3Row?.status).toBe("scoped");
    expect(missingRow?.status).toBe("error");
    // Restore s3 to no-scopes so subsequent tests start with a clean slate.
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "development" });
  });

  // 38. scope_secrets_bulk partial failure — CONFLICT emits error row but continues
  it("scope_secrets_bulk partial failure: CONFLICT emits error row but continues", async () => {
    // s2 (stripe/API_KEY) is already scoped to beta/development.
    // s4 shares the same key AND namespace (stripe/API_KEY), so scoping it
    // to the same cell (beta, development) must produce a CONFLICT row.
    // isError stays false — partial-failure semantics.
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s4"],
      repo: "beta",
      envs: ["development"],
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as {
      results: Array<{ secret: string; env: string; status: string; code?: string }>;
    };
    expect(Array.isArray(data.results)).toBe(true);
    const conflictRow = data.results.find(
      (r) => r.secret === "s4" && r.env === "development",
    );
    expect(conflictRow?.status).toBe("error");
  });

  // 39. scope_secrets_bulk validates input — empty secrets array returns isError=true
  it("scope_secrets_bulk: empty secrets array returns isError=true", async () => {
    const result = await tool("scope_secrets_bulk", {
      secrets: [],
      repo: "alpha",
      envs: ["development"],
    });
    expect(result.isError).toBe(true);
  });

  // 40. scope_secrets_bulk validates input — empty envs array returns isError=true
  it("scope_secrets_bulk: empty envs array returns isError=true", async () => {
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s3"],
      repo: "alpha",
      envs: [],
    });
    expect(result.isError).toBe(true);
  });

  // 41. scope_secrets_bulk validates input — missing repo returns isError=true
  it("scope_secrets_bulk: missing repo returns isError=true", async () => {
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s3"],
      envs: ["development"],
    });
    expect(result.isError).toBe(true);
  });

  // 42. scope_secrets_bulk — response never contains `value` field (security invariant)
  it("scope_secrets_bulk: response never contains value field", async () => {
    const result = await tool("scope_secrets_bulk", {
      secrets: ["s3"],
      repo: "alpha",
      envs: ["development", "production"],
    });
    expect(result.isError).toBeFalsy();
    const rawText = JSON.stringify(result);
    // Known seed values must not appear verbatim.
    expect(rawText).not.toContain("postgres://user:pass");
    expect(rawText).not.toContain("sk_live_");
    // No `value` key anywhere in the JSON.
    const data = parse(result);
    function hasValueField(node: unknown): boolean {
      if (Array.isArray(node)) return node.some(hasValueField);
      if (node !== null && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if ("value" in obj) return true;
        return Object.values(obj).some(hasValueField);
      }
      return false;
    }
    expect(hasValueField(data)).toBe(false);
    // Restore s3 to no-scopes so subsequent tests start with a clean slate.
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "development" });
    await tool("unscope_secret", { secret: "s3", repo: "alpha", env: "production" });
  });

  // ── NEW TESTS for issue #83: update_repo_path MCP tool ──────────────────

  // 43. update_repo_path updates the path and reflects in list_repos
  it("update_repo_path updates the path and reflects in list_repos", async () => {
    const result = await tool("update_repo_path", {
      target: "alpha",
      path: "/new/path/alpha",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { repo: Record<string, unknown> };
    expect(data.repo.name).toBe("alpha");
    expect(data.repo.path).toBe("/new/path/alpha");

    // list_repos must reflect the new path.
    const listResult = await tool("list_repos");
    expect(listResult.isError).toBeFalsy();
    const listData = parse(listResult) as {
      repos: Array<Record<string, unknown>>;
    };
    const alpha = listData.repos.find((r) => r.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.path).toBe("/new/path/alpha");
  });

  // 44. update_repo_path accepts `id` alias for backward compatibility
  it("update_repo_path accepts id alias for backward compatibility", async () => {
    const result = await tool("update_repo_path", {
      id: "alpha",
      path: "/another/new/path",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { repo: Record<string, unknown> };
    expect(data.repo.name).toBe("alpha");
    expect(data.repo.path).toBe("/another/new/path");
  });

  // 45. update_repo_path leaves scopes and secrets intact
  it("update_repo_path leaves scopes and secrets intact", async () => {
    // Capture scopes for s1 (which is scoped to alpha/development + alpha/production) before.
    const beforeScopes = parse(await tool("list_scopes")) as {
      scopes: Array<{ repo: string; env: string; secrets: unknown[] }>;
    };
    // Find the alpha rows.
    const alphaScopesBefore = beforeScopes.scopes
      .filter((s) => s.repo === "alpha")
      .map((s) => ({ env: s.env, count: s.secrets.length }))
      .sort((a, b) => a.env.localeCompare(b.env));

    // Change the path.
    const upd = await tool("update_repo_path", {
      target: "alpha",
      path: "/relocated/alpha",
    });
    expect(upd.isError).toBeFalsy();

    // Scopes for alpha must be unchanged.
    const afterScopes = parse(await tool("list_scopes")) as {
      scopes: Array<{ repo: string; env: string; secrets: unknown[] }>;
    };
    const alphaScopesAfter = afterScopes.scopes
      .filter((s) => s.repo === "alpha")
      .map((s) => ({ env: s.env, count: s.secrets.length }))
      .sort((a, b) => a.env.localeCompare(b.env));
    expect(alphaScopesAfter).toEqual(alphaScopesBefore);

    // describe_secret on s1 must still work and must NEVER include `value`.
    const desc = await tool("describe_secret", { id: "s1" });
    expect(desc.isError).toBeFalsy();
    const descData = parse(desc) as { secret: Record<string, unknown> };
    expect(descData.secret.key).toBe("DATABASE_URL");
    expect(descData.secret).not.toHaveProperty("value");
  });

  // 46. update_repo_path does NOT require the new path to exist on disk
  it("update_repo_path does NOT require the new path to exist on disk", async () => {
    const result = await tool("update_repo_path", {
      target: "alpha",
      path: "/ghost/path/that/does/not/exist",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { repo: Record<string, unknown> };
    expect(data.repo.path).toBe("/ghost/path/that/does/not/exist");
  });

  // 47. update_repo_path returns isError when target/id is missing
  it("update_repo_path returns isError when target/id is missing", async () => {
    const result = await tool("update_repo_path", { path: "/some/path" });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/target|id/i);
  });

  // 48. update_repo_path returns isError when path is missing
  it("update_repo_path returns isError when path is missing", async () => {
    const result = await tool("update_repo_path", { target: "alpha" });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    // The error message must explain that `path` is required/missing —
    // not just include the substring "path" from echoing the tool name.
    expect(text).not.toMatch(/Unknown tool/);
    expect(text.toLowerCase()).toMatch(/path/);
    expect(text.toLowerCase()).toMatch(/required|missing/);
  });

  // 49. update_repo_path returns isError when path is relative
  it("update_repo_path returns isError when path is relative", async () => {
    const result = await tool("update_repo_path", {
      target: "alpha",
      path: "relative/no/slash",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/absolute|must start with \//i);
  });

  // 50. update_repo_path returns isError when path contains null byte
  it("update_repo_path returns isError when path contains null byte", async () => {
    const result = await tool("update_repo_path", {
      target: "alpha",
      path: "/has/null\0byte",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/null/i);
  });

  // 51. update_repo_path returns isError (NOT_FOUND) for unknown repo
  it("update_repo_path returns isError (NOT_FOUND) for unknown repo", async () => {
    const result = await tool("update_repo_path", {
      target: "nonexistent",
      path: "/x/y/z",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("NOT_FOUND");
  });

  // 52. update_repo_path precedence — `target` wins when both `target` and `id`
  // are supplied with different values. Mirrors the precedence in the
  // dispatcher (`args.target ?? args.id`).
  it("update_repo_path: target wins when both target and id are supplied", async () => {
    const result = await tool("update_repo_path", {
      target: "alpha",
      id: "beta",
      path: "/precedence/alpha",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { repo: Record<string, unknown> };
    // `target` (alpha) must win over `id` (beta).
    expect(data.repo.name).toBe("alpha");
    expect(data.repo.path).toBe("/precedence/alpha");

    // Confirm via list_repos that beta is untouched.
    const list = parse(await tool("list_repos")) as {
      repos: Array<Record<string, unknown>>;
    };
    const beta = list.repos.find((r) => r.name === "beta");
    expect(beta).toBeDefined();
    expect(beta!.path).toBe("/repos/beta");

    // Restore alpha's path so subsequent tests that rely on `/repos/alpha` are
    // not broken by the state mutation above.
    await tool("update_repo_path", { target: "alpha", path: "/repos/alpha" });
  });

  // 53. update_repo_path with empty-string target returns isError with the
  // same "target is required" message as missing-target.
  it("update_repo_path with empty-string target returns isError (same as missing)", async () => {
    const result = await tool("update_repo_path", {
      target: "",
      path: "/some/path",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/target|id/i);
    expect(text.toLowerCase()).toMatch(/required/);
  });

  // 54. update_repo_path is a no-op (success) when called with the SAME path
  // the repo already has — the path is unchanged and no error is returned.
  it("update_repo_path is a no-op when called with the repo's current path", async () => {
    // Capture the repo's current path via list_repos.
    const before = parse(await tool("list_repos")) as {
      repos: Array<Record<string, unknown>>;
    };
    const alphaBefore = before.repos.find((r) => r.name === "alpha");
    expect(alphaBefore).toBeDefined();
    const currentPath = alphaBefore!.path as string;

    // Update with the exact same path.
    const result = await tool("update_repo_path", {
      target: "alpha",
      path: currentPath,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { repo: Record<string, unknown> };
    expect(data.repo.path).toBe(currentPath);

    // Confirm via list_repos that the path is unchanged.
    const after = parse(await tool("list_repos")) as {
      repos: Array<Record<string, unknown>>;
    };
    const alphaAfter = after.repos.find((r) => r.name === "alpha");
    expect(alphaAfter).toBeDefined();
    expect(alphaAfter!.path).toBe(currentPath);
  });

  // 55. update_repo_path returns CONFLICT when new path is already registered
  // to a different repo. Post-condition: alpha's path must be unchanged.
  it("update_repo_path returns CONFLICT when new path is already registered to a different repo", async () => {
    const result = await tool("update_repo_path", {
      target: "alpha",
      path: "/repos/beta",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("CONFLICT");

    // Post-condition: alpha's path must be unchanged after a CONFLICT error.
    const list = parse(await tool("list_repos")) as {
      repos: Array<Record<string, unknown>>;
    };
    const alpha = list.repos.find((r) => r.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.path).toBe("/repos/alpha");
  });
});

// ---------------------------------------------------------------------------
// Issue #114 (OROBOROUS): MCP add_secret must reject dotenvx-reserved keys.
// These tests are RED until mcp/tools/index.ts adds the isDotenvxReservedKey
// guard to the add_secret case.
// ---------------------------------------------------------------------------
describe("MCP add_secret — dotenvx reserved-key rejection (issue #114 OROBOROUS)", () => {
  // 12. MCP add_secret with key = "DOTENV_PUBLIC_KEY_PRODUCTION" → error result
  //     containing "dotenvx-internal" (or similar).
  it('add_secret with key "DOTENV_PUBLIC_KEY_PRODUCTION" returns isError with dotenvx-related message', async () => {
    const vp = await tmpFile("03abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab");
    const result = await tool("add_secret", {
      key: "DOTENV_PUBLIC_KEY_PRODUCTION",
      valuePath: vp,
      description: "Test fixture — issue #114 dotenvx public-key rejection.",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
    // The error message must mention dotenvx or "internal" to guide the caller.
    expect(text).toMatch(/dotenvx[-_]?internal|dotenvx|reserved/i);
  });

  // 13. MCP add_secret with key = "DOTENV_PRIVATE_KEY_STAGING" → error result.
  it('add_secret with key "DOTENV_PRIVATE_KEY_STAGING" returns isError', async () => {
    const vp = await tmpFile("aabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabbccddeeaabb");
    const result = await tool("add_secret", {
      key: "DOTENV_PRIVATE_KEY_STAGING",
      valuePath: vp,
      description: "Test fixture — issue #114 dotenvx private-key rejection.",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // Regression: a normal key must still work after the guard is in place.
  it('add_secret with a normal key "REGULAR_SECRET" still succeeds (no regression)', async () => {
    const vp = await tmpFile("sk_live_not_a_dotenvx_key_AAAAAAA");
    const result = await tool("add_secret", {
      key: "REGULAR_SECRET",
      valuePath: vp,
      description: "Test fixture — issue #114 regression guard.",
    });
    // This test should PASS even before the fix (normal key accepted).
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret.key).toBe("REGULAR_SECRET");
  });
});

// ---------------------------------------------------------------------------
// Daemon-down tests — each test kills its own isolated daemon.
// These run in their own describe with beforeEach/afterEach so they don't
// disrupt the shared daemon used by the main "MCP tool handlers" suite.
// ---------------------------------------------------------------------------
describe("MCP tool handlers — daemon-down scenarios", () => {
  let isolatedTmp: string;
  let isolatedDaemon: SpawnedDaemon | null = null;

  beforeEach(async () => {
    isolatedTmp = await makeVaultDir();
    await seedVault(isolatedTmp, SEED, DEFAULT_PASSWORD);
    isolatedDaemon = await startDaemon({ vaultDir: isolatedTmp });
    await isolatedDaemon.ready;
  });

  afterEach(async () => {
    if (isolatedDaemon) {
      await isolatedDaemon.kill();
      isolatedDaemon = null;
    }
    await cleanupVaultDir(isolatedTmp);
  });

  // 12. daemon_status returns structured { running: false } when daemon is not running
  it("daemon_status returns structured { running: false } when daemon is not running", async () => {
    await isolatedDaemon!.kill();
    isolatedDaemon = null;

    const result = await callTool(
      "daemon_status",
      {},
      { socketPath: path.join(isolatedTmp, "sm.sock") },
    );
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    expect(data.running).toBe(false);
  });

  // 12b. DAEMON_LOCKED error message on non-daemon_status MCP calls does not instruct agents to run sm-daemon start
  it("DAEMON_LOCKED error message on non-status tools does not instruct agents to run sm-daemon start", async () => {
    if (isolatedDaemon) { await isolatedDaemon.kill(); isolatedDaemon = null; }

    const result = await callTool(
      "list_repos",
      {},
      { socketPath: path.join(isolatedTmp, "sm.sock") },
    );
    expect(result.isError).toBe(true);
    const rawText = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(rawText).not.toMatch(/sm-daemon start/i);
    expect(rawText.toLowerCase()).toMatch(/human|user|surface/i);
  });

  // 12c. daemon_status structured response when daemon is locked does not mention sm-daemon start
  it("daemon_status structured response when locked does not mention sm-daemon start", async () => {
    if (isolatedDaemon) { await isolatedDaemon.kill(); isolatedDaemon = null; }

    const result = await callTool(
      "daemon_status",
      {},
      { socketPath: path.join(isolatedTmp, "sm.sock") },
    );
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    expect(data.running).toBe(false);
    expect(data.locked).toBe(true);
    const rawText = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(rawText).not.toMatch(/sm-daemon start/i);
  });
});
