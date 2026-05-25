import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { runImport, type ImportConflictPolicy } from "../../import/import";
import { findRepo } from "./_resolve";
import { VariantSchema } from "../../vault/schema";
import { resolveVariant } from "../../vault/variant/resolve";

const VALID_CONFLICTS = new Set<ImportConflictPolicy>(["skip", "overwrite", "fail"]);

registerHandler("import", async (args) => {
  if (typeof args.repo !== "string" || args.repo.length === 0) {
    return err("INVALID_INPUT", "`repo` (id or name) is required");
  }
  const env =
    typeof args.env === "string" && args.env.length > 0 ? args.env : undefined;
  const dryRun = args.dryRun === true;
  const defaultNamespace =
    typeof args.defaultNamespace === "string" && args.defaultNamespace.length > 0
      ? args.defaultNamespace
      : undefined;
  // Explicit defaultVariant (validated) overrides the implicit env-derived
  // variant lookup below. Empty string is treated as "absent" for symmetry
  // with defaultNamespace.
  let defaultVariant: string | undefined;
  if (typeof args.defaultVariant === "string" && args.defaultVariant.length > 0) {
    const parsed = VariantSchema.safeParse(args.defaultVariant);
    if (!parsed.success) {
      return err(
        "INVALID_INPUT",
        "defaultVariant must start with a lowercase letter and contain only lowercase letters/digits, max 32 chars",
      );
    }
    defaultVariant = parsed.data;
  }
  const onConflict =
    typeof args.onConflict === "string" && VALID_CONFLICTS.has(args.onConflict as ImportConflictPolicy)
      ? (args.onConflict as ImportConflictPolicy)
      : "skip";

  const { data } = currentSessionData();
  const repo = findRepo(data, args.repo);
  if (!repo) return err("NOT_FOUND", `repo "${args.repo}" not found`);

  // Default-env resolution: if no --env given, refuse for multi-env repos to
  // avoid silently picking the wrong one. Single-env repos pick the only env.
  let targetEnv = env;
  if (!targetEnv) {
    if (repo.environments.length === 1) {
      targetEnv = repo.environments[0]!;
    } else {
      return err(
        "INVALID_INPUT",
        `repo "${repo.name}" has multiple envs (${repo.environments.join(", ")}); pass --env`,
      );
    }
  }
  if (!repo.environments.includes(targetEnv)) {
    return err(
      "INVALID_INPUT",
      `env "${targetEnv}" is not configured for repo "${repo.name}"`,
    );
  }

  // If the caller did not pass an explicit defaultVariant, derive it from the
  // target env via the envVariantMap. Mirror the empty-map fallback from
  // planAutoScope: an empty map means "fall through to DEFAULT_ENV_VARIANT_MAP".
  if (defaultVariant === undefined) {
    const rawMap = data.envVariantMap;
    const mapIsEmpty =
      Object.keys(rawMap.global).length === 0 &&
      Object.keys(rawMap.repos).length === 0;
    const effectiveMap = mapIsEmpty ? undefined : rawMap;
    defaultVariant = resolveVariant(effectiveMap, repo.id, targetEnv);
  }

  let res;
  try {
    res = await runImport({
      data,
      repoPath: repo.path,
      repoId: repo.id,
      repoName: repo.name,
      env: targetEnv,
      defaultNamespace,
      defaultVariant,
      onConflict,
      dryRun,
    });
  } catch (e) {
    return err(
      "BAD_REQUEST",
      `import failed: ${(e as Error).message ?? "unknown error"}`,
    );
  }
  if (!res.ok) {
    return err(
      "IMPORT_CONFLICT",
      `conflict on key "${res.plan.actions.find((a) => a.type === "conflict")?.key}" — re-run with --on-conflict skip|overwrite to proceed`,
    );
  }
  if (res.next) {
    await persistData(res.next);
  }
  return ok({ plan: res.plan, dryRun });
});
