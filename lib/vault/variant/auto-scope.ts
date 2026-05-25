import type { Secret, VaultDataV4 } from '../schema';
import { cellsForVariant } from './resolve';
import { findSiblingVariantConflict } from '../scope/sibling-check';

export type AutoScopeCell =
  | { action: 'add'; cell: { repoId: string; env: string } }
  | { action: 'skip-already-scoped'; cell: { repoId: string; env: string } }
  | { action: 'skip-sibling-conflict'; cell: { repoId: string; env: string }; siblingId?: string };

export type AutoScopePlan = AutoScopeCell[];

/**
 * Compute the set of `(repoId, env)` cells that `secret` should be added to,
 * based on the vault's `envVariantMap` and the secret's `variant` tag.
 *
 * **Empty-map footgun (Resolution to scope-doc §5 Phase 4 #6, option (a)):**
 * if `data.envVariantMap` exists but both its `global` and `repos` sub-maps
 * are empty (which happens after a user removes every entry via
 * `env-variant-unset`), the function treats the map as absent and falls back
 * to `DEFAULT_ENV_VARIANT_MAP`. There is currently no way to express
 * "I want zero auto-scoping" through the map alone — an empty map is
 * indistinguishable from a missing one. Users who intend to disable
 * auto-scoping entirely must instead leave the secret's `variant` field unset
 * (call `set_variant` with `unset: true` on each variant-bearing secret).
 *
 * Resolution decision: option (a) — fall back to the default map — was chosen
 * over (b) treating the empty map as "explicit disable" because fresh V3+
 * vaults that have not customised the map should still benefit from sensible
 * defaults. The trade-off is the footgun documented above; the
 * `env-variant-unset` handler partially mitigates it by returning a `note`
 * field whenever the map becomes empty (see
 * `lib/daemon/handlers/env-variant.ts`).
 */
export function planAutoScope(secret: Secret, data: VaultDataV4): AutoScopePlan {
  if (secret.variant === undefined) {
    return [];
  }

  // Treat an envVariantMap with empty global and repos as "no map" (fall back to
  // DEFAULT_ENV_VARIANT_MAP) so that freshly-created v3 vaults behave naturally.
  const rawMap = data.envVariantMap;
  const mapIsEmpty =
    Object.keys(rawMap.global).length === 0 &&
    Object.keys(rawMap.repos).length === 0;
  const map = mapIsEmpty ? undefined : rawMap;

  const candidateCells = cellsForVariant(secret.variant, data.repos, map);
  const plan: AutoScopePlan = candidateCells.map(cell => {
    const alreadyHas = secret.scopes.some(sc => sc.repoId === cell.repoId && sc.env === cell.env);
    if (alreadyHas) return { action: 'skip-already-scoped' as const, cell };

    const sibling = findSiblingVariantConflict(secret, data.secrets, cell);
    if (sibling.conflict) {
      return { action: 'skip-sibling-conflict' as const, cell, siblingId: sibling.siblingId };
    }

    return { action: 'add' as const, cell };
  });

  return plan;
}

export function applyAutoScope(secret: Secret, plan: AutoScopePlan): Secret {
  const additions = plan
    .filter((c): c is { action: 'add'; cell: { repoId: string; env: string } } => c.action === 'add')
    .map(c => c.cell);
  if (additions.length === 0) return secret;
  return { ...secret, scopes: [...secret.scopes, ...additions] };
}
