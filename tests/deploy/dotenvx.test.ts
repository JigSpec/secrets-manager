import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as dotenvx from "@dotenvx/dotenvx";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DeployOptions,
  type DeployResult,
  type DotenvxSetFn,
  deployToScope,
  extractPublicKey,
} from "@/lib/deploy/dotenvx";

/* -------------------------------------------------------------------------- */
/* Test utilities                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A real secp256k1 public key (compressed, 66 hex chars) harvested from a
 * scratch `dotenvx.set` run. Reusing this lets us exercise the real
 * `dotenvx.set` against a known-good header.
 */
const REAL_PUBLIC_KEY =
  "0381855245d4130405a9581ebc74cb0d5ee7ed9938bee58d7264a0ce1c3d52fcbd";

/** A fake hex key — never sent to real crypto; only used with stubbed setFn. */
const FAKE_PUBLIC_KEY =
  "02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

const ALT_PUBLIC_KEY =
  "03ffeeddccbbaa00112233445566778899aabbccddeeff00112233445566778899";

let tmpRoots: string[] = [];

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s5-deploy-"));
  tmpRoots.push(root);
  return root;
}

/**
 * Write an executable stub script that the module will exec instead of the
 * real `dotenvx-ops` binary. Returns the absolute path to use as
 * `dotenvxOpsBin`.
 *
 * `body` is plain shell; it gets to read $PWD and arguments.
 */
async function writeStubBinary(
  body: string,
  marker = "default"
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `s5-ops-${marker}-`));
  tmpRoots.push(dir);
  const file = path.join(dir, "dotenvx-ops");
  const script = `#!/bin/sh\n${body}\n`;
  await fs.writeFile(file, script, { mode: 0o755 });
  // mkdtemp may not preserve the mode if umask is set — chmod to be safe.
  await fs.chmod(file, 0o755);
  return file;
}

/**
 * A `DotenvxSetFn` stub that writes a deterministic fake encrypted line
 * for the given (key, value). Records each call.
 */
function makeFakeSetFn(opts?: {
  failOn?: string;
  failViaThrow?: boolean;
}): DotenvxSetFn & {
  calls: Array<{ key: string; value: string; path: string }>;
} {
  const calls: Array<{ key: string; value: string; path: string }> = [];
  const fn = (function impl(
    key: string,
    value: string,
    options: { path: string }
  ) {
    calls.push({ key, value, path: options.path });
    if (opts?.failOn === key) {
      if (opts.failViaThrow) {
        throw new Error(`forced throw on ${key}`);
      }
      return {
        processedEnvs: [
          {
            key,
            error: { code: "INVALID_PUBLIC_KEY", message: "forced failure" },
          },
        ],
        changedFilepaths: [],
        unchangedFilepaths: [options.path],
      };
    }
    // Eagerly upsert the line into the file so the on-disk contents reflect
    // the stub's behaviour (mirrors how the real dotenvx.set updates the
    // file synchronously).
    const fsSync = require("node:fs") as typeof import("node:fs");
    const current = fsSync.existsSync(options.path)
      ? fsSync.readFileSync(options.path, "utf8")
      : "";
    const line = `${key}="encrypted:fake:${Buffer.from(value).toString("base64")}"`;
    const linePattern = new RegExp(`^${key}=.*$`, "m");
    const next = linePattern.test(current)
      ? current.replace(linePattern, line)
      : current.endsWith("\n") || current.length === 0
        ? current + line + "\n"
        : current + "\n" + line + "\n";
    fsSync.writeFileSync(options.path, next, "utf8");
    return {
      processedEnvs: [{ key }],
      changedFilepaths: [options.path],
      unchangedFilepaths: [],
    };
  }) as unknown as DotenvxSetFn & {
    calls: Array<{ key: string; value: string; path: string }>;
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  for (const r of tmpRoots) {
    await fs.rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

/* -------------------------------------------------------------------------- */
/* Unit: extractPublicKey                                                      */
/* -------------------------------------------------------------------------- */

describe("extractPublicKey", () => {
  it("returns hex when the var matches with double quotes", () => {
    const c = `DOTENV_PUBLIC_KEY_PRODUCTION="${REAL_PUBLIC_KEY}"\nFOO=bar\n`;
    expect(extractPublicKey(c, "production")).toBe(REAL_PUBLIC_KEY);
  });

  it("returns hex when the var matches without quotes", () => {
    const c = `DOTENV_PUBLIC_KEY_STAGING=${REAL_PUBLIC_KEY}\n`;
    expect(extractPublicKey(c, "staging")).toBe(REAL_PUBLIC_KEY);
  });

  it("returns null when missing", () => {
    expect(extractPublicKey("KEEP=1\n", "production")).toBeNull();
  });

  it("uppercases env name", () => {
    const c = `DOTENV_PUBLIC_KEY_DEVELOPMENT="${REAL_PUBLIC_KEY}"\n`;
    expect(extractPublicKey(c, "development")).toBe(REAL_PUBLIC_KEY);
  });
});

/* -------------------------------------------------------------------------- */
/* Integration: deployToScope                                                  */
/* -------------------------------------------------------------------------- */

describe("deployToScope — empty repo provisions a keypair", () => {
  it("invokes the stub binary, writes the public key, and writes encrypted owned keys", async () => {
    const repo = await mkRepo();
    // Stub binary writes the public-key header into the env file.
    const stub = await writeStubBinary(
      `cat > "$PWD/.env.production" <<EOF
DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"
EOF
exit 0`,
      "empty"
    );
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { ALPHA: "one", BETA: "two" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKey).toBe(FAKE_PUBLIC_KEY);
    expect(result.ownedKeyCount).toBe(2);
    expect(result.envFilePath).toBe(path.join(repo, ".env.production"));

    const after = await fs.readFile(result.envFilePath, "utf8");
    expect(after).toContain(`DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"`);
    expect(after).toContain("ALPHA=");
    expect(after).toContain("BETA=");
    expect(setFn.calls.map((c) => c.key)).toEqual(["ALPHA", "BETA"]);
  });
});

describe("deployToScope — public key already present", () => {
  it("does NOT shell out and uses the real dotenvx.set", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    const initial = `DOTENV_PUBLIC_KEY_PRODUCTION="${REAL_PUBLIC_KEY}"\nKEEPME="value-i-care-about"\n`;
    await fs.writeFile(envFile, initial, "utf8");

    // Stub binary that fails the test if it ever runs.
    const stub = await writeStubBinary(
      `echo "stub should not have been called" >&2
exit 99`,
      "no-call"
    );

    // Use the real @dotenvx/dotenvx.set — it should encrypt MY_KEY against
    // the embedded public key. We do not stub setFn here.
    const result = await deployToScope(
      repo,
      "production",
      { MY_KEY: "hello" },
      { dotenvxOpsBin: stub }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKey).toBe(REAL_PUBLIC_KEY);

    const after = await fs.readFile(envFile, "utf8");
    expect(after).toContain('KEEPME="value-i-care-about"');
    expect(after).toMatch(/MY_KEY="encrypted:[^"]+"/);
  });
});

describe("deployToScope — unowned keys preserved on update", () => {
  it("rewrites only the owned key, leaves others untouched", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    // Seed with header + an unowned key. Then run a first deploy to produce a
    // real (valid) ciphertext for AN_OWNED, so the second pass exercises the
    // "owned key already encrypted, must be replaced in place" path.
    const seed = [
      `DOTENV_PUBLIC_KEY_PRODUCTION="${REAL_PUBLIC_KEY}"`,
      `KEEPME="raw"`,
      "",
    ].join("\n");
    await fs.writeFile(envFile, seed, "utf8");

    const stub = await writeStubBinary(
      `echo "should not run" >&2
exit 99`,
      "no-call-2"
    );

    // First deploy: writes AN_OWNED="encrypted:<real-ciphertext>".
    const first = await deployToScope(
      repo,
      "production",
      { AN_OWNED: "oldval" },
      { dotenvxOpsBin: stub }
    );
    expect(first.ok).toBe(true);

    const afterFirst = await fs.readFile(envFile, "utf8");
    const firstOwnedLine = afterFirst
      .split("\n")
      .find((l) => l.startsWith("AN_OWNED="));
    expect(firstOwnedLine).toBeDefined();

    // Second deploy: updates AN_OWNED to newval, KEEPME must be untouched.
    const result = await deployToScope(
      repo,
      "production",
      { AN_OWNED: "newval" },
      { dotenvxOpsBin: stub }
    );
    expect(result.ok).toBe(true);

    const after = await fs.readFile(envFile, "utf8");
    expect(after).toContain('KEEPME="raw"');
    // Exactly one AN_OWNED line, and it must have changed ciphertext.
    const lines = after.split("\n").filter((l) => l.startsWith("AN_OWNED="));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^AN_OWNED="encrypted:[^"]+"/);
    expect(lines[0]).not.toBe(firstOwnedLine);
  });
});

describe("deployToScope — rotation simulated", () => {
  it("re-encrypts with the new public key when the header is swapped", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");

    // Phase A: write file with PUBLIC_KEY_A and a stale encrypted MY_KEY.
    const phaseA = [
      `DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"`,
      `MY_KEY="encrypted:fake:b2xkLXZhbHVl"`, // base64("old-value")
      "",
    ].join("\n");
    await fs.writeFile(envFile, phaseA, "utf8");

    // Phase B: caller rotated to ALT_PUBLIC_KEY in the file header.
    const phaseB = phaseA.replace(FAKE_PUBLIC_KEY, ALT_PUBLIC_KEY);
    await fs.writeFile(envFile, phaseB, "utf8");

    // Use a recording stub setFn that captures which public key it would
    // have used (by reading the file inline) and writes a marker line.
    const observedKeys: string[] = [];
    const setFn: DotenvxSetFn = (key, value, opts) => {
      const fsSync = require("node:fs") as typeof import("node:fs");
      const cur = fsSync.readFileSync(opts.path, "utf8");
      const pk = extractPublicKey(cur, "production");
      if (pk) observedKeys.push(pk);
      const line = `${key}="encrypted:fake:${pk?.slice(0, 8) ?? "??"}:${Buffer.from(value).toString("base64")}"`;
      const re = new RegExp(`^${key}=.*$`, "m");
      const next = re.test(cur) ? cur.replace(re, line) : cur + line + "\n";
      fsSync.writeFileSync(opts.path, next, "utf8");
      return {
        processedEnvs: [{ key }],
        changedFilepaths: [opts.path],
        unchangedFilepaths: [],
      };
    };

    const stub = await writeStubBinary(`exit 99`, "rotate-noop");
    const result = await deployToScope(
      repo,
      "production",
      { MY_KEY: "newval" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKey).toBe(ALT_PUBLIC_KEY);
    expect(observedKeys).toEqual([ALT_PUBLIC_KEY]);

    const after = await fs.readFile(envFile, "utf8");
    expect(after).toContain(`DOTENV_PUBLIC_KEY_PRODUCTION="${ALT_PUBLIC_KEY}"`);
    expect(after).toMatch(/MY_KEY="encrypted:fake:[0-9a-f]{8}:/);
    expect(after).not.toContain("b2xkLXZhbHVl"); // old base64 gone
  });
});

describe("deployToScope — repo path missing", () => {
  it("returns REPO_PATH_NOT_FOUND when the repo dir does not exist", async () => {
    const ghost = path.join(os.tmpdir(), `s5-ghost-${Date.now()}-${Math.random()}`);
    const result = await deployToScope(ghost, "production", { K: "v" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REPO_PATH_NOT_FOUND");
  });

  it("returns REPO_PATH_NOT_FOUND when the path is a file, not a dir", async () => {
    const dir = await mkRepo();
    const file = path.join(dir, "iam-a-file");
    await fs.writeFile(file, "x");
    const result = await deployToScope(file, "production", { K: "v" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REPO_PATH_NOT_FOUND");
  });
});

describe("deployToScope — dotenvx-ops failure surfaces", () => {
  it("returns DOTENVX_OPS_NOT_LOGGED_IN when stderr mentions login", async () => {
    const repo = await mkRepo();
    const stub = await writeStubBinary(
      `echo "Error: not logged in" >&2
exit 1`,
      "noauth"
    );
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn, requireDotenvxOps: true }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOTENVX_OPS_NOT_LOGGED_IN");
    expect(setFn.calls).toHaveLength(0);
  });

  it("returns DOTENVX_OPS_FAILED when stub fails generically", async () => {
    const repo = await mkRepo();
    const stub = await writeStubBinary(
      `echo "kaboom" >&2
exit 2`,
      "fail"
    );
    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: stub,
        dotenvxSetFn: makeFakeSetFn(),
        requireDotenvxOps: true,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DOTENVX_OPS_FAILED");
  });

  it("extracts public key from stdout when the CLI emits it but does not write the file", async () => {
    const repo = await mkRepo();
    const stub = await writeStubBinary(
      `echo "${FAKE_PUBLIC_KEY}"
exit 0`,
      "stdout-pk"
    );
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKey).toBe(FAKE_PUBLIC_KEY);

    const after = await fs.readFile(result.envFilePath, "utf8");
    expect(after).toContain(`DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"`);
    expect(after).toContain("K=");
  });
});

describe("deployToScope — partial-failure guard restores snapshot", () => {
  it("reverts the file when the second key fails and returns ENCRYPTION_FAILED", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    const initial = [
      `DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"`,
      `KEEPME="precious"`,
      "",
    ].join("\n");
    await fs.writeFile(envFile, initial, "utf8");

    const stub = await writeStubBinary(`exit 99`, "no-call-partial");
    const setFn = makeFakeSetFn({ failOn: "BAD" });

    const result = await deployToScope(
      repo,
      "production",
      { GOOD: "1", BAD: "2", LATER: "3" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ENCRYPTION_FAILED");
    expect(result.error).toContain("BAD");

    // File should be back to its pre-deploy state.
    const after = await fs.readFile(envFile, "utf8");
    expect(after).toBe(initial);
    // The third key should never have been attempted.
    expect(setFn.calls.map((c) => c.key)).toEqual(["GOOD", "BAD"]);
  });

  it("reverts the file when setFn throws", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    const initial = `DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"\nKEEPME="x"\n`;
    await fs.writeFile(envFile, initial, "utf8");

    const stub = await writeStubBinary(`exit 99`, "no-call-throw");
    const setFn = makeFakeSetFn({ failOn: "BAD", failViaThrow: true });

    const result = await deployToScope(
      repo,
      "production",
      { GOOD: "1", BAD: "2" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ENCRYPTION_FAILED");

    const after = await fs.readFile(envFile, "utf8");
    expect(after).toBe(initial);
  });
});

describe("deployToScope — env name casing", () => {
  it("uses lowercase env in the filename and uppercase in the var name", async () => {
    const repo = await mkRepo();
    const stub = await writeStubBinary(
      `echo "${FAKE_PUBLIC_KEY}"
exit 0`,
      "casing"
    );
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "Staging",
      { K: "v" },
      { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envFilePath).toBe(path.join(repo, ".env.staging"));
    const after = await fs.readFile(result.envFilePath, "utf8");
    expect(after).toContain("DOTENV_PUBLIC_KEY_STAGING=");
  });
});

// Type-narrowing helper consumer: silence unused warnings when destructuring.
function _consume(r: DeployResult) {
  return r;
}
void _consume;
void vi;

/* -------------------------------------------------------------------------- */
/* Integration: deployToScope — local keypair fallback (issue #59)             */
/* -------------------------------------------------------------------------- */

/**
 * Tests for the new local-keypair fallback path. When `dotenvx-ops` is either
 * missing on PATH or refuses (not-logged-in), the deploy pipeline should:
 *   - locally generate a secp256k1 keypair,
 *   - write the public key into the .env file,
 *   - persist the private key to `<privateKeyDir>/<basename>-<hash16>/<env>.private.key`
 *     with mode 0o600 (owner-only),
 *   - return ok: true with `publicKey` matching the header.
 *
 * Flag `requireDotenvxOps: true` disables the fallback entirely so CI/prod
 * deployments fail loudly rather than silently degrade.
 *
 * Agent C: these tests MUST be RED until Agent D implements the fallback in
 * `lib/deploy/dotenvx.ts`. Do not skip or weaken.
 */
describe("deployToScope — local keypair fallback", () => {
  /** Local DeployOptions extension so the new option compiles in tests. */
  type FallbackOptions = DeployOptions & {
    requireDotenvxOps?: boolean;
    privateKeyDir?: string;
  };

  /** Match the privkey-dir naming convention spec'd by Agent B. */
  const hashRepo = (p: string): string =>
    createHash("sha256").update(p).digest("hex").slice(0, 16);

  async function mkPrivkeyDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "s5-pk-"));
    tmpRoots.push(dir);
    return dir;
  }

  function expectedPrivkeyPath(
    privateKeyDir: string,
    repo: string,
    env: string
  ): string {
    return path.join(
      privateKeyDir,
      `${path.basename(repo)}-${hashRepo(repo)}`,
      `${env.toLowerCase()}.private.key`
    );
  }

  it("falls back to local keypair when ops binary is missing", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: "/nonexistent/dotenvx-ops-DNE",
        dotenvxSetFn: setFn,
        privateKeyDir,
      } as FallbackOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // .env.production has the public-key header.
    const envFile = path.join(repo, ".env.production");
    const after = await fs.readFile(envFile, "utf8");
    const pkHeader = extractPublicKey(after, "production");
    expect(pkHeader).not.toBeNull();
    expect(after).toContain(`DOTENV_PUBLIC_KEY_PRODUCTION="${pkHeader}"`);
    expect(result.publicKey).toBe(pkHeader);

    // Private key file written with mode 0o600 at the expected path.
    const privkeyPath = expectedPrivkeyPath(privateKeyDir, repo, "production");
    const st = await fs.stat(privkeyPath);
    expect(st.isFile()).toBe(true);
    // mask off file-type bits; only compare permission bits.
    expect(st.mode & 0o777).toBe(0o600);

    // Privkey file should be non-empty and hex.
    const pkContents = (await fs.readFile(privkeyPath, "utf8")).trim();
    expect(pkContents.length).toBeGreaterThan(0);
    expect(pkContents).toMatch(/[0-9a-fA-F]+/);
  });

  it("falls back when ops binary reports not-logged-in", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    const stub = await writeStubBinary(
      `echo "Error: not logged in" >&2
exit 1`,
      "fallback-noauth"
    );
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: stub,
        dotenvxSetFn: setFn,
        privateKeyDir,
      } as FallbackOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const envFile = path.join(repo, ".env.production");
    const after = await fs.readFile(envFile, "utf8");
    const pkHeader = extractPublicKey(after, "production");
    expect(pkHeader).not.toBeNull();
    expect(result.publicKey).toBe(pkHeader);

    const privkeyPath = expectedPrivkeyPath(privateKeyDir, repo, "production");
    const st = await fs.stat(privkeyPath);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("private key is round-trippable via dotenvx.keypair", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { ALPHA: "one" },
      {
        dotenvxOpsBin: "/nonexistent/dotenvx-ops-DNE",
        dotenvxSetFn: setFn,
        privateKeyDir,
      } as FallbackOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const envFilePath = path.join(repo, ".env.production");
    const privkeyPath = expectedPrivkeyPath(privateKeyDir, repo, "production");
    const persisted = (await fs.readFile(privkeyPath, "utf8")).trim();

    // dotenvx.keypair returns an object of DOTENV_PRIVATE_KEY_<ENV> => hex.
    // Signature: keypair(envFile, key, envKeysFile = null, noOps = false)
    // The fourth arg `true` disables the dotenvx-ops network path.
    const keypairs = (
      dotenvx as unknown as {
        keypair: (
          envFile: string,
          key: undefined,
          envKeysFile: null,
          noOps: boolean
        ) => Record<string, string>;
      }
    ).keypair(envFilePath, undefined, null, true);

    expect(keypairs).toBeTruthy();
    expect(keypairs.DOTENV_PRIVATE_KEY_PRODUCTION).toBe(persisted);

    // Round-trip a real value: encrypt with public key, decrypt with private.
    // Note: this uses the REAL dotenvx.set (no stub) so encryption is genuine.
    const realResult = await deployToScope(
      repo,
      "production",
      { ROUND_TRIP: "secret-value" },
      {
        dotenvxOpsBin: "/nonexistent/dotenvx-ops-DNE",
        privateKeyDir,
      } as FallbackOptions
    );
    expect(realResult.ok).toBe(true);

    // Decrypt via dotenvx.get using the persisted private key.
    const got = (
      dotenvx as unknown as {
        get: (
          key: string,
          options: { path: string; privateKey: string }
        ) => string | undefined;
      }
    ).get("ROUND_TRIP", { path: envFilePath, privateKey: persisted });
    expect(got).toBe("secret-value");
  });

  it("SM_REQUIRE_DOTENVX_OPS=1 disables fallback when ops missing", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: "/nonexistent/dotenvx-ops-DNE",
        dotenvxSetFn: setFn,
        privateKeyDir,
        requireDotenvxOps: true,
      } as FallbackOptions
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.code === "DOTENVX_OPS_NOT_LOGGED_IN" ||
        result.code === "DOTENVX_OPS_FAILED"
    ).toBe(true);

    // nextStep must be a non-empty string mentioning the override flag.
    const nextStep = (result as unknown as { nextStep?: string }).nextStep;
    expect(typeof nextStep).toBe("string");
    expect(nextStep && nextStep.length).toBeGreaterThan(0);
    expect(nextStep).toContain("SM_REQUIRE_DOTENVX_OPS");

    // No private-key file should have been written when fallback is disabled.
    const privkeyPath = expectedPrivkeyPath(privateKeyDir, repo, "production");
    await expect(fs.access(privkeyPath)).rejects.toThrow();
  });

  it("SM_REQUIRE_DOTENVX_OPS env var disables fallback", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    const setFn = makeFakeSetFn();

    process.env.SM_REQUIRE_DOTENVX_OPS = "1";
    let result: DeployResult;
    try {
      result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        {
          dotenvxOpsBin: "/nonexistent/dotenvx-ops-DNE",
          dotenvxSetFn: setFn,
          privateKeyDir,
        } as FallbackOptions
      );
    } finally {
      delete process.env.SM_REQUIRE_DOTENVX_OPS;
    }

    expect(result!.ok).toBe(false);
    if (result!.ok) return;
    expect(
      result.code === "DOTENVX_OPS_NOT_LOGGED_IN" ||
        result.code === "DOTENVX_OPS_FAILED"
    ).toBe(true);
    const nextStep = (result as unknown as { nextStep?: string }).nextStep;
    expect(nextStep).toContain("SM_REQUIRE_DOTENVX_OPS");
  });

  it("pre-seeded DOTENV_PUBLIC_KEY_<ENV> wins (no fallback, no privkey file)", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    const envFile = path.join(repo, ".env.production");
    await fs.writeFile(
      envFile,
      `DOTENV_PUBLIC_KEY_PRODUCTION="${REAL_PUBLIC_KEY}"\n`,
      "utf8"
    );

    // Stub binary that fails noisily — proves we don't shell out when
    // the header is already present.
    const stub = await writeStubBinary(
      `echo "stub should not have been called" >&2
exit 99`,
      "fallback-pre-seeded"
    );

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: stub,
        privateKeyDir,
      } as FallbackOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKey).toBe(REAL_PUBLIC_KEY);

    // privateKeyDir must be untouched (no subdir created).
    const entries = await fs.readdir(privateKeyDir);
    expect(entries).toEqual([]);
  });

  it("ops binary succeeds → no local fallback invoked", async () => {
    const repo = await mkRepo();
    const privateKeyDir = await mkPrivkeyDir();
    // Stub writes the public-key header into the env file (same pattern as
    // the existing "empty repo provisions a keypair" test).
    const stub = await writeStubBinary(
      `cat > "$PWD/.env.production" <<EOF
DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"
EOF
exit 0`,
      "fallback-ops-ok"
    );
    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: stub,
        dotenvxSetFn: setFn,
        privateKeyDir,
      } as FallbackOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKey).toBe(FAKE_PUBLIC_KEY);

    // privateKeyDir must remain empty: ops succeeded, fallback never ran.
    const entries = await fs.readdir(privateKeyDir);
    expect(entries).toEqual([]);
  });

  it("local fallback failure surfaces LOCAL_KEYPAIR_FAILED + nextStep", async () => {
    const repo = await mkRepo();
    // Create a regular FILE at the path we'll pass as privateKeyDir. The
    // fallback's `mkdir <privateKeyDir>/<basename>-<hash>` will fail because
    // privateKeyDir is not a directory.
    const blockerDir = await mkRepo();
    const privateKeyDir = path.join(blockerDir, "iam-a-file-not-a-dir");
    await fs.writeFile(privateKeyDir, "block", "utf8");

    const setFn = makeFakeSetFn();

    const result = await deployToScope(
      repo,
      "production",
      { K: "v" },
      {
        dotenvxOpsBin: "/nonexistent/dotenvx-ops-DNE",
        dotenvxSetFn: setFn,
        privateKeyDir,
      } as FallbackOptions
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LOCAL_KEYPAIR_FAILED");

    const nextStep = (result as unknown as { nextStep?: string }).nextStep;
    expect(typeof nextStep).toBe("string");
    expect(nextStep && nextStep.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Regression: process.env DOTENV_PUBLIC_KEY_<ENV> must not override the file  */
/* -------------------------------------------------------------------------- */

describe("deployToScope — stale DOTENV_PUBLIC_KEY_<ENV> in process.env", () => {
  // Repro for the bug where the daemon process inherits
  // DOTENV_PUBLIC_KEY_<ENV> from its launch environment (or a wrapping
  // `dotenvx run` of an unrelated repo) and dotenvx's keyValues helper
  // prefers process.env over the target file, surfacing as
  //   [INVALID_PUBLIC_KEY] could not encrypt using public key
  //   'DOTENV_PUBLIC_KEY_PRODUCTION=encrypt…'
  // when the polluted value happens to start with "encrypted:".
  it("uses the file's public key when process.env carries a bogus value", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    await fs.writeFile(
      envFile,
      `DOTENV_PUBLIC_KEY_PRODUCTION="${REAL_PUBLIC_KEY}"\n`,
      "utf8"
    );

    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    const savedPriv = process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
    // A value shaped like an encrypted dotenvx secret — exactly what shows up
    // in the bug report's truncated error (`encrypt…`).
    process.env.DOTENV_PUBLIC_KEY_PRODUCTION =
      "encrypted:BGTheRWLle1FaIJCEG7Q89uWEDIAyCApDnARmFzIuphSQClWTl";

    try {
      const stub = await writeStubBinary(
        `echo "stub should not have been called" >&2
exit 99`,
        "process-env-pubkey-pollution"
      );

      const result = await deployToScope(
        repo,
        "production",
        { VERCEL_ORG_ID: "team_abc123" },
        { dotenvxOpsBin: stub }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.publicKey).toBe(REAL_PUBLIC_KEY);

      const after = await fs.readFile(envFile, "utf8");
      expect(after).toMatch(/VERCEL_ORG_ID="encrypted:[^"]+"/);

      // The polluted env var must be restored exactly — sm must not leak its
      // internal scrub to unrelated callers in the same process.
      expect(process.env.DOTENV_PUBLIC_KEY_PRODUCTION).toBe(
        "encrypted:BGTheRWLle1FaIJCEG7Q89uWEDIAyCApDnARmFzIuphSQClWTl"
      );

      // DOTENV_PRIVATE_KEY_PRODUCTION must remain absent after the call
      // (no-leakage contract: the deploy must not inject a private key into
      // the caller's environment).
      expect("DOTENV_PRIVATE_KEY_PRODUCTION" in process.env).toBe(false);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
      if (savedPriv === undefined) {
        delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PRIVATE_KEY_PRODUCTION = savedPriv;
      }
    }
  });

  it("restores an unset env var to unset after a successful deploy", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    await fs.writeFile(
      envFile,
      `DOTENV_PUBLIC_KEY_PRODUCTION="${REAL_PUBLIC_KEY}"\n`,
      "utf8"
    );

    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    const savedPriv = process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
    delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION;

    try {
      const stub = await writeStubBinary(
        `echo "stub should not have been called" >&2
exit 99`,
        "process-env-restore-unset"
      );

      const result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        { dotenvxOpsBin: stub }
      );

      expect(result.ok).toBe(true);
      expect("DOTENV_PUBLIC_KEY_PRODUCTION" in process.env).toBe(false);
      expect("DOTENV_PRIVATE_KEY_PRODUCTION" in process.env).toBe(false);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
      if (savedPriv === undefined) {
        delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PRIVATE_KEY_PRODUCTION = savedPriv;
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Error-path: env-var restoration after deployToScope failure                 */
/* -------------------------------------------------------------------------- */

describe("deployToScope — env-var restoration on error path", () => {
  // These tests verify that the finally block correctly restores (or clears)
  // process.env vars even when deployToScope throws or returns an error,
  // guarding against SDK side-effect re-injection during the try block.

  it("restores a pre-existing stale pub var after ensurePublicKey fails (requireDotenvxOps)", async () => {
    const repo = await mkRepo();
    const staleValue = "encrypted:stale-value-should-be-restored";

    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    process.env.DOTENV_PUBLIC_KEY_PRODUCTION = staleValue;

    try {
      // Stub fails with a login error; requireDotenvxOps=true means no fallback.
      const stub = await writeStubBinary(
        `echo "Error: not logged in" >&2
exit 1`,
        "err-path-restore-login"
      );

      const result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        { dotenvxOpsBin: stub, requireDotenvxOps: true }
      );

      // Deploy must have failed.
      expect(result.ok).toBe(false);

      // The stale value must be restored exactly — not left deleted.
      expect(process.env.DOTENV_PUBLIC_KEY_PRODUCTION).toBe(staleValue);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
    }
  });

  it("leaves pub var absent after ensurePublicKey fails when it was absent before", async () => {
    const repo = await mkRepo();

    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;

    try {
      const stub = await writeStubBinary(
        `echo "Error: not logged in" >&2
exit 1`,
        "err-path-absent-pub"
      );

      const result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        { dotenvxOpsBin: stub, requireDotenvxOps: true }
      );

      expect(result.ok).toBe(false);

      // Var was absent before; it must remain absent — the SDK must not have
      // leaked it into process.env as a side effect.
      expect("DOTENV_PUBLIC_KEY_PRODUCTION" in process.env).toBe(false);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
    }
  });

  it("restores a pre-existing stale pub var after dotenvxSetFn throws", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    await fs.writeFile(
      envFile,
      `DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"\nKEEPME="x"\n`,
      "utf8"
    );

    const staleValue = "encrypted:stale-pub-key-throw-path";
    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    process.env.DOTENV_PUBLIC_KEY_PRODUCTION = staleValue;

    try {
      const stub = await writeStubBinary(`exit 99`, "err-path-setfn-throw");
      const setFn = makeFakeSetFn({ failOn: "K", failViaThrow: true });

      const result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ENCRYPTION_FAILED");

      // Stale pub var must be restored, not left absent or corrupted.
      expect(process.env.DOTENV_PUBLIC_KEY_PRODUCTION).toBe(staleValue);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
    }
  });

  it("leaves pub var absent after dotenvxSetFn throws when it was absent before", async () => {
    const repo = await mkRepo();
    const envFile = path.join(repo, ".env.production");
    await fs.writeFile(
      envFile,
      `DOTENV_PUBLIC_KEY_PRODUCTION="${FAKE_PUBLIC_KEY}"\nKEEPME="x"\n`,
      "utf8"
    );

    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;

    try {
      const stub = await writeStubBinary(`exit 99`, "err-path-setfn-throw-absent");
      const setFn = makeFakeSetFn({ failOn: "K", failViaThrow: true });

      const result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        { dotenvxOpsBin: stub, dotenvxSetFn: setFn }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("ENCRYPTION_FAILED");

      // Var was absent before; defensive delete in finally must keep it absent.
      expect("DOTENV_PUBLIC_KEY_PRODUCTION" in process.env).toBe(false);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
    }
  });

  it("all four vars are properly restored/absent after a failing deploy", async () => {
    const repo = await mkRepo();

    // Set up a stale env var for the scoped public key; leave others absent.
    const savedPub = process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
    const savedPriv = process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
    const savedBarePub = process.env.DOTENV_PUBLIC_KEY;
    const savedBarePriv = process.env.DOTENV_PRIVATE_KEY;

    const staleBarePub = "encrypted:stale-bare-pub";
    process.env.DOTENV_PUBLIC_KEY_PRODUCTION = "encrypted:stale-scoped-pub";
    delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
    process.env.DOTENV_PUBLIC_KEY = staleBarePub;
    delete process.env.DOTENV_PRIVATE_KEY;

    try {
      const stub = await writeStubBinary(
        `echo "Error: not logged in" >&2
exit 1`,
        "err-path-all-four"
      );

      const result = await deployToScope(
        repo,
        "production",
        { K: "v" },
        { dotenvxOpsBin: stub, requireDotenvxOps: true }
      );

      expect(result.ok).toBe(false);

      // Scoped pub: was set → must be restored.
      expect(process.env.DOTENV_PUBLIC_KEY_PRODUCTION).toBe(
        "encrypted:stale-scoped-pub"
      );
      // Scoped priv: was absent → must remain absent.
      expect("DOTENV_PRIVATE_KEY_PRODUCTION" in process.env).toBe(false);
      // Bare pub: was set → must be restored.
      expect(process.env.DOTENV_PUBLIC_KEY).toBe(staleBarePub);
      // Bare priv: was absent → must remain absent.
      expect("DOTENV_PRIVATE_KEY" in process.env).toBe(false);
    } finally {
      if (savedPub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PUBLIC_KEY_PRODUCTION = savedPub;
      }
      if (savedPriv === undefined) {
        delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
      } else {
        process.env.DOTENV_PRIVATE_KEY_PRODUCTION = savedPriv;
      }
      if (savedBarePub === undefined) {
        delete process.env.DOTENV_PUBLIC_KEY;
      } else {
        process.env.DOTENV_PUBLIC_KEY = savedBarePub;
      }
      if (savedBarePriv === undefined) {
        delete process.env.DOTENV_PRIVATE_KEY;
      } else {
        process.env.DOTENV_PRIVATE_KEY = savedBarePriv;
      }
    }
  });
});
