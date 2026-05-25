/**
 * MCP server module.
 *
 * Exports:
 *   - McpToolResult  — the canonical return type for every MCP tool call.
 *   - createMcpServer — factory that wires up an MCP server backed by the
 *                       daemon IPC channel (used by the sm-mcp binary).
 *
 * The server itself is thin: all business logic lives in mcp/tools/index.ts.
 * This file only owns the transport-level wiring and the shared type.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type McpToolContent = { type: "text"; text: string };

/**
 * Return value for every tool handler, following the MCP specification:
 *   https://spec.modelcontextprotocol.io/specification/server/tools/
 */
export type McpToolResult = {
  content: McpToolContent[];
  isError?: boolean;
};

/**
 * Build a success McpToolResult from an arbitrary JSON-serialisable payload.
 * Wraps JSON.stringify in a try/catch so that circular references or BigInt
 * values return an error result instead of throwing.
 */
export function okResult(payload: unknown): McpToolResult {
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (e) {
    return errorResult(
      `Failed to serialise response: ${(e as Error).message ?? String(e)}`,
    );
  }
}

/**
 * Build an error McpToolResult from a human-readable message.
 */
export function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Shared JSON Schema fragments — referenced by both add_secret and set_tutorial
// to avoid duplication and ensure consistent constraints.
// ---------------------------------------------------------------------------
const TUTORIAL_STEP_SCHEMA = {
  type: "object" as const,
  properties: {
    order: { type: "integer", minimum: 0 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    body: { type: "string", minLength: 1, maxLength: 2000 },
    link: { type: "string", format: "uri" },
  },
  required: ["order", "title", "body"],
};

const TUTORIAL_SCHEMA = {
  type: "object" as const,
  properties: {
    steps: {
      type: "array" as const,
      items: TUTORIAL_STEP_SCHEMA,
      minItems: 1,
      maxItems: 20,
    },
    createdAt: { type: "string", description: "ISO 8601 datetime string (e.g. 2025-01-15T12:00:00.000Z)" },
    mayBeStale: { type: "boolean" },
    authorAgent: { type: "string", maxLength: 100 },
  },
  required: ["steps", "createdAt"],
};

// ---------------------------------------------------------------------------
// Tool definitions — kept here so both the server wiring and the test suite
// can reference them without importing the full tool registry.
// ---------------------------------------------------------------------------
export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "daemon_status",
    description: "Check whether the secrets-manager daemon is running.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description: "Include socketPath in the response (default: false).",
        },
      },
    },
  },
  {
    name: "list_repos",
    description: "List all registered repositories.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_secrets",
    description: "List secrets (metadata only, never values). Optionally filter by namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description: "Filter by namespace (lowercase alphanumeric only, no hyphens (regex ^[a-z][a-z0-9]*$)).",
        },
      },
    },
  },
  {
    name: "list_scopes",
    description: "List all scope assignments (which secrets are available to which repo/env pairs).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "describe_secret",
    description: "Describe a single secret by id or key. Returns metadata and valueFingerprint, never the plaintext value.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Secret id or key name." },
      },
      required: ["id"],
    },
  },
  {
    name: "find_shared",
    description: "Find secrets whose values are shared across multiple scopes.",
    inputSchema: {
      type: "object",
      properties: {
        minLength: {
          type: "integer",
          description: "Minimum value length to consider (default: 8).",
        },
      },
    },
  },
  {
    name: "add_repo",
    description: "Register a new repository.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        path: { type: "string", description: "Absolute filesystem path to the repo root." },
        environments: {
          type: "array",
          items: { type: "string" },
          description: "Non-empty list of environment names for this repo. Include both test and live environments (e.g. [\"test\", \"live\"]).",
        },
      },
      required: ["name", "path", "environments"],
    },
  },
  {
    name: "remove_repo",
    description: "Remove a registered repository by id or name.",
    inputSchema: {
      type: "object",
      properties: {
        // Canonical key is `target`; `id` is accepted as a backward-compat alias.
        target: { type: "string", description: "Repo id or name (canonical)." },
        id: { type: "string", description: "Alias for target (deprecated)." },
      },
    },
  },
  {
    name: "set_repo_envs",
    description: "Replace the environment list for a repository.",
    inputSchema: {
      type: "object",
      properties: {
        // Canonical key is `target`; `id` is accepted as a backward-compat alias.
        target: { type: "string", description: "Repo id or name (canonical)." },
        id: { type: "string", description: "Alias for target (deprecated)." },
        // Canonical key is `environments`; `envs` is accepted as a backward-compat alias.
        environments: {
          type: "array",
          items: { type: "string" },
          description: "New environment list (canonical).",
        },
        envs: {
          type: "array",
          items: { type: "string" },
          description: "Alias for environments (deprecated).",
        },
      },
    },
  },
  {
    name: "update_repo_path",
    description:
      "Update a repository's on-disk path without disturbing its scopes or secrets. " +
      "Call after a `git mv`, worktree move, or directory rename. " +
      "Canonical key is `target` (repo id or name); `id` is accepted as a backward-compat alias. " +
      "`path` must be absolute (start with /). The new path is NOT required to exist on disk — " +
      "this is intentional so a repo can be re-pointed before the workload exists locally. " +
      "Scopes and secrets remain intact; only the recorded path changes. " +
      "Note: any .env.<env> files already written under the OLD path are left in place; " +
      "no redeploy is triggered. Run `deploy` again after updating the path if you want the " +
      "new location populated.",
    inputSchema: {
      type: "object",
      properties: {
        // Canonical key is `target`; `id` is accepted as a backward-compat alias.
        target: { type: "string", description: "Repo id or name (canonical)." },
        id: { type: "string", description: "Alias for target (deprecated)." },
        path: {
          type: "string",
          description: "New absolute filesystem path. Must start with /. The path does NOT need to exist on disk.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "scope_secret",
    description:
      "Assign a secret to one or more repo/environment pairs. " +
      "ALWAYS call this after add_secret — a secret that is not scoped will never be deployed. " +
      "Use `env` (string) for a single environment (backward compatible), " +
      "or `envs` (array of strings) to fan out to multiple environments in one call. " +
      "Exactly one of `env` or `envs` must be provided. " +
      "If you are scoping more than 2 secrets, prefer `scope_secrets_bulk` — one round-trip with partial-failure semantics. For one secret fanning across multiple environments, `envs:` is sufficient.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        repo: { type: "string", description: "Repo id or name." },
        env: {
          type: "string",
          description: "Environment name (single env, backward compatible). Mutually exclusive with `envs`.",
        },
        envs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "List of environment names to scope to in one batch call. Mutually exclusive with `env`.",
        },
      },
      required: ["secret", "repo"],
    },
  },
  {
    name: "scope_secrets_bulk",
    description: "Assign multiple secrets to a repo across multiple environments in one call. Uses partial-failure semantics — rows that fail (conflict, not found, etc.) are reported in results without aborting the rest.",
    inputSchema: {
      type: "object",
      properties: {
        secrets: {
          type: "array",
          items: { type: "string" },
          description: "Non-empty list of secret ids or keys.",
        },
        repo: { type: "string", description: "Repo id or name." },
        envs: {
          type: "array",
          items: { type: "string" },
          description: "Non-empty list of environment names.",
        },
      },
      required: ["secrets", "repo", "envs"],
    },
  },
  {
    name: "unscope_secret",
    description: "Remove a secret from a repo/environment pair.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        repo: { type: "string", description: "Repo id or name." },
        env: { type: "string", description: "Environment name." },
      },
      required: ["secret", "repo", "env"],
    },
  },
  {
    name: "set_namespace",
    description: "Set or clear the namespace for a secret. The namespace is a vault-internal disambiguator only — it lets the vault hold two secrets that share the same key without colliding. It does NOT change the env-var name written to .env files at deploy time; the deployed key is always the bare key.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        namespace: {
          type: "string",
          description: "New namespace (lowercase alphanumeric only, no hyphens (regex ^[a-z][a-z0-9]*$)).",
        },
        unset: { type: "boolean", description: "Pass true to clear the namespace." },
      },
      required: ["secret"],
    },
  },
  {
    name: "set_variant",
    description:
      "Set or clear the variant on an existing secret. Setting a variant re-runs auto-scoping against the vault's envVariantMap so the secret lands in every (repo, env) cell that resolves to the new variant — and reports any cells skipped because a sibling secret (same key+namespace, different variant) already owns them in `skippedVariants`. Unsetting the variant preserves existing scopes (call `unscope_secret` explicitly if you need to remove them). The (key, namespace, variant) triple must remain unique across the vault — collisions return CONFLICT. Like namespace, variant is vault-internal: it never changes the env-var name written to .env files at deploy time.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        variant: {
          type: "string",
          description:
            "New variant (lowercase alphanumeric, must start with a letter, max 32 chars (regex ^[a-z][a-z0-9]*$)). Mutually exclusive with `unset`.",
        },
        unset: { type: "boolean", description: "Pass true to clear the variant. Mutually exclusive with `variant`." },
      },
      required: ["secret"],
    },
  },
  {
    name: "env_variant_list",
    description:
      "List the vault's current envVariantMap (global env→variant mappings plus any per-repo overrides). " +
      "The map is what `add_secret`'s `variant` field consults at auto-scope time — `variant: \"test\"` on a secret will auto-scope to every (repo, env) where this map resolves env → \"test\". " +
      "Use this before set/unset to see the current state, including the V2→V3 default map injected on first vault open (development/test/local → test, staging/stage/preview → staging, production/prod/live → live).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "env_variant_set",
    description:
      "Set a global or per-repo env→variant override. Without `repo`, sets a global override (applies to every repo unless overridden). With `repo`, sets a per-repo override that wins over the global. " +
      "Variant must be lowercase alphanumeric, start with a letter, max 32 chars (regex /^[a-z][a-z0-9]*$/). " +
      "Example: env_variant_set({ env: \"qa\", variant: \"test\" }) makes any repo with a `qa` environment auto-scope `variant: \"test\"` secrets into the qa cell. " +
      "Returns NOT_FOUND if `repo` is provided but doesn't match a registered repo id.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name to map (e.g. \"qa\", \"preview\")." },
        variant: { type: "string", description: "Variant to map it to (e.g. \"test\", \"staging\", \"live\")." },
        repo: { type: "string", description: "Optional repo id; if omitted, sets a global override." },
      },
      required: ["env", "variant"],
    },
  },
  {
    name: "env_variant_unset",
    description:
      "Remove a global or per-repo env→variant override. Without `repo`, removes the global override; with `repo`, removes only the per-repo override (the global mapping for that env, if any, remains in effect). " +
      "Removing the last per-repo override for a repo cleans up the repo entry entirely so the map doesn't accumulate tombstones. " +
      "Warning: clearing every override does NOT disable auto-scoping — the daemon falls back to its built-in default map when the override map is empty. To stop a secret from auto-scoping, clear the secret's variant via `set_variant` with `unset: true` rather than zeroing the env map.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name whose override to remove." },
        repo: { type: "string", description: "Optional repo id; if omitted, removes the global override." },
      },
      required: ["env"],
    },
  },
  {
    name: "rename_secret",
    description: "Rename a secret key.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or current key." },
        newKey: {
          type: "string",
          description: "New key name (must match /^[A-Z_][A-Z0-9_]*$/).",
        },
      },
      required: ["secret", "newKey"],
    },
  },
  {
    name: "add_secret",
    description: "Add a new secret with a known final plaintext value. The value is read from a temp file (valuePath) and the file is deleted after the daemon reads it. valuePath must hold the final, real plaintext — never write placeholder/sentinel strings like TODO, __SET__, PLACEHOLDER, __SET_VIA_TUTORIAL__ here. If you do not yet have the value, call set_tutorial instead — it auto-creates an awaiting_value placeholder that deploy filters out.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Secret key name (must match /^[A-Z_][A-Z0-9_]*$/).",
        },
        namespace: { type: "string", description: "Optional namespace — a vault-internal disambiguator only. Use it when you want to add a second secret with the same key (e.g. STRIPE_API_KEY and GITHUB_API_KEY both stored as key=API_KEY, namespaces=stripe/github). The namespace does NOT appear in the deployed env-var name; on deploy the secret is written as KEY." },
        variant: {
          type: "string",
          description:
            "Optional variant tag (lowercase letters/digits, must start with a letter, max 32 chars; regex /^[a-z][a-z0-9]*$/). " +
            "When set, the daemon auto-scopes this secret to every (repo, env) cell whose env resolves to this variant via the vault's envVariantMap. " +
            "Cells already owned by a sibling secret with the same key+namespace but a different variant are skipped and returned in the response `skippedVariants` array. " +
            "Variant differs from namespace: namespace is a vault-internal disambiguator that lets two secrets share a key; variant is an auto-scoping label tied to env-classification (e.g. \"test\", \"staging\", \"live\"). " +
            "Setting both is allowed and orthogonal.",
        },
        description: {
          type: "string",
          description: "ALWAYS provide this — include what the secret is, which service uses it, whether it is for test or live, and when to rotate it. Max 500 chars.",
        },
        valuePath: {
          type: "string",
          description: "Absolute path to a temporary file containing the plaintext value. Must be inside the system temp directory.",
        },
        tutorial: {
          ...TUTORIAL_SCHEMA,
          description: "Optional tutorial instructions for the human user to follow to obtain this secret. Only attach a tutorial when the human must fetch the value from an external service (vendor dashboard, vendor portal, OAuth screen). Do NOT attach for values generated locally (openssl rand), policy/config strings (AUTH_TRUST_HOST=true, allow-lists, sender addresses) — use set_description for those.",
        },
      },
      required: ["key", "valuePath", "description"],
    },
  },
  {
    name: "set_value",
    description: "Update the value of an existing secret. The plaintext value is read from a temp file (valuePath) and the file is deleted after the daemon reads it.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        valuePath: {
          type: "string",
          description: "Absolute path to a temporary file containing the new plaintext value. Must be inside the system temp directory.",
        },
        description: {
          type: "string",
          description: "Optional new description (max 500 chars). Pass empty string \"\" to clear.",
        },
      },
      required: ["secret", "valuePath"],
    },
  },
  {
    name: "set_description",
    description: "Set or clear the description field of an existing secret without touching its value. Safe for MCP-only callers that cannot supply a valuePath.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        description: {
          type: "string",
          description: "New description (max 500 chars). Pass empty string \"\" to clear the existing description.",
        },
        unset: {
          type: "boolean",
          description: "Pass true to clear the description (equivalent to description: \"\").",
        },
      },
      required: ["secret"],
    },
  },
  {
    name: "set_tutorial",
    description: "Attach step-by-step tutorial instructions to a secret so the human user can follow them in the GUI to obtain the value. If the key does not yet exist, this auto-creates an awaiting_value placeholder — the canonical way for an agent to register a needed-but-unknown secret. Deploy skips placeholders until either set_value or add_secret lands the real value (both upsert into the placeholder). Pass unset:true to remove a previously attached tutorial.",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Secret id or key." },
        tutorial: {
          ...TUTORIAL_SCHEMA,
          description: "Tutorial object with steps, createdAt, and optional fields. Only attach a tutorial when the human must fetch the value from an external service (vendor dashboard, vendor portal, OAuth screen). Do NOT attach for values generated locally (openssl rand), policy/config strings (AUTH_TRUST_HOST=true, allow-lists, sender addresses) — use set_description for those.",
        },
        unset: { type: "boolean", description: "Pass true to remove the tutorial from the secret." },
        description: {
          type: "string",
          description: "Always required when attaching a tutorial (exempt only when unset:true). Include what the secret is, which service uses it, whether it is for test or live, and when to rotate it. Max 500 chars.",
        },
      },
      required: ["secret"],
    },
  },
  {
    name: "remove_secret",
    description: "Permanently delete a secret.",
    inputSchema: {
      type: "object",
      properties: {
        // Canonical key is `target`; `id` is accepted as a backward-compat alias.
        target: { type: "string", description: "Secret id or key (canonical)." },
        id: { type: "string", description: "Alias for target (deprecated)." },
      },
    },
  },
  {
    name: "deploy",
    description: "Deploy secrets to repo .env files. OUTPUT: dotenvx-encrypted files — values are encrypted with the repo public key and safe to commit to git. After deploy, run: git add .env.<env> && git commit && git push. Do NOT run vercel env add / flyctl secrets set / heroku config:set — the encrypted .env.<env> IS the artifact; workloads read it via dotenvx run. Pass dryRun:true to preview without writing. The env-var name written to .env.<env> is always the bare secret key — namespaces are internal-only and do not prefix the deployed key.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Preview only; do not write files." },
        repo: { type: "string", description: "Limit to a specific repo id or name." },
        env: { type: "string", description: "Limit to a specific environment." },
        timeoutMs: {
          type: "integer",
          description: "Timeout in milliseconds for the deploy operation (default: 60000).",
        },
      },
    },
  },
];

/**
 * The names of every registered tool, used for dynamic error messages.
 */
export const TOOL_NAMES: string[] = TOOL_DEFINITIONS.map((t) => t.name);

type CreateMcpServerOpts = {
  /** Path to the daemon Unix socket. */
  socketPath: string;
  /** MCP server name, reported to clients. Defaults to "secrets-manager". */
  serverName?: string;
  /** MCP server version. Defaults to "0.1.0". */
  serverVersion?: string;
};

type CreateMcpServerResult = {
  /** The configured MCP Server instance (not yet connected to a transport). */
  server: Server;
  /** The list of tool definitions to advertise via tools/list. */
  toolDefs: Tool[];
};

/**
 * Factory that creates and configures an MCP Server backed by the daemon IPC
 * channel. The caller is responsible for connecting the server to a transport
 * (e.g. StdioServerTransport) and registering the request handlers.
 *
 * @example
 * ```ts
 * const { server, toolDefs } = createMcpServer({ socketPath: '/tmp/sm.sock' });
 * server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));
 * server.setRequestHandler(CallToolRequestSchema, async (req) => { ... });
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createMcpServer(opts: CreateMcpServerOpts): CreateMcpServerResult {
  const {
    serverName = "secrets-manager",
    serverVersion = "0.1.0",
  } = opts;

  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } },
  );

  return { server, toolDefs: TOOL_DEFINITIONS };
}
