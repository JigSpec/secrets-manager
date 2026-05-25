import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findRepo, findSecretOrAmbiguous } from "./_resolve";
import { scopeCellConflicts } from "../../vault/scope-conflict";
import { findSiblingVariantConflict } from "../../vault/scope/sibling-check";

type BulkScopeRowResult = {
  secret: string;
  env: string;
  status: "scoped" | "unchanged" | "error";
  code?: string;
  message?: string;
};

registerHandler("scope-bulk", async (args) => {
  // Validate all args up-front.
  if (!Array.isArray(args.secrets) || (args.secrets as unknown[]).length === 0) {
    return err("INVALID_INPUT", "`secrets` (non-empty array of ids or keys) is required");
  }
  for (let i = 0; i < (args.secrets as unknown[]).length; i++) {
    if (typeof (args.secrets as unknown[])[i] !== "string") {
      return err("INVALID_INPUT", `\`secrets[${i}]\` must be a string`);
    }
  }

  if (typeof args.repo !== "string" || args.repo.length === 0) {
    return err("INVALID_INPUT", "`repo` (id or name) is required");
  }

  if (!Array.isArray(args.envs) || (args.envs as unknown[]).length === 0) {
    return err("INVALID_INPUT", "`envs` (non-empty array) is required");
  }
  for (let i = 0; i < (args.envs as unknown[]).length; i++) {
    if (typeof (args.envs as unknown[])[i] !== "string") {
      return err("INVALID_INPUT", `\`envs[${i}]\` must be a string`);
    }
  }

  const secrets = args.secrets as string[];
  const envs = args.envs as string[];

  const { data } = currentSessionData();
  const repo = findRepo(data, args.repo);
  if (!repo) return err("NOT_FOUND", `repo "${args.repo}" not found`);

  const results: BulkScopeRowResult[] = [];
  // Mutable data reference for inter-row consistency after each persist.
  let currentData = currentSessionData().data;

  for (const secretNeedle of secrets) {
    const secretOrAmb = findSecretOrAmbiguous(currentData, secretNeedle);

    if (!secretOrAmb) {
      // NOT_FOUND — emit error row for each env, continue to next secret.
      for (const env of envs) {
        results.push({
          secret: secretNeedle,
          env,
          status: "error",
          code: "NOT_FOUND",
          message: `secret "${secretNeedle}" not found`,
        });
      }
      continue;
    }

    if (secretOrAmb === "AMBIGUOUS") {
      // AMBIGUOUS — emit error row for each env, continue to next secret.
      for (const env of envs) {
        results.push({
          secret: secretNeedle,
          env,
          status: "error",
          code: "AMBIGUOUS",
          message: `multiple secrets share key "${secretNeedle}" — use the secret id instead`,
        });
      }
      continue;
    }

    let secret = secretOrAmb;

    for (const env of envs) {
      // Unknown env — emit INVALID_INPUT row.
      if (!repo.environments.includes(env)) {
        results.push({
          secret: secretNeedle,
          env,
          status: "error",
          code: "INVALID_INPUT",
          message: `env "${env}" is not configured for repo "${repo.name}"`,
        });
        continue;
      }

      // Re-fetch latest secret state after each persist.
      const latestSecret = currentData.secrets.find((s) => s.id === secret.id);
      if (!latestSecret) {
        results.push({
          secret: secretNeedle,
          env,
          status: "error",
          code: "NOT_FOUND",
          message: `secret "${secretNeedle}" disappeared unexpectedly`,
        });
        continue;
      }

      // Already scoped — idempotent.
      const has = latestSecret.scopes.some(
        (sc) => sc.repoId === repo.id && sc.env === env,
      );
      if (has) {
        results.push({ secret: secretNeedle, env, status: "unchanged" });
        continue;
      }

      // Check for conflict.
      const cell = { repoId: repo.id, env };

      // Sibling-variant guard: same logic as scope.ts. Variant-less candidates
      // skip this guard.
      if (latestSecret.variant !== undefined) {
        const siblingResult = findSiblingVariantConflict(
          latestSecret,
          currentData.secrets,
          cell,
        );
        if (siblingResult.conflict) {
          results.push({
            secret: secretNeedle,
            env,
            status: "error",
            code: "CONFLICT",
            message: `cell (${repo.name}, ${env}) is already owned by sibling secret "${siblingResult.siblingId}" with variant ${siblingResult.siblingVariant ?? "<unset>"}; manual scope blocked by variant identity rule`,
          });
          continue;
        }
      }

      if (scopeCellConflicts(currentData.secrets, latestSecret.id, latestSecret.key, latestSecret.namespace, cell)) {
        results.push({
          secret: secretNeedle,
          env,
          status: "error",
          code: "CONFLICT",
          message: `another secret with key "${latestSecret.key}"${
            latestSecret.namespace ? ` in namespace "${latestSecret.namespace}"` : ""
          } already owns scope (${repo.name}, ${env})`,
        });
        continue;
      }

      // Apply scope, persist, and update local state.
      const updated = {
        ...latestSecret,
        scopes: [...latestSecret.scopes, cell],
      };
      const newSecrets = currentData.secrets.map((s) => (s.id === latestSecret.id ? updated : s));
      currentData = { ...currentData, secrets: newSecrets };
      await persistData(currentData);
      secret = updated;
      results.push({ secret: secretNeedle, env, status: "scoped" });
    }
  }

  // Partial-failure semantics: always return ok with results array.
  return ok({ results });
});
