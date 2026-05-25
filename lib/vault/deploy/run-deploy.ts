import { existsSync } from "node:fs";

import { detectCollisions, secretsForCell, type Collision } from "./write-key";
import { deployToScope, type DeployErrorCode } from "../../deploy/dotenvx";
import type { Scope, VaultData } from "../schema";

export type DeployTarget = Scope;

export type PerTargetSuccess = {
  ok: true;
  /** Discriminant: PerTargetSuccess never has a `skipped` key. */
  skipped?: never;
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  ownedKeyCount: number;
  writtenKeys: string[];
  /** Present only when `dryRun: true`. */
  dryRun?: boolean;
};

export type PerTargetSkipped = {
  ok: true;
  skipped: true;
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  reason: "PATH_NOT_FOUND";
};

export type PerTargetCollisionFailure = {
  ok: false;
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  code: "COLLISION";
  collisions: Collision[];
};

export type PerTargetDeployFailure = {
  ok: false;
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  code: Extract<
    DeployErrorCode,
    | "DOTENVX_OPS_NOT_LOGGED_IN"
    | "DOTENVX_OPS_FAILED"
    | "LOCAL_KEYPAIR_FAILED"
    | "REPO_PATH_NOT_FOUND"
    | "ENCRYPTION_FAILED"
    | "WRITE_FAILED"
    | "UNKNOWN"
  >;
  error: string;
  ownedKeyCount: number;
  /** Remediation hint surfaced alongside the error code. */
  nextStep?: string;
};

export type PerTargetMissingRepo = {
  ok: false;
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  code: "REPO_NOT_IN_VAULT";
  error: string;
};

export type PerTargetMissingValues = {
  ok: false;
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  code: "MISSING_SECRET_VALUES";
  error: string;
  missingKeys: string[];
};

export type DeployTargetResult =
  | PerTargetSuccess
  | PerTargetSkipped
  | PerTargetCollisionFailure
  | PerTargetDeployFailure
  | PerTargetMissingRepo
  | PerTargetMissingValues;

export type RunDeployOptions = {
  data: VaultData;
  /** When omitted, defaults to every `(repoId, env)` cell at least one secret scopes to. */
  targets?: DeployTarget[];
  dryRun: boolean;
  /** When true, skip repos whose path does not exist on the local filesystem. */
  localOnly?: boolean;
  /**
   * Fired exactly once per target, in iteration order, AFTER the target's
   * `DeployTargetResult` is computed and pushed to the aggregate array. The
   * handler is awaited if it returns a Promise so consumers can do
   * per-target side-effects sequentially. The handler receives a reference
   * to the SAME result object that appears in the returned array (no clone).
   *
   * Used by the GUI streaming Route Handler to emit NDJSON `target` events
   * as the deploy progresses (issue #76).
   */
  onTarget?: (
    result: DeployTargetResult,
    index: number,
  ) => void | Promise<void>;
};

/**
 * Sentinel placeholder values that indicate a secret has not been given a
 * real value yet. These must not be written into .env files.
 */
const SENTINEL_VALUES = new Set(["PLACEHOLDER", "<SET_ME>", "TODO"]);

/**
 * Returns true if the given secret value is empty, whitespace-only, or a
 * known sentinel placeholder string that should not be deployed.
 */
function isMissingValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (SENTINEL_VALUES.has(trimmed)) return true;
  return false;
}

/**
 * Single deploy engine used by both the GUI server-action and the CLI
 * daemon handler. Pure with respect to its inputs except for the actual
 * `deployToScope` call (which writes encrypted `.env.<env>` files).
 *
 * Per target:
 *   1. Compute the scoped secret subset.
 *   2. Run collision detection on `writtenKeyFor(secret)`. Under the post-#78
 *      contract `writtenKeyFor` is identity on `secret.key`, so a collision
 *      here implies two secrets share the same bare `key` in the same cell
 *      — which should already have been blocked at scope time by
 *      `scopeCellConflicts`. The check remains as defense-in-depth for
 *      legacy vaults.
 *   3. Check for secrets with empty or sentinel values before building the
 *      owned map. Return MISSING_SECRET_VALUES if any are found.
 *   4. Build the `(key → value)` map directly from the scoped subset.
 *   5. If `dryRun`, return the planned written keys without touching disk.
 *   6. Otherwise, call `deployToScope` and translate its result.
 */
export async function runDeploy(
  opts: RunDeployOptions,
): Promise<DeployTargetResult[]> {
  const targets = opts.targets ?? enumerateTargets(opts.data);
  const results: DeployTargetResult[] = [];

  let index = 0;
  for (const t of targets) {
    const result = await computeTargetResult(opts, t);
    results.push(result);
    if (opts.onTarget) {
      // Awaited so consumers (e.g. the streaming Route Handler) can serialize
      // per-target side-effects before the loop advances.
      await opts.onTarget(result, index);
    }
    index++;
  }

  return results;
}

/**
 * Pure-per-target compute step extracted from the main loop so the
 * `runDeploy` body has exactly one `results.push(...)` site and exactly
 * one `onTarget(...)` invocation per target. This makes the reference-
 * equality contract trivial to satisfy: the object pushed and the object
 * passed to `onTarget` are literally the same reference.
 */
async function computeTargetResult(
  opts: RunDeployOptions,
  t: DeployTarget,
): Promise<DeployTargetResult> {
  const repo = opts.data.repos.find((r) => r.id === t.repoId);
  if (!repo) {
    return {
      ok: false,
      repoId: t.repoId,
      repoName: "(unknown)",
      repoPath: "",
      env: t.env,
      code: "REPO_NOT_IN_VAULT",
      error: "repo no longer exists in vault",
    };
  }

  // localOnly: skip repos whose path doesn't exist on this machine.
  if (opts.localOnly && !existsSync(repo.path)) {
    return {
      ok: true,
      skipped: true,
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.path,
      env: t.env,
      reason: "PATH_NOT_FOUND",
    };
  }

  const scoped = secretsForCell(opts.data.secrets, t);
  const collisions = detectCollisions(scoped);
  if (collisions.length > 0) {
    return {
      ok: false,
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.path,
      env: t.env,
      code: "COLLISION",
      collisions,
    };
  }

  // Check for secrets with empty or sentinel placeholder values before
  // building the owned map. Writing blank or placeholder strings into .env
  // files would silently corrupt the target environment.
  const missingKeys = scoped
    .filter((s) => isMissingValue(s.value))
    .map((s) => s.key);
  if (missingKeys.length > 0) {
    return {
      ok: false,
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.path,
      env: t.env,
      code: "MISSING_SECRET_VALUES",
      error: `${missingKeys.length} secret${missingKeys.length === 1 ? "" : "s"} have empty or placeholder values: ${missingKeys.join(", ")}`,
      missingKeys,
    };
  }

  const owned: Record<string, string> = {};
  for (const s of scoped) {
    // namespace is intentionally ignored — issue #78
    owned[s.key] = s.value;
  }
  const writtenKeys = Object.keys(owned).sort();

  if (opts.dryRun) {
    return {
      ok: true,
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.path,
      env: t.env,
      ownedKeyCount: writtenKeys.length,
      writtenKeys,
      dryRun: true,
    };
  }

  const r = await deployToScope(repo.path, t.env, owned);
  if (r.ok) {
    return {
      ok: true,
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.path,
      env: t.env,
      ownedKeyCount: r.ownedKeyCount,
      writtenKeys,
    };
  }
  return {
    ok: false,
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    env: t.env,
    code: r.code,
    error: r.error,
    ownedKeyCount: writtenKeys.length,
    ...(r.nextStep ? { nextStep: r.nextStep } : {}),
  };
}

/**
 * Every `(repoId, env)` cell mentioned by at least one secret's scope.
 */
export function enumerateTargets(data: VaultData): DeployTarget[] {
  const seen = new Map<string, DeployTarget>();
  for (const s of data.secrets) {
    for (const sc of s.scopes) {
      seen.set(`${sc.repoId}::${sc.env}`, sc);
    }
  }
  return Array.from(seen.values());
}

/**
 * Subset of `enumerateTargets` restricted to a single repo — i.e. every
 * `(repoId, env)` cell for `repoId` that has at least one scoped secret.
 * Returns `[]` for an unknown repoId or a repo with no scopes.
 *
 * Used by `deployRepoAction` (per-repo GUI deploy) and the CLI daemon
 * "deploy --repo <name>" path.
 */
export function targetsForRepo(
  data: VaultData,
  repoId: string,
): DeployTarget[] {
  return enumerateTargets(data).filter((t) => t.repoId === repoId);
}
