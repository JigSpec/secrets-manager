/**
 * RED tests for issue #10 — "Daemon doesn't release control of the terminal
 * it's launched in".
 *
 * These tests verify the DESIRED behaviour after the fix: sm-daemon start
 * should prompt for a password, then detach — the parent process exits with
 * code 0 once the daemon is ready, and the daemon itself continues running as
 * a background child process.
 *
 * All tests in this file are expected to FAIL against the current (unfixed)
 * code because cmdStart() currently blocks forever in a `new Promise(() =>
 * {})` and never resolves — i.e. the parent never exits voluntarily.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveVault } from "@/lib/vault/store";
import { makeVaultDir, cleanupVaultDir } from "@/tests/_helpers/daemon-harness";
import { sendCommand } from "@/lib/cli/ipc-client";

const PASSWORD = "hunter22hunter22";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DAEMON_BIN = path.join(REPO_ROOT, "bin", "sm-daemon.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

let tmp: string;

beforeEach(async () => {
  tmp = await makeVaultDir();
  // Seed a vault the daemon can decrypt.
  const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
  process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
  try {
    await saveVault({ version: 2, repos: [], secrets: [] }, PASSWORD);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
    else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
  }
});

afterEach(async () => {
  // Kill background daemon if still alive (best-effort cleanup).
  const pidFile = path.join(tmp, "sm.pid");
  try {
    const pidStr = (await readFile(pidFile, "utf8")).trim();
    const pid = Number(pidStr);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead — fine.
      }
    }
  } catch {
    // No pid file — nothing to kill.
  }
  await cleanupVaultDir(tmp);
});

/**
 * Spawn `sm-daemon start`, feed the password on stdin, and return the child
 * process plus a promise that resolves to the exit info.
 *
 * The promise resolves with code=-1 if the process has to be force-killed
 * (i.e. it never exits voluntarily within timeoutMs — the broken behaviour).
 */
function spawnDaemon(timeoutMs = 10_000): {
  proc: ReturnType<typeof spawn>;
  exited: Promise<{ code: number | null; killedByUs: boolean }>;
} {
  const proc = spawn(TSX_BIN, [DAEMON_BIN, "start"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SECRETS_MANAGER_VAULT_DIR: tmp,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin!.write(PASSWORD + "\n");
  proc.stdin!.end();

  const exited = new Promise<{ code: number | null; killedByUs: boolean }>(
    (resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ code: -1, killedByUs: true });
      }, timeoutMs);
      proc.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode, killedByUs: false });
      });
    },
  );

  return { proc, exited };
}

/**
 * Wait for condition() to become true, polling every 50 ms up to timeoutMs.
 */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sm-daemon start backgrounds itself (issue #10)", () => {
  it(
    "parent process exits with code 0 after printing 'daemon ready'",
    async () => {
      // RED: currently cmdStart() returns `new Promise(() => {})` and never
      // resolves, so the parent process never exits voluntarily.
      // The timeout guard fires → code -1 → expect(code).toBe(0) fails.
      const { proc, exited } = spawnDaemon();

      let stderr = "";
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const { code, killedByUs } = await exited;

      // After the fix: parent exits cleanly with 0 and has printed the ready
      // line.  killedByUs must be false (we didn't have to force-kill it).
      expect(killedByUs, "parent process was force-killed — it never exited voluntarily").toBe(false);
      expect(code).toBe(0);
      expect(stderr).toMatch(/daemon ready/);
    },
    15_000,
  );

  it(
    "socket file exists after parent exits voluntarily",
    async () => {
      // RED: the parent never exits voluntarily under the current
      // implementation, so killedByUs is always true here and the assertion
      // at the end fails.
      const { exited } = spawnDaemon();
      const { killedByUs } = await exited;

      // The test requires that the parent exited on its own (not force-killed).
      // This fails today because the process blocks forever.
      expect(killedByUs, "parent process was force-killed — it never exited voluntarily").toBe(false);

      // After the fix: daemon is still running as a background process with
      // the socket bound.
      const socketPath = path.join(tmp, "sm.sock");
      expect(existsSync(socketPath)).toBe(true);
    },
    15_000,
  );

  it(
    "background daemon answers a status command after parent exits voluntarily",
    async () => {
      // RED: parent never exits voluntarily → killedByUs is true → first
      // assertion fails before we even reach sendCommand.
      const { exited } = spawnDaemon();
      const { killedByUs } = await exited;

      expect(killedByUs, "parent process was force-killed — it never exited voluntarily").toBe(false);

      // Allow a brief settling period for the background daemon to bind.
      const socketPath = path.join(tmp, "sm.sock");
      await waitFor(() => existsSync(socketPath), 5_000);

      const status = await sendCommand(
        { cmd: "status" },
        { socketPathOverride: socketPath },
      );
      expect(status.ok).toBe(true);
    },
    20_000,
  );

  it(
    "pid file records background child pid, not parent (spawner) pid",
    async () => {
      // RED: the parent never exits voluntarily, so killedByUs is true and
      // the first assertion fails.  Even if we got past it, process.pid in
      // server.ts IS the parent pid today (no forking), so the second
      // assertion (childPid !== parentPid) would also fail.
      const { proc, exited } = spawnDaemon();
      const parentPid = proc.pid!;

      const { killedByUs } = await exited;

      expect(killedByUs, "parent process was force-killed — it never exited voluntarily").toBe(false);

      const pidFile = path.join(tmp, "sm.pid");
      const childPidStr = await readFile(pidFile, "utf8");
      const childPid = Number(childPidStr.trim());

      // After the fix: the daemon runs as a separate child process whose pid
      // differs from the parent/spawner pid.
      expect(childPid).toBeGreaterThan(0);
      expect(childPid).not.toBe(parentPid);
    },
    15_000,
  );

  it(
    "sm-daemon stop can stop the background daemon and remove the socket",
    async () => {
      // RED: parent never exits voluntarily (foreground), so killedByUs is
      // true and the first assertion fails before we reach the stop call.
      const { exited } = spawnDaemon();
      const { killedByUs } = await exited;

      expect(killedByUs, "parent process was force-killed — it never exited voluntarily").toBe(false);

      // Wait for daemon to bind its socket.
      const socketPath = path.join(tmp, "sm.sock");
      await waitFor(() => existsSync(socketPath), 5_000);

      // Now ask the daemon to stop.
      const stopProc = spawn(TSX_BIN, [DAEMON_BIN, "stop"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SECRETS_MANAGER_VAULT_DIR: tmp,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const { code: stopCode } = await new Promise<{ code: number | null }>(
        (resolve) => {
          stopProc.once("exit", (code) => resolve({ code }));
        },
      );
      expect(stopCode).toBe(0);

      // Socket should be removed once the daemon shuts down.
      await waitFor(() => !existsSync(socketPath), 5_000);
      expect(existsSync(socketPath)).toBe(false);
    },
    25_000,
  );
});
