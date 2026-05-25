#!/usr/bin/env -S npx tsx
import { runSubcommand } from "../lib/cli/router";

const verb = process.argv[2];
const rest = process.argv.slice(3);

if (!verb || verb === "--help" || verb === "-h" || verb === "help") {
  process.stdout.write(
    [
      "usage: sm <verb> [flags]",
      "",
      "──── For AI agents ─────────────────────────────────────────────",
      "  This is the unguided CLI surface. Prefer `sm-mcp` (the MCP",
      "  server, rendered as tools in your client) for the guided",
      "  workflow with safety-rail descriptions. See CLAUDE.md for the",
      "  full agent guide and the MCP→CLI mapping.",
      "────────────────────────────────────────────────────────────────",
      "",
      "Daemon-status:",
      "  daemon-status               — alias of `sm-daemon status`",
      "",
      "Read-only:",
      "  list-repos",
      "  list-secrets [--namespace NS]",
      "  list-scopes",
      "  describe-secret <key|id>",
      "",
      "Structural mutations:",
      "  add-repo --name NAME --path PATH --env ENV...",
      "  remove-repo <id|name>",
      "  set-repo-envs <id|name> --env ENV...",
      "  scope    <secret> --repo REPO --env ENV [--env ENV ...]",
      "  unscope  <secret> --repo REPO --env ENV",
      "  set-namespace <secret> --namespace NS  (or --unset)",
      "  set-variant   <secret> --variant V     (or --unset)",
      "  set-description <secret> --description \"...\"  (or --unset)",
      "  rename-secret <secret> --new-key NEW",
      "",
      "Env-variant map (controls add-secret --variant auto-scoping):",
      "  env-variant list",
      "  env-variant set   --env ENV --variant V [--repo REPO]",
      "  env-variant unset --env ENV [--repo REPO]",
      "",
      "Value-bearing mutations:",
      "  add-secret --key KEY [--namespace NS] [--variant V] [--description \"...\"] --value-from-file PATH",
      "  remove-secret <id|key>",
      "  set-value <secret> --value-from-file PATH [--description \"...\"]",
      "",
      "Import / discovery:",
      "  import --repo PATH [--env ENV] [--dry-run] [--default-namespace NS]",
      "         [--default-variant V] [--on-conflict skip|overwrite|fail]",
      "  find-shared [--min-length N]",
      "",
      "Deploy:",
      "  deploy [--repo REPO] [--env ENV] [--dry-run]",
      "",
      "Output:",
      "  All commands accept --json (default for non-TTY) and emit `{ ok, ... }`.",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

runSubcommand(verb, rest).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${(e as Error).message ?? e}\n`);
    process.exit(1);
  },
);
