/**
 * Tests for issue #79 — PR 1: tool description string improvements.
 *
 * These tests assert properties that do NOT hold in the current codebase and
 * will therefore FAIL (be red) until the corresponding description edits are
 * applied to mcp/server.ts:
 *
 *   1. add_secret top-level description warns against sentinel placeholders
 *      and points to set_tutorial.
 *   2. add_secret.tutorial param description carries the external-service-only
 *      caveat and points to set_description.
 *   3. set_tutorial top-level description leads with the auto-create-placeholder
 *      semantic and notes that deploy skips placeholders.
 *   4. set_tutorial.tutorial param description carries the external-service-only
 *      caveat and points to set_description.
 *   5. scope_secret top-level description points to scope_secrets_bulk when
 *      working with more than 2 secrets.
 *   6. set_namespace top-level description clarifies that namespace is a
 *      vault-internal disambiguator only and does NOT rewrite the deployed
 *      env var name — the deployed key is always the bare key (post-#78).
 */

import { describe, it, expect } from "vitest";

import { TOOL_DEFINITIONS } from "../../mcp/server";

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTool(name: string) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in TOOL_DEFINITIONS`);
  return tool;
}

function getParamDescription(toolName: string, paramName: string): string {
  const tool = getTool(toolName);
  const props =
    (tool.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties ?? {};
  const param = props[paramName];
  if (!param) throw new Error(`Param "${paramName}" not found in tool "${toolName}"`);
  return param.description ?? "";
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe("Issue #79 — tool description string improvements (PR 1)", () => {
  it("add_secret description warns against sentinel placeholders and points to set_tutorial", () => {
    const desc: string = getTool("add_secret").description ?? "";
    expect(desc).toContain("awaiting_value placeholder");
    expect(desc).toContain("set_tutorial");
    expect(desc).toContain("__SET_VIA_TUTORIAL__");
  });

  it("add_secret.tutorial param description carries external-service-only caveat", () => {
    const desc = getParamDescription("add_secret", "tutorial");
    expect(desc).toContain("external service");
    expect(desc).toContain("set_description");
    expect(desc).toContain("openssl rand");
    expect(desc.toLowerCase()).toContain("policy");
  });

  it("set_tutorial description leads with auto-create-placeholder semantic", () => {
    const desc: string = getTool("set_tutorial").description ?? "";
    expect(desc).toContain("auto-creates an awaiting_value placeholder");
    expect(desc.toLowerCase()).toContain("deploy skips placeholders");
  });

  it("set_tutorial.tutorial param description carries external-service-only caveat", () => {
    const desc = getParamDescription("set_tutorial", "tutorial");
    expect(desc).toContain("external service");
    expect(desc).toContain("set_description");
    expect(desc).toContain("openssl rand");
    expect(desc.toLowerCase()).toContain("policy");
  });

  it("scope_secret description points to scope_secrets_bulk", () => {
    const desc: string = getTool("scope_secret").description ?? "";
    expect(desc).toContain("scope_secrets_bulk");
    expect(desc).toContain("more than 2 secrets");
  });

  it("set_namespace description declares namespace is vault-internal only", () => {
    const desc: string = getTool("set_namespace").description ?? "";
    expect(desc).toContain("vault-internal");
    expect(desc).toContain("bare key");
    expect(desc.toLowerCase()).toContain("does not change");
  });
});
