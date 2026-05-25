import { registerHandler, currentSessionData } from "../server";
import { ok } from "../protocol";

/**
 * Emit one row per (repoName, env, secretKey, namespace, secretId). Rows are
 * cross-joined from the secret's scopes; collisions are *not* resolved here.
 * The CLI consumer or `detectCollisions` does that work.
 */
registerHandler("list-scopes", async () => {
  const { data } = currentSessionData();
  const reposById = new Map(data.repos.map((r) => [r.id, r]));
  type ScopeRow = {
    repoId: string;
    repoName: string;
    env: string;
    secretId: string;
    secretKey: string;
    namespace?: string;
  };
  const rows: ScopeRow[] = [];
  for (const s of data.secrets) {
    for (const sc of s.scopes) {
      const r = reposById.get(sc.repoId);
      if (!r) continue;
      const row: ScopeRow = {
        repoId: sc.repoId,
        repoName: r.name,
        env: sc.env,
        secretId: s.id,
        secretKey: s.key,
      };
      if (s.namespace !== undefined) row.namespace = s.namespace;
      rows.push(row);
    }
  }
  return ok({ scopes: rows });
});
