import { DEFAULT_ENV_VARIANT_MAP } from '../variant/resolve';

export function migrateV2toV3(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  // Already v3 — pass through unchanged; do not re-inject defaults.
  // Note: this function receives raw (pre-Zod) data, so `obj.version` may be
  // any value. Strict equality against integer 3 is intentional; non-integer
  // values (e.g. 2.9) fall through and are treated as needing upgrade, which
  // is safe — Zod will reject them later if they produce an invalid shape.
  if (obj.version === 3) return parsed;
  return {
    ...obj,
    version: 3,
    envVariantMap: obj.envVariantMap ?? { global: { ...DEFAULT_ENV_VARIANT_MAP }, repos: {} },
  };
}
