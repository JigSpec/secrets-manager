import type { EnvVariantMap } from '../schema';

export const DEFAULT_ENV_VARIANT_MAP: Readonly<Record<string, string>> = Object.freeze({
  local: 'test', dev: 'test', development: 'test', test: 'test', testing: 'test', sandbox: 'test',
  staging: 'staging', stage: 'staging', preview: 'staging',
  prod: 'live', production: 'live', live: 'live',
});

export function resolveVariant(map: EnvVariantMap | undefined, repoId: string, env: string): string | undefined {
  const repoOverride = map?.repos?.[repoId]?.[env];
  if (repoOverride !== undefined) return repoOverride;
  const globalOverride = map?.global?.[env];
  if (globalOverride !== undefined) return globalOverride;
  // Only use the default map when no explicit map is provided.
  if (map === undefined) {
    return DEFAULT_ENV_VARIANT_MAP[env];
  }
  return undefined;
}

export function cellsForVariant(
  variant: string,
  repos: Array<{ id: string; environments: string[] }>,
  map: EnvVariantMap | undefined,
): Array<{ repoId: string; env: string }> {
  const cells: Array<{ repoId: string; env: string }> = [];
  for (const repo of repos) {
    for (const env of repo.environments) {
      if (resolveVariant(map, repo.id, env) === variant) {
        cells.push({ repoId: repo.id, env });
      }
    }
  }
  return cells;
}
