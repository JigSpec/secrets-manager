"use server";

import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  getSessionId,
  getVaultData,
  getSessionPassword,
  lock,
  persistVaultData,
} from "@/lib/vault/session";
import {
  decryptDroppedVault,
  applyVaultMerge,
} from "@/lib/import/vault-drop";
import {
  type Repo,
  type Secret,
  type Scope,
  type VaultData,
  type VaultDataV4,
  type EnvVariantMap,
  VariantSchema,
} from "@/lib/vault/schema";
import { planAutoScope, applyAutoScope } from "@/lib/vault/variant/auto-scope";
import { DEFAULT_ENV_VARIANT_MAP } from "@/lib/vault/variant/resolve";
import { runDeploy, targetsForRepo } from "@/lib/vault/deploy/run-deploy";
import {
  toDeployTargetResult,
  type DeployTargetResult,
} from "@/lib/vault/deploy/result-projection";
import { existsSync, statSync } from "node:fs";
import { isSentinelValue } from "@/lib/vault/sentinel";

export type { DeployTargetResult } from "@/lib/vault/deploy/result-projection";
import { classifySecret } from "@/lib/vault/classify";
import { sendCommand } from "@/lib/cli/ipc-client";
import {
  DEFAULT_IDLE_TTL_MIN,
  MAX_IDLE_TTL_MIN,
  MIN_IDLE_TTL_MIN,
  clampTtlMin,
  loadDaemonConfig,
  saveDaemonConfig,
} from "@/lib/daemon/config";

function newId(): string {
  return randomBytes(8).toString("hex");
}

async function requireVault(): Promise<VaultData> {
  const data = await getVaultData();
  if (!data) {
    redirect("/unlock");
  }
  return data;
}

const EnvName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, {
    message: "Env names must start with a letter and use [A-Za-z0-9_-]",
  });

const RepoInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  path: z
    .string()
    .trim()
    .min(1, "Path is required")
    .refine((p) => p.startsWith("/"), {
      message: "Path must be absolute (start with /)",
    }),
  environments: z
    .array(EnvName)
    .min(1, "At least one environment is required"),
});

const SecretInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Key is required")
    .regex(/^[A-Z_][A-Z0-9_]*$/, {
      message: "Key must match [A-Z_][A-Z0-9_]*",
    }),
  value: z.string(),
  namespace: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9]*$/, {
      message: "Namespace must match [a-z][a-z0-9]*",
    })
    .min(1)
    .max(32)
    .optional(),
  variant: VariantSchema.optional(),
  description: z.string().min(1).max(500).optional(),
});

function isVariantCapable(data: VaultData): data is VaultDataV4 {
  return data.version >= 3;
}

export type ActionResult<T = VaultData> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Variant-aware action result: like ActionResult, but also carries the
 * `skippedVariants` array reported by planAutoScope for cells that could
 * not be auto-scoped because a sibling secret with the same (key, namespace)
 * but a different variant already occupies them.
 *
 * The GUI uses this to toast a warning on add/update so the operator knows
 * a cell was intentionally skipped (not silently dropped).
 */
export type SecretActionResult =
  | {
      ok: true;
      data: VaultData;
      /** Cells skipped during auto-scope due to sibling conflict. Empty array if none. */
      skippedVariants: { repoId: string; env: string; siblingId?: string }[];
    }
  | { ok: false; error: string };

async function commit(next: VaultData): Promise<ActionResult<VaultData>> {
  await persistVaultData(next);
  return { ok: true, data: next };
}

export async function lockAction(): Promise<void> {
  await lock();
  redirect("/unlock");
}

// ----- Repo CRUD -----

export async function addRepoAction(input: {
  name: string;
  path: string;
  environments: string[];
}): Promise<ActionResult> {
  const parsed = RepoInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, path, environments } = parsed.data;
  if (!existsSync(path)) {
    return { ok: false, error: `Path does not exist: ${path}` };
  }
  try {
    if (!statSync(path).isDirectory()) {
      return { ok: false, error: `Path is not a directory: ${path}` };
    }
  } catch {
    return { ok: false, error: `Path is not accessible: ${path}` };
  }
  const data = await requireVault();
  if (data.repos.some((r) => r.path === path)) {
    return { ok: false, error: "A repo with that path is already registered." };
  }
  const repo: Repo = {
    id: newId(),
    name,
    path,
    environments: Array.from(new Set(environments)),
  };
  return commit({ ...data, repos: [...data.repos, repo] });
}

export async function updateRepoAction(input: {
  id: string;
  name: string;
  path: string;
  environments: string[];
}): Promise<ActionResult> {
  const parsed = RepoInputSchema.safeParse({
    name: input.name,
    path: input.path,
    environments: input.environments,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = await requireVault();
  const idx = data.repos.findIndex((r) => r.id === input.id);
  if (idx === -1) return { ok: false, error: "Repo not found." };
  if (!existsSync(parsed.data.path)) {
    return { ok: false, error: `Path does not exist: ${parsed.data.path}` };
  }
  if (
    data.repos.some(
      (r) => r.id !== input.id && r.path === parsed.data.path,
    )
  ) {
    return { ok: false, error: "Another repo already uses that path." };
  }
  const updated: Repo = {
    id: input.id,
    name: parsed.data.name,
    path: parsed.data.path,
    environments: Array.from(new Set(parsed.data.environments)),
  };
  const allowedEnvs = new Set(updated.environments);
  const secrets: Secret[] = data.secrets.map((s) => ({
    ...s,
    scopes: s.scopes.filter(
      (sc) => sc.repoId !== input.id || allowedEnvs.has(sc.env),
    ),
  }));
  const repos = [...data.repos];
  repos[idx] = updated;
  return commit({ ...data, repos, secrets });
}

export async function deleteRepoAction(id: string): Promise<ActionResult> {
  const data = await requireVault();
  const repos = data.repos.filter((r) => r.id !== id);
  if (repos.length === data.repos.length) {
    return { ok: false, error: "Repo not found." };
  }
  const secrets: Secret[] = data.secrets.map((s) => ({
    ...s,
    scopes: s.scopes.filter((sc) => sc.repoId !== id),
  }));
  return commit({ ...data, repos, secrets });
}

// ----- Secret CRUD -----

export async function addSecretAction(input: {
  key: string;
  value: string;
  namespace?: string;
  variant?: string;
  description?: string;
}): Promise<SecretActionResult> {
  const parsed = SecretInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (isSentinelValue(parsed.data.value)) {
    return { ok: false, error: "value appears to be a placeholder — store the real secret value" };
  }
  const data = await requireVault();
  // Identity rule: (key, namespace, variant) triple must be unique.
  if (
    data.secrets.some(
      (s) =>
        s.key === parsed.data.key &&
        (s.namespace ?? null) === (parsed.data.namespace ?? null) &&
        (s.variant ?? null) === (parsed.data.variant ?? null),
    )
  ) {
    const label = formatSecretLabel(parsed.data);
    return { ok: false, error: `Secret "${label}" already exists.` };
  }
  let secret: Secret = {
    id: newId(),
    key: parsed.data.key,
    value: parsed.data.value,
    ...(parsed.data.namespace ? { namespace: parsed.data.namespace } : {}),
    ...(parsed.data.variant ? { variant: parsed.data.variant } : {}),
    scopes: [],
    ...(parsed.data.description !== undefined && parsed.data.description !== "" ? { description: parsed.data.description } : {}),
  };
  // Variant-aware auto-scoping mirrors the daemon's add-secret handler so GUI
  // users get the same cell distribution as CLI/MCP callers.
  let skippedVariants: { repoId: string; env: string; siblingId?: string }[] = [];
  if (parsed.data.variant !== undefined && isVariantCapable(data)) {
    const plan = planAutoScope(secret, data);
    secret = applyAutoScope(secret, plan);
    skippedVariants = plan
      .filter((c): c is Extract<typeof c, { action: "skip-sibling-conflict" }> =>
        c.action === "skip-sibling-conflict",
      )
      .map((c) => ({
        repoId: c.cell.repoId,
        env: c.cell.env,
        ...(c.siblingId !== undefined ? { siblingId: c.siblingId } : {}),
      }));
  }
  const next: VaultData = { ...data, secrets: [...data.secrets, secret] };
  await persistVaultData(next);
  return { ok: true, data: next, skippedVariants };
}

function formatSecretLabel(s: { key: string; namespace?: string; variant?: string }): string {
  const parts: string[] = [];
  if (s.namespace) parts.push(`[${s.namespace}]`);
  parts.push(s.key);
  if (s.variant) parts.push(`{${s.variant}}`);
  return parts.join(" ");
}

export async function updateSecretAction(input: {
  id: string;
  key: string;
  value: string;
  namespace?: string;
  variant?: string;
  description?: string;
}): Promise<SecretActionResult> {
  const parsed = SecretInputSchema.safeParse({
    key: input.key,
    value: input.value,
    namespace: input.namespace,
    variant: input.variant,
    description: input.description,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (isSentinelValue(parsed.data.value)) {
    return { ok: false, error: "value appears to be a placeholder — store the real secret value" };
  }
  const data = await requireVault();
  const idx = data.secrets.findIndex((s) => s.id === input.id);
  if (idx === -1) return { ok: false, error: "Secret not found." };
  // Identity rule: (key, namespace, variant) triple must remain unique.
  if (
    data.secrets.some(
      (s) =>
        s.id !== input.id &&
        s.key === parsed.data.key &&
        (s.namespace ?? null) === (parsed.data.namespace ?? null) &&
        (s.variant ?? null) === (parsed.data.variant ?? null),
    )
  ) {
    const label = formatSecretLabel(parsed.data);
    return { ok: false, error: `Another secret already uses key "${label}".` };
  }
  const prev = data.secrets[idx]!;
  let updated: Secret = {
    ...prev,
    key: parsed.data.key,
    value: parsed.data.value,
  };
  if (parsed.data.namespace) {
    updated.namespace = parsed.data.namespace;
  } else {
    delete updated.namespace;
  }
  if (parsed.data.variant) {
    updated.variant = parsed.data.variant;
  } else {
    delete updated.variant;
  }
  if (parsed.data.description !== undefined) {
    if (parsed.data.description === "") {
      delete updated.description;
    } else {
      updated.description = parsed.data.description;
    }
  }
  // Variant-aware re-auto-scope: if the user changed the variant (or set one
  // for the first time), mirror add-secret/set-variant behaviour and walk the
  // (repo, env) grid to add any missing variant cells. Existing scopes are
  // preserved by planAutoScope (it filters out cells the secret already has).
  // Sibling conflicts surface as skippedVariants so the GUI can toast.
  let skippedVariants: { repoId: string; env: string; siblingId?: string }[] = [];
  if (parsed.data.variant !== undefined && isVariantCapable(data)) {
    // Build a candidate vault-state that excludes the secret-under-edit so
    // sibling-check doesn't false-positive against the secret's own prior row.
    const candidateData: VaultDataV4 = {
      ...data,
      secrets: data.secrets.map((s) => (s.id === input.id ? updated : s)),
    };
    const plan = planAutoScope(updated, candidateData);
    updated = applyAutoScope(updated, plan);
    skippedVariants = plan
      .filter((c): c is Extract<typeof c, { action: "skip-sibling-conflict" }> =>
        c.action === "skip-sibling-conflict",
      )
      .map((c) => ({
        repoId: c.cell.repoId,
        env: c.cell.env,
        ...(c.siblingId !== undefined ? { siblingId: c.siblingId } : {}),
      }));
  }
  const secrets = [...data.secrets];
  secrets[idx] = updated;
  const next: VaultData = { ...data, secrets };
  await persistVaultData(next);
  return { ok: true, data: next, skippedVariants };
}

export async function deleteSecretAction(id: string): Promise<ActionResult> {
  const data = await requireVault();
  const secrets = data.secrets.filter((s) => s.id !== id);
  if (secrets.length === data.secrets.length) {
    return { ok: false, error: "Secret not found." };
  }
  return commit({ ...data, secrets });
}

// ----- envVariantMap CRUD -----

export type EnvVariantMapView = {
  envVariantMap: EnvVariantMap;
  defaults: Readonly<Record<string, string>>;
};

export async function envVariantListAction(): Promise<
  ActionResult<EnvVariantMapView>
> {
  const data = await requireVault();
  if (!isVariantCapable(data)) {
    return {
      ok: false,
      error: "Vault must be upgraded to support env→variant mapping.",
    };
  }
  return {
    ok: true,
    data: { envVariantMap: data.envVariantMap, defaults: DEFAULT_ENV_VARIANT_MAP },
  };
}

export async function envVariantSetAction(input: {
  env: string;
  variant: string;
  repo?: string;
}): Promise<ActionResult<EnvVariantMapView>> {
  if (typeof input.env !== "string" || input.env.length === 0) {
    return { ok: false, error: "Env name is required." };
  }
  const envParsed = EnvName.safeParse(input.env);
  if (!envParsed.success) {
    return { ok: false, error: envParsed.error.issues[0]?.message ?? "Invalid env name." };
  }
  const variantParsed = VariantSchema.safeParse(input.variant);
  if (!variantParsed.success) {
    return {
      ok: false,
      error: "Variant must match [a-z][a-z0-9]* (max 32 chars).",
    };
  }
  const data = await requireVault();
  if (!isVariantCapable(data)) {
    return {
      ok: false,
      error: "Vault must be upgraded to support env→variant mapping.",
    };
  }
  const existing = data.envVariantMap;
  let next: EnvVariantMap;
  if (typeof input.repo === "string" && input.repo.length > 0) {
    if (!data.repos.some((r) => r.id === input.repo)) {
      return { ok: false, error: `Repo "${input.repo}" not found.` };
    }
    const repoOverrides = {
      ...(existing.repos[input.repo] ?? {}),
      [envParsed.data]: variantParsed.data,
    };
    next = {
      ...existing,
      repos: { ...existing.repos, [input.repo]: repoOverrides },
    };
  } else {
    next = {
      ...existing,
      global: { ...existing.global, [envParsed.data]: variantParsed.data },
    };
  }
  await persistVaultData({ ...data, envVariantMap: next });
  return {
    ok: true,
    data: { envVariantMap: next, defaults: DEFAULT_ENV_VARIANT_MAP },
  };
}

export async function envVariantUnsetAction(input: {
  env: string;
  repo?: string;
}): Promise<ActionResult<EnvVariantMapView>> {
  if (typeof input.env !== "string" || input.env.length === 0) {
    return { ok: false, error: "Env name is required." };
  }
  const data = await requireVault();
  if (!isVariantCapable(data)) {
    return {
      ok: false,
      error: "Vault must be upgraded to support env→variant mapping.",
    };
  }
  const existing = data.envVariantMap;
  let next: EnvVariantMap;
  if (typeof input.repo === "string" && input.repo.length > 0) {
    const repoOverrides = { ...(existing.repos[input.repo] ?? {}) };
    delete repoOverrides[input.env];
    const repos = { ...existing.repos };
    if (Object.keys(repoOverrides).length === 0) {
      delete repos[input.repo];
    } else {
      repos[input.repo] = repoOverrides;
    }
    next = { ...existing, repos };
  } else {
    const global = { ...existing.global };
    delete global[input.env];
    next = { ...existing, global };
  }
  await persistVaultData({ ...data, envVariantMap: next });
  return {
    ok: true,
    data: { envVariantMap: next, defaults: DEFAULT_ENV_VARIANT_MAP },
  };
}

export async function toggleScopeAction(input: {
  secretId: string;
  repoId: string;
  env: string;
  next: boolean;
}): Promise<ActionResult> {
  const data = await requireVault();
  const secret = data.secrets.find((s) => s.id === input.secretId);
  if (!secret) return { ok: false, error: "Secret not found." };
  const repo = data.repos.find((r) => r.id === input.repoId);
  if (!repo) return { ok: false, error: "Repo not found." };
  if (!repo.environments.includes(input.env)) {
    return { ok: false, error: `Env "${input.env}" is not configured for this repo.` };
  }

  const has = secret.scopes.some(
    (sc) => sc.repoId === input.repoId && sc.env === input.env,
  );
  let scopes: Scope[];
  if (input.next && !has) {
    scopes = [...secret.scopes, { repoId: input.repoId, env: input.env }];
  } else if (!input.next && has) {
    scopes = secret.scopes.filter(
      (sc) => !(sc.repoId === input.repoId && sc.env === input.env),
    );
  } else {
    scopes = secret.scopes;
  }

  const updated: Secret = { ...secret, scopes };
  const secrets = data.secrets.map((s) =>
    s.id === input.secretId ? updated : s,
  );
  return commit({ ...data, secrets });
}

// ----- Set Secret Value (Issue #64: Needs Your Attention) -----

export async function setSecretValueAction(
  id: string,
  value: string,
): Promise<ActionResult<VaultData>> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: false, error: "Value must not be empty." };
  }
  const data = await requireVault();
  const idx = data.secrets.findIndex((s) => s.id === id);
  if (idx === -1) {
    return { ok: false, error: "Secret not found." };
  }
  const prev = data.secrets[idx]!;
  // status is intentionally stripped once a real value is provided
  const { status: _status, ...secretWithoutStatus } = prev;
  const flavor = classifySecret(trimmed);
  const updated: Secret = {
    ...secretWithoutStatus,
    value: trimmed,
    flavor,
  };
  const secrets = [...data.secrets];
  secrets[idx] = updated;
  return commit({ ...data, secrets });
}

// ----- Deploy -----

export async function deployAllAction(): Promise<
  ActionResult<{ results: DeployTargetResult[] }>
> {
  const data = await requireVault();
  const raw = await runDeploy({ data, dryRun: false });
  return { ok: true, data: { results: raw.map(toDeployTargetResult) } };
}

export async function deployRepoAction(
  repoId: string,
): Promise<ActionResult<{ results: DeployTargetResult[] }>> {
  if (typeof repoId !== "string" || repoId.length === 0) {
    return { ok: false, error: "repoId is required." };
  }
  const data = await requireVault();
  const repo = data.repos.find((r) => r.id === repoId);
  if (!repo) {
    return { ok: false, error: "Repo not found." };
  }
  const targets = targetsForRepo(data, repoId);
  const raw = await runDeploy({ data, targets, dryRun: false });
  return { ok: true, data: { results: raw.map(toDeployTargetResult) } };
}

// expose for diagnostics
export async function getSessionIdAction(): Promise<string | null> {
  return getSessionId();
}

// ----- Vault drop import -----

/**
 * Import a dropped .enc vault file by decrypting it with the current session
 * password and merging it into the active vault using the "skip" conflict policy
 * (new secrets are added; existing secrets are left unchanged).
 *
 * @param content  Raw string content of the dropped .enc file.
 * @returns        The merged VaultData on success, or an error message.
 */
export async function importDroppedVaultAction(
  content: string,
): Promise<ActionResult<VaultData>> {
  const password = await getSessionPassword();
  if (!password) {
    return { ok: false, error: "Session is not unlocked." };
  }
  const current = await requireVault();
  let incoming: VaultData;
  try {
    incoming = await decryptDroppedVault(content, password);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Failed to decrypt vault file: ${message}` };
  }
  const { vault } = applyVaultMerge(current, incoming, "skip");
  return commit(vault);
}

// ----- Daemon idle-TTL controls -----

export type DaemonTtlInfo = {
  /** TTL currently in effect on the running daemon, in minutes. Null if daemon is locked. */
  liveMinutes: number | null;
  /** TTL persisted in the daemon config file, in minutes. Null if no override is saved. */
  savedMinutes: number | null;
  /** The fallback default TTL, in minutes. */
  defaultMinutes: number;
  /** Min/max accepted by the validator. */
  minMinutes: number;
  maxMinutes: number;
  /** True if the daemon responded to status — otherwise it's locked. */
  daemonRunning: boolean;
};

export async function getDaemonTtlInfoAction(): Promise<DaemonTtlInfo> {
  const cfg = await loadDaemonConfig();
  const status = await sendCommand({ cmd: "status" }, { timeoutMs: 2_000 });
  const rawTtl = status.ok
    ? (status as unknown as { idleTtlMs?: unknown }).idleTtlMs
    : null;
  const live =
    typeof rawTtl === "number" && Number.isFinite(rawTtl)
      ? Math.round(rawTtl / 60_000)
      : null;
  return {
    liveMinutes: live,
    savedMinutes: cfg.idleTtlMin ?? null,
    defaultMinutes: DEFAULT_IDLE_TTL_MIN,
    minMinutes: MIN_IDLE_TTL_MIN,
    maxMinutes: MAX_IDLE_TTL_MIN,
    daemonRunning: status.ok,
  };
}

export type SetDaemonTtlResult =
  | {
      ok: true;
      minutes: number;
      /** "live" if the running daemon was updated; "saved" if only the on-disk config was changed. */
      applied: "live" | "saved";
    }
  | { ok: false; error: string };

export async function setDaemonIdleTtlAction(
  minutes: number,
): Promise<SetDaemonTtlResult> {
  if (
    typeof minutes !== "number" ||
    !Number.isFinite(minutes) ||
    minutes < MIN_IDLE_TTL_MIN ||
    minutes > MAX_IDLE_TTL_MIN
  ) {
    return {
      ok: false,
      error: `Minutes must be between ${MIN_IDLE_TTL_MIN} and ${MAX_IDLE_TTL_MIN}.`,
    };
  }
  const clamped = clampTtlMin(minutes);

  // Prefer the IPC path: the handler persists the config and re-arms the
  // running idle timer in one shot.
  const resp = await sendCommand(
    { cmd: "set-idle-ttl", args: { minutes: clamped } },
    { timeoutMs: 3_000 },
  );
  if (resp.ok) {
    return { ok: true, minutes: clamped, applied: "live" };
  }
  // Daemon not running — persist directly so the value takes effect on next start.
  if (resp.code === "DAEMON_LOCKED") {
    try {
      const existing = await loadDaemonConfig();
      await saveDaemonConfig({ ...existing, idleTtlMin: clamped });
      return { ok: true, minutes: clamped, applied: "saved" };
    } catch (e) {
      return {
        ok: false,
        error: `Failed to write daemon config: ${(e as Error).message ?? String(e)}`,
      };
    }
  }
  return { ok: false, error: resp.message };
}
