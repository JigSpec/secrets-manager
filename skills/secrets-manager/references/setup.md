# Setup — installing secrets-manager and registering sm-mcp

When `sm-mcp` / `sm` / `sm-daemon` aren't available, walk the user through this. Do not try to skip steps — each is load-bearing.

## What needs to be true

For an AI agent to use the MCP server:

1. The repo is cloned and dependencies are installed.
2. The `sm`, `sm-mcp`, and `sm-daemon` binaries are on PATH (via `install.sh` symlinks).
3. The `sm-mcp` server is registered with the user's MCP client (Claude Code, Claude Desktop, Cursor, etc.).
4. The daemon is running (`sm-daemon start`) — only the human can do this, because it prompts for the master password.

## 1. Install

```bash
git clone https://github.com/JigSpec/secrets-manager.git
cd secrets-manager
pnpm install
sudo ./install.sh         # creates symlinks in /usr/local/bin
```

Requirements:

- Node 20+
- `pnpm` (or substitute `npm install` / `yarn install`)
- `npx` on PATH (the bin shebangs use `#!/usr/bin/env -S npx tsx`)

Custom prefix (e.g. Apple Silicon Homebrew):

```bash
sudo SM_BIN_DIR=/opt/homebrew/bin ./install.sh
```

Verify:

```bash
which sm sm-daemon sm-mcp
sm --help
```

### Optional: dotenvx-ops

Secrets-manager works without `dotenvx-ops` — when missing, it generates a keypair in-process via the bundled `@dotenvx/dotenvx` SDK and stores the private key under `~/.config/secrets-manager/keys/<repo>-<hash>/<env>.private.key` (mode `0600`).

For teams that want centralized key custody, install [`dotenvx-ops`](https://dotenvx.com/) and set `SM_REQUIRE_DOTENVX_OPS=1`. The human will need an active `dotenvx-ops login` session for the *first* deploy to each new `(repo, env)` pair.

## 2. Register sm-mcp with the MCP client

### Claude Code (recommended)

```bash
claude mcp add secrets-manager sm-mcp
```

That writes a `secrets-manager` entry under `mcpServers` in `~/.claude.json` (or the project `.mcp.json`).

Verify Claude Code can see the server:

```bash
claude mcp list
```

Restart any active Claude Code session so it picks up the new server.

### Claude Desktop

The config file path depends on your OS:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Edit the file for your platform:

```json
{
  "mcpServers": {
    "secrets-manager": {
      "command": "sm-mcp"
    }
  }
}
```

Restart Claude Desktop.

### Other MCP clients (Cursor, Continue, Cline, etc.)

Same pattern — register a stdio MCP server with `command: "sm-mcp"`. No extra args needed in the default case. If you're connecting to a non-default daemon socket (rare, mostly for tests), pass `--socket /path/to/sm.sock` as an arg.

## 3. First-time vault creation (new installations only)

If this is your first time running secrets-manager, you must create the vault before starting the daemon:

1. Start the web UI:
   ```bash
   pnpm dev
   ```
2. Open http://localhost:3000 in your browser.
3. Follow the prompts to create the vault and set the master password.

Skip this step if the vault already exists (i.e. the daemon has started successfully before).

## 4. Start the daemon (the human does this)

```bash
sm-daemon start
```

This prompts for the master password (no echo). The CLI/MCP path assumes the vault already exists (see step 3 above if it doesn't).

The daemon runs in the foreground in that terminal. Keep it open (or background it with `&` / a service manager). Idle-locks after 60 min by default — override with `SM_DAEMON_IDLE_TTL_MIN`.

Check status (AI-safe — no password prompt):

```bash
sm-daemon status
```

Stop / lock:

```bash
sm-daemon stop
```

## What an AI can and cannot do here

| Step | Can the AI do this? |
|------|---------------------|
| 1. Install (clone, pnpm install, ./install.sh) | Can run the commands if the user authorizes, but `sudo` will need the human's password |
| 2. Register `sm-mcp` with the MCP client | Can run `claude mcp add secrets-manager sm-mcp` or edit the config file |
| 3. Create vault via web UI (first-time only) | **No** — requires the human to interact with the browser UI and set the master password |
| 4. Start the daemon (`sm-daemon start`) | **No** — the daemon prompts for the master password, which only the human types. Tell the user to start it. |
| 4'. Check daemon status (`sm-daemon status` / `daemon_status`) | Yes — read-only, no password |

After the daemon is running, the AI can use the MCP tools for everything in the Golden Rules workflow.

## Troubleshooting setup

- **`sm: command not found`** — `install.sh` either failed or installed to a directory not on PATH. Check `which -a sm` and re-run with `SM_BIN_DIR=/your/bin/dir`.
- **`Error: Cannot find module 'tsx'`** — `pnpm install` was skipped or failed. Re-run from the repo root.
- **`sm-mcp` MCP tools don't appear after `claude mcp add`** — Restart the Claude Code session. The MCP client list is loaded at session start.
- **Daemon starts but `daemon_status` returns `DAEMON_LOCKED`** — Vault has not yet been created. Open the web UI (`pnpm dev` → http://localhost:3000) and create the master password.
- **`KEY_INVALID_AFTER_RELOAD` after the human rotated the master password** — Restart the daemon with the new password (`sm-daemon stop` then `sm-daemon start`).
