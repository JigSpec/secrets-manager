import type { DeployTargetResult as RawDeployTargetResult } from "./run-deploy";

/**
 * UI-facing projection of a `DeployTargetResult`. Both server actions
 * (`deployAllAction`, `deployRepoAction`) and the streaming consumer in
 * the GUI map the discriminated-union raw result to this flat shape so the
 * `<DeploySheet>` can render uniformly.
 *
 * The flat shape intentionally collapses the per-error-code detail into
 * a single `error: string` field — the sheet renders that string verbatim.
 */
export type DeployTargetResult = {
  repoId: string;
  repoName: string;
  repoPath: string;
  env: string;
  ok: boolean;
  ownedKeyCount: number;
  /** The env-var names actually written to disk. Bare keys per issue #78. */
  writtenKeys?: string[];
  error?: string;
};

export function toDeployTargetResult(
  r: RawDeployTargetResult,
): DeployTargetResult {
  if (r.ok) {
    // PerTargetSkipped: repo path absent on this machine — treat as a no-op
    // success with zero keys written so the UI can surface the skip reason.
    if ("skipped" in r) {
      return {
        repoId: r.repoId,
        repoName: r.repoName,
        repoPath: r.repoPath,
        env: r.env,
        ok: true,
        ownedKeyCount: 0,
      };
    }
    return {
      repoId: r.repoId,
      repoName: r.repoName,
      repoPath: r.repoPath,
      env: r.env,
      ok: true,
      ownedKeyCount: r.ownedKeyCount,
      writtenKeys: r.writtenKeys,
    };
  }
  if (r.code === "COLLISION") {
    // issue #78 — collisions imply two secrets share the same bare key in
    // this cell. We surface each member's namespace alongside its internal
    // id so the user can tell the colliding secrets apart in their vault.
    const lines = r.collisions
      .map(
        (c) =>
          `two secrets share key ${c.writtenKey} (${c.members
            .map((m) => `${m.id} [ns=${m.namespace ?? "<none>"}]`)
            .join(", ")})`,
      )
      .join("; ");
    return {
      repoId: r.repoId,
      repoName: r.repoName,
      repoPath: r.repoPath,
      env: r.env,
      ok: false,
      ownedKeyCount: 0,
      error: `Pre-deploy collision: ${lines}`,
    };
  }
  if (r.code === "REPO_NOT_IN_VAULT") {
    return {
      repoId: r.repoId,
      repoName: r.repoName,
      repoPath: r.repoPath,
      env: r.env,
      ok: false,
      ownedKeyCount: 0,
      error: r.error,
    };
  }
  if (r.code === "MISSING_SECRET_VALUES") {
    return {
      repoId: r.repoId,
      repoName: r.repoName,
      repoPath: r.repoPath,
      env: r.env,
      ok: false,
      ownedKeyCount: 0,
      error: r.error,
    };
  }
  return {
    repoId: r.repoId,
    repoName: r.repoName,
    repoPath: r.repoPath,
    env: r.env,
    ok: false,
    ownedKeyCount: r.ownedKeyCount,
    error: r.error,
  };
}
