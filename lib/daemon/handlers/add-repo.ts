import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { z } from "zod";

import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import type { Repo } from "../../vault/schema";
import { planAutoScope, applyAutoScope } from "../../vault/variant/auto-scope";

const EnvName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, {
    message: "env names must start with a letter and use [A-Za-z0-9_-]",
  });

const InputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  path: z
    .string()
    .trim()
    .min(1)
    .refine((p) => p.startsWith("/"), {
      message: "path must be absolute (start with /)",
    }),
  environments: z.array(EnvName).min(1),
});

registerHandler("add-repo", async (args) => {
  const parsed = InputSchema.safeParse(args);
  if (!parsed.success) {
    return err("INVALID_INPUT", parsed.error.issues[0]?.message ?? "invalid input");
  }
  const { name, path, environments } = parsed.data;
  if (!existsSync(path)) {
    return err("INVALID_INPUT", `path does not exist: ${path}`);
  }
  try {
    if (!statSync(path).isDirectory()) {
      return err("INVALID_INPUT", `path is not a directory: ${path}`);
    }
  } catch {
    return err("INVALID_INPUT", `path is not accessible: ${path}`);
  }

  const { data } = currentSessionData();
  if (data.repos.some((r) => r.path === path)) {
    return err("CONFLICT", "a repo with that path is already registered");
  }
  if (data.repos.some((r) => r.name === name)) {
    return err("CONFLICT", `a repo named "${name}" already exists`);
  }

  const repo: Repo = {
    id: randomBytes(8).toString("hex"),
    name,
    path,
    environments: Array.from(new Set(environments)),
  };
  // Auto-scope walk: every variant-bearing secret may need to land in the
  // newly-added repo's cells (those whose env resolves to the secret's
  // variant via the envVariantMap). Run planAutoScope against the new
  // next-state vault, accumulate skip-sibling-conflict cells, and surface
  // them on the response.
  const skippedVariants: { repoId: string; env: string; siblingId?: string }[] = [];
  let secrets = data.secrets;
  // Snapshot with the new repo — used as the evolving state during the walk so
  // each planAutoScope call sees the up-to-date secrets list from prior iterations.
  let walkData = { ...data, repos: [...data.repos, repo], secrets };
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i]!;
    if (s.variant === undefined) continue;
    const plan = planAutoScope(s, walkData);
    const updated = applyAutoScope(s, plan);
    secrets = secrets.map((t, j) => (j === i ? updated : t));
    // Update the walk snapshot's secrets in-place; avoid a full object spread on
    // every iteration by mutating only the `secrets` key of the existing snapshot.
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
    repo,
    ...(skippedVariants.length > 0 ? { skippedVariants } : {}),
  });
});
