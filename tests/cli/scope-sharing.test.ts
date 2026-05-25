/**
 * tests/cli/scope-sharing.test.ts
 *
 * RED tests for issue #16 — multiple secrets may share (key, namespace)
 * iff their scope sets are disjoint.
 *
 * ALL tests in this file are expected to FAIL with the current code and
 * PASS once the fix is applied.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import { sendCommand } from "@/lib/cli/ipc-client";
import type { VaultData } from "@/lib/vault/schema";

/**
 * Seed vault:
 *   s1: DATABASE_URL (no ns) → scoped to (r1, development)
 *   s2: DATABASE_URL (no ns) → scoped to (r2, development)
 *
 * Under the current code this vault is valid at load time, but any
 * mutation touching DATABASE_URL by bare key will hit the first match
 * and silently ignore s2, or will reject a rename that should be
 * allowed.
 */
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
      environments: ["development", "production"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://alpha",
      scopes: [{ repoId: "r1", env: "development" }],
    },
    {
      id: "s2",
      key: "DATABASE_URL",
      value: "postgres://beta",
      scopes: [{ repoId: "r2", env: "development" }],
    },
  ],
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeEach(async () => {
  tmp = await makeVaultDir();
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterEach(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
});

function s(req: { cmd: string; args?: Record<string, unknown> }) {
  return sendCommand(req, { socketPathOverride: daemon!.socketPath });
}

describe("scope-sharing: disjoint scope sets allow shared (key, namespace)", () => {
  /**
   * Test 1 — scope adds a disjoint cell to s2.
   *
   * s2 is currently scoped to (r2, development).  Adding (r2, production)
   * does NOT conflict with s1 (which owns r1/development only), so it
   * must succeed.
   *
   * FAILS TODAY because the fix hasn't implemented conflict-aware scoping
   * — the current code would succeed but for the wrong reason (it doesn't
   * validate sibling conflicts), OR because the vault rejects loading a
   * seed with two secrets sharing (key, namespace).
   *
   * After the fix: succeeds and the returned secret includes the new scope.
   */
  it("scope allows adding a disjoint cell to s2 (r2/production)", async () => {
    const r = await s({
      cmd: "scope",
      args: { secret: "s2", repo: "beta", env: "production" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as { id: string; scopes: { repoId: string; env: string }[] };
    expect(sec.id).toBe("s2");
    expect(
      sec.scopes.some((sc) => sc.repoId === "r2" && sc.env === "production"),
    ).toBe(true);
  });

  /**
   * Test 2 — scope rejects a conflicting cell.
   *
   * s1 already owns (r1, development).  Attempting to scope s2 to
   * (r1, development) creates an overlap — both s1 and s2 would serve
   * DATABASE_URL in r1/development.  The handler must return CONFLICT.
   *
   * FAILS TODAY: the current scope handler does not check sibling
   * secrets for cell conflicts.
   */
  it("scope rejects adding a cell already owned by a sibling (r1/development → CONFLICT)", async () => {
    const r = await s({
      cmd: "scope",
      args: { secret: "s2", repo: "alpha", env: "development" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
  });

  /**
   * Test 3 — scope adds a disjoint cell to s1.
   *
   * s1 is scoped to (r1, development).  (r1, production) is not owned
   * by any other DATABASE_URL secret, so adding it must succeed.
   *
   * FAILS TODAY for the same reason as test 1.
   */
  it("scope allows adding a disjoint cell to s1 (r1/production)", async () => {
    const r = await s({
      cmd: "scope",
      args: { secret: "s1", repo: "alpha", env: "production" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as { id: string; scopes: { repoId: string; env: string }[] };
    expect(sec.id).toBe("s1");
    expect(
      sec.scopes.some((sc) => sc.repoId === "r1" && sc.env === "production"),
    ).toBe(true);
  });

  /**
   * Test 4 — rename-secret succeeds when the new key's sibling scopes
   * are all disjoint from the secret being renamed.
   *
   * Rename s1 to ALPHA_URL (r1/dev), then rename s2 to ALPHA_URL (r2/dev).
   * The two ALPHA_URL secrets have disjoint scopes, so the second rename
   * must succeed.
   *
   * FAILS TODAY: rename-secret rejects any rename when another secret
   * already has the same (key, namespace).
   */
  it("rename-secret succeeds when new key siblings are disjoint", async () => {
    // Rename s1 to ALPHA_URL first.
    const rename1 = await s({
      cmd: "rename-secret",
      args: { secret: "s1", newKey: "ALPHA_URL" },
    });
    expect(rename1.ok).toBe(true);

    // Now rename s2 to ALPHA_URL.  s1 already has ALPHA_URL at r1/dev;
    // s2 is at r2/dev — disjoint.  The fix must allow this.
    const rename2 = await s({
      cmd: "rename-secret",
      args: { secret: "s2", newKey: "ALPHA_URL" },
    });
    expect(rename2.ok).toBe(true);
    if (!rename2.ok) return;
    expect((rename2.secret as { key: string }).key).toBe("ALPHA_URL");
  });

  /**
   * Test 5 — rename-secret rejects when new key's sibling scopes overlap.
   *
   * We scope s2 to also cover (r1, development) in a setup where s1
   * already owns that cell, then attempt a rename of another secret to
   * DATABASE_URL — the rename would land s2 in conflict with s1.
   *
   * Simpler version: rename s1 to SHARED_KEY at r1/dev, then try to
   * rename s2 (r2/dev) to SHARED_KEY.  That's disjoint and should
   * succeed (covered by test 4).  For a CONFLICT we need overlapping
   * scopes.  We set up fresh secrets where overlap exists:
   *   s3: ANOTHER_KEY (no ns) → scoped to (r1, development)  [same cell as s1]
   * Then rename s2 to ANOTHER_KEY → would make ANOTHER_KEY own both r2/dev
   * (from s2) and r1/dev (from s3).  But s1 (DATABASE_URL) already owns
   * r1/dev.  After the rename s2 becomes ANOTHER_KEY — the only conflict
   * would be among ANOTHER_KEY siblings.  s3 at r1/dev and s2 (renamed)
   * at r2/dev are disjoint → that's fine.
   *
   * To get a true overlap we need s1 and s2 to BOTH touch the same cell
   * under the target key.  We do this:
   *   - rename s1 → SHARED_KEY  (r1/dev)
   *   - scope s2 to r1/dev first (currently blocked — will pass post-fix)
   *   - rename s2 → SHARED_KEY  (r1/dev + r2/dev)
   *   s2 after rename would share r1/dev with s1 → CONFLICT
   *
   * However, scoping s2 to r1/dev is itself gated on test 2 passing.
   * So we use a different, self-contained approach with a 3-secret seed:
   */
  it("rename-secret rejects rename when new key sibling already owns one of the target secret scopes", async () => {
    // We'll build up the conflict state through commands rather than relying
    // on a different seed, using the existing 2-secret vault:
    //   s1: DATABASE_URL at r1/dev
    //   s2: DATABASE_URL at r2/dev
    //
    // Step 1: rename s1 → CONFLICT_KEY   (s1 now at r1/dev as CONFLICT_KEY)
    const step1 = await s({
      cmd: "rename-secret",
      args: { secret: "s1", newKey: "CONFLICT_KEY" },
    });
    expect(step1.ok).toBe(true);

    // Step 2: scope s2 to r1/development in addition to r2/dev.
    //   This requires the fix to be in place (test 2 covers the CONFLICT
    //   guard; here we need it to *succeed* because CONFLICT_KEY s1 is at
    //   r1/dev, not DATABASE_URL anymore).  DATABASE_URL s2 going to r1/dev
    //   should now be allowed since no other DATABASE_URL owns r1/dev.
    const step2 = await s({
      cmd: "scope",
      args: { secret: "s2", repo: "alpha", env: "development" },
    });
    expect(step2.ok).toBe(true);

    // Step 3: rename s2 (DATABASE_URL, now scoped to r1/dev + r2/dev) →
    //   CONFLICT_KEY.  s1 (CONFLICT_KEY) owns r1/dev.  s2 also owns r1/dev.
    //   Overlap → CONFLICT.
    const step3 = await s({
      cmd: "rename-secret",
      args: { secret: "s2", newKey: "CONFLICT_KEY" },
    });
    expect(step3.ok).toBe(false);
    if (step3.ok) return;
    expect(step3.code).toBe("CONFLICT");
  });

  /**
   * Test 6 — bare-key lookup returns AMBIGUOUS when multiple secrets share
   * the same (key, namespace) tuple.
   *
   * With s1 and s2 both keyed "DATABASE_URL" (no namespace), using the
   * bare key as the `secret` selector must surface an AMBIGUOUS error
   * rather than silently picking the first match.
   *
   * FAILS TODAY: _resolve.ts::findSecret returns the first match with no
   * AMBIGUOUS check.  The scope handler succeeds silently on s1.
   */
  it("scope with bare key returns AMBIGUOUS when multiple secrets share the key", async () => {
    const r = await s({
      cmd: "scope",
      // Use bare key — should be ambiguous since both s1 and s2 have
      // key="DATABASE_URL" with no namespace.
      args: { secret: "DATABASE_URL", repo: "alpha", env: "production" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("AMBIGUOUS");
  });
});
