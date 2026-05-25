import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveVault } from "@/lib/vault/store";
import { sendCommand } from "@/lib/cli/ipc-client";

const PASSWORD = "hunter22hunter22";
const ALT_PASSWORD = "rotated-password-9876";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DAEMON_BIN = path.join(REPO_ROOT, "bin", "sm-daemon.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

type Spawned = {
  proc: ChildProcess;
  socketPath: string;
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrBuf: () => string;
};

async function startDaemon(opts: {
  vaultDir: string;
  password?: string;
}): Promise<Spawned> {
  const env = {
    ...process.env,
    SECRETS_MANAGER_VAULT_DIR: opts.vaultDir,
    SM_DAEMON_IDLE_TTL_MIN: "60",
    SM_DAEMON_TEST_PING: "1",
  };
  const proc = spawn(TSX_BIN, [DAEMON_BIN, "start"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.write(`${opts.password ?? PASSWORD}\n`);
  let buf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // The parent process now exits (code 0) once the background daemon is ready.
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`daemon never became ready (stderr=${buf})`)),
      15_000,
    );
    exited.then(({ code }) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`daemon parent exited with code ${code} before ready (stderr=${buf})`));
      }
    }).catch(reject);
  });

  return {
    proc,
    socketPath: path.join(opts.vaultDir, "sm.sock"),
    ready,
    exited,
    stderrBuf: () => buf,
  };
}

let tmp: string;
let active: Spawned | null = null;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "sm-daemon-mtime-"));
  process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
  await saveVault(
    {
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: "/tmp",
          environments: ["development"],
        },
      ],
      secrets: [],
    },
    PASSWORD,
  );
  delete process.env.SECRETS_MANAGER_VAULT_DIR;
});

afterEach(async () => {
  if (active) {
    // Kill the background child process via its PID file (parent has already exited).
    const pidFile = path.join(tmp, "sm.pid");
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
    if (!active.proc.killed) active.proc.kill("SIGKILL");
    try {
      await active.exited;
    } catch {
      // ignore
    }
    active = null;
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("daemon mtime reload", () => {
  it("auto-locks with KEY_INVALID_AFTER_RELOAD when the vault is re-encrypted with a different password", async () => {
    // The spawned daemon registers `__ping__` because we set
    // SM_DAEMON_TEST_PING=1. We use it as a no-op verb that crosses
    // the reconcile path.
    active = await startDaemon({ vaultDir: tmp });
    await active.ready;

    const firstPing = await sendCommand(
      { cmd: "__ping__" },
      { socketPathOverride: active.socketPath },
    );
    expect(firstPing.ok).toBe(true);

    // Re-encrypt the vault with a different password under the daemon's
    // feet. Bump mtime to be safe (some filesystems give us 1s granularity).
    process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
    await saveVault(
      { version: 2, repos: [], secrets: [] },
      ALT_PASSWORD,
    );
    const future = new Date(Date.now() + 5_000);
    await utimes(path.join(tmp, "vault.enc"), future, future);
    delete process.env.SECRETS_MANAGER_VAULT_DIR;

    const ping2 = await sendCommand(
      { cmd: "__ping__" },
      { socketPathOverride: active.socketPath },
    );
    expect(ping2.ok).toBe(false);
    if (ping2.ok) return;
    expect(ping2.code).toBe("KEY_INVALID_AFTER_RELOAD");

    const { code } = await active.exited;
    expect(code).toBe(0);
  }, 20_000);
});
