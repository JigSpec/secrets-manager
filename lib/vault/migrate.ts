import { VaultError } from "./errors";
import { migrateV2toV3 } from "./migrate/v2-to-v3";
import { migrateV3toV4 } from "./migrate/v3-to-v4";

/**
 * Migrate a parsed vault payload from v1 (or unversioned) to v2.
 *
 * - v0.1 (no `version` field): wrap as `{ version: 2, repos, secrets }`. Every
 *   secret keeps its existing fields; `namespace` is left absent (interpreted
 *   as "shared" downstream).
 * - v1: upgrade to v2.
 * - v2: pass through.
 * - v3+: pass through (handled by later migration steps).
 *
 * Zod validation happens AFTER this step, so we accept `unknown` and emit a
 * shape the zod schema will accept (or fail) deterministically.
 */
export function migrateFromV1(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Not an object — leave to zod for a useful INVALID_DATA error.
    return parsed;
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj.version;

  if (version === undefined) {
    return {
      version: 2,
      repos: obj.repos ?? [],
      secrets: obj.secrets ?? [],
    };
  }

  if (typeof version === "number") {
    if (version === 2) return parsed;
    if (version === 1) {
      return {
        version: 2,
        repos: obj.repos ?? [],
        secrets: obj.secrets ?? [],
      };
    }
    if (version === 3) {
      // v3 is accepted — pass through for schema validation.
      return parsed;
    }
    if (version === 4) {
      // v4 is accepted — pass through for schema validation.
      return parsed;
    }
    if (version > 4) {
      throw new VaultError(
        "INCOMPATIBLE_VAULT_VERSION",
        `vault version ${version} is newer than this build supports`,
      );
    }
  }

  // Unknown shape; let zod reject it.
  return parsed;
}

/**
 * @deprecated Use `migrateFromV1` instead.
 * Kept as an alias for backward compatibility during the rename transition.
 */
export const migrateToV2 = migrateFromV1;

/**
 * Migrate a parsed vault payload to the latest schema version (v4).
 *
 * Chains: unversioned/v1 → v2 → v3 → v4.
 * Throws INCOMPATIBLE_VAULT_VERSION for version > 4.
 */
export function migrateToLatest(parsed: unknown): unknown {
  // migrateFromV1 handles throwing for version > 4.
  return migrateV3toV4(migrateV2toV3(migrateFromV1(parsed)));
}
