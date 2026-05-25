import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import * as dotenvx from "@dotenvx/dotenvx";

import { vaultDir } from "../vault/store";

const execFileAsync = promisify(execFile);

export type DeployErrorCode =
  | "DOTENVX_OPS_NOT_LOGGED_IN"
  | "DOTENVX_OPS_FAILED"
  | "LOCAL_KEYPAIR_FAILED"
  | "REPO_PATH_NOT_FOUND"
  | "ENCRYPTION_FAILED"
  | "WRITE_FAILED"
  | "UNKNOWN";

export type DeployResult =
  | {
      ok: true;
      repoPath: string;
      env: string;
      publicKey: string;
      ownedKeyCount: number;
      envFilePath: string;
    }
  | {
      ok: false;
      repoPath: string;
      env: string;
      error: string;
      code: DeployErrorCode;
      /** Remediation hint surfaced alongside the error code (sibling of `error`). */
      nextStep?: string;
    };

/**
 * Signature of the dotenvx `set` function. We type the bits we use rather than
 * leaning on `any` so tests can stub it precisely.
 */
export type DotenvxSetFn = (
  key: string,
  value: string,
  options: { path: string; encrypt?: boolean }
) => DotenvxSetResult | Promise<DotenvxSetResult>;

export type DotenvxSetResult = {
  processedEnvs?: Array<{
    key: string;
    error?: { code?: string; message?: string };
  }>;
  changedFilepaths?: string[];
  unchangedFilepaths?: string[];
};

export interface DeployOptions {
  /** Override the path/name of the `dotenvx-ops` binary. Default `"dotenvx-ops"`. */
  dotenvxOpsBin?: string;
  /** Override `dotenvx.set` for tests. */
  dotenvxSetFn?: DotenvxSetFn;
  /**
   * When true, do NOT fall back to a locally-generated keypair if
   * `dotenvx-ops` is missing or refuses. Default: `SM_REQUIRE_DOTENVX_OPS === "1"`.
   * Used in CI/prod to ensure key custody stays with `dotenvx-ops`.
   */
  requireDotenvxOps?: boolean;
  /**
   * Base directory under which locally-provisioned private keys are stored.
   * Default: `path.join(vaultDir(), "keys")`. Each `(repo, env)` gets a
   * subdirectory `<basename>-<hash16>` with a `<env>.private.key` file
   * (mode 0o600).
   */
  privateKeyDir?: string;
}

/** Hex-encoded secp256k1 public key — uncompressed = 130 chars, compressed = 66. */
const PUBLIC_KEY_HEX_RE = /[0-9a-fA-F]{60,140}/;

/** Bootstrap key name used to trigger dotenvx's in-process keypair provisioning. */
const BOOTSTRAP_KEY = "__SM_KEYPAIR_BOOTSTRAP__";

/**
 * Remediation strings keyed by failure code. Tests assert that the
 * disable-fallback path's `nextStep` contains the literal
 * `"SM_REQUIRE_DOTENVX_OPS"`, so the relevant copies must say so.
 */
export const REMEDIATION: Record<
  "DOTENVX_OPS_NOT_LOGGED_IN" | "DOTENVX_OPS_FAILED" | "LOCAL_KEYPAIR_FAILED",
  string
> = {
  DOTENVX_OPS_NOT_LOGGED_IN:
    'Run "dotenvx-ops login" or unset SM_REQUIRE_DOTENVX_OPS=1 to allow local keypair provisioning.',
  DOTENVX_OPS_FAILED:
    "dotenvx-ops failed. Install/repair it (https://dotenvx.com/docs/ops) or unset SM_REQUIRE_DOTENVX_OPS=1 to fall back to a local keypair.",
  LOCAL_KEYPAIR_FAILED:
    'Local keypair provisioning failed. Check write access to ~/.config/secrets-manager/keys and rerun "sm deploy".',
};

function publicKeyVarName(env: string): string {
  return `DOTENV_PUBLIC_KEY_${env.toUpperCase()}`;
}

function privateKeyVarName(env: string): string {
  return `DOTENV_PRIVATE_KEY_${env.toUpperCase()}`;
}

function envFileName(env: string): string {
  // Filenames keep the casing the caller gave us so we match dotenvx's lookup
  // rules (case-sensitive on Linux). Use exactly what the caller passes after
  // a single lowercase normalization step, since SPEC examples show
  // `.env.production` (lowercase).
  return `.env.${env.toLowerCase()}`;
}

/**
 * Find a `DOTENV_PUBLIC_KEY_<ENV>="..."` line in the file contents.
 * Tolerates single/double/no quotes and surrounding whitespace.
 */
export function extractPublicKey(
  contents: string,
  env: string
): string | null {
  const varName = publicKeyVarName(env);
  const re = new RegExp(
    `^\\s*${varName}\\s*=\\s*["']?([0-9a-fA-F]{60,140})["']?\\s*$`,
    "m"
  );
  const m = re.exec(contents);
  return m ? m[1] : null;
}

/**
 * Deterministic path for a locally-provisioned private key file.
 *
 * Shape: `<baseDir>/<basename(repoPath)>-<sha256(repoPath).slice(0,16)>/<env>.private.key`.
 */
export function localPrivateKeyPath(
  repoPath: string,
  env: string,
  baseDir?: string
): string {
  if (!/^[\w.-]+$/.test(env)) {
    throw new Error(`Invalid env name: ${JSON.stringify(env)}`);
  }
  const base = baseDir ?? path.join(vaultDir(), "keys");
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 16);
  return path.join(
    base,
    `${path.basename(repoPath)}-${hash}`,
    `${env.toLowerCase()}.private.key`
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

interface KeypairProvisionResult {
  ok: true;
  publicKey: string;
}
interface KeypairProvisionFailure {
  ok: false;
  code: Extract<
    DeployErrorCode,
    "DOTENVX_OPS_NOT_LOGGED_IN" | "DOTENVX_OPS_FAILED"
  >;
  message: string;
}

interface LocalKeypairFailure {
  ok: false;
  code: Extract<DeployErrorCode, "LOCAL_KEYPAIR_FAILED">;
  message: string;
}

/**
 * Provision a keypair via `dotenvx-ops keypair`. The CLI may either:
 *   (a) write the `DOTENV_PUBLIC_KEY_<ENV>=...` line into `.env.<env>` directly, or
 *   (b) emit the public key on stdout.
 * We support both: re-read the file first; if still missing, scan stdout.
 */
async function provisionKeypair(
  bin: string,
  repoPath: string,
  envFilePath: string,
  env: string
): Promise<KeypairProvisionResult | KeypairProvisionFailure> {
  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileAsync(bin, ["keypair"], {
      cwd: repoPath,
      env: {
        ...process.env,
        // Hint at the target env file; current versions of dotenvx-ops
        // discover this themselves but passing it doesn't hurt.
        DOTENV_KEYPAIR_TARGET_FILE: envFilePath,
      },
    });
    stdout = r.stdout ?? "";
    stderr = r.stderr ?? "";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    const blob = `${stdout}\n${stderr}\n${e.message ?? ""}`.toLowerCase();
    if (
      blob.includes("not logged in") ||
      blob.includes("please login") ||
      blob.includes("please log in") ||
      blob.includes("unauthor") ||
      blob.includes("401")
    ) {
      return {
        ok: false,
        code: "DOTENVX_OPS_NOT_LOGGED_IN",
        message:
          "dotenvx-ops appears to require login. Run `dotenvx-ops login` and retry.",
      };
    }
    // Fall through to a re-read attempt; the binary may have partially
    // succeeded before exiting nonzero.
  }

  // Re-read the env file — the CLI may have inserted the public key line.
  let after = "";
  try {
    after = await fs.readFile(envFilePath, "utf8");
  } catch {
    after = "";
  }
  const fromFile = extractPublicKey(after, env);
  if (fromFile) return { ok: true, publicKey: fromFile };

  // Fall back: try to parse the public key out of stdout.
  const fromStdout = PUBLIC_KEY_HEX_RE.exec(stdout)?.[0];
  if (fromStdout) {
    // Persist it into the env file so subsequent deploys are deterministic.
    const header = `${publicKeyVarName(env)}="${fromStdout}"\n`;
    const next = after.length > 0 ? header + after : header;
    try {
      await fs.writeFile(envFilePath, next, "utf8");
    } catch {
      // Best-effort — the caller still gets the public key.
    }
    return { ok: true, publicKey: fromStdout };
  }

  return {
    ok: false,
    code: "DOTENVX_OPS_FAILED",
    message:
      `dotenvx-ops keypair did not yield a public key for env "${env}". ` +
      (stderr || stdout || "no output captured").trim(),
  };
}

/**
 * Locally provision a secp256k1 keypair via the bundled @dotenvx/dotenvx SDK
 * (`noOps: true`), persist the public key into the env file (already done by
 * the SDK), and write the private key out to `localPrivateKeyPath(...)` with
 * mode 0o600. The bootstrap key used to trigger provisioning is scrubbed.
 *
 * Returns the public key on success.
 */
async function provisionLocalKeypair(
  repoPath: string,
  envFilePath: string,
  env: string,
  privateKeyDir: string
): Promise<KeypairProvisionResult | LocalKeypairFailure> {
  const localPath = localPrivateKeyPath(repoPath, env, privateKeyDir);
  const localDir = path.dirname(localPath);

  // 1. Ensure the destination directory exists. If `privateKeyDir` is not a
  //    directory (e.g. it's a regular file blocking the path), this throws
  //    and we surface LOCAL_KEYPAIR_FAILED with a remediation hint.
  try {
    await fs.mkdir(localDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      code: "LOCAL_KEYPAIR_FAILED",
      message: `Failed to create private-key directory ${localDir}: ${(err as Error).message}`,
    };
  }

  // 2. If both keys are already present (re-deploy on an existing fallback
  //    repo), short-circuit. dotenvx.keypair reads from env file + .env.keys
  //    + process.env.
  try {
    const existing = (
      dotenvx as unknown as {
        keypair: (
          envFile: string,
          key: undefined,
          envKeysFile: string | null,
          noOps: boolean
        ) => Record<string, string | null> | string | null;
      }
    ).keypair(envFilePath, undefined, null, true) as Record<
      string,
      string | null
    >;
    const pubName = publicKeyVarName(env);
    const privName = privateKeyVarName(env);
    if (existing && existing[pubName] && existing[privName]) {
      // Public key is in the env file already; persist the private key locally
      // if we haven't yet.
      if (!(await pathExists(localPath))) {
        try {
          await fs.writeFile(localPath, existing[privName] as string, {
            mode: 0o600,
          });
        } catch (err) {
          return {
            ok: false,
            code: "LOCAL_KEYPAIR_FAILED",
            message: `Failed to persist private key: ${(err as Error).message}`,
          };
        }
      }
      return { ok: true, publicKey: existing[pubName] as string };
    }
  } catch {
    // Reading failed — proceed to provision via dotenvx.set.
  }

  // 3. Trigger provisioning via dotenvx.set with `noOps: true`. The SDK will:
  //    - generate a fresh secp256k1 keypair via eciesjs,
  //    - prepend `DOTENV_PUBLIC_KEY_<ENV>="<hex>"` to the env file,
  //    - write `DOTENV_PRIVATE_KEY_<ENV>=<hex>` to `<envDir>/.env.keys` (the
  //      dotenvx convention — required so subsequent `dotenvx.keypair` and
  //      `dotenvx.get` calls round-trip without env-var pollution).
  //    We mirror the bare hex private key into `localPath` so users can find
  //    it under `~/.config/secrets-manager/keys/...` for backup/recovery.
  try {
    (
      dotenvx as unknown as {
        set: (
          key: string,
          value: string,
          options: {
            path: string;
            noOps?: boolean;
            encrypt?: boolean;
          }
        ) => DotenvxSetResult;
      }
    ).set(BOOTSTRAP_KEY, "x", {
      path: envFilePath,
      noOps: true,
    });
  } catch (err) {
    return {
      ok: false,
      code: "LOCAL_KEYPAIR_FAILED",
      message: `Failed to provision local keypair: ${(err as Error).message}`,
    };
  }

  // 4. Read the freshly provisioned keypair via dotenvx.keypair. With
  //    `envKeysFile = null`, dotenvx looks at `<envDir>/.env.keys` which
  //    `set` just wrote.
  let publicKey: string | null = null;
  let privateKey: string | null = null;
  try {
    const kp = (
      dotenvx as unknown as {
        keypair: (
          envFile: string,
          key: undefined,
          envKeysFile: string | null,
          noOps: boolean
        ) => Record<string, string | null>;
      }
    ).keypair(envFilePath, undefined, null, true);
    publicKey = kp[publicKeyVarName(env)] ?? null;
    privateKey = kp[privateKeyVarName(env)] ?? null;
  } catch (err) {
    return {
      ok: false,
      code: "LOCAL_KEYPAIR_FAILED",
      message: `Failed to read provisioned keypair: ${(err as Error).message}`,
    };
  }

  if (!publicKey || !privateKey) {
    return {
      ok: false,
      code: "LOCAL_KEYPAIR_FAILED",
      message:
        "dotenvx-provisioned keypair returned empty public or private key",
    };
  }

  // 5. Persist the private key as a bare hex string at `localPath`. Mode 0o600
  //    via the writeFile option is sufficient and atomic.
  try {
    await fs.writeFile(localPath, privateKey, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      code: "LOCAL_KEYPAIR_FAILED",
      message: `Failed to write private key to ${localPath}: ${(err as Error).message}`,
    };
  }

  // 6. Scrub the bootstrap line that dotenvx.set just inserted into the env
  //    file, while preserving the `DOTENV_PUBLIC_KEY_<ENV>="..."` header it
  //    also inserted.
  try {
    const after = await fs.readFile(envFilePath, "utf8");
    const stripped = after
      .split("\n")
      .filter((line) => !line.startsWith(`${BOOTSTRAP_KEY}=`))
      .join("\n");
    if (stripped !== after) {
      await fs.writeFile(envFilePath, stripped, "utf8");
    }
  } catch (err) {
    return {
      ok: false,
      code: "LOCAL_KEYPAIR_FAILED",
      message: `Failed to scrub bootstrap key from env file: ${(err as Error).message}`,
    };
  }

  // 7. If the env file still lacks the public-key header (defensive — should
  //    have been inserted by the SDK), prepend it.
  try {
    const after = await fs.readFile(envFilePath, "utf8");
    if (!extractPublicKey(after, env)) {
      const header = `${publicKeyVarName(env)}="${publicKey}"\n`;
      const seedPreserved = after.length > 0 ? header + after : header;
      await fs.writeFile(envFilePath, seedPreserved, "utf8");
    }
  } catch {
    // Best-effort.
  }

  return { ok: true, publicKey };
}

interface EnsurePublicKeyContext {
  dotenvxOpsBin: string;
  requireDotenvxOps: boolean;
  privateKeyDir: string;
}

async function ensurePublicKey(
  envFilePath: string,
  env: string,
  repoPath: string,
  ctx: EnsurePublicKeyContext
): Promise<
  | { ok: true; publicKey: string }
  | {
      ok: false;
      code: DeployErrorCode;
      message: string;
      nextStep?: string;
    }
> {
  // 1. Existing pubkey in `.env.<env>` always wins.
  let contents = "";
  try {
    contents = await fs.readFile(envFilePath, "utf8");
  } catch {
    contents = "";
  }
  const existing = extractPublicKey(contents, env);
  if (existing) return { ok: true, publicKey: existing };

  // 2. Attempt dotenvx-ops provisioning.
  const ops = await provisionKeypair(
    ctx.dotenvxOpsBin,
    repoPath,
    envFilePath,
    env
  );
  if (ops.ok) return { ok: true, publicKey: ops.publicKey };

  // 3. ops failed.
  // 3a. Strict mode: surface the ops failure with its remediation.
  if (ctx.requireDotenvxOps) {
    return {
      ok: false,
      code: ops.code,
      message: ops.message,
      nextStep: REMEDIATION[ops.code],
    };
  }

  // 4. Fall back to a locally-provisioned keypair.
  const local = await provisionLocalKeypair(
    repoPath,
    envFilePath,
    env,
    ctx.privateKeyDir
  );
  if (local.ok) return { ok: true, publicKey: local.publicKey };

  return {
    ok: false,
    code: local.code,
    message: local.message,
    nextStep: REMEDIATION.LOCAL_KEYPAIR_FAILED,
  };
}

/**
 * Write every owned secret into the target `.env.<env>` file using
 * public-key encryption.
 *
 * Atomic-ish semantics: we snapshot the env file before iterating; if any
 * single `set` call surfaces an error, we restore the snapshot and return
 * `code: "ENCRYPTION_FAILED"`.
 */
export async function deployToScope(
  repoPath: string,
  env: string,
  ownedKeys: Record<string, string>,
  opts?: DeployOptions
): Promise<DeployResult> {
  if (!/^[\w.-]+$/.test(env)) {
    return {
      ok: false,
      repoPath,
      env,
      error: `Invalid env name: ${JSON.stringify(env)}`,
      code: "REPO_PATH_NOT_FOUND",
    };
  }

  const dotenvxOpsBin = opts?.dotenvxOpsBin ?? "dotenvx-ops";
  const dotenvxSetFn: DotenvxSetFn =
    opts?.dotenvxSetFn ?? (dotenvx as unknown as { set: DotenvxSetFn }).set;
  const requireDotenvxOps =
    opts?.requireDotenvxOps ?? process.env.SM_REQUIRE_DOTENVX_OPS === "1";
  const privateKeyDir =
    opts?.privateKeyDir ?? path.join(vaultDir(), "keys");

  const envFilePath = path.join(repoPath, envFileName(env));

  // 1. Validate repo path.
  if (!(await pathExists(repoPath)) || !(await isDirectory(repoPath))) {
    return {
      ok: false,
      repoPath,
      env,
      error: `Repo path does not exist or is not a directory: ${repoPath}`,
      code: "REPO_PATH_NOT_FOUND",
    };
  }

  // 2. Ensure env file exists (create empty if missing).
  if (!(await pathExists(envFilePath))) {
    try {
      await fs.writeFile(envFilePath, "", "utf8");
    } catch (err) {
      return {
        ok: false,
        repoPath,
        env,
        error: `Failed to create env file: ${(err as Error).message}`,
        code: "WRITE_FAILED",
      };
    }
  }

  // 3. Scrub DOTENV_{PUBLIC,PRIVATE}_KEY_<ENV> and the bare
  //    DOTENV_{PUBLIC,PRIVATE}_KEY from process.env for the duration of every
  //    dotenvx interaction. dotenvx's keyValues helper prefers process.env
  //    over the target file, so a stale value inherited from the daemon's
  //    launch shell (or a `dotenvx run` wrapper on an unrelated repo) silently
  //    overrides the file's real key and surfaces later as
  //    `[INVALID_PUBLIC_KEY] ... 'DOTENV_PUBLIC_KEY_<ENV>=encrypt…'`.
  //    The file is the source of truth; restore on exit so we don't leak this
  //    scrub to unrelated callers in the same process.
  //
  //    NOTE: runDeploy serialises all calls to deployToScope (one at a time),
  //    so these process.env mutations are safe. If deploys are ever
  //    parallelised this section must be revisited to avoid races.
  const pubVar = publicKeyVarName(env);
  const privVar = privateKeyVarName(env);
  const savedPub = process.env[pubVar];
  const savedPriv = process.env[privVar];
  const savedBarePub = process.env["DOTENV_PUBLIC_KEY"];
  const savedBarePriv = process.env["DOTENV_PRIVATE_KEY"];
  delete process.env[pubVar];
  delete process.env[privVar];
  delete process.env["DOTENV_PUBLIC_KEY"];
  delete process.env["DOTENV_PRIVATE_KEY"];
  // SUBPROCESS ENV EFFECT: the four deleted vars above will also be absent
  // from any child process spawned inside the try block (e.g. the
  // `dotenvx-ops keypair` call in provisionKeypair), because child_process
  // inherits the current process.env at spawn time.
  //
  // This is intentional — the .env file is the authoritative source of truth
  // for key material, and we do not want a stale process.env value to shadow
  // what the CLI reads from disk.
  //
  // Risk: a CI wrapper that legitimately injects DOTENV_PRIVATE_KEY_<ENV>
  // into the environment for decryption purposes will NOT have that variable
  // available to `dotenvx-ops keypair`. Callers must store keys in the .env
  // file (or .env.keys), not rely on environment-variable injection, when
  // using this deploy pipeline.

  try {
    // 4. Resolve a public key — read it, provision via dotenvx-ops, or fall
    //    back to a locally-provisioned keypair.
    const pk = await ensurePublicKey(envFilePath, env, repoPath, {
      dotenvxOpsBin,
      requireDotenvxOps,
      privateKeyDir,
    });
    if (!pk.ok) {
      return {
        ok: false,
        repoPath,
        env,
        error: pk.message,
        code: pk.code,
        ...(pk.nextStep ? { nextStep: pk.nextStep } : {}),
      };
    }

    // 5. Snapshot the env file so we can restore on partial failure.
    let snapshot: string;
    try {
      snapshot = await fs.readFile(envFilePath, "utf8");
    } catch (err) {
      return {
        ok: false,
        repoPath,
        env,
        error: `Failed to snapshot env file: ${(err as Error).message}`,
        code: "WRITE_FAILED",
      };
    }

    // 6. Iterate owned keys, applying dotenvx.set for each.
    const ownedEntries = Object.entries(ownedKeys);
    for (const [key, value] of ownedEntries) {
      let result: DotenvxSetResult | undefined;
      try {
        result = await Promise.resolve(
          dotenvxSetFn(key, value, { path: envFilePath })
        );
      } catch (err) {
        await restoreSnapshot(envFilePath, snapshot);
        return {
          ok: false,
          repoPath,
          env,
          error: `Failed to encrypt key "${key}": ${(err as Error).message}`,
          code: "ENCRYPTION_FAILED",
        };
      }
      const processed = result?.processedEnvs ?? [];
      const failed = processed.find((p) => p.error);
      if (failed) {
        await restoreSnapshot(envFilePath, snapshot);
        return {
          ok: false,
          repoPath,
          env,
          error: `Failed to encrypt key "${failed.key}": ${
            failed.error?.message ?? failed.error?.code ?? "unknown error"
          }`,
          code: "ENCRYPTION_FAILED",
        };
      }
    }

    return {
      ok: true,
      repoPath,
      env,
      publicKey: pk.publicKey,
      ownedKeyCount: ownedEntries.length,
      envFilePath,
    };
  } finally {
    if (savedPub !== undefined) {
      process.env[pubVar] = savedPub;
    } else {
      // Guard against SDK side-effect re-injection: if the var wasn't set
      // before, ensure it's absent even if the dotenvx call wrote it.
      delete process.env[pubVar];
    }
    if (savedPriv !== undefined) {
      process.env[privVar] = savedPriv;
    } else {
      // Guard against SDK side-effect re-injection: if the var wasn't set
      // before, ensure it's absent even if the dotenvx call wrote it.
      delete process.env[privVar];
    }
    if (savedBarePub !== undefined) {
      process.env["DOTENV_PUBLIC_KEY"] = savedBarePub;
    } else {
      // Guard against SDK side-effect re-injection: if the var wasn't set
      // before, ensure it's absent even if the dotenvx call wrote it.
      delete process.env["DOTENV_PUBLIC_KEY"];
    }
    if (savedBarePriv !== undefined) {
      process.env["DOTENV_PRIVATE_KEY"] = savedBarePriv;
    } else {
      // Guard against SDK side-effect re-injection: if the var wasn't set
      // before, ensure it's absent even if the dotenvx call wrote it.
      delete process.env["DOTENV_PRIVATE_KEY"];
    }
  }
}

async function restoreSnapshot(
  envFilePath: string,
  snapshot: string
): Promise<void> {
  try {
    await fs.writeFile(envFilePath, snapshot, "utf8");
  } catch {
    // Best-effort restore; the caller is already in an error path.
  }
}
