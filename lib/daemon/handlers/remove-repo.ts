import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findRepo } from "./_resolve";

registerHandler("remove-repo", async (args) => {
  if (typeof args.target !== "string" || args.target.length === 0) {
    return err("INVALID_INPUT", "`target` (repo id or name) is required");
  }
  const { data } = currentSessionData();
  const repo = findRepo(data, args.target);
  if (!repo) return err("NOT_FOUND", `repo "${args.target}" not found`);

  const repos = data.repos.filter((r) => r.id !== repo.id);
  const secrets = data.secrets.map((s) => ({
    ...s,
    scopes: s.scopes.filter((sc) => sc.repoId !== repo.id),
  }));
  await persistData({ ...data, repos, secrets });
  return ok({ removedRepo: { id: repo.id, name: repo.name } });
});
