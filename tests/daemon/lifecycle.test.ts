import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveVault } from "@/lib/vault/store";
import { sendCommand } from "@/lib/cli/ipc-client";

const PASSWORD = "hunter22hunter22";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DAEMON_BIN = path.join(REPO_ROOT, "bin", "sm-daemon.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

type Spawned = {
  proc: ChildProcess;
  socketPath: string;
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function startDaemon(opts: {
  vaultDir: string;
  password?: string;
  idleTtlMin?: number;
}): Promise<Spawned> {
  const env = {
    ...process.env,
    SECRETS_MANAGER_VAULT_DIR: opts.vaultDir,
    SM_DAEMON_IDLE_TTL_MIN: String(opts.idleTtlMin ?? 60),
  };
  const proc = spawn(TSX_BIN, [DAEMON_BIN, "start"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.write(`${opts.password ?? PASSWORD}\n`);
  proc.stdin?.end();
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // The parent process now exits (code 0) once the background daemon is ready.
  // Resolve when the parent exits with code 0 (which implies "daemon ready").
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `daemon never became ready (stderr: ${stderrBuf})`,
        ),
      );
    }, 15_000);
    exited.then(({ code }) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `daemon parent exited with code ${code} before ready (stderr: ${stderrBuf})`,
          ),
        );
      }
    }).catch(reject);
  });

  return {
    proc,
    socketPath: path.join(opts.vaultDir, "sm.sock"),
    ready,
    exited,
  };
}

async function killDaemon(s: Spawned): Promise<void> {
  // Kill the background child process via its PID file (since the parent
  // process exits once the daemon is ready).
  const pidFile = path.join(path.dirname(s.socketPath), "sm.pid");
  try {
    const { readFile } = await import("node:fs/promises");
    const pidStr = (await readFile(pidFile, "utf8")).trim();
    const pid = Number(pidStr);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  } catch {
    // No pid file — nothing to kill.
  }
  // Also kill the parent proc in case it hasn't exited yet.
  if (!s.proc.killed) {
    s.proc.kill("SIGKILL");
  }
  try {
    await s.exited;
  } catch {
    // ignore
  }
}

let tmp: string;
let active: Spawned | null = null;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "sm-daemon-lifecycle-"));
  // Seed an existing vault file the daemon can decrypt.
  process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
  await saveVault({ version: 2, repos: [], secrets: [] }, PASSWORD);
  delete process.env.SECRETS_MANAGER_VAULT_DIR;
});

afterEach(async () => {
  if (active) {
    await killDaemon(active);
    active = null;
  }
  await rm(tmp, { recursive: true, force: true });
});

/** Poll until condition() is true or timeoutMs elapses. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!condition()) {
    throw new Error(`waitFor timed out after ${timeoutMs} ms`);
  }
}

describe("daemon lifecycle", () => {
  it("starts, answers status, accepts stop, and cleans up the socket", async () => {
    active = await startDaemon({ vaultDir: tmp });
    await active.ready;

    // Parent has exited (code 0); background daemon is now running.
    const { code } = await active.exited;
    expect(code).toBe(0);

    // Wait for socket to appear in case daemon hasn't fully bound yet.
    await waitFor(() => existsSync(active!.socketPath), 5_000);

    const status = await sendCommand(
      { cmd: "status" },
      { socketPathOverride: active.socketPath },
    );
    expect(status.ok).toBe(true);
    if (status.ok) {
      const s = status as Record<string, unknown>;
      expect(typeof s.idleTtlMs).toBe("number");
      expect(typeof s.idleTtlMsRemaining).toBe("number");
      expect(s.idleTtlMsRemaining as number).toBeGreaterThan(0);
      expect(s.idleTtlMsRemaining as number).toBeLessThanOrEqual(
        s.idleTtlMs as number,
      );
    }

    const stop = await sendCommand(
      { cmd: "stop" },
      { socketPathOverride: active.socketPath },
    );
    expect(stop.ok).toBe(true);

    // Wait for the background daemon to clean up its socket and pid file.
    // The daemon unlinks the socket before the pid file (lib/daemon/server.ts),
    // so we must wait for both — otherwise the pid-file assertion races the cleanup.
    const pidFile = path.join(tmp, "sm.pid");
    await waitFor(
      () => !existsSync(active!.socketPath) && !existsSync(pidFile),
      5_000,
    );
    expect(existsSync(active.socketPath)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  }, 20_000);

  it("returns DAEMON_LOCKED when no daemon is running", async () => {
    const r = await sendCommand(
      { cmd: "status" },
      { socketPathOverride: path.join(tmp, "sm.sock") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("DAEMON_LOCKED");
  });

  it("refuses a second start while the first daemon is running", async () => {
    active = await startDaemon({ vaultDir: tmp });
    await active.ready;

    const second = spawn(TSX_BIN, [DAEMON_BIN, "start"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SECRETS_MANAGER_VAULT_DIR: tmp,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    second.stdin?.write(`${PASSWORD}\n`);
    let stderr = "";
    second.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const exit = await new Promise<number | null>((resolve) =>
      second.once("exit", (code) => resolve(code)),
    );
    expect(exit).not.toBe(0);
    expect(stderr).toMatch(/already running/i);
  });
});
