#!/usr/bin/env -S npx tsx
import "../lib/daemon/handlers";
import { startServer } from "../lib/daemon/server";
import { sendCommand } from "../lib/cli/ipc-client";
import { readPasswordFromTty } from "../lib/daemon/password-prompt";
import { socketPath } from "../lib/daemon/paths";
import { resolveStartupIdleTtlMs } from "../lib/daemon/config";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

async function cmdStart(): Promise<number> {
  // CHILD BRANCH — run by the detached background process
  if (process.argv.includes("--daemon-child")) {
    return runDaemonChild();
  }

  // PARENT BRANCH — the process the user runs in their terminal
  if (existsSync(socketPath())) {
    // Try to talk to it; if it answers status, surface the existing daemon.
    const probe = await sendCommand({ cmd: "status" }, { timeoutMs: 1500 });
    if (probe.ok) {
      process.stderr.write("daemon already running\n");
      return 1;
    }
    // Otherwise the socket is stale — startServer will clean it up.
  }

  let password: string;
  try {
    password = await readPasswordFromTty();
  } catch (e) {
    process.stderr.write(
      `failed to read password: ${(e as Error).message}\n`,
    );
    return 1;
  }
  if (password.length === 0) {
    process.stderr.write("empty password, aborting\n");
    return 1;
  }

  // Spawn the detached daemon child. Password goes in via stdin pipe;
  // readiness signal comes back on stdout pipe.
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], "start", "--daemon-child"],
    {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    },
  );
  child.unref();

  child.stdin!.write(password + "\n");
  child.stdin!.end();

  return new Promise<number>((resolve) => {
    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { buf += chunk; });
    child.stdout!.on("end", () => {
      let msg: { ok: boolean; socketPath?: string; error?: string };
      try {
        msg = JSON.parse(buf.trim());
      } catch {
        process.stderr.write(`daemon child sent unreadable response: ${buf}\n`);
        resolve(1);
        return;
      }
      if (msg.ok) {
        process.stderr.write(`daemon ready (socket ${msg.socketPath})\n`);
        resolve(0);
      } else {
        process.stderr.write(`failed to start daemon: ${msg.error ?? "unknown error"}\n`);
        resolve(1);
      }
    });
    child.on("error", (e) => {
      process.stderr.write(`failed to spawn daemon child: ${e.message}\n`);
      resolve(1);
    });
  });
}

async function runDaemonChild(): Promise<number> {
  let password: string;
  try {
    password = await readPasswordFromTty();
  } catch (e) {
    const msg = JSON.stringify({ ok: false, error: (e as Error).message });
    process.stdout.write(msg + "\n");
    try { process.stdout.end(); } catch { /* ignore */ }
    return 1;
  }
  if (password.length === 0) {
    process.stdout.write(JSON.stringify({ ok: false, error: "empty password" }) + "\n");
    try { process.stdout.end(); } catch { /* ignore */ }
    return 1;
  }

  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer({
      password,
      idleTtlMs: await resolveStartupIdleTtlMs(),
      onLock: (reason) => {
        process.stderr.write(`daemon locked (${reason})\n`);
        setImmediate(() => process.exit(0));
      },
    });
  } catch (e) {
    const msg = JSON.stringify({ ok: false, error: (e as Error).message });
    process.stdout.write(msg + "\n");
    try { process.stdout.end(); } catch { /* ignore */ }
    return 1;
  }

  // Signal readiness to the parent, then close stdout so parent unblocks.
  const readyMsg = JSON.stringify({ ok: true, socketPath: handle.socketPath });
  await new Promise<void>((resolve) => {
    process.stdout.write(readyMsg + "\n", () => resolve());
  });
  try { process.stdout.end(); } catch { /* ignore */ }

  const stop = async () => {
    try { await handle.stop(); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });

  // Keep alive; process.exit() is called from onLock → setImmediate.
  return new Promise(() => {});
}

async function cmdStop(): Promise<number> {
  const r = await sendCommand({ cmd: "stop" });
  if (r.ok) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }
  process.stderr.write(JSON.stringify(r) + "\n");
  return 1;
}

async function cmdStatus(): Promise<number> {
  const r = await sendCommand({ cmd: "status" });
  if (r.ok) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }
  process.stdout.write(JSON.stringify(r) + "\n");
  return 1;
}

async function main(): Promise<number> {
  const verb = process.argv[2];
  switch (verb) {
    case "start":
      return cmdStart();
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(
        "usage: sm-daemon {start|stop|status}\n" +
          "  start    Foreground: prompts for password, binds socket\n" +
          "  stop     Asks running daemon to lock and exit\n" +
          "  status   Reports running/locked\n",
      );
      return 0;
    default:
      process.stderr.write(
        `unknown sm-daemon command: ${verb}\nrun \`sm-daemon help\`\n`,
      );
      return 1;
  }
}

main().then(
  (code) => {
    process.exit(code ?? 0);
  },
  (e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
