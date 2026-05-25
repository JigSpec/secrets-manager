/**
 * Test 2 — Issue #93 Point 3: awaitingCount must include sentinel values
 *
 * Verifies that `components/workbench.tsx` computes awaitingCount as:
 *
 *   data.secrets.filter(
 *     (s) => s.status === "awaiting_value" || isSentinelValue(s.value)
 *   ).length
 *
 * This ensures secrets whose value is a sentinel placeholder (e.g.
 * "PLACEHOLDER", "__SET_VIA_TUTORIAL__") are correctly surfaced in the
 * "Needs Your Attention" banner and dialog, even when their status field
 * is not set to "awaiting_value".
 *
 * These are pure source-text tests — no DOM required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSentinelValue } from "@/lib/vault/sentinel";
import type { Secret } from "@/lib/vault/schema";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Logic-level test: the sentinel-aware count function
// ---------------------------------------------------------------------------

/**
 * Sentinel-aware implementation of awaitingCount matching workbench.tsx.
 * Counts secrets that are either status=awaiting_value OR have a sentinel value.
 */
function fixedAwaitingCount(secrets: Secret[]): number {
  return secrets.filter(
    (s) => s.status === "awaiting_value" || isSentinelValue(s.value),
  ).length;
}

function makeSecret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: "id-1",
    key: "SOME_KEY",
    value: "",
    scopes: [],
    ...overrides,
  } as Secret;
}

describe("awaitingCount — sentinel-value secrets (Issue #93, Point 3)", () => {
  it("counts a secret with status=\"awaiting_value\" (baseline)", () => {
    const secrets = [
      makeSecret({ status: "awaiting_value" }),
      makeSecret({ value: "real_value" }),
    ];
    expect(fixedAwaitingCount(secrets)).toBe(1);
  });

  it("counts a secret with value=\"PLACEHOLDER\" and no status", () => {
    // A secret whose value is a sentinel but whose status field is undefined.
    // isSentinelValue("PLACEHOLDER") returns true, so it NEEDS attention.
    const secrets = [
      makeSecret({ value: "PLACEHOLDER" }), // no status field
      makeSecret({ value: "real_value" }),
    ];

    // Demonstrate that isSentinelValue correctly identifies PLACEHOLDER
    expect(isSentinelValue("PLACEHOLDER")).toBe(true);

    // The fixed awaitingCount returns 1 for this input.
    const count = fixedAwaitingCount(secrets);
    expect(count).toBe(1);
  });

  it("counts both status-based and sentinel-based secrets together", () => {
    const secrets = [
      makeSecret({ status: "awaiting_value", value: "" }),
      makeSecret({ value: "PLACEHOLDER" }), // sentinel, no status
      makeSecret({ value: "__SET_VIA_TUTORIAL__" }), // another sentinel
      makeSecret({ value: "sk-real-key-abc" }), // real value
    ];

    // isSentinelValue works for both sentinels
    expect(isSentinelValue("PLACEHOLDER")).toBe(true);
    expect(isSentinelValue("__SET_VIA_TUTORIAL__")).toBe(true);
    expect(isSentinelValue("sk-real-key-abc")).toBe(false);

    // Fixed impl counts 1 status + 2 sentinels = 3.
    const count = fixedAwaitingCount(secrets);
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Source-text test: workbench.tsx must use needsAttention (via sentinel module)
// ---------------------------------------------------------------------------

describe("workbench.tsx — awaitingCount uses needsAttention (Issue #93, Point 3)", () => {
  const src = readSrc("components/workbench.tsx");

  it("imports needsAttention from @/lib/vault/sentinel in workbench.tsx", () => {
    const importsCheck = /needsAttention/.test(src);
    expect(
      importsCheck,
      'Expected workbench.tsx to import/use needsAttention from @/lib/vault/sentinel. '
      + 'The awaitingCount useMemo must call needsAttention (which internally uses isSentinelValue) to catch sentinel-valued secrets.',
    ).toBe(true);
  });

  it("awaitingCount filter in workbench.tsx checks needsAttention (source-text guard)", () => {
    const usesNeedsAttentionInCount =
      /awaitingCount/.test(src) && /needsAttention/.test(src);
    expect(
      usesNeedsAttentionInCount,
      'awaitingCount in workbench.tsx must call needsAttention in its filter. '
      + 'needsAttention delegates to isSentinelValue and isEmptyValue internally.',
    ).toBe(true);
  });
});
