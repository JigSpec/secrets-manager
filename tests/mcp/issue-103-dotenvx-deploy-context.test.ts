/**
 * Tests for issue #103 — dotenvx deploy context gap.
 *
 * A real production failure occurred where an agent told a user to gitignore
 * the .env.<env> output files written by `deploy`, because the `deploy` tool
 * description did not tell agents that those files are dotenvx-encrypted and
 * safe to commit.
 *
 * Two fixes are planned:
 *
 *   1. The `deploy` tool description in mcp/server.ts must contain substrings
 *      that make it unambiguous that:
 *        - output files are dotenvx-ENCRYPTED (safe to commit)
 *        - the correct post-deploy workflow is git add / git commit / git push
 *        - vercel env add / flyctl secrets set are NOT the right next steps
 *        - dryRun:true (existing) must still be present
 *        - bare secret key (existing namespace note) must still be present
 *
 *   2. When `daemon_status` is called with a running daemon, the response must
 *      include a `workflow` field that guides agents through the correct
 *      post-deploy git workflow and includes "dotenvx-encrypted" so agents
 *      cannot mistake the files for plaintext.
 *
 * These tests are intentionally RED until the fixes land.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { TOOL_DEFINITIONS } from "../../mcp/server";
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
// Helper — look up a tool by name from TOOL_DEFINITIONS
// ---------------------------------------------------------------------------

function getTool(name: string) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in TOOL_DEFINITIONS`);
  return tool;
}

// ---------------------------------------------------------------------------
// Part 1 — Static assertions on the `deploy` tool description
//
// These tests run without a daemon. They just import TOOL_DEFINITIONS and
// assert substrings on the description string.
// ---------------------------------------------------------------------------

describe("Issue #103 — deploy tool description (static)", () => {
  let deployDesc: string;

  beforeAll(() => {
    deployDesc = getTool("deploy").description ?? "";
  });

  it("deploy description contains 'dotenvx-ENCRYPTED' or 'dotenvx-encrypted'", () => {
    // The description must make it explicit that output files are encrypted.
    // Either capitalisation is acceptable (case-insensitive match on "encrypted").
    const lower = deployDesc.toLowerCase();
    expect(lower).toContain("dotenvx-encrypted");
  });

  it("deploy description contains 'safe to commit'", () => {
    // Agents must be told explicitly that the output files are safe to commit
    // so they never advise users to gitignore them.
    expect(deployDesc.toLowerCase()).toContain("safe to commit");
  });

  it("deploy description contains 'git add'", () => {
    // The positive post-deploy workflow must include git add.
    expect(deployDesc).toContain("git add");
  });

  it("deploy description contains 'git commit'", () => {
    // The positive post-deploy workflow must include git commit.
    expect(deployDesc).toContain("git commit");
  });

  it("deploy description contains 'git push'", () => {
    // The positive post-deploy workflow must include git push.
    expect(deployDesc).toContain("git push");
  });

  it("deploy description contains 'vercel env add' as a warning/negative example", () => {
    // Agents must see a warning that vercel env add is NOT the next step,
    // so they don't confuse the local encrypted files with a Vercel push.
    expect(deployDesc).toContain("vercel env add");
  });

  it("deploy description contains 'flyctl secrets set' as a warning/negative example", () => {
    // Agents must see a warning that flyctl secrets set is NOT the next step.
    expect(deployDesc).toContain("flyctl secrets set");
  });

  it("deploy description still contains 'dryRun:true' (existing invariant must not regress)", () => {
    // Existing guidance — dryRun:true must remain in the description.
    expect(deployDesc).toContain("dryRun:true");
  });

  it("deploy description still contains 'bare secret key' or 'bare key' (namespace note must not regress)", () => {
    // Existing namespace note — the deployed key is always the bare key.
    // Accept "bare secret key" or "bare key" to allow minor phrasing variation.
    const hasBareKey =
      deployDesc.includes("bare secret key") || deployDesc.includes("bare key");
    expect(hasBareKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — Integration test: daemon_status running response includes workflow
//
// These tests require a live daemon. They assert that the structured response
// returned by daemon_status when running includes a `workflow` field that
// contains the correct post-deploy git workflow strings.
// ---------------------------------------------------------------------------

const MINIMAL_SEED: VaultData = {
  version: 2,
  repos: [],
  secrets: [],
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  await seedVault(tmp, MINIMAL_SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterAll(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
});

/** Call an MCP tool against the shared running daemon. */
function tool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  return callTool(name, args, { socketPath: daemon!.socketPath });
}

/** Parse the JSON payload from the first text content block. */
function parse(result: McpToolResult): unknown {
  const block = result.content.find((c) => c.type === "text");
  if (!block) {
    throw new Error(
      `parse(): McpToolResult has no text content block. isError=${String(result.isError)}`,
    );
  }
  return JSON.parse(block.text);
}

describe("Issue #103 — daemon_status workflow field (integration)", () => {
  it("daemon_status returns running:true when daemon is up (sanity check)", async () => {
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    expect(data.running).toBe(true);
  });

  it("daemon_status response includes a 'workflow' field when daemon is running", async () => {
    // The workflow field provides post-deploy guidance so agents always know
    // the correct next steps after calling deploy.
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    expect(data).toHaveProperty("workflow");
    expect(typeof data.workflow).toBe("string");
    expect((data.workflow as string).length).toBeGreaterThan(0);
  });

  it("daemon_status workflow field contains 'dotenvx-encrypted'", async () => {
    // The workflow reminder must reinforce that files are encrypted, not
    // plaintext, so agents never tell users to gitignore them.
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    const workflow = (data.workflow as string ?? "").toLowerCase();
    expect(workflow).toContain("dotenvx-encrypted");
  });

  it("daemon_status workflow field contains 'git add'", async () => {
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    const workflow = data.workflow as string ?? "";
    expect(workflow).toContain("git add");
  });

  it("daemon_status workflow field contains 'git commit'", async () => {
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    const workflow = data.workflow as string ?? "";
    expect(workflow).toContain("git commit");
  });

  it("daemon_status workflow field contains 'git push'", async () => {
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    const workflow = data.workflow as string ?? "";
    expect(workflow).toContain("git push");
  });

  it("daemon_status workflow field contains 'vercel env add'", async () => {
    // The workflow reminder must warn against treating deploy as a Vercel push.
    const result = await tool("daemon_status");
    expect(result.isError).toBeFalsy();
    const data = parse(result) as Record<string, unknown>;
    const workflow = data.workflow as string ?? "";
    expect(workflow).toContain("vercel env add");
  });
});
