import type { Scope, Secret } from "../schema";

/**
 * The string that will land on disk as the env var name.
 *
 * Identity on `secret.key` — namespace is intentionally ignored. As of issue
 * #78, `namespace` is a vault-internal disambiguator only (it lets the vault
 * hold two secrets that share the same `key` without colliding); it does
 * not affect the env-var name written to `.env.<env>`. The parameter type
 * still accepts a `namespace` field so callers can pass a full `Secret`
 * without first destructuring; the function ignores it.
 *
 *   key = "DATABASE_URL"                  → "DATABASE_URL"
 *   key = "API_KEY", namespace = "stripe" → "API_KEY"
 */
export function writtenKeyFor(
  secret: Pick<Secret, "key"> & { namespace?: string | undefined },
): string {
  return secret.key;
}

export type CollisionMember = {
  id: string;
  key: string;
  namespace: string | undefined;
};

export type Collision = {
  writtenKey: string;
  members: CollisionMember[];
};

/**
 * For a given `(repo, env)` cell, return every set of two-or-more secrets
 * whose `writtenKeyFor(...)` collide. Callers pass the scoped subset; this
 * function does not filter by scope itself.
 *
 * Under the post-#78 contract `writtenKeyFor` is identity on `key`, so a
 * collision here implies two secrets share the same bare `key` in the same
 * cell. That should already have been blocked at scope time by
 * `scopeCellConflicts`; this function remains as defense-in-depth for
 * legacy vaults that predate the scope-time guard.
 */
export function detectCollisions(secrets: Secret[]): Collision[] {
  const byWritten = new Map<string, CollisionMember[]>();
  for (const s of secrets) {
    const w = writtenKeyFor(s);
    const list = byWritten.get(w) ?? [];
    list.push({ id: s.id, key: s.key, namespace: s.namespace });
    byWritten.set(w, list);
  }
  const out: Collision[] = [];
  for (const [writtenKey, members] of byWritten) {
    if (members.length >= 2) {
      out.push({ writtenKey, members });
    }
  }
  return out;
}

/**
 * Convenience: given the full secret list + a target cell, return the
 * subset scoped to that cell. Pure; useful for both deploy + collision
 * detection callers.
 *
 * Secrets with `status === "awaiting_value"` are excluded — they have no
 * real value yet and must never be written to dotenvx repos.
 */
export function secretsForCell(
  secrets: Secret[],
  cell: Scope,
): Secret[] {
  return secrets.filter(
    (s) =>
      s.status !== "awaiting_value" &&
      s.scopes.some((sc) => sc.repoId === cell.repoId && sc.env === cell.env),
  );
}
