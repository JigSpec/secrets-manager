import type { DaemonResponse } from "../daemon/protocol";

export type EmitOptions = {
  /** Force JSON output. Default: true if stdout is not a TTY. */
  json?: boolean;
  /** Stream override (tests pass a buffer-collector). */
  stdout?: { write: (chunk: string) => boolean | void };
  stderr?: { write: (chunk: string) => boolean | void };
};

/**
 * Emit a response to the appropriate stream and return the process exit
 * code. Errors go to stderr in human mode, stdout in JSON mode (so a
 * piped consumer sees one JSON object regardless of success).
 */
export function emit(
  response: DaemonResponse,
  opts: EmitOptions = {},
): number {
  const json = opts.json ?? !process.stdout.isTTY;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  if (json) {
    stdout.write(JSON.stringify(response) + "\n");
    return response.ok ? 0 : 1;
  }
  if (response.ok) {
    stdout.write(humanFormat(response) + "\n");
    return 0;
  }
  stderr.write(`error: ${response.code}: ${response.message}\n`);
  return 1;
}

function humanFormat(resp: Extract<DaemonResponse, { ok: true }>): string {
  // Best-effort prettyprint. Most subcommands have a hand-written formatter
  // in their command file; this is the fallback.
  const { ok: _ok, ...rest } = resp;
  return JSON.stringify(rest, null, 2);
}

/**
 * Parse `--json`, `--no-json` flags out of argv, returning the residue.
 */
export function parseOutputFlags(argv: string[]): {
  json: boolean | undefined;
  rest: string[];
} {
  let json: boolean | undefined;
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--no-json") json = false;
    else rest.push(a);
  }
  return { json, rest };
}
