import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "../..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");
const UNINSTALL_SH = join(REPO_ROOT, "uninstall.sh");

function runInstall(binDir: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [INSTALL_SH], {
    env: { ...process.env, SM_BIN_DIR: binDir, SM_SKIP_ROOT_CHECK: "1", ...env },
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
}

function runUninstall(binDir: string) {
  return spawnSync("bash", [UNINSTALL_SH], {
    env: { ...process.env, SM_BIN_DIR: binDir, SM_SKIP_ROOT_CHECK: "1" },
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
}

describe("install.sh", () => {
  let tmpBin: string;

  beforeEach(() => {
    tmpBin = mkdtempSync(join(tmpdir(), "sm-install-test-"));
  });

  afterEach(() => {
    rmSync(tmpBin, { recursive: true, force: true });
  });

  it("exits 0 on a fresh install", () => {
    const result = runInstall(tmpBin);
    expect(result.status).toBe(0);
  });

  it("creates symlinks for sm and sm-daemon", () => {
    runInstall(tmpBin);
    expect(lstatSync(join(tmpBin, "sm")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(tmpBin, "sm-daemon")).isSymbolicLink()).toBe(true);
  });

  it("symlinks point to absolute paths inside the repo", () => {
    runInstall(tmpBin);
    const smTarget = readlinkSync(join(tmpBin, "sm"));
    const daemonTarget = readlinkSync(join(tmpBin, "sm-daemon"));
    expect(smTarget).toBe(join(REPO_ROOT, "bin/sm.ts"));
    expect(daemonTarget).toBe(join(REPO_ROOT, "bin/sm-daemon.ts"));
  });

  it("is idempotent — re-running exits 0 and symlinks remain correct", () => {
    runInstall(tmpBin);
    const result = runInstall(tmpBin);
    expect(result.status).toBe(0);
    expect(readlinkSync(join(tmpBin, "sm"))).toBe(join(REPO_ROOT, "bin/sm.ts"));
  });

  it("replaces a stale symlink pointing to a wrong path", () => {
    symlinkSync("/tmp/old-sm", join(tmpBin, "sm"));
    const result = runInstall(tmpBin);
    expect(result.status).toBe(0);
    expect(readlinkSync(join(tmpBin, "sm"))).toBe(join(REPO_ROOT, "bin/sm.ts"));
  });

  it("marks bin/sm.ts executable after install", () => {
    runInstall(tmpBin);
    const mode = lstatSync(join(REPO_ROOT, "bin/sm.ts")).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("marks bin/sm-daemon.ts executable after install", () => {
    runInstall(tmpBin);
    const mode = lstatSync(join(REPO_ROOT, "bin/sm-daemon.ts")).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});

describe("uninstall.sh", () => {
  let tmpBin: string;

  beforeEach(() => {
    tmpBin = mkdtempSync(join(tmpdir(), "sm-uninstall-test-"));
  });

  afterEach(() => {
    rmSync(tmpBin, { recursive: true, force: true });
  });

  it("exits 0 after a fresh install", () => {
    runInstall(tmpBin);
    const result = runUninstall(tmpBin);
    expect(result.status).toBe(0);
  });

  it("removes both symlinks", () => {
    runInstall(tmpBin);
    runUninstall(tmpBin);
    expect(existsSync(join(tmpBin, "sm"))).toBe(false);
    expect(existsSync(join(tmpBin, "sm-daemon"))).toBe(false);
  });

  it("exits 0 even if symlinks are already gone (idempotent)", () => {
    const result = runUninstall(tmpBin);
    expect(result.status).toBe(0);
  });
});
