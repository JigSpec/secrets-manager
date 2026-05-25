import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { saveVault } from "@/lib/vault/store";
import type { VaultData } from "@/lib/vault/schema";

export const DEFAULT_PASSWORD = "hunter22hunter22";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DAEMON_BIN = path.join(REPO_ROOT, "bin", "sm-daemon.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

export type SpawnedDaemon = {
  proc: ChildProcess;
  vaultDir: string;
  socketPath: string;
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrBuf: () => string;
  kill: () => Promise<void>;
};

export async function makeVaultDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "sm-test-"));
}

export async function seedVault(
  dir: string,
  data: VaultData,
  password: string = DEFAULT_PASSWORD,
): Promise<void> {
  const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
  process.env.SECRETS_MANAGER_VAULT_DIR = dir;
  try {
    await saveVault(data, password);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
    else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
  }
}

export async function startDaemon(opts: {
  vaultDir: string;
  password?: string;
  idleTtlMin?: number;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<SpawnedDaemon> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SECRETS_MANAGER_VAULT_DIR: opts.vaultDir,
    SM_DAEMON_IDLE_TTL_MIN: String(opts.idleTtlMin ?? 60),
    // Use N=1024 in tests unless explicitly overridden, to avoid 3-5 s scrypt
    // waits per daemon start. Production code always uses the default 2^17.
    SM_SCRYPT_N: process.env.SM_SCRYPT_N ?? "1024",
    ...(opts.extraEnv ?? {}),
  };
  const proc = spawn(TSX_BIN, [DAEMON_BIN, "start"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.write(`${opts.password ?? DEFAULT_PASSWORD}\n`);
  proc.stdin?.end();

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

  const kill = async (): Promise<void> => {
    // Kill the background child process via its PID file.
    const pidFile = path.join(opts.vaultDir, "sm.pid");
    let daemonPid: number | null = null;
    try {
      const { readFile } = await import("node:fs/promises");
      const pidStr = (await readFile(pidFile, "utf8")).trim();
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && pid > 0) {
        daemonPid = pid;
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    } catch {
      // No pid file — nothing to kill.
    }
    // Also kill the parent proc in case it hasn't exited yet.
    if (!proc.killed) proc.kill("SIGKILL");
    try {
      await exited;
    } catch {
      // ignore
    }
    // Wait for the background daemon child to actually die before returning.
    // Without this, a subsequent startDaemon() may see the old PID still alive
    // and refuse to start ("daemon already running").
    if (daemonPid !== null) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(daemonPid, 0);
          // Still alive — wait a bit.
          await new Promise<void>((r) => setTimeout(r, 20));
        } catch {
          // ESRCH — process is gone.
          break;
        }
      }
    }
  };

  return {
    proc,
    vaultDir: opts.vaultDir,
    socketPath: path.join(opts.vaultDir, "sm.sock"),
    ready,
    exited,
    stderrBuf: () => buf,
    kill,
  };
}

export async function cleanupVaultDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
