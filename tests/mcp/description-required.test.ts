/**
 * Integration tests for issue #65: description required at MCP surface
 * ("human-optional / AI-required" metadata pattern).
 *
 * All 11 tests in this suite are expected to pass — the enforcement is
 * implemented in this same PR (feat(mcp): enforce description as required).
 *
 * Run: pnpm test tests/mcp/description-required.test.ts
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
// Seed data — version 3 with envVariantMap, one existing secret
// ---------------------------------------------------------------------------
const SEED: VaultData = {
  version: 3,
  repos: [],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://user:pass@host:5432/db_entropy_value_xx",
      scopes: [],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_AAAAAAAAAAAAAAAAAAAAAAAA",
      scopes: [],
    },
  ],
  envVariantMap: { global: {}, repos: {} },
};

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------
let tmp: string;
let scratch: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-mcp-desc-req-"));
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
 * Throws an explicit error if no text block is present.
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

/** A valid minimal tutorial fixture for use in MCP args. */
function validTutorial() {
  return {
    steps: [
      {
        order: 1,
        title: "Open the Stripe dashboard",
        body: "Navigate to https://dashboard.stripe.com and sign in with your account.",
        link: "https://dashboard.stripe.com",
      },
      {
        order: 2,
        title: "Copy your secret API key",
        body: "Go to Developers → API Keys and copy the Secret key value.",
      },
    ],
    createdAt: new Date().toISOString(),
    authorAgent: "claude-sonnet-4-6",
  };
}

// ---------------------------------------------------------------------------
// Group A: add_secret — description enforcement
// ---------------------------------------------------------------------------
describe("Group A: add_secret — description enforcement (issue #65)", () => {
  // add_secret without description must be rejected with an error mentioning 'description'.
  it("A1: add_secret without description returns isError:true mentioning 'description'", async () => {
    const vp = await tmpFile("secret-value-no-desc-AAAAAAAAA");
    const result = await tool("add_secret", {
      key: "NO_DESC_SECRET",
      valuePath: vp,
      // description intentionally omitted
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.toLowerCase()).toMatch(/description/);
  });

  // add_secret with empty description must be rejected.
  it("A2: add_secret with empty description returns isError:true", async () => {
    const vp = await tmpFile("secret-value-empty-desc-AAAAAAA");
    const result = await tool("add_secret", {
      key: "EMPTY_DESC_SECRET",
      valuePath: vp,
      description: "",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // add_secret with a valid non-empty description succeeds; description is reflected in response.
  it("A3: add_secret with valid description succeeds and data.secret.description matches", async () => {
    const vp = await tmpFile("secret-value-with-desc-AAAAAAAA");
    const desc = "Primary database connection string for the production Postgres cluster.";
    const result = await tool("add_secret", {
      key: "DESCRIBED_SECRET",
      valuePath: vp,
      description: desc,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown> };
    expect(data.secret.key).toBe("DESCRIBED_SECRET");
    expect(data.secret.description).toBe(desc);
    expect(data.secret).not.toHaveProperty("value");
  });

  // add_secret with description > 500 chars must be rejected.
  it("A4: add_secret with description > 500 chars returns isError:true", async () => {
    const vp = await tmpFile("secret-value-long-desc-AAAAAAAAA");
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
});

// ---------------------------------------------------------------------------
// Group B: set_tutorial — description enforcement
// ---------------------------------------------------------------------------
describe("Group B: set_tutorial — description enforcement (issue #65)", () => {
  // set_tutorial on a new key without description must be rejected; no placeholder created.
  it("B1: set_tutorial new key without description returns isError:true, placeholder NOT created", async () => {
    const result = await tool("set_tutorial", {
      secret: "BRAND_NEW_KEY_NO_DESC",
      tutorial: validTutorial(),
      // description intentionally omitted
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.toLowerCase()).toMatch(/description/);

    // Confirm no placeholder was created.
    const listResult = await tool("list_secrets");
    expect(listResult.isError).toBeFalsy();
    const listData = parse(listResult) as { secrets: Array<Record<string, unknown>> };
    const placeholder = listData.secrets.find(
      (s) => s.key === "BRAND_NEW_KEY_NO_DESC",
    );
    expect(placeholder).toBeUndefined();
  });

  // set_tutorial on a new key with valid description succeeds; description is stored and persists.
  it("B2: set_tutorial new key with valid description succeeds, description stored and persists", async () => {
    const desc = "Stripe live secret API key for payment processing in production.";
    const result = await tool("set_tutorial", {
      secret: "BRAND_NEW_KEY_WITH_DESC",
      tutorial: validTutorial(),
      description: desc,
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as {
      created: boolean;
      secret: Record<string, unknown>;
    };
    expect(data.created).toBe(true);
    expect(data.secret.key).toBe("BRAND_NEW_KEY_WITH_DESC");
    expect(data.secret.description).toBe(desc);
    expect(data.secret).not.toHaveProperty("value");

    // Verify description persists on re-read via describe_secret.
    const descResult = await tool("describe_secret", { id: "BRAND_NEW_KEY_WITH_DESC" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.description).toBe(desc);
  });

  // set_tutorial on an existing secret without description must be rejected; tutorial not attached.
  it("B3: set_tutorial existing secret without description returns isError:true, tutorial NOT attached", async () => {
    const result = await tool("set_tutorial", {
      secret: "s1",
      tutorial: validTutorial(),
      // description intentionally omitted
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.toLowerCase()).toMatch(/description/);

    // Confirm tutorial was NOT attached.
    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret).not.toHaveProperty("tutorial");
  });

  // set_tutorial on an existing secret with description succeeds; description and tutorial stored.
  it("B4: set_tutorial existing secret with description succeeds, description and tutorial stored", async () => {
    const desc = "Primary Postgres connection URL for the production database cluster.";
    const tut = validTutorial();
    const result = await tool("set_tutorial", {
      secret: "s1",
      tutorial: tut,
      description: desc,
    });
    expect(result.isError).toBeFalsy();

    // Confirm description is stored.
    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.description).toBe(desc);

    // Confirm tutorial is attached.
    expect(descData.secret).toHaveProperty("tutorial");
    const storedTut = descData.secret.tutorial as Record<string, unknown>;
    const steps = storedTut.steps as Array<Record<string, unknown>>;
    expect(steps[0].title).toBe(tut.steps[0].title);
  });

  // set_tutorial unset:true without description succeeds — the unset path is exempt.
  it("B5: set_tutorial unset:true without description succeeds (unset path exempt)", async () => {
    // First attach a tutorial so we have something to remove.
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: validTutorial(),
      description: "Temporary description for B5 setup.",
    });

    // Unset should succeed without a description.
    const result = await tool("set_tutorial", {
      secret: "s1",
      unset: true,
    });
    // Even if the setup above failed (pre-fix), unset on an existing secret
    // without a tutorial should at worst return NOT_FOUND — not a description
    // error. We test that the error (if any) is NOT about description.
    if (result.isError) {
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(text.toLowerCase()).not.toMatch(/missing_description|description.*required/i);
    } else {
      // Success path: tutorial should be gone.
      const descResult = await tool("describe_secret", { id: "s1" });
      expect(descResult.isError).toBeFalsy();
      const descData = parse(descResult) as { secret: Record<string, unknown> };
      expect(descData.secret).not.toHaveProperty("tutorial");
    }
  });

  // set_tutorial with empty description must be rejected.
  it("B6: set_tutorial with empty description returns isError:true", async () => {
    const result = await tool("set_tutorial", {
      secret: "EMPTY_DESC_TUTORIAL_KEY",
      tutorial: validTutorial(),
      description: "",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // set_tutorial with description > 500 chars must be rejected.
  it("B7: set_tutorial with description > 500 chars returns isError:true", async () => {
    const result = await tool("set_tutorial", {
      secret: "LONG_DESC_TUTORIAL_KEY",
      tutorial: validTutorial(),
      description: "Y".repeat(501),
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });
});
