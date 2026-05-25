---
name: secrets-manager
description: Authoritative guide for using the secrets-manager toolchain (sm-mcp, sm CLI, sm-daemon) to safely store, scope, and deploy secrets to repository .env files. Invoke this whenever the user mentions secrets, credentials, API keys, env vars for a project, .env files, dotenv, dotenvx, secret rotation, deploying or syncing env vars to a repo, scoping secrets to repos/environments, or whenever any `mcp__secrets-manager__*` tool is available or referenced. Also use when the user says things like "how do I store a secret", "I need to add an env var", "rotate my Stripe key", "set up secrets-manager", or when a `daemon_status` / `add_secret` / `scope_secret` / `deploy` call needs to happen. Prefer triggering — undertriggering produces wrong workflows (sentinel-string placeholders, missing scopes, namespace-as-grouping mistakes, deploys that fail silently, secrets that ship to the wrong env).
---

# secrets-manager

Secrets Manager (`sm`) stores, scopes, and deploys secrets to repository `.env.<env>` files. A local daemon holds the master password in memory; an MCP server (`sm-mcp`, preferred for AI) and a CLI (`sm`, fallback) talk to it.

**It is not a runtime credentials proxy.** `deploy` writes encrypted `.env.<env>` files locally via dotenvx; the workload reads them at process start with `dotenvx run -f .env.<env>`. Plaintext never transits `sm` at workload runtime.

## First: which surface is available?

Figure this out before doing anything else — the workflow depends on it.

1. **MCP available (preferred)** — Tools named `mcp__secrets-manager__*` are in your tool list. Call `mcp__secrets-manager__daemon_status` first, then follow the Golden Rules below.
2. **CLI only** — No MCP tools, but `sm` is on PATH. Run `sm daemon-status`. Same daemon underneath; you just lose the inline workflow descriptions. See `references/cli-fallback.md` for the MCP→CLI map and the safe value-handoff pattern.
3. **Nothing installed, or daemon offline** — Walk the user through install/start. See `references/setup.md`. **Never try to start the daemon yourself** — `sm-daemon start` prompts interactively for the master password, which only the human types.

When `daemon_status` returns "stopped" or returns `DAEMON_LOCKED`, tell the user: "The daemon isn't running — start it with `sm-daemon start` in a terminal where you can type the master password, then I'll continue." Don't try to work around it.

## Golden rules

Ten rules. Each one fixes a real failure mode. Read the **why** so you can judge edge cases instead of pattern-matching.

### 1. `daemon_status` before anything else

The daemon may be stopped, idle-locked (after 60 min by default), or invalid (vault re-encrypted with a different password → `KEY_INVALID_AFTER_RELOAD`). Every other tool fails opaquely if the daemon isn't healthy. Pay the one-call tax up front.

### 2. Every `add_secret` needs a real `description`

The `description` field is not optional in practice. It's the only durable record of *what this secret is, which service, which env role (test or live), and when to rotate it*. A blank description forces the next agent (or human) to reverse-engineer the secret from its key name. Always include service, environment role, and rotation cadence.

- **Good:** `"Stripe secret key for sandbox (test) — rotate every 90 days"`
- **Bad:** `"stripe key"`

### 3. `scope_secret` immediately after `add_secret` (or `set_tutorial`)

A secret with no scopes is invisible to `deploy`. Storing without scoping just hides a future surprise where deploy "succeeds" but writes nothing for that key.

- One secret, multiple envs: `scope_secret` with `envs: ["test", "live"]` — one round-trip.
- Multiple secrets at once: always use `scope_secrets_bulk`. It returns partial-failure rows so you can see every `CONFLICT` in one response — a loop of individual `scope_secret` calls hides which ones failed after the first error.

### 4. Repo environments are user-chosen labels

Common patterns: `test`+`live`, `development`+`production`, `local`+`staging`+`production`, or anything else. The names are just labels — `scope_secret` and `deploy` operate on whatever the repo declared via `add_repo`. The MCP `add_repo` tool description uses `test`+`live` for historical reasons; that's a convention, not a contract.

**The one inviolable rule:** sandbox/test credentials must never land in a prod env, and vice versa. If you're unsure which env role a credential is for, ask the user before scoping.

### 5. `namespace` is a vault-internal disambiguator, not a label

A `namespace` lets the vault hold two secrets that share the *same key* (e.g. a Stripe `API_KEY` and a SendGrid `API_KEY`) without colliding. **It does not change the env-var name written to `.env.<env>`** — the deployed key is always the bare `KEY`, regardless of namespace.

If you set `namespace: "stripe"` just to say "this secret belongs to Stripe", you're misusing the field. Put service identity in `description` instead. Use `set_namespace` with `unset: true` to clear an accidental namespace.

Set a namespace only when the vault would otherwise refuse two same-keyed secrets. Use lowercase alphanumeric names (regex `^[a-z][a-z0-9]*$`, no hyphens) matching the external service (`stripe`, `sendgrid`, `postgres`, `awss3`).

### 6. Use `set_tutorial` for unknown values — never write a sentinel string

If the value isn't available yet (the human needs to log into a vendor dashboard, generate an OAuth token, etc.), call `set_tutorial`. It auto-creates an `awaiting_value` placeholder that `deploy` filters out until the human submits the real value.

**Never** write strings like `__SET_VIA_TUTORIAL__` / `TODO` / `PLACEHOLDER` / `<YOUR_KEY>` as the value of `add_secret`. The daemon rejects obvious sentinels, but creative variations slip through and ship as garbage to a `.env` file. The `awaiting_value` mechanic exists precisely to avoid this — use it.

### 7. Pass plaintext via `valuePath` — never inline, never guess the arg name

Both `add_secret` and `set_value` read the plaintext from a file at `valuePath` (an absolute path inside the system temp dir). They do **not** accept an inline `value` parameter, and the arg is **not** `valueFromFile` / `value_from_file` — it's literally `valuePath`. The daemon reads the file and deletes it after, so the plaintext never lives in the tool-call transcript.

```
TMPFILE=$(mktemp)
# user writes value to $TMPFILE
add_secret({ key: "STRIPE_API_KEY", description: "...", valuePath: "$TMPFILE" })
set_value({ secret: "DATADOG_API_KEY", valuePath: "$TMPFILE" })
```

If the user pastes a value inline in chat, write it to a temp file first (`umask 077; TMPFILE=$(mktemp); printf '%s' "$VAL" > "$TMPFILE"`), then pass `valuePath: "$TMPFILE"`, then `rm "$TMPFILE"` after the call returns. See `references/cli-fallback.md` for the full snippet. The CLI uses `--value-from-file PATH` (different name, same idea) — that's a CLI affordance, not the MCP arg.

### 8. `deploy --dryRun` first, then deploy

`deploy` writes encrypted `.env.<env>` files via dotenvx. Always run `dryRun: true` first to preview what will be written — you'll see which secrets land in which envs and catch missing scopes or stale values before they ship.

**`deploy` writes local files only.** It does not push to Vercel, Fly, Heroku, or any other runtime. The downstream platform must be synced separately (e.g. `vercel env pull`, `flyctl secrets import`). Be explicit with the user about this — they often assume `deploy` ships everywhere.

### 9. Rotate via `set_value`, then re-deploy

When a secret is compromised or hits its rotation date (per its description):

1. `set_value` (pass `valuePath` pointing at a temp file holding the new value — see Rule 7).
2. `set_description` to record the new rotation date.
3. Re-deploy so `.env.<env>` files reflect the new value.

Don't `remove_secret` + `add_secret` — that loses the scopes. Don't forget step 3 — without re-deploy, the workload still reads the old value.

### 10. `variant` is an auto-scoping label — orthogonal to namespace

Setting `variant: "test"` (or `"staging"`, `"live"`, …) on `add_secret` tells the daemon: "place this secret into every `(repo, env)` whose env resolves to this variant via the vault's `envVariantMap`." The defaults ship with `development|dev|local|test|testing|sandbox → test`, `staging|stage|preview → staging`, `production|prod|live → live`. So `add_secret({ key: "STRIPE_KEY", variant: "test", ... })` lands in every dev/test cell across every registered repo in one call — no separate `scope_secret` needed for those cells.

- **Variant vs namespace:** `namespace` is a vault-internal disambiguator that lets two secrets share a `key`; `variant` controls which cells a secret auto-lands in. Both can be set independently on the same secret. Setting a `namespace` does NOT auto-scope. Setting a `variant` does NOT let two secrets share a key.
- **Variant is vault-internal too:** like namespace, it never appears in the deployed `.env.<env>` file — the deployed env-var is always the bare `KEY`.
- **Triple identity rule:** `(key, namespace, variant)` is the uniqueness triple. `add_secret` (or `set_variant`) returns `CONFLICT` if the new triple collides with an existing secret.
- **Sibling-check on every scope op:** if a `(repo, env)` cell is already owned by a sibling — same `(key, namespace)` but different `variant` — the daemon refuses to silently overwrite. On `add_secret` / `set_variant` the cell appears in the response's `skippedVariants` array (`[{ repoId, env, siblingId? }]`) and the auto-scope walk skips it. On manual `scope_secret` / `scope_secrets_bulk` the daemon returns `CONFLICT`. **Always inspect `skippedVariants` after a variant-bearing `add_secret` or `set_variant`** — non-empty means a sibling already owns that cell and you must decide: leave the sibling, or clear/re-point it via `set_variant` / `unscope_secret` first.
- **Mutable in place:** use `set_variant <secret> --variant V` (or `unset: true`) to change a variant after creation. On set, auto-scope re-runs and `skippedVariants` is reported. On unset, the field is removed but existing scopes are preserved — clear them explicitly with `unscope_secret` if you want them gone.
- **Empty `envVariantMap` does not disable auto-scoping** — it falls back to the built-in defaults. The `env_variant_unset` response includes a `note` field warning of this whenever the post-unset map becomes empty. To stop a single secret from auto-scoping, clear its variant via `set_variant` with `unset: true`, not by emptying the map.
- **Variant format:** lowercase alphanumeric, must start with a letter, max 32 chars (regex `^[a-z][a-z0-9]*$`). Stricter than namespace — no hyphens, no underscores.

## Typical workflow

```
1. daemon_status                — confirm the daemon is running
2. add_repo (one-time)          — register the repo and its env list
3a. set_tutorial                 — unknown value: creates `awaiting_value` placeholder
3b. add_secret + description     — known value: provide a meaningful description
4. scope_secret (envs: [...])    — assign to one or more envs in one call (required
                                   after both set_tutorial and add_secret)
   or scope_secrets_bulk         — many secrets × many envs in one round-trip
5. deploy --dryRun               — preview the .env output
6. deploy                        — write encrypted .env.<env> files locally
```

Step 3 is mutually exclusive: pick (a) if you don't have the value, (b) if you do. Never `add_secret` with a placeholder value just to "get it in the vault" — that's exactly what `set_tutorial` is for. Either way, always call `scope_secret` (step 4) immediately after — an unscoped secret is invisible to `deploy`.

## Tool reference (grouped by stage)

### Bootstrap

| Tool | Purpose |
|------|---------|
| `daemon_status` | Always call first — verifies the daemon is healthy |
| `add_repo` | Register a repo with its env list (e.g. `test`, `live`) |
| `set_repo_envs` | Replace the env list for an existing repo |
| `update_repo_path` | Update on-disk path after `git mv` / worktree move (scopes preserved) |
| `list_repos` | See all registered repositories |

### Add a secret

| Tool | Purpose |
|------|---------|
| `set_tutorial` | Unknown value — auto-creates `awaiting_value` placeholder + human-readable steps |
| `add_secret` | Known value — pass plaintext via `valuePath` (temp file), always include `description`; `namespace` only for vault disambiguation; pass `variant` to auto-scope into every `(repo, env)` whose env maps to that variant (returns `skippedVariants` for cells already owned by a sibling) |

### Scope

| Tool | Purpose |
|------|---------|
| `scope_secret` | Assign to one or many (`envs: [...]`) repo/env pairs. Variant-aware: returns `CONFLICT` if the target cell is already owned by a same-key/same-namespace/different-variant sibling. |
| `scope_secrets_bulk` | Many secrets × many envs in one call — partial-failure rows on `CONFLICT` (including variant sibling collisions). |
| `unscope_secret` | Remove a secret from a (repo, env) pair |

### Modify

| Tool | Purpose |
|------|---------|
| `set_value` | Rotate a secret value — pass new plaintext via `valuePath` (temp file); re-deploy afterwards |
| `set_description` | Update description without touching value |
| `set_description --unset` | Clear the description entirely (pass `unset: true`) |
| `set_namespace` | Set or clear (`unset: true`) the vault-internal namespace |
| `set_variant` | Set or clear (`unset: true`) the variant tag on an existing secret. On set: re-runs auto-scope and returns `skippedVariants` for sibling-owned cells. On unset: removes the field but preserves existing scopes. Enforces the `(key, namespace, variant)` triple identity rule on every mutation. |
| `rename_secret` | Rename the secret key |

### Env → variant mapping

| Tool | Purpose |
|------|---------|
| `env_variant_list` | Inspect the current `envVariantMap` (global + per-repo env→variant overrides) plus the built-in defaults |
| `env_variant_set` | Add a global or per-repo override (`env`, `variant`, optional `repo`). Per-repo wins over global. |
| `env_variant_unset` | Remove an override. Clearing every entry does NOT disable auto-scoping — the daemon falls back to the built-in defaults; the response includes a `note` field warning of this whenever the map becomes empty. |

### Inspect

| Tool | Purpose |
|------|---------|
| `list_secrets` | List secrets, optionally filtered by `namespace` |
| `describe_secret` | Inspect metadata + value fingerprint for one secret (never plaintext) |
| `list_scopes` | See all repo/env/secret assignments |
| `find_shared` | Detect secrets reused across multiple scopes (often an anti-pattern) |

### Deploy

| Tool | Purpose |
|------|---------|
| `deploy` | Write encrypted `.env.<env>` files. Use `dryRun: true` first. Local files only — does not push to Vercel/Fly/Heroku. |

### Destructive — confirm with user before calling

| Tool | Purpose |
|------|---------|
| `remove_secret` | Permanently delete a secret (with its scopes) |
| `remove_repo` | Unregister a repo |

These are irreversible. Always confirm with the user before calling — even when they ask you to "clean up", verify *which* specific secrets/repos they mean. The CLI cannot read plaintext back out, so a deleted secret is truly gone.

## Common mistakes

- **Skipping `daemon_status`** — every subsequent call fails opaquely.
- **Forgetting `scope_secret` after `add_secret` or `set_tutorial`** — the secret is stored but never deployed. (Exception: `add_secret` with `variant` set auto-scopes into every matching cell — but always inspect `skippedVariants` and add manual scopes for any cells the auto-walk skipped.)
- **Blank `description`** — makes rotation and audit impossible.
- **Writing sentinel strings as values** (`TODO`, `PLACEHOLDER`, `<YOUR_KEY>`) — call `set_tutorial` instead. The daemon catches obvious ones, but creative variants ship.
- **Setting `namespace` as a service label** — it's a vault-internal disambiguator. The deployed env-var is always the bare key. Use `description` for service identity.
- **Confusing `variant` with `namespace`** — `namespace` lets two secrets share a key; `variant` auto-scopes a secret into cells whose env maps to the variant. They're independent. Setting a `namespace` does NOT auto-scope; setting a `variant` does NOT allow two secrets to share a key.
- **Ignoring `skippedVariants` in the response** — non-empty means a sibling already owns one or more target cells. Silent failure if you ignore it. Decide whether to keep the sibling or clear/re-point it via `set_variant` / `unscope_secret` first.
- **Manually scoping a variant-bearing secret onto a sibling-owned cell** — `scope_secret` / `scope_secrets_bulk` now refuse with `CONFLICT`. Either clear the sibling's variant via `set_variant --unset` (then re-scope), or `unscope_secret` the sibling cell first.
- **Emptying the `envVariantMap` to disable auto-scoping** — it doesn't disable; it falls back to defaults. To stop a single secret from auto-scoping, clear its variant via `set_variant` with `unset: true`.
- **Calling `scope_secret` N times when `scope_secrets_bulk` does it in one** — bulk has partial-failure semantics that single-call loops don't.
- **Assuming `deploy` ships to Vercel/Fly/Heroku** — it doesn't. Local `.env.<env>` files only; sync to the runtime platform separately.
- **Deploying to `live` before `test`** — always preview with `dryRun: true` and exercise the dev env first.
- **Reusing one value across `test` and `live`** — run `find_shared` to detect.
- **Renaming a moved repo with `remove_repo` + `add_repo`** — that loses the scopes. Use `update_repo_path` instead.

## When something goes wrong

Error codes (`DAEMON_LOCKED`, `CONFLICT`, `INVALID_INPUT`, `KEY_INVALID_AFTER_RELOAD`, `COLLISION`, `AMBIGUOUS`, ...) and how to interpret them: see `references/troubleshooting.md`.

## Setup

If `sm-mcp`, `sm`, or `sm-daemon` aren't available, walk the user through install and registration: see `references/setup.md`.

## CLI fallback

If only the `sm` CLI is available (no MCP), every MCP tool has a CLI equivalent. See `references/cli-fallback.md` for the mapping and the safe value-handoff pattern (`umask 077`, write to temp file, `--value-from-file PATH`, `rm`).
