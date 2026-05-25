# Secrets Manager — AI Usage Guide

This document is the authoritative guide for AI agents (Claude, Copilot, etc.) working with the secrets-manager toolchain. Read it in full before taking any action.

## What Is This Tool?

Secrets Manager is an AI-driven development tool that stores, scopes, and deploys secrets to repository `.env` files. It runs as a background daemon process and exposes an MCP (Model Context Protocol) server (`sm-mcp`) that AI agents use to manage secrets safely.

It is **not** a runtime credentials proxy. `deploy` writes encrypted `.env.<env>` files locally via `dotenvx`; the workload reads them with `dotenvx run -f .env.<env>` at process start. Plaintext does not transit `sm` at workload runtime.

## Versioning Policy

This project uses a `MAJOR.FEATURE.BUGFIX` scheme (not standard semver):

- **FEATURE** (middle number): bump when a new user-visible feature is added (e.g. `1.0.0` → `1.1.0`).
- **BUGFIX** (last number): bump when a bug is fixed without adding new features (e.g. `1.0.0` → `1.0.1`).
- **MAJOR** (first number): bumped only for breaking or architectural changes — this is a deliberate manual decision, not automatic.

After bumping the version: update the `version` field in `package.json` **and** create a git tag `v<version>` (e.g. `git tag v1.0.0`).

## Golden Rules for AI Agents

1. **Always check `daemon_status` first.** Before calling any other tool, verify the daemon is running. If it is not running, tell the user to start it with `sm-daemon start`.

2. **Always fill in the `description` field when adding a secret.** The description field is not optional in practice — always provide a meaningful description that explains what the secret is, which service uses it, which environment (test or live) it belongs to, and when it should be rotated.

3. **Always call `scope_secret` after `add_secret`.** A secret that has not been scoped to a repo/environment pair will never be deployed. After every `add_secret` call, immediately call `scope_secret` to assign the secret to the correct repo and environment. When you are fanning a secret across more than one environment, pass `envs: [...]` (array) instead of `env: "..."` so it lands in one round-trip. When you are scoping more than 2 secrets or 1 environment, prefer `scope_secrets_bulk` — it returns partial-failure rows so one CONFLICT does not abort the rest.

4. **Repositories can declare any environment names.** Common patterns are `test` + `live`, `development` + `production`, or `local` + `staging` + `production` — whatever the user picks for that repo is what `scope_secret` and `deploy` operate on. Whatever the names, never mix sandbox/test credentials into the env that holds real production credentials. The MCP `add_repo` tool calls the production environment `live` in its descriptions for historical reasons; this is just a naming convention, not a hard requirement.

5. **Only set `namespace` when you need a vault-internal disambiguator.** Namespace is a *vault-internal* field — it lets the vault hold two secrets that share the same key (e.g. a Stripe `API_KEY` and a GitHub `API_KEY`) without colliding. It does **NOT** change the env-var name written to `.env.<env>` — the deployed key is always the bare `KEY`. Do not set a namespace just to label which service a secret belongs to; use the `description` field for that. See issue #79 misuse #4 and issue #78 for the design discussion. Use `set_namespace` with `unset: true` to clear an accidental namespace.

6. **Use `set_tutorial` when the value is unknown.** If a secret needs to be added but you don't have the value yet (e.g. the human must log into a vendor dashboard, paste an OAuth token, or generate a key in a portal), call `set_tutorial` on the key — it **auto-creates an `awaiting_value` placeholder** that `deploy` filters out until the human submits the real value. **Never** write a sentinel string like `__SET_VIA_TUTORIAL__` / `TODO` / `PLACEHOLDER` as the value of `add_secret` — sentinels are not filtered and will ship as garbage.

7. **Deploy to write `.env` files.** After scoping secrets, call `deploy` to write them to the repository `.env` files. Use `dryRun: true` first to preview what will be written before committing to the deploy. **`deploy` writes local files only** — it does not push to Vercel, Fly, Heroku, or any other runtime. The downstream platform must be updated separately (e.g. `vercel env pull` / `flyctl secrets import`).

8. **Rotate secrets proactively.** When a secret is compromised or reaches its rotation deadline (as noted in its description), use `set_value` to rotate it. Update the description to record the new rotation date.

9. **When you set a `variant` on a secret, the daemon auto-scopes it.** `add_secret` with `variant: "test"` (or `"staging"`, `"live"`, etc.) auto-scopes the secret to every `(repo, env)` cell whose env resolves to that variant via the vault's `envVariantMap`. Inspect the response's `skippedVariants` array — non-empty means at least one target cell is already owned by a sibling secret with the same key+namespace but a different variant, and you must decide whether to leave the sibling or replace it. Variants are vault-internal: they affect auto-scoping only and never change the deployed env-var name (always the bare `KEY`). See the "Variants" section for the full model.

## Typical Workflow

```
1. daemon_status               — confirm the daemon is running
2. add_repo                    — register the repository and its environment list
3a. set_tutorial               — for an unknown-value secret: auto-creates
                                 an `awaiting_value` placeholder for the human to fill
3b. add_secret                 — for a known-value secret: provide description
                                 (set namespace ONLY to disambiguate same-keyed secrets in the vault)
4. scope_secret (envs: [...])  — assign to one or more envs in one call
   or scope_secrets_bulk       — for many secrets × many envs at once
5. deploy --dryRun             — preview the .env output
6. deploy                      — write encrypted .env.<env> files locally
```

Step 3 is mutually exclusive: pick (a) for unknown-value secrets, (b) for known-value secrets. Do not call `add_secret` with a placeholder value just to "get it in the vault" — use `set_tutorial` instead.

## Environment Types (convention, not contract)

The MCP `add_repo` tool's description names `test` and `live` as the canonical convention:

- `test` — Used during local development, unit tests, and CI pipelines. May use sandbox API keys. Secrets in this environment should never be real production credentials.
- `live` — Used in production deployments. Secrets here are real credentials and must be rotated on a schedule (see the `description` field of each secret).

Other repos use `development` / `production`, `local` / `staging` / `production`, or any other names — what matters is that *real* credentials never land in a *dev* env and vice versa.

## When to Rotate a Secret

Check the `description` field of each secret. The description should state the rotation schedule. Use `set_value` to update the secret value and then update the description to record the new rotation date. After rotating, always re-deploy so that `.env` files reflect the new values.

## MCP Tool Quick Reference

Grouped by workflow stage. Every tool in `mcp/server.ts` `TOOL_DEFINITIONS` appears here — `tests/docs/tool-mention-parity.test.ts` enforces this invariant.

### Bootstrap

| Tool | Purpose |
|------|---------|
| `daemon_status` | Check that the daemon is running (always call this first) |
| `add_repo` | Register a repo with its environment list (e.g. `test` + `live`) |
| `set_repo_envs` | Replace the environment list for an existing repo |
| `update_repo_path` | Update a repo's on-disk path after `git mv`, worktree move, or directory rename. Scopes and secrets are unchanged. |
| `list_repos` | See all registered repositories |

### Add a secret

| Tool | Purpose |
|------|---------|
| `set_tutorial` | For an unknown-value secret: auto-creates an `awaiting_value` placeholder and attaches step-by-step instructions for the human. Use this — never write a sentinel string as a value. |
| `add_secret` | For a known-value secret: always provide a description. Set `namespace` only when you need to disambiguate two same-keyed secrets in the same vault (it does not change the deployed env-var name). |

### Scope (one or many)

| Tool | Purpose |
|------|---------|
| `scope_secret` | Assign a secret to one or more (`envs: [...]`) repo/environment pairs — always call after add_secret. |
| `scope_secrets_bulk` | Many secrets × many environments × one repo, in one call. Returns partial-failure rows; one CONFLICT does not abort the rest. Prefer this when scoping more than 2 secrets or fanning across more than 1 environment. |
| `unscope_secret` | Remove a secret from a repo/environment |

### Modify

| Tool | Purpose |
|------|---------|
| `set_value` | Rotate a secret value (use when rotating credentials) |
| `set_description` | Update the description without touching the value |
| `set_namespace` | Assign or clear the namespace (a vault-internal disambiguator that does not change the deployed env-var name) — pass `unset: true` to clear |
| `set_variant` | Assign or clear the variant tag on an existing secret. Re-runs auto-scope when set (returns `skippedVariants` on sibling conflicts); preserves existing scopes when unset. The `(key, namespace, variant)` triple identity rule is enforced — if the new triple collides with another secret, `CONFLICT` is returned. Pass `unset: true` to clear. |
| `rename_secret` | Rename a secret key |

### Envs → variant mapping

| Tool | Purpose |
|------|---------|
| `env_variant_list` | List the current envVariantMap (global + per-repo env→variant overrides). |
| `env_variant_set` | Set a global or per-repo env→variant override. Without `repo`, sets a global mapping; with `repo`, sets a per-repo override that wins over the global. |
| `env_variant_unset` | Remove a global or per-repo env→variant override. Clearing every override does NOT disable auto-scoping — the daemon falls back to its built-in default map. |

### Inspect

| Tool | Purpose |
|------|---------|
| `list_secrets` | List secrets, optionally filtered by namespace |
| `describe_secret` | Inspect metadata and fingerprint for a single secret |
| `list_scopes` | See all repo/environment/secret assignments |
| `find_shared` | Find secrets whose values are reused across multiple scopes |

### Deploy

| Tool | Purpose |
|------|---------|
| `deploy` | Write encrypted `.env.<env>` files for scoped secrets. The deployed env-var name is always the bare secret `KEY` (namespaces are vault-internal only and do NOT prefix the deployed key). Use `dryRun: true` first. Writes local files only — does NOT push to Vercel/Fly/Heroku. |

### Destructive

| Tool | Purpose |
|------|---------|
| `remove_secret` | Permanently delete a secret |
| `remove_repo` | Unregister a repository |

## Namespace Conventions

Set a namespace **only when** you need to disambiguate two same-keyed secrets that the vault would otherwise refuse to hold together (e.g. one `API_KEY` for Stripe and another `API_KEY` for SendGrid; one `DATABASE_URL` for app A and another `DATABASE_URL` for app B). The namespace is **not a grouping label** and **does not change the env-var name** written to `.env.<env>` — the deployed key is always the bare `KEY`, regardless of namespace. Examples:

- `namespace: "stripe"` + key `API_KEY` → vault holds it as the "stripe" `API_KEY`; deploys as `API_KEY=...` in `.env.<env>`.
- `namespace: "sendgrid"` + key `API_KEY` → vault holds it as the "sendgrid" `API_KEY`; also deploys as `API_KEY=...` (so don't scope both into the same `(repo, env)` — pick one per cell).

Because namespaces never appear in the deployed file, you cannot use them to make one secret value land under two different env-var names. If you need that, use a separate secret with a different `key`. Use `set_namespace` with `unset: true` to clear an accidental namespace.

When you *do* set a namespace, use lowercase alphanumeric names (regex `^[a-z][a-z0-9]*$`, no hyphens) that match the external service (`stripe`, `sendgrid`, `postgres`, `githuboauth`, `awss3`). These names are internal only; they never appear in the deployed `.env` file.

## Variants

A **variant** is an auto-scoping label (e.g. `test`, `staging`, `live`) attached to a secret that says "I belong in every cell where the environment maps to this variant." It is orthogonal to namespace:

- **Namespace** is a vault-internal disambiguator. It lets the vault hold two secrets that share the same `key`. Setting a namespace does NOT auto-scope.
- **Variant** is an auto-scoping label. Setting a variant on `add_secret` causes the daemon to walk every (repo, env) and auto-place the secret into every cell whose env resolves to that variant via the vault's `envVariantMap`.

Variants enable: "add `STRIPE_KEY` once with `variant: \"test\"`, have it land in every dev/test/local environment across every registered repo, automatically."

The `envVariantMap` ships with sensible defaults on first vault open:

- `development`, `dev`, `local`, `test`, `testing`, `sandbox` → `test`
- `staging`, `stage`, `preview` → `staging`
- `production`, `prod`, `live` → `live`

Use `env_variant_list` to inspect the current map. Use `env_variant_set` to add per-vault or per-repo overrides (e.g. tell repo `frontend` that its `qa` env is a `test` variant). Use `env_variant_unset` to remove overrides.

**Sibling conflict:** if you call `add_secret({ key: "API_KEY", variant: "test" })` and the cell `r1/development` is already occupied by a sibling `(key=API_KEY, same-namespace, variant=live)`, the daemon skips that cell and reports it in the response `skippedVariants` array — `[{ repoId, env, siblingId? }]`. Inspect that array after every variant-bearing `add_secret` call. It is not an error; it means you must decide whether the cell should keep the existing sibling or be re-pointed at the new secret. **The same sibling-check now also applies to manual `scope_secret` / `scope_secrets_bulk`** — attempting to place a variant-bearing secret onto a cell that a different-variant sibling already owns returns `CONFLICT`.

**Variant identity rule:** `(key, namespace, variant)` is a triple. `add_secret` with the same triple as an existing secret returns `CONFLICT`.

**Variants are mutable in place.** Use `set_variant` to change a secret's variant after creation (or clear it with `unset: true`). On set, the daemon re-runs auto-scope against the current `envVariantMap` and reports `skippedVariants` for cells already claimed by a same-key, same-namespace, different-variant sibling. On unset, the variant field is removed but existing scopes are preserved — clear scopes explicitly with `unscope_secret` if you want them gone. The triple identity rule is enforced on every mutation.

**Variant format:** lowercase alphanumeric, must start with a letter, max 32 chars (regex `^[a-z][a-z0-9]*$`). No hyphens. Stricter than namespace.

**Variant is vault-internal:** like namespace, the variant tag never appears in the deployed `.env.<env>` file — the deployed env-var name is always the bare `KEY`. Variant only affects which cells the secret is auto-scoped into; it does not rename the key on disk.

**Empty `envVariantMap` does not disable auto-scoping.** If you `env_variant_unset` every entry until the map is empty, the daemon falls back to its built-in `DEFAULT_ENV_VARIANT_MAP` (development/test/local→test, staging/stage/preview→staging, production/prod/live→live). The `env_variant_unset` response includes a `note` field warning of this fallback whenever the map becomes empty. To stop a single secret from auto-scoping, clear its variant via `set_variant` with `unset: true` rather than emptying the map.

## Common Mistakes to Avoid

- **Skipping `daemon_status`** — the daemon may not be running, causing every subsequent call to fail.
- **Forgetting to call `scope_secret` after `add_secret`** — the secret will be stored but never deployed.
- **Leaving the `description` blank** — this makes it impossible to know what the secret is for or when to rotate it.
- **Writing a placeholder sentinel** (`__SET_VIA_TUTORIAL__`, `TODO`, `FIXME`, `PLACEHOLDER`) as the value of `add_secret` — sentinels are not filtered and ship as garbage. Call `set_tutorial` instead; it auto-creates an `awaiting_value` placeholder that `deploy` filters out.
- **Setting a `namespace` just to label which service a secret belongs to** — namespaces are vault-internal disambiguators, not grouping labels. They never appear in the deployed env-var name. Use the `description` field for service labelling, and leave `namespace` unset unless you genuinely need to hold two same-keyed secrets in the vault.
- **Confusing variant with namespace** — namespace is a vault-internal disambiguator that lets two secrets share a key; variant is an auto-scoping label tied to env classification. Setting a namespace does NOT auto-scope, and setting a variant does NOT let two secrets share a key (you still need different namespaces if the keys collide). Both can be set on the same secret independently.
- **Calling `scope_secret` N times when `scope_secrets_bulk` does it in one call** — bulk has partial-failure semantics so one CONFLICT does not abort the rest. Also remember `scope_secret` itself accepts `envs: [...]` for the single-secret × many-envs case.
- **Calling `scope_secret` to land a variant-bearing secret on a cell already owned by a sibling** — manual scope now runs the variant sibling-check and rejects with `CONFLICT` when a same-key, same-namespace, different-variant sibling already occupies the target cell. Use `set_variant` to change the existing sibling, or `unscope_secret` the sibling first.
- **Assuming `deploy` ships to Vercel/Fly/Heroku** — it does NOT. It writes encrypted local `.env.<env>` files via dotenvx; the workload reads them with `dotenvx run`. Push or sync to the runtime deploy target separately.
- **Deploying to `live` (or whatever the prod env is called) without first deploying to `test`** — always preview with `dryRun: true` and exercise the dev env first.
- **Reusing the same secret value across `test` and `live`** — use `find_shared` to detect this.

## Why MCP, not CLI?

You may have access to both the `sm-mcp` MCP server and the `sm` CLI. Both reach the same daemon and produce identical encrypted `.env.<env>` files — the safety properties (no plaintext on the wire, vault encrypted at rest, master password held only by the daemon) are the same on both surfaces.

The difference is **workflow scaffolding**:

- The MCP server renders rich descriptions into your context (description-required, scope-after-add, dryRun-before-deploy, namespace-is-vault-internal warnings — see issue #79). You see these the moment the MCP tool list loads.
- The CLI has no in-context way to teach you the workflow. `sm --help` is a flat verb list. CLAUDE.md is not loaded into your context unless your harness happens to include it.

**Prefer `sm-mcp` whenever it is available.** Only fall back to the `sm` CLI when MCP is not configured in the host. When you do use the CLI, replicate the Golden Rules above by hand (daemon_status first, description on every add, scope after add, dryRun before deploy).

## CLI Fallback (Appendix) — Mapping MCP Tools to `sm` Verbs

If you must call the `sm` CLI directly, use this map. Every CLI verb hits the same daemon handler as the MCP tool, so the safety properties are identical — but the workflow guardrails above are your responsibility.

| MCP tool              | CLI equivalent                                                          |
|-----------------------|-------------------------------------------------------------------------|
| `daemon_status`       | `sm-daemon status` (or `sm daemon-status`)                              |
| `add_repo`            | `sm add-repo --name N --path P --env E [--env E ...]`                   |
| `set_repo_envs`       | `sm set-repo-envs <id\|name> --env E [--env E ...]`                     |
| `update_repo_path`    | `sm update-repo-path <repo> <path>`                                     |
| `list_repos`          | `sm list-repos`                                                         |
| `remove_repo`         | `sm remove-repo <id\|name>`                                             |
| `add_secret`          | `sm add-secret --key K --description "..." [--namespace N] [--variant V] --value-from-file PATH` |
| `set_tutorial`        | (no CLI equivalent — MCP-only; auto-creates an `awaiting_value` placeholder for unknown-value secrets) |
| `scope_secret`        | `sm scope <secret> --repo R --env E [--env E ...]` (multiple `--env` fans out in one call) |
| `scope_secrets_bulk`  | (no CLI equivalent — MCP-only; call `sm scope` per secret instead, or prefer MCP) |
| `unscope_secret`      | `sm unscope <secret> --repo R --env E`                                  |
| `list_secrets`        | `sm list-secrets [--namespace NS]`                                      |
| `describe_secret`     | `sm describe-secret <key\|id>`                                          |
| `set_value`           | `sm set-value <secret> --value-from-file PATH`                          |
| `set_description`     | `sm set-description <secret> --description "..."` |
| `set_namespace`       | `sm set-namespace <secret> --namespace NS` (or `--unset`)               |
| `set_variant`         | `sm set-variant <secret> --variant V` (or `--unset`)                    |
| `env_variant_list`    | `sm env-variant list`                                                   |
| `env_variant_set`     | `sm env-variant set --env ENV --variant V [--repo REPO]`                |
| `env_variant_unset`   | `sm env-variant unset --env ENV [--repo REPO]`                          |
| `rename_secret`       | `sm rename-secret <secret> --new-key NEW`                               |
| `deploy`              | `sm deploy [--repo R] [--env E] [--dry-run]` — **always** run with `--dry-run` first |
| `find_shared`         | `sm find-shared [--min-length N]`                                       |
| `list_scopes`         | `sm list-scopes`                                                        |
| `remove_secret`       | `sm remove-secret <id\|key>`                                            |

**This tool is not a runtime proxy.** It writes encrypted `.env.<env>` files; your workload reads them via `dotenvx run`. Plaintext never transits `sm` at workload runtime.
