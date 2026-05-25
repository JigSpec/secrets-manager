import { stat } from "node:fs/promises";

import { vaultPath, loadVault, saveVault } from "../vault/store";
import type { VaultData, VaultDataV4 } from "../vault/schema";

/**
 * The daemon is a single-process server. Session state is a single in-memory
 * cell: the held password + the decrypted vault data + the mtime of the
 * vault file at the moment we last reconciled. The mtime is used by the
 * server's reload-on-change check before dispatching each request.
 *
 * This module is intentionally distinct from `lib/vault/session.ts`, which
 * is the cookie-based GUI session. v0.3 unifies them.
 */

let held:
  | {
      password: string;
      data: VaultDataV4;
      lastMtimeMs: number;
    }
  | null = null;

export function setSession(
  password: string,
  data: VaultDataV4,
  mtimeMs: number,
): void {
  held = { password, data, lastMtimeMs: mtimeMs };
}

export function getSession(): {
  password: string;
  data: VaultDataV4;
  lastMtimeMs: number;
} {
  if (!held) throw new Error("daemon session not initialized");
  return held;
}

export function hasSession(): boolean {
  return held !== null;
}

export function clearSession(): void {
  held = null;
}

export function replaceData(data: VaultDataV4, mtimeMs: number): void {
  if (!held) throw new Error("daemon session not initialized");
  held = { password: held.password, data, lastMtimeMs: mtimeMs };
}

/**
 * Persist `next` to disk with the held password, refresh in-memory state,
 * and update the cached mtime. The mtime stamp prevents the next request's
 * stale-check from re-loading the file we just wrote.
 */
export async function persistData(next: VaultDataV4): Promise<void> {
  if (!held) throw new Error("daemon session not initialized");
  await saveVault(next, held.password);
  const m = await stat(vaultPath()).catch(() => null);
  held = {
    password: held.password,
    data: next,
    lastMtimeMs: m?.mtimeMs ?? Date.now(),
  };
}

/**
 * On every request the server calls this to reconcile in-memory state with
 * the file on disk. Returns `"ok"` for normal flow, `"key-invalid"` if the
 * held password can no longer decrypt the file (rotated externally).
 */
export async function reconcileFromDisk(): Promise<"ok" | "key-invalid"> {
  if (!held) throw new Error("daemon session not initialized");
  const s = await stat(vaultPath()).catch(() => null);
  if (!s) return "ok"; // file gone — keep in-memory state; next persist will re-create.
  if (s.mtimeMs === held.lastMtimeMs) return "ok";
  try {
    const reloaded = await loadVault(held.password);
    held = {
      password: held.password,
      data: reloaded,
      lastMtimeMs: s.mtimeMs,
    };
    return "ok";
  } catch {
    return "key-invalid";
  }
}
