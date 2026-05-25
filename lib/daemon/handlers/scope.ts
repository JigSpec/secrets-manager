import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findRepo, findSecretOrAmbiguous } from "./_resolve";
import { scopeCellConflicts } from "../../vault/scope-conflict";
import { findSiblingVariantConflict } from "../../vault/scope/sibling-check";

type ScopeRowResult = {
  env: string;
  status: "scoped" | "unchanged" | "error";
  code?: string;
  message?: string;
};

registerHandler("scope", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  if (typeof args.repo !== "string" || args.repo.length === 0) {
    return err("INVALID_INPUT", "`repo` (id or name) is required");
  }

  // Determine the list of envs to process.
  // Accept `envs` (array) OR `env` (singular, backward-compat), but never both.
  // When `envs` array is used → partial-failure semantics (always returns ok with results).
  // When singular `env` is used → old error semantics preserved for backward compat.
  const hasBatch = Array.isArray(args.envs);
  const hasSingle = typeof args.env === "string" && (args.env as string).length > 0;

  if (hasBatch && hasSingle) {
    return err(
      "INVALID_INPUT",
      "provide either `env` (string) or `envs` (array), not both",
    );
  }
  if (!hasBatch && !hasSingle) {
    return err("INVALID_INPUT", "`env` or `envs` is required");
  }

  const useEnvsArray = hasBatch;
  let envsToProcess: string[];
  if (useEnvsArray) {
    const rawEnvs = args.envs as unknown[];
    if (rawEnvs.length === 0) {
      return err("INVALID_INPUT", "`envs` must be a non-empty array");
    }
    for (let i = 0; i < rawEnvs.length; i++) {
      if (typeof rawEnvs[i] !== "string") {
        return err(
          "INVALID_INPUT",
          `\`envs[${i}]\` must be a string, got ${typeof rawEnvs[i]}`,
        );
      }
    }
    envsToProcess = rawEnvs as string[];
  } else {
    envsToProcess = [args.env as string];
  }

  const { data } = currentSessionData();
  const secretOrAmb = findSecretOrAmbiguous(data, args.secret);
  if (!secretOrAmb) return err("NOT_FOUND", `secret "${args.secret}" not found`);
  if (secretOrAmb === "AMBIGUOUS") {
    return err(
      "AMBIGUOUS",
      `multiple secrets share key "${args.secret}" — use the secret id instead`,
    );
  }
  let secret = secretOrAmb;

  const repo = findRepo(data, args.repo);
  if (!repo) return err("NOT_FOUND", `repo "${args.repo}" not found`);

  // Process each env, accumulating results with per-row partial-failure commits.
  const results: ScopeRowResult[] = [];
  // We need a mutable reference to the current session data for inter-row consistency.
  let currentData = currentSessionData().data;

  for (const env of envsToProcess) {
    // Validate env is in repo.environments.
    if (!repo.environments.includes(env)) {
      if (!useEnvsArray) {
        // Singular env path: preserve old hard-error semantics.
        return err(
          "INVALID_INPUT",
          `env "${env}" is not configured for repo "${repo.name}"`,
        );
      }
      results.push({
        env,
        status: "error",
        code: "INVALID_INPUT",
        message: `env "${env}" is not configured for repo "${repo.name}"`,
      });
      continue;
    }

    // Re-fetch the secret from current data to get latest scopes after each commit.
    const latestSecret = currentData.secrets.find((s) => s.id === secret.id);
    if (!latestSecret) {
      results.push({
        env,
        status: "error",
        code: "NOT_FOUND",
        message: `secret "${secret.id}" disappeared unexpectedly`,
      });
      continue;
    }

    const has = latestSecret.scopes.some(
      (sc) => sc.repoId === repo.id && sc.env === env,
    );
    if (has) {
      results.push({ env, status: "unchanged" });
      continue;
    }

    // Check for conflict.
    const cell = { repoId: repo.id, env };

    // Sibling-variant guard: a secret carrying a variant cannot be manually
    // scoped onto a cell already owned by a same-key+namespace sibling with
    // a DIFFERENT variant. Runs BEFORE scopeCellConflicts so the sibling
    // message is preferred over the namespace-blind one. Variant-less
    // secrets skip this guard (Phase 4 sibling rule applies only when the
    // candidate carries a variant).
    if (latestSecret.variant !== undefined) {
      const siblingResult = findSiblingVariantConflict(
        latestSecret,
        currentData.secrets,
        cell,
      );
      if (siblingResult.conflict) {
        const message = `cell (${repo.name}, ${env}) is already owned by sibling secret "${siblingResult.siblingId}" with variant ${siblingResult.siblingVariant ?? "<unset>"}; manual scope blocked by variant identity rule`;
        if (!useEnvsArray) {
          return err("CONFLICT", message);
        }
        results.push({
          env,
          status: "error",
          code: "CONFLICT",
          message,
        });
        continue;
      }
    }

    if (scopeCellConflicts(currentData.secrets, latestSecret.id, latestSecret.key, latestSecret.namespace, cell)) {
      // Post-#78: the conflict is the bare key collision, not the namespace.
      // Namespaces are vault-internal disambiguators and do not differentiate
      // deploy keys, so we don't mention them in the user-facing message.
      const message = `another secret with key "${latestSecret.key}" already owns scope (${repo.name}, ${env}); namespaces do not differentiate deploy keys`;
      if (!useEnvsArray) {
        // Singular env path: preserve old hard-error semantics.
        return err("CONFLICT", message);
      }
      results.push({
        env,
        status: "error",
        code: "CONFLICT",
        message,
      });
      continue;
    }

    // Apply scope and persist.
    const updated = {
      ...latestSecret,
      scopes: [...latestSecret.scopes, cell],
    };
    const newSecrets = currentData.secrets.map((s) => (s.id === latestSecret.id ? updated : s));
    currentData = { ...currentData, secrets: newSecrets };
    await persistData(currentData);
    // Update local secret reference so outboundMetadata reflects all applied scopes.
    secret = updated;
    results.push({ env, status: "scoped" });
  }

  // Re-fetch final state of the secret for metadata.
  const finalSecret = currentData.secrets.find((s) => s.id === secret.id) ?? secret;

  // For idempotent single-env (unchanged), also set unchanged: true for backward compat.
  const allUnchanged = results.length > 0 && results.every((r) => r.status === "unchanged");
  const response: Record<string, unknown> = {
    secret: outboundMetadata(finalSecret),
    results,
  };
  if (!useEnvsArray && allUnchanged) {
    response.unchanged = true;
  }
  return ok(response);
});

function outboundMetadata(s: {
  id: string;
  key: string;
  scopes: { repoId: string; env: string }[];
  namespace?: string;
}) {
  const out: Record<string, unknown> = {
    id: s.id,
    key: s.key,
    scopes: s.scopes,
  };
  if (s.namespace !== undefined) out.namespace = s.namespace;
  return out;
}
