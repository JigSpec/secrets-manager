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
import { sendCommand } from "@/lib/cli/ipc-client";
import type { VaultData } from "@/lib/vault/schema";

/**
 * Strings the daemon may emit that are longer than the short-string cap (16
 * chars). Anything longer must match one of these allowlisted shapes — the
 * point is to make leaks of unstructured high-entropy strings (a plaintext
 * secret, an unbounded blob) obvious.
 *
 * The order matters only for readability — the test ORs them.
 */
const ALLOWLIST_REGEXES: Array<{ name: string; rx: RegExp }> = [
  // Random 16-char hex id (covers `newId()` and value fingerprints).
  { name: "16-hex-id-or-fingerprint", rx: /^[a-f0-9]{16}$/ },
  // Env-var key shape: A-Z, digits, underscore. Used for `key` and
  // `writtenKeys`. (Pre-#78 also `keyRemap.source` / `keyRemap.written`.)
  { name: "env-var-key", rx: /^[A-Z_][A-Z0-9_]*$/ },
  // Absolute filesystem path (repo paths, fixture paths).
  { name: "absolute-path", rx: /^\/.*$/ },
  // Namespace label.
  { name: "namespace-label", rx: /^[a-z][a-z0-9]*$/ },
];

/**
 * Field path suffixes whose contents are deliberately freeform (human-
 * readable error blurbs, request echo). These bypass the allowlist; they're
 * not where a plaintext value would hide.
 */
const FREEFORM_PATH_SUFFIXES = [
  ".error",
  ".message",
  ".reason",
];

function isAllowedString(value: string, path: string): boolean {
  if (value.length <= 16) return true;
  if (FREEFORM_PATH_SUFFIXES.some((suf) => path.endsWith(suf))) return true;
  return ALLOWLIST_REGEXES.some((rule) => rule.rx.test(value));
}

type Offender = { path: string; value: string };

function collectOffenders(node: unknown, prefix = "$"): Offender[] {
  const out: Offender[] = [];
  if (node === null || node === undefined) return out;
  if (typeof node === "string") {
    if (!isAllowedString(node, prefix)) {
      out.push({ path: prefix, value: node });
    }
    return out;
  }
  if (typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      out.push(...collectOffenders(child, `${prefix}[${i}]`));
    });
    return out;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out.push(...collectOffenders(v, `${prefix}.${k}`));
  }
  return out;
}

const SEED: VaultData = {
  version: 2,
  repos: [
    {
      id: "r1",
      name: "alpha",
      path: "/repos/alpha",
      environments: ["development", "production"],
    },
  ],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "high-entropy-value-AAAAAAAAAAAA",
      scopes: [{ repoId: "r1", env: "development" }],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "second-high-entropy-AAAAAAAAAA",
      scopes: [{ repoId: "r1", env: "development" }],
    },
  ],
};

let tmp: string;
let scratch: string;
let realRepo: string;
let daemon: SpawnedDaemon | null = null;

beforeEach(async () => {
  tmp = await makeVaultDir();
  scratch = await mkdtemp(path.join(tmpdir(), "sm-noblob-"));
  realRepo = await mkdtemp(path.join(tmpdir(), "sm-repo-"));
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
  await rm(scratch, { recursive: true, force: true });
  await rm(realRepo, { recursive: true, force: true });
});

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

async function tmpFile(content: string): Promise<string> {
  const p = path.join(scratch, `v-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(p, content, "utf8");
  return p;
}

describe("CLI responses contain no long unstructured strings", () => {
  it("every long string field in every response matches an allowlisted shape", async () => {
    const responses: Array<{ cmd: string; resp: unknown }> = [];
    const record = async (cmd: string, args?: Record<string, unknown>) => {
      const r = await s(cmd, args);
      responses.push({ cmd, resp: r });
    };

    // Happy-path sweep — error blurbs are excluded from this check via the
    // freeform-suffix allowlist, but we still keep error responses out so the
    // matrix stays representative.
    await record("list-repos");
    await record("list-secrets");
    await record("list-scopes");
    await record("describe-secret", { id: "DATABASE_URL" });
    await record("describe-secret", { id: "s2" });
    await record("find-shared");

    await record("scope", {
      secret: "API_KEY",
      repo: "alpha",
      env: "production",
    });
    await record("unscope", {
      secret: "API_KEY",
      repo: "alpha",
      env: "production",
    });
    await record("set-namespace", { secret: "s1", namespace: "supabase" });
    await record("set-namespace", { secret: "s1", unset: true });
    await record("rename-secret", { secret: "DATABASE_URL", newKey: "DB_URL" });
    await record("rename-secret", { secret: "DB_URL", newKey: "DATABASE_URL" });

    await record("add-repo", {
      name: "beta",
      path: realRepo,
      environments: ["development"],
    });
    await record("set-repo-envs", {
      target: "beta",
      environments: ["development", "staging"],
    });
    await record("remove-repo", { target: "beta" });

    const f1 = await tmpFile("brand-new-high-entropy-AAAAAAA");
    await record("add-secret", { key: "NEW_KEY", valuePath: f1 });

    const f2 = await tmpFile("replacement-high-entropy-AAAAAA");
    await record("set-value", { secret: "DATABASE_URL", valuePath: f2 });

    await record("remove-secret", { target: "NEW_KEY" });

    await writeFile(path.join(realRepo, ".env.development"), "# empty\n");
    await record("add-repo", {
      name: "beta",
      path: realRepo,
      environments: ["development"],
    });
    await record("import", { repo: "beta", dryRun: true });

    await record("deploy", { dryRun: true });
    await record("deploy", { dryRun: true, repo: "alpha" });

    const allOffenders: Array<{
      cmd: string;
      offenders: Offender[];
    }> = [];
    for (const { cmd, resp } of responses) {
      const offs = collectOffenders(resp);
      if (offs.length > 0) allOffenders.push({ cmd, offenders: offs });
    }
    expect(
      allOffenders,
      `unallowlisted long strings detected:\n${JSON.stringify(allOffenders, null, 2)}`,
    ).toEqual([]);
  });

  it("rejects a synthetic payload with a long opaque string (allowlist control)", () => {
    const bad = {
      ok: true,
      secrets: [
        {
          id: "abcdef0123456789",
          key: "K",
          leaked: "definitely-not-an-env-var-or-path-or-namespace",
        },
      ],
    };
    const offs = collectOffenders(bad);
    expect(offs.map((o) => o.path)).toEqual(["$.secrets[0].leaked"]);

    const good = {
      ok: true,
      secrets: [
        {
          id: "abcdef0123456789",
          key: "VERY_LONG_BUT_VALID_ENV_KEY",
          namespace: "supabase",
        },
      ],
    };
    expect(collectOffenders(good)).toEqual([]);
  });

  it("treats absolute paths as allowlisted regardless of length", () => {
    const node = {
      repoPath: "/a/very/long/absolute/path/that/exceeds/sixteen",
    };
    expect(collectOffenders(node)).toEqual([]);
  });
});
