import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findRepo } from "./_resolve";

registerHandler("update-repo-path", async (args) => {
  // Canonical key: `target`. Backward-compat alias: `repo` (used by the CLI
  // and pre-existing callers). Mirrors the pattern used by `remove-repo` and
  // `set-repo-envs`.
  const rawTarget =
    typeof args.target === "string"
      ? args.target
      : typeof args.repo === "string"
        ? args.repo
        : "";
  const targetArg = rawTarget.trim();
  const pathArg = typeof args.path === "string" ? args.path.trim() : "";

  if (!targetArg) {
    return err("INVALID_INPUT", "`target` (repo id or name) is required");
  }
  if (!pathArg) {
    return err("INVALID_INPUT", "`path` is required");
  }
  if (!pathArg.startsWith("/")) {
    return err("INVALID_INPUT", "path must be absolute (start with /)");
  }
  if (pathArg.includes("\0")) {
    return err("INVALID_INPUT", "path must not contain null bytes");
  }

  const { data } = currentSessionData();
  const repo = findRepo(data, targetArg);
  if (!repo) {
    return err("NOT_FOUND", `repo "${targetArg}" not found`);
  }

  if (pathArg === repo.path) {
    return ok({ repo: { id: repo.id, name: repo.name, path: repo.path } });
  }

  if (data.repos.some((r) => r.id !== repo.id && r.path === pathArg)) {
    return err("CONFLICT", "a repo with that path is already registered");
  }

  const updatedRepo = { ...repo, path: pathArg };
  const repos = data.repos.map((r) => (r.id === repo.id ? updatedRepo : r));
  await persistData({ ...data, repos });

  return ok({ repo: { id: updatedRepo.id, name: updatedRepo.name, path: updatedRepo.path } });
});
