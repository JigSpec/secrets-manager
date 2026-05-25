import { fingerprint } from "./value-hash";
import type { Secret } from "../vault/schema";

export type SharedGroup = {
  fingerprint: string;
  members: Array<{ id: string; key: string; namespace?: string }>;
};

/**
 * Group secrets that share a value (above the entropy floor) by their
 * fingerprint. Returns only groups of two or more — singletons are
 * uninteresting and excluded.
 *
 * Values below the fingerprint's length/entropy floor produce `null` and are
 * ignored entirely — `"password"` is not interesting as a shared value.
 */
export function findShared(secrets: Secret[]): SharedGroup[] {
  const byFp = new Map<string, Secret[]>();
  for (const s of secrets) {
    const fp = fingerprint(s.value);
    if (fp === null) continue;
    const arr = byFp.get(fp) ?? [];
    arr.push(s);
    byFp.set(fp, arr);
  }
  const groups: SharedGroup[] = [];
  for (const [fp, arr] of byFp) {
    if (arr.length < 2) continue;
    groups.push({
      fingerprint: fp,
      members: arr.map((s) => ({
        id: s.id,
        key: s.key,
        ...(s.namespace !== undefined ? { namespace: s.namespace } : {}),
      })),
    });
  }
  // Stable ordering by fingerprint for predictable test output.
  groups.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return groups;
}
