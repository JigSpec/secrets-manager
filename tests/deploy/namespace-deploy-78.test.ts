/**
 * tests/deploy/namespace-deploy-78.test.ts
 *
 * Authoritative lock-in for issue #78 — namespace is a vault-internal
 * disambiguator only; the env-var name written to .env.<env> is always the
 * bare `key`, regardless of namespace.
 *
 * Mix of unit tests (against `writtenKeyFor`, `detectCollisions`, `runDeploy`)
 * and daemon integration tests (against the `scope` and `deploy` IPC
 * handlers), matching the styles already used elsewhere in `tests/deploy/`
 * and `tests/cli/`.
 *
 * These tests are RED against the pre-#78 implementation. Implementation
 * (Agent D) will turn them GREEN.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectCollisions,
  writtenKeyFor,
} from "@/lib/vault/deploy/write-key";
import { runDeploy } from "@/lib/vault/deploy/run-deploy";
import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import { sendCommand } from "@/lib/cli/ipc-client";
import type { Secret, VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

function mk(over: Partial<Secret> & { id: string; key: string }): Secret {
  return {
    value: "v",
    scopes: [],
    ...over,
  } as Secret;
}

describe("issue #78 — writtenKeyFor ignores namespace", () => {
  it("returns the bare key for a namespaced secret", () => {
    // issue #78
    expect(
      writtenKeyFor({ key: "API_KEY", namespace: "stripe" }),
    ).toBe("API_KEY");
  });

  it("returns the bare key for a non-namespaced secret", () => {
    // issue #78
    expect(
      writtenKeyFor({ key: "DATABASE_URL", namespace: undefined }),
    ).toBe("DATABASE_URL");
  });

  it("is opaque to namespace (a property smoke check)", () => {
    // issue #78 — for every (key, namespace) pair, the written key equals
    // the bare key, never any transform of the namespace.
    const namespaces = [undefined, "stripe", "github", "sendgrid", "x"];
    const keys = ["API_KEY", "DATABASE_URL", "PORT", "AWS_SECRET"];
    for (const ns of namespaces) {
      for (const k of keys) {
        const got = writtenKeyFor({ key: k, namespace: ns as string | undefined });
        expect(got).toBe(k);
      }
    }
  });
});

describe("issue #78 — detectCollisions on bare key", () => {
  it("flags two namespaced secrets that share a bare key as a collision", () => {
    // issue #78
    const out = detectCollisions([
      mk({ id: "a", key: "API_KEY", namespace: "stripe" }),
      mk({ id: "b", key: "API_KEY", namespace: "github" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].writtenKey).toBe("API_KEY");
    expect(out[0].members.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("does NOT flag a historic NS_KEY-shaped pair (different bare keys)", () => {
    // issue #78 — pre-#78 these collided (STRIPE_API_KEY === STRIPE+API_KEY).
    // Post-#78 their written keys are distinct (`STRIPE_API_KEY` vs `API_KEY`).
    const out = detectCollisions([
      mk({ id: "a", key: "STRIPE_API_KEY" }),
      mk({ id: "b", key: "API_KEY", namespace: "stripe" }),
    ]);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runDeploy integration (in-process — no daemon)
// ---------------------------------------------------------------------------

describe("issue #78 — runDeploy writes bare keys (in-process)", () => {
  function vaultWith(secrets: Secret[]): VaultData {
    return {
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: "/tmp/__sm-deploy-78-fake__",
          environments: ["test", "live"],
        },
      ],
      secrets,
    };
  }

  it("a namespaced secret writes as its bare key under dry-run", async () => {
    // issue #78
    const data = vaultWith([
      mk({
        id: "s1",
        key: "API_KEY",
        namespace: "stripe",
        value: "sk_test_X",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
    ]);
    const results = await runDeploy({ data, dryRun: true });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r as { skipped?: boolean }).skipped).toBeFalsy();
    expect(
      (r as { writtenKeys?: string[] }).writtenKeys,
    ).toEqual(["API_KEY"]);
  });

  it("two same-cell secrets — one namespaced, one not — both write as bare keys", async () => {
    // issue #78 — covers the "mixed namespaced/non-namespaced" case from
    // the plan: { key: PORT } + { key: DB_URL, namespace: postgres }.
    const data = vaultWith([
      mk({
        id: "s1",
        key: "PORT",
        value: "3000",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
      mk({
        id: "s2",
        key: "DB_URL",
        namespace: "postgres",
        value: "postgres://",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
    ]);
    const results = await runDeploy({ data, dryRun: true });
    const r = results[0];
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      (r as { writtenKeys?: string[] }).writtenKeys?.sort(),
    ).toEqual(["DB_URL", "PORT"]);
  });

  it("two namespaced secrets with different bare keys both write as bare keys", async () => {
    // issue #78 — covers the basic "two namespaced secrets, different keys"
    // case from the plan; .env.<env> contains both as bare keys.
    const data = vaultWith([
      mk({
        id: "s1",
        key: "API_KEY",
        namespace: "stripe",
        value: "sk_test_A",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
      mk({
        id: "s2",
        key: "WEBHOOK_SECRET",
        namespace: "stripe",
        value: "whsec_B",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
    ]);
    const results = await runDeploy({ data, dryRun: true });
    const r = results[0];
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      (r as { writtenKeys?: string[] }).writtenKeys?.sort(),
    ).toEqual(["API_KEY", "WEBHOOK_SECRET"]);
  });

  it("deploy result no longer surfaces keyRemap for namespaced secrets", async () => {
    // issue #78 — keyRemap surfaced KEY → NS_KEY rewrites for the GUI deploy
    // sheet. Under the new contract there is no remap; the field should be
    // absent (or, if kept for back-compat, always empty).
    const data = vaultWith([
      mk({
        id: "s1",
        key: "API_KEY",
        namespace: "stripe",
        value: "sk_test_X",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
    ]);
    const results = await runDeploy({ data, dryRun: true });
    const r = results[0];
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const maybeRemap = (r as { keyRemap?: unknown }).keyRemap;
    // Either the field is gone entirely, or it's an empty array.
    const acceptable =
      maybeRemap === undefined ||
      (Array.isArray(maybeRemap) && maybeRemap.length === 0);
    expect(acceptable).toBe(true);
  });

  it("legacy vault collision is detected at deploy time", async () => {
    // issue #78 — defense-in-depth: a legacy vault that bypassed the
    // scope-time guard and has two namespaced secrets sharing the same bare
    // key in the same cell must still produce a COLLISION result, never a
    // silent overwrite.
    const data = vaultWith([
      mk({
        id: "s1",
        key: "API_KEY",
        namespace: "stripe",
        value: "sk_test_A",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
      mk({
        id: "s2",
        key: "API_KEY",
        namespace: "github",
        value: "gh_test_B",
        scopes: [{ repoId: "r1", env: "test" }],
      }),
    ]);
    const results = await runDeploy({ data, dryRun: true });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r as { code: string }).code).toBe("COLLISION");
    const collisions = (
      r as { collisions: Array<{ writtenKey: string; members: { id: string }[] }> }
    ).collisions;
    expect(collisions).toHaveLength(1);
    expect(collisions[0].writtenKey).toBe("API_KEY");
    expect(collisions[0].members.map((m) => m.id).sort()).toEqual(["s1", "s2"]);
  });
});

// ---------------------------------------------------------------------------
// Daemon integration — scope-time guard for same-key/different-ns collision
// ---------------------------------------------------------------------------

describe("issue #78 — scope-time guard rejects same-key collision regardless of namespace", () => {
  const SEED: VaultData = {
    version: 2,
    repos: [
      {
        id: "r1",
        name: "alpha",
        path: "/tmp/__sm-78-scope-fake__",
        environments: ["test", "live"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        namespace: "stripe",
        value: "sk_test_A",
        scopes: [{ repoId: "r1", env: "test" }],
      },
      {
        id: "s2",
        key: "API_KEY",
        namespace: "github",
        value: "gh_test_B",
        scopes: [],
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

  function call(req: { cmd: string; args?: Record<string, unknown> }) {
    return sendCommand(req, { socketPathOverride: daemon!.socketPath });
  }

  it("scope rejects adding the same cell already owned by a sibling with the same bare key (different namespace)", async () => {
    // issue #78 — s1 (API_KEY, ns=stripe) owns (r1, test). Attempting to
    // scope s2 (API_KEY, ns=github) into (r1, test) must be rejected even
    // though the namespaces differ, because both would write as bare
    // API_KEY in .env.test.
    const r = await call({
      cmd: "scope",
      args: { secret: "s2", repo: "alpha", env: "test" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// Daemon integration — bare-key deploy via the IPC handler
// ---------------------------------------------------------------------------

describe("issue #78 — daemon deploy --dryRun writes bare keys", () => {
  const SEED: VaultData = {
    version: 2,
    repos: [
      {
        id: "r1",
        name: "alpha",
        path: "/tmp/__sm-78-deploy-fake__",
        environments: ["test", "live"],
      },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        namespace: "stripe",
        value: "sk_test_X",
        scopes: [{ repoId: "r1", env: "test" }],
      },
      // s2: unscoped — must not affect any (r, env) writtenKeys.
      {
        id: "s2",
        key: "DATABASE_URL",
        value: "postgres://only-vault",
        scopes: [],
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

  function call(req: { cmd: string; args?: Record<string, unknown> }) {
    return sendCommand(req, { socketPathOverride: daemon!.socketPath });
  }

  it("namespaced secret deploys as bare key (no NS_ prefix)", async () => {
    // issue #78 — under the pre-#78 contract this would be STRIPE_API_KEY.
    const r = await call({ cmd: "deploy", args: { dryRun: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const results = r.results as Array<{
      ok: boolean;
      repoName: string;
      env: string;
      writtenKeys?: string[];
    }>;
    const cell = results.find(
      (x) => x.repoName === "alpha" && x.env === "test",
    );
    expect(cell?.writtenKeys?.sort()).toEqual(["API_KEY"]);
    // Belt-and-braces: the NS_KEY form must not appear anywhere in the
    // writtenKeys list for this cell.
    expect(cell?.writtenKeys ?? []).not.toContain("STRIPE_API_KEY");
  });
});
