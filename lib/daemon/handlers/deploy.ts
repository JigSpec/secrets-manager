import { registerHandler, currentSessionData } from "../server";
import { err, ok } from "../protocol";
import { runDeploy, enumerateTargets, type DeployTarget } from "../../vault/deploy/run-deploy";
import { findRepo } from "./_resolve";

registerHandler("deploy", async (args) => {
  const dryRun = args.dryRun === true;
  const localOnly = args.localOnly === true;
  const repoArg =
    typeof args.repo === "string" && args.repo.length > 0 ? args.repo : undefined;
  const envArg =
    typeof args.env === "string" && args.env.length > 0 ? args.env : undefined;

  const { data } = currentSessionData();

  let targets: DeployTarget[] | undefined;
  if (repoArg) {
    const repo = findRepo(data, repoArg);
    if (!repo) return err("NOT_FOUND", `repo "${repoArg}" not found`);
    if (envArg && !repo.environments.includes(envArg)) {
      return err(
        "INVALID_INPUT",
        `env "${envArg}" is not configured for repo "${repo.name}"`,
      );
    }
    targets = enumerateTargets(data).filter(
      (t) => t.repoId === repo.id && (!envArg || t.env === envArg),
    );
  } else if (envArg) {
    targets = enumerateTargets(data).filter((t) => t.env === envArg);
  }

  const results = await runDeploy({ data, targets, dryRun, localOnly });
  const anyFail = results.some((r) => !r.ok);
  if (anyFail && !dryRun) {
    // The plan says deploy is "informational" — a per-target failure does
    // not abort the whole run, but the caller's exit code should reflect
    // the partial failure. We still return ok=true with results, and let
    // the CLI inspect.
  }
  return ok({ results, dryRun });
});
