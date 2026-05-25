/**
 * MCP tool registry.
 *
 * Exports `callTool(name, args, opts)` — the single entry point used by the
 * MCP server and the integration test suite.
 *
 * Every tool maps to one daemon IPC command via `sendCommand`. The layer's
 * only job beyond routing is:
 *   1. Validate that required arguments are present and correctly typed.
 *   2. Pass through to the daemon and translate the daemon response into an
 *      McpToolResult (JSON payload in a text content block).
 *   3. NEVER emit any `value` field or plaintext secret in the response.
 *
 * Security invariant implementation:
 *   - All daemon responses (including read commands) are passed through
 *     `scrubSecretFields` before being returned, which recursively removes
 *     any field named `value`. This is a defensive measure — the daemon
 *     already strips `value` from read responses, but we double-check here.
 *   - For add-secret / set-value the daemon reads the temp file itself and
 *     also never echoes the value back; callers pass `valuePath` straight
 *     through to the daemon.
 *   - `valuePath` is validated to ensure it points inside the OS temp
 *     directory, preventing path-traversal / prompt-injection attacks.
 */

import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sendCommand } from "../../lib/cli/ipc-client";
import type { DaemonResponse } from "../../lib/daemon/protocol";
import { errorResult, okResult, TOOL_NAMES } from "../server";
import type { McpToolResult } from "../server";
import { TutorialSchema } from "../../lib/vault/schema";
import { formatZodError } from "../../lib/vault/zod-format";
import { isDotenvxReservedKey } from "../../lib/vault/sentinel";

// McpToolResult is exported from mcp/server; we do NOT re-export it here
// to avoid confusion about the canonical source.
type CallToolOpts = {
  socketPath: string;
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Namespace format: lowercase letters, digits, and hyphens; must not be empty.
 * This matches the convention used throughout the daemon.
 */
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate a namespace string. Returns an error message if invalid, or null if
 * the value is acceptable.
 */
function validateNamespace(ns: unknown): string | null {
  if (typeof ns !== "string") {
    return "`namespace` must be a string";
  }
  if (!NAMESPACE_RE.test(ns)) {
    return "`namespace` must be lowercase alphanumeric with optional hyphens (e.g. \"stripe\", \"my-service\")";
  }
  return null;
}

/**
 * Variant format: must start with a lowercase letter, followed by lowercase
 * letters/digits only, max 32 chars. Matches lib/vault/schema.ts VariantSchema.
 * Note: this regex is STRICTER than NAMESPACE_RE — variant disallows leading
 * digits and hyphens. Do not collapse the two validators.
 */
const VARIANT_RE = /^[a-z][a-z0-9]*$/;

function validateVariant(v: unknown): string | null {
  if (typeof v !== "string") {
    return "`variant` must be a string";
  }
  if (v.length === 0 || v.length > 32) {
    return "`variant` must be 1-32 characters";
  }
  if (!VARIANT_RE.test(v)) {
    return "`variant` must start with a lowercase letter and contain only lowercase letters/digits (regex /^[a-z][a-z0-9]*$/, no hyphens, max 32 chars)";
  }
  return null;
}

/**
 * Validate that `valuePath` is an absolute path inside the system temp
 * directory. This prevents prompt-injection or AI-supplied paths from reading
 * sensitive files like /etc/passwd or ~/.ssh/id_rsa.
 *
 * Uses `fs.realpath()` to dereference symlinks before checking, so a symlink
 * pointing outside the temp directory is correctly rejected.
 *
 * Returns an error message if invalid, null if the path is acceptable.
 */
async function validateValuePath(p: unknown): Promise<string | null> {
  if (typeof p !== "string" || p.length === 0) {
    return "`valuePath` must be a non-empty string";
  }
  if (!path.isAbsolute(p)) {
    return "`valuePath` must be an absolute path";
  }
  // Resolve symlinks to get the real path, then check it is inside tmpdir.
  // If realpath() fails, the file is missing or unreadable — reject rather
  // than fall back to path.resolve(), which does NOT dereference symlinks
  // and would let a /tmp/x → /etc/passwd link slip past the tmpdir check.
  let resolved: string;
  try {
    resolved = await realpath(p);
  } catch {
    return "`valuePath` must point to an existing readable file (realpath failed)";
  }
  // Canonicalize tmpdir too — on macOS, tmpdir() returns /var/folders/... but
  // that's a symlink to /private/var/folders/..., so a realpath()'d input
  // would never match startsWith() against the un-resolved tmpdir.
  let tmp: string;
  try {
    tmp = await realpath(tmpdir());
  } catch {
    tmp = tmpdir();
  }
  // The resolved path must be inside the OS temp directory.
  if (!resolved.startsWith(tmp + path.sep) && resolved !== tmp) {
    return (
      `\`valuePath\` must point to a file inside the system temp directory (${tmp}). ` +
      `Got: ${resolved}. Supply a path returned by a prior tmpFile / sentinelFile call.`
    );
  }
  return null;
}

/**
 * Validate that all elements of an array are strings.
 * Returns an error message if any element is not a string, null otherwise.
 */
function validateStringArray(arr: unknown[], fieldName: string): string | null {
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string") {
      return `\`${fieldName}[${i}]\` must be a string, got ${typeof arr[i]}`;
    }
  }
  return null;
}

/**
 * Validate a description string for MCP callers.
 * Returns an error message if invalid, or null if acceptable.
 */
function validateDescription(desc: unknown): string | null {
  if (desc === undefined || desc === null) {
    return "`description` is required — include what the secret is, which service uses it, whether it is for test or live, and when to rotate it (max 500 chars)";
  }
  if (typeof desc !== "string") {
    return "`description` must be a string";
  }
  if (desc.length === 0) {
    return "`description` must not be empty";
  }
  if (desc.length > 500) {
    return "`description` must be 500 characters or fewer";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Security scrubber — removes any field named `value` at any depth.
// Applied defensively to ALL daemon responses before they leave this layer.
// ---------------------------------------------------------------------------
function scrubSecretFields(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrubSecretFields);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "value") continue; // ← strip plaintext secret value
      out[k] = scrubSecretFields(v);
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Internal helper — send a daemon command and translate to McpToolResult.
// Applies scrubSecretFields to all successful responses.
// ---------------------------------------------------------------------------
async function dispatch(
  cmd: string,
  args: Record<string, unknown>,
  socketPath: string,
): Promise<McpToolResult> {
  let resp: DaemonResponse;
  try {
    resp = await sendCommand({ cmd, args }, { socketPathOverride: socketPath });
  } catch (e) {
    return errorResult(
      `Failed to contact daemon: ${(e as Error).message ?? String(e)}`,
    );
  }

  if (!resp.ok) {
    return errorResult(`${resp.code}: ${resp.message}`);
  }

  // Strip the `ok` boolean before serialising — callers only care about the
  // payload fields.
  const { ok: _ok, ...payload } = resp as { ok: true } & Record<string, unknown>;
  // Defensively scrub any `value` field from the payload before returning.
  const scrubbed = scrubSecretFields(payload);
  return okResult(scrubbed);
}

// ---------------------------------------------------------------------------
// callTool — the public entry point.
// ---------------------------------------------------------------------------
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  opts: CallToolOpts,
): Promise<McpToolResult> {
  const { socketPath } = opts;

  switch (name) {
    // ── Read surface ────────────────────────────────────────────────────────

    case "daemon_status": {
      let resp: DaemonResponse;
      try {
        resp = await sendCommand(
          { cmd: "status", args: {} },
          { socketPathOverride: socketPath },
        );
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const locked = code === "ENOENT" || code === "ECONNREFUSED";
        return okResult({ running: false, locked, reason: (e as Error).message ?? String(e) });
      }
      if (!resp.ok) {
        // DAEMON_LOCKED means the socket doesn't exist / refused connection —
        // return a structured "not running" response rather than an error.
        if (resp.code === "DAEMON_LOCKED") {
          return okResult({ running: false, locked: true, reason: resp.message ?? "Daemon locked" });
        }
        return errorResult(`${resp.code}: ${resp.message}`);
      }
      const { ok: _ok, ...rest } = resp as { ok: true } & Record<string, unknown>;
      // Only include socketPath when verbose:true is explicitly requested.
      // Scrub any secret fields from the status response defensively.
      const payload: Record<string, unknown> = { running: true, ...rest };
      if (args.verbose === true) {
        payload.socketPath = socketPath;
      }
      const scrubbed = scrubSecretFields(payload) as Record<string, unknown>;
      if (scrubbed.running === true) {
        scrubbed.workflow =
          "Deploy: git add .env.<env> && git commit && git push. " +
          "dotenvx-encrypted — safe to commit. " +
          "Do NOT use vercel env add / flyctl secrets set.";
      }
      return okResult(scrubbed);
    }

    case "list_repos":
      // dispatch applies scrubSecretFields defensively.
      return dispatch("list-repos", {}, socketPath);

    case "list_secrets": {
      const daemonArgs: Record<string, unknown> = {};
      if (args.namespace !== undefined) {
        // Validate namespace format before forwarding to the daemon.
        const nsErr = validateNamespace(args.namespace);
        if (nsErr !== null) return errorResult(nsErr);
        daemonArgs.namespace = args.namespace;
      }
      // dispatch applies scrubSecretFields defensively.
      return dispatch("list-secrets", daemonArgs, socketPath);
    }

    case "list_scopes":
      // dispatch applies scrubSecretFields defensively.
      return dispatch("list-scopes", {}, socketPath);

    case "describe_secret": {
      if (typeof args.id !== "string" || args.id.length === 0) {
        return errorResult("`id` (secret id or key) is required");
      }
      // dispatch applies scrubSecretFields defensively.
      return dispatch("describe-secret", { id: args.id }, socketPath);
    }

    case "find_shared": {
      const daemonArgs: Record<string, unknown> = {};
      if (args.minLength !== undefined) {
        // Validate minLength is a positive integer.
        if (
          typeof args.minLength !== "number" ||
          !Number.isInteger(args.minLength) ||
          args.minLength < 1
        ) {
          return errorResult("`minLength` must be a positive integer");
        }
        daemonArgs.minLength = args.minLength;
      }
      // dispatch applies scrubSecretFields defensively.
      return dispatch("find-shared", daemonArgs, socketPath);
    }

    // ── Repo CRUD ────────────────────────────────────────────────────────────

    case "add_repo": {
      if (typeof args.name !== "string" || args.name.length === 0) {
        return errorResult("`name` is required");
      }
      if (typeof args.path !== "string" || args.path.length === 0) {
        return errorResult("`path` is required");
      }
      if (!Array.isArray(args.environments) || args.environments.length === 0) {
        return errorResult("`environments` (non-empty array) is required");
      }
      // Validate that every element in the environments array is a string.
      const envStrErr = validateStringArray(args.environments, "environments");
      if (envStrErr !== null) return errorResult(envStrErr);

      return dispatch(
        "add-repo",
        { name: args.name, path: args.path, environments: args.environments },
        socketPath,
      );
    }

    case "remove_repo": {
      // Canonical key: `target`. Backward-compat alias: `id`.
      // Prefer `target`; fall back to `id` if only the alias was supplied.
      const target = args.target ?? args.id;
      if (typeof target !== "string" || target.length === 0) {
        return errorResult("`target` (repo id or name) is required");
      }
      return dispatch("remove-repo", { target }, socketPath);
    }

    case "set_repo_envs": {
      // Canonical key: `target`. Backward-compat alias: `id`.
      // Prefer `target`; fall back to `id` if only the alias was supplied.
      const target = args.target ?? args.id;
      if (typeof target !== "string" || target.length === 0) {
        return errorResult("`target` (repo id or name) is required");
      }
      // Canonical key: `environments`. Backward-compat alias: `envs`.
      // Prefer `environments`; fall back to `envs` if only the alias was supplied.
      const envs = args.environments ?? args.envs;
      if (!Array.isArray(envs) || envs.length === 0) {
        return errorResult("`environments` (non-empty array) is required");
      }
      // Validate that every element in the environments array is a string.
      const envStrErr = validateStringArray(envs, "environments");
      if (envStrErr !== null) return errorResult(envStrErr);

      return dispatch(
        "set-repo-envs",
        { target, environments: envs },
        socketPath,
      );
    }

    case "update_repo_path": {
      // Canonical key: `target`. Backward-compat alias: `id`.
      // Prefer `target`; fall back to `id` if only the alias was supplied.
      const target = args.target ?? args.id;
      if (typeof target !== "string" || target.length === 0) {
        return errorResult("`target` (repo id or name) is required");
      }
      if (typeof args.path !== "string" || args.path.length === 0) {
        return errorResult("`path` is required");
      }
      // Trim before validating so leading/trailing whitespace does not reject
      // an otherwise-valid absolute path. The daemon handler also trims, so
      // the trimmed value is what eventually lands in the vault.
      const trimmedPath = args.path.trim();
      if (trimmedPath.length === 0) {
        return errorResult("`path` is required");
      }
      // Use path.isAbsolute() to mirror how the rest of this file validates
      // absolute paths (see validateValuePath above).
      if (!path.isAbsolute(trimmedPath)) {
        return errorResult("`path` must be absolute (start with /)");
      }
      if (trimmedPath.includes("\0")) {
        return errorResult("`path` must not contain null bytes");
      }
      // The daemon handler accepts `target` (canonical) with `repo` as a
      // backward-compat alias for the CLI; pass `target` straight through to
      // match the peer dispatchers (`remove_repo`, `set_repo_envs`).
      return dispatch(
        "update-repo-path",
        { target, path: trimmedPath },
        socketPath,
      );
    }

    // ── Secret mutations ─────────────────────────────────────────────────────

    case "scope_secret": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      if (typeof args.repo !== "string" || args.repo.length === 0) {
        return errorResult("`repo` (id or name) is required");
      }

      // Accept `envs` (array) OR `env` (singular, backward-compat), but never both.
      const hasEnv = args.env !== undefined;
      const hasEnvs = args.envs !== undefined;

      if (hasEnv && hasEnvs) {
        return errorResult(
          "provide either `env` (string) or `envs` (array), not both",
        );
      }
      if (!hasEnv && !hasEnvs) {
        return errorResult(
          "either `env` (string) or `envs` (non-empty array) is required",
        );
      }

      if (hasEnvs) {
        if (!Array.isArray(args.envs) || args.envs.length === 0) {
          return errorResult("`envs` must be a non-empty array of strings");
        }
        const envStrErr = validateStringArray(args.envs, "envs");
        if (envStrErr !== null) return errorResult(envStrErr);
        return dispatch(
          "scope",
          { secret: args.secret, repo: args.repo, envs: args.envs },
          socketPath,
        );
      }

      // Single env path (backward compat)
      if (typeof args.env !== "string" || args.env.length === 0) {
        return errorResult("`env` must be a non-empty string");
      }
      return dispatch(
        "scope",
        { secret: args.secret, repo: args.repo, env: args.env },
        socketPath,
      );
    }

    case "scope_secrets_bulk": {
      // Validate secrets array.
      if (!Array.isArray(args.secrets) || args.secrets.length === 0) {
        return errorResult("`secrets` (non-empty array of ids or keys) is required");
      }
      const secretsStrErr = validateStringArray(args.secrets, "secrets");
      if (secretsStrErr !== null) return errorResult(secretsStrErr);

      // Validate repo.
      if (typeof args.repo !== "string" || args.repo.length === 0) {
        return errorResult("`repo` (id or name) is required");
      }

      // Validate envs array.
      if (!Array.isArray(args.envs) || args.envs.length === 0) {
        return errorResult("`envs` (non-empty array) is required");
      }
      const envsStrErr = validateStringArray(args.envs, "envs");
      if (envsStrErr !== null) return errorResult(envsStrErr);

      return dispatch(
        "scope-bulk",
        { secrets: args.secrets, repo: args.repo, envs: args.envs },
        socketPath,
      );
    }

    case "unscope_secret": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      if (typeof args.repo !== "string" || args.repo.length === 0) {
        return errorResult("`repo` (id or name) is required");
      }
      if (typeof args.env !== "string" || args.env.length === 0) {
        return errorResult("`env` is required");
      }
      return dispatch(
        "unscope",
        { secret: args.secret, repo: args.repo, env: args.env },
        socketPath,
      );
    }

    case "set_namespace": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      const daemonArgs: Record<string, unknown> = { secret: args.secret };
      if (args.unset === true) {
        daemonArgs.unset = true;
      } else {
        if (args.namespace === undefined) {
          return errorResult("either `namespace` or `unset: true` is required");
        }
        // Validate namespace format.
        const nsErr = validateNamespace(args.namespace);
        if (nsErr !== null) return errorResult(nsErr);
        daemonArgs.namespace = args.namespace;
      }
      return dispatch("set-namespace", daemonArgs, socketPath);
    }

    case "set_variant": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      const daemonArgs: Record<string, unknown> = { secret: args.secret };
      if (args.unset === true) {
        if (args.variant !== undefined) {
          return errorResult("cannot specify both `variant` and `unset`");
        }
        daemonArgs.unset = true;
      } else {
        if (args.variant === undefined) {
          return errorResult("either `variant` or `unset: true` is required");
        }
        // Client-side variant validation for a clean error before IPC.
        const vErr = validateVariant(args.variant);
        if (vErr !== null) return errorResult(vErr);
        daemonArgs.variant = args.variant as string;
      }
      return dispatch("set-variant", daemonArgs, socketPath);
    }

    case "env_variant_list": {
      // No args; daemon returns { envVariantMap }.
      return dispatch("env-variant-list", {}, socketPath);
    }

    case "env_variant_set": {
      if (typeof args.env !== "string" || args.env.length === 0) {
        return errorResult("`env` is required");
      }
      // Client-side variant validation for a clean error message before IPC.
      const vErr = validateVariant(args.variant);
      if (vErr !== null) return errorResult(vErr);
      const daemonArgs: Record<string, unknown> = {
        env: args.env,
        variant: args.variant as string,
      };
      if (args.repo !== undefined) {
        if (typeof args.repo !== "string" || args.repo.length === 0) {
          return errorResult("`repo` must be a non-empty string if provided");
        }
        daemonArgs.repo = args.repo;
      }
      return dispatch("env-variant-set", daemonArgs, socketPath);
    }

    case "env_variant_unset": {
      if (typeof args.env !== "string" || args.env.length === 0) {
        return errorResult("`env` is required");
      }
      const daemonArgs: Record<string, unknown> = { env: args.env };
      if (args.repo !== undefined) {
        if (typeof args.repo !== "string" || args.repo.length === 0) {
          return errorResult("`repo` must be a non-empty string if provided");
        }
        daemonArgs.repo = args.repo;
      }
      return dispatch("env-variant-unset", daemonArgs, socketPath);
    }

    case "rename_secret": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      if (typeof args.newKey !== "string" || args.newKey.length === 0) {
        return errorResult("`newKey` is required");
      }
      if (isDotenvxReservedKey(args.newKey)) {
        return errorResult(
          `"${args.newKey}" is a dotenvx-internal key (matches DOTENV_(PUBLIC|PRIVATE)_KEY_*) and must not be stored in the vault.`,
        );
      }
      return dispatch(
        "rename-secret",
        { secret: args.secret, newKey: args.newKey },
        socketPath,
      );
    }

    case "add_secret": {
      if (typeof args.key !== "string" || args.key.length === 0) {
        return errorResult("`key` is required");
      }
      // Validate key format before hitting the daemon so we get a clean error.
      if (!/^[A-Z_][A-Z0-9_]*$/.test(args.key)) {
        return errorResult(
          "`key` must match /^[A-Z_][A-Z0-9_]*$/ (uppercase only)",
        );
      }
      if (isDotenvxReservedKey(args.key)) {
        return errorResult(
          `"${args.key}" is a dotenvx-internal key (matches DOTENV_(PUBLIC|PRIVATE)_KEY_*) and must not be stored in the vault.`,
        );
      }
      // Validate valuePath to prevent path-traversal attacks (including symlinks).
      const vpErr = await validateValuePath(args.valuePath);
      if (vpErr !== null) return errorResult(vpErr);

      const daemonArgs: Record<string, unknown> = {
        key: args.key,
        valuePath: args.valuePath,
      };
      if (args.namespace !== undefined) {
        // Validate namespace format.
        const nsErr = validateNamespace(args.namespace);
        if (nsErr !== null) return errorResult(nsErr);
        daemonArgs.namespace = args.namespace;
      }
      if (args.variant !== undefined) {
        const vErr = validateVariant(args.variant);
        if (vErr !== null) return errorResult(vErr);
        daemonArgs.variant = args.variant as string;
      }
      const descErr = validateDescription(args.description);
      if (descErr !== null) return errorResult(descErr);
      daemonArgs.description = args.description as string;
      if (args.tutorial !== undefined) {
        const parsed = TutorialSchema.safeParse(args.tutorial);
        if (!parsed.success) {
          return errorResult(`invalid tutorial: ${formatZodError(parsed.error)}`);
        }
        daemonArgs.tutorial = parsed.data;
      }
      return dispatch("add-secret", daemonArgs, socketPath);
    }

    case "set_value": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      // Validate valuePath to prevent path-traversal attacks (including symlinks).
      const vpErr = await validateValuePath(args.valuePath);
      if (vpErr !== null) return errorResult(vpErr);

      const daemonArgs: Record<string, unknown> = {
        secret: args.secret,
        valuePath: args.valuePath,
      };
      if (args.description !== undefined) {
        if (typeof args.description !== "string") {
          return errorResult("`description` must be a string");
        }
        if (args.description.length > 500) {
          return errorResult("`description` must be 500 characters or fewer");
        }
        daemonArgs.description = args.description;
      }
      return dispatch("set-value", daemonArgs, socketPath);
    }

    case "set_description": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      if (args.unset === true && args.description !== undefined) {
        return errorResult("provide either `description` or `unset: true`, not both");
      }
      let description: string;
      if (args.unset === true) {
        description = "";
      } else if (args.description !== undefined) {
        if (typeof args.description !== "string") {
          return errorResult("`description` must be a string");
        }
        if (args.description.length > 500) {
          return errorResult("`description` must be 500 characters or fewer");
        }
        description = args.description;
      } else {
        return errorResult("either `description` or `unset: true` is required");
      }
      return dispatch("set-description", { secret: args.secret, description }, socketPath);
    }

    case "set_tutorial": {
      if (typeof args.secret !== "string" || args.secret.length === 0) {
        return errorResult("`secret` (id or key) is required");
      }
      if (args.unset === true && args.tutorial !== undefined) {
        return errorResult("provide either `tutorial` or `unset: true`, not both");
      }
      // Description is not required for unset — no data is being created.
      if (args.unset === true) {
        return dispatch("set-tutorial", { secret: args.secret, unset: true }, socketPath);
      }
      if (args.tutorial === undefined) {
        return errorResult("either `tutorial` or `unset: true` is required");
      }
      const parsed = TutorialSchema.safeParse(args.tutorial);
      if (!parsed.success) {
        return errorResult(`invalid tutorial: ${formatZodError(parsed.error)}`);
      }
      const descErr = validateDescription(args.description);
      if (descErr !== null) return errorResult(descErr);
      return dispatch("set-tutorial", { secret: args.secret, tutorial: parsed.data, description: args.description as string }, socketPath);
    }

    case "remove_secret": {
      // Canonical key: `target`. Backward-compat alias: `id`.
      // Prefer `target`; fall back to `id` if only the alias was supplied.
      const target = args.target ?? args.id;
      if (typeof target !== "string" || target.length === 0) {
        return errorResult("`target` (secret id or key) is required");
      }
      return dispatch("remove-secret", { target }, socketPath);
    }

    // ── Deploy ───────────────────────────────────────────────────────────────

    case "deploy": {
      const daemonArgs: Record<string, unknown> = {};
      if (args.dryRun === true) daemonArgs.dryRun = true;
      if (typeof args.repo === "string" && args.repo.length > 0)
        daemonArgs.repo = args.repo;
      if (typeof args.env === "string" && args.env.length > 0)
        daemonArgs.env = args.env;

      // Configurable timeout for deploy (default: 60 s, documented here).
      const DEFAULT_DEPLOY_TIMEOUT_MS = 60_000;
      let timeoutMs = DEFAULT_DEPLOY_TIMEOUT_MS;
      if (args.timeoutMs !== undefined) {
        if (
          typeof args.timeoutMs !== "number" ||
          !Number.isInteger(args.timeoutMs) ||
          args.timeoutMs < 1
        ) {
          return errorResult("`timeoutMs` must be a positive integer");
        }
        timeoutMs = args.timeoutMs;
      }

      let resp: DaemonResponse;
      try {
        resp = await sendCommand(
          { cmd: "deploy", args: daemonArgs },
          { socketPathOverride: socketPath, timeoutMs },
        );
      } catch (e) {
        return errorResult(
          `Failed to contact daemon: ${(e as Error).message ?? String(e)}`,
        );
      }

      if (!resp.ok) {
        return errorResult(`${resp.code}: ${resp.message}`);
      }

      const { ok: _ok, ...payload } = resp as { ok: true } & Record<string, unknown>;
      // Scrub any stray `value` fields from deploy plan entries.
      const scrubbed = scrubSecretFields(payload);
      return okResult(scrubbed);
    }

    // ── Unknown tool ─────────────────────────────────────────────────────────

    default:
      // Generate the tool list dynamically to avoid it drifting from TOOL_NAMES.
      return errorResult(
        `Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(", ")}`,
      );
  }
}
