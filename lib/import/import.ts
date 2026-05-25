import { SecretKeySchema, type Secret, type VaultData, type VaultDataV4 } from "../vault/schema";
import { readEnvFile, type EnvEntry } from "./env-parse";
import { classifySecret } from "../vault/classify";
import { generateSecretId } from "../daemon/id";
import { planAutoScope, applyAutoScope } from "../vault/variant/auto-scope";
import { isDotenvxReservedKey } from "../vault/sentinel";

export type ImportConflictPolicy = "skip" | "overwrite" | "fail";

export type ImportEntryAction =
  | { type: "skipped"; key: string; reason: "invalid-key" | "dotenvx-reserved" }
  | { type: "scope-existing"; key: string; namespace?: string; secretId: string }
  | { type: "new-secret"; key: string; namespace?: string; secretId: string }
  | { type: "overwrite"; key: string; namespace?: string; secretId: string }
  | { type: "skip"; key: string; namespace?: string; secretId: string }
  | { type: "conflict"; key: string; namespace?: string }
  | {
      type: "variant-skip";
      key: string;
      namespace?: string;
      secretId: string;
      cell: { repoId: string; env: string };
      siblingId?: string;
    };

export type ImportPlan = {
  repoId: string;
  repoName: string;
  env: string;
  actions: ImportEntryAction[];
  /** Total number of `.env` entries considered. */
  entriesParsed: number;
};

export type ImportOptions = {
  data: VaultDataV4;
  repoPath: string;
  repoId: string;
  repoName: string;
  env: string;
  defaultNamespace?: string;
  /**
   * If set, newly-created secrets get this `variant` tag and the engine runs
   * planAutoScope + applyAutoScope against the in-flight `secrets` array so
   * the secret lands in every cell whose env resolves to this variant.
   * Sibling-conflict cells become `variant-skip` actions in the plan.
   */
  defaultVariant?: string;
  onConflict: ImportConflictPolicy;
  dryRun: boolean;
};

export type ImportResult =
  | { ok: true; plan: ImportPlan; next?: VaultDataV4 }
  | { ok: false; reason: "conflict-fail"; plan: ImportPlan };

/**
 * Pure import engine. Reads the repo's `.env.<env>` file, computes a plan
 * (and a candidate `next` VaultData), and returns either:
 *   - `{ ok: true, plan, next? }` — `next` present iff not dryRun
 *   - `{ ok: false, reason: "conflict-fail", plan }` — caller surfaces error
 *
 * Matching strategy (two-pass):
 *   1. Among secrets with the same (key, defaultNamespace), prefer one that:
 *      a. Already owns the target (repoId, env) cell — add scope idempotently.
 *      b. Has the same value AND is not yet scoped to the target cell.
 *   2. If no existing secret matches, create a new secret.
 *
 * `--default-namespace` is a per-import knob: all entries land in the same
 * namespace. Users wanting fine-grained namespace assignment run multiple
 * imports.
 */
export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const entries = dedupeKeepLast(await readEnvFile(opts.repoPath, opts.env));
  const plan: ImportPlan = {
    repoId: opts.repoId,
    repoName: opts.repoName,
    env: opts.env,
    actions: [],
    entriesParsed: entries.length,
  };

  // Work on a mutable copy of secrets so subsequent entries see the effects
  // of earlier ones (e.g. two .env keys mapping to the same vault secret).
  const secrets: Secret[] = opts.data.secrets.map((s) => ({ ...s }));

  for (const e of entries) {
    const normalized = e.key;
    const upper = normalized.toUpperCase();
    const keyParsed = SecretKeySchema.safeParse(upper);
    if (!keyParsed.success) {
      plan.actions.push({ type: "skipped", key: normalized, reason: "invalid-key" });
      continue;
    }
    const key = keyParsed.data;
    if (isDotenvxReservedKey(key)) {
      plan.actions.push({ type: "skipped", key, reason: "dotenvx-reserved" });
      continue;
    }
    const ns = opts.defaultNamespace;

    // Two-pass sibling selection:
    //
    // Pass 1 — prefer a sibling that already owns this (repoId, env) cell.
    //   This is idempotent and always safe.
    const cellOwnerIdx = secrets.findIndex(
      (s) =>
        s.key === key &&
        (s.namespace ?? undefined) === (ns ?? undefined) &&
        s.scopes.some((sc) => sc.repoId === opts.repoId && sc.env === opts.env),
    );

    if (cellOwnerIdx !== -1) {
      // The cell is already owned — treat as scope-existing (idempotent).
      const existing = secrets[cellOwnerIdx]!;
      // Value may differ — apply conflict policy.
      const valueMatches = existing.value === e.value;
      if (valueMatches) {
        // Cell already scoped to this secret with matching value — nothing to do.
        plan.actions.push({
          type: "scope-existing",
          key,
          ...(ns !== undefined ? { namespace: ns } : {}),
          secretId: existing.id,
        });
        continue;
      }
      // Value mismatch against the cell owner.
      if (opts.onConflict === "skip") {
        plan.actions.push({
          type: "skip",
          key,
          ...(ns !== undefined ? { namespace: ns } : {}),
          secretId: existing.id,
        });
        continue;
      }
      if (opts.onConflict === "overwrite") {
        const flavor = classifySecret(e.value);
        secrets[cellOwnerIdx] = { ...existing, value: e.value, flavor };
        plan.actions.push({
          type: "overwrite",
          key,
          ...(ns !== undefined ? { namespace: ns } : {}),
          secretId: existing.id,
        });
        continue;
      }
      // onConflict === "fail"
      plan.actions.push({
        type: "conflict",
        key,
        ...(ns !== undefined ? { namespace: ns } : {}),
      });
      return { ok: false, reason: "conflict-fail", plan };
    }

    // Pass 2 — no existing secret owns this cell yet.
    // Only attach to a sibling with the same (key, ns) when the value matches.
    // Do NOT fall back to any-value sibling — that would trigger conflict
    // resolution on an unrelated secret instead of creating a new one.
    const idx = secrets.findIndex(
      (s) =>
        s.key === key &&
        (s.namespace ?? undefined) === (ns ?? undefined) &&
        s.value === e.value &&
        !s.scopes.some((sc) => sc.repoId === opts.repoId && sc.env === opts.env),
    );

    if (idx === -1) {
      // No existing secret to attach to — create a new one.
      const flavor = classifySecret(e.value);
      let secret: Secret = {
        id: generateSecretId(),
        key,
        value: e.value,
        scopes: [{ repoId: opts.repoId, env: opts.env }],
        flavor,
        ...(ns !== undefined ? { namespace: ns } : {}),
        ...(opts.defaultVariant !== undefined ? { variant: opts.defaultVariant } : {}),
      };

      // When a defaultVariant is set, run planAutoScope against the in-flight
      // next-state so the new secret lands in every cell whose env resolves
      // to the variant — not just the target cell. Sibling-conflict cells
      // become `variant-skip` actions in the plan.
      if (opts.defaultVariant !== undefined) {
        const inFlightData: VaultDataV4 = { ...opts.data, secrets: [...secrets, secret] };
        const autoPlan = planAutoScope(secret, inFlightData);
        secret = applyAutoScope(secret, autoPlan);
        for (const cell of autoPlan) {
          if (cell.action === "skip-sibling-conflict") {
            plan.actions.push({
              type: "variant-skip",
              key,
              ...(ns !== undefined ? { namespace: ns } : {}),
              secretId: secret.id,
              cell: cell.cell,
              ...(cell.siblingId ? { siblingId: cell.siblingId } : {}),
            });
          }
        }
      }
      secrets.push(secret);
      plan.actions.push({
        type: "new-secret",
        key,
        ...(ns !== undefined ? { namespace: ns } : {}),
        secretId: secret.id,
      });
      continue;
    }

    const existing = secrets[idx]!;
    // Value matches (guaranteed by the findIndex predicate above).
    secrets[idx] = ensureScope(existing, opts.repoId, opts.env);
    plan.actions.push({
      type: "scope-existing",
      key,
      ...(ns !== undefined ? { namespace: ns } : {}),
      secretId: existing.id,
    });
  }

  if (opts.dryRun) {
    return { ok: true, plan };
  }
  const next: VaultDataV4 = { ...opts.data, secrets };
  return { ok: true, plan, next };
}

function ensureScope(s: Secret, repoId: string, env: string): Secret {
  if (s.scopes.some((sc) => sc.repoId === repoId && sc.env === env)) {
    return s;
  }
  return { ...s, scopes: [...s.scopes, { repoId, env }] };
}

function dedupeKeepLast(entries: EnvEntry[]): EnvEntry[] {
  // .env semantics: later assignments win.
  // NOTE: when the same key appears multiple times in the same .env file but
  // with *different* values (and no pre-existing vault secret for it), the
  // surviving entry is whichever one last appears in the file. The selected
  // value is then passed to planAutoScope. Callers importing several .env files
  // that redefine the same key may get order-dependent planAutoScope results
  // depending on which import runs first.
  const seen = new Map<string, EnvEntry>();
  for (const e of entries) seen.set(e.key, e);
  return Array.from(seen.values());
}
