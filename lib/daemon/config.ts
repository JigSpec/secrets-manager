import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { vaultDir } from "../vault/store";

export const DEFAULT_IDLE_TTL_MIN = 60;
export const MIN_IDLE_TTL_MIN = 1;
export const MAX_IDLE_TTL_MIN = 1440;

export type DaemonConfig = {
  idleTtlMin?: number;
};

export function daemonConfigPath(): string {
  return path.join(vaultDir(), "daemon-config.json");
}

export async function loadDaemonConfig(): Promise<DaemonConfig> {
  try {
    const raw = await readFile(daemonConfigPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: DaemonConfig = {};
    const ttl = (parsed as Record<string, unknown>).idleTtlMin;
    if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
      out.idleTtlMin = clampTtlMin(ttl);
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveDaemonConfig(cfg: DaemonConfig): Promise<void> {
  const dir = vaultDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    daemonConfigPath(),
    JSON.stringify(cfg, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export function clampTtlMin(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_IDLE_TTL_MIN;
  return Math.min(MAX_IDLE_TTL_MIN, Math.max(MIN_IDLE_TTL_MIN, Math.floor(min)));
}

/**
 * Compute the effective idle-TTL (in ms) at daemon startup.
 * Precedence: env var (SM_DAEMON_IDLE_TTL_MIN) > config file > default.
 */
export async function resolveStartupIdleTtlMs(): Promise<number> {
  const envRaw = process.env.SM_DAEMON_IDLE_TTL_MIN;
  if (envRaw !== undefined && envRaw !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n > 0) {
      return clampTtlMin(n) * 60_000;
    }
  }
  const cfg = await loadDaemonConfig();
  if (cfg.idleTtlMin !== undefined) {
    return clampTtlMin(cfg.idleTtlMin) * 60_000;
  }
  return DEFAULT_IDLE_TTL_MIN * 60_000;
}
