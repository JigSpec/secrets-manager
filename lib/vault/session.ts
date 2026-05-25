import "server-only";

import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import type { VaultData } from "./schema";
import { loadVault, saveVault, vaultExists, VaultError } from "./store";

const SESSION_COOKIE = "sm-session-id";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

type SessionEntry = {
  data: VaultData;
  password: string;
};

// Back the sessions Map with globalThis so it survives Next.js dev-mode HMR.
// Without this, editing any source file under `app/` or `lib/` re-evaluates
// this module, wipes the Map, and turns every subsequent API call into a
// 401 "Vault is locked" even though the user's cookie is still valid — the
// workbench stays on screen (it was hydrated before HMR), but Deploy fails.
//
// Security note: globalThis.__secretsManager_webSessions_v1 holds plaintext
// vault passwords in process memory. This is intentional and acceptable:
// secrets-manager is a localhost-only developer tool with a single trusted
// user. The password is already in process memory from the moment the vault is
// unlocked — persisting it here across HMR cycles does not expand the attack
// surface. It is never serialised, logged, or sent over the network.
const _smSessionsCandidate = (globalThis as any).__secretsManager_webSessions_v1;
const sessions: Map<string, SessionEntry> =
  _smSessionsCandidate instanceof Map
    ? _smSessionsCandidate
    : new Map<string, SessionEntry>();
(globalThis as any).__secretsManager_webSessions_v1 = sessions;

function newSessionId(): string {
  return randomBytes(24).toString("base64url");
}

export async function getSessionId(): Promise<string | null> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE);
  return cookie?.value ?? null;
}

export async function isUnlocked(): Promise<boolean> {
  const id = await getSessionId();
  if (!id) return false;
  return sessions.has(id);
}

export async function getVaultData(): Promise<VaultData | null> {
  const id = await getSessionId();
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  // Reload from disk on every call so that daemon writes are visible immediately
  // (fixes stale-cache bug: issue #91, Step 3).
  try {
    const fresh = await loadVault(entry.password);
    entry.data = fresh;
    return fresh;
  } catch (e) {
    if (e instanceof VaultError) {
      // Vault is inaccessible (wrong password after rotation, corrupted file,
      // or file deleted). Return null so callers treat it as an unauthenticated
      // session rather than crashing with an unhandled exception.
      return null;
    }
    throw e;
  }
}

export async function getSessionPassword(): Promise<string | null> {
  const id = await getSessionId();
  if (!id) return null;
  return sessions.get(id)?.password ?? null;
}

async function setSessionCookie(id: string): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: id,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
    maxAge: 0,
  });
}

export async function unlockWithPassword(password: string): Promise<VaultData> {
  const data = await loadVault(password);
  const id = newSessionId();
  sessions.set(id, { data, password });
  await setSessionCookie(id);
  return data;
}

export async function createVaultWithPassword(
  password: string,
): Promise<VaultData> {
  const seed: VaultData = { version: 2, repos: [], secrets: [] };
  await saveVault(seed, password);
  const id = newSessionId();
  sessions.set(id, { data: seed, password });
  await setSessionCookie(id);
  return seed;
}

export async function persistVaultData(data: VaultData): Promise<void> {
  const id = await getSessionId();
  if (!id) throw new Error("session not established");
  const entry = sessions.get(id);
  if (!entry) throw new Error("session not found");
  await saveVault(data, entry.password);
  entry.data = data;
}

export async function lock(): Promise<void> {
  const id = await getSessionId();
  if (id) sessions.delete(id);
  await clearSessionCookie();
}

export async function vaultIsInitialized(): Promise<boolean> {
  return vaultExists();
}
