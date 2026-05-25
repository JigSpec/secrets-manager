import type { Repo, Secret, VaultData } from "../../vault/schema";

/**
 * Match repos by id first, then by name. The CLI accepts either form.
 */
export function findRepo(
  data: VaultData,
  needle: string,
): Repo | undefined {
  return (
    data.repos.find((r) => r.id === needle) ??
    data.repos.find((r) => r.name === needle)
  );
}

/**
 * Match secrets by id first, then by key. Namespaced secrets are matched on
 * the bare key — the CLI's namespace argument disambiguates when needed.
 */
export function findSecret(
  data: VaultData,
  needle: string,
): Secret | undefined {
  return (
    data.secrets.find((s) => s.id === needle) ??
    data.secrets.find((s) => s.key === needle)
  );
}

/**
 * Like findSecret but distinguishes between a single match and an ambiguous
 * one (multiple secrets share the same bare key with no namespace difference).
 *
 * Returns:
 *   - The Secret if exactly one matches by id, or exactly one matches by key
 *   - "AMBIGUOUS" if multiple distinct secrets match by key (different ids)
 *   - undefined if no match found
 *
 * When the needle matches by id, that is always unambiguous.
 */
export function findSecretOrAmbiguous(
  data: VaultData,
  needle: string,
  variant?: string,
): Secret | "AMBIGUOUS" | undefined {
  // ID match is always unambiguous.
  const byId = data.secrets.find((s) => s.id === needle);
  if (byId) return byId;

  // Bare-key match — count distinct secrets that match.
  const byKey = data.secrets.filter((s) => s.key === needle);
  if (byKey.length === 0) return undefined;
  if (byKey.length === 1) return byKey[0]!;

  // Variant-aware disambiguation (Phase 4): if a `variant` is provided and
  // exactly one of the by-key candidates matches it, that's the resolved
  // secret. Otherwise propagate AMBIGUOUS.
  if (variant !== undefined) {
    const byVariant = byKey.filter((s) => s.variant === variant);
    if (byVariant.length === 1) return byVariant[0]!;
  }
  return "AMBIGUOUS";
}

/**
 * Resolve a (key, variant) pair to a single Secret. Prefers id matches (always
 * unambiguous); falls back to `s.key === needle && s.variant === variant`.
 * Returns undefined when no match is found.
 *
 * Phase 4 helper for callers (like future set-variant flows) that want to
 * target a specific variant by key+variant rather than risk AMBIGUOUS.
 */
export function findSecretByKeyAndVariant(
  data: VaultData,
  needle: string,
  variant: string,
): Secret | undefined {
  const byId = data.secrets.find((s) => s.id === needle);
  if (byId) return byId;
  const byKeyAndVariant = data.secrets.filter(
    (s) => s.key === needle && s.variant === variant,
  );
  if (byKeyAndVariant.length === 1) return byKeyAndVariant[0]!;
  return undefined;
}
