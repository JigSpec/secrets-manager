/**
 * MCP security invariant — no tool response ever emits a plaintext secret.
 *
 * This file mirrors tests/cli/never-emits-value.test.ts but exercises the MCP
 * tool layer instead of the daemon's IPC socket directly.
 *
 * These tests FAIL until the implementation under mcp/ is written.
 * Imports that don't exist yet:
 *   - ../../mcp/tools/index
 *   - ../../mcp/server
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import type { VaultData } from "@/lib/vault/schema";

// ── Imports that do not exist yet ────────────────────────────────────────────
import { callTool } from "../../mcp/tools/index";
import type { McpToolResult } from "../../mcp/server";
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A high-entropy sentinel that is used as every secret's plaintext value in
 * the seed vault. Any occurrence of this string in an MCP tool response is a
 * security violation.
 */
const SENTINEL = "SENTINEL_VALUE_DO_NOT_LEAK_MCP_X9k7mZpQ2vW8nLrT4HfYjB";

// ---------------------------------------------------------------------------
// Seed factory
// ---------------------------------------------------------------------------
function makeSeed(repoPath: string): VaultData {
  return {
    version: 2,
    repos: [
      {
        id: "r1",
        name: "alpha",
        path: repoPath,
        environments: ["development", "production"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "DATABASE_URL",
        value: SENTINEL,
        scopes: [{ repoId: "r1", env: "development" }],
      },
      {
        id: "s2",
        key: "API_KEY",
        namespace: "stripe",
        value: SENTINEL,
        scopes: [{ repoId: "r1", env: "development" }],
      },
      {
        id: "s3",
        key: "API_KEY",
        namespace: "github",
        value: SENTINEL,
        scopes: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------
let tmp: string;
let scratch: string;
let realRepo: string;
let daemon: SpawnedDaemon | null = null;

beforeEach(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-mcp-sentinel-"));
  realRepo = await mkdtemp(path.join(tmpdir(), "sm-mcp-repo-"));
  await seedVault(tmp, makeSeed(realRepo), DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
  await rm(scratch, { recursive: true, force: true });
  await rm(realRepo, { recursive: true, force: true });
});

/** Call a tool and return the raw McpToolResult. */
function t(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  return callTool(name, args, { socketPath: daemon!.socketPath });
}

/** Write a sentinel-valued temp file; return its path. */
async function sentinelFile(): Promise<string> {
  const p = path.join(
    scratch,
    `sv-${Math.random().toString(36).slice(2)}.txt`,
  );
  await writeFile(p, SENTINEL, "utf8");
  return p;
}

/**
 * Recursively walk a parsed JSON value and collect every string that equals
 * or contains the sentinel.
 */
function findLeaks(
  node: unknown,
  prefix = "$",
): Array<{ path: string; value: string }> {
  const hits: Array<{ path: string; value: string }> = [];
  if (typeof node === "string") {
    if (node.includes(SENTINEL)) hits.push({ path: prefix, value: node });
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) =>
      hits.push(...findLeaks(child, `${prefix}[${i}]`)),
    );
    return hits;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      hits.push(...findLeaks(v, `${prefix}.${k}`));
    }
  }
  return hits;
}

/**
 * Assert that a tool result contains no leaked sentinel — either in the
 * structured content fields or in the raw serialised form.
 */
function assertNoLeak(toolName: string, result: McpToolResult): void {
  // 1. Raw JSON serialisation check (catches any field, any nesting).
  const raw = JSON.stringify(result);
  expect(
    raw.includes(SENTINEL),
    `tool "${toolName}" leaked sentinel in raw JSON: ${raw.slice(0, 200)}`,
  ).toBe(false);

  // 2. Structural walk of the parsed text payload.
  for (const block of result.content) {
    if (block.type !== "text") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      // Non-JSON text block — check the raw string.
      expect(
        block.text.includes(SENTINEL),
        `tool "${toolName}" leaked sentinel in text block: ${block.text.slice(0, 200)}`,
      ).toBe(false);
      continue;
    }
    const leaks = findLeaks(parsed);
    expect(
      leaks,
      `tool "${toolName}" leaked sentinel in parsed payload: ${JSON.stringify(leaks)}`,
    ).toEqual([]);
  }
}

// ---------------------------------------------------------------------------
// Shared helper — recursively check for a field named 'value' in any object.
// Extracted here to avoid duplicating the same function in every sub-test.
// ---------------------------------------------------------------------------
function hasValueKey(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasValueKey);
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, "value")) return true;
  return Object.values(obj).some(hasValueKey);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe("MCP tools never emit plaintext secret values", () => {
  it(
    "every MCP tool response is free of the sentinel plaintext value",
    async () => {
      // We collect (name, result) pairs so a single assertion failure names
      // the offending tool.
      const records: Array<{ name: string; result: McpToolResult }> = [];
      const run = async (
        name: string,
        args: Record<string, unknown> = {},
      ) => {
        const result = await t(name, args);
        records.push({ name, result });
        return result;
      };

      // ── Read surface ──────────────────────────────────────────────────────
      await run("daemon_status");
      await run("list_repos");
      await run("list_secrets");
      await run("list_secrets", { namespace: "stripe" });
      await run("list_scopes");
      await run("describe_secret", { id: "DATABASE_URL" });
      await run("describe_secret", { id: "s2" });
      await run("find_shared");

      // ── Structural mutations ───────────────────────────────────────────────
      await run("scope_secret", {
        secret: "s3",
        repo: "alpha",
        env: "production",
      });
      await run("unscope_secret", {
        secret: "s3",
        repo: "alpha",
        env: "production",
      });
      await run("set_namespace", { secret: "s3", namespace: "twilio" });
      await run("set_namespace", { secret: "s3", unset: true });
      await run("rename_secret", {
        secret: "DATABASE_URL",
        newKey: "DB_URL",
      });
      await run("rename_secret", { secret: "DB_URL", newKey: "DATABASE_URL" });

      // ── Repo CRUD ─────────────────────────────────────────────────────────
      const extraRepo = await mkdtemp(path.join(tmpdir(), "sm-extra-repo-"));
      try {
        await run("add_repo", {
          name: "gamma",
          path: extraRepo,
          environments: ["development"],
        });
        await run("set_repo_envs", {
          target: "gamma",
          environments: ["development", "staging"],
        });
        await run("update_repo_path", {
          target: "alpha",
          path: "/new/path/alpha",
        });
        await run("remove_repo", { target: "gamma" });
      } finally {
        await rm(extraRepo, { recursive: true, force: true });
      }

      // ── Value-bearing mutations ────────────────────────────────────────────
      const f1 = await sentinelFile();
      await run("add_secret", { key: "NEW_KEY", valuePath: f1 });

      const f2 = await sentinelFile();
      await run("add_secret", {
        key: "ANOTHER_KEY",
        namespace: "stripe",
        valuePath: f2,
      });

      const f3 = await sentinelFile();
      await run("set_value", { secret: "DATABASE_URL", valuePath: f3 });

      await run("remove_secret", { target: "NEW_KEY" });

      // ── Deploy (dry-run) ──────────────────────────────────────────────────
      await run("deploy", { dryRun: true });
      await run("deploy", { dryRun: true, repo: "alpha" });
      await run("deploy", { dryRun: true, repo: "alpha", env: "development" });

      // ── Assertions ────────────────────────────────────────────────────────
      for (const { name, result } of records) {
        assertNoLeak(name, result);
      }

      // The daemon's own stderr must also be clean.
      const stderr = daemon!.stderrBuf();
      expect(
        stderr.includes(SENTINEL),
        `daemon stderr leaked sentinel:\n${stderr}`,
      ).toBe(false);

      // Sanity control: the sentinel value is still in the vault (encrypted).
      // We confirm this via list_secrets — s1 is still present even though
      // its value was never emitted.
      const check = await t("list_secrets");
      expect(check.isError).toBeFalsy();
      const raw = JSON.stringify(check);
      // The sentinel should NOT appear even in the sanity-check response.
      expect(raw.includes(SENTINEL)).toBe(false);
    },
    // Give the full sweep a generous timeout — daemon startup takes a moment.
    60_000,
  );

  // Targeted sub-tests for the most critical paths.

  it("list_secrets response contains no field named 'value'", async () => {
    const result = await t("list_secrets");
    expect(result.isError).toBeFalsy();

    for (const block of result.content) {
      if (block.type !== "text") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        continue;
      }
      expect(
        hasValueKey(parsed),
        `list_secrets response contained a 'value' field: ${block.text.slice(0, 300)}`,
      ).toBe(false);
    }
  });

  it("describe_secret response contains no field named 'value'", async () => {
    const result = await t("describe_secret", { id: "s1" });
    expect(result.isError).toBeFalsy();

    for (const block of result.content) {
      if (block.type !== "text") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        continue;
      }
      expect(
        hasValueKey(parsed),
        `describe_secret response contained a 'value' field: ${block.text.slice(0, 300)}`,
      ).toBe(false);
    }
  });

  it("add_secret response contains no field named 'value'", async () => {
    const vp = await sentinelFile();
    const result = await t("add_secret", { key: "NOSECRET_LEAK", valuePath: vp });
    // Regardless of success or error, no 'value' key should appear.

    for (const block of result.content) {
      if (block.type !== "text") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        continue;
      }
      expect(
        hasValueKey(parsed),
        `add_secret response contained a 'value' field: ${block.text.slice(0, 300)}`,
      ).toBe(false);
    }

    // The sentinel itself must not appear anywhere.
    expect(JSON.stringify(result).includes(SENTINEL)).toBe(false);
  });
});
