import { stat } from "node:fs/promises";
import * as net from "node:net";
import { unlink, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

import { loadVault, vaultDir, vaultPath } from "../vault/store";
import {
  clearSession,
  getSession,
  reconcileFromDisk,
  setSession,
} from "./session";
import { pidPath, socketPath } from "./paths";
import {
  type DaemonErrorCode,
  type DaemonRequest,
  type DaemonResponse,
  err,
  ok,
} from "./protocol";

export type HandlerContext = {
  /** Idle TTL reset hook — call after a successful business operation. */
  bumpIdle: () => void;
  /** Trigger a clean daemon shutdown (used by `stop` / key-invalid). */
  requestStop: (reason: "idle" | "key-invalid" | "stop") => void;
  /** Read the currently-active idle TTL in milliseconds. */
  getIdleTtlMs: () => number;
  /** Update the active idle TTL and immediately re-arm the timer. */
  setIdleTtlMs: (ms: number) => void;
};

export type Handler = (
  args: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<DaemonResponse> | DaemonResponse;

const handlers = new Map<string, Handler>();

export function registerHandler(verb: string, fn: Handler): void {
  handlers.set(verb, fn);
}

export function unregisterAllHandlers(): void {
  handlers.clear();
}

export type StartServerOptions = {
  password: string;
  idleTtlMs: number;
  onLock?: (reason: "idle" | "key-invalid" | "stop") => void;
};

export type StartServerResult = {
  socketPath: string;
  stop: () => Promise<void>;
};

export async function startServer(
  opts: StartServerOptions,
): Promise<StartServerResult> {
  const dir = vaultDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Refuse to start if a live daemon is already bound. Stale socket + dead
  // PID → reclaim by unlinking.
  await reclaimStaleSocket();

  // Initial load + session install.
  const data = await loadVault(opts.password);
  const m = await stat(vaultPath()).catch(() => null);
  setSession(opts.password, data, m?.mtimeMs ?? Date.now());

  let stopped = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let idleTtlMs = opts.idleTtlMs;
  let idleDeadlineMs: number = Date.now() + idleTtlMs;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleDeadlineMs = Date.now() + idleTtlMs;
    idleTimer = setTimeout(() => {
      if (stopped) return;
      void stop("idle");
    }, idleTtlMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };
  bumpIdle();

  const ctx: HandlerContext = {
    bumpIdle,
    requestStop: (reason) => {
      void stop(reason);
    },
    getIdleTtlMs: () => idleTtlMs,
    setIdleTtlMs: (next) => {
      if (!Number.isFinite(next) || next <= 0) return;
      idleTtlMs = Math.floor(next);
      bumpIdle();
    },
  };

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buf.slice(0, newlineIdx);
      buf = buf.slice(newlineIdx + 1);
      void handleLine(line, socket, ctx, () => idleTtlMs, () => idleDeadlineMs);
    });
    socket.on("error", () => {
      // Client disconnect during write — best-effort.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(), () => {
      server.off("error", reject);
      resolve();
    });
  });
  // chmod 0600 on the socket
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(socketPath(), 0o600);
  } catch {
    // Best-effort; some filesystems / OSes don't honor.
  }

  // Write PID file so future starts can detect us.
  await writeFile(pidPath(), String(process.pid), { mode: 0o600 });

  const stop = async (reason: "idle" | "key-invalid" | "stop"): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearSession();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await safeUnlink(socketPath());
    await safeUnlink(pidPath());
    opts.onLock?.(reason);
  };

  return {
    socketPath: socketPath(),
    stop: () => stop("stop"),
  };
}

async function handleLine(
  line: string,
  socket: net.Socket,
  ctx: HandlerContext,
  getIdleTtlMs: () => number,
  getIdleDeadlineMs: () => number,
): Promise<void> {
  let req: DaemonRequest;
  try {
    req = JSON.parse(line);
  } catch {
    writeResponse(socket, err("BAD_REQUEST", "request is not valid JSON"));
    socket.end();
    return;
  }
  if (typeof req?.cmd !== "string") {
    writeResponse(socket, err("BAD_REQUEST", "request is missing 'cmd'"));
    socket.end();
    return;
  }

  // Built-ins.
  if (req.cmd === "stop") {
    writeResponse(socket, ok({ stopped: true }));
    socket.end(() => {
      ctx.requestStop("stop");
    });
    return;
  }
  if (req.cmd === "status") {
    writeResponse(
      socket,
      ok({
        state: "running" as const,
        pid: process.pid,
        idleTtlMs: getIdleTtlMs(),
        idleTtlMsRemaining: Math.max(0, getIdleDeadlineMs() - Date.now()),
      }),
    );
    socket.end();
    ctx.bumpIdle();
    return;
  }

  // Reload-on-mtime-change before each handler.
  const r = await reconcileFromDisk();
  if (r === "key-invalid") {
    writeResponse(
      socket,
      err(
        "KEY_INVALID_AFTER_RELOAD",
        "vault file changed and the held password no longer decrypts it — daemon is locking",
      ),
    );
    socket.end(() => {
      ctx.requestStop("key-invalid");
    });
    return;
  }

  const handler = handlers.get(req.cmd);
  if (!handler) {
    writeResponse(socket, err("UNKNOWN_COMMAND", `unknown command: ${req.cmd}`));
    socket.end();
    return;
  }
  try {
    const resp = await handler(req.args ?? {}, ctx);
    writeResponse(socket, resp);
    socket.end();
    ctx.bumpIdle();
  } catch (e) {
    writeResponse(
      socket,
      err(
        "BAD_REQUEST",
        `handler threw: ${(e as Error).message ?? String(e)}`,
      ),
    );
    socket.end();
  }
}

function writeResponse(socket: net.Socket, resp: DaemonResponse): void {
  try {
    socket.write(JSON.stringify(resp) + "\n");
  } catch {
    // Client may have disconnected.
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    // ENOENT or perms — best-effort cleanup.
  }
}

async function reclaimStaleSocket(): Promise<void> {
  const sp = socketPath();
  const pp = pidPath();
  if (!existsSync(sp) && !existsSync(pp)) return;

  if (existsSync(pp)) {
    const pidStr = (await readSmall(pp)).trim();
    const pid = Number(pidStr);
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
      const e = new Error(
        `daemon already running (pid ${pid}); socket at ${sp}`,
      ) as Error & { code?: string };
      e.code = "DAEMON_ALREADY_RUNNING";
      throw e;
    }
  }
  await safeUnlink(sp);
  await safeUnlink(pp);

  // Defensive guard against orphan-not-actually-stale sockets.
  if (existsSync(sp)) {
    try {
      statSync(sp);
    } catch {
      // ignore
    }
  }
}

async function readSmall(p: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return await readFile(p, "utf8");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lightweight passthrough into the daemon's in-memory state. Handlers
 * import this rather than the session module directly so that:
 *   (a) tests can swap session backends without monkeypatching, and
 *   (b) the handler surface stays small.
 */
export function currentSessionData() {
  return getSession();
}
