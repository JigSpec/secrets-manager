/**
 * MCP tool integration tests for the tutorial feature (issue #41).
 *
 * A single daemon instance is shared across all tests in this file
 * (beforeAll/afterAll) to avoid the per-test scrypt overhead (~3-5 s each)
 * that causes 45-second timeouts when this file runs late in the full suite.
 *
 * Tests that mutate `s1` use unique keys instead of reusing `s1` to avoid
 * cross-test state conflicts. Tests that verify "no tutorial / no status on a
 * clean secret" use `s2`, which no test in this file mutates.
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

// ── Imports from paths that exist (they drive behaviour being tested) ────────────
import { callTool } from "../../mcp/tools/index";
import type { McpToolResult } from "../../mcp/server";
// ───────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Seed data
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
  scratch = await mkdtemp(path.join(tmpdir(), "sm-mcp-tutorial-"));
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

/** A tutorial with mayBeStale: true (always stale). */
function staleTutorial() {
  return {
    ...validTutorial(),
    mayBeStale: true,
  };
}

/** A tutorial created 91 days ago (stale by age). */
function oldTutorial() {
  const d = new Date();
  d.setDate(d.getDate() - 91);
  return {
    ...validTutorial(),
    createdAt: d.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("MCP tutorial feature", () => {
  // 1. add_secret with tutorial stores tutorial; describe_secret returns it
  it("add_secret with tutorial stores tutorial — describe_secret returns tutorial.steps[0].title", async () => {
    const vp = await tmpFile("brand-new-stripe-api-key-AAAAAAA");
    const tut = validTutorial();
    const addResult = await tool("add_secret", {
      key: "STRIPE_API_KEY",
      valuePath: vp,
      description: "Stripe live secret API key for payment processing in production.",
      tutorial: tut,
    });
    expect(addResult.isError).toBeFalsy();

    const addData = parse(addResult) as { secret: Record<string, unknown> };
    expect(addData.secret.key).toBe("STRIPE_API_KEY");
    // The tutorial must be included in the add response.
    expect(addData.secret).toHaveProperty("tutorial");

    // Now describe the secret and verify the tutorial is present.
    const descResult = await tool("describe_secret", { id: "STRIPE_API_KEY" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    const storedTut = descData.secret.tutorial as Record<string, unknown>;
    expect(storedTut).toBeDefined();
    const steps = storedTut.steps as Array<Record<string, unknown>>;
    expect(steps[0].title).toBe(tut.steps[0].title);
  });

  // 2. add_secret with invalid tutorial (missing createdAt) returns isError: true
  it("add_secret with invalid tutorial (missing createdAt) returns isError: true", async () => {
    const vp = await tmpFile("another-api-key-BBBBBBB");
    const badTutorial = {
      steps: [{ order: 1, title: "Step 1", body: "Body text." }],
      // createdAt is intentionally missing
    };
    const result = await tool("add_secret", {
      key: "BAD_TUTORIAL_SECRET",
      valuePath: vp,
      description: "Description provided to reach tutorial validation.",
      tutorial: badTutorial,
    });
    expect(result.isError).toBe(true);
  });

  // 3. set_tutorial attaches tutorial to an existing secret; describe_secret confirms
  it("set_tutorial attaches tutorial to existing secret — describe_secret confirms", async () => {
    const tut = validTutorial();
    const setResult = await tool("set_tutorial", {
      secret: "s1",
      tutorial: tut,
      description: "Primary database URL for the production Postgres cluster.",
    });
    expect(setResult.isError).toBeFalsy();

    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    const storedTut = descData.secret.tutorial as Record<string, unknown>;
    expect(storedTut).toBeDefined();
    const steps = storedTut.steps as Array<Record<string, unknown>>;
    expect(steps[0].title).toBe(tut.steps[0].title);
  });

  // 4. set_tutorial with unset: true removes tutorial; describe_secret has no tutorial
  it("set_tutorial with unset: true removes tutorial — describe_secret has no tutorial key", async () => {
    // First attach a tutorial.
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: validTutorial(),
      description: "Primary database URL for the production Postgres cluster.",
    });

    // Now remove it.
    const unsetResult = await tool("set_tutorial", {
      secret: "s1",
      unset: true,
    });
    expect(unsetResult.isError).toBeFalsy();

    // describe_secret must no longer include the tutorial.
    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret).not.toHaveProperty("tutorial");
  });

  // 5. set_tutorial on non-existent secret (lowercase id-like needle) returns isError: true
  it("set_tutorial on non-existent secret returns isError: true", async () => {
    const result = await tool("set_tutorial", {
      secret: "does-not-exist",
      tutorial: validTutorial(),
      description: "Description for non-existent key test.",
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  });

  // 6. describe_secret returns tutorialIsStale: true when mayBeStale: true
  it("describe_secret returns tutorialIsStale: true when mayBeStale: true", async () => {
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: staleTutorial(),
      description: "Primary database URL for the production Postgres cluster.",
    });

    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.tutorialIsStale).toBe(true);
  });

  // 7. describe_secret returns tutorialIsStale: true when createdAt is >90 days old
  it("describe_secret returns tutorialIsStale: true when createdAt is >90 days old", async () => {
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: oldTutorial(),
      description: "Primary database URL for the production Postgres cluster.",
    });

    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.tutorialIsStale).toBe(true);
  });

  // 8. describe_secret returns tutorialIsStale: false for a fresh tutorial
  it("describe_secret returns tutorialIsStale: false for a fresh tutorial", async () => {
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: validTutorial(),
      description: "Primary database URL for the production Postgres cluster.",
    });

    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.tutorialIsStale).toBe(false);
  });

  // 9. tutorial field is NOT stripped by scrubSecretFields
  it("tutorial field is NOT stripped by scrubSecretFields — tutorial.steps[0].title survives in describe_secret", async () => {
    const tut = validTutorial();
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: tut,
      description: "Primary database URL for the production Postgres cluster.",
    });

    const descResult = await tool("describe_secret", { id: "s1" });
    expect(descResult.isError).toBeFalsy();

    // The raw serialised response must include the step title.
    const rawText = JSON.stringify(descResult);
    expect(rawText).toContain(tut.steps[0].title);

    // But must never expose the plaintext value.
    expect(rawText).not.toContain("postgres://user:pass");
  });

  // 10. list_secrets includes tutorial field for secrets that have one
  it("list_secrets includes tutorial field for secrets that have one", async () => {
    const tut = validTutorial();
    await tool("set_tutorial", {
      secret: "s1",
      tutorial: tut,
      description: "Primary database URL for the production Postgres cluster.",
    });

    const listResult = await tool("list_secrets");
    expect(listResult.isError).toBeFalsy();
    const listData = parse(listResult) as {
      secrets: Array<Record<string, unknown>>;
    };

    const s1 = listData.secrets.find((sec) => sec.id === "s1");
    expect(s1).toBeDefined();
    expect(s1!).toHaveProperty("tutorial");

    // s2 (no tutorial) must not have the field.
    const s2 = listData.secrets.find((sec) => sec.id === "s2");
    expect(s2).toBeDefined();
    expect(s2!).not.toHaveProperty("tutorial");

    // Values must never appear.
    const rawText = JSON.stringify(listResult);
    expect(rawText).not.toContain("postgres://user:pass");
    expect(rawText).not.toContain("sk_live_");
  });

  // 11. set_tutorial returns INVALID_INPUT for empty steps array
  it("set_tutorial with empty steps array returns isError: true", async () => {
    const result = await tool("set_tutorial", {
      secret: "s1",
      tutorial: {
        steps: [],
        createdAt: new Date().toISOString(),
      },
    });
    expect(result.isError).toBe(true);
  });

  // 12. set_tutorial with invalid link URL returns isError: true
  it("set_tutorial with invalid link URL returns isError: true", async () => {
    const result = await tool("set_tutorial", {
      secret: "s1",
      tutorial: {
        steps: [
          {
            order: 1,
            title: "Step 1",
            body: "Body text.",
            link: "not-a-url",
          },
        ],
        createdAt: new Date().toISOString(),
      },
    });
    expect(result.isError).toBe(true);
  });

  // 13. set_tutorial missing both tutorial and unset returns isError: true
  it("set_tutorial missing both tutorial and unset returns isError: true", async () => {
    const result = await tool("set_tutorial", { secret: "s1" });
    expect(result.isError).toBe(true);
  });

  // 14. describe_secret has no tutorialIsStale field when secret has no tutorial
  it("describe_secret has no tutorialIsStale when secret has no tutorial", async () => {
    // Use s2 — no test in this file sets a tutorial on s2, so it is always clean.
    const descResult = await tool("describe_secret", { id: "s2" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret).not.toHaveProperty("tutorialIsStale");
  });

  // 15. set_tutorial on a valid key that doesn't exist auto-creates a placeholder
  it("set_tutorial auto-creates placeholder for valid key that doesn't exist yet", async () => {
    const tut = validTutorial();
    const result = await tool("set_tutorial", {
      secret: "BRAND_NEW_KEY",
      tutorial: tut,
      description: "Auto-created placeholder for BRAND_NEW_KEY — Stripe API key.",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { secret: Record<string, unknown>; created: boolean };
    expect(data.created).toBe(true);
    expect(data.secret.key).toBe("BRAND_NEW_KEY");
    expect(data.secret.status).toBe("awaiting_value");
    expect(data.secret).toHaveProperty("tutorial");
    expect(data.secret).not.toHaveProperty("value");
  });

  // 16. set_tutorial auto-created placeholder is visible in list_secrets
  it("set_tutorial placeholder appears in list_secrets with status awaiting_value", async () => {
    await tool("set_tutorial", {
      secret: "PLACEHOLDER_KEY",
      tutorial: validTutorial(),
      description: "Placeholder for PLACEHOLDER_KEY — GitHub OAuth app secret.",
    });

    const listResult = await tool("list_secrets");
    expect(listResult.isError).toBeFalsy();
    const listData = parse(listResult) as { secrets: Array<Record<string, unknown>> };
    const ph = listData.secrets.find((s) => s.key === "PLACEHOLDER_KEY");
    expect(ph).toBeDefined();
    expect(ph!.status).toBe("awaiting_value");
    expect(ph!).not.toHaveProperty("value");
  });

  // 17. set_tutorial unset:true on non-existent key still returns NOT_FOUND
  it("set_tutorial unset:true on non-existent key returns isError:true", async () => {
    const result = await tool("set_tutorial", {
      secret: "TOTALLY_MISSING_KEY",
      unset: true,
    });
    expect(result.isError).toBe(true);
  });

  // 18. set_tutorial with a lowercase (non-key) needle that doesn't exist still returns NOT_FOUND
  it("set_tutorial with a lowercase id-like needle that doesn't exist returns isError:true", async () => {
    const result = await tool("set_tutorial", {
      secret: "not_a_key",
      tutorial: validTutorial(),
      description: "Description for lowercase-key error test.",
    });
    expect(result.isError).toBe(true);
  });

  // 19. add_secret fills placeholder created by set_tutorial (upsert)
  it("add_secret upserts into awaiting_value placeholder created by set_tutorial", async () => {
    const tut = validTutorial();
    await tool("set_tutorial", {
      secret: "UPSERT_KEY",
      tutorial: tut,
      description: "Upsert test placeholder — Stripe live API key.",
    });

    const vp = await tmpFile("real-secret-value-AAAAAAA");
    const addResult = await tool("add_secret", {
      key: "UPSERT_KEY",
      valuePath: vp,
      description: "Upsert test placeholder — Stripe live API key.",
    });
    expect(addResult.isError).toBeFalsy();
    const addData = parse(addResult) as { secret: Record<string, unknown>; upserted: boolean };
    expect(addData.upserted).toBe(true);
    expect(addData.secret.key).toBe("UPSERT_KEY");

    const listResult = await tool("list_secrets");
    const listData = parse(listResult) as { secrets: Array<Record<string, unknown>> };
    const matches = listData.secrets.filter((s) => s.key === "UPSERT_KEY");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.status).toBeUndefined();
    expect(matches[0]!).toHaveProperty("tutorial");
  });

  // 20. set_value promotes awaiting_value placeholder to active
  it("set_value clears awaiting_value status from placeholder", async () => {
    await tool("set_tutorial", {
      secret: "SET_VALUE_KEY",
      tutorial: validTutorial(),
      description: "Placeholder for SET_VALUE_KEY — test service API token.",
    });

    const vp = await tmpFile("value-for-set-value-AAAAAAA");
    const svResult = await tool("set_value", { secret: "SET_VALUE_KEY", valuePath: vp });
    expect(svResult.isError).toBeFalsy();

    const descResult = await tool("describe_secret", { id: "SET_VALUE_KEY" });
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.status).toBeUndefined();
  });

  // 21. add_secret on a normal key (no placeholder) does NOT set upserted flag
  it("add_secret on a fresh non-placeholder key sets upserted:false or absent", async () => {
    const vp = await tmpFile("normal-value-AAAAAAA");
    const result = await tool("add_secret", {
      key: "NORMAL_KEY",
      valuePath: vp,
      description: "Normal key for upsert-flag test.",
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result) as { upserted?: boolean };
    expect(data.upserted ?? false).toBe(false);
  });

  // 22. describe_secret surfaces status: "awaiting_value" for placeholder secrets
  it("describe_secret returns status: 'awaiting_value' for a placeholder created by set_tutorial", async () => {
    await tool("set_tutorial", {
      secret: "DESCRIBE_ME",
      tutorial: validTutorial(),
      description: "Describe-me test placeholder — internal service key.",
    });

    const descResult = await tool("describe_secret", { id: "DESCRIBE_ME" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret.status).toBe("awaiting_value");
    expect(descData.secret).not.toHaveProperty("value");
  });

  // 23. describe_secret omits status for normal (non-placeholder) secrets
  it("describe_secret omits status for a normal secret with no status field", async () => {
    // Use s2 — no test in this file sets status on s2, so it is always clean.
    const descResult = await tool("describe_secret", { id: "s2" });
    expect(descResult.isError).toBeFalsy();
    const descData = parse(descResult) as { secret: Record<string, unknown> };
    expect(descData.secret).not.toHaveProperty("status");
  });

  // ── Issue #53 — set_tutorial mutex + Zod field path ────────────────────────

  // M1. set_tutorial rejects both unset:true AND tutorial with a mutex error
  it("set_tutorial rejects both unset:true and tutorial with a mutex error", async () => {
    const result = await tool("set_tutorial", {
      secret: "s2",
      unset: true,
      tutorial: validTutorial(),
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/tutorial/);
    expect(text).toMatch(/unset/);
    expect(text).toMatch(/not both/i);

    // Side-effect check: s2 must not have been mutated (no tutorial attached).
    // We use s2 here because no other test in this file mutates s2.
    const desc = await tool("describe_secret", { id: "s2" });
    const data = parse(desc) as { secret: Record<string, unknown> };
    expect(data.secret).not.toHaveProperty("tutorial");
  });

  // M2. set_tutorial with malformed tutorial surfaces the offending field path
  it("set_tutorial with malformed tutorial surfaces the offending field path", async () => {
    const result = await tool("set_tutorial", {
      secret: "s1",
      tutorial: {
        steps: [{ order: 1, title: "T", body: "", link: "https://example.com" }],
        createdAt: new Date().toISOString(),
      },
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    // Path must include "steps", "body", and the array index "0".
    expect(text).toMatch(/steps/);
    expect(text).toMatch(/body/);
    expect(text).toMatch(/\b0\b|\[0\]/);
    expect(text).toMatch(/invalid tutorial/i);
  });

  // M3. set_tutorial with bad createdAt surfaces createdAt in the error
  it("set_tutorial with bad createdAt surfaces createdAt in the error", async () => {
    const result = await tool("set_tutorial", {
      secret: "s1",
      tutorial: {
        steps: [{ order: 1, title: "T", body: "B" }],
        createdAt: "not-a-datetime",
      },
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/createdAt/);
    expect(text).toMatch(/invalid tutorial/i);
  });

  // M4. add_secret with malformed tutorial surfaces the offending field path
  it("add_secret with malformed tutorial surfaces the offending field path", async () => {
    const vp = await tmpFile("any-value-AAAAAAA");
    const result = await tool("add_secret", {
      key: "FOO_KEY",
      valuePath: vp,
      description: "Description provided to reach tutorial validation.",
      tutorial: {
        steps: [{ order: 1, title: "T", body: "B", link: "not-a-url" }],
        createdAt: new Date().toISOString(),
      },
    });
    expect(result.isError).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toMatch(/steps/);
    expect(text).toMatch(/link/);
    expect(text).toMatch(/\b0\b|\[0\]/);
    expect(text).toMatch(/invalid tutorial/i);
  });
});
