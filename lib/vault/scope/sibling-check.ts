import type { Secret } from '../schema';

export type SiblingConflictResult =
  | { conflict: false }
  | { conflict: true; siblingId: string; siblingVariant: string | undefined };

export function findSiblingVariantConflict(
  candidate: Secret,
  siblings: Secret[],
  cell: { repoId: string; env: string },
): SiblingConflictResult {
  for (const s of siblings) {
    if (s.id === candidate.id) continue;
    if (s.key !== candidate.key) continue;
    if ((s.namespace ?? undefined) !== (candidate.namespace ?? undefined)) continue;
    if ((s.variant ?? undefined) === (candidate.variant ?? undefined)) continue;
    const ownsCell = s.scopes.some(sc => sc.repoId === cell.repoId && sc.env === cell.env);
    if (ownsCell) return { conflict: true, siblingId: s.id, siblingVariant: s.variant };
  }
  return { conflict: false };
}
