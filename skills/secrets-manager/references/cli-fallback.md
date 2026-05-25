# CLI fallback — using `sm` when MCP isn't available

If `mcp__secrets-manager__*` tools aren't in your tool list, you fall back to the `sm` CLI. The CLI talks to the same daemon and produces identical encrypted `.env.<env>` files — only the workflow scaffolding differs (no inline tool descriptions, so the Golden Rules in SKILL.md are entirely your responsibility).

## MCP → CLI tool map

| MCP tool              | CLI equivalent                                                          |
|-----------------------|-------------------------------------------------------------------------|
| `daemon_status`       | `sm-daemon status` (or `sm daemon-status`)                              |
| `add_repo`            | `sm add-repo --name N --path P --env E [--env E ...]`                   |
| `set_repo_envs`       | `sm set-repo-envs <id\|name> --env E [--env E ...]`                     |
| `update_repo_path`    | `sm update-repo-path <repo> --path PATH`                                |
| `list_repos`          | `sm list-repos`                                                         |
| `remove_repo`         | `sm remove-repo <id\|name>`                                             |
| `add_secret`          | `sm add-secret --key K --description "..." [--namespace N] [--variant V] --value-from-file PATH` |
| `set_tutorial`        | (no CLI equivalent — MCP-only)                                          |
| `scope_secret`        | `sm scope <secret> --repo R --env E [--env E ...]` (multiple `--env` fans out) |
| `scope_secrets_bulk`  | (no CLI equivalent — call `sm scope` per secret, or prefer MCP)         |
| `unscope_secret`      | `sm unscope <secret> --repo R --env E`                                  |
| `list_secrets`        | `sm list-secrets [--namespace NS]`                                      |
| `describe_secret`     | `sm describe-secret <key\|id>`                                          |
| `set_value`           | `sm set-value <secret> --value-from-file PATH`                          |
| `set_description`     | `sm set-description <secret> --description "..."` (or `--unset`)        |
| `set_namespace`       | `sm set-namespace <secret> --namespace NS` (or `--unset`)               |
| `set_variant`         | `sm set-variant <secret> --variant V` (or `--unset`) — mutates in place, re-runs auto-scope on set, preserves scopes on unset |
| `env_variant_list`    | `sm env-variant list`                                                   |
| `env_variant_set`     | `sm env-variant set --env ENV --variant V [--repo REPO]`                |
| `env_variant_unset`   | `sm env-variant unset --env ENV [--repo REPO]` (clearing every override falls back to built-in defaults, NOT off) |
| `rename_secret`       | `sm rename-secret <secret> --new-key NEW`                               |
| `deploy`              | `sm deploy [--repo R] [--env E] [--dry-run]` — **always** `--dry-run` first |
| `find_shared`         | `sm find-shared [--min-length N]`                                       |
| `list_scopes`         | `sm list-scopes`                                                        |
| `remove_secret`       | `sm remove-secret <id\|key>`                                            |

`sm import` (no MCP equivalent) imports an existing `.env` file: `sm import --repo PATH [--env ENV] [--dry-run] [--default-namespace NS] [--default-variant V] [--on-conflict skip|overwrite|fail]`. Pass `--default-variant` to auto-scope newly-created secrets to every cell whose env resolves to that variant.

Every command emits JSON (`{ ok, ... }`) on non-TTY and exits non-zero on failure. Responses **never** include the `value` field — three test suites enforce that invariant.

## Two MCP-only tools and how to work around them

### `set_tutorial`

There is no CLI equivalent. If you need to register an unknown-value secret from the CLI, you can't (cleanly). Options:

1. Ask the user to use the web UI (`pnpm dev` → http://localhost:3000) to attach the tutorial — that goes through the same daemon.
2. If the user can give you the value now, just `sm add-secret` with the real value.
3. Do **not** write `sm add-secret` with a placeholder like `TODO` or `<YOUR_KEY>` — the daemon rejects obvious sentinels, and any that slip through ship as garbage to `.env`.

### `scope_secrets_bulk`

No CLI equivalent. Loop `sm scope` per secret. Unlike the MCP bulk call — which returns partial-failure rows so you can see every `CONFLICT` in one response — a shell loop gives you less visibility: you must check each call's JSON output individually to know which ones failed. Best to script it and inspect each response.

## Safe value-handoff pattern

The CLI never accepts a plaintext value on argv — values are passed via temp file. The standard pattern:

```bash
umask 077                                         # ensure 0600 perms
TMPFILE=$(mktemp)                                  # unique temp file, not a fixed path
printf '%s' "$MY_SECRET_VALUE" > "$TMPFILE"        # write value to temp file
sm add-secret \
  --key DATABASE_URL \
  --description "Postgres URL for test env — rotate every 90 days" \
  --value-from-file "$TMPFILE"
rm "$TMPFILE"                                      # always clean up
```

Use `$(mktemp)` rather than a fixed path like `/tmp/v.txt` — predictable filenames are vulnerable to symlink attacks (TOCTOU). `mktemp` produces a unique, non-guessable path with `0600` permissions (combined with `umask 077`).

For AI-driven workflows, the **user** writes the temp file. The AI just hands the path to `sm`. Do not paste plaintext values into your conversation — the user should put them on disk in a file you can reference.

If you find yourself about to write a plaintext value to the shell or to argv (e.g. `echo "$KEY" | sm ...`), stop. The value would land in shell history, the process table, and possibly logs. Use the temp-file path instead.

## Replicating the Golden Rules by hand on the CLI

The CLI doesn't render the MCP descriptions into your context, so the workflow guardrails are entirely on you:

1. Always run `sm daemon-status` (or `sm-daemon status`) first.
2. Always pass `--description "..."` on `sm add-secret`.
3. Always run `sm scope ...` immediately after `sm add-secret` (unless `--variant` was set and the auto-scope walk already covered every target cell — inspect the response's `skippedVariants` array; any non-empty entries are cells you must handle explicitly).
4. Always run `sm deploy --dry-run` before `sm deploy`.
5. `--namespace` is vault-internal; do not set it as a service label.
6. `--variant` is an auto-scoping label, orthogonal to namespace. Mutate it later with `sm set-variant <secret> --variant V` (or `--unset`). Manage the env→variant map with `sm env-variant set/unset/list`.
7. There is no CLI `set_tutorial` — if the value is unknown, ask the user to handle it via the web UI, or get the real value first.
8. Rotate via `sm set-value`, then re-deploy.
