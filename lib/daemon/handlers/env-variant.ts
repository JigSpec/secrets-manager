import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { VariantSchema } from "../../vault/schema";

/**
 * env-variant-list: return the current envVariantMap stored in the vault.
 */
registerHandler("env-variant-list", async (_args) => {
  const { data } = currentSessionData();
  const envVariantMap = data.envVariantMap;
  return ok({ envVariantMap });
});

/**
 * env-variant-set: set a global or per-repo env→variant override.
 *
 * Args:
 *   env: string (required)
 *   variant: string (required)
 *   repo?: string — if provided, sets a per-repo override; otherwise global
 */
registerHandler("env-variant-set", async (args) => {
  if (typeof args.env !== "string" || args.env.length === 0) {
    return err("INVALID_INPUT", "`env` is required and must be a non-empty string");
  }
  if (typeof args.variant !== "string" || args.variant.length === 0) {
    return err("INVALID_INPUT", "`variant` is required and must be a non-empty string");
  }
  const variantParsed = VariantSchema.safeParse(args.variant);
  if (!variantParsed.success) {
    return err(
      "INVALID_INPUT",
      "`variant` must start with a lowercase letter and contain only lowercase letters/digits, max 32 chars",
    );
  }

  const { data } = currentSessionData();
  const existing = data.envVariantMap;

  let next = existing;

  if (typeof args.repo === "string" && args.repo.length > 0) {
    // Validate that the repo ID exists in the vault
    const repoExists = data.repos.some((r) => r.id === args.repo);
    if (!repoExists) {
      return err("NOT_FOUND", `repo "${args.repo}" not found`);
    }
    // Per-repo override
    const repoOverrides = { ...(existing.repos[args.repo] ?? {}), [args.env]: variantParsed.data };
    next = {
      ...existing,
      repos: { ...existing.repos, [args.repo]: repoOverrides },
    };
  } else {
    // Global override
    next = {
      ...existing,
      global: { ...existing.global, [args.env]: variantParsed.data },
    };
  }

  await persistData({ ...data, envVariantMap: next });
  return ok({});
});

const EMPTY_MAP_NOTE =
  "envVariantMap is now empty; the daemon will fall back to " +
  "DEFAULT_ENV_VARIANT_MAP (development/test/local→test, " +
  "staging/stage/preview→staging, production/prod/live→live). " +
  "To stop a secret from auto-scoping, call set_variant with unset:true " +
  "on the secret instead.";

/**
 * env-variant-unset: remove a global or per-repo env→variant override.
 *
 * Args:
 *   env: string (required)
 *   repo?: string — if provided, removes per-repo override; otherwise global
 */
registerHandler("env-variant-unset", async (args) => {
  if (typeof args.env !== "string" || args.env.length === 0) {
    return err("INVALID_INPUT", "`env` is required and must be a non-empty string");
  }

  const { data } = currentSessionData();
  const existing = data.envVariantMap;

  let next = existing;

  if (typeof args.repo === "string" && args.repo.length > 0) {
    // Remove per-repo override
    const repoOverrides = { ...(existing.repos[args.repo] ?? {}) };
    delete repoOverrides[args.env];
    // Clean up empty repo objects to avoid accumulating tombstones
    const repos = { ...existing.repos };
    if (Object.keys(repoOverrides).length === 0) {
      delete repos[args.repo];
    } else {
      repos[args.repo] = repoOverrides;
    }
    next = { ...existing, repos };
  } else {
    // Remove global override; clean up is implicit since we rebuild the object
    const global = { ...existing.global };
    delete global[args.env];
    next = { ...existing, global };
  }

  await persistData({ ...data, envVariantMap: next });
  // Empty-map footgun (scope-doc §5 Phase 4 #6, option (a)): an empty map is
  // indistinguishable from "no map" → planAutoScope falls back to
  // DEFAULT_ENV_VARIANT_MAP. Warn the caller that auto-scoping is NOT
  // disabled — the only way to opt out is to clear the secret's variant.
  const isEmpty =
    Object.keys(next.global).length === 0 &&
    Object.keys(next.repos).length === 0;
  if (isEmpty) {
    return ok({ note: EMPTY_MAP_NOTE });
  }
  return ok({});
});
