import type { Repo, Secret } from "@/lib/vault/schema";

/**
 * Returns all secrets that have at least one scope targeting the given repo.
 */
export function secretsForRepo(secrets: Secret[], repoId: string): Secret[] {
  return secrets.filter((secret) =>
    secret.scopes.some((scope) => scope.repoId === repoId),
  );
}

/**
 * Groups secrets by environment for a given repo.
 *
 * Returns a Map whose keys are the environment names defined on the repo
 * (in the same order as `repo.environments`) and whose values are the
 * secrets whose scopes include that repo+env combination.
 *
 * A secret can appear in multiple buckets if it is scoped to the same repo
 * with several different environments.
 *
 * The `secrets` array need not be pre-filtered to the repo — the function
 * filters by `repo.id` internally.
 */
export function groupSecretsByEnv(
  secrets: Secret[],
  repo: Repo,
): Map<string, Secret[]> {
  const result = new Map<string, Secret[]>();

  for (const env of repo.environments) {
    result.set(
      env,
      secrets.filter((secret) =>
        secret.scopes.some(
          (scope) => scope.repoId === repo.id && scope.env === env,
        ),
      ),
    );
  }

  return result;
}
