/**
 * lib/import/vault-drop.ts
 *
 * Utilities for Issue #32 — drag-and-drop encrypted vault files into the UI.
 *
 * Provides:
 *   - decryptDroppedVault  — parse + decrypt a .enc envelope string
 *   - previewVaultMerge    — classify incoming secrets vs current vault
 *   - applyVaultMerge      — merge two vaults with overwrite or skip policy
 *
 * NOTE: This module transitively imports node:crypto via @/lib/vault/crypto,
 * so it will not bundle for the browser. Invoke decryptDroppedVault from
 * Server Actions, Route Handlers, or server components; do not call it from
 * a "use client" boundary. (We deliberately do not use `import "server-only"`
 * here so the pure helpers remain unit-testable in Vitest — matching the
 * convention already used by @/lib/vault/crypto.)
 */

import {
  deriveKey,
  decryptVault,
  parseBlob,
} from "@/lib/vault/crypto";
import { VaultDataSchema } from "@/lib/vault/schema";
import type { VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DroppedVaultPreview = {
  /** Secrets in incoming that do not exist in current (new key+namespace). */
  toAdd: VaultData["secrets"];
  /** Secrets in incoming that exactly match current (same key+namespace+value). */
  noOps: VaultData["secrets"];
  /** Secrets in incoming that share key+namespace with current but differ in value. */
  conflicts: VaultData["secrets"];
};

export type DroppedVaultMergeResult = {
  /** The resulting vault after applying the merge. */
  vault: VaultData;
  /** Number of secrets added from the incoming vault. */
  added: number;
  /** Number of secrets overwritten from the incoming vault (overwrite policy only). */
  overwritten: number;
  /** Number of secrets skipped (noOps + conflicts under skip policy, or noOps under overwrite policy). */
  skipped: number;
};

// ---------------------------------------------------------------------------
// decryptDroppedVault
// ---------------------------------------------------------------------------

/**
 * Parse and decrypt a .enc vault envelope string.
 *
 * @param content  The raw string content of the dropped .enc file.
 * @param password The user-supplied master password.
 * @returns        The decrypted VaultData.
 * @throws         If the envelope is malformed, the password is wrong, or the
 *                 decrypted payload fails schema validation.
 */
export async function decryptDroppedVault(
  content: string,
  password: string,
): Promise<VaultData> {
  if (!password) throw new Error("Password must not be empty");
  const envelope = parseBlob(content);
  const key = await deriveKey(password, envelope.salt);
  const plaintext = decryptVault(envelope, key);
  const parsed = JSON.parse(plaintext) as unknown;
  return VaultDataSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// previewVaultMerge
// ---------------------------------------------------------------------------

/**
 * Diff two vaults and classify each incoming secret.
 *
 * @param current  The vault currently in the application.
 * @param incoming The vault loaded from the dropped file.
 * @returns        A preview object with toAdd, noOps, and conflicts arrays.
 */
export function previewVaultMerge(
  current: VaultData,
  incoming: VaultData,
): DroppedVaultPreview {
  const toAdd: VaultData["secrets"] = [];
  const noOps: VaultData["secrets"] = [];
  const conflicts: VaultData["secrets"] = [];

  for (const incomingSecret of incoming.secrets) {
    const match = current.secrets.find(
      (s) => s.key === incomingSecret.key && s.namespace === incomingSecret.namespace,
    );

    if (!match) {
      toAdd.push({ ...incomingSecret });
    } else if (match.value === incomingSecret.value) {
      noOps.push({ ...incomingSecret });
    } else {
      conflicts.push({ ...incomingSecret });
    }
  }

  return { toAdd, noOps, conflicts };
}

// ---------------------------------------------------------------------------
// applyVaultMerge
// ---------------------------------------------------------------------------

/**
 * Apply the merge of two vaults using the given conflict-resolution policy.
 *
 * - "overwrite": add new secrets and update conflicting secrets with the
 *                incoming value. noOps are left unchanged (counted as skipped).
 * - "skip":      add new secrets only; keep current values for all conflicts.
 *                Both conflicts and noOps are counted as skipped.
 *
 * @param current  The vault currently in the application.
 * @param incoming The vault loaded from the dropped file.
 * @param policy   "overwrite" | "skip"
 * @returns        The merged VaultData and counts of added/overwritten/skipped secrets.
 */
export function applyVaultMerge(
  current: VaultData,
  incoming: VaultData,
  policy: "overwrite" | "skip",
): DroppedVaultMergeResult {
  const { toAdd, noOps, conflicts } = previewVaultMerge(current, incoming);

  // Start with a copy of the current secrets.
  let secrets = current.secrets.map((s) => ({ ...s }));

  let added = 0;
  let overwritten = 0;
  let skipped = 0;

  // Always add secrets that don't exist in current.
  secrets = [...secrets, ...toAdd.map((s) => ({ ...s }))];
  added = toAdd.length;

  if (policy === "overwrite") {
    // Update conflicting secrets with the incoming value.
    for (const incomingSecret of conflicts) {
      secrets = secrets.map((s) =>
        s.key === incomingSecret.key && s.namespace === incomingSecret.namespace
          ? { ...s, id: incomingSecret.id, value: incomingSecret.value }
          : s,
      );
      overwritten++;
    }
    // noOps are unchanged — count them as skipped.
    skipped = noOps.length;
  } else {
    // skip policy: keep current values for conflicts too.
    // Both conflicts and noOps count as skipped.
    skipped = conflicts.length + noOps.length;
  }

  const vault: VaultData = {
    ...current,
    secrets,
  };

  return { vault, added, overwritten, skipped };
}
