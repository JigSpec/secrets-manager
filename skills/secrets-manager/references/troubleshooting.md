# Troubleshooting — decoding secrets-manager errors

Every MCP/CLI response is shaped `{ ok, ... }`. On failure, `ok: false` plus an `error.code` and `error.message`. This is a decoder for the codes you'll see.

## Error codes

### `DAEMON_LOCKED`

**Meaning:** The daemon is not running, the socket isn't accessible, or the vault is locked (idle-locked after 60 min, or has not been created).

**What to do:**
1. Tell the user to start the daemon: `sm-daemon start`.
2. If it was already running, the idle TTL probably expired. Same fix.
3. If `sm-daemon start` fails with "vault file not found", the human hasn't created the master password yet — open the web UI (`pnpm dev` → http://localhost:3000) and create it.

Do not retry the failed call in a loop — the daemon won't come back on its own.

### `KEY_INVALID_AFTER_RELOAD`

**Meaning:** While the daemon was running, the vault file was re-encrypted with a different password (typically because the human rotated the master password via the web UI). The daemon auto-locks and exits.

**What to do:** Tell the user to restart the daemon with the new password: `sm-daemon stop` (if still alive), then `sm-daemon start`.

### `NOT_FOUND`

**Meaning:** The secret, repo, or scope the call referenced doesn't exist.

**What to do:**
- For a secret: run `list_secrets` to find the actual key. The user may have referred to it by description instead of key.
- For a repo: run `list_repos`.
- For a scope: run `list_scopes` to see what's actually assigned.

### `AMBIGUOUS`

**Meaning:** The secret lookup matched multiple keys (only happens when looking up by partial key or value fingerprint).

**What to do:** Look it up by full key or by `id` (run `list_secrets` and use the unique `id` field).

### `CONFLICT`

**Meaning:** The mutation collides with existing state.

Common cases:
- `add_repo` with a name or path that's already registered → use `list_repos` to find the existing entry, or pick a different name.
- `add_secret` with a `(key, namespace, variant)` triple that already exists → use `set_value` to rotate, or change one of the three (different namespace, different variant, or `set_variant` the existing secret).
- `set_variant` that would produce a triple already held by another secret → pick a different variant, or clear the colliding secret's variant first via `set_variant --unset`.
- `scope_secret` / `scope_secrets_bulk` placing a variant-bearing secret onto a cell already owned by a same-key/same-namespace/different-variant sibling → either clear the sibling (`set_variant --unset` or `unscope_secret`), or accept that the new secret cannot share that cell.
- `scope_secret` for a `(secret, repo, env)` triple that's already scoped → safe to ignore (idempotency).
- `rename_secret` to a key that's already used by another secret in the same namespace → pick a different name.

For bulk operations (`scope_secrets_bulk`), `CONFLICT` rows are returned per-row alongside successful rows — they don't abort the whole call. Read the response carefully.

### `INVALID_INPUT`

**Meaning:** Validation failed on a field.

Common cases:
- `key` doesn't match the env-var regex (`^[A-Z][A-Z0-9_]*$`) — keys must be UPPER_SNAKE_CASE.
- `description` is empty or too long — provide a meaningful one.
- `namespace` doesn't match `^[a-z][a-z0-9]*$` — lowercase alphanumeric only, no hyphens, no leading digit.
- `variant` doesn't match `^[a-z][a-z0-9]*$` and ≤ 32 chars — same shape as namespace but stricter on length. Common examples: `test`, `staging`, `live`, `qa`. No hyphens or underscores.
- `set_variant` called with both `variant` and `unset: true`, or with neither — pass exactly one.
- `env` not in the repo's declared env list — call `list_repos` to see valid env names, or `set_repo_envs` to add it.
- `value` looks like a placeholder sentinel — use `set_tutorial` instead (see Golden Rule 6).

The `error.message` usually pinpoints the field. Read it.

### `PERSIST_FAILED`

**Meaning:** Vault file write failed (disk full, permissions, fs error).

**What to do:** Check `~/.config/secrets-manager/` for disk space and ownership. The user may need to fix filesystem state — surface the error message verbatim.

### `DEPLOY_FAILED`

**Meaning:** `deploy` couldn't write a `.env.<env>` file. Sub-causes vary — message text matters.

Common cases:
- `dotenvx not found` — the bundled SDK is missing because `pnpm install` was skipped or partial. Tell the user to re-run `pnpm install` in the repo root.
- `repo path does not exist` — the repo was moved on disk. Use `update_repo_path` to fix the registered path. **Do not** `remove_repo` + `add_repo` — that loses scopes.
- `failed to write key file` — `~/.config/secrets-manager/keys/` is unwritable or full.
- `dotenvx-ops required` — `SM_REQUIRE_DOTENVX_OPS=1` is set but `dotenvx-ops` isn't on PATH or the user isn't logged in.

### `COLLISION`

**Meaning:** Two or more secrets scoped to the same `(repo, env)` would deploy to the same env-var name. Remember: the deployed key is always the bare secret `key`, regardless of `namespace`. So if Stripe's `API_KEY` and SendGrid's `API_KEY` (different namespaces) are both scoped to the same `(repo, env)`, deploy refuses — only one bare `API_KEY=` can exist in the file.

**What to do:** Pick one per cell. Either `unscope_secret` one of them, `rename_secret` one to a non-colliding key (e.g. `STRIPE_API_KEY` and `SENDGRID_API_KEY`), or split into two repos.

### `IMPORT_CONFLICT`

**Meaning:** `import` (only available via CLI) found a key in the `.env` file that already exists in the vault, and `--on-conflict` wasn't specified.

**What to do:** Re-run with `--on-conflict skip|overwrite|fail` explicitly. `skip` is safest by default.

### `BAD_REQUEST`

**Meaning:** Malformed payload to the daemon. Usually an MCP/CLI bug — the daemon refuses to interpret it.

**What to do:** Report the full request and error to the user; this is a bug, not a config issue.

### `UNKNOWN_COMMAND`

**Meaning:** CLI verb not recognized. (Doesn't apply to MCP — MCP tools are statically defined.)

**What to do:** Run `sm --help` for the verb list.

## Non-error symptoms

### "`deploy` succeeded but the `.env` file is empty"

The secret was added but not scoped to that `(repo, env)`. Run `list_scopes` to confirm. Fix with `scope_secret`.

### "`deploy` skipped a secret I just added"

It's probably an `awaiting_value` placeholder (created by `set_tutorial` without a follow-up `set_value`). Run `describe_secret <key>` and check the `status` field. The human needs to submit the real value (typically via the web UI's tutorial pane) before deploy will write it.

### "I deployed but my Vercel/Fly/Heroku build still uses the old value"

`deploy` writes local files only. The downstream platform needs its own sync (`vercel env pull`, `flyctl secrets import`, Heroku CLI). This is by design — not a bug.

### "`daemon_status` says running but mutations fail with `DAEMON_LOCKED`"

The vault may be locked even when the socket process is up (e.g. idle TTL fired but the socket lingers briefly). Have the user run `sm-daemon stop && sm-daemon start`.

### "The deployed env-var has the bare key — I expected `STRIPE_API_KEY`"

Namespaces are vault-internal. They never appear in `.env.<env>`. If you want the deployed name to be `STRIPE_API_KEY`, rename the secret with `rename_secret`. The `namespace` field is purely for letting two same-keyed secrets coexist in the vault. (Same goes for `variant` — it controls auto-scoping but never appears in the deployed file.)

### "`add_secret` with `variant` succeeded but `skippedVariants` is non-empty"

Not an error — it's a notice. Each entry in `skippedVariants` (`[{ repoId, env, siblingId? }]`) is a cell that the auto-scope walk refused to claim because a sibling secret (same `key` + same `namespace`, different `variant`) already owns it. Decide per cell:

- **Leave the sibling** if the existing secret is the right one for that env. Do nothing; your new secret will only live in the cells the walk did claim.
- **Re-point the cell** to your new secret: clear the sibling's variant via `set_variant --unset` (preserves its scopes — clear them too with `unscope_secret` if you want them gone), then re-run `set_variant` on your new secret so the auto-walk picks up that cell.

### "`env_variant_unset` returned a `note` about falling back to defaults"

Clearing the last override in the map does **not** disable auto-scoping. The daemon falls back to its built-in `DEFAULT_ENV_VARIANT_MAP` (`development|dev|local|test|testing|sandbox → test`, `staging|stage|preview → staging`, `production|prod|live → live`). The `note` is the only warning you get. To stop a single secret from auto-scoping, clear that secret's variant via `set_variant --unset`, not by emptying the map.

## Read the `error.message`

The daemon's error messages are written with care — they often pinpoint the problem field or the conflicting record. Surface them to the user verbatim rather than paraphrasing. If you can't explain a message, ask the user; don't guess.
