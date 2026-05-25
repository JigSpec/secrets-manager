/**
 * Tests for the new `onTarget` callback on `runDeploy` (Issue #76).
 *
 * Today `runDeploy` iterates targets sequentially in a for…of loop and only
 * resolves once every target has finished. The deploy progress bar in the
 * GUI therefore never sees intermediate state — it jumps from 0/N to N/N.
 *
 * The fix is to expose a per-target hook:
 *
 *   await runDeploy({
 *     data,
 *     dryRun: false,
 *     onTarget: (result, index) => {
 *       // fired exactly once per target, in iteration order, AFTER the
 *       // target's DeployTargetResult is known.
 *     },
 *   });
 *
 * The aggregate `Promise<DeployTargetResult[]>` must still resolve with the
 * same array of results — `onTarget` is additive, not a replacement.
 *
 * NOTE: These tests use `dryRun: true` everywhere so we never touch disk and
 * never need a real dotenvx-ops binary. The dry-run path still iterates
 * targets sequentially and emits the same per-target results, so it
 * exercises the new callback contract end-to-end without external state.
 */
import { describe, expect, it } from "vitest";

import type { DeployTargetResult } from "@/lib/vault/deploy/run-deploy";
import { runDeploy } from "@/lib/vault/deploy/run-deploy";
import type { VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixture(): VaultData {
  // Four (repoId, env) cells across two repos. enumerateTargets() returns
  // them in the order they are discovered scanning secrets[*].scopes — so
  // the fixture is constructed so the iteration order is stable and
  // predictable.
  return {
    version: 2,
    repos: [
      { id: "r-alpha", name: "alpha", path: "/tmp/alpha", environments: ["test", "live"] },
      { id: "r-beta", name: "beta", path: "/tmp/beta", environments: ["test", "live"] },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value: "v-api",
        scopes: [
          { repoId: "r-alpha", env: "test" },
          { repoId: "r-alpha", env: "live" },
          { repoId: "r-beta", env: "test" },
          { repoId: "r-beta", env: "live" },
        ],
      },
    ],
  };
}

function singleTargetFixture(): VaultData {
  return {
    version: 2,
    repos: [
      { id: "r-solo", name: "solo", path: "/tmp/solo", environments: ["test"] },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value: "v",
        scopes: [{ repoId: "r-solo", env: "test" }],
      },
    ],
  };
}

function emptyTargetsFixture(): VaultData {
  return {
    version: 2,
    repos: [
      { id: "r-solo", name: "solo", path: "/tmp/solo", environments: ["test"] },
    ],
    // No secret scopes → enumerateTargets returns [].
    secrets: [
      { id: "s1", key: "API_KEY", value: "v", scopes: [] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDeploy onTarget callback", () => {
  it("is invoked exactly once per target", async () => {
    const data = fixture();
    const calls: DeployTargetResult[] = [];

    const results = await runDeploy({
      data,
      dryRun: true,
      onTarget: (r) => {
        calls.push(r);
      },
    });

    expect(results).toHaveLength(4);
    expect(calls).toHaveLength(4);
  });

  it("fires in the same order as the returned results array", async () => {
    const data = fixture();
    const seen: string[] = [];

    const results = await runDeploy({
      data,
      dryRun: true,
      onTarget: (r) => {
        seen.push(`${r.repoId}::${r.env}`);
      },
    });

    const expected = results.map((r) => `${r.repoId}::${r.env}`);
    expect(seen).toEqual(expected);
  });

  it("passes a fully-populated DeployTargetResult (not a partial)", async () => {
    const data = fixture();
    const seen: DeployTargetResult[] = [];

    await runDeploy({
      data,
      dryRun: true,
      onTarget: (r) => {
        seen.push(r);
      },
    });

    // Must have fired — guards against the "callback is silently ignored"
    // baseline behaviour where the loop below trivially has zero iterations.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(4);

    for (const r of seen) {
      // The same discriminating shape the final results carry.
      expect(typeof r.ok).toBe("boolean");
      expect(typeof r.repoId).toBe("string");
      expect(typeof r.repoName).toBe("string");
      expect(typeof r.env).toBe("string");
      // For dry-run successes, writtenKeys must be populated — i.e. the
      // result is finished, not "pending".
      if (r.ok && !("skipped" in r)) {
        expect(Array.isArray(r.writtenKeys)).toBe(true);
      }
    }
  });

  it("passes a monotonically increasing index (0..N-1)", async () => {
    const data = fixture();
    const indices: number[] = [];

    await runDeploy({
      data,
      dryRun: true,
      onTarget: (_r, index) => {
        indices.push(index);
      },
    });

    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it("is awaited if it returns a promise (sequential, not racing the next target)", async () => {
    const data = fixture();
    const log: string[] = [];

    await runDeploy({
      data,
      dryRun: true,
      onTarget: async (r) => {
        log.push(`begin:${r.repoId}::${r.env}`);
        // Force a microtask boundary so a non-awaiting impl would interleave
        // the next target's iteration.
        await Promise.resolve();
        await Promise.resolve();
        log.push(`end:${r.repoId}::${r.env}`);
      },
    });

    // Guard against the baseline (callback ignored): the log MUST have
    // 2 entries per target — otherwise the loop below has zero iterations
    // and trivially passes.
    expect(log).toHaveLength(2 * 4);

    // Each begin must be paired immediately with its end before the next
    // begin appears — proves runDeploy awaited the callback.
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]!.startsWith("begin:")).toBe(true);
      expect(log[i + 1]!.startsWith("end:")).toBe(true);
      const beginKey = log[i]!.slice("begin:".length);
      const endKey = log[i + 1]!.slice("end:".length);
      expect(endKey).toBe(beginKey);
    }
  });

  it("the aggregate Promise still resolves with all results when onTarget is provided", async () => {
    // This test pulls double duty: it confirms the aggregate Promise still
    // resolves with every target's result AND that onTarget was actually
    // fired (so the "passes onTarget but it's silently dropped" baseline
    // doesn't trivially pass).
    const data = fixture();
    let invocations = 0;
    const results = await runDeploy({
      data,
      dryRun: true,
      onTarget: () => {
        invocations += 1;
      },
    });

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(invocations).toBe(4);
  });

  it("the callback receives the SAME result object that ends up in the array (reference equality)", async () => {
    const data = singleTargetFixture();
    let captured: DeployTargetResult | null = null;

    const results = await runDeploy({
      data,
      dryRun: true,
      onTarget: (r) => {
        captured = r;
      },
    });

    expect(results).toHaveLength(1);
    // The encoded contract is: onTarget gets a reference to the per-target
    // result that ends up at the same index in the returned array. This
    // guarantees no double-encoding / no transformation discrepancy
    // between the streamed event and the final aggregate.
    expect(captured).not.toBeNull();
    expect(results[0]).toBe(captured);
  });

  it("works without an onTarget callback (backwards-compatible)", async () => {
    const data = fixture();
    // No onTarget — original signature must still resolve with results.
    const results = await runDeploy({ data, dryRun: true });
    expect(results).toHaveLength(4);
  });

  it("does not fire onTarget when there are zero targets", async () => {
    const data = emptyTargetsFixture();
    let fired = 0;
    const results = await runDeploy({
      data,
      dryRun: true,
      onTarget: () => {
        fired += 1;
      },
    });
    expect(results).toHaveLength(0);
    expect(fired).toBe(0);
  });

  it("fires onTarget for skipped targets too (so the UI progress bar still advances)", async () => {
    // With localOnly: true and missing paths, the result is `{ok: true, skipped: true}`.
    // The progress bar must still advance for these — otherwise the user
    // sees a hang on the skipped target.
    const data: VaultData = {
      version: 2,
      repos: [
        { id: "ghost", name: "ghost", path: "/tmp/sm-ghost-does-not-exist-xyz", environments: ["test"] },
      ],
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "v",
          scopes: [{ repoId: "ghost", env: "test" }],
        },
      ],
    };

    const seen: DeployTargetResult[] = [];
    const results = await runDeploy({
      data,
      dryRun: false,
      localOnly: true,
      onTarget: (r) => {
        seen.push(r);
      },
    });

    expect(results).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok).toBe(true);
    if (seen[0]!.ok) {
      expect("skipped" in seen[0]! && seen[0]!.skipped).toBe(true);
    }
  });
});
