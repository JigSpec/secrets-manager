import { z } from "zod";

import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findRepo } from "./_resolve";
import { planAutoScope, applyAutoScope } from "../../vault/variant/auto-scope";

const EnvName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, {
    message: "env names must start with a letter and use [A-Za-z0-9_-]",
  });

registerHandler("set-repo-envs", async (args) => {
  if (typeof args.target !== "string" || args.target.length === 0) {
    return err("INVALID_INPUT", "`target` (repo id or name) is required");
  }
  const parsed = z.array(EnvName).min(1).safeParse(args.environments);
  if (!parsed.success) {
    return err(
      "INVALID_INPUT",
      parsed.error.issues[0]?.message ?? "at least one valid env is required",
    );
  }
  const newEnvs = Array.from(new Set(parsed.data));

  const { data } = currentSessionData();
  const repo = findRepo(data, args.target);
  if (!repo) return err("NOT_FOUND", `repo "${args.target}" not found`);

  const allowed = new Set(newEnvs);
  const repos = data.repos.map((r) =>
    r.id === repo.id ? { ...r, environments: newEnvs } : r,
  );
  // Step 1 — strip scopes pointing at removed envs.
  let secrets = data.secrets.map((s) => ({
    ...s,
    scopes: s.scopes.filter(
      (sc) => sc.repoId !== repo.id || allowed.has(sc.env),
    ),
  }));

  // Step 2 — walk every variant-bearing secret and re-run planAutoScope
  // against the post-strip next-state vault, so newly-added envs claim the
  // variant secrets they should. Sibling-conflict cells are accumulated and
  // surfaced via `skippedVariants` so the caller can react.
  const skippedVariants: { repoId: string; env: string; siblingId?: string }[] = [];
  // Snapshot used during the walk; mutate only its `secrets` key per iteration
  // to avoid a full object spread on every loop pass (O(n²) → O(n)).
  let walkData = { ...data, repos, secrets };
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i]!;
    if (s.variant === undefined) continue;
    const plan = planAutoScope(s, walkData);
    const updated = applyAutoScope(s, plan);
    secrets = secrets.map((t, j) => (j === i ? updated : t));
    walkData.secrets = secrets;
    for (const cell of plan) {
      if (cell.action === "skip-sibling-conflict") {
        skippedVariants.push({
          repoId: cell.cell.repoId,
          env: cell.cell.env,
          ...(cell.siblingId ? { siblingId: cell.siblingId } : {}),
        });
      }
    }
  }
  const nextData = { ...walkData, secrets };
  await persistData(nextData);
  return ok({
    repo: { id: repo.id, name: repo.name, environments: newEnvs },
    ...(skippedVariants.length > 0 ? { skippedVariants } : {}),
  });
});
