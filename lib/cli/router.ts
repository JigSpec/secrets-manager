import { emit, parseOutputFlags } from "./output";
import { sendCommand } from "./ipc-client";
import type { DaemonResponse } from "../daemon/protocol";

/**
 * Map of subcommand name → handler. Each handler returns a `DaemonResponse`
 * (or anything shaped like one) and the router takes care of formatting +
 * exit code via `emit`.
 *
 * Subcommand files register themselves at import time via `register`.
 */
type SubcommandHandler = (
  argv: string[],
  ctx: { json: boolean | undefined },
) => Promise<DaemonResponse>;

const registry = new Map<string, SubcommandHandler>();

export function register(name: string, fn: SubcommandHandler): void {
  registry.set(name, fn);
}

/**
 * Daemon-status is special: it doesn't go through the standard command
 * registration since it lives on `sm-daemon`. We re-expose it on `sm` as a
 * convenience for AI agents that don't want to switch binaries.
 */
register("daemon-status", async () => {
  return sendCommand({ cmd: "status" });
});

export async function runSubcommand(
  verb: string,
  argv: string[],
): Promise<number> {
  // Import every command file once so the registry is populated. Done lazily
  // so `sm --help` doesn't pay the cost.
  await import("./commands");

  const handler = registry.get(verb);
  if (!handler) {
    return emit(
      {
        ok: false,
        code: "UNKNOWN_COMMAND",
        message: `unknown command: ${verb}`,
      },
      {},
    );
  }
  const parsed = parseOutputFlags(argv);
  let response: DaemonResponse;
  try {
    response = await handler(parsed.rest, { json: parsed.json });
  } catch (e) {
    response = {
      ok: false,
      code: "BAD_REQUEST",
      message: `handler threw: ${(e as Error).message ?? String(e)}`,
    };
  }
  return emit(response, { json: parsed.json });
}

/**
 * Like `runSubcommand` but returns the raw `DaemonResponse` instead of
 * writing to stdout and returning an exit code. Intended for unit tests
 * that want to inspect the response object directly.
 */
export async function dispatchCommand(
  verb: string,
  argv: string[],
): Promise<DaemonResponse> {
  await import("./commands");

  const handler = registry.get(verb);
  if (!handler) {
    return {
      ok: false,
      code: "UNKNOWN_COMMAND",
      message: `unknown command: ${verb}`,
    };
  }
  const parsed = parseOutputFlags(argv);
  try {
    return await handler(parsed.rest, { json: parsed.json });
  } catch (e) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: `handler threw: ${(e as Error).message ?? String(e)}`,
    };
  }
}
