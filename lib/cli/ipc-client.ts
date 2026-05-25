import * as net from "node:net";

import { socketPath } from "../daemon/paths";
import type {
  DaemonErrorResponse,
  DaemonRequest,
  DaemonResponse,
} from "../daemon/protocol";

/**
 * Connect to the daemon, send a single request, read a single response,
 * close. The protocol is line-delimited JSON over a Unix stream socket.
 *
 * If the socket isn't there (or the daemon refuses), we synthesize a
 * `DAEMON_LOCKED` response — never throw — so callers can format it like
 * any other daemon-emitted error.
 */
export async function sendCommand(
  req: DaemonRequest,
  opts?: { socketPathOverride?: string; timeoutMs?: number },
): Promise<DaemonResponse> {
  const target = opts?.socketPathOverride ?? socketPath();
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    const sock = net.createConnection({ path: target });
    let buf = "";
    let settled = false;
    const settle = (r: DaemonResponse) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(r);
    };

    const timer = setTimeout(() => {
      settle(
        lockedResponse(
          "Daemon did not respond before the timeout — is `sm-daemon` running?",
        ),
      );
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    sock.setEncoding("utf8");
    sock.once("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      try {
        const parsed = JSON.parse(line) as DaemonResponse;
        clearTimeout(timer);
        settle(parsed);
      } catch {
        clearTimeout(timer);
        settle(
          lockedResponse(
            "Daemon returned an unparseable response — protocol mismatch",
          ),
        );
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        settle(
          lockedResponse(
            "Daemon must be unlocked by human user with master password. Surface this to the user.",
          ),
        );
        return;
      }
      settle(
        lockedResponse(
          `Could not reach daemon: ${err.message ?? "unknown error"}`,
        ),
      );
    });
    sock.on("end", () => {
      // Buffer may still contain unparsed bytes; if we haven't already
      // settled, treat it as a protocol error.
      if (!settled) {
        const trimmed = buf.trim();
        if (trimmed.length > 0) {
          try {
            const parsed = JSON.parse(trimmed) as DaemonResponse;
            clearTimeout(timer);
            settle(parsed);
            return;
          } catch {
            // fall through
          }
        }
        clearTimeout(timer);
        settle(
          lockedResponse("Daemon closed the connection without responding"),
        );
      }
    });
  });
}

export function lockedResponse(message: string): DaemonErrorResponse {
  return { ok: false, code: "DAEMON_LOCKED", message };
}
