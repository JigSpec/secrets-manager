import type { Secret, Scope } from "./schema";

/**
 * Returns the first (repoId, env) cell that is already claimed by another
 * secret with the same (key, namespace), or null if the operation is safe.
 * Pass excludeId when updating an existing secret.
 */
export function findScopeConflict(
  secrets: Secret[],
  candidate: { key: string; namespace?: string; scopes: Scope[] },
  excludeId?: string,
): Scope | null {
  for (const s of secrets) {
    if (s.id === excludeId) continue;
    if (s.key !== candidate.key) continue;
    if ((s.namespace ?? undefined) !== (candidate.namespace ?? undefined)) continue;
    for (const cell of s.scopes) {
      const matchingCandidateCell = candidate.scopes.find(
        (c) => c.repoId === cell.repoId && c.env === cell.env,
      );
      if (matchingCandidateCell) {
        return matchingCandidateCell;
      }
    }
  }
  return null;
}

/**
 * Returns true if adding `cell` to the secret identified by secretId would
 * conflict with any sibling secret (same key, different id).
 *
 * Note: namespace is intentionally ignored here. Two secrets with the same
 * base key (e.g. API_KEY/stripe and API_KEY/github) cannot coexist in the
 * same scope cell because both would write to the same env-var name in
 * `.env.<env>` regardless of namespace (issue #78). Use `findScopeConflict`
 * (which IS namespace-aware) for rename/set-namespace operations where the
 * full (key, namespace) pair matters.
 */
export function scopeCellConflicts(
  secrets: Secret[],
  secretId: string,
  key: string,
  _namespace: string | undefined,
  cell: Scope,
): boolean {
  return secrets.some(
    (s) =>
      s.id !== secretId &&
      s.key === key &&
      s.scopes.some((sc) => sc.repoId === cell.repoId && sc.env === cell.env),
  );
}
